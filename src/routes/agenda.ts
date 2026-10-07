import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { HttpError } from "../ctx.ts";
import { html } from "../html.ts";
import { badgeSessao, formPost } from "../views.ts";
import { brl, dataHoraLocalValida, fmtDataHoraLocal, hojeLocal, inteiro, reaisParaCentavos } from "../util.ts";

interface LinhaSessao {
  id: number;
  data_hora: string;
  valor_centavos: number;
  status: string;
  paciente_id: number;
  paciente_nome: string;
  psicologo_nome: string;
}

async function listar(c: Ctx): Promise<Response> {
  const { results } = await c.db
    .prepare(
      `SELECT s.id, s.data_hora, s.valor_centavos, s.status, s.paciente_id,
              p.nome AS paciente_nome, ps.nome AS psicologo_nome
         FROM sessao s
         JOIN paciente p ON p.id = s.paciente_id
         JOIN psicologo ps ON ps.id = s.psicologo_id
        ORDER BY s.data_hora DESC LIMIT 300`,
    )
    .all<LinhaSessao>();

  const botao = (c: Ctx, id: number, status: string, classe: string, rotulo: string) =>
    formPost(
      c,
      `/agenda/${id}/status`,
      "d-inline",
      html`<input type="hidden" name="status" value="${status}"><button class="btn btn-sm ${classe}">${rotulo}</button>`,
    );

  return c.pagina(
    "Agenda",
    html`<div class="d-flex justify-content-between align-items-center mb-3">
  <h2>Agenda</h2><a href="/agenda/nova" class="btn btn-success">+ Nova sessão</a>
</div>
<table class="table table-bordered bg-white align-middle">
  <thead><tr><th>Data/Hora</th><th>Paciente</th><th>Psicólogo</th><th>Valor</th><th>Status</th><th>Ações</th></tr></thead>
  <tbody>
    ${results.length
      ? results.map(
          (s) => html`<tr>
        <td>${fmtDataHoraLocal(s.data_hora)}</td>
        <td><a href="/pacientes/${s.paciente_id}">${s.paciente_nome}</a></td>
        <td>${s.psicologo_nome}</td>
        <td>${brl(s.valor_centavos)}</td>
        <td>${badgeSessao(s.status)}</td>
        <td>${s.status === "agendada"
          ? html`${botao(c, s.id, "realizada", "btn-outline-success", "Marcar realizada")}
                 ${botao(c, s.id, "falta", "btn-outline-danger", "Falta")}
                 ${botao(c, s.id, "cancelada", "btn-outline-secondary", "Cancelar")}`
          : ""}</td></tr>`,
        )
      : html`<tr><td colspan="6" class="text-muted">Nenhuma sessão cadastrada.</td></tr>`}
  </tbody>
</table>`,
  );
}

async function formNova(c: Ctx, v: Record<string, string>, erro: string | null, status = 200): Promise<Response> {
  if (erro) c.flash = { tipo: "danger", msg: erro };
  const pacientes = (await c.db.prepare("SELECT id, nome FROM paciente WHERE ativo = 1 ORDER BY lower(nome), nome").all<{ id: number; nome: string }>()).results;
  const psicologos = (await c.db.prepare("SELECT id, nome FROM psicologo WHERE ativo = 1 ORDER BY nome").all<{ id: number; nome: string }>()).results;
  return c.pagina(
    "Nova sessão",
    html`<h2>Nova sessão</h2>
<form method="post" action="/agenda/nova" class="bg-white p-4 rounded shadow-sm" style="max-width:500px">
  <input type="hidden" name="_csrf" value="${c.csrf}">
  <div class="mb-3"><label class="form-label">Paciente</label>
    <select name="paciente_id" class="form-select" required>
      ${pacientes.map((p) => html`<option value="${p.id}" ${String(p.id) === v.paciente_id ? "selected" : ""}>${p.nome}</option>`)}
    </select></div>
  <div class="mb-3"><label class="form-label">Psicólogo</label>
    <select name="psicologo_id" class="form-select" required>
      ${psicologos.map((p) => html`<option value="${p.id}" ${String(p.id) === v.psicologo_id ? "selected" : ""}>${p.nome}</option>`)}
    </select></div>
  <div class="mb-3"><label class="form-label">Data e hora</label>
    <input name="data_hora" type="datetime-local" class="form-control" required value="${v.data_hora ?? ""}"></div>
  <div class="mb-3"><label class="form-label">Duração (min)</label>
    <input name="duracao_min" type="number" min="5" max="480" class="form-control" value="${v.duracao_min ?? "50"}"></div>
  <div class="mb-3"><label class="form-label">Valor (R$)</label>
    <input name="valor" type="number" step="0.01" min="0" class="form-control" value="${v.valor ?? "150.00"}"></div>
  <button class="btn btn-primary">Agendar</button>
</form>`,
    status,
  );
}

