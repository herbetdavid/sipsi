// Medida APROXIMADA de CPU por requisição (rode: node test/bench-cpu.ts).
// Mede em Node/V8 neste computador; no Worker real o número varia. A medida oficial é o
// painel da Cloudflare (Workers & Pages > sipsi > Metrics > "CPU time"). Aqui o banco é um PostgreSQL
// em processo (PGlite), então o tempo de espera de rede do Neon (que NÃO conta como CPU) não aparece.
import { readFileSync, readdirSync } from "node:fs";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { PgShim } from "./pg-shim.ts";
import { gerarSeedSql } from "../scripts/gerar-seed-demo.ts";

const ORIGEM = "https://sipsi.test";
const shim = await PgShim.criar();
const env: Env = { DB: shim, PASSWORD_PEPPER: "pepper-bench" };
const pasta = new URL("../migrations/", import.meta.url);
for (const f of readdirSync(pasta).filter((x) => x.endsWith(".sql")).sort()) await shim.exec(readFileSync(new URL(f, pasta), "utf8"));
await shim.exec(await gerarSeedSql("pepper-bench"));

const cpuMs = (a: NodeJS.CpuUsage) => (a.user + a.system) / 1000;
let cookie = "";
let csrf = "";

async function chamar(metodo: string, caminho: string, form?: Record<string, string>): Promise<Response> {
  const h = new Headers();
  if (cookie) h.set("Cookie", cookie);
  let body: string | undefined;
  if (metodo === "POST") {
    h.set("Origin", ORIGEM);
    h.set("Content-Type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(form).toString();
  }
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body }), env);
  const sc = res.headers.getSetCookie().find((c) => c.startsWith("sipsi_sessao="));
  if (sc && !/Max-Age=0/.test(sc)) cookie = sc.split(";")[0]!;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const m = /name="_csrf" value="([0-9a-f]+)"/.exec(new TextDecoder().decode(bytes.slice(0, 4000)));
  if (m) csrf = m[1]!;
  return res;
}

async function medir(rotulo: string, fn: () => Promise<unknown>, n = 25): Promise<void> {
  for (let i = 0; i < 3; i++) await fn(); // aquece o JIT
  const amostras: number[] = [];
  for (let i = 0; i < n; i++) {
    const antes = process.cpuUsage();
    await fn();
    amostras.push(cpuMs(process.cpuUsage(antes)));
  }
  amostras.sort((a, b) => a - b);
  const med = amostras[Math.floor(n / 2)]!;
  console.log(`${rotulo.padEnd(46)} mediana ${med.toFixed(2).padStart(7)} ms   p95 ${amostras[Math.floor(n * 0.95)]!.toFixed(2).padStart(7)} ms`);
}

// frio: primeira requisição depois de carregar o módulo
const frio = process.cpuUsage();
await chamar("GET", "/auth/login");
console.log(`primeira requisição (inclui JIT/inicialização)   ${cpuMs(process.cpuUsage(frio)).toFixed(2)} ms\n`);

await medir("GET  /auth/login (página de login)", () => chamar("GET", "/auth/login"));
await medir("POST /auth/login (PBKDF2 100k + pepper)", async () => {
  cookie = "";
  await chamar("POST", "/auth/login", { login: "admin", senha: "123456" });
}, 10);
await chamar("POST", "/auth/login", { login: "admin", senha: "123456" });
await chamar("GET", "/");
await medir("GET  /pacientes (lista, com sessão)", () => chamar("GET", "/pacientes"));
await medir("GET  /agenda (JOIN de 3 tabelas)", () => chamar("GET", "/agenda"));
await medir("GET  /prontuario/paciente/1", () => chamar("GET", "/prontuario/paciente/1"));
await medir("GET  /relatorios/faturamento (agregação)", () => chamar("GET", "/relatorios/faturamento"));
await medir("POST /pacientes/novo (escrita + auditoria)", () => chamar("POST", "/pacientes/novo", { _csrf: csrf, nome: "Paciente Bench" }));
const doc = await chamar("POST", "/documentos/paciente/1/declaracao", { _csrf: csrf, psicologo_id: "1", data_atendimento: "2026-09-30", horario_inicio: "10:00", horario_fim: "10:50" });
const url = doc.headers.get("Location")!;
await medir("GET  /documentos/baixar/:id (gera PDF)", () => chamar("GET", url));
