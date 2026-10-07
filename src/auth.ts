// Sessões, proteção CSRF e limitação de tentativas de login.
import type { Banco } from "./env.ts";
import { aleatorioB64url, hmacSha256, paraHex, sha256Hex, utf8 } from "./crypto.ts";

export type Papel = "admin" | "psicologo" | "recepcao";
export const TODOS_OS_PAPEIS: Papel[] = ["admin", "psicologo", "recepcao"];

export interface Usuario {
  id: number;
  nome: string;
  login: string;
  email: string | null;
  papel: Papel;
  psicologo_id: number | null;
}

export const COOKIE_SESSAO = "sipsi_sessao";
export const SESSAO_HORAS = 12;

// Limites de tentativas malsucedidas por janela de 15 minutos.
export const JANELA_MIN = 15;
export const MAX_FALHAS_POR_LOGIN = 5;
export const MAX_FALHAS_POR_IP = 30;

function somarHoras(isoUtc: string, horas: number): string {
  return new Date(new Date(isoUtc + "Z").getTime() + horas * 3_600_000).toISOString().slice(0, 19);
}

function subtrairMinutos(isoUtc: string, min: number): string {
  return new Date(new Date(isoUtc + "Z").getTime() - min * 60_000).toISOString().slice(0, 19);
}

export async function criarSessao(db: Banco, usuarioId: number, agora: string): Promise<{ token: string; expiraEm: string }> {
  const token = aleatorioB64url(32);
  const expiraEm = somarHoras(agora, SESSAO_HORAS);
  await db.batch([
    // limpeza oportunista de sessões vencidas
    db.prepare("DELETE FROM sessao_login WHERE expira_em < ?").bind(agora),
    db
      .prepare("INSERT INTO sessao_login (id_hash, usuario_id, expira_em, criado_em) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), usuarioId, expiraEm, agora),
  ]);
  return { token, expiraEm };
}

export async function usuarioDaSessao(db: Banco, token: string, agora: string): Promise<Usuario | null> {
  if (!token || token.length > 100) return null;
  const linha = await db
    .prepare(
      `SELECT u.id, u.nome, u.login, u.email, u.papel, u.psicologo_id
         FROM sessao_login s JOIN usuario u ON u.id = s.usuario_id
        WHERE s.id_hash = ? AND s.expira_em > ? AND u.ativo = 1`,
    )
    .bind(await sha256Hex(token), agora)
    .first<Usuario>();
  return linha ?? null;
}

export async function encerrarSessao(db: Banco, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessao_login WHERE id_hash = ?").bind(await sha256Hex(token)).run();
}

/** Token CSRF derivado do token de sessão (só quem tem o cookie consegue calculá-lo). */
export async function tokenCsrf(tokenSessao: string): Promise<string> {
  return paraHex(await hmacSha256(utf8(tokenSessao), utf8("sipsi-csrf-v1")));
}

export async function tentativasBloqueadas(db: Banco, login: string, ip: string, agora: string): Promise<boolean> {
  const desde = subtrairMinutos(agora, JANELA_MIN);
  const r = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM login_tentativa WHERE email = ? AND criado_em >= ?) AS por_login,
         (SELECT COUNT(*) FROM login_tentativa WHERE ip = ? AND criado_em >= ?) AS por_ip`,
    )
    .bind(login, desde, ip, desde)
    .first<{ por_email: number; por_ip: number }>();
  return (r?.por_login ?? 0) >= MAX_FALHAS_POR_LOGIN || (r?.por_ip ?? 0) >= MAX_FALHAS_POR_IP;
}

export async function registrarFalhaDeLogin(db: Banco, login: string, ip: string, agora: string): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO login_tentativa (email, ip, criado_em) VALUES (?, ?, ?)").bind(login, ip, agora),
    db.prepare("DELETE FROM login_tentativa WHERE criado_em < ?").bind(subtrairMinutos(agora, 24 * 60)),
  ]);
}
