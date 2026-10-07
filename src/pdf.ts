/**
 * Documentos clínicos formais (Resolução CFP nº 06/2019) em PDF, via pdf-lib
 * (JavaScript puro, roda nos Workers). Gerados em memória, sob demanda.
 *
 * Os dados que aparecem no documento (paciente, psicólogo, data de emissão) vêm de um
 * "snapshot" gravado na emissão; por isso o PDF regenerado é idêntico ao original,
 * mesmo que o cadastro mude depois.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { fmtData } from "./util.ts";

export type TipoDocumento = "declaracao" | "atestado" | "relatorio_psicologico";

export interface Snapshot {
  paciente_nome: string;
  paciente_cpf: string | null;
  paciente_nascimento: string | null;
  psicologo_nome: string;
  psicologo_crp: string;
  data_emissao: string; // YYYY-MM-DD
}

export interface CamposDeclaracao {
  data_atendimento: string;
  horario_inicio: string;
  horario_fim: string;
}
export interface CamposAtestado {
  dias_afastamento: number;
  cid: string | null;
}
export interface CamposRelatorio {
  motivo: string;
  procedimentos: string;
  analise: string;
  conclusao: string;
}

const LARGURA = 595.28; // A4
const ALTURA = 841.89;
const MARGEM = 56;
const UTIL = LARGURA - 2 * MARGEM;
const LIMITE_INFERIOR = 70;

// Fontes padrão do PDF usam WinAnsi (Latin-1 + alguns símbolos do Windows-1252).
const EXTRAS_WINANSI = new Set(["€", "‚", "ƒ", "„", "…", "†", "‡", "ˆ", "‰", "Š", "‹", "Œ", "Ž", "‘", "’", "“", "”", "•", "–", "—", "˜", "™", "š", "›", "œ", "ž", "Ÿ"]);

function limpar(texto: string): string {
  let saida = "";
  for (const ch of texto.replace(/\t/g, " ").replace(/\r/g, "")) {
    if (ch === "\n" || (ch >= " " && ch <= "~") || (ch >= "\u00A0" && ch <= "\u00FF") || EXTRAS_WINANSI.has(ch)) saida += ch;
    else saida += "?";
  }
  return saida;
}

function quebrar(texto: string, fonte: PDFFont, tam: number, largura: number): string[] {
  const linhas: string[] = [];
  for (const paragrafo of limpar(texto).split("\n")) {
    const palavras = paragrafo.split(/\s+/).filter(Boolean);
    if (!palavras.length) {
      linhas.push("");
      continue;
    }
    let atual = "";
    for (let palavra of palavras) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra;
      if (fonte.widthOfTextAtSize(tentativa, tam) <= largura) {
        atual = tentativa;
        continue;
      }
      if (atual) linhas.push(atual);
      atual = "";
      // palavra maior que a linha inteira: quebra por caracteres
      while (fonte.widthOfTextAtSize(palavra, tam) > largura) {
        let n = palavra.length - 1;
        while (n > 1 && fonte.widthOfTextAtSize(palavra.slice(0, n), tam) > largura) n--;
        linhas.push(palavra.slice(0, n));
        palavra = palavra.slice(n);
      }
      atual = palavra;
    }
    linhas.push(atual);
  }
  return linhas;
}

class Escritor {
  doc: PDFDocument;
  normal: PDFFont;
  negrito: PDFFont;
  italico: PDFFont;
  page!: PDFPage;
  y = 0;

  constructor(doc: PDFDocument, normal: PDFFont, negrito: PDFFont, italico: PDFFont) {
    this.doc = doc;
    this.normal = normal;
    this.negrito = negrito;
    this.italico = italico;
    this.novaPagina();
  }

  novaPagina(): void {
    this.page = this.doc.addPage([LARGURA, ALTURA]);
    // cabeçalho
    this.centralizadoEmY("Documento Psicológico", this.negrito, 14, ALTURA - 50);
    this.centralizadoEmY("Elaborado conforme Resolução CFP nº 06/2019", this.normal, 9, ALTURA - 68, rgb(0.4, 0.4, 0.4));
    this.y = ALTURA - 95;
    // rodapé
    this.centralizadoEmY(`Gerado por Sipsi  |  Página ${this.doc.getPageCount()}`, this.italico, 8, 30, rgb(0.5, 0.5, 0.5));
  }

  /** Texto centralizado horizontalmente, na altura absoluta `y` da página. */
  centralizadoEmY(texto: string, fonte: PDFFont, tam: number, y: number, cor = rgb(0, 0, 0)): void {
    const t = limpar(texto);
    const x = (LARGURA - fonte.widthOfTextAtSize(t, tam)) / 2;
    this.page.drawText(t, { x, y, size: tam, font: fonte, color: cor });
  }

  garantir(altura: number): void {
    if (this.y - altura < LIMITE_INFERIOR) this.novaPagina();
  }

  espaco(h: number): void {
    this.y -= h;
  }

  linha(texto: string, fonte: PDFFont, tam: number, alinhamento: "esq" | "centro" = "esq"): void {
    this.garantir(tam * 1.6);
    const t = limpar(texto);
    const x = alinhamento === "centro" ? (LARGURA - fonte.widthOfTextAtSize(t, tam)) / 2 : MARGEM;
    this.page.drawText(t, { x, y: this.y, size: tam, font: fonte });
    this.y -= tam * 1.6;
  }

  paragrafo(texto: string, fonte: PDFFont, tam: number, entrelinha = 1.55): void {
    for (const ln of quebrar(texto, fonte, tam, UTIL)) {
      this.garantir(tam * entrelinha);
      if (ln) this.page.drawText(ln, { x: MARGEM, y: this.y, size: tam, font: fonte });
      this.y -= tam * entrelinha;
    }
  }

  identificacao(s: Snapshot): void {
    this.linha("Identificação do profissional", this.negrito, 11);
    this.linha(`Nome: ${s.psicologo_nome}`, this.normal, 10);
    this.linha(`CRP: ${s.psicologo_crp}`, this.normal, 10);
    this.espaco(8);
    this.linha("Identificação do paciente", this.negrito, 11);
    this.linha(`Nome: ${s.paciente_nome}`, this.normal, 10);
    if (s.paciente_cpf) this.linha(`CPF: ${s.paciente_cpf}`, this.normal, 10);
    if (s.paciente_nascimento) this.linha(`Data de nascimento: ${fmtData(s.paciente_nascimento)}`, this.normal, 10);
    this.espaco(14);
  }

  titulo(texto: string): void {
    this.linha(texto, this.negrito, 12, "centro");
    this.espaco(10);
  }

  assinatura(s: Snapshot): void {
    this.garantir(110);
    this.linha(`São Paulo, ${fmtData(s.data_emissao)}`, this.normal, 11);
    this.espaco(34);
    this.linha("_".repeat(40), this.normal, 11, "centro");
    this.linha(`${s.psicologo_nome} - CRP ${s.psicologo_crp}`, this.normal, 11, "centro");
  }
}

