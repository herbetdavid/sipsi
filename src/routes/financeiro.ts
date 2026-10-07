import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { html } from "../html.ts";
import { badge, formPost } from "../views.ts";
import { FINANCEIRO } from "../rbac.ts";
import { brl, fmtData, hojeLocal } from "../util.ts";
import { HttpError } from "../ctx.ts";

const FORMAS = ["pix", "cartao", "dinheiro", "transferencia"];

interface Linha {
  id: number;
  paciente_nome: string;
  data_vencimento: string | null;
  data_pagamento: string | null;
  valor_centavos: number;
  status: string;
}

async function listar(c: Ctx): Promise<Response> {
  const { results } = await c.db
    .prepare(
      `SELECT l.id, p.nome AS paciente_nome, l.data_vencimento, l.data_pagamento, l.valor_centavos, l.status
         FROM lancamento_financeiro l JOIN paciente p ON p.id = l.paciente_id
        ORDER BY l.data_vencimento DESC, l.id DESC LIMIT 300`,
    )
    .all<Linha>();

  return c.pagina(
    "Financeiro",
    html`<h2 class="mb-3">Financeiro</h2>
<table class="table table-bordered bg-white align-middle">
  <thead><tr><th>Paciente</th><th>Vencimento</th><th>Valor</th><th>Status</th><th>Ações</th></tr></thead>
  <tbody>
    ${results.length
      ? results.map(
          (l) => html`<tr>
      <td>${l.paciente_nome}</td><td>${fmtData(l.data_vencimento)}</td><td>${brl(l.valor_centavos)}</td>
      <td>${badge(l.status === "pago" ? "bg-success" : "bg-warning text-dark", l.status)}</td>
      <td>${l.status === "pendente"
        ? formPost(
            c,
            `/financeiro/${l.id}/pagar`,
            "d-flex gap-1",
            html`<select name="forma_pagamento" class="form-select form-select-sm" style="width:auto">
              <option value="pix">PIX</option><option value="cartao">Cartão</option>
              <option value="dinheiro">Dinheiro</option><option value="transferencia">Transferência</option>
            </select><button class="btn btn-sm btn-outline-success">Registrar pagamento</button>`,
          )
        : html`<span class="text-muted small">pago em ${fmtData(l.data_pagamento)}</span>`}</td></tr>`,
        )
      : html`<tr><td colspan="5" class="text-muted">Nenhum lançamento.</td></tr>`}
  </tbody>
</table>`,
  );
}

async function pagar(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const forma = (await c.campo("forma_pagamento")) || "pix";
  if (!FORMAS.includes(forma)) throw new HttpError(400, "Forma de pagamento inválida.");
  const r = await c.db
    .prepare(
      "UPDATE lancamento_financeiro SET status = 'pago', forma_pagamento = ?, data_pagamento = ? WHERE id = ? AND status = 'pendente'",
    )
    .bind(forma, hojeLocal(), id)
    .run();
  if (r.meta.changes === 0) {
    return c.redirecionar("/financeiro", { tipo: "warning", msg: "Lançamento não encontrado ou já pago." });
  }
  return c.redirecionar("/financeiro", { tipo: "success", msg: "Pagamento registrado." });
}

export function registrarRotasFinanceiro(r: Router): void {
  r.get("/financeiro", listar, { papeis: FINANCEIRO });
  r.post("/financeiro/:id/pagar", pagar, { papeis: FINANCEIRO });
}
