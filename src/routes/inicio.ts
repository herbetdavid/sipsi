import type { Router } from "../router.ts";
import type { Ctx } from "../ctx.ts";
import { html } from "../html.ts";

async function inicio(c: Ctx): Promise<Response> {
  return c.pagina(
    "Início",
    html`<h1 class="mb-4">Sipsi</h1>
<p class="text-muted">Gestão clínica e administrativa para consultórios de psicologia.</p>
<div class="row g-3 mt-3">
  <div class="col-md-4"><div class="card h-100"><div class="card-body">
    <h5 class="card-title">Pacientes &amp; Agenda</h5>
    <p class="card-text">Cadastro de pacientes e agendamento de sessões.</p>
    <a href="/pacientes" class="btn btn-primary btn-sm">Pacientes</a>
    <a href="/agenda" class="btn btn-outline-primary btn-sm">Agenda</a>
  </div></div></div>
  <div class="col-md-4"><div class="card h-100"><div class="card-body">
    <h5 class="card-title">Financeiro</h5>
    <p class="card-text">Lançamentos gerados automaticamente ao concluir sessões.</p>
    <a href="/financeiro" class="btn btn-primary btn-sm">Ver lançamentos</a>
  </div></div></div>
  <div class="col-md-4"><div class="card h-100"><div class="card-body">
    <h5 class="card-title">Questionários de Rastreio</h5>
    <p class="card-text">Motor genérico orientado a dados (sem código por escala).</p>
    <a href="/questionarios" class="btn btn-primary btn-sm">Instrumentos</a>
  </div></div></div>
  <div class="col-md-4"><div class="card h-100"><div class="card-body">
    <h5 class="card-title">Relatórios</h5>
    <p class="card-text">Faturamento, taxa de faltas e livro caixa (contador).</p>
    <a href="/relatorios/faturamento" class="btn btn-primary btn-sm">Faturamento</a>
    <a href="/relatorios/faltas" class="btn btn-outline-primary btn-sm">Faltas</a>
  </div></div></div>
</div>`,
  );
}

export function registrarRotasInicio(r: Router): void {
  r.get("/", inicio);
}
