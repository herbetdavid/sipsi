// Conexão Neon para scripts de linha de comando (Node). Usa WebSocket via "ws".
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

export function abrirPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Defina DATABASE_URL (string de conexão do Neon, região aws-sa-east-1).");
    process.exit(1);
  }
  return new Pool({ connectionString: url, max: 1 });
}
