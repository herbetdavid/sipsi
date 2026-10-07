# Sipsi — Cloudflare Workers + Neon (PostgreSQL, São Paulo) ou instalação local

Gestão clínica e administrativa para consultórios de psicologia (pacientes, agenda, prontuário,
financeiro, NFS-e, questionários de rastreio, documentos clínicos em PDF e auditoria LGPD).
Worker em TypeScript + **Neon** (PostgreSQL serverless) + PDFs com **pdf-lib**.

## Arquitetura

```
src/index.ts        entrada do Worker: sessão, CSRF, RBAC, cabeçalhos de segurança, erros, pool Neon por requisição
src/router.ts       roteador mínimo (sem framework)
src/ctx.ts          contexto da requisição (banco, usuário, formulário, cookies, flash)
src/pg.ts           adaptador PostgreSQL (prepare/bind/first/all/run/batch; "?" -> $1; batch = transação)
src/neon.ts         backend Neon (@neondatabase/serverless, WebSocket, transações reais)
src/auth.ts         sessões, token CSRF, limitação de tentativas de login
src/crypto.ts       PBKDF2 + pepper, SHA-256, HMAC (Web Crypto)
src/html.ts         templates com escape automático (anti-XSS)
src/pdf.ts          declaração / atestado / relatório (CFP 06/2019) em PDF
src/nfse.ts         interface NFSeProvider + provedor simulado (ponto de troca p/ provedor real)
src/routes/*.ts     um arquivo por módulo
migrations/         0001 schema · 0002 triggers de imutabilidade (PostgreSQL)
scripts/            migrar · executar-sql · criar-usuario · gerar-seed-demo
test/               unidades + ponta a ponta sobre PostgreSQL (PGlite) + bench
```

Dependências de runtime: `pdf-lib` e `@neondatabase/serverless`.

## Duas formas de instalar (escolha do administrador)

| | **Nuvem** (Cloudflare Workers + Neon) | **Local** (no computador) |
|---|---|---|
| Quem usa | Qualquer aparelho, pelo navegador | O computador onde foi instalado (ou a rede local, com HTTPS) |
| Contas necessárias | Cloudflare e Neon | Nenhuma |
| Onde ficam os dados | Neon (escolha São Paulo) | Pasta no próprio computador |
| Backup | Histórico do Neon + backups | **Por conta do administrador** (pasta de dados + `segredo-sipsi.txt`) |
| Instalação | `npm run deploy` (manual) | Instalador `.exe` (Windows) ou pacote `.tar.gz` (Mac/Linux) |

## Modo local

**Usuário final:** instala `Sipsi-Instalador-x.y.z.exe` (Windows) — nada além disso, o Node vem embutido. Abre o atalho
"Sipsi"; na 1ª vez informa nome, e-mail e senha do administrador; o navegador abre em `http://localhost:8787`.
Dados e segredo ficam em `%LOCALAPPDATA%\Sipsi` (Mac: `~/Library/Application Support/Sipsi`; Linux: `~/.local/share/Sipsi`),
**fora** da pasta do programa: atualizar ou desinstalar não os apaga. Guarde cópia do `segredo-sipsi.txt` separada
da pasta `dados`; sem ele ninguém consegue entrar.

**Desenvolvimento:** `npm run local` (Node ≥ 22.18). Variáveis opcionais estão no topo de `src/local/iniciar.ts`
(`SIPSI_DADOS`, `PORT`, `SIPSI_HOST`, `DATABASE_URL` para usar o Neon a partir do computador, `SIPSI_PROXY`).
Por padrão só o próprio computador acessa (`127.0.0.1`). Liberar a rede (`SIPSI_HOST=0.0.0.0`) exige HTTPS na frente
(Caddy, com `SIPSI_PROXY=1`); sem isso, senhas e sessões trafegam em texto puro.

**Gerar o instalador:** o `npm run empacotar` monta `dist/sipsi-<so>-<arch>/` (Node embutido + app + dependências de
produção + atalho) para o sistema em que roda. O fluxo `.github/workflows/instaladores.yml` roda no GitHub
(Windows, macOS Intel/ARM, Linux) e gera o `.exe` (via Inno Setup, `instalador/sipsi.iss`) e os `.tar.gz`.

## Cloudflare Workers + Neon com Hyperdrive

O Hyperdrive mantém um pool de conexões perto do Neon, o que reduz a latência e o custo de abrir conexão a cada
requisição. O app escolhe sozinho: `HYPERDRIVE` (se configurado) > `DATABASE_URL` (driver serverless do Neon).

