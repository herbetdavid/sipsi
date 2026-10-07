// Ponto de entrada do Worker.
import type { Banco, Env } from "./env.ts";
import { BancoPg } from "./pg.ts";
import { criarBackendNeon } from "./neon.ts";
import { criarBackendPg } from "./hyperdrive.ts";
import { Ctx, HttpError } from "./ctx.ts";
import { Router } from "./router.ts";
import { COOKIE_SESSAO, tokenCsrf, usuarioDaSessao } from "./auth.ts";
import { igualConstante } from "./crypto.ts";
import { paginaErroSimples } from "./views.ts";
import { registrarRotasAuth } from "./routes/auth.ts";
import { registrarRotasPacientes } from "./routes/pacientes.ts";
import { registrarRotasAgenda } from "./routes/agenda.ts";
import { registrarRotasProntuario } from "./routes/prontuario.ts";
import { registrarRotasObservacoes } from "./routes/observacoes.ts";
import { registrarRotasFinanceiro } from "./routes/financeiro.ts";
import { registrarRotasNfse } from "./routes/nfse.ts";
import { registrarRotasQuestionarios } from "./routes/questionarios.ts";
import { registrarRotasRelatorios } from "./routes/relatorios.ts";
import { registrarRotasDocumentos } from "./routes/documentos.ts";
import { registrarRotasAuditoria } from "./routes/auditoria.ts";
import { registrarRotasInicio } from "./routes/inicio.ts";

const TAMANHO_MAX_CORPO = 200_000; // bytes

const router = new Router();
registrarRotasInicio(router);
registrarRotasAuth(router);
registrarRotasPacientes(router);
registrarRotasAgenda(router);
registrarRotasProntuario(router);
registrarRotasObservacoes(router);
registrarRotasFinanceiro(router);
registrarRotasNfse(router);
registrarRotasQuestionarios(router);
registrarRotasRelatorios(router);
registrarRotasDocumentos(router);
registrarRotasAuditoria(router);

function comCabecalhosDeSeguranca(res: Response, c: Ctx): Response {
  const h = res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  h.set("Cache-Control", "no-store");
  if (c.https) h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if ((h.get("Content-Type") ?? "").startsWith("text/html")) {
    h.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src https://cdn.jsdelivr.net; style-src-attr 'unsafe-inline'; " +
        "img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  }
  for (const cookie of c.setCookies) h.append("Set-Cookie", cookie);
  return res;
}

/** Aceita POST só de mesma origem (Sec-Fetch-Site / Origin). */
function origemPermitida(req: Request, url: URL): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin" || site === "none";
  const origem = req.headers.get("Origin");
  if (!origem) return false;
  try {
    return new URL(origem).host === url.host;
  } catch {
    return false;
  }
}

async function tratar(c: Ctx, req: Request, env: Env): Promise<Response> {

  if (c.url.pathname === "/healthz") {
    return comCabecalhosDeSeguranca(new Response("ok", { headers: { "Content-Type": "text/plain" } }), c);
  }

  if (!env.DB && !env.HYPERDRIVE && !env.DATABASE_URL) {
    return comCabecalhosDeSeguranca(
      paginaErroSimples(500, "Configuração incompleta: configure o Hyperdrive (binding HYPERDRIVE) ou o segredo DATABASE_URL."),
      c,
    );
  }

  if (!env.PASSWORD_PEPPER) {
    return comCabecalhosDeSeguranca(
      paginaErroSimples(500, "Configuração incompleta: defina o segredo PASSWORD_PEPPER (wrangler secret put PASSWORD_PEPPER)."),
      c,
    );
  }

  // sessão
  const token = c.cookiesRecebidos[COOKIE_SESSAO];
  if (token) {
    c.user = await usuarioDaSessao(c.db, token, c.agora);
    if (c.user) {
      c.tokenSessao = token;
      c.csrf = await tokenCsrf(token);
    } else {
      c.limparCookie(COOKIE_SESSAO); // token vencido ou inválido
    }
  }

  const metodo = req.method === "HEAD" ? "GET" : req.method;
  const caminho = c.url.pathname.length > 1 ? c.url.pathname.replace(/\/+$/, "") : "/";
  const achada = router.casar(metodo, caminho);
  if (achada === null) throw new HttpError(404, "Página não encontrada.");
  if (achada === "metodo") throw new HttpError(405, "Método não permitido.");
  const { rota, params } = achada;
  c.params = params;

  if (metodo === "POST") {
    if (!origemPermitida(req, c.url)) throw new HttpError(403, "Requisição de origem não permitida.");
    const tamanho = Number(req.headers.get("Content-Length") ?? "0");
    if (tamanho > TAMANHO_MAX_CORPO) throw new HttpError(413, "Requisição grande demais.");
  }

  if (!rota.publico) {
    if (!c.user) {
      const proximo = metodo === "GET" ? `?next=${encodeURIComponent(c.url.pathname + c.url.search)}` : "";
      return comCabecalhosDeSeguranca(c.redirecionar(`/auth/login${proximo}`), c);
    }
    if (!rota.papeis.includes(c.user.papel)) {
      throw new HttpError(403, "Você não tem permissão para acessar esta área.");
    }
    if (metodo === "POST") {
      const enviado = await c.campo("_csrf");
      if (!enviado || !igualConstante(enviado, c.csrf)) {
        throw new HttpError(403, "Token de segurança inválido. Recarregue a página e tente novamente.");
      }
    }
  }

  return comCabecalhosDeSeguranca(await rota.handler(c), c);
}

export default {
  async fetch(req: Request, env: Env, execCtx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    // Uma conexão por requisição, encerrada ao final. Em testes, env.DB já vem pronto.
    // Preferência: Hyperdrive (pool perto do Neon) > driver serverless do Neon (DATABASE_URL).
    const pg = env.DB
      ? null
      : env.HYPERDRIVE
        ? new BancoPg(criarBackendPg(env.HYPERDRIVE.connectionString))
        : env.DATABASE_URL
          ? new BancoPg(criarBackendNeon(env.DATABASE_URL))
          : null;
    const banco: Banco = env.DB ?? pg ?? ({} as Banco);
    const c = new Ctx(req, env, banco);
    try {
      return await tratar(c, req, env);
    } catch (e) {
      // Páginas de erro passam pelos mesmos cabeçalhos de segurança e cookies das demais.
      if (e instanceof HttpError) return comCabecalhosDeSeguranca(paginaErroSimples(e.status, e.message), c);
      console.error("erro não tratado:", e instanceof Error ? (e.stack ?? e.message) : e);
      return comCabecalhosDeSeguranca(paginaErroSimples(500, "Erro interno. Tente novamente em instantes."), c);
    } finally {
      if (pg) {
        const fechar = pg.fechar().catch(() => undefined);
        if (execCtx) execCtx.waitUntil(fechar);
        else await fechar;
      }
    }
  },
};
