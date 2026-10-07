// Roteador mínimo: "/pacientes/:id" -> regex. Sem dependências.
import type { Ctx } from "./ctx.ts";
import type { Papel } from "./auth.ts";
import { TODOS_OS_PAPEIS } from "./auth.ts";

export type Handler = (c: Ctx) => Promise<Response>;

export interface OpcoesRota {
  /** Papéis autorizados (padrão: qualquer usuário autenticado). */
  papeis?: Papel[];
  /** Rota acessível sem login (somente a tela de login). */
  publico?: boolean;
}

export interface Rota {
  metodo: "GET" | "POST";
  regex: RegExp;
  chaves: string[];
  handler: Handler;
  papeis: Papel[];
  publico: boolean;
}

export class Router {
  rotas: Rota[] = [];

  adicionar(metodo: "GET" | "POST", caminho: string, handler: Handler, o: OpcoesRota = {}): void {
    const chaves: string[] = [];
    const padrao = caminho.replace(/:([a-zA-Z_]+)/g, (_m, nome: string) => {
      chaves.push(nome);
      return "([^/]+)";
    });
    this.rotas.push({
      metodo,
      regex: new RegExp(`^${padrao}$`),
      chaves,
      handler,
      papeis: o.papeis ?? TODOS_OS_PAPEIS,
      publico: o.publico ?? false,
    });
  }

  get(caminho: string, handler: Handler, o?: OpcoesRota): void {
    this.adicionar("GET", caminho, handler, o);
  }

  post(caminho: string, handler: Handler, o?: OpcoesRota): void {
    this.adicionar("POST", caminho, handler, o);
  }

  /** Retorna a rota + parâmetros, "metodo" (caminho existe, método não) ou null. */
  casar(metodo: string, caminho: string): { rota: Rota; params: Record<string, string> } | "metodo" | null {
    let existeOutroMetodo = false;
    for (const rota of this.rotas) {
      const m = rota.regex.exec(caminho);
      if (!m) continue;
      if (rota.metodo !== metodo) {
        existeOutroMetodo = true;
        continue;
      }
      const params: Record<string, string> = {};
      rota.chaves.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? "");
      });
      return { rota, params };
    }
    return existeOutroMetodo ? "metodo" : null;
  }
}
