// Servidor HTTP local: coloca o MESMO app do Worker (fetch) atrás de node:http.
// Dois modos de banco: "arquivo" (PostgreSQL embutido em uma pasta; sem contas) ou "neon" (DATABASE_URL).
import { createServer, type IncomingMessage, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import worker from "../index.ts";
import type { Env } from "../env.ts";
import { BancoPg } from "../pg.ts";
import { criarBackendPglite } from "./pglite.ts";
import { migrarPglite } from "./migrar.ts";

const MAX_CORPO = 300_000;

export interface OpcoesLocal {
  /** Pasta dos dados (modo "arquivo"). Omitida = memória (testes). */
  dados?: string;
  /** Modo "neon": string de conexão (o app abre um pool por requisição). */
  databaseUrl?: string;
  pepper: string;
  modoDemo?: boolean;
  /** Atrás de um proxy HTTPS (Caddy/nginx): confia em X-Forwarded-Proto/For. */
  confiarProxy?: boolean;
}

export interface AppLocal {
  env: Env;
  banco: BancoPg | null;
  servidor: Server;
  fechar(): Promise<void>;
}

async function lerCorpo(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const p of req) {
    total += (p as Buffer).length;
    if (total > MAX_CORPO) throw new Error("corpo grande demais");
    partes.push(p as Buffer);
  }
  return partes.length ? Buffer.concat(partes) : undefined;
}

/** Monta o Request. O IP vem do socket (ou do proxy confiável); cabeçalhos de IP do cliente são descartados. */
export function montarRequest(req: IncomingMessage, corpo: Uint8Array | undefined, confiarProxy: boolean): Request {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const nome = k.toLowerCase();
    if (nome === "cf-connecting-ip" || nome === "x-forwarded-for" || nome === "x-forwarded-proto") continue;
    h.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  let ip = req.socket.remoteAddress ?? "desconhecido";
  let proto = "http";
  if (confiarProxy) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
    if (xff) ip = xff;
    if (req.headers["x-forwarded-proto"] === "https") proto = "https";
  }
  h.set("CF-Connecting-IP", ip);
  const metodo = req.method ?? "GET";
  const url = `${proto}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const comCorpo = metodo !== "GET" && metodo !== "HEAD" && corpo !== undefined;
  return new Request(url, { method: metodo, headers: h, body: comCorpo ? (corpo as unknown as BodyInit) : undefined });
}

export async function abrirLocal(o: OpcoesLocal): Promise<AppLocal> {
  const env: Env = { PASSWORD_PEPPER: o.pepper, MODO_DEMO: o.modoDemo ? "1" : "0" };
  let banco: BancoPg | null = null;
  let pg: PGlite | null = null;
  if (o.databaseUrl) {
    neonConfig.webSocketConstructor = ws;
    env.DATABASE_URL = o.databaseUrl; // o app abre/fecha um pool por requisição
  } else {
    pg = await PGlite.create(o.dados);
    await migrarPglite(pg);
    banco = new BancoPg(criarBackendPglite(pg));
    env.DB = banco;
  }

  const servidor = createServer(async (req, resp) => {
    try {
      const corpo = await lerCorpo(req);
      const res = await worker.fetch(montarRequest(req, corpo, o.confiarProxy === true), env);
      const cab: Record<string, string | string[]> = {};
      res.headers.forEach((v, k) => {
        if (k !== "set-cookie") cab[k] = v;
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) cab["set-cookie"] = cookies;
      resp.writeHead(res.status, cab);
      resp.end(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      const grande = e instanceof Error && e.message === "corpo grande demais";
      resp.writeHead(grande ? 413 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      resp.end(grande ? "Requisição grande demais." : "Erro interno.");
      if (!grande) console.error("erro no servidor local:", e);
    }
  });

  return {
    env,
    banco,
    servidor,
    async fechar() {
      await new Promise<void>((ok) => servidor.close(() => ok()));
      if (pg) await pg.close();
    },
  };
}
