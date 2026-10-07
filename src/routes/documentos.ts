import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { HttpError } from "../ctx.ts";
import { html, type Seguro } from "../html.ts";
import { registrarLog } from "../audit.ts";
import { CLINICO } from "../rbac.ts";
import { psicologosPermitidos } from "../psicologos.ts";
import { dataIsoValida, fmtDataHoraUtc, horaValida, hojeLocal, inteiro } from "../util.ts";
import { gerarPdf, type CamposAtestado, type CamposDeclaracao, type CamposRelatorio, type Snapshot, type TipoDocumento } from "../pdf.ts";

const ROTULOS: Record<TipoDocumento, string> = {
  declaracao: "Declaração de comparecimento",
  atestado: "Atestado psicológico",
  relatorio_psicologico: "Relatório psicológico",
};

type Campos = CamposDeclaracao | CamposAtestado | CamposRelatorio;

async function paciente(c: Ctx, id: number): Promise<{ id: number; nome: string; cpf: string | null; data_nascimento: string | null }> {
  const p = await c.db
    .prepare("SELECT id, nome, cpf, data_nascimento FROM paciente WHERE id = ?")
    .bind(id)
    .first<{ id: number; nome: string; cpf: string | null; data_nascimento: string | null }>();
  if (!p) throw new HttpError(404, "Paciente não encontrado.");
  return p;
}

async function listar(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const p = await paciente(c, id);
  const { results } = await c.db
    .prepare(
      `SELECT d.id, d.tipo, d.criado_em, ps.nome AS psicologo_nome
         FROM documento_clinico d JOIN psicologo ps ON ps.id = d.psicologo_id
        WHERE d.paciente_id = ? ORDER BY d.criado_em DESC, d.id DESC`,
    )
    .bind(id)
    .all<{ id: number; tipo: TipoDocumento; criado_em: string; psicologo_nome: string }>();
  await registrarLog(c, "visualizar", "DocumentoClinico", null, id, "listagem de documentos clínicos");

  return c.pagina(
    `Documentos - ${p.nome}`,
    html`<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
  <h2>Documentos clínicos — ${p.nome}</h2>
  <div class="d-flex gap-2 flex-wrap">
    <a href="/documentos/paciente/${id}/declaracao" class="btn btn-outline-primary btn-sm">+ Declaração</a>
    <a href="/documentos/paciente/${id}/atestado" class="btn btn-outline-primary btn-sm">+ Atestado</a>
    <a href="/documentos/paciente/${id}/relatorio" class="btn btn-outline-primary btn-sm">+ Relatório</a>
  </div>
</div>
<table class="table table-bordered bg-white">
  <thead><tr><th>Tipo</th><th>Psicólogo</th><th>Emitido em</th><th></th></tr></thead>
  <tbody>
    ${results.length
      ? results.map(
          (d) => html`<tr><td>${ROTULOS[d.tipo] ?? d.tipo}</td><td>${d.psicologo_nome}</td><td>${fmtDataHoraUtc(d.criado_em)}</td>
        <td><a href="/documentos/baixar/${d.id}" target="_blank" rel="noopener">Abrir PDF</a></td></tr>`,
        )
      : html`<tr><td colspan="4" class="text-muted">Nenhum documento emitido.</td></tr>`}
  </tbody>
</table>`,
  );
}

// ------------------------------------------------------------------ formulários
async function selecaoPsicologo(c: Ctx, escolhido: string): Promise<Seguro> {
  const psicologos = await psicologosPermitidos(c);
  return html`<div class="mb-3"><label class="form-label">Psicólogo responsável</label>
  <select name="psicologo_id" class="form-select" required>
    ${psicologos.map((p) => html`<option value="${p.id}" ${String(p.id) === escolhido ? "selected" : ""}>${p.nome}</option>`)}
  </select></div>`;
}

type Definicao = {
  titulo: string;
  largura: number;
  corpo: (v: Record<string, string>) => Seguro;
};

