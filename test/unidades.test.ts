import { test } from "node:test";
import assert from "node:assert/strict";
import { brl, reaisParaCentavos, dataIsoValida, dataHoraLocalValida, horaValida, caminhoInternoSeguro, fmtDataHoraUtc, fmtDataHoraLocal, fmtData, inteiro } from "../src/util.ts";
import { hashSenha, verificarSenha, ITERACOES_MAX } from "../src/crypto.ts";
import { esc, html } from "../src/html.ts";

test("dinheiro: formatação pt-BR e parsing em centavos", () => {
  assert.equal(brl(15000), "R$ 150,00");
  assert.equal(brl(1234567), "R$ 12.345,67");
  assert.equal(brl(5), "R$ 0,05");
  assert.equal(brl(0), "R$ 0,00");
  assert.equal(reaisParaCentavos("150"), 15000);
  assert.equal(reaisParaCentavos("150.5"), 15050);
  assert.equal(reaisParaCentavos("150,50"), 15050);
  assert.equal(reaisParaCentavos("0.07"), 7);
  assert.equal(reaisParaCentavos("-1"), null);
  assert.equal(reaisParaCentavos("abc"), null);
  assert.equal(reaisParaCentavos("1.234"), null);
  assert.equal(reaisParaCentavos(""), null);
});

test("datas: validação estrita e formatação", () => {
  assert.ok(dataIsoValida("2026-02-28"));
  assert.ok(!dataIsoValida("2026-02-30"));
  assert.ok(!dataIsoValida("2026-13-01"));
  assert.ok(!dataIsoValida("02/10/2026"));
  assert.ok(dataHoraLocalValida("2026-10-02T14:30"));
  assert.ok(!dataHoraLocalValida("2026-10-02T24:00"));
  assert.ok(horaValida("23:59") && !horaValida("24:00") && !horaValida("9:00"));
  assert.equal(fmtData("2026-10-02"), "02/10/2026");
  assert.equal(fmtDataHoraLocal("2026-10-02T14:30"), "02/10/2026 14:30");
  // 15:00 UTC = 12:00 em Brasília (UTC-3, sem horário de verão)
  assert.equal(fmtDataHoraUtc("2026-10-02T15:00:00"), "02/10/2026 12:00");
  assert.equal(fmtDataHoraUtc("2026-10-02T02:30:15", true), "01/10/2026 23:30:15");
  assert.equal(inteiro("12"), 12);
  assert.equal(inteiro("1e3"), null);
  assert.equal(inteiro("-3"), null);
});

test("redirecionamento: só caminhos internos (anti open-redirect)", () => {
  assert.equal(caminhoInternoSeguro("/agenda"), "/agenda");
  assert.equal(caminhoInternoSeguro("//evil.com"), null);
  assert.equal(caminhoInternoSeguro("https://evil.com"), null);
  assert.equal(caminhoInternoSeguro("/\\evil.com"), null);
  assert.equal(caminhoInternoSeguro(""), null);
});

test("html: escapa tudo que é interpolado, mas não o HTML do próprio template", () => {
  const nome = `<img src=x onerror="alert(1)"> & 'aspas'`;
  const saida = html`<p title="${nome}">${nome}</p>`.s;
  assert.ok(!saida.includes("<img"));
  assert.ok(saida.includes("&lt;img"));
  assert.ok(saida.includes("&quot;"));
  assert.equal(esc("a<b"), "a&lt;b");
  const aninhado = html`<ul>${["<a>", "b"].map((x) => html`<li>${x}</li>`)}</ul>`.s;
  assert.equal(aninhado, "<ul><li>&lt;a&gt;</li><li>b</li></ul>");
  assert.equal(html`${null}${undefined}${false}x`.s, "x");
});

test("senhas: PBKDF2 com pepper (ida e volta, adulteração, pepper errado, teto de iterações)", async () => {
  const h = await hashSenha("senha-forte-123", "pepper-A");
  assert.match(h, /^pbkdf2-sha256\$100000\$[\w-]+\$[\w-]+$/);
  assert.ok(await verificarSenha("senha-forte-123", h, "pepper-A"));
  assert.ok(!(await verificarSenha("senha-forte-124", h, "pepper-A")));
  assert.ok(!(await verificarSenha("senha-forte-123", h, "pepper-B")), "pepper diferente não pode validar");
  const adulterado = h.slice(0, -2) + (h.endsWith("A") ? "BB" : "AA");
  assert.ok(!(await verificarSenha("senha-forte-123", adulterado, "pepper-A")));
  assert.ok(!(await verificarSenha("x", "lixo", "pepper-A")));
  // sal aleatório: o mesmo texto gera hashes diferentes
  assert.notEqual(h, await hashSenha("senha-forte-123", "pepper-A"));
  // o runtime dos Workers recusa > 100.000 iterações; pedir mais é limitado ao teto
  const limitado = await hashSenha("x", "p", 600_000);
  assert.ok(limitado.startsWith(`pbkdf2-sha256$${ITERACOES_MAX}$`));
  // hash armazenado com mais iterações que o teto é recusado em vez de estourar no runtime
  assert.ok(!(await verificarSenha("x", limitado.replace(`$${ITERACOES_MAX}$`, "$600000$"), "p")));
  await assert.rejects(() => hashSenha("x", ""), /PASSWORD_PEPPER/);
});
