import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { HttpError } from "../ctx.ts";
import { html } from "../html.ts";
import { badgeNivel } from "../views.ts";
import { registrarLog } from "../audit.ts";
import { fmtDataHoraUtc, inteiro } from "../util.ts";

interface Aplicacao {
  id: number;
  paciente_id: number;
  instrumento_id: number;
  status: string;
  data_conclusao: string | null;
  pontuacao_total: number | null;
  interpretacao: string | null;
  nivel_alerta: string | null;
  paciente_nome: string;
  sigla: string;
}

async function carregarAplicacao(c: Ctx, id: number): Promise<Aplicacao> {
  const a = await c.db
    .prepare(
      `SELECT a.id, a.paciente_id, a.instrumento_id, a.status, a.data_conclusao, a.pontuacao_total,
              a.interpretacao, a.nivel_alerta, p.nome AS paciente_nome, i.sigla
         FROM aplicacao_questionario a
         JOIN paciente p ON p.id = a.paciente_id
         JOIN instrumento i ON i.id = a.instrumento_id
        WHERE a.id = ?`,
    )
    .bind(id)
    .first<Aplicacao>();
  if (!a) throw new HttpError(404, "Aplicação não encontrada.");
  return a;
}

async function instrumentos(c: Ctx): Promise<Response> {
  const { results } = await c.db
    .prepare("SELECT id, sigla, nome, fonte_citacao FROM instrumento WHERE ativo = 1 ORDER BY sigla")
    .all<{ id: number; sigla: string; nome: string; fonte_citacao: string }>();
  return c.pagina(
    "Instrumentos de rastreio",
    html`<h2 class="mb-3">Instrumentos de rastreio</h2>
<p class="text-muted small">Motor genérico orientado a dados: novos instrumentos são cadastrados via dados
  (perguntas, opções, regras de pontuação), sem exigir alteração de código.</p>
<div class="row g-3">
  ${results.length
    ? results.map(
        (i) => html`<div class="col-md-4"><div class="card"><div class="card-body">
    <h5>${i.sigla}</h5><p class="text-muted small">${i.nome}</p>
    <p class="text-muted" style="font-size:0.75rem">Fonte: ${i.fonte_citacao}</p>
    <a href="/questionarios/aplicar/${i.id}" class="btn btn-sm btn-primary">Aplicar</a>
  </div></div></div>`,
      )
    : html`<p class="text-muted">Nenhum instrumento cadastrado.</p>`}
</div>`,
  );
}

async function instrumentoAtivo(c: Ctx, id: number): Promise<{ id: number; sigla: string }> {
  const i = await c.db.prepare("SELECT id, sigla FROM instrumento WHERE id = ? AND ativo = 1").bind(id).first<{ id: number; sigla: string }>();
  if (!i) throw new HttpError(404, "Instrumento não encontrado.");
  return i;
}

async function aplicarForm(c: Ctx, instrumentoId: number, erro: string | null = null, status = 200): Promise<Response> {
  if (erro) c.flash = { tipo: "danger", msg: erro };
  const i = await instrumentoAtivo(c, instrumentoId);
  const { results: pacientes } = await c.db
    .prepare("SELECT id, nome FROM paciente WHERE ativo = 1 ORDER BY lower(nome), nome")
    .all<{ id: number; nome: string }>();
  return c.pagina(
    `Aplicar ${i.sigla}`,
    html`<h2>Aplicar ${i.sigla}</h2>
<form method="post" action="/questionarios/aplicar/${i.id}" class="bg-white p-4 rounded shadow-sm" style="max-width:500px">
  <input type="hidden" name="_csrf" value="${c.csrf}">
  <div class="mb-3"><label class="form-label">Paciente</label>
    <select name="paciente_id" class="form-select" required>${pacientes.map((p) => html`<option value="${p.id}">${p.nome}</option>`)}</select></div>
  <button class="btn btn-primary">Iniciar aplicação</button>
</form>`,
    status,
  );
}

async function aplicarGet(c: Ctx): Promise<Response> {
  return aplicarForm(c, c.idParam("id"));
}

async function aplicarPost(c: Ctx): Promise<Response> {
  const instrumentoId = c.idParam("id");
  await instrumentoAtivo(c, instrumentoId);
  const pacienteId = inteiro(await c.campo("paciente_id"));
  const existe = pacienteId
    ? await c.db.prepare("SELECT id FROM paciente WHERE id = ? AND ativo = 1").bind(pacienteId).first()
    : null;
  if (!pacienteId || !existe) return aplicarForm(c, instrumentoId, "Selecione um paciente válido.", 400);

  const r = await c.db
    .prepare("INSERT INTO aplicacao_questionario (paciente_id, instrumento_id, status, data_envio) VALUES (?, ?, 'pendente', ?) RETURNING id")
    .bind(pacienteId, instrumentoId, c.agora)
    .first<{ id: number }>();
  await registrarLog(c, "criar", "AplicacaoQuestionario", r!.id, pacienteId, "aplicação de questionário iniciada");
  return c.redirecionar(`/questionarios/responder/${r!.id}`);
}

