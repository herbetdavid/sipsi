// Modo local: servidor HTTP real (node:http) com PostgreSQL embutido em memória.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { abrirLocal, montarRequest } from "../src/local/servidor.ts";

function falsoReq(headers: Record<string, string>, ip = "10.0.0.5"): IncomingMessage {
  return { headers, method: "GET", url: "/x", socket: { remoteAddress: ip } } as unknown as IncomingMessage;
}

test("local: o IP vem do socket; cabeçalhos de IP enviados pelo cliente são descartados", () => {
  const r = montarRequest(falsoReq({ host: "localhost:8787", "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }), undefined, false);
  assert.equal(r.headers.get("cf-connecting-ip"), "10.0.0.5");
  assert.equal(new URL(r.url).protocol, "http:");
});

test("local: atrás de proxy confiável usa X-Forwarded-For/Proto", () => {
  const r = montarRequest(falsoReq({ host: "app.clinica.com", "x-forwarded-for": "9.9.9.9, 10.0.0.1", "x-forwarded-proto": "https" }), undefined, true);
  assert.equal(r.headers.get("cf-connecting-ip"), "9.9.9.9");
  assert.equal(new URL(r.url).protocol, "https:");
});

test("local: servidor responde /healthz e a tela de login, migrando o banco sozinho", async () => {
  const app = await abrirLocal({ pepper: "pepper-de-teste" });
  await new Promise<void>((ok) => app.servidor.listen(0, "127.0.0.1", ok));
  const { port } = app.servidor.address() as AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    const login = await fetch(`http://127.0.0.1:${port}/auth/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /<form/i);
    const n = await app.banco!.prepare("SELECT COUNT(*) AS n FROM _migracoes").first<{ n: number }>();
    assert.equal(n!.n, 2);
  } finally {
    await app.fechar();
  }
});
