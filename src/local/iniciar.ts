/**
 * Inicia o Sipsi no próprio computador.
 *
 *   npm run local
 *
 * Sem configurar nada: banco PostgreSQL embutido na pasta ./dados-sipsi, segredo das senhas em
 * ./segredo-sipsi.txt (gerado na primeira vez) e acesso só por este computador em http://localhost:8787.
 *
 * Variáveis opcionais:
 *   SIPSI_DADOS=pasta       onde ficam os dados (padrão: ./dados-sipsi)
 *   DATABASE_URL=...        usa um banco Neon em vez da pasta local
 *   PASSWORD_PEPPER=...     segredo das senhas (padrão: arquivo ./segredo-sipsi.txt)
 *   SIPSI_PEPPER_ARQUIVO=   caminho do arquivo do segredo
 *   PORT=8787  SIPSI_HOST=127.0.0.1   (0.0.0.0 libera a rede local; exige HTTPS, veja o manual)
 *   SIPSI_PROXY=1           atrás de proxy HTTPS (Caddy): confia em X-Forwarded-*
 *   SIPSI_ABRIR_NAVEGADOR=1 abre o navegador ao iniciar (usado pelos atalhos do instalador)
 *   MODO_DEMO=1             mostra credenciais de demonstração (só desenvolvimento)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { abrirLocal } from "./servidor.ts";
import { migrarPool } from "./migrar.ts";
import { hashSenha } from "../crypto.ts";
import { agoraUtc, emailValido } from "../util.ts";

const env = process.env;
const dados = env.SIPSI_DADOS ?? "./dados-sipsi";
const arquivoPepper = env.SIPSI_PEPPER_ARQUIVO ?? "./segredo-sipsi.txt";
const porta = Number(env.PORT ?? 8787);
const host = env.SIPSI_HOST ?? "127.0.0.1";

function obterPepper(): string {
  if (env.PASSWORD_PEPPER) return env.PASSWORD_PEPPER;
  if (existsSync(arquivoPepper)) return readFileSync(arquivoPepper, "utf8").trim();
  if (!env.DATABASE_URL && existsSync(dados) && existsSync(`${dados}/PG_VERSION`)) {
    console.error(`ERRO: existem dados em ${dados}, mas o segredo (${arquivoPepper}) não foi encontrado.\nSem ele, ninguém consegue entrar. Restaure o arquivo do backup.`);
    process.exit(1);
  }
  const novo = randomBytes(48).toString("base64url");
  mkdirSync(dirname(arquivoPepper), { recursive: true });
  writeFileSync(arquivoPepper, novo + "\n", { mode: 0o600 });
  console.log(`Segredo das senhas criado em ${arquivoPepper}. GUARDE UMA CÓPIA (separada da pasta de dados).`);
  return novo;
}

async function perguntar(texto: string, oculto = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (oculto) {
    const r = rl as unknown as { _writeToOutput: (s: string) => void };
    r._writeToOutput = (s: string) => {
      if (s.includes(texto)) process.stdout.write(texto);
    };
  }
  return new Promise((ok) =>
    rl.question(texto, (resp) => {
      rl.close();
      if (oculto) process.stdout.write("\n");
      ok(resp.trim());
    }),
  );
}

async function criarPrimeiroAdmin(consulta: (sql: string, p: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>, pepper: string): Promise<void> {
  const n = Number((await consulta("SELECT COUNT(*) AS n FROM usuario", [])).rows[0]?.n ?? 0);
  if (n > 0) return;
  console.log("\nPrimeira execução: vamos criar o administrador.");
  let nome = env.USUARIO_NOME ?? "";
  let email = (env.USUARIO_EMAIL ?? "").toLowerCase();
  let senha = env.USUARIO_SENHA ?? "";
  if (!process.stdin.isTTY && !(nome && email && senha)) {
    console.log("Sem terminal interativo: defina USUARIO_NOME, USUARIO_EMAIL e USUARIO_SENHA, ou rode no terminal.");
    process.exit(1);
  }
  while (!nome) nome = await perguntar("Nome do administrador: ");
  while (!emailValido(email)) email = (await perguntar("E-mail (será o login): ")).toLowerCase();
  while (senha.length < 10) {
    senha = await perguntar("Senha (mínimo 10 caracteres, não aparece na tela): ", true);
    if (senha.length < 10) console.log("Senha curta demais.");
  }
  await consulta(
    "INSERT INTO usuario (nome, email, senha_hash, papel, ativo, criado_em) VALUES ($1, $2, $3, 'admin', 1, $4)",
    [nome, email, await hashSenha(senha, pepper), agoraUtc()],
  );
  console.log(`Administrador criado: ${email}\n`);
}

const pepper = obterPepper();
let consulta: (sql: string, p: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
let fecharExtra = async (): Promise<void> => {};

if (env.DATABASE_URL) {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  if (!(await migrarPool(pool, () => {}))) process.exit(1);
  consulta = (sql, p) => pool.query(sql, p as never) as never;
  fecharExtra = () => pool.end();
}

if (!existsSync(dados) && !env.DATABASE_URL) mkdirSync(dados, { recursive: true });
const app = await abrirLocal({
  dados: env.DATABASE_URL ? undefined : dados,
  databaseUrl: env.DATABASE_URL,
  pepper,
  modoDemo: env.MODO_DEMO === "1",
  confiarProxy: env.SIPSI_PROXY === "1",
});
if (!env.DATABASE_URL) consulta = (sql, p) => app.banco!.backend.query(sql, p as never);

await criarPrimeiroAdmin(consulta!, pepper);

app.servidor.listen(porta, host, () => {
  const onde = host === "127.0.0.1" ? "localhost" : host;
  console.log(`Sipsi no ar: http://${onde}:${porta}`);
  console.log(env.DATABASE_URL ? "Banco: Neon (DATABASE_URL)" : `Dados em: ${dados}  (faça backup desta pasta)`);
  if (host !== "127.0.0.1" && env.SIPSI_PROXY !== "1") {
    console.log("ATENÇÃO: acesso pela rede sem HTTPS expõe senhas e sessões. Use um proxy HTTPS (SIPSI_PROXY=1).");
  }
  console.log("Para encerrar: feche esta janela ou pressione Ctrl+C");
  if (env.SIPSI_ABRIR_NAVEGADOR === "1") {
    const url = `http://localhost:${porta}`;
    const [cmd, args] =
      process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try {
      spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    } catch {
      /* sem navegador padrão: o endereço já foi exibido acima */
    }
  }
});

for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinal, async () => {
    console.log("\nEncerrando...");
    await app.fechar();
    await fecharExtra();
    process.exit(0);
  });
}