interface Pergunta {
  id: number;
  ordem: number;
  texto: string;
}
interface Opcao {
  id: number;
  pergunta_id: number;
  texto: string;
  valor_numerico: number;
}

async function perguntasEOpcoes(c: Ctx, instrumentoId: number): Promise<{ perguntas: Pergunta[]; opcoes: Opcao[] }> {
  const perguntas = (
    await c.db.prepare("SELECT id, ordem, texto FROM pergunta_instrumento WHERE instrumento_id = ? ORDER BY ordem").bind(instrumentoId).all<Pergunta>()
  ).results;
  const opcoes = (
    await c.db
      .prepare(
        `SELECT o.id, o.pergunta_id, o.texto, o.valor_numerico
           FROM opcao_resposta o JOIN pergunta_instrumento q ON q.id = o.pergunta_id
          WHERE q.instrumento_id = ? ORDER BY o.pergunta_id, o.ordem`,
      )
      .bind(instrumentoId)
      .all<Opcao>()
  ).results;
  return { perguntas, opcoes };
}

async function responderGet(c: Ctx): Promise<Response> {
  const a = await carregarAplicacao(c, c.idParam("id"));
  if (a.status === "concluido") return c.redirecionar(`/questionarios/resultado/${a.id}`);
  const { perguntas, opcoes } = await perguntasEOpcoes(c, a.instrumento_id);
  return c.pagina(
    `Responder ${a.sigla}`,
    html`<h2>${a.sigla} — ${a.paciente_nome}</h2>
<form method="post" action="/questionarios/responder/${a.id}" class="bg-white p-4 rounded shadow-sm">
  <input type="hidden" name="_csrf" value="${c.csrf}">
  ${perguntas.map(
    (q) => html`<div class="mb-4">
    <label class="form-label fw-bold">${q.ordem}. ${q.texto}</label>
    ${opcoes
      .filter((o) => o.pergunta_id === q.id)
      .map(
        (o) => html`<div class="form-check">
      <input class="form-check-input" type="radio" name="pergunta_${q.id}" value="${o.id}" id="op_${o.id}" required>
      <label class="form-check-label" for="op_${o.id}">${o.texto}</label></div>`,
      )}
  </div>`,
  )}
  <button class="btn btn-primary">Enviar respostas</button>
</form>`,
  );
}

/**
 * Registra as respostas e finaliza/pontua na mesma transação:
 * soma os valores, procura a faixa de interpretação e grava o resultado.
 * (No MVP original a finalização era um GET que alterava dados; aqui é parte deste POST.)
 */
async function responderPost(c: Ctx): Promise<Response> {
  const a = await carregarAplicacao(c, c.idParam("id"));
  if (a.status === "concluido") return c.redirecionar(`/questionarios/resultado/${a.id}`);
  const { perguntas, opcoes } = await perguntasEOpcoes(c, a.instrumento_id);

  const escolhidas: { pergunta: Pergunta; opcao: Opcao }[] = [];
  for (const q of perguntas) {
    const opcaoId = inteiro(await c.campo(`pergunta_${q.id}`));
    const opcao = opcaoId ? opcoes.find((o) => o.id === opcaoId && o.pergunta_id === q.id) : undefined;
    if (!opcao) {
      return c.redirecionar(`/questionarios/responder/${a.id}`, { tipo: "warning", msg: "Responda todas as perguntas para concluir." });
    }
    escolhidas.push({ pergunta: q, opcao });
  }

  const total = escolhidas.reduce((soma, e) => soma + e.opcao.valor_numerico, 0);
  const regra = await c.db
    .prepare(
      `SELECT interpretacao, nivel_alerta FROM regra_pontuacao
        WHERE instrumento_id = ? AND faixa_min <= ? AND faixa_max >= ? ORDER BY faixa_min LIMIT 1`,
    )
    .bind(a.instrumento_id, total, total)
    .first<{ interpretacao: string; nivel_alerta: string }>();

  await c.db.batch([
    ...escolhidas.map((e) =>
      c.db
        .prepare(
          `INSERT INTO resposta_questionario (aplicacao_id, pergunta_id, opcao_id, valor_numerico) VALUES (?, ?, ?, ?)
           ON CONFLICT(aplicacao_id, pergunta_id) DO UPDATE SET opcao_id = excluded.opcao_id, valor_numerico = excluded.valor_numerico`,
        )
        .bind(a.id, e.pergunta.id, e.opcao.id, e.opcao.valor_numerico),
    ),
    c.db
      .prepare(
        `UPDATE aplicacao_questionario
            SET status = 'concluido', pontuacao_total = ?, interpretacao = ?, nivel_alerta = ?, data_conclusao = ?
          WHERE id = ? AND status <> 'concluido'`,
      )
      .bind(total, regra?.interpretacao ?? "Sem regra de interpretação cadastrada", regra?.nivel_alerta ?? "normal", c.agora, a.id),
  ]);
  await registrarLog(c, "criar", "AplicacaoQuestionario", a.id, a.paciente_id, `questionário ${a.sigla} concluído`);
  return c.redirecionar(`/questionarios/resultado/${a.id}`);
}

