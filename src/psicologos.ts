import type { Ctx } from "./ctx.ts";

/** Psicólogos em nome de quem o usuário pode assinar: psicólogo só assina em seu próprio nome. */
export async function psicologosPermitidos(c: Ctx): Promise<{ id: number; nome: string }[]> {
  const vinculo = c.user?.papel === "psicologo" ? c.user.psicologo_id : null;
  const sql = vinculo
    ? "SELECT id, nome FROM psicologo WHERE ativo = 1 AND id = ? ORDER BY nome"
    : "SELECT id, nome FROM psicologo WHERE ativo = 1 ORDER BY nome";
  const stmt = c.db.prepare(sql);
  return (await (vinculo ? stmt.bind(vinculo) : stmt).all<{ id: number; nome: string }>()).results;
}
