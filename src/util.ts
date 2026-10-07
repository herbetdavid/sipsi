// Datas, dinheiro e validações simples.
//
// Convenções de armazenamento (PostgreSQL/Neon):
//  - timestamps de registro: texto ISO em UTC, "YYYY-MM-DDTHH:MM:SS"
//  - data/hora de sessão: horário LOCAL da clínica, sem fuso, "YYYY-MM-DDTHH:MM"
//  - datas: "YYYY-MM-DD"
//  - dinheiro: inteiro em centavos (nunca ponto flutuante)

export const FUSO = "America/Sao_Paulo";

export function agoraUtc(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19);
}

/** Data de hoje (YYYY-MM-DD) no fuso da clínica. */
export function hojeLocal(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_DATA_HORA = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function dataValida(a: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function dataIsoValida(s: string): boolean {
  const m = RE_DATA.exec(s);
  return !!m && dataValida(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function dataHoraLocalValida(s: string): boolean {
  const m = RE_DATA_HORA.exec(s);
  if (!m) return false;
  return (
    dataValida(Number(m[1]), Number(m[2]), Number(m[3])) &&
    Number(m[4]) <= 23 &&
    Number(m[5]) <= 59
  );
}

export function horaValida(s: string): boolean {
  return RE_HORA.test(s);
}

/** "2026-10-02" -> "02/10/2026" */
export function fmtData(s: string | null | undefined): string {
  if (!s) return "-";
  const m = RE_DATA.exec(s.slice(0, 10));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/** Horário local sem fuso: "2026-10-02T14:30" -> "02/10/2026 14:30" */
export function fmtDataHoraLocal(s: string | null | undefined): string {
  if (!s) return "-";
  const m = RE_DATA_HORA.exec(s.slice(0, 16));
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : s;
}

/** Timestamp UTC de registro -> horário de Brasília: "dd/mm/aaaa HH:MM[:SS]" */
export function fmtDataHoraUtc(s: string | null | undefined, comSegundos = false): string {
  if (!s) return "-";
  const d = new Date(s.length === 19 ? s + "Z" : s);
  if (Number.isNaN(d.getTime())) return s;
  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string): string => partes.find((p) => p.type === t)?.value ?? "";
  const base = `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`;
  return comSegundos ? `${base}:${g("second")}` : base;
}

/** 15050 -> "R$ 150,50" */
export function brl(centavos: number | null | undefined): string {
  const v = Math.round(centavos ?? 0);
  const sinal = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const inteiro = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cent = String(abs % 100).padStart(2, "0");
  return `${sinal}R$ ${inteiro},${cent}`;
}

/** "150", "150.5", "150,50" -> centavos; null se inválido ou negativo. */
export function reaisParaCentavos(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [inteiro = "0", frac = ""] = t.split(".");
  return Number(inteiro) * 100 + Number((frac + "00").slice(0, 2));
}

/** Inteiro positivo estrito ("12"); null se inválido. */
export function inteiro(s: string | null | undefined): number | null {
  if (!s || !/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function emailValido(s: string): boolean {
  return s.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Aceita só caminhos internos (evita open redirect no parâmetro ?next=). */
export function caminhoInternoSeguro(s: string | null | undefined): string | null {
  if (!s || !s.startsWith("/") || s.startsWith("//") || s.includes("\\")) return null;
  return s;
}