export async function gerarPdf(
  tipo: TipoDocumento,
  snap: Snapshot,
  campos: CamposDeclaracao | CamposAtestado | CamposRelatorio,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const data = new Date(`${snap.data_emissao}T12:00:00Z`);
  doc.setTitle("Documento Psicológico - Sipsi");
  doc.setCreator("Sipsi");
  doc.setProducer("Sipsi");
  doc.setCreationDate(data); // datas fixas => PDF regenerado é idêntico, byte a byte
  doc.setModificationDate(data);

  const w = new Escritor(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
    await doc.embedFont(StandardFonts.HelveticaOblique),
  );
  w.identificacao(snap);

  if (tipo === "declaracao") {
    const c = campos as CamposDeclaracao;
    w.titulo("DECLARAÇÃO DE COMPARECIMENTO");
    w.paragrafo(
      `Declaro, para os devidos fins, que ${snap.paciente_nome} compareceu a atendimento psicológico ` +
        `no dia ${fmtData(c.data_atendimento)}, no período das ${c.horario_inicio} às ${c.horario_fim}.`,
      w.normal,
      11,
    );
  } else if (tipo === "atestado") {
    const c = campos as CamposAtestado;
    w.titulo("ATESTADO PSICOLÓGICO");
    let texto =
      `Atesto que ${snap.paciente_nome} necessita de afastamento de suas atividades por um período de ` +
      `${c.dias_afastamento} dia(s), a contar de ${fmtData(snap.data_emissao)}, por motivo de ordem psicológica.`;
    if (c.cid) texto += ` CID: ${c.cid}.`;
    w.paragrafo(texto, w.normal, 11);
  } else {
    const c = campos as CamposRelatorio;
    w.titulo("RELATÓRIO PSICOLÓGICO");
    const secoes: [string, string][] = [
      ["1. Motivo / demanda", c.motivo],
      ["2. Procedimentos utilizados", c.procedimentos],
      ["3. Análise", c.analise],
      ["4. Conclusão", c.conclusao],
    ];
    for (const [t, texto] of secoes) {
      w.garantir(40);
      w.linha(t, w.negrito, 11);
      w.paragrafo(texto, w.normal, 10);
      w.espaco(6);
    }
  }
  w.espaco(22);
  w.assinatura(snap);
  return doc.save();
}
