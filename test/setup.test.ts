// Primeiro acesso: criação do primeiro administrador pelo navegador.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { PgShim } from "./pg-shim.ts";

const ORIGEM = "https://sipsi.test";
const TOKEN = "codigo-de-configuracao-bem-longo-123";
let shim: PgShim;
const env: Env = { PASSWORD_PEPPER: "pepper-de-teste", MODO_DEMO: "0" };

before(async () => {
  shim = await PgShim.criar();
  env.DB = shim;
  const pasta = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(pasta).filter((x) => x.endsWith(".sql")).sort()) await shim.exec(readFileSync(new URL(f, pasta), "utf8"));
});

const get = (c: string) => worker.fetch(new Request(ORIGEM + c), env);
const post = (c: string, f: Record<string, string>) =>
  worker.fetch(new Request(ORIGEM + c, { method: "POST", headers: { Origin: ORIGEM, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f).toString() }), env);
const dados = (o: Partial<Record<string, string>> = {}) => ({ token: TOKEN, nome: "Dona Clínica", login: "admin", email: "Admin@Clinica.com", senha: "uma-senha-longa-1", senha2: "uma-senha-longa-1", ...o }) as Record<string, string>;
const contarUsuarios = async () => (await shim.um<{ n: number }>("SELECT COUNT(*) AS n FROM usuario")).n;

test("setup: sem SETUP_TOKEN configurado, a rota não existe (404)", async () => {
  delete env.SETUP_TOKEN;
  assert.equal((await get("/primeiro-acesso")).status, 404);
  assert.equal((await post("/primeiro-acesso", dados())).status, 404);
  assert.equal(await contarUsuarios(), 0);
});

test("setup: SETUP_TOKEN curto demais é recusado (404)", async () => {
  env.SETUP_TOKEN = "curto";
  assert.equal((await get("/primeiro-acesso")).status, 404);
});

test("setup: código errado, login inválido, senha curta e senhas diferentes não criam usuário", async () => {
  env.SETUP_TOKEN = TOKEN;
  assert.equal((await get("/primeiro-acesso")).status, 200);
  assert.equal((await post("/primeiro-acesso", dados({ token: "errado" }))).status, 403);
  assert.equal((await post("/primeiro-acesso", dados({ login: "a" }))).status, 400);
  assert.equal((await post("/primeiro-acesso", dados({ senha: "curta", senha2: "curta" }))).status, 400);
  assert.equal((await post("/primeiro-acesso", dados({ senha2: "outra-senha-longa-2" }))).status, 400);
  assert.equal((await post("/primeiro-acesso", dados({ email: "nao-e-email" }))).status, 400);
  assert.equal(await contarUsuarios(), 0);
});

test("setup: o administrador criado consegue entrar com o nome de usuário", async () => {
  const r = await post("/auth/login", { login: "admin", senha: "uma-senha-longa-1" });
  assert.equal(r.status, 303);
  assert.ok(r.headers.getSetCookie().some((c) => c.includes("HttpOnly")));
  const log = await shim.um<{ n: number }>("SELECT COUNT(*) AS n FROM log_auditoria WHERE acao='setup_admin_criado'");
  assert.equal(log.n, 1);
});
