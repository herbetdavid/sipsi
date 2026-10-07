// Teste de ponta a ponta: chama o fetch() do Worker com Requests reais, sobre PostgreSQL real em processo (PGlite)
// (as migrações e o seed de demonstração são os mesmos arquivos usados no Neon).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PgShim } from "./pg-shim.ts";
import { gerarSeedSql } from "../scripts/gerar-seed-demo.ts";

const ORIGEM = "https://sipsi.test";
const PEPPER = "pepper-de-teste";
let shim: PgShim;
const env: Env = { PASSWORD_PEPPER: PEPPER, MODO_DEMO: "0" };

let maxConsultas = 0;
let requisicoesIniciadas = 0; // para ignorar, na contagem, requisições que se sobrepõem
let emVoo = 0;
let rotaMaxConsultas = "";

interface Resp {
  status: number;
  headers: Headers;
  texto: string;
  bytes: Uint8Array;
  local: string | null;
}

class Cliente {
  cookies = new Map<string, string>();
  csrf = "";

  async req(metodo: string, caminho: string, form?: Record<string, string>, cab: Record<string, string> = {}): Promise<Resp> {
    const headers = new Headers(cab);
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    let body: string | undefined;
    if (metodo === "POST") {
      if (!headers.has("Origin") && !headers.has("Sec-Fetch-Site")) headers.set("Origin", ORIGEM);
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(form ?? {}).toString();
    }
    const antes = shim.consultas;
    const iniciadasAntes = ++requisicoesIniciadas;
    const jaEmVoo = emVoo++;
    let res: Response;
    try {
      res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers, body }), env);
    } finally {
      emVoo--;
    }
    // sozinha = nada em andamento ao começar e nada começou enquanto rodava
    const sozinha = jaEmVoo === 0 && requisicoesIniciadas === iniciadasAntes;
    if (sozinha && shim.consultas - antes > maxConsultas) {
      maxConsultas = shim.consultas - antes;
      rotaMaxConsultas = `${metodo} ${caminho}`;
    }
    for (const sc of res.headers.getSetCookie()) {
      const [par, ...attrs] = sc.split(";");
      const i = par!.indexOf("=");
      const nome = par!.slice(0, i).trim();
      const valor = par!.slice(i + 1).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(nome);
      else this.cookies.set(nome, valor);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const r: Resp = { status: res.status, headers: res.headers, texto: new TextDecoder().decode(bytes), bytes, local: res.headers.get("Location") };
    const m = /name="_csrf" value="([0-9a-f]+)"/.exec(r.texto);
    if (m) this.csrf = m[1]!;
    return r;
  }

  get(caminho: string) {
    return this.req("GET", caminho);
  }

  /** POST já com o token CSRF da última página vista. */
  post(caminho: string, form: Record<string, string> = {}) {
    return this.req("POST", caminho, { _csrf: this.csrf, ...form });
  }

  async entrar(login: string, senha = "123456"): Promise<Resp> {
    await this.get("/auth/login");
    const r = await this.req("POST", "/auth/login", { login, senha });
    await this.get("/"); // captura o token CSRF
    return r;
  }
}

/** Texto do PDF como um leitor o veria (uma string por página). */
async function textoDoPdf(bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const paginas: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const t = await (await doc.getPage(i)).getTextContent();
    paginas.push(t.items.map((x) => ("str" in x ? x.str : "")).join(" "));
  }
  return paginas;
}

const um = <T>(sql: string, ...p: (string | number | null)[]): Promise<T> => shim.um<T>(sql, ...p);
const todos = <T>(sql: string, ...p: (string | number | null)[]): Promise<T[]> => shim.todos<T>(sql, ...p);

let admin: Cliente;
let recepcao: Cliente;
let psicologa: Cliente;

before(async () => {
  shim = await PgShim.criar();
  env.DB = shim;
  const pasta = new URL("../migrations/", import.meta.url);
  for (const arq of readdirSync(pasta).filter((f) => f.endsWith(".sql")).sort()) {
    await shim.exec(readFileSync(new URL(arq, pasta), "utf8"));
  }
  await shim.exec(await gerarSeedSql(PEPPER));
  admin = new Cliente();
  recepcao = new Cliente();
  psicologa = new Cliente();
  await admin.entrar("admin");
  await recepcao.entrar("recepcao");
  await psicologa.entrar("carla");
});

// ------------------------------------------------------------------ infraestrutura
test("configuração: sem PASSWORD_PEPPER o app recusa funcionar (falha explícita, não silenciosa)", async () => {
  const res = await worker.fetch(new Request(ORIGEM + "/auth/login"), { DB: shim });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /PASSWORD_PEPPER/);
});

test("rotas: 404 para inexistente, 405 para método errado, /healthz livre", async () => {
  const c = new Cliente();
  assert.equal((await c.get("/nao-existe")).status, 404);
  assert.equal((await c.get("/auth/logout")).status, 405);
  const h = await c.get("/healthz");
  assert.equal(h.status, 200);
  assert.equal(h.texto, "ok");
});

test("cabeçalhos de segurança em páginas HTML", async () => {
  const r = await new Cliente().get("/auth/login");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(r.headers.get("X-Frame-Options"), "DENY");
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.match(r.headers.get("Strict-Transport-Security") ?? "", /max-age=/);
  const csp = r.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/script-src/.test(csp) && !csp.includes("unsafe-eval"), "nenhum script é permitido");
});

test("páginas de erro (403/404) também levam cabeçalhos de segurança e não vazam detalhes", async () => {
  for (const r of [await recepcao.get("/auditoria"), await recepcao.get("/nao-existe")]) {
    assert.ok(r.status === 403 || r.status === 404);
    assert.equal(r.headers.get("X-Frame-Options"), "DENY");
    assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.ok(!/stack|Error:|\.ts:/.test(r.texto), "sem rastros internos");
  }
});

// -------------------------------------------------------------------- autenticação
test("sem login: redireciona para /auth/login preservando o destino", async () => {
  const r = await new Cliente().get("/pacientes");
  assert.equal(r.status, 303);
  assert.equal(r.local, "/auth/login?next=%2Fpacientes");
});