async function novaGet(c: Ctx): Promise<Response> {
  return formNova(c, {}, null);
}

async function novaPost(c: Ctx): Promise<Response> {
  const v = {
    paciente_id: await c.campo("paciente_id"),
    psicologo_id: await c.campo("psicologo_id"),
    data_hora: await c.campo("data_hora"),
    duracao_min: (await c.campo("duracao_min")) || "50",
    valor: (await c.campo("valor")) || "0",
  };
  const pacienteId = inteiro(v.paciente_id);
  const psicologoId = inteiro(v.psicologo_id);
  const duracao = inteiro(v.duracao_min);
  const valor = reaisParaCentavos(v.valor);

  const erros: string[] = [];
  if (!pacienteId) erros.push("Selecione o paciente.");
  if (!psicologoId) erros.push("Selecione o psicólogo.");
  if (!dataHoraLocalValida(v.data_hora)) erros.push("Data e hora inválidas.");
  if (!duracao || duracao < 5 || duracao > 480) erros.push("Duração deve ficar entre 5 e 480 minutos.");
  if (valor === null) erros.push("Valor inválido.");
  if (!erros.length) {
    const ok = await c.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM paciente WHERE id = ? AND ativo = 1) AS p,
                (SELECT COUNT(*) FROM psicologo WHERE id = ? AND ativo = 1) AS ps`,
      )
      .bind(pacienteId!, psicologoId!)
      .first<{ p: number; ps: number }>();
    if (!ok?.p) erros.push("Paciente não encontrado ou inativo.");
    if (!ok?.ps) erros.push("Psicólogo não encontrado ou inativo.");
  }
  if (erros.length) return formNova(c, v, erros.join(" "), 400);

  await c.db
    .prepare(
      "INSERT INTO sessao (paciente_id, psicologo_id, data_hora, duracao_min, valor_centavos, criado_em) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(pacienteId!, psicologoId!, v.data_hora, duracao!, valor!, c.agora)
    .run();
  return c.redirecionar("/agenda", { tipo: "success", msg: "Sessão agendada." });
}

/**
 * Regra central do módulo: ao marcar uma sessão como "realizada", gera o
 * lançamento financeiro correspondente — na MESMA transação (db.batch),
 * então nunca fica sessão realizada sem lançamento (nem o contrário). O INSERT só vale
 * se a sessão realmente está 'realizada' no banco: se uma requisição simultânea já a marcou
 * como falta/cancelada, nenhum lançamento é criado.
 */
async function atualizarStatus(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const novo = await c.campo("status");
  if (!["realizada", "falta", "cancelada"].includes(novo)) throw new HttpError(400, "Status inválido.");

  const sessao = await c.db.prepare("SELECT id, status FROM sessao WHERE id = ?").bind(id).first<{ id: number; status: string }>();
  if (!sessao) throw new HttpError(404, "Sessão não encontrada.");
  if (sessao.status !== "agendada") {
    return c.redirecionar("/agenda", { tipo: "warning", msg: "Só sessões agendadas podem mudar de status." });
  }

  const comandos = [c.db.prepare("UPDATE sessao SET status = ? WHERE id = ? AND status = 'agendada'").bind(novo, id)];
  if (novo === "realizada") {
    comandos.push(
      c.db
        .prepare(
          `INSERT INTO lancamento_financeiro
             (sessao_id, paciente_id, valor_centavos, status, data_vencimento, criado_em)
           SELECT id, paciente_id, valor_centavos, 'pendente', ?, ? FROM sessao WHERE id = ? AND status = 'realizada'
           ON CONFLICT (sessao_id) DO NOTHING`,
        )
        .bind(hojeLocal(), c.agora, id),
    );
  }
  await c.db.batch(comandos);
  return c.redirecionar("/agenda");
}

export function registrarRotasAgenda(r: Router): void {
  r.get("/agenda", listar);
  r.get("/agenda/nova", novaGet);
  r.post("/agenda/nova", novaPost);
  r.post("/agenda/:id/status", atualizarStatus);
}
