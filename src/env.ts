// Tipos mínimos do banco (PostgreSQL) e do ambiente do Worker (o que o app realmente usa).
// A implementação real fica em pg.ts (adaptador) + hyperdrive.ts (Hyperdrive/pg) ou neon.ts (driver
// serverless do Neon) e
// test/pg-shim.ts (PGlite, testes: Postgres de verdade, em processo).

export interface ResultadoBanco<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface ExecucaoBanco {
  success: boolean;
  /** Linhas afetadas (INSERT/UPDATE/DELETE). */
  meta: { changes: number } & Record<string, unknown>;
}

export type Valor = string | number | null;

export interface ComandoBanco {
  /** Parâmetros posicionais: use "?" no SQL (convertido para $1, $2, ... pelo adaptador). */
  bind(...valores: Valor[]): ComandoBanco;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<ResultadoBanco<T>>;
  run(): Promise<ExecucaoBanco>;
}

export interface Banco {
  prepare(sql: string): ComandoBanco;
  /** Executa os comandos em uma única transação atômica. */
  batch(comandos: ComandoBanco[]): Promise<unknown[]>;
}

export interface Env {
  /** Binding do Cloudflare Hyperdrive apontando para o Neon (preferido quando existe). */
  HYPERDRIVE?: { connectionString: string };
  /** String de conexão do Neon (secret). Ex.: postgresql://usuario:senha@ep-xxx.sa-east-1.aws.neon.tech/sipsi?sslmode=require */
  DATABASE_URL?: string;
  /** Só para testes: banco já pronto (sobrepõe DATABASE_URL). */
  DB?: Banco;
  /** Segredo misturado à senha (HMAC) antes do PBKDF2. Obrigatório. */
  PASSWORD_PEPPER?: string;
  /** "1" exibe credenciais de demonstração na tela de login. */
  MODO_DEMO?: string;
}
