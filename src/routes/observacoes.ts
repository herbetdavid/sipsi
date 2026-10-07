import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { HttpError } from "../ctx.ts";
import { html } from "../html.ts";
import { registrarLog } from "../audit.ts";
import { fmtDataHoraUtc } from "../util.ts";

// NOTA DE ACESSO: qualquer papel autenticado (admin, psicologo, recepcao) pode ver
// e criar observações — regime mais permissivo que o prontuário (decisão do MVP).

async function paciente(c: Ctx, id: number): Promise<{ id: number; nome: string }> {
  const p = await c.db.prepare("SELECT id, nome FROM paciente WHERE id = ?").bind(id).first<{ id: number; nome: string }>();
  if (!p) throw new HttpError(404, "Paciente não encontrado.");
  return p;
}

async function listar(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const p = await paciente(c, id);
  const { results } = await c.db
    .prepare("SELECT id, autor, conteudo, criado_em FROM observacao_administrativa WHERE paciente_id = ? ORDER BY criado_em DESC, id DESC")
    .bind(id)
    .all<{ id: number; autor: string | null; conteudo: string; criado_em: string }>();
  await registrarLog(c, "visualizar", "ObservacaoAdministrativa", null, id);

  return c.pagina(
    `Observações - ${p.nome}`,
    html`<div class="d-flex justify-content-between align-items-center mb-3">
  <h2>Observações administrativas — ${p.nome}</h2>
  <a href="/observacoes/paciente/${id}/nova" class="btn btn-success">+ Nova observação</a>
</div>
<p class="text-muted small">Este módulo é separado do prontuário clínico e tem regime de acesso distinto.</p>
${results.length
  ? results.map(
      (o) => html`<div class="card mb-2"><div class="card-body">
    <h6 class="card-subtitle text-muted mb-2">${fmtDataHoraUtc(o.criado_em)} — ${o.autor}</h6>
    <p class="card-text" style="white-space: pre-wrap">${o.conteudo}</p>
  </div></div>`,
    )
  : html`<p class="text-muted">Nenhuma observação registrada.</p>`}`,
  );
}

async function form(c: Ctx, id: number, conteudo: string, erro: string | null, status = 200): Promise<Response> {
  if (erro) c.flash = { tipo: "danger", msg: erro };
  const p = await paciente(c, id);
  return c.pagina(
    "Nova observação",
    html`<h2>Nova observação — ${p.nome}</h2>
<form method="post" action="/observacoes/paciente/${id}/nova" class="bg-white p-4 rounded shadow-sm" style="max-width:500px">
  <input type="hidden" name="_csrf" value="${c.csrf}">
  <p class="small text-muted">O autor registrado será o usuário logado (${c.user?.nome}).</p>
  <div class="mb-3"><label class="form-label">Conteúdo</label>
    <textarea name="conteudo" class="form-control" rows="4" required maxlength="5000">${conteudo}</textarea></div>
  <button class="btn btn-primary">Salvar</button>
</form>`,
    status,
  );
}

async function novaGet(c: Ctx): Promise<Response> {
  return form(c, c.idParam("id"), "", null);
}

async function novaPost(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  await paciente(c, id);
  const conteudo = await c.campo("conteudo");
  if (!conteudo || conteudo.length > 5000) return form(c, id, conteudo, "Informe o conteúdo (até 5.000 caracteres).", 400);
  const r = await c.db
    .prepare("INSERT INTO observacao_administrativa (paciente_id, autor, conteudo, criado_em) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(id, c.user?.nome ?? "desconhecido", conteudo, c.agora)
    .first<{ id: number }>();
  await registrarLog(c, "criar", "ObservacaoAdministrativa", r!.id, id);
  return c.redirecionar(`/observacoes/paciente/${id}`, { tipo: "success", msg: "Observação registrada." });
}

export function registrarRotasObservacoes(r: Router): void {
  r.get("/observacoes/paciente/:id", listar);
  r.get("/observacoes/paciente/:id/nova", novaGet);
  r.post("/observacoes/paciente/:id/nova", novaPost);
}