test("login: senha errada e usuário inexistente dão a MESMA resposta genérica", async () => {
  const a = new Cliente();
  const errada = await a.req("POST", "/auth/login", { login: "admin", senha: "errada" });
  const inexistente = await new Cliente().req("POST", "/auth/login", { login: "ninguem", senha: "errada" });
  assert.equal(errada.status, 401);
  assert.equal(inexistente.status, 401);
  assert.match(errada.texto, /Nome de usuário ou senha inválidos/);
  assert.match(inexistente.texto, /Nome de usuário ou senha inválidos/);
  assert.ok((await um<{ n: number }>("SELECT COUNT(*) n FROM log_auditoria WHERE acao='login_falho'")).n >= 2);
  assert.equal(a.cookies.has("sipsi_sessao"), false);
});

test("login ok: cookie HttpOnly + SameSite + Secure; token da sessão não fica em texto no banco", async () => {
  const c = new Cliente();
  await c.get("/auth/login");
  const res = await worker.fetch(
    new Request(ORIGEM + "/auth/login", {
      method: "POST",
      headers: { Origin: ORIGEM, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login: "admin", senha: "123456" }).toString(),
    }),
    env,
  );
  assert.equal(res.status, 303);
  const cookie = res.headers.getSetCookie().find((x) => x.startsWith("sipsi_sessao="))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  const token = cookie.split(";")[0]!.split("=")[1]!;
  assert.equal((await todos("SELECT 1 FROM sessao_login WHERE id_hash = ?", token)).length, 0, "banco guarda só o hash");
});

test("login: ?next só aceita caminho interno (anti open-redirect)", async () => {
  const c1 = new Cliente();
  const ok = await c1.req("POST", "/auth/login", { login: "admin", senha: "123456", next: "/agenda" });
  assert.equal(ok.local, "/agenda");
  const c2 = new Cliente();
  const mau = await c2.req("POST", "/auth/login", { login: "admin", senha: "123456", next: "//evil.com" });
  assert.equal(mau.local, "/");
});

test("login: bloqueio após 5 falhas no mesmo usuário (inclusive com a senha certa)", async () => {
  // usuário próprio, para não bloquear os demais testes
  await shim.exec(
    `INSERT INTO usuario (nome, login, email, senha_hash, papel, criado_em)
     SELECT 'Teste Limite', 'limite', 'limite@x.com', senha_hash, 'recepcao', '2026-01-01T00:00:00' FROM usuario WHERE login='admin'`,
  );
  const c = new Cliente();
  for (let i = 0; i < 5; i++) assert.equal((await c.req("POST", "/auth/login", { login: "limite", senha: "errada" })).status, 401);
  const bloqueado = await c.req("POST", "/auth/login", { login: "limite", senha: "123456" });
  assert.equal(bloqueado.status, 429);
  assert.match(bloqueado.texto, /Muitas tentativas/);
  assert.equal(c.cookies.has("sipsi_sessao"), false);
});

test("usuário inativo não consegue entrar", async () => {
  await shim.exec(
    `INSERT INTO usuario (nome, login, email, senha_hash, papel, ativo, criado_em)
     SELECT 'Inativo', 'inativo', 'inativo@x.com', senha_hash, 'recepcao', 0, '2026-01-01T00:00:00' FROM usuario WHERE login='admin'`,
  );
  assert.equal((await new Cliente().req("POST", "/auth/login", { login: "inativo", senha: "123456" })).status, 401);
});

test("sessão vencida no banco = deslogado", async () => {
  const c = new Cliente();
  await c.entrar("recepcao");
  assert.equal((await c.get("/pacientes")).status, 200);
  await shim.exec("UPDATE sessao_login SET expira_em = '2000-01-01T00:00:00'");
  assert.equal((await c.get("/pacientes")).status, 303);
  await admin.entrar("admin"); // restaura as sessões que expiramos acima
  await recepcao.entrar("recepcao");
  await psicologa.entrar("carla");
});

