/**
 * Camada de integração com emissão de NFS-e (Nota Fiscal de Serviço Eletrônica).
 * Psicólogos prestam SERVIÇO: o documento correto é NFS-e (municipal), não NFe.
 *
 * Cada prefeitura tem seu webservice; na prática usa-se um provedor intermediário
 * (eNotas, NFE.io, Focus NFe) atrás de uma API única. Aqui há uma INTERFACE
 * (NFSeProvider) e um MockNFSeProvider que simula o comportamento, sem credenciais.
 * Para integrar um provedor real: implemente NFSeProvider (usando fetch) e
 * troque o retorno de obterProvider().
 */
import type { Env } from "./env.ts";

export interface NFSeResultado {
  sucesso: boolean;
  numeroNota?: string;
  codigoVerificacao?: string;
  valorIssCentavos?: number;
  urlPdf?: string | null;
  mensagemErro?: string;
}

export interface NFSeEmissao {
  valorCentavos: number;
  descricaoServico: string;
  tomadorNome: string;
  tomadorCpf: string | null;
}

export interface NFSeProvider {
  nome: string;
  emitir(dados: NFSeEmissao): Promise<NFSeResultado>;
}

function sorteio(tamanho: number, alfabeto: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(tamanho));
  return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join("");
}

export class MockNFSeProvider implements NFSeProvider {
  nome = "mock";
  /** Alíquota de exemplo (5%). Varia por município: parametrizar em produção. */
  aliquotaIss = 0.05;

  async emitir(dados: NFSeEmissao): Promise<NFSeResultado> {
    return {
      sucesso: true,
      numeroNota: sorteio(8, "0123456789"),
      codigoVerificacao: sorteio(10, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
      valorIssCentavos: Math.round(dados.valorCentavos * this.aliquotaIss),
      urlPdf: null,
    };
  }
}

/** Ponto único de troca entre o mock e um provedor real. */
export function obterProvider(_env: Env): NFSeProvider {
  return new MockNFSeProvider();
}
