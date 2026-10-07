// Backend PostgreSQL embutido (PGlite): Postgres de verdade, em processo, sem instalar nada.
// Com um diretório, os dados ficam em disco; sem, ficam em memória (testes).
import { PGlite } from "@electric-sql/pglite";
import type { Valor } from "../env.ts";
import type { Backend, Executor, RespostaSql } from "../pg.ts";

const PARSERS = { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) };

type Consultavel = { query: PGlite["query"] };

function executor(q: Consultavel): Executor {
  return {
    async query(sql: string, params: Valor[]): Promise<RespostaSql> {
      const r = await q.query(sql, params, { parsers: PARSERS });
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? 0 };
    },
  };
}

export function criarBackendPglite(pg: PGlite): Backend {
  return {
    ...executor(pg),
    transaction: (fn) => pg.transaction((tx) => fn(executor(tx as unknown as Consultavel))),
    close: () => pg.close(),
  };
}
