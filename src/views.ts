// Layout e componentes visuais compartilhados (mesmo visual Bootstrap do MVP).
import type { Ctx } from "./ctx.ts";
import { html, type Seguro } from "./html.ts";

export function campoCsrf(c: Ctx): Seguro {
  return html`<input type="hidden" name="_csrf" value="${c.csrf}">`;
}

export function badge(classe: string, texto: string): Seguro {
  return html`<span class="badge ${classe}">${texto}</span>`;
}

export function badgeSessao(status: string): Seguro {
  const classe =
    status === "realizada" ? "bg-success" : status === "falta" ? "bg-danger" : status === "cancelada" ? "bg-secondary" : "bg-warning text-dark";
  return badge(classe, status);
}

export function badgeNivel(nivel: string): Seguro {
  const classe =
    nivel === "critico" ? "bg-danger" : nivel === "alerta" ? "bg-warning text-dark" : nivel === "atencao" ? "bg-info text-dark" : "bg-success";
  return badge(classe, nivel);
}

/** Formulário POST que já inclui o token CSRF. */
export function formPost(c: Ctx, acao: string, classe: string, filhos: Seguro): Seguro {
  return html`<form method="post" action="${acao}" class="${classe}">${campoCsrf(c)}${filhos}</form>`;
}

function navbar(c: Ctx): Seguro {
  const u = c.user;
  if (!u) {
    return html`<nav class="navbar navbar-dark bg-dark mb-4"><div class="container"><a class="navbar-brand" href="/">Sipsi</a></div></nav>`;
  }
  const financeiro = u.papel === "admin" || u.papel === "recepcao";
  return html`<nav class="navbar navbar-expand-lg navbar-dark bg-dark mb-4">
    <div class="container">
      <a class="navbar-brand" href="/">Sipsi</a>
      <div class="navbar-nav flex-row flex-wrap gap-3">
        <a class="nav-link" href="/pacientes">Pacientes</a>
        <a class="nav-link" href="/agenda">Agenda</a>
        ${financeiro ? html`<a class="nav-link" href="/financeiro">Financeiro</a><a class="nav-link" href="/nfse">NFS-e</a>` : ""}
        <a class="nav-link" href="/questionarios">Questionários</a>
        <a class="nav-link" href="/relatorios/faturamento">Relatórios</a>
        ${u.papel === "admin" ? html`<a class="nav-link" href="/auditoria">Auditoria</a>` : ""}
      </div>
      <div class="navbar-nav flex-row gap-2 ms-auto align-items-center">
        <span class="nav-link text-muted small">${u.nome} (${u.papel})</span>
        <form method="post" action="/auth/logout" class="d-inline">${campoCsrf(c)}<button class="btn btn-link nav-link">Sair</button></form>
      </div>
    </div>
  </nav>`;
}

export function layout(c: Ctx, titulo: string, conteudo: Seguro): Seguro {
  const f = c.flash;
  return html`<html lang="pt-br">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${titulo} · Sipsi</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="bg-light">
  ${navbar(c)}
  <div class="container pb-5">
    ${f ? html`<div class="alert alert-${f.tipo}">${f.msg}</div>` : ""}
    ${conteudo}
  </div>
</body>
</html>`;
}

export function paginaErroSimples(status: number, mensagem: string): Response {
  const corpo = `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Erro ${status} · Sipsi</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"></head><body class="bg-light"><div class="container py-5" style="max-width:600px"><h1 class="h3">Erro ${status}</h1><p>${mensagem.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)}</p><a href="/">Voltar ao início</a></div></body></html>`;
  return new Response(corpo, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
