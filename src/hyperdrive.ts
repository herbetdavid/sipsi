// Backend PostgreSQL via node-postgres (pg). No Worker, a conexão vem do Hyperdrive
// (env.HYPERDRIVE.connectionString), que mantém um pool perto do Neon e evita o custo de abrir
// uma conexão nova a cada requisição. Exige a flag nodejs_compat. Um Client por requisição.
import pg from "pg";
import type { Valor } from "./env.ts";
import type { Backend, Executor, RespostaSql } from "./pg.ts";

// int8 (COUNT/SUM) e numeric chegam como texto: converte para número.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

type Consultavel = { query(texto: string, valores: Valor[]): Promise<{ rows: unknown[]; rowCount: number | null }> };

function executor(q: Consultavel): Executor {
  return {
    async query(sql, params): Promise<RespostaSql> {
      const r = await q.query(sql, params);
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount };
    },
  };
}

/** Conexão preguiçosa: só conecta na primeira consulta (rotas sem banco não pagam o custo). */
export function criarBackendPg(urlConexao: string): Backend {
  const client = new pg.Client({ connectionString: urlConexao });
  let conectado: Promise<void> | null = null;
  const garantir = (): Promise<void> => (conectado ??= client.connect().then(() => undefined));
  return {
    async query(sql, params) {
      await garantir();
      return executor(client).query(sql, params);
    },
    async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
      await garantir();
      await client.query("BEGIN");
      try {
        const r = await fn(executor(client));
        await client.query("COMMIT");
        return r;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* conexão já perdida */
        }
        throw e;
      }
    },
    async close() {
      if (conectado) await client.end();
    },
  };
}