```bash
# 1. No Neon, crie um usuário só para o Hyperdrive e use a string de conexão DIRETA (sem "-pooler").
# 2. Crie a configuração com o CACHE DESLIGADO (dados de saúde; leitura logo após gravação):
npx wrangler hyperdrive create sipsi-neon --caching-disabled --connection-string="postgresql://usuario:senha@ep-xxx.sa-east-1.aws.neon.tech/sipsi?sslmode=require"
# 3. Descomente em wrangler.jsonc: "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id impresso no passo 2>" }]
npx wrangler secret put PASSWORD_PEPPER
npm run deploy
```
A flag `nodejs_compat` (necessária ao driver `pg`) já está ativada. Neste modo não é preciso o segredo `DATABASE_URL`
no Worker; ele só é usado nos scripts (`db:migrar`, `usuario:criar`).

## Banco: Neon na região de São Paulo

1. Crie um projeto no Neon escolhendo **AWS South America (São Paulo) — `aws-sa-east-1`**. A região **não pode ser
   mudada depois** em um projeto existente.
2. Copie a string de conexão (com `sslmode=require`). Use a conexão **direta** (não "pooled"/pgbouncer), porque o app
   usa transações.
3. Aplique as migrações:

```bash
DATABASE_URL='postgresql://...' npm run db:migrar
```

### Papel de banco (recomendado)
Crie um papel só para o app, sem poder de alterar o schema, e use a string de conexão dele no Worker
(use o dono do banco apenas para migrar):

```sql
CREATE ROLE sipsi_app LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO sipsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sipsi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sipsi_app;
```
Isso não impede o dono de remover triggers, mas limita o estrago de uma falha no app (não verificado no Neon real).

## Rodar localmente

Requer Node ≥ 22.18 e `npm install`.

```bash
cp .dev.vars.example .dev.vars      # preencha DATABASE_URL (use um projeto/branch de DESENVOLVIMENTO) e PASSWORD_PEPPER
DATABASE_URL=... npm run db:migrar
PASSWORD_PEPPER=<o mesmo do .dev.vars> npm run seed:gerar        # cria seed-demo.sql (dados fictícios)
DATABASE_URL=... npm run sql -- seed-demo.sql                    # SOMENTE banco de desenvolvimento
npm run dev                                                      # http://localhost:8787 (senha dos usuários demo: 123456)
```

## Publicar

```bash
npx wrangler login
npx wrangler secret put DATABASE_URL         # string de conexão do Neon (papel do app)
npx wrangler secret put PASSWORD_PEPPER      # use o MESMO valor ao rodar criar-usuario
DATABASE_URL='<conexão do dono>' npm run db:migrar

# primeiro administrador — ALTERNATIVA sem linha de comando: defina o segredo SETUP_TOKEN e abra /primeiro-acesso
# (a página só existe enquanto não houver nenhum usuário; remova o SETUP_TOKEN depois). Pela linha de comando:
# (a senha não é gravada em arquivo)
DATABASE_URL=... PASSWORD_PEPPER=... USUARIO_EMAIL=voce@clinica.com USUARIO_NOME="Seu Nome" \
USUARIO_SENHA='uma-senha-longa' npm run usuario:criar

# psicólogos (ainda não há tela de cadastro)
psql "$DATABASE_URL" -c "INSERT INTO psicologo (nome, crp) VALUES ('Nome', '06/00000')"

npm run deploy
```

> Alterar `PASSWORD_PEPPER` depois invalida todas as senhas já gravadas (é preciso recriar os usuários).
> Não rode o seed de demonstração em um banco com dados reais; ele usa a senha `123456`.

## O que foi verificado e o que não foi

Executado e passando (49 testes: `npm test`; `npm run typecheck`): unidades e **ponta a ponta pelo `fetch()` do Worker
sobre PostgreSQL real em processo (PGlite)** com as mesmas migrações: login, bloqueio por tentativas, CSRF, RBAC, XSS,
regras de negócio (Agenda → Financeiro em transação única, NFS-e, questionários), cadeia de hash do prontuário, triggers
(inclusive TRUNCATE), auditoria, PDFs. Bundle (wrangler `--dry-run`): ~296 KB comprimido.

**Verificado a mais:** o backend do Hyperdrive (`pg`) contra um servidor Postgres via socket (inserção com `RETURNING`,
números, transação com rollback); o pacote local do **Linux**, que sobe sem Node instalado, cria o administrador e
responde no navegador.

**NÃO verificado:**
- **Instalador do Windows (.exe), pacotes do macOS e o fluxo do GitHub Actions**: o script do Inno Setup e o workflow
  foram escritos, mas nunca executados. Rode o fluxo e teste em uma máquina limpa antes de distribuir. Sem assinatura
  de código, Windows e macOS exibem aviso de "aplicativo não reconhecido".
