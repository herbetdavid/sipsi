/**
 * Aplica as migrações no Neon (DATABASE_URL), em ordem, registrando as já aplicadas (tabela _migracoes).
 *   DATABASE_URL='postgresql://...' npm run db:migrar
 * (No modo local, as migrações rodam sozinhas ao iniciar: npm run local.)
 */
import { abrirPool } from "./conexao.ts";
import { migrarPool } from "../src/local/migrar.ts";

const pool = abrirPool();
try {
  if (!(await migrarPool(pool))) process.exitCode = 1;
} finally {
  await pool.end();
}
