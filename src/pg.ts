// Adaptador PostgreSQL com a mesma interface mínima usada pelo app (prepare/bind/first/all/run/batch).
// É independente do driver: quem fornece a conexão implementa `Backend`.
import type { Banco, ComandoBanco, ExecucaoBanco, ResultadoBanco, Valor } from "./env.ts";

export interface RespostaSql {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface Executor {
  query(sql: string, params: Valor[]): Promise<RespostaSql>;
}

export interface Backend extends Executor {
  /** BEGIN ... COMMIT (ROLLBACK se `fn` lançar). */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Converte "?" em $1, $2... ignorando literais entre aspas simples. */
export function converterPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let emTexto = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") {
      emTexto = !emTexto; // '' dentro de texto alterna duas vezes: continua correto
      out += ch;
    } else if (ch === "?" && !emTexto) {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

class Comando implements ComandoBanco {
  banco: BancoPg;
  sql: string;
  params: Valor[];
  constructor(banco: BancoPg, sql: string, params: Valor[] = []) {
    this.banco = banco;
    this.sql = sql;
    this.params = params;
  }
  bind(...valores: Valor[]): ComandoBanco {
    return new Comando(this.banco, this.sql, valores);
  }
  async first<T>(): Promise<T | null> {
    const r = await this.banco.backend.query(converterPlaceholders(this.sql), this.params);
    this.banco.consultas++;
    return (r.rows[0] ?? null) as T | null;
  }
  async all<T>(): Promise<ResultadoBanco<T>> {
    const r = await this.banco.backend.query(converterPlaceholders(this.sql), this.params);
    this.banco.consultas++;
    return { results: r.rows as T[], success: true, meta: {} };
  }
  async run(): Promise<ExecucaoBanco> {
    const r = await this.banco.backend.query(converterPlaceholders(this.sql), this.params);
    this.banco.consultas++;
    return { success: true, meta: { changes: r.rowCount ?? 0 } };
  }
  /** Executa dentro de uma transação já aberta. */
  async executarEm(tx: Executor): Promise<ExecucaoBanco> {
    const r = await tx.query(converterPlaceholders(this.sql), this.params);
    this.banco.consultas++;
    return { success: true, meta: { changes: r.rowCount ?? 0 } };
  }
}

export class BancoPg implements Banco {
  /** Contador de comandos executados (usado pelos testes para medir consultas por requisição). */
  consultas = 0;
  backend: Backend;
  constructor(backend: Backend) {
    this.backend = backend;
  }
  prepare(sql: string): ComandoBanco {
    return new Comando(this, sql);
  }
  async batch(comandos: ComandoBanco[]): Promise<unknown[]> {
    return this.backend.transaction(async (tx) => {
      const saida: unknown[] = [];
      for (const c of comandos) saida.push(await (c as Comando).executarEm(tx));
      return saida;
    });
  }
  fechar(): Promise<void> {
    return this.backend.close();
  }
}

/** Erro de violação de UNIQUE (SQLSTATE 23505)? Devolve o nome da constraint. */
export function violacaoUnica(e: unknown): string | null {
  const o = e as { code?: string; constraint?: string } | null;
  return o && o.code === "23505" ? (o.constraint ?? "") : null;
}