- **Hyperdrive real**: criação da configuração, binding, `nodejs_compat` e comportamento no Worker publicado.
- Conexão com o **Neon real** (driver WebSocket, `Pool` por requisição dentro do Worker, latência, `wrangler dev`/`deploy`).
- **Concorrência real.** O PGlite tem uma única conexão e serializa as requisições; os testes "simultâneos" passam, mas
  não exercitam disputas verdadeiras entre conexões. A lógica (UNIQUE, `UPDATE ... WHERE status = ...`,
  `ON CONFLICT`) é correta em PostgreSQL READ COMMITTED, porém ainda precisa de teste com várias conexões no Neon.
- Tempo de CPU no `workerd` (o `npm run bench` mede o Node *incluindo* o PostgreSQL em WASM, então superestima).
- Aparência no navegador.

## Plano gratuito: limite de CPU e login

O plano gratuito limita **10 ms de CPU por requisição**. O login (PBKDF2 100.000 iterações + pepper) mede ~16–22 ms em
Node; é a única rota que passa do limite. Opções: (a) plano pago; (b) autenticar fora do app (Cloudflare Access);
(c) aceitar estouros pontuais (meça no painel). **Não reduza as iterações só para caber no limite.**
Espera de rede com o Neon não conta como CPU.

## Concorrência no PostgreSQL

- Cada `db.batch([...])` é uma **transação** (`BEGIN … COMMIT`, `ROLLBACK` em erro).
- Regras "ler e depois escrever" continuam desenhadas para intercalação segura:
  - prontuário: `UNIQUE(paciente_id, seq)` (constraint `prontuario_entrada_paciente_seq_key`) + até 5 tentativas; 409 amigável se persistir;
  - Agenda → Financeiro: `UPDATE ... WHERE status='agendada'` e `INSERT ... SELECT ... ON CONFLICT (sessao_id) DO NOTHING` só se a sessão está "realizada";
  - pagamento: `UPDATE ... WHERE status='pendente'` (aplicado uma vez);
  - NFS-e: **reserva** do lançamento (`UNIQUE`) *antes* de chamar o provedor; reservas abandonadas (> 5 min) e notas com erro podem ser retomadas.
- Criações simples (ex.: cadastrar paciente) não têm chave natural: um duplo clique cria dois registros.

## Segurança — decisões

- Sessão por cookie `HttpOnly; SameSite=Lax; Secure`; o banco guarda só o **hash** do token; 12 h de validade; logout invalida no servidor.
- **CSRF**: POST exige mesma origem (`Sec-Fetch-Site`/`Origin`) **e** token ligado à sessão.
- **CSP restritiva** (sem scripts), `X-Frame-Options: DENY`, `nosniff`, `Cache-Control: no-store`, HSTS.
- Login: mesma resposta para e-mail inexistente e senha errada (com custo de hash equivalente), bloqueio após 5 falhas/15 min por e-mail e 30 por IP, `?next=` só aceita caminho interno.
- **Prontuário imutável e verificável**: triggers recusam UPDATE/DELETE; cada entrada inclui o hash da anterior; há tela de verificação da cadeia. O mesmo vale para documentos emitidos e a trilha de auditoria.
- PDFs gerados sob demanda a partir de um *snapshot* do momento da emissão (nada em disco; o documento não muda se o cadastro mudar).
- Dinheiro em centavos (inteiros). Datas: registros em UTC, exibidos em horário de Brasília.

### Triggers de imutabilidade (migração 0002)

Uma função PL/pgSQL (`recusar_alteracao`) é ligada a `UPDATE`, `DELETE` e `TRUNCATE` de `prontuario_entrada`,
`documento_clinico` e `log_auditoria` (9 triggers). Confira após migrar:
`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1;`. Atenção: o dono do banco (ou um superusuário) pode
remover triggers; por isso o app usa um papel de banco só com INSERT/SELECT/UPDATE nas demais tabelas — veja
"Papel de banco" abaixo — e a cadeia de hash do prontuário detecta adulteração mesmo se isso acontecer.

## Diferenças em relação ao MVP em Flask

Senhas passam de scrypt para PBKDF2 (recrie os usuários); logout e conclusão de questionário agora são POST
(antes mudavam dados via GET); o autor de uma observação é sempre o usuário logado; um psicólogo só assina
em seu próprio nome; só sessões "agendadas" mudam de status; recepção não vê atalhos para prontuário/documentos;
credenciais de demonstração só aparecem com `MODO_DEMO=1`; telas de relatório ganharam abas; auditoria registra
também questionários, login e verificações de integridade.

## Pendências antes de uso com pacientes reais

Tela de usuários/psicólogos · 2FA (ou Cloudflare Access) · multi-clínica (`clinica_id`) · política de retenção
e exclusão (LGPD × guarda de prontuário do CFP) · backups e restauração testada · Bootstrap hospedado por você
(com SRI) em vez de CDN · paginação das listagens · termo de uso/consentimento · revisão jurídica.
