import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { html } from "../html.ts";
import { SOMENTE_ADMIN } from "../rbac.ts";
import { fmtDataHoraUtc, inteiro } from "../util.ts";

interface Log {
  usuario_nome: string | null;
  acao: string;
  entidade: string;
  paciente_id: number | null;
  detalhes: string | null;
  ip_origem: string | null;
  criado_em: string;
}

async function listar(c: Ctx): Promise<Response> {
  const pacienteId = inteiro(c.consulta("paciente_id"));
  const base = `SELECT usuario_nome, acao, entidade, paciente_id, detalhes, ip_origem, criado_em FROM log_auditoria`;
  const stmt = pacienteId
    ? c.db.prepare(`${base} WHERE paciente_id = ? ORDER BY id DESC LIMIT 200`).bind(pacienteId)
    : c.db.prepare(`${base} ORDER BY id DESC LIMIT 200`);
  const { results } = await stmt.all<Log>();

  const cor = (a: string): string =>
    a === "visualizar" ? "bg-info text-dark" : a === "criar" ? "bg-success" : a === "login_falho" || a === "login_bloqueado" ? "bg-danger" : "bg-secondary";

  return c.pagina(
    "Auditoria",
    html`<h2 class="mb-3">Trilha de Auditoria (LGPD)</h2>
<p class="text-muted small">Registro de acessos a dados pessoais sensíveis. Mostrando os 200 mais recentes. O banco impede alterar ou apagar estes registros.</p>
<form method="get" action="/auditoria" class="d-flex gap-2 mb-3">
  <input type="number" name="paciente_id" min="1" placeholder="Filtrar por ID do paciente" value="${pacienteId ?? ""}" class="form-control" style="max-width:260px">
  <button class="btn btn-outline-primary">Filtrar</button>
</form>
<table class="table table-bordered bg-white table-sm">
  <thead><tr><th>Data/Hora</th><th>Usuário</th><th>Ação</th><th>Entidade</th><th>Paciente</th><th>Detalhes</th><th>IP</th></tr></thead>
  <tbody>
    ${results.length
      ? results.map(
          (l) => html`<tr><td>${fmtDataHoraUtc(l.criado_em, true)}</td><td>${l.usuario_nome}</td>
        <td><span class="badge ${cor(l.acao)}">${l.acao}</span></td><td>${l.entidade}</td><td>${l.paciente_id ?? "-"}</td>
        <td class="small">${l.detalhes ?? "-"}</td><td class="small text-muted">${l.ip_origem ?? "-"}</td></tr>`,
        )
      : html`<tr><td colspan="7" class="text-muted">Nenhum registro de auditoria ainda.</td></tr>`}
  </tbody>
</table>`,
  );
}

export function registrarRotasAuditoria(r: Router): void {
  r.get("/auditoria", listar, { papeis: SOMENTE_ADMIN });
}