// ------------------------------------------------------------------------- CSRF
test("CSRF: POST sem token, com token errado ou de outra origem é recusado", async () => {
  const semToken = await admin.req("POST", "/pacientes/novo", { nome: "Sem Token" });
  assert.equal(semToken.status, 403);
  const errado = await admin.req("POST", "/pacientes/novo", { _csrf: "0".repeat(64), nome: "Token Errado" });
  assert.equal(errado.status, 403);
  const outraOrigem = await admin.req("POST", "/pacientes/novo", { _csrf: admin.csrf, nome: "Origem Errada" }, { Origin: "https://evil.example" });
  assert.equal(outraOrigem.status, 403);
  const crossSite = await admin.req("POST", "/pacientes/novo", { _csrf: admin.csrf, nome: "Cross Site" }, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const semOrigem = await new Cliente().req("POST", "/auth/login", { login: "admin", senha: "123456" }, { Origin: "" });
  assert.equal(semOrigem.status, 403, "login também exige mesma origem");
  assert.equal((await um<{ n: number }>("SELECT COUNT(*) n FROM paciente WHERE nome IN ('Sem Token','Token Errado','Origem Errada','Cross Site')")).n, 0);
});

test("CSRF: o token de um usuário não vale para outro", async () => {
  const r = await admin.req("POST", "/pacientes/novo", { _csrf: recepcao.csrf, nome: "Token Alheio" });
  assert.equal(r.status, 403);
});

// ------------------------------------------------------------------------- RBAC
test("RBAC: cada papel só acessa o que lhe cabe", async () => {
  const casos: [Cliente, string, number][] = [
    [recepcao, "/prontuario/paciente/1", 403],
    [recepcao, "/documentos/paciente/1", 403],
    [recepcao, "/auditoria", 403],
    [recepcao, "/financeiro", 200],
    [recepcao, "/nfse", 200],
    [recepcao, "/pacientes", 200],
    [psicologa, "/financeiro", 403],
    [psicologa, "/nfse", 403],
    [psicologa, "/auditoria", 403],
    [psicologa, "/prontuario/paciente/1", 200],
    [psicologa, "/documentos/paciente/1", 200],
    [admin, "/auditoria", 200],
    [admin, "/financeiro", 200],
    [admin, "/prontuario/paciente/1", 200],
  ];
  for (const [cliente, caminho, esperado] of casos) {
    assert.equal((await cliente.get(caminho)).status, esperado, `${caminho}`);
  }
  // POST de área proibida também é barrado (antes mesmo de olhar o token)
  assert.equal((await recepcao.post("/prontuario/paciente/1/nova", { conteudo: "x", psicologo_id: "1" })).status, 403);
  // a ficha do paciente não mostra links de áreas que o papel não acessa
  const ficha = await recepcao.get("/pacientes/1");
  assert.ok(!ficha.texto.includes("/prontuario/paciente/1"));
  assert.ok((await psicologa.get("/pacientes/1")).texto.includes("/prontuario/paciente/1"));
});

// ----------------------------------------------------------------- pacientes / XSS
test("pacientes: validação (CPF, e-mail, data) e proteção contra XSS na listagem", async () => {
  await admin.get("/pacientes/novo");
  assert.equal((await admin.post("/pacientes/novo", { nome: "Fulano", cpf: "111.111.111-11" })).status, 400);
  assert.equal((await admin.post("/pacientes/novo", { nome: "Fulano", email: "isso-nao-e-email" })).status, 400);
  assert.equal((await admin.post("/pacientes/novo", { nome: "Fulano", data_nascimento: "2026-02-30" })).status, 400);
  assert.equal((await admin.post("/pacientes/novo", { nome: "" })).status, 400);

  const xss = `<script>alert('x')</script>`;
  const ok = await admin.post("/pacientes/novo", { nome: xss, cpf: "529.982.247-25", email: "a@b.co" });
  assert.equal(ok.status, 303);
  const lista = await admin.get("/pacientes");
  assert.ok(!lista.texto.includes("<script>alert"), "HTML do nome não pode ser interpretado");
  assert.ok(lista.texto.includes("&lt;script&gt;alert"));
  const id = (await um<{ id: number }>("SELECT id FROM paciente WHERE nome = ?", xss)).id;
  assert.ok(!(await admin.get(`/pacientes/${id}`)).texto.includes("<script>alert"));
  // erro de validação reapresenta o formulário SEM refletir HTML cru
  const refletido = await admin.post("/pacientes/novo", { nome: `"><b>oi</b>`, cpf: "000" });
  assert.equal(refletido.status, 400);
  assert.ok(!refletido.texto.includes("<b>oi</b>"));
  assert.equal((await admin.get("/pacientes/999999")).status, 404);
  assert.equal((await admin.get("/pacientes/abc")).status, 404);
});

// ---------------------------------------------------------------------- agenda
test("agenda: cria sessão com validação; valor vira centavos", async () => {
  await admin.get("/agenda/nova");
  const base = { paciente_id: "3", psicologo_id: "1", data_hora: "2026-12-01T10:00", duracao_min: "50", valor: "199,90" };
  assert.equal((await admin.post("/agenda/nova", { ...base, data_hora: "ontem" })).status, 400);
  assert.equal((await admin.post("/agenda/nova", { ...base, valor: "-5" })).status, 400);
  assert.equal((await admin.post("/agenda/nova", { ...base, paciente_id: "999" })).status, 400);
  assert.equal((await admin.post("/agenda/nova", { ...base, duracao_min: "0" })).status, 400);
  assert.equal((await admin.post("/agenda/nova", base)).status, 303);
  const s = (await um<{ valor_centavos: number; status: string }>("SELECT valor_centavos, status FROM sessao ORDER BY id DESC LIMIT 1"));
  assert.deepEqual({ ...s }, { valor_centavos: 19990, status: "agendada" });
  const lista = await admin.get("/agenda");
  assert.ok(lista.texto.includes("R$ 199,90"));
  assert.ok(lista.texto.includes("01/12/2026 10:00"));
});

test("agenda → financeiro: 'realizada' gera UM lançamento (idempotente); status inválido é recusado", async () => {
  const sess = (await um<{ id: number; valor_centavos: number }>("SELECT id, valor_centavos FROM sessao WHERE status='agendada' ORDER BY id LIMIT 1"));
  await admin.get("/agenda");
  assert.equal((await admin.post(`/agenda/${sess.id}/status`, { status: "hackeado" })).status, 400);
  assert.equal((await admin.post(`/agenda/${sess.id}/status`, { status: "realizada" })).status, 303);
  const l = (await todos<{ valor_centavos: number; status: string; data_vencimento: string }>("SELECT * FROM lancamento_financeiro WHERE sessao_id = ?", sess.id));
  assert.equal(l.length, 1);
  assert.equal(l[0]!.valor_centavos, sess.valor_centavos);
  assert.equal(l[0]!.status, "pendente");
  assert.match(l[0]!.data_vencimento, /^\d{4}-\d{2}-\d{2}$/);
  // repetir não duplica nem muda de novo
  const outra = await admin.post(`/agenda/${sess.id}/status`, { status: "falta" });
  assert.equal(outra.status, 303);
  assert.equal((await um<{ status: string }>("SELECT status FROM sessao WHERE id = ?", sess.id)).status, "realizada");
  assert.equal((await todos("SELECT 1 FROM lancamento_financeiro WHERE sessao_id = ?", sess.id)).length, 1);
  // falta/cancelada não geram lançamento
  const nova = (await um<{ id: number }>("SELECT id FROM sessao WHERE status='agendada' ORDER BY id LIMIT 1"));
  if (nova) {
    await admin.post(`/agenda/${nova.id}/status`, { status: "cancelada" });
    assert.equal((await todos("SELECT 1 FROM lancamento_financeiro WHERE sessao_id = ?", nova.id)).length, 0);
  }
  assert.equal((await admin.post("/agenda/999999/status", { status: "realizada" })).status, 404);
});

// ------------------------------------------------------------------- financeiro
test("financeiro: registrar pagamento (uma vez só) e forma de pagamento validada", async () => {
  const pend = (await um<{ id: number }>("SELECT id FROM lancamento_financeiro WHERE status='pendente' ORDER BY id LIMIT 1"));
  await recepcao.get("/financeiro");
  assert.equal((await recepcao.post(`/financeiro/${pend.id}/pagar`, { forma_pagamento: "fiado" })).status, 400);
  assert.equal((await recepcao.post(`/financeiro/${pend.id}/pagar`, { forma_pagamento: "cartao" })).status, 303);
  const l = (await um<{ status: string; forma_pagamento: string; data_pagamento: string }>("SELECT * FROM lancamento_financeiro WHERE id = ?", pend.id));
  assert.equal(l.status, "pago");
  assert.equal(l.forma_pagamento, "cartao");
  assert.match(l.data_pagamento, /^\d{4}-\d{2}-\d{2}$/);
  // pagar de novo não altera nada
  await recepcao.post(`/financeiro/${pend.id}/pagar`, { forma_pagamento: "pix" });
  assert.equal((await um<{ forma_pagamento: string }>("SELECT forma_pagamento FROM lancamento_financeiro WHERE id = ?", pend.id)).forma_pagamento, "cartao");
});

// -------------------------------------------------------------------------- NFS-e
test("NFS-e: só emite para lançamento pago, uma vez, com ISS de 5% em centavos", async () => {
  const pago = (await um<{ id: number; valor_centavos: number }>("SELECT id, valor_centavos FROM lancamento_financeiro WHERE status='pago' ORDER BY id LIMIT 1"));
  await recepcao.get("/nfse");
  const r1 = await recepcao.post(`/nfse/emitir/${pago.id}`);
  assert.equal(r1.status, 303);
  const nota = (await um<{ numero_nota: string; status: string; valor_iss_centavos: number; codigo_verificacao: string }>(
    "SELECT * FROM nota_fiscal WHERE lancamento_id = ?", pago.id));
  assert.match(nota.numero_nota, /^\d{8}$/);
  assert.equal(nota.status, "emitida");
  assert.equal(nota.valor_iss_centavos, Math.round(pago.valor_centavos * 0.05));
  const pagina = await recepcao.get("/nfse");
  assert.ok(pagina.texto.includes(nota.numero_nota));
  // segunda emissão não cria outra nota nem troca o número
  await recepcao.post(`/nfse/emitir/${pago.id}`);
  assert.equal((await todos("SELECT 1 FROM nota_fiscal WHERE lancamento_id = ?", pago.id)).length, 1);
  assert.equal((await um<{ numero_nota: string }>("SELECT numero_nota FROM nota_fiscal WHERE lancamento_id = ?", pago.id)).numero_nota, nota.numero_nota);
  // lançamento pendente é recusado
  const pend = (await um<{ id: number }>("SELECT id FROM lancamento_financeiro WHERE status='pendente' LIMIT 1"));
  if (pend) {
    await recepcao.post(`/nfse/emitir/${pend.id}`);
    assert.equal((await todos("SELECT 1 FROM nota_fiscal WHERE lancamento_id = ?", pend.id)).length, 0);
  }
  assert.equal((await recepcao.post("/nfse/emitir/999999")).status, 404);
  // nota com erro pode ser reemitida; nota emitida, não
  await shim.exec(`UPDATE nota_fiscal SET status='erro', numero_nota=NULL WHERE lancamento_id=${pago.id}`);
  await recepcao.post(`/nfse/emitir/${pago.id}`);
  assert.equal((await um<{ status: string }>("SELECT status FROM nota_fiscal WHERE lancamento_id = ?", pago.id)).status, "emitida");
});

// ------------------------------------------------------------------ questionários
test("questionários: pontua, interpreta pela faixa, exige respostas completas e não permite refazer", async () => {
  await admin.get("/questionarios");
  const ap = await admin.post("/questionarios/aplicar/1", { paciente_id: "1" });
  assert.equal(ap.status, 303);
  const caminhoResponder = ap.local!;
  assert.match(caminhoResponder, /^\/questionarios\/responder\/\d+$/);
  const idAp = caminhoResponder.split("/").pop()!;

  const form = await admin.get(caminhoResponder);
  assert.equal(form.status, 200);
  assert.ok(form.texto.includes("pergunta_1") && form.texto.includes("Frequentemente"));

  // incompleto: volta para responder, nada é concluído
  const inc = await admin.post(caminhoResponder, { pergunta_1: "4" });
  assert.equal(inc.local, caminhoResponder);
  assert.equal((await um<{ status: string }>("SELECT status FROM aplicacao_questionario WHERE id = ?", idAp)).status, "pendente");
  // opção de OUTRA pergunta não é aceita
  const trocada = await admin.post(caminhoResponder, { pergunta_1: "5", pergunta_2: "5", pergunta_3: "9" });
  assert.equal(trocada.local, caminhoResponder);

  // 3 + 3 + 3 = 9 -> faixa "critico"
  const ok = await admin.post(caminhoResponder, { pergunta_1: "4", pergunta_2: "8", pergunta_3: "12" });
  assert.equal(ok.local, `/questionarios/resultado/${idAp}`);
  const a = (await um<{ status: string; pontuacao_total: number; nivel_alerta: string; interpretacao: string }>("SELECT * FROM aplicacao_questionario WHERE id = ?", idAp));
  assert.equal(a.status, "concluido");
  assert.equal(a.pontuacao_total, 9);
  assert.equal(a.nivel_alerta, "critico");
  const res = await admin.get(`/questionarios/resultado/${idAp}`);
  assert.ok(res.texto.includes("Sinais importantes") && res.texto.includes("atenção prioritária do profissional"));

  // já concluído: reenviar não altera o resultado
  await admin.post(caminhoResponder, { pergunta_1: "1", pergunta_2: "5", pergunta_3: "9" });
  assert.equal((await um<{ pontuacao_total: number }>("SELECT pontuacao_total FROM aplicacao_questionario WHERE id = ?", idAp)).pontuacao_total, 9);

  // outra aplicação com pontuação baixa -> "normal"; evolução lista as duas em ordem
  const ap2 = (await admin.post("/questionarios/aplicar/1", { paciente_id: "1" })).local!;
  await admin.post(ap2, { pergunta_1: "1", pergunta_2: "5", pergunta_3: "9" });
  const idAp2 = ap2.split("/").pop()!;
  assert.equal((await um<{ nivel_alerta: string }>("SELECT nivel_alerta FROM aplicacao_questionario WHERE id = ?", idAp2)).nivel_alerta, "normal");
  const ev = await admin.get("/questionarios/evolucao/1/1");
  assert.equal((ev.texto.match(/<tr><td>\d{2}\/\d{2}\/\d{4}<\/td>/g) ?? []).length, 2);
  // paciente inválido
  assert.equal((await admin.post("/questionarios/aplicar/1", { paciente_id: "999" })).status, 400);
  assert.equal((await admin.get("/questionarios/aplicar/999")).status, 404);
});

// ---------------------------------------------------------------------- prontuário
test("prontuário: entradas encadeadas por hash, verificação de integridade e imutabilidade no banco", async () => {
  await psicologa.get("/prontuario/paciente/2/nova");
  const e1 = await psicologa.post("/prontuario/paciente/2/nova", { psicologo_id: "1", sessao_id: "", conteudo: "Primeira evolução." });
  assert.equal(e1.status, 303);
  const e2 = await psicologa.post("/prontuario/paciente/2/nova", { psicologo_id: "1", sessao_id: "", conteudo: "Segunda evolução <b>negrito?</b>" });
  assert.equal(e2.status, 303);

  const linhas = (await todos<{ seq: number; hash_anterior: string; hash_integridade: string }>(
    "SELECT seq, hash_anterior, hash_integridade FROM prontuario_entrada WHERE paciente_id = 2 ORDER BY seq"));
  assert.equal(linhas.length, 2);
  assert.deepEqual(linhas.map((l) => l.seq), [1, 2]);
  assert.equal(linhas[0]!.hash_anterior, "GENESIS");
  assert.equal(linhas[1]!.hash_anterior, linhas[0]!.hash_integridade, "cada entrada aponta para a anterior");
  assert.notEqual(linhas[0]!.hash_integridade, linhas[1]!.hash_integridade);

  const lista = await psicologa.get("/prontuario/paciente/2");
  assert.ok(lista.texto.includes("Primeira evolução."));
  assert.ok(!lista.texto.includes("<b>negrito?</b>"), "conteúdo clínico é escapado");
  assert.ok(lista.texto.indexOf("Segunda") < lista.texto.indexOf("Primeira"), "mais recente primeiro");

  assert.match((await psicologa.get("/prontuario/paciente/2/verificar")).texto, /Cadeia íntegra: 2 entrada/);

  // o banco recusa UPDATE e DELETE
  await assert.rejects(() => shim.exec("UPDATE prontuario_entrada SET conteudo='adulterado' WHERE paciente_id=2"), /append-only/);
  await assert.rejects(() => shim.exec("DELETE FROM prontuario_entrada WHERE paciente_id=2"), /append-only/);

  // se alguém burlar o banco (ex.: removendo o trigger), a verificação DETECTA a adulteração
  await shim.exec("DROP TRIGGER prontuario_entrada_sem_update ON prontuario_entrada");
  await shim.exec("UPDATE prontuario_entrada SET conteudo='texto alterado por fora' WHERE paciente_id=2 AND seq=1");
  const ver = await psicologa.get("/prontuario/paciente/2/verificar");
  assert.match(ver.texto, /Cadeia comprometida/);
  assert.match(ver.texto, /Entrada #1: o conteúdo não confere/);
});

test("prontuário: psicólogo só assina em seu nome; sessão só vincula uma vez e do próprio paciente", async () => {
  await shim.exec("INSERT INTO psicologo (id, nome, crp) VALUES (2, 'Dr. Outro', '06/999999')");
  await psicologa.get("/prontuario/paciente/1/nova");
  const alheio = await psicologa.post("/prontuario/paciente/1/nova", { psicologo_id: "2", conteudo: "assinando por outro" });
  assert.equal(alheio.status, 400);
  assert.equal((await todos("SELECT 1 FROM prontuario_entrada WHERE conteudo = 'assinando por outro'")).length, 0);
  // admin pode escolher qualquer psicólogo ativo
  await admin.get("/prontuario/paciente/1/nova");
  assert.equal((await admin.post("/prontuario/paciente/1/nova", { psicologo_id: "2", conteudo: "admin assina pelo Dr. Outro" })).status, 303);

  // sessão 1 é realizada e do paciente 1
  assert.equal((await psicologa.post("/prontuario/paciente/1/nova", { psicologo_id: "1", sessao_id: "1", conteudo: "vinculada à sessão 1" })).status, 303);
  assert.equal((await um<{ sessao_id: number }>("SELECT sessao_id FROM prontuario_entrada WHERE conteudo = 'vinculada à sessão 1'")).sessao_id, 1);
  assert.equal((await psicologa.post("/prontuario/paciente/1/nova", { psicologo_id: "1", sessao_id: "1", conteudo: "de novo na sessão 1" })).status, 400);
  // sessão de outro paciente (3 = paciente 2)
  assert.equal((await psicologa.post("/prontuario/paciente/1/nova", { psicologo_id: "1", sessao_id: "3", conteudo: "sessão alheia" })).status, 400);
  assert.equal((await psicologa.post("/prontuario/paciente/1/nova", { psicologo_id: "1", conteudo: "" })).status, 400);
  // a cadeia do paciente 1 segue íntegra mesmo com várias entradas
  assert.match((await psicologa.get("/prontuario/paciente/1/verificar")).texto, /Cadeia íntegra: 2 entrada/);
});

// ------------------------------------------------------------------- observações
test("observações: qualquer papel cria; autor é o usuário logado (não o digitado); conteúdo escapado", async () => {
  await recepcao.get("/observacoes/paciente/1/nova");
  const r = await recepcao.post("/observacoes/paciente/1/nova", { conteudo: "Prefere contato por <i>WhatsApp</i>", autor: "Falsificado" });
  assert.equal(r.status, 303);
  const o = (await um<{ autor: string }>("SELECT autor FROM observacao_administrativa ORDER BY id DESC LIMIT 1"));
  assert.equal(o.autor, "Ana (Recepção)");
  const lista = await recepcao.get("/observacoes/paciente/1");
  assert.ok(lista.texto.includes("&lt;i&gt;WhatsApp&lt;/i&gt;") && !lista.texto.includes("<i>WhatsApp"));
  assert.equal((await recepcao.post("/observacoes/paciente/1/nova", { conteudo: "   " })).status, 400);
});

// ------------------------------------------------------------------------ documentos
test("documentos: gera PDF válido, idêntico a cada download, congelado no momento da emissão", async () => {
  await psicologa.get("/documentos/paciente/1/declaracao");
  const campos = { psicologo_id: "1", data_atendimento: "2026-09-30", horario_inicio: "10:00", horario_fim: "10:50" };
  assert.equal((await psicologa.post("/documentos/paciente/1/declaracao", { ...campos, horario_fim: "09:00" })).status, 400);
  assert.equal((await psicologa.post("/documentos/paciente/1/declaracao", { ...campos, data_atendimento: "31/09" })).status, 400);
  assert.equal((await psicologa.post("/documentos/paciente/1/declaracao", { ...campos, psicologo_id: "2" })).status, 400);
  const emitir = await psicologa.post("/documentos/paciente/1/declaracao", campos);
  assert.equal(emitir.status, 303);
  assert.match(emitir.local!, /^\/documentos\/baixar\/\d+$/);

  const pdf1 = await psicologa.get(emitir.local!);
  assert.equal(pdf1.status, 200);
  assert.equal(pdf1.headers.get("Content-Type"), "application/pdf");
  assert.match(pdf1.headers.get("Content-Disposition") ?? "", /^inline; filename="declaracao_1_\d+\.pdf"$/);
  assert.equal(new TextDecoder().decode(pdf1.bytes.slice(0, 5)), "%PDF-");
  const doc = await PDFDocument.load(pdf1.bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), "Documento Psicológico - Sipsi");

  // conteúdo real do PDF, extraído como um leitor faria (acentos, datas e assinatura incluídos)
  const [pag1] = await textoDoPdf(pdf1.bytes);
  for (const trecho of ["DECLARAÇÃO DE COMPARECIMENTO", "Nome: João Pereira", "CPF: 529.982.247-25", "Data de nascimento: 12/05/1990",
    "30/09/2026", "10:00 às 10:50", "Dra. Carla Menezes - CRP 06/123456", "Resolução CFP nº 06/2019", "Página 1"]) {
    assert.ok(pag1!.includes(trecho), `PDF deveria conter: ${trecho}`);
  }

  // regenera idêntico (byte a byte)...
  const pdf2 = await psicologa.get(emitir.local!);
  assert.deepEqual(pdf2.bytes, pdf1.bytes);
  // ...e continua idêntico mesmo se o cadastro mudar depois (snapshot)
  await shim.exec("UPDATE paciente SET nome = 'Nome Novo', cpf = NULL WHERE id = 1");
  const pdf3 = await psicologa.get(emitir.local!);
  assert.deepEqual(pdf3.bytes, pdf1.bytes, "documento emitido não muda se o cadastro mudar");
  assert.ok((await textoDoPdf(pdf3.bytes))[0]!.includes("João Pereira"), "nome antigo preservado no documento");
  await shim.exec("UPDATE paciente SET nome = 'João Pereira', cpf = '529.982.247-25' WHERE id = 1");

  // listagem + auditoria do download
  const lista = await psicologa.get("/documentos/paciente/1");
  assert.ok(lista.texto.includes("Declaração de comparecimento") && lista.texto.includes(emitir.local!));
  assert.ok((await todos("SELECT 1 FROM log_auditoria WHERE entidade='DocumentoClinico' AND acao='visualizar'")).length >= 3);
  // recepção não baixa documento clínico
  assert.equal((await recepcao.get(emitir.local!)).status, 403);
  assert.equal((await psicologa.get("/documentos/baixar/999999")).status, 404);
});

test("documentos: atestado e relatório longo (várias páginas, caracteres fora do Latin-1 não quebram)", async () => {
  await psicologa.get("/documentos/paciente/1/atestado");
  assert.equal((await psicologa.post("/documentos/paciente/1/atestado", { psicologo_id: "1", dias_afastamento: "0" })).status, 400);
  assert.equal((await psicologa.post("/documentos/paciente/1/atestado", { psicologo_id: "1", dias_afastamento: "3", cid: "F41.1; DROP" })).status, 400);
  const at = await psicologa.post("/documentos/paciente/1/atestado", { psicologo_id: "1", dias_afastamento: "3", cid: "F41.1" });
  assert.equal(at.status, 303);
  const pdfAt = await psicologa.get(at.local!);
  assert.equal(pdfAt.status, 200);
  assert.equal((await PDFDocument.load(pdfAt.bytes)).getPageCount(), 1);
  const textoAt = (await textoDoPdf(pdfAt.bytes))[0]!;
  assert.ok(textoAt.includes("ATESTADO PSICOLÓGICO") && textoAt.includes("3 dia(s)") && textoAt.includes("CID: F41.1."));

  const longo = "Paciente relata melhora gradual, com maior adesão às estratégias propostas. ".repeat(40);
  const rel = await psicologa.post("/documentos/paciente/1/relatorio", {
    psicologo_id: "1",
    motivo: "Demanda espontânea 😀 — acompanhamento “quinzenal”.",
    procedimentos: longo + "\n\n" + longo,
    analise: longo,
    conclusao: "Palavra" + "x".repeat(300) + " final.",
  });
  assert.equal(rel.status, 303);
  const pdfRel = await psicologa.get(rel.local!);
  assert.equal(pdfRel.status, 200);
  const paginas = (await PDFDocument.load(pdfRel.bytes)).getPageCount();
  assert.ok(paginas >= 2, `relatório longo deve paginar (páginas: ${paginas})`);
  const textos = await textoDoPdf(pdfRel.bytes);
  assert.ok(textos[0]!.includes("Página 1") && textos[1]!.includes("Página 2"), "cabeçalho/rodapé em cada página");
  assert.ok(textos[0]!.includes("Demanda espontânea ? — acompanhamento “quinzenal”."), "emoji vira '?'; aspas e travessão (WinAnsi) preservados");
  assert.ok(textos.join(" ").includes("4. Conclusão") && textos.at(-1)!.includes("CRP 06/123456"), "todas as seções e a assinatura aparecem");
  assert.equal((await psicologa.post("/documentos/paciente/1/relatorio", { psicologo_id: "1", motivo: "só um campo" })).status, 400);
});

// ------------------------------------------------------------------------ relatórios
test("relatórios: totais, taxas e filtros de período (datas inválidas são ignoradas)", async () => {
  const fat = await admin.get("/relatorios/faturamento");
  assert.equal(fat.status, 200);
  const pago = (await um<{ t: number }>("SELECT COALESCE(SUM(valor_centavos),0) t FROM lancamento_financeiro WHERE status='pago'")).t;
  const pend = (await um<{ t: number }>("SELECT COALESCE(SUM(valor_centavos),0) t FROM lancamento_financeiro WHERE status='pendente'")).t;
  const brl = (c: number) => `R$ ${Math.floor(c / 100).toLocaleString("pt-BR")},${String(c % 100).padStart(2, "0")}`;
  assert.ok(fat.texto.includes(`<h3>${brl(pago)}</h3>`), `recebido ${brl(pago)}`);
  assert.ok(fat.texto.includes(`<h3>${brl(pend)}</h3>`), `pendente ${brl(pend)}`);

  const vazio = await admin.get("/relatorios/faturamento?inicio=2099-01-01");
  assert.ok(vazio.texto.includes("Sem dados no período"));
  const invalido = await admin.get("/relatorios/faturamento?inicio=lixo'; DROP TABLE paciente;--");
  assert.equal(invalido.status, 200);
  assert.ok((await todos("SELECT 1 FROM paciente")).length > 0, "tabela intacta");

  const f = await psicologa.get("/relatorios/faltas");
  const total = (await um<{ n: number }>("SELECT COUNT(*) n FROM sessao")).n;
  const faltas = (await um<{ n: number }>("SELECT COUNT(*) n FROM sessao WHERE status='falta'")).n;
  assert.ok(f.texto.includes(`<h3>${total}</h3>`));
  assert.ok(f.texto.includes(`<h3>${((faltas / total) * 100).toFixed(1).replace(".", ",")}%</h3>`));

  const lc = await recepcao.get("/relatorios/livro-caixa");
  const soma = (await um<{ t: number }>("SELECT COALESCE(SUM(valor_centavos),0) t FROM lancamento_financeiro WHERE status='pago'")).t;
  assert.ok(lc.texto.includes(`<th>${brl(soma)}</th>`), `livro caixa total ${brl(soma)}`);
});

// ------------------------------------------------------------------- concorrência
// O PGlite tem uma conexão só e executa uma consulta por vez (sem deadlock), mas DUAS REQUISIÇÕES podem se
// intercalar entre uma consulta e outra. Estes testes disparam requisições simultâneas e conferem
// os invariantes (as requisições se intercalam a cada consulta, mas sem paralelismo real entre conexões).

test("concorrência: gravações simultâneas no prontuário mantêm a cadeia linear e íntegra", async () => {
  await psicologa.get("/prontuario/paciente/3/nova");
  const respostas = await Promise.all(
    [1, 2, 3, 4].map((i) => psicologa.post("/prontuario/paciente/3/nova", { psicologo_id: "1", sessao_id: "", conteudo: `entrada simultânea ${i}` })),
  );
  for (const r of respostas) assert.equal(r.status, 303, "nenhuma gravação deve falhar com erro");
  const seqs = (await todos<{ seq: number }>("SELECT seq FROM prontuario_entrada WHERE paciente_id = 3 ORDER BY seq")).map((x) => x.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4], "sequência sem buracos nem repetições");
  assert.match((await psicologa.get("/prontuario/paciente/3/verificar")).texto, /Cadeia íntegra: 4 entrada/);
});

