import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { HttpError } from "../ctx.ts";
import { html } from "../html.ts";
import { badge, formPost } from "../views.ts";
import { FINANCEIRO } from "../rbac.ts";
import { brl, fmtData, fmtDataHoraUtc } from "../util.ts";
import { registrarLog } from "../audit.ts";
import { obterProvider, type NFSeResultado } from "../nfse.ts";

/** Reservas "pendentes" mais velhas que isto são consideradas abandonadas e podem ser retomadas. */
const RESERVA_EXPIRA_MIN = 5;

function minutosAtras(isoUtc: string, min: number): string {
  return new Date(new Date(isoUtc + "Z").getTime() - min * 60_000).toISOString().slice(0, 19);
}

async function listar(c: Ctx): Promise<Response> {
  const { results: notas } = await c.db
    .prepare(
      `SELECT n.id, n.numero_nota, n.status, n.valor_iss_centavos, n.emitida_em, n.mensagem_erro,
              l.valor_centavos, p.nome AS paciente_nome
         FROM nota_fiscal n
         JOIN lancamento_financeiro l ON l.id = n.lancamento_id
         JOIN paciente p ON p.id = l.paciente_id
        ORDER BY n.criado_em DESC LIMIT 200`,
    )
    .all<{
      id: number;
      numero_nota: string | null;
      status: string;
      valor_iss_centavos: number | null;
      emitida_em: string | null;
      mensagem_erro: string | null;
      valor_centavos: number;
      paciente_nome: string;
    }>();
  const { results: pendentes } = await c.db
    .prepare(
      `SELECT l.id, l.valor_centavos, l.data_pagamento, p.nome AS paciente_nome
         FROM lancamento_financeiro l JOIN paciente p ON p.id = l.paciente_id
        WHERE l.status = 'pago'
          AND NOT EXISTS (SELECT 1 FROM nota_fiscal n WHERE n.lancamento_id = l.id AND n.status = 'emitida')
        ORDER BY l.data_pagamento DESC`,
    )
    .all<{ id: number; valor_centavos: number; data_pagamento: string | null; paciente_nome: string }>();

  return c.pagina(
    "NFS-e",
    html`<h2 class="mb-3">NFS-e (Nota Fiscal de Serviço Eletrônica)</h2>
<div class="alert alert-info small">
  Ambiente de demonstração: as notas são emitidas por um provedor simulado (MockNFSeProvider),
  sem integração real com prefeitura. Veja <code>src/nfse.ts</code> para o ponto de troca por um
  provedor real (eNotas, NFE.io, Focus NFe).
</div>
<h5 class="mt-4">Lançamentos pagos aguardando emissão</h5>
<table class="table table-bordered bg-white">
  <thead><tr><th>Paciente</th><th>Valor</th><th>Data pagamento</th><th></th></tr></thead>
  <tbody>
    ${pendentes.length
      ? pendentes.map(
          (l) => html`<tr><td>${l.paciente_nome}</td><td>${brl(l.valor_centavos)}</td><td>${fmtData(l.data_pagamento)}</td>
        <td>${formPost(c, `/nfse/emitir/${l.id}`, "", html`<button class="btn btn-sm btn-primary">Emitir NFS-e</button>`)}</td></tr>`,
        )
      : html`<tr><td colspan="4" class="text-muted">Nenhum lançamento pendente de emissão.</td></tr>`}
  </tbody>
</table>
<h5 class="mt-4">Notas emitidas</h5>
<table class="table table-bordered bg-white">
  <thead><tr><th>Número</th><th>Paciente</th><th>Valor</th><th>ISS</th><th>Status</th><th>Emitida em</th></tr></thead>
  <tbody>
    ${notas.length
      ? notas.map(
          (n) => html`<tr><td>${n.numero_nota || "-"}</td><td>${n.paciente_nome}</td><td>${brl(n.valor_centavos)}</td>
        <td>${n.valor_iss_centavos ? brl(n.valor_iss_centavos) : "-"}</td>
        <td>${badge(n.status === "emitida" ? "bg-success" : "bg-danger", n.status)}</td>
        <td>${fmtDataHoraUtc(n.emitida_em)}</td></tr>`,
        )
      : html`<tr><td colspan="6" class="text-muted">Nenhuma nota emitida ainda.</td></tr>`}
  </tbody>
</table>`,
  );
}

