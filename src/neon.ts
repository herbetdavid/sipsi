// Backend Neon (PostgreSQL serverless) para o Worker. Usa WebSocket (Pool) para permitir
// transações; um Pool por requisição, encerrado ao final (ctx.waitUntil).
import { Pool, types } from "@neondatabase/serverless";
import type { Valor } from "./env.ts";
import type { Backend, Executor, RespostaSql } from "./pg.ts";

// int8 (COUNT/SUM) e numeric chegam como texto no driver: converte para número.
types.setTypeParser(20, (v: string) => Number(v));
types.setTypeParser(1700, (v: string) => Number(v));

export function criarBackendNeon(urlConexao: string): Backend {
  const pool = new Pool({ connectionString: urlConexao, max: 1 });
  const exec = (q: { query(t: string, v: Valor[]): Promise<{ rows: unknown[]; rowCount: number | null }> }): Executor => ({
    async query(sql, params): Promise<RespostaSql> {
      const r = await q.query(sql, params);
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount };
    },
  });
  return {
    ...exec(pool),
    async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await fn(exec(client));
        await client.query("COMMIT");
        return r;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* conexão já perdida */
        }
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
