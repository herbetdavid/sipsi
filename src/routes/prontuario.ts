import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { HttpError } from "../ctx.ts";
import { html } from "../html.ts";
import { sha256Hex } from "../crypto.ts";
import { registrarLog } from "../audit.ts";
import { CLINICO } from "../rbac.ts";
import { psicologosPermitidos } from "../psicologos.ts";
import { fmtDataHoraLocal, fmtDataHoraUtc, inteiro } from "../util.ts";

import { violacaoUnica } from "../pg.ts";

export const HASH_GENESIS = "GENESIS";

/** Hash de uma entrada: encadeia o hash anterior + todos os campos (JSON canônico). */
export async function calcularHash(
  anterior: string,
  pacienteId: number,
  psicologoId: number,
  sessaoId: number | null,
  conteudo: string,
  criadoEm: string,
): Promise<string> {
  return sha256Hex(JSON.stringify([anterior, pacienteId, psicologoId, sessaoId, conteudo, criadoEm]));
}

interface Entrada {
  id: number;
  seq: number;
  paciente_id: number;
  sessao_id: number | null;
  psicologo_id: number;
  conteudo: string;
  criado_em: string;
  hash_anterior: string;
  hash_integridade: string;
  psicologo_nome?: string;
}

async function carregarPaciente(c: Ctx, id: number): Promise<{ id: number; nome: string }> {
  const p = await c.db.prepare("SELECT id, nome FROM paciente WHERE id = ?").bind(id).first<{ id: number; nome: string }>();
  if (!p) throw new HttpError(404, "Paciente não encontrado.");
  return p;
}

async function listar(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const paciente = await carregarPaciente(c, id);
  const { results: entradas } = await c.db
    .prepare(
      `SELECT e.id, e.seq, e.criado_em, e.conteudo, e.hash_integridade, ps.nome AS psicologo_nome
         FROM prontuario_entrada e JOIN psicologo ps ON ps.id = e.psicologo_id
        WHERE e.paciente_id = ? ORDER BY e.seq DESC`,
    )
    .bind(id)
    .all<Entrada>();
  await registrarLog(c, "visualizar", "ProntuarioEntrada", null, id, `listagem do prontuário (${entradas.length} entradas)`);

  return c.pagina(
    `Prontuário - ${paciente.nome}`,
    html`<div class="d-flex justify-content-between align-items-center mb-3">
  <h2>Prontuário — ${paciente.nome}</h2>
  <div class="d-flex gap-2">
    <a href="/prontuario/paciente/${id}/verificar" class="btn btn-outline-secondary">Verificar integridade</a>
    <a href="/prontuario/paciente/${id}/nova" class="btn btn-success">+ Nova entrada</a>
  </div>
</div>
<p class="text-muted small">Registros são imutáveis (o banco recusa alteração e exclusão): correções exigem nova entrada, nunca edição da anterior.</p>
${entradas.length
  ? entradas.map(
      (e) => html`<div class="card mb-3"><div class="card-body">
    <h6 class="card-subtitle text-muted mb-2">#${e.seq} · ${fmtDataHoraUtc(e.criado_em)} — ${e.psicologo_nome}</h6>
    <p class="card-text" style="white-space: pre-wrap">${e.conteudo}</p>
    <code class="small text-muted">hash: ${e.hash_integridade.slice(0, 16)}...</code>
  </div></div>`,
    )
  : html`<p class="text-muted">Nenhuma entrada de prontuário registrada.</p>`}`,
  );
}

