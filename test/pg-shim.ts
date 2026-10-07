// Banco de teste: PostgreSQL de verdade, em processo (PGlite/WASM), com o MESMO SQL e as
// MESMAS migrações usados no Neon. Troca o driver, não o dialeto.
import { PGlite } from "@electric-sql/pglite";
import type { Valor } from "../src/env.ts";
import { BancoPg, converterPlaceholders } from "../src/pg.ts";
import { criarBackendPglite } from "../src/local/pglite.ts";

const PARSERS = { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) };

export class PgShim extends BancoPg {
  pg: PGlite;
  constructor(pg: PGlite) {
    super(criarBackendPglite(pg));
    this.pg = pg;
  }
  static async criar(): Promise<PgShim> {
    return new PgShim(await PGlite.create());
  }
  /** Executa SQL puro (vários comandos), p.ex. migrações e seed. */
  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }
  async um<T>(sql: string, ...p: Valor[]): Promise<T> {
    return (await this.pg.query(converterPlaceholders(sql), p, { parsers: PARSERS })).rows[0] as T;
  }
  async todos<T>(sql: string, ...p: Valor[]): Promise<T[]> {
    return (await this.pg.query(converterPlaceholders(sql), p, { parsers: PARSERS })).rows as T[];
  }
}
