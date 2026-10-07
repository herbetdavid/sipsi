/**
 * Cria um usuário (ex.: o primeiro administrador) direto no banco, sem gravar a senha em arquivo.
 *
 *   DATABASE_URL='postgresql://...' PASSWORD_PEPPER=<o mesmo do Worker> USUARIO_EMAIL=voce@clinica.com \
 *   USUARIO_NOME="Seu Nome" USUARIO_SENHA='uma-senha-longa' USUARIO_PAPEL=admin npm run usuario:criar
 *
 * USUARIO_PAPEL: admin | psicologo | recepcao (padrão: admin).
 * Para o papel "psicologo", informe também USUARIO_PSICOLOGO_ID (id da tabela psicologo).
 */
import { hashSenha } from "../src/crypto.ts";
import { agoraUtc, emailValido } from "../src/util.ts";
import { abrirPool } from "./conexao.ts";

const env = process.env;
const pepper = env.PASSWORD_PEPPER;
const email = (env.USUARIO_EMAIL ?? "").trim().toLowerCase();
const nome = (env.USUARIO_NOME ?? "").trim();
const senha = env.USUARIO_SENHA ?? "";
const papel = env.USUARIO_PAPEL ?? "admin";
const psicologoId = env.USUARIO_PSICOLOGO_ID ? Number(env.USUARIO_PSICOLOGO_ID) : null;

const erros: string[] = [];
if (!pepper) erros.push("PASSWORD_PEPPER não definido.");
if (!emailValido(email)) erros.push("USUARIO_EMAIL inválido.");
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
    "INSERT INTO usuario (nome, email, senha_hash, papel, ativo, psicologo_id, criado_em) VALUES ($1, $2, $3, $4, 1, $5, $6)",
    [nome, email, hash, papel, psicologoId, agoraUtc()],
  );
  console.log(`Usuário criado (${papel}: ${email}).`);
} catch (e) {
  console.error("Falhou:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