const FORMS: Record<TipoDocumento, Definicao> = {
  declaracao: {
    titulo: "Declaração de comparecimento",
    largura: 500,
    corpo: (v) => html`<div class="mb-3"><label class="form-label">Data do atendimento</label>
      <input type="date" name="data_atendimento" class="form-control" required value="${v.data_atendimento ?? ""}"></div>
    <div class="row">
      <div class="col mb-3"><label class="form-label">Horário início</label>
        <input type="time" name="horario_inicio" class="form-control" required value="${v.horario_inicio ?? ""}"></div>
      <div class="col mb-3"><label class="form-label">Horário fim</label>
        <input type="time" name="horario_fim" class="form-control" required value="${v.horario_fim ?? ""}"></div>
    </div>`,
  },
  atestado: {
    titulo: "Atestado psicológico",
    largura: 500,
    corpo: (v) => html`<div class="mb-3"><label class="form-label">Dias de afastamento</label>
      <input type="number" name="dias_afastamento" class="form-control" min="1" max="365" required value="${v.dias_afastamento ?? ""}"></div>
    <div class="mb-3"><label class="form-label">CID (opcional)</label>
      <input name="cid" class="form-control" maxlength="10" placeholder="Ex: F41.1" value="${v.cid ?? ""}"></div>`,
  },
  relatorio_psicologico: {
    titulo: "Relatório psicológico",
    largura: 700,
    corpo: (v) => {
      const area = (nome: string, rotulo: string, linhas: number) => html`<div class="mb-3"><label class="form-label">${rotulo}</label>
        <textarea name="${nome}" class="form-control" rows="${linhas}" required maxlength="8000">${v[nome] ?? ""}</textarea></div>`;
      return html`${area("motivo", "1. Motivo / demanda", 3)}${area("procedimentos", "2. Procedimentos utilizados", 3)}${area("analise", "3. Análise", 4)}${area("conclusao", "4. Conclusão", 3)}`;
    },
  },
};

const ROTA_DO_TIPO: Record<TipoDocumento, string> = {
  declaracao: "declaracao",
  atestado: "atestado",
  relatorio_psicologico: "relatorio",
};

async function renderForm(c: Ctx, tipo: TipoDocumento, v: Record<string, string>, erro: string | null, status = 200): Promise<Response> {
  if (erro) c.flash = { tipo: "danger", msg: erro };
  const id = c.idParam("id");
  const p = await paciente(c, id);
  const def = FORMS[tipo];
  return c.pagina(
    def.titulo,
    html`<h2>${def.titulo} — ${p.nome}</h2>
<form method="post" action="/documentos/paciente/${id}/${ROTA_DO_TIPO[tipo]}" class="bg-white p-4 rounded shadow-sm" style="max-width:${def.largura}px">
  <input type="hidden" name="_csrf" value="${c.csrf}">
  ${await selecaoPsicologo(c, v.psicologo_id ?? "")}
  ${def.corpo(v)}
  <button class="btn btn-primary">Gerar PDF</button>
</form>`,
    status,
  );
}

async function lerCampos(c: Ctx, tipo: TipoDocumento): Promise<{ valores: Record<string, string>; campos: Campos | null; erros: string[] }> {
  const nomes: Record<TipoDocumento, string[]> = {
    declaracao: ["data_atendimento", "horario_inicio", "horario_fim"],
    atestado: ["dias_afastamento", "cid"],
    relatorio_psicologico: ["motivo", "procedimentos", "analise", "conclusao"],
  };
  const valores: Record<string, string> = { psicologo_id: await c.campo("psicologo_id") };
  for (const n of nomes[tipo]) valores[n] = await c.campo(n);
  const erros: string[] = [];
  let campos: Campos | null = null;

  if (tipo === "declaracao") {
    if (!dataIsoValida(valores.data_atendimento ?? "")) erros.push("Data do atendimento inválida.");
    if (!horaValida(valores.horario_inicio ?? "") || !horaValida(valores.horario_fim ?? "")) erros.push("Horários inválidos.");
    else if ((valores.horario_fim ?? "") <= (valores.horario_inicio ?? "")) erros.push("O horário final deve ser depois do inicial.");
    campos = { data_atendimento: valores.data_atendimento ?? "", horario_inicio: valores.horario_inicio ?? "", horario_fim: valores.horario_fim ?? "" };
  } else if (tipo === "atestado") {
    const dias = inteiro(valores.dias_afastamento);
    if (!dias || dias > 365) erros.push("Informe de 1 a 365 dias de afastamento.");
    if (valores.cid && !/^[A-Za-z0-9.\-]{1,10}$/.test(valores.cid)) erros.push("CID inválido.");
    campos = { dias_afastamento: dias ?? 0, cid: valores.cid || null };
  } else {
    for (const n of nomes[tipo]) {
      const t = valores[n] ?? "";
      if (!t || t.length > 8000) erros.push("Preencha todas as seções (até 8.000 caracteres cada).");
    }
    campos = {
      motivo: valores.motivo ?? "",
      procedimentos: valores.procedimentos ?? "",
      analise: valores.analise ?? "",
      conclusao: valores.conclusao ?? "",
    };
  }
  return { valores, campos, erros: [...new Set(erros)] };
}

