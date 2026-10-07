// Contexto de uma requisição: acesso ao banco, usuário logado, formulário,
// cookies (incluindo "flash") e atalhos para montar respostas.
import type { Banco, Env } from "./env.ts";
import type { Seguro } from "./html.ts";
import type { Usuario } from "./auth.ts";
import { agoraUtc } from "./util.ts";
import { layout } from "./views.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.status = status;
  }
}

export interface Flash {
  tipo: "success" | "danger" | "warning" | "info";
  msg: string;
}

const COOKIE_FLASH = "sipsi_flash";

function lerCookies(cabecalho: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cabecalho) return out;
  for (const par of cabecalho.split(";")) {
    const i = par.indexOf("=");
    if (i < 0) continue;
    out[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
  return out;
}

export class Ctx {
  req: Request;
  url: URL;
  env: Env;
  db: Banco;
  params: Record<string, string> = {};
  user: Usuario | null = null;
  tokenSessao: string | null = null;
  csrf = "";
  ip: string;
  agora: string;
  https: boolean;
  cookiesRecebidos: Record<string, string>;
  flash: Flash | null = null;
  setCookies: string[] = [];
  formCache: FormData | null = null;

  constructor(req: Request, env: Env, db: Banco) {
    this.req = req;
    this.env = env;
    this.db = db;
    this.url = new URL(req.url);
    this.https = this.url.protocol === "https:";
    this.ip = req.headers.get("CF-Connecting-IP") ?? "desconhecido";
    this.agora = agoraUtc();
    this.cookiesRecebidos = lerCookies(req.headers.get("Cookie"));

    const bruto = this.cookiesRecebidos[COOKIE_FLASH];
    if (bruto) {
      try {
        const o = JSON.parse(decodeURIComponent(bruto)) as Flash;
        if (typeof o.msg === "string") this.flash = o;
      } catch {
        /* cookie inválido: ignora */
      }
      this.limparCookie(COOKIE_FLASH);
    }
  }

  // ----------------------------------------------------------------- cookies
  definirCookie(nome: string, valor: string, maxAgeSeg?: number): void {
    let c = `${nome}=${valor}; Path=/; HttpOnly; SameSite=Lax`;
    if (maxAgeSeg !== undefined) c += `; Max-Age=${maxAgeSeg}`;
    if (this.https) c += "; Secure";
    this.setCookies.push(c);
  }

  limparCookie(nome: string): void {
    this.definirCookie(nome, "", 0);
  }

  // -------------------------------------------------------------- formulário
  async formulario(): Promise<FormData> {
    if (!this.formCache) {
      const tipo = this.req.headers.get("Content-Type") ?? "";
      this.formCache =
        tipo.includes("application/x-www-form-urlencoded") || tipo.includes("multipart/form-data")
          ? await this.req.formData()
          : new FormData();
    }
    return this.formCache;
  }

  /** Valor de um campo de formulário (texto, com espaços das pontas removidos). */
  async campo(nome: string, opcoes: { semTrim?: boolean } = {}): Promise<string> {
    const v = (await this.formulario()).get(nome);
    if (typeof v !== "string") return "";
    return opcoes.semTrim ? v : v.trim();
  }

  // --------------------------------------------------------------- parâmetros
  idParam(nome: string): number {
    const v = this.params[nome] ?? "";
    if (!/^\d{1,12}$/.test(v)) throw new HttpError(404, "Página não encontrada.");
    return Number(v);
  }

  consulta(nome: string): string {
    return (this.url.searchParams.get(nome) ?? "").trim();
  }

  // ---------------------------------------------------------------- respostas
  redirecionar(para: string, flash?: Flash, status = 303): Response {
    if (flash) {
      this.definirCookie(COOKIE_FLASH, encodeURIComponent(JSON.stringify(flash)), 30);
    }
    return new Response(null, { status, headers: { Location: para } });
  }

  pagina(titulo: string, conteudo: Seguro, status = 200): Response {
    return new Response("<!doctype html>" + layout(this, titulo, conteudo).s, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
