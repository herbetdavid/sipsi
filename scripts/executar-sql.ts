/**
 * Executa um arquivo SQL (vários comandos) no banco de DATABASE_URL, em uma transação.
 * Uso típico: o seed de DEMONSTRAÇÃO, nunca em banco com dados reais.
 *
 *   DATABASE_URL='postgresql://...' npx tsx scripts/executar-sql.ts seed-demo.sql
 */
import { readFileSync } from "node:fs";
import { abrirPool } from "./conexao.ts";

const arquivo = process.argv[2];
if (!arquivo) {
  console.error("Uso: npx tsx scripts/executar-sql.ts <arquivo.sql>");
  process.exit(1);
}
const pool = abrirPool();
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(readFileSync(arquivo, "utf8"));
  await client.query("COMMIT");
  console.log(`executado: ${arquivo}`);
} catch (e) {
  await client.query("ROLLBACK");
  console.error("FALHOU:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