async function resultado(c: Ctx): Promise<Response> {
  const a = await carregarAplicacao(c, c.idParam("id"));
  if (a.status !== "concluido") return c.redirecionar(`/questionarios/responder/${a.id}`);
  await registrarLog(c, "visualizar", "AplicacaoQuestionario", a.id, a.paciente_id, `resultado ${a.sigla}`);
  const nivel = a.nivel_alerta ?? "normal";
  return c.pagina(
    "Resultado",
    html`<h2>Resultado — ${a.sigla}</h2>
<div class="card" style="max-width:500px"><div class="card-body">
  <p><strong>Paciente:</strong> ${a.paciente_nome}</p>
  <p><strong>Pontuação total:</strong> ${a.pontuacao_total}</p>
  <p><strong>Interpretação:</strong> ${a.interpretacao}</p>
  <p><strong>Nível:</strong> ${badgeNivel(nivel)}</p>
  ${nivel === "alerta" || nivel === "critico"
    ? html`<div class="alert alert-warning mt-3">Este resultado indica necessidade de atenção prioritária do profissional responsável.</div>`
    : ""}
  <a href="/questionarios/evolucao/${a.paciente_id}/${a.instrumento_id}" class="btn btn-sm btn-outline-primary mt-2">Ver evolução</a>
</div></div>`,
  );
}

async function evolucao(c: Ctx): Promise<Response> {
  const pacienteId = c.idParam("pacienteId");
  const instrumentoId = c.idParam("instrumentoId");
  const p = await c.db.prepare("SELECT id, nome FROM paciente WHERE id = ?").bind(pacienteId).first<{ id: number; nome: string }>();
  const i = await c.db.prepare("SELECT id, sigla FROM instrumento WHERE id = ?").bind(instrumentoId).first<{ id: number; sigla: string }>();
  if (!p || !i) throw new HttpError(404, "Registro não encontrado.");
  const { results } = await c.db
    .prepare(
      `SELECT data_conclusao, pontuacao_total, interpretacao, nivel_alerta FROM aplicacao_questionario
        WHERE paciente_id = ? AND instrumento_id = ? AND status = 'concluido' ORDER BY data_conclusao ASC`,
    )
    .bind(pacienteId, instrumentoId)
    .all<{ data_conclusao: string; pontuacao_total: number; interpretacao: string; nivel_alerta: string }>();
  await registrarLog(c, "visualizar", "AplicacaoQuestionario", null, pacienteId, `evolução ${i.sigla}`);
  return c.pagina(
    "Evolução",
    html`<h2>Evolução — ${i.sigla} — ${p.nome}</h2>
<table class="table table-bordered bg-white">
  <thead><tr><th>Data</th><th>Pontuação</th><th>Interpretação</th><th>Nível</th></tr></thead>
  <tbody>
    ${results.length
      ? results.map((a) => html`<tr><td>${fmtDataHoraUtc(a.data_conclusao).slice(0, 10)}</td><td>${a.pontuacao_total}</td><td>${a.interpretacao}</td><td>${a.nivel_alerta}</td></tr>`)
      : html`<tr><td colspan="4" class="text-muted">Nenhuma aplicação concluída ainda.</td></tr>`}
  </tbody>
</table>`,
  );
}

export function registrarRotasQuestionarios(r: Router): void {
  r.get("/questionarios", instrumentos);
  r.get("/questionarios/aplicar/:id", aplicarGet);
  r.post("/questionarios/aplicar/:id", aplicarPost);
  r.get("/questionarios/responder/:id", responderGet);
  r.post("/questionarios/responder/:id", responderPost);
  r.get("/questionarios/resultado/:id", resultado);
  r.get("/questionarios/evolucao/:pacienteId/:instrumentoId", evolucao);
}
