// Trilha de auditoria (LGPD): quem fez o quê, em qual paciente, quando e de onde.
import type { Ctx } from "./ctx.ts";
import type { Usuario } from "./auth.ts";

export async function registrarLog(
  c: Ctx,
  acao: string,
  entidade: string,
  entidadeId: number | null = null,
  pacienteId: number | null = null,
  detalhes: string | null = null,
  usuario: Usuario | null = c.user,
): Promise<void> {
  await c.db
    .prepare(
      `INSERT INTO log_auditoria
         (usuario_id, usuario_nome, acao, entidade, entidade_id, paciente_id, detalhes, ip_origem, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      usuario?.id ?? null,
      usuario?.nome ?? "anônimo",
      acao,
      entidade,
      entidadeId,
      pacienteId,
      detalhes ? detalhes.slice(0, 255) : null,
      c.ip,
      c.agora,
    )
    .run();
}
