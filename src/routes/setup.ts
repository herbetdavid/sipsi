// Primeiro acesso: cria o PRIMEIRO administrador pelo navegador (sem linha de comando).
// Segurança:
//  - só existe se o segredo SETUP_TOKEN estiver definido (>= 20 caracteres) E ainda não houver nenhum usuário;
//  - exige o código SETUP_TOKEN (comparação em tempo constante) e limita tentativas;
//  - a criação é atômica (INSERT ... WHERE NOT EXISTS): duas requisições simultâneas criam no máximo um admin;
//  - depois do primeiro usuário a rota passa a responder 404 para sempre.
import type { Router } from "../router.ts";
import { HttpError, type Ctx } from "../ctx.ts";
import { html } from "../html.ts";
import { hashSenha, igualConstante } from "../crypto.ts";
import { registrarLog } from "../audit.ts";
import { registrarFalhaDeLogin, tentativasBloqueadas } from "../auth.ts";
import { emailValido } from "../util.ts";

const CHAVE_LIMITE = "__setup__"; // reaproveita a tabela de tentativas de login
const MIN_TOKEN = 20;
const MIN_SENHA = 10;

async function disponivel(c: Ctx): Promise<boolean> {
  const t = c.env.SETUP_TOKEN;
  if (!t || t.length < MIN_TOKEN) return false;
  const n = await c.db.prepare("SELECT COUNT(*) AS n FROM usuario").first<{ n: number }>();
  return (n?.n ?? 1) === 0;
}

function formulario(c: Ctx, valores: { nome?: string; email?: string }, erro: string | null, status = 200): Response {
  if (erro) c.flash = { tipo: "danger", msg: erro };
  return c.pagina(
    "Primeiro acesso",
    html`<div class="row justify-content-center mt-5"><div class="col-md-5"><div class="card"><div class="card-body">
  <h4 class="mb-1">Primeiro acesso</h4>
  <p class="text-muted small">Crie o administrador do sistema. Você precisa do código de configuração (<code>SETUP_TOKEN</code>) cadastrado na Cloudflare.</p>
  <form method="post" action="/primeiro-acesso" autocomplete="off">
    <div class="mb-3"><label class="form-label">Código de configuração</label>
      <input type="password" name="token" class="form-control" required maxlength="200" autocomplete="off"></div>
    <div class="mb-3"><label class="form-label">Nome do administrador</label>
      <input name="nome" class="form-control" required maxlength="150" value="${valores.nome ?? ""}"></div>
    <div class="mb-3"><label class="form-label">E-mail (será o login)</label>
      <input type="email" name="email" class="form-control" required maxlength="150" value="${valores.email ?? ""}"></div>
    <div class="mb-3"><label class="form-label">Senha (mínimo ${MIN_SENHA} caracteres)</label>
      <input type="password" name="senha" class="form-control" required minlength="${MIN_SENHA}" maxlength="200" autocomplete="new-password"></div>
    <div class="mb-3"><label class="form-label">Repita a senha</label>
      <input type="password" name="senha2" class="form-control" required minlength="${MIN_SENHA}" maxlength="200" autocomplete="new-password"></div>
    <button class="btn btn-primary w-100">Criar administrador</button>
  </form>
</div></div></div></div>`,
    status,
  );
}

async function setupGet(c: Ctx): Promise<Response> {
  if (!(await disponivel(c))) throw new HttpError(404, "Página não encontrada.");
  return formulario(c, {}, null);
}

async function setupPost(c: Ctx): Promise<Response> {
  if (!(await disponivel(c))) throw new HttpError(404, "Página não encontrada.");
  if (await tentativasBloqueadas(c.db, CHAVE_LIMITE, c.ip, c.agora)) {
    return formulario(c, {}, "Muitas tentativas. Aguarde alguns minutos e tente de novo.", 429);
  }

  const token = await c.campo("token", { semTrim: true });
  const nome = await c.campo("nome");
  const email = (await c.campo("email")).toLowerCase();
  const senha = await c.campo("senha", { semTrim: true });
  const senha2 = await c.campo("senha2", { semTrim: true });
  const esperado = c.env.SETUP_TOKEN as string;

  if (!token || !igualConstante(token, esperado)) {
    await registrarFalhaDeLogin(c.db, CHAVE_LIMITE, c.ip, c.agora);
    await registrarLog(c, "setup_token_invalido", "Usuario", null, null, "código de configuração incorreto");
    return formulario(c, { nome, email }, "Código de configuração incorreto.", 403);
  }
  if (!nome || nome.length > 150) return formulario(c, { nome, email }, "Informe o nome (até 150 caracteres).", 400);
  if (!emailValido(email) || email.length > 150) return formulario(c, { nome, email }, "E-mail inválido.", 400);
  if (senha.length < MIN_SENHA || senha.length > 200) return formulario(c, { nome, email }, `A senha precisa ter pelo menos ${MIN_SENHA} caracteres.`, 400);
  if (senha !== senha2) return formulario(c, { nome, email }, "As senhas não conferem.", 400);

  const hash = await hashSenha(senha, c.env.PASSWORD_PEPPER ?? "");
  const r = await c.db
    .prepare(
      `INSERT INTO usuario (nome, email, senha_hash, papel, ativo, criado_em)
       SELECT ?, ?, ?, 'admin', 1, ? WHERE NOT EXISTS (SELECT 1 FROM usuario)`,
    )
    .bind(nome, email, hash, c.agora)
    .run();
  if (r.meta.changes === 0) throw new HttpError(404, "Página não encontrada."); // alguém criou antes

  await registrarLog(c, "setup_admin_criado", "Usuario", null, null, `primeiro administrador: ${email}`);
  return c.pagina(
    "Administrador criado",
    html`<div class="row justify-content-center mt-5"><div class="col-md-5"><div class="card"><div class="card-body">
  <h4 class="mb-2">Administrador criado</h4>
  <p>Agora você já pode entrar com <strong>${email}</strong>.</p>
  <p class="small text-muted">Por segurança, remova o segredo <code>SETUP_TOKEN</code> na Cloudflare. Esta página já não funciona mais.</p>
  <a class="btn btn-primary w-100" href="/auth/login">Ir para o login</a>
</div></div></div></div>`,
  );
}

export function registrarRotasSetup(r: Router): void {
  r.get("/primeiro-acesso", setupGet, { publico: true });
  r.post("/primeiro-acesso", setupPost, { publico: true });
}
