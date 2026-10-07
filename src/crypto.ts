// Primitivas de criptografia usando apenas Web Crypto (nativa nos Workers).

const enc = new TextEncoder();

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return enc.encode(s) as Uint8Array<ArrayBuffer>;
}

export function paraHex(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function paraB64url(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let bin = "";
  for (const x of u) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(texto: string): Promise<string> {
  return paraHex(await crypto.subtle.digest("SHA-256", utf8(texto)));
}

export async function hmacSha256(chave: Uint8Array<ArrayBuffer>, msg: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", chave, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
}

export function aleatorioB64url(bytes: number): string {
  return paraB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function igualConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------------------
// Senhas: PBKDF2-HMAC-SHA256 com sal aleatório + "pepper" (segredo do Worker).
//
// O runtime dos Workers recusa mais de 100.000 iterações, então este é o teto
// da plataforma (abaixo dos 600.000 recomendados pela OWASP). O pepper
// (HMAC da senha com um segredo que NÃO fica no banco) compensa em parte: um
// vazamento só do banco não permite ataque offline às senhas.
// Formato armazenado: pbkdf2-sha256$<iterações>$<sal b64url>$<hash b64url>
// ---------------------------------------------------------------------------

export const ITERACOES_MAX = 100_000;

async function derivar(senha: string, pepper: string, sal: Uint8Array<ArrayBuffer>, iteracoes: number): Promise<Uint8Array> {
  if (!pepper) throw new Error("PASSWORD_PEPPER não configurado.");
  const material = await hmacSha256(utf8(pepper), utf8(senha));
  const chave = await crypto.subtle.importKey("raw", material as Uint8Array<ArrayBuffer>, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteracoes },
    chave,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashSenha(senha: string, pepper: string, iteracoes: number = ITERACOES_MAX): Promise<string> {
  const it = Math.min(iteracoes, ITERACOES_MAX);
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const h = await derivar(senha, pepper, sal, it);
  return `pbkdf2-sha256$${it}$${paraB64url(sal)}$${paraB64url(h)}`;
}

export async function verificarSenha(senha: string, armazenado: string, pepper: string): Promise<boolean> {
  const p = armazenado.split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2-sha256") return false;
  const it = Number(p[1]);
  if (!Number.isInteger(it) || it < 1 || it > ITERACOES_MAX) return false;
  const h = await derivar(senha, pepper, deB64url(p[2] ?? ""), it);
  return igualConstante(paraB64url(h), p[3] ?? "");
}

/** Hash fictício: usado para gastar o mesmo tempo quando o e-mail não existe. */
export const HASH_FALSO = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
