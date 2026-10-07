import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { html, type Seguro } from "../html.ts";
import { brl, dataIsoValida, fmtData } from "../util.ts";
import type { Valor } from "../env.ts";

function abas(ativa: string): Seguro {
  const item = (href: string, chave: string, rotulo: string): Seguro =>
    html`<li class="nav-item"><a class="nav-link ${ativa === chave ? "active" : ""}" href="${href}">${rotulo}</a></li>`;
  return html`<ul class="nav nav-tabs mb-3">${item("/relatorios/faturamento", "fat", "Faturamento")}${item("/relatorios/faltas", "faltas", "Faltas")}${item("/relatorios/livro-caixa", "caixa", "Livro caixa")}</ul>`;
}

/** Lê ?inicio= e ?fim=; valores inválidos são ignorados. */
function periodo(c: Ctx): { inicio: string; fim: string } {
  const inicio = c.consulta("inicio");
  const fim = c.consulta("fim");
  return { inicio: dataIsoValida(inicio) ? inicio : "", fim: dataIsoValida(fim) ? fim : "" };
}

function formPeriodo(acao: string, inicio: string, fim: string): Seguro {
  return html`<form method="get" action="${acao}" class="d-flex gap-2 mb-3">
  <input type="date" name="inicio" value="${inicio}" class="form-control" style="max-width:200px">
  <input type="date" name="fim" value="${fim}" class="form-control" style="max-width:200px">
  <button class="btn btn-outline-primary">Filtrar</button>
</form>`;
}

async function faturamento(c: Ctx): Promise<Response> {
  const { inicio, fim } = periodo(c);
  const filtros: string[] = [];
  const valores: Valor[] = [];
  if (inicio) {
    filtros.push("data_vencimento >= ?");
    valores.push(inicio);
  }
  if (fim) {
    filtros.push("data_vencimento <= ?");
    valores.push(fim);
  }
  const onde = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
  const { results } = await c.db
    .prepare(
      `SELECT substr(data_vencimento, 1, 7) AS mes, status, SUM(valor_centavos) AS total
         FROM lancamento_financeiro ${onde} GROUP BY mes, status ORDER BY mes, status`,
    )
    .bind(...valores)
    .all<{ mes: string | null; status: string; total: number }>();

  const totalPago = results.filter((r) => r.status === "pago").reduce((s, r) => s + r.total, 0);
  const totalPendente = results.filter((r) => r.status === "pendente").reduce((s, r) => s + r.total, 0);

  return c.pagina(
    "Faturamento",
    html`<h2 class="mb-3">Relatório de Faturamento</h2>${abas("fat")}
${formPeriodo("/relatorios/faturamento", inicio, fim)}
<div class="row mb-4">
  <div class="col-md-4"><div class="card bg-success text-white"><div class="card-body"><h6>Recebido</h6><h3>${brl(totalPago)}</h3></div></div></div>
  <div class="col-md-4"><div class="card bg-warning"><div class="card-body"><h6>Pendente</h6><h3>${brl(totalPendente)}</h3></div></div></div>
</div>
<table class="table table-bordered bg-white">
  <thead><tr><th>Mês</th><th>Status</th><th>Total</th></tr></thead>
  <tbody>
    ${results.length
      ? results.map((r) => html`<tr><td>${r.mes ?? "-"}</td><td>${r.status}</td><td>${brl(r.total)}</td></tr>`)
      : html`<tr><td colspan="3" class="text-muted">Sem dados no período.</td></tr>`}
  </tbody>
</table>`,
  );
}

async function faltas(c: Ctx): Promise<Response> {
  const { results } = await c.db
    .prepare("SELECT status, COUNT(*) AS n FROM sessao GROUP BY status")
    .all<{ status: string; n: number }>();
  const contagem: Record<string, number> = {};
  let total = 0;
  for (const r of results) {
    contagem[r.status] = r.n;
    total += r.n;
  }
  const pct = (n: number): string => (total ? ((n / total) * 100).toFixed(1) : "0.0").replace(".", ",");

  return c.pagina(
    "Faltas",
    html`<h2 class="mb-3">Taxa de Faltas e Cancelamentos</h2>${abas("faltas")}
<div class="row g-3">
  <div class="col-md-4"><div class="card"><div class="card-body"><h6>Total de sessões</h6><h3>${total}</h3></div></div></div>
  <div class="col-md-4"><div class="card border-danger"><div class="card-body"><h6>Taxa de faltas</h6><h3>${pct(contagem.falta ?? 0)}%</h3>
    <p class="text-muted small">${contagem.falta ?? 0} sessão(ões)</p></div></div></div>
  <div class="col-md-4"><div class="card border-secondary"><div class="card-body"><h6>Taxa de cancelamento</h6><h3>${pct(contagem.cancelada ?? 0)}%</h3>
    <p class="text-muted small">${contagem.cancelada ?? 0} sessão(ões)</p></div></div></div>
</div>`,
  );
}

/** Relatório simplificado para o contador: entradas confirmadas no período. */
async function livroCaixa(c: Ctx): Promise<Response> {
  const { inicio, fim } = periodo(c);
  const filtros = ["l.status = 'pago'"];
  const valores: Valor[] = [];
  if (inicio) {
    filtros.push("l.data_pagamento >= ?");
    valores.push(inicio);
  }
  if (fim) {
    filtros.push("l.data_pagamento <= ?");
    valores.push(fim);
  }
  const { results } = await c.db
    .prepare(
      `SELECT l.data_pagamento, l.forma_pagamento, l.valor_centavos, p.nome AS paciente_nome
         FROM lancamento_financeiro l JOIN paciente p ON p.id = l.paciente_id
        WHERE ${filtros.join(" AND ")} ORDER BY l.data_pagamento, l.id`,
    )
    .bind(...valores)
    .all<{ data_pagamento: string; forma_pagamento: string | null; valor_centavos: number; paciente_nome: string }>();
  const total = results.reduce((s, l) => s + l.valor_centavos, 0);

  return c.pagina(
    "Livro Caixa",
    html`<h2 class="mb-3">Livro Caixa (para o contador)</h2>${abas("caixa")}
${formPeriodo("/relatorios/livro-caixa", inicio, fim)}
<table class="table table-bordered bg-white">
  <thead><tr><th>Data pagamento</th><th>Paciente</th><th>Forma</th><th>Valor</th></tr></thead>
  <tbody>
    ${results.length
      ? results.map((l) => html`<tr><td>${fmtData(l.data_pagamento)}</td><td>${l.paciente_nome}</td><td>${l.forma_pagamento ?? "-"}</td><td>${brl(l.valor_centavos)}</td></tr>`)
      : html`<tr><td colspan="4" class="text-muted">Sem entradas no período.</td></tr>`}
  </tbody>
  <tfoot><tr><th colspan="3">Total</th><th>${brl(total)}</th></tr></tfoot>
</table>`,
  );
}

export function registrarRotasRelatorios(r: Router): void {
  r.get("/relatorios/faturamento", faturamento);
  r.get("/relatorios/faltas", faltas);
  r.get("/relatorios/livro-caixa", livroCaixa);
}