async function emitir(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const l = await c.db
    .prepare(
      `SELECT l.id, l.status, l.valor_centavos, p.id AS paciente_id, p.nome, p.cpf
         FROM lancamento_financeiro l JOIN paciente p ON p.id = l.paciente_id WHERE l.id = ?`,
    )
    .bind(id)
    .first<{ id: number; status: string; valor_centavos: number; paciente_id: number; nome: string; cpf: string | null }>();
  if (!l) throw new HttpError(404, "Lançamento não encontrado.");
  if (l.status !== "pago") {
    return c.redirecionar("/nfse", { tipo: "warning", msg: "Só é possível emitir nota para lançamentos já pagos." });
  }

  const provider = obterProvider(c.env);

  // 1) RESERVA a emissão antes de falar com o provedor. UNIQUE(lancamento_id) faz com que, se duas
  //    requisições chegarem juntas (duplo clique), só uma consiga a reserva e chame o provedor,
  //    evitando duas notas fiscais reais para o mesmo serviço. Uma reserva "pendente" antiga
  //    (requisição que morreu no meio) ou uma nota com erro podem ser retomadas.
  const reserva = await c.db
    .prepare(
      `INSERT INTO nota_fiscal (lancamento_id, provedor, status, criado_em) VALUES (?, ?, 'pendente', ?)
       ON CONFLICT(lancamento_id) DO UPDATE SET
         status = 'pendente', provedor = excluded.provedor, criado_em = excluded.criado_em, mensagem_erro = NULL
       WHERE nota_fiscal.status = 'erro' OR (nota_fiscal.status = 'pendente' AND nota_fiscal.criado_em < ?)`,
    )
    .bind(l.id, provider.nome, c.agora, minutosAtras(c.agora, RESERVA_EXPIRA_MIN))
    .run();
  if (reserva.meta.changes === 0) {
    return c.redirecionar("/nfse", { tipo: "warning", msg: "Este lançamento já possui NFS-e emitida ou em emissão." });
  }

  // 2) Chama o provedor (uma falha vira nota com erro, que pode ser reemitida).
  let res: NFSeResultado;
  try {
    res = await provider.emitir({
      valorCentavos: l.valor_centavos,
      descricaoServico: "Prestação de serviços de psicologia clínica",
      tomadorNome: l.nome,
      tomadorCpf: l.cpf,
    });
  } catch (e) {
    console.error("falha no provedor de NFS-e:", e instanceof Error ? e.message : e);
    res = { sucesso: false, mensagemErro: "falha ao contatar o provedor de NFS-e" };
  }

  // 3) Grava o resultado sobre a reserva.
  await c.db
    .prepare(
      `UPDATE nota_fiscal SET status = ?, numero_nota = ?, codigo_verificacao = ?, valor_iss_centavos = ?,
              url_pdf = ?, mensagem_erro = ?, emitida_em = ?
        WHERE lancamento_id = ? AND status = 'pendente'`,
    )
    .bind(
      res.sucesso ? "emitida" : "erro",
      res.numeroNota ?? null,
      res.codigoVerificacao ?? null,
      res.valorIssCentavos ?? null,
      res.urlPdf ?? null,
      res.mensagemErro ?? null,
      res.sucesso ? c.agora : null,
      l.id,
    )
    .run();

  const nota = await c.db.prepare("SELECT id FROM nota_fiscal WHERE lancamento_id = ?").bind(l.id).first<{ id: number }>();
  await registrarLog(c, "emitir", "NotaFiscal", nota?.id ?? null, l.paciente_id, `NFS-e nº ${res.numeroNota ?? "-"} - valor ${brl(l.valor_centavos)}`);

  return res.sucesso
    ? c.redirecionar("/nfse", { tipo: "success", msg: `NFS-e nº ${res.numeroNota} emitida com sucesso (ambiente de demonstração).` })
    : c.redirecionar("/nfse", { tipo: "danger", msg: `Falha na emissão: ${res.mensagemErro ?? "erro desconhecido"}.` });
}

export function registrarRotasNfse(r: Router): void {
  r.get("/nfse", listar, { papeis: FINANCEIRO });
  r.post("/nfse/emitir/:id", emitir, { papeis: FINANCEIRO });
}
