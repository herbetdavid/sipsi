/**
 * Cria um usuário diretamente no banco, sem gravar a senha em arquivo.
 *
 *   DATABASE_URL='postgresql://...' PASSWORD_PEPPER=<o mesmo do Worker> USUARIO_LOGIN=admin \
 *   USUARIO_NOME="Seu Nome" USUARIO_EMAIL=voce@clinica.com USUARIO_SENHA='uma-senha-longa' USUARIO_PAPEL=admin npm run usuario:criar
 *
 * USUARIO_EMAIL é opcional. USUARIO_LOGIN deve ter 3–50 caracteres: letras, números, ponto, hífen ou sublinhado.
 * USUARIO_PAPEL: admin | psicologo | recepcao (padrão: admin).
 * Para o papel "psicologo", informe também USUARIO_PSICOLOGO_ID (id da tabela psicologo).
 */
import { hashSenha } from "../src/crypto.ts";
import { agoraUtc } from "../src/util.ts";
import { abrirPool } from "./conexao.ts";

const env = process.env;
const pepper = env.PASSWORD_PEPPER;
const login = (env.USUARIO_LOGIN ?? "").trim().toLowerCase();
const email = (env.USUARIO_EMAIL ?? "").trim().toLowerCase();
const nome = (env.USUARIO_NOME ?? "").trim();
const senha = env.USUARIO_SENHA ?? "";
const papel = env.USUARIO_PAPEL ?? "admin";
const psicologoId = env.USUARIO_PSICOLOGO_ID ? Number(env.USUARIO_PSICOLOGO_ID) : null;

const erros: string[] = [];
if (!pepper) erros.push("PASSWORD_PEPPER não definido.");
if (!/^[A-Za-z0-9._-]{3,50}$/.test(login)) erros.push("USUARIO_LOGIN inválido (3–50 caracteres: letras, números, ponto, hífen ou sublinhado).");
if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) erros.push("USUARIO_EMAIL inválido.");
if (!nome) erros.push("USUARIO_NOME obrigatório.");
if (senha.length < 10) erros.push("USUARIO_SENHA deve ter pelo menos 10 caracteres.");
if (!["admin", "psicologo", "recepcao"].includes(papel)) erros.push("USUARIO_PAPEL inválido.");
if (papel === "psicologo" && !psicologoId) erros.push("Para o papel psicologo, informe USUARIO_PSICOLOGO_ID.");
if (erros.length) {
  console.error("Erros:\n- " + erros.join("\n- "));
  process.exit(1);
}

const hash = await hashSenha(senha, pepper as string);
const pool = abrirPool();
try {
  await pool.query(
    "INSERT INTO usuario (nome, login, email, senha_hash, papel, ativo, psicologo_id, criado_em) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)",
    [nome, login, email || null, hash, papel, psicologoId, agoraUtc()],
  );
  console.log(`Usuário criado (${papel}: ${login}).`);
} catch (e) {
  console.error("Falhou:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