test("concorrência: 'realizada' e 'falta' ao mesmo tempo nunca deixam lançamento sem sessão realizada", async () => {
  await admin.get("/agenda");
  const combinacoes = [["realizada", "falta"], ["falta", "realizada"], ["realizada", "realizada"], ["cancelada", "realizada"], ["realizada", "cancelada"]];
  for (const ordem of combinacoes) {
    await shim.exec(`INSERT INTO sessao (paciente_id, psicologo_id, data_hora, duracao_min, valor_centavos, status, criado_em)
               VALUES (3, 1, '2027-01-01T10:00', 50, 15000, 'agendada', '2026-01-01T00:00:00')`);
    const id = (await um<{ id: number }>("SELECT MAX(id) id FROM sessao")).id;
    const rs = await Promise.all(ordem.map((st) => admin.post(`/agenda/${id}/status`, { status: st })));
    for (const r of rs) assert.equal(r.status, 303);
    const final = (await um<{ status: string }>("SELECT status FROM sessao WHERE id = ?", id)).status;
    const n = (await um<{ n: number }>("SELECT COUNT(*) n FROM lancamento_financeiro WHERE sessao_id = ?", id)).n;
    assert.equal(n, final === "realizada" ? 1 : 0, `${ordem.join("+")} -> ${final}: ${n} lançamento(s)`);
  }
});