async function emitir(c: Ctx, tipo: TipoDocumento): Promise<Response> {
  const id = c.idParam("id");
  const p = await paciente(c, id);
  const { valores, campos, erros } = await lerCampos(c, tipo);

  const psicologoId = inteiro(valores.psicologo_id);
  const permitidos = await psicologosPermitidos(c);
  if (!psicologoId || !permitidos.some((x) => x.id === psicologoId)) erros.push("Psicólogo inválido para o seu perfil.");
  if (erros.length || !campos) return renderForm(c, tipo, valores, erros.join(" "), 400);

  const psi = await c.db.prepare("SELECT nome, crp FROM psicologo WHERE id = ?").bind(psicologoId!).first<{ nome: string; crp: string }>();
  if (!psi) throw new HttpError(400, "Psicólogo não encontrado.");

  const snapshot: Snapshot = {
    paciente_nome: p.nome,
    paciente_cpf: p.cpf,
    paciente_nascimento: p.data_nascimento,
    psicologo_nome: psi.nome,
    psicologo_crp: psi.crp,
    data_emissao: hojeLocal(),
  };
  const nomeArquivo = `${tipo}_${p.id}_${Math.floor(Date.now() / 1000)}.pdf`;
  const r = await c.db
    .prepare("INSERT INTO documento_clinico (paciente_id, psicologo_id, tipo, conteudo_json, arquivo_pdf, criado_em) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(p.id, psicologoId!, tipo, JSON.stringify({ campos, snapshot }), nomeArquivo, c.agora)
    .first<{ id: number }>();
  await registrarLog(c, "criar", "DocumentoClinico", r!.id, p.id, ROTULOS[tipo].toLowerCase());
  return c.redirecionar(`/documentos/baixar/${r!.id}`);
}

async function baixar(c: Ctx): Promise<Response> {
  const id = c.idParam("id");
  const d = await c.db
    .prepare("SELECT id, paciente_id, tipo, conteudo_json, arquivo_pdf FROM documento_clinico WHERE id = ?")
    .bind(id)
    .first<{ id: number; paciente_id: number; tipo: TipoDocumento; conteudo_json: string; arquivo_pdf: string | null }>();
  if (!d) throw new HttpError(404, "Documento não encontrado.");

  let dados: { campos: Campos; snapshot: Snapshot };
  try {
    dados = JSON.parse(d.conteudo_json) as { campos: Campos; snapshot: Snapshot };
  } catch {
    throw new HttpError(500, "Registro do documento corrompido.");
  }
  const pdf = await gerarPdf(d.tipo, dados.snapshot, dados.campos);
  await registrarLog(c, "visualizar", "DocumentoClinico", d.id, d.paciente_id, `download do PDF - tipo ${d.tipo}`);

  const nome = (d.arquivo_pdf ?? `documento_${d.id}.pdf`).replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${nome}"` },
  });
}

export function registrarRotasDocumentos(r: Router): void {
  r.get("/documentos/paciente/:id", listar, { papeis: CLINICO });
  for (const tipo of Object.keys(FORMS) as TipoDocumento[]) {
    const caminho = `/documentos/paciente/:id/${ROTA_DO_TIPO[tipo]}`;
    r.get(caminho, (c) => renderForm(c, tipo, {}, null), { papeis: CLINICO });
    r.post(caminho, (c) => emitir(c, tipo), { papeis: CLINICO });
  }
  r.get("/documentos/baixar/:id", baixar, { papeis: CLINICO });
}