async function formNova(c: Ctx, pacienteId: number, v: Record<string, string>, erro: string | null, status = 200): Promise<Response> {
  if (erro) c.flash = { tipo: "danger", msg: erro };
  const paciente = await carregarPaciente(c, pacienteId);
  const psicologos = await psicologosPermitidos(c);
  const { results: sessoes } = await c.db
    .prepare(
      `SELECT s.id, s.data_hora FROM sessao s
        WHERE s.paciente_id = ? AND s.status = 'realizada'
          AND NOT EXISTS (SELECT 1 FROM prontuario_entrada e WHERE e.sessao_id = s.id)
        ORDER BY s.data_hora DESC`,
    )
    .bind(pacienteId)
    .all<{ id: number; data_hora: string }>();

  return c.pagina(
    "Nova entrada - Prontuário",
    html`<h2>Nova entrada de prontuário — ${paciente.nome}</h2>
<form method="post" action="/prontuario/paciente/${pacienteId}/nova" class="bg-white p-4 rounded shadow-sm" style="max-width:600px">
  <input type="hidden" name="_csrf" value="${c.csrf}">
  <div class="mb-3"><label class="form-label">Psicólogo responsável</label>
    <select name="psicologo_id" class="form-select" required>
      ${psicologos.map((p) => html`<option value="${p.id}" ${String(p.id) === v.psicologo_id ? "selected" : ""}>${p.nome}</option>`)}
    </select></div>
  <div class="mb-3"><label class="form-label">Sessão vinculada (opcional)</label>
    <select name="sessao_id" class="form-select">
      <option value="">-- sem vínculo --</option>
      ${sessoes.map((s) => html`<option value="${s.id}" ${String(s.id) === v.sessao_id ? "selected" : ""}>${fmtDataHoraLocal(s.data_hora)}</option>`)}
    </select></div>
  <div class="mb-3"><label class="form-label">Conteúdo (evolução clínica)</label>
    <textarea name="conteudo" class="form-control" rows="6" required maxlength="20000">${v.conteudo ?? ""}</textarea></div>
  <button class="btn btn-primary">Salvar (permanente)</button>
</form>`,
    status,
  );
}

async function novaGet(c: Ctx): Promise<Response> {
  return formNova(c, c.idParam("id"), {}, null);
}