test("concorrência: pagamento em duplicidade (duplo clique) é aplicado uma única vez", async () => {
  const pend = (await um<{ id: number }>("SELECT id FROM lancamento_financeiro WHERE status = 'pendente' ORDER BY id LIMIT 1"));
  await recepcao.get("/financeiro");
  const rs = await Promise.all(["pix", "cartao", "dinheiro"].map((f) => recepcao.post(`/financeiro/${pend.id}/pagar`, { forma_pagamento: f })));
  for (const r of rs) assert.equal(r.status, 303);
  const l = (await um<{ status: string; forma_pagamento: string; data_pagamento: string }>("SELECT * FROM lancamento_financeiro WHERE id = ?", pend.id));
  assert.equal(l.status, "pago");
  assert.ok(["pix", "cartao", "dinheiro"].includes(l.forma_pagamento));
  assert.ok(l.data_pagamento);
});

test("concorrência: duplo clique em 'Emitir NFS-e' chama o provedor UMA vez e gera UMA nota", async () => {
  const l = (await um<{ id: number }>(
    `SELECT l.id FROM lancamento_financeiro l WHERE l.status = 'pago'
        AND NOT EXISTS (SELECT 1 FROM nota_fiscal n WHERE n.lancamento_id = l.id) ORDER BY l.id LIMIT 1`));
  assert.ok(l, "precisa existir um lançamento pago sem nota");
  const emissoes = async () => (await um<{ n: number }>("SELECT COUNT(*) n FROM log_auditoria WHERE acao = 'emitir' AND entidade = 'NotaFiscal'")).n;
  const antes = await emissoes();
  await recepcao.get("/nfse");
  const rs = await Promise.all([1, 2, 3].map(() => recepcao.post(`/nfse/emitir/${l.id}`)));
  for (const r of rs) assert.equal(r.status, 303);
  const notas = (await todos<{ status: string; numero_nota: string }>("SELECT status, numero_nota FROM nota_fiscal WHERE lancamento_id = ?", l.id));
  assert.equal(notas.length, 1);
  assert.equal(notas[0]!.status, "emitida");
  assert.equal((await emissoes()) - antes, 1, "o provedor só pode ser acionado por uma das requisições");

  // reserva abandonada (requisição que morreu no meio) é retomada...
  await shim.exec(`UPDATE nota_fiscal SET status = 'pendente', numero_nota = NULL, criado_em = '2000-01-01T00:00:00' WHERE lancamento_id = ${l.id}`);
  await recepcao.post(`/nfse/emitir/${l.id}`);
  assert.equal((await um<{ status: string }>("SELECT status FROM nota_fiscal WHERE lancamento_id = ?", l.id)).status, "emitida");
  // ...mas uma reserva recente (emissão em andamento) bloqueia nova tentativa
  const agora = new Date().toISOString().slice(0, 19);
  await shim.exec(`UPDATE nota_fiscal SET status = 'pendente', numero_nota = NULL, criado_em = '${agora}' WHERE lancamento_id = ${l.id}`);
  await recepcao.post(`/nfse/emitir/${l.id}`);
  assert.equal((await um<{ status: string }>("SELECT status FROM nota_fiscal WHERE lancamento_id = ?", l.id)).status, "pendente", "emissão em andamento não é atropelada");
});

