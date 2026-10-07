import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { HttpError } from "../ctx.ts";
import { html } from "../html.ts";
import { registrarLog } from "../audit.ts";
import { dataIsoValida, emailValido } from "../util.ts";

interface Paciente {
  id: number;
  nome: string;
  cpf: string | null;
  email: string | null;
  telefone: string | null;
  data_nascimento: string | null;
}

function cpfValido(cpf: string): boolean {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number): number => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

async function listar(c: Ctx): Promise<Response> {
  const { results } = await c.db
    .prepare("SELECT id, nome, email, telefone FROM paciente ORDER BY lower(nome), nome")
    .all<Paciente>();
  return c.pagina(
    "Pacientes",
    html`<div class="d-flex justify-content-between align-items-center mb-3">
  <h2>Pacientes</h2><a href="/pacientes/novo" class="btn btn-success">+ Novo paciente</a>
</div>
<table class="table table-bordered bg-white">
  <thead><tr><th>Nome</th><th>E-mail</th><th>Telefone</th><th></th></tr></thead>
  <tbody>
    ${results.length
      ? results.map(
          (p) => html`<tr><td>${p.nome}</td><td>${p.email || "-"}</td><td>${p.telefone || "-"}</td>
            <td><a href="/pacientes/${p.id}">Ver ficha</a></td></tr>`,
        )
      : html`<tr><td colspan="4" class="text-muted">Nenhum paciente cadastrado.</td></tr>`}
  </tbody>
</table>`,
  );
}

function formNovo(c: Ctx, v: Record<string, string>, erro: string | null, status = 200): Response {
  if (erro) c.flash = { tipo: "danger", msg: erro };
  return c.pagina(
    "Novo paciente",
    html`<h2>Novo paciente</h2>
<form method="post" action="/pacientes/novo" class="bg-white p-4 rounded shadow-sm" style="max-width:500px">
  <input type="hidden" name="_csrf" value="${c.csrf}">
  <div class="mb-3"><label class="form-label">Nome</label>
    <input name="nome" class="form-control" required maxlength="150" value="${v.nome ?? ""}"></div>
  <div class="mb-3"><label class="form-label">CPF</label>
    <input name="cpf" class="form-control" maxlength="14" value="${v.cpf ?? ""}"></div>
  <div class="mb-3"><label class="form-label">Data de nascimento</label>
    <input name="data_nascimento" type="date" class="form-control" value="${v.data_nascimento ?? ""}"></div>
  <div class="mb-3"><label class="form-label">E-mail</label>
    <input name="email" type="email" class="form-control" maxlength="150" value="${v.email ?? ""}"></div>
  <div class="mb-3"><label class="form-label">Telefone</label>
    <input name="telefone" class="form-control" maxlength="20" value="${v.telefone ?? ""}"></div>
  <button class="btn btn-primary">Salvar</button>
</form>`,
    status,
  );
}

async function novoGet(c: Ctx): Promise<Response> {
  return formNovo(c, {}, null);
}

async function novoPost(c: Ctx): Promise<Response> {
  const v = {
    nome: await c.campo("nome"),
    cpf: await c.campo("cpf"),
    email: await c.campo("email"),
    telefone: await c.campo("telefone"),
    data_nascimento: await c.campo("data_nascimento"),
  };
  const erros: string[] = [];
  if (!v.nome || v.nome.length > 150) erros.push("Informe o nome (até 150 caracteres).");
  if (v.cpf && !cpfValido(v.cpf)) erros.push("CPF inválido.");
  if (v.email && !emailValido(v.email)) erros.push("E-mail inválido.");
  if (v.telefone.length > 20) erros.push("Telefone muito longo.");
  if (v.data_nascimento && !dataIsoValida(v.data_nascimento)) erros.push("Data de nascimento inválida.");
  if (erros.length) return formNovo(c, v, erros.join(" "), 400);

  const r = await c.db
    .prepare("INSERT INTO paciente (nome, cpf, email, telefone, data_nascimento, criado_em) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(v.nome, v.cpf || null, v.email || null, v.telefone || null, v.data_nascimento || null, c.agora)
    .first<{ id: number }>();
  const novoId = r!.id;
  await registrarLog(c, "criar", "Paciente", novoId, novoId, "cadastro de paciente");
  return c.redirecionar("/pacientes", { tipo: "success", msg: "Paciente cadastrado." });
}

async function detalhe(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const p = await c.db
    .prepare("SELECT id, nome, email, telefone FROM paciente WHERE id = ?")
    .bind(id)
    .first<Paciente>();
  if (!p) throw new HttpError(404, "Paciente não encontrado.");
  const n = await c.db
    .prepare("SELECT COUNT(*) AS n FROM sessao WHERE paciente_id = ?")
    .bind(id)
    .first<{ n: number }>();
  const clinico = c.user?.papel === "admin" || c.user?.papel === "psicologo";

  return c.pagina(
    p.nome,
    html`<h2>${p.nome}</h2>
<p class="text-muted">${p.email ?? ""} ${p.telefone ?? ""}</p>
<div class="row g-3 mt-2">
  ${clinico
    ? html`<div class="col-md-4"><div class="card"><div class="card-body">
        <h5>Prontuário clínico</h5>
        <p class="text-muted small">Registro oficial, sigiloso, append-only.</p>
        <a class="btn btn-sm btn-primary" href="/prontuario/paciente/${p.id}">Ver prontuário</a>
      </div></div></div>`
    : ""}
  <div class="col-md-4"><div class="card"><div class="card-body">
    <h5>Observações administrativas</h5>
    <p class="text-muted small">Não faz parte do prontuário clínico.</p>
    <a class="btn btn-sm btn-outline-secondary" href="/observacoes/paciente/${p.id}">Ver observações</a>
  </div></div></div>
  <div class="col-md-4"><div class="card"><div class="card-body">
    <h5>Sessões</h5>
    <p class="text-muted small">${n?.n ?? 0} sessão(ões) registrada(s).</p>
    <a class="btn btn-sm btn-outline-primary" href="/agenda">Ver agenda</a>
  </div></div></div>
  ${clinico
    ? html`<div class="col-md-4"><div class="card"><div class="card-body">
        <h5>Documentos clínicos</h5>
        <p class="text-muted small">Declaração, atestado, relatório (CFP 06/2019).</p>
        <a class="btn btn-sm btn-outline-primary" href="/documentos/paciente/${p.id}">Ver documentos</a>
      </div></div></div>`
    : ""}
</div>`,
  );
}

export function registrarRotasPacientes(r: Router): void {
  r.get("/pacientes", listar);
  r.get("/pacientes/novo", novoGet);
  r.post("/pacientes/novo", novoPost);
  r.get("/pacientes/:id", detalhe);
}