async function novaPost(c: Ctx): Promise<Response> {
  const pacienteId = c.idParam("id");
  await carregarPaciente(c, pacienteId);
  const v = {
    psicologo_id: await c.campo("psicologo_id"),
    sessao_id: await c.campo("sessao_id"),
    conteudo: await c.campo("conteudo"),
  };

  const psicologoId = inteiro(v.psicologo_id);
  const sessaoId = v.sessao_id ? inteiro(v.sessao_id) : null;
  const erros: string[] = [];

  if (!v.conteudo || v.conteudo.length > 20000) erros.push("Informe o conteúdo (até 20.000 caracteres).");
  const permitidos = await psicologosPermitidos(c);
  if (!psicologoId || !permitidos.some((p) => p.id === psicologoId)) erros.push("Psicólogo inválido para o seu perfil.");
  if (v.sessao_id && !sessaoId) erros.push("Sessão inválida.");
  if (!erros.length && sessaoId) {
    const s = await c.db
      .prepare(
        `SELECT s.id FROM sessao s
          WHERE s.id = ? AND s.paciente_id = ? AND s.status = 'realizada'
            AND NOT EXISTS (SELECT 1 FROM prontuario_entrada e WHERE e.sessao_id = s.id)`,
      )
      .bind(sessaoId, pacienteId)
      .first();
    if (!s) erros.push("A sessão escolhida não está disponível para vínculo.");
  }
  if (erros.length) return formNova(c, pacienteId, v, erros.join(" "), 400);

  // Encadeamento: UNIQUE(paciente_id, seq) garante uma cadeia linear; se duas
  // gravações simultâneas disputarem o mesmo seq, a perdedora tenta de novo.
  let novoId = 0;
  const TENTATIVAS = 5;
  for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
    const ultima = await c.db
      .prepare("SELECT seq, hash_integridade FROM prontuario_entrada WHERE paciente_id = ? ORDER BY seq DESC LIMIT 1")
      .bind(pacienteId)
      .first<{ seq: number; hash_integridade: string }>();
    const seq = (ultima?.seq ?? 0) + 1;
    const anterior = ultima?.hash_integridade ?? HASH_GENESIS;
    const hash = await calcularHash(anterior, pacienteId, psicologoId!, sessaoId, v.conteudo, c.agora);
    try {
      const r = await c.db
        .prepare(
          `INSERT INTO prontuario_entrada
             (paciente_id, seq, sessao_id, psicologo_id, conteudo, criado_em, hash_anterior, hash_integridade)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(pacienteId, seq, sessaoId, psicologoId!, v.conteudo, c.agora, anterior, hash)
        .first<{ id: number }>();
      novoId = r!.id;
      break;
    } catch (e) {
      const restricao = violacaoUnica(e);
      if (restricao === "prontuario_entrada_sessao_id_key") {
        return formNova(c, pacienteId, v, "Esta sessão já possui entrada de prontuário.", 409);
      }
      if (restricao !== "prontuario_entrada_paciente_seq_key") throw e;
    }
  }

  if (!novoId) {
    return formNova(c, pacienteId, v, "Outra gravação simultânea no mesmo prontuário impediu o registro. Tente novamente.", 409);
  }
  await registrarLog(c, "criar", "ProntuarioEntrada", novoId, pacienteId, "nova entrada de prontuário");
  return c.redirecionar(`/prontuario/paciente/${pacienteId}`, { tipo: "success", msg: "Entrada registrada." });
}

/** Recalcula a cadeia inteira e aponta qualquer entrada que não confira. */
async function verificar(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const paciente = await carregarPaciente(c, id);
  const { results } = await c.db
    .prepare(
      `SELECT id, seq, paciente_id, sessao_id, psicologo_id, conteudo, criado_em, hash_anterior, hash_integridade
         FROM prontuario_entrada WHERE paciente_id = ? ORDER BY seq ASC`,
    )
    .bind(id)
    .all<Entrada>();

  const problemas: string[] = [];
  let esperadoAnterior = HASH_GENESIS;
  let esperadoSeq = 1;
  for (const e of results) {
    if (e.seq !== esperadoSeq) problemas.push(`Entrada #${e.seq}: sequência esperada #${esperadoSeq} (entrada ausente?).`);
    if (e.hash_anterior !== esperadoAnterior) problemas.push(`Entrada #${e.seq}: o encadeamento não confere com a entrada anterior.`);
    const recalculado = await calcularHash(e.hash_anterior, e.paciente_id, e.psicologo_id, e.sessao_id, e.conteudo, e.criado_em);
    if (recalculado !== e.hash_integridade) problemas.push(`Entrada #${e.seq}: o conteúdo não confere com o hash registrado.`);
    esperadoAnterior = e.hash_integridade;
    esperadoSeq = e.seq + 1;
  }
  await registrarLog(c, "visualizar", "ProntuarioEntrada", null, id, `verificação de integridade: ${problemas.length ? "FALHA" : "ok"}`);

  return c.pagina(
    "Integridade do prontuário",
    html`<h2>Integridade do prontuário — ${paciente.nome}</h2>
${problemas.length
  ? html`<div class="alert alert-danger"><strong>Cadeia comprometida.</strong><ul class="mb-0">${problemas.map((p) => html`<li>${p}</li>`)}</ul></div>`
  : html`<div class="alert alert-success">Cadeia íntegra: ${results.length} entrada(s) conferidas (encadeamento e conteúdo).</div>`}
<a href="/prontuario/paciente/${id}" class="btn btn-outline-primary">Voltar ao prontuário</a>`,
  );
}

// NOTA DELIBERADA: não há rota de edição/exclusão e o banco bloqueia UPDATE/DELETE
// (triggers em migrations/0001_init.sql). Correções são feitas com nova entrada.
export function registrarRotasProntuario(r: Router): void {
  r.get("/prontuario/paciente/:id", listar, { papeis: CLINICO });
  r.get("/prontuario/paciente/:id/nova", novaGet, { papeis: CLINICO });
  r.post("/prontuario/paciente/:id/nova", novaPost, { papeis: CLINICO });
  r.get("/prontuario/paciente/:id/verificar", verificar, { papeis: CLINICO });
}