// ---------------------------------------------------------------------- auditoria
test("auditoria: registra acessos sensíveis (quem/o quê/paciente) e só o admin vê", async () => {
  const vistas = (await todos<{ acao: string; entidade: string }>("SELECT DISTINCT acao, entidade FROM log_auditoria"));
  const tem = (a: string, e: string) => vistas.some((v) => v.acao === a && v.entidade === e);
  for (const [a, e] of [["login", "Usuario"], ["login_falho", "Usuario"], ["login_bloqueado", "Usuario"], ["visualizar", "ProntuarioEntrada"],
    ["criar", "ProntuarioEntrada"], ["visualizar", "ObservacaoAdministrativa"], ["criar", "ObservacaoAdministrativa"],
    ["criar", "DocumentoClinico"], ["emitir", "NotaFiscal"], ["criar", "AplicacaoQuestionario"], ["criar", "Paciente"]] as const) {
    assert.ok(tem(a, e), `faltou log ${a}/${e}`);
  }
  const p = (await um<{ usuario_nome: string; paciente_id: number; ip_origem: string }>(
    "SELECT usuario_nome, paciente_id, ip_origem FROM log_auditoria WHERE entidade='ProntuarioEntrada' AND acao='criar' LIMIT 1"));
  assert.equal(p.usuario_nome, "Dra. Carla Menezes");
  assert.equal(p.paciente_id, 2);
  const pag = await admin.get("/auditoria?paciente_id=2");
  assert.equal(pag.status, 200);
  assert.ok(pag.texto.includes("Dra. Carla Menezes") && pag.texto.includes("ProntuarioEntrada"));
  assert.equal((await psicologa.get("/auditoria")).status, 403);
  // imutável no banco
  await assert.rejects(() => shim.exec("DELETE FROM log_auditoria"), /append-only/);
  await assert.rejects(() => shim.exec("UPDATE log_auditoria SET usuario_nome = 'x'"), /append-only/);
  await assert.rejects(() => shim.exec("DELETE FROM documento_clinico"), /imutável/);
});

