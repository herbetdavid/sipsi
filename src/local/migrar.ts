// Aplicação das migrações (migrations/*.sql), em ordem, uma transação por arquivo.
import { readdirSync, readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { Pool } from "@neondatabase/serverless";

const PASTA = new URL("../../migrations/", import.meta.url);
const CRIAR = "CREATE TABLE IF NOT EXISTS _migracoes (nome TEXT PRIMARY KEY, aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now())";
const arquivos = (): string[] => readdirSync(PASTA).filter((f) => f.endsWith(".sql")).sort();
const ler = (arq: string): string => readFileSync(new URL(arq, PASTA), "utf8");

export async function migrarPglite(pg: PGlite): Promise<string[]> {
  await pg.exec(CRIAR);
  const feitas = new Set((await pg.query<{ nome: string }>("SELECT nome FROM _migracoes")).rows.map((r) => r.nome));
  const novas: string[] = [];
  for (const arq of arquivos()) {
    if (feitas.has(arq)) continue;
    await pg.transaction(async (tx) => {
      await tx.exec(ler(arq));
      await tx.query("INSERT INTO _migracoes (nome) VALUES ($1)", [arq]);
    });
    novas.push(arq);
  }
  return novas;
}

export async function migrarPool(pool: Pool, log: (m: string) => void = console.log): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query(CRIAR);
    const feitas = new Set((await client.query("SELECT nome FROM _migracoes")).rows.map((r: { nome: string }) => r.nome));
    for (const arq of arquivos()) {
      if (feitas.has(arq)) {
        log(`já aplicada: ${arq}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(ler(arq));
        await client.query("INSERT INTO _migracoes (nome) VALUES ($1)", [arq]);
        await client.query("COMMIT");
        log(`aplicada: ${arq}`);
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`FALHOU em ${arq}:`, e instanceof Error ? e.message : e);
        return false;
      }
    }
    return true;
  } finally {
    client.release();
  }
}
