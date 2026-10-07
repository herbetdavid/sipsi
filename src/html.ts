// Template HTML com escape automático: tudo que é interpolado é escapado,
// exceto valores já marcados como seguros (resultado de html`` ou bruto()).

export class Seguro {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
  toString(): string {
    return this.s;
  }
}

const MAPA: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (ch) => MAPA[ch] ?? ch);
}

function renderizar(v: unknown): string {
  if (v instanceof Seguro) return v.s;
  if (Array.isArray(v)) return v.map(renderizar).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

export function html(partes: TemplateStringsArray, ...valores: unknown[]): Seguro {
  let saida = "";
  partes.forEach((p, i) => {
    saida += p;
    if (i < valores.length) saida += renderizar(valores[i]);
  });
  return new Seguro(saida);
}

/** Marca uma string como HTML confiável (use só com conteúdo escrito por nós). */
export function bruto(s: string): Seguro {
  return new Seguro(s);
}