// -------------------------------------------------------------------------- logout
test("logout: encerra a sessão no servidor (cookie roubado deixa de valer)", async () => {
  const c = new Cliente();
  await c.entrar("recepcao");
  const token = c.cookies.get("sipsi_sessao")!;
  assert.equal((await c.get("/pacientes")).status, 200);
  assert.equal((await c.post("/auth/logout")).status, 303);
  assert.equal(c.cookies.has("sipsi_sessao"), false);
  const ladrao = new Cliente();
  ladrao.cookies.set("sipsi_sessao", token);
  assert.equal((await ladrao.get("/pacientes")).status, 303, "token antigo não funciona mais");
  assert.equal((await c.get("/pacientes")).status, 303);
});

test("modo demo: credenciais só aparecem na tela de login quando MODO_DEMO=1", async () => {
  assert.ok(!(await new Cliente().get("/auth/login")).texto.includes("admin / recepcao / carla"));
  const res = await worker.fetch(new Request(ORIGEM + "/auth/login"), { ...env, MODO_DEMO: "1" });
  assert.ok((await res.text()).includes("admin / recepcao / carla"));
});

test("orçamento de consultas: nenhuma requisição chega perto do limite de 50 consultas por invocação (herdado do projeto original)", () => {
  console.log(`# máximo de consultas em uma requisição: ${maxConsultas} (${rotaMaxConsultas})`);
  assert.ok(maxConsultas <= 15, `${rotaMaxConsultas} usou ${maxConsultas} consultas`);
});
