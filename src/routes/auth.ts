import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { html, type Seguro } from "../html.ts";
import type { Flash } from "../ctx.ts";
import {
  COOKIE_SESSAO,
  SESSAO_HORAS,
  criarSessao,
  encerrarSessao,
  registrarFalhaDeLogin,
  tentativasBloqueadas,
  type Papel,
  type Usuario,
} from "../auth.ts";
import { HASH_FALSO, verificarSenha } from "../crypto.ts";
import { registrarLog } from "../audit.ts";
import { caminhoInternoSeguro } from "../util.ts";

const LOGIN_MAX = 50;
const LOGIN_MIN = 3;
const LOGIN_RE = /^[A-Za-z0-9._-]+$/;

function loginValido(login: string): boolean {
  return login.length >= LOGIN_MIN && login.length <= LOGIN_MAX && LOGIN_RE.test(login);
}

function formLogin(c: Ctx, proximo: string | null, aviso: Flash | null, status = 200): Response {
  if (aviso) c.flash = aviso;
  const dica: Seguro | string =
    c.env.MODO_DEMO === "1"
      ? html`<hr><p class="small text-muted mb-0">Usuários de demonstração:</p>
          <p class="small text-muted mb-0">admin / recepcao / carla</p>
          <p class="small text-muted">senha: 123456</p>`
      : "";
  return c.pagina(
    "Login",
    html`<div class="row justify-content-center mt-5"><div class="col-md-4"><div class="card"><div class="card-body">
  <h4 class="mb-3">Entrar</h4>
  <form method="post" action="/auth/login">
    ${proximo ? html`<input type="hidden" name="next" value="${proximo}">` : ""}
    <div class="mb-3"><label class="form-label">Nome de usuário</label>
      <input type="text" name="login" class="form-control" required autofocus autocomplete="username" maxlength="${LOGIN_MAX}"></div>
    <div class="mb-3"><label class="form-label">Senha</label>
      <input type="password" name="senha" class="form-control" required autocomplete="current-password" maxlength="200"></div>
    <button class="btn btn-primary w-100">Entrar</button>
  </form>
  ${dica}
</div></div></div></div>`,
    status,
  );
}

async function loginGet(c: Ctx): Promise<Response> {
  if (c.user) return c.redirecionar("/");
  return formLogin(c, caminhoInternoSeguro(c.consulta("next")), null);
}

interface LinhaUsuario extends Usuario {
  senha_hash: string;
}

async function loginPost(c: Ctx): Promise<Response> {
  if (c.user) return c.redirecionar("/");
  const login = (await c.campo("login")).toLowerCase();
  const senha = await c.campo("senha", { semTrim: true });
  const proximo = caminhoInternoSeguro(await c.campo("next"));
  const invalido: Flash = { tipo: "danger", msg: "Nome de usuário ou senha inválidos." };

  if (!loginValido(login) || !senha || senha.length > 200) return formLogin(c, proximo, invalido, 401);

  if (await tentativasBloqueadas(c.db, login, c.ip, c.agora)) {
    await registrarLog(c, "login_bloqueado", "Usuario", null, null, `limite de tentativas: ${login}`);
    return formLogin(c, proximo, { tipo: "danger", msg: "Muitas tentativas. Aguarde alguns minutos e tente de novo." }, 429);
  }

  const u = await c.db
    .prepare("SELECT id, nome, login, email, papel, psicologo_id, senha_hash FROM usuario WHERE lower(login) = lower(?) AND ativo = 1")
    .bind(login)
    .first<LinhaUsuario>();

  // Sempre gasta o mesmo tempo de hash, exista o usuário ou não (evita enumerar usuários).
  const ok = await verificarSenha(senha, u?.senha_hash ?? HASH_FALSO, c.env.PASSWORD_PEPPER ?? "");

  if (u && ok) {
    const { token } = await criarSessao(c.db, u.id, c.agora);
    c.definirCookie(COOKIE_SESSAO, token, SESSAO_HORAS * 3600);
    const usuario: Usuario = { id: u.id, nome: u.nome, login: u.login, email: u.email, papel: u.papel as Papel, psicologo_id: u.psicologo_id };
    await registrarLog(c, "login", "Usuario", u.id, null, `login bem-sucedido: ${login}`, usuario);
    return c.redirecionar(proximo ?? "/");
  }

  await registrarFalhaDeLogin(c.db, login, c.ip, c.agora);
  await registrarLog(c, "login_falho", "Usuario", null, null, `tentativa falha: ${login}`);
  return formLogin(c, proximo, invalido, 401);
}

async function logout(c: Ctx): Promise<Response> {
  if (c.user && c.tokenSessao) {
    await registrarLog(c, "logout", "Usuario", c.user.id);
    await encerrarSessao(c.db, c.tokenSessao);
  }
  c.limparCookie(COOKIE_SESSAO);
  return c.redirecionar("/auth/login");
}

export function registrarRotasAuth(r: Router): void {
  r.get("/auth/login", loginGet, { publico: true });
  r.post("/auth/login", loginPost, { publico: true });
  r.post("/auth/logout", logout);
}
