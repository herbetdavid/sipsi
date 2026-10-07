# Como publicar este projeto no GitHub (sem instalar nada)

1. Crie uma conta em github.com (ative a verificação em duas etapas).
2. Clique em **New repository**. Nome: `sipsi`. Marque **Private**. Não marque "Add a README". Clique em **Create repository**.
3. Na página do repositório vazio, clique no link **uploading an existing file**.
4. Abra a pasta onde você extraiu o zip e **selecione tudo que está dentro dela** (as pastas `.github`, `instalador`, `migrations`, `scripts`, `src`, `test` e os arquivos soltos). Arraste para a página do GitHub. Não envie o próprio arquivo .zip.
   - O projeto tem pouco mais de 50 arquivos, abaixo do limite de 100 por envio do navegador.
   - Se a pasta `.github` não aparecer para arrastar, ative "Itens ocultos" no Explorador de Arquivos (aba Exibir).
5. Espere terminar e clique em **Commit changes**.
6. Abra a aba **Actions**. Se houver um botão para habilitar, clique. A cada envio, o fluxo **Testes** roda sozinho; ele deve ficar verde.

## Gerar o instalador do Windows
Aba **Actions → Instaladores → Run workflow**. Ao terminar, baixe o arquivo em **Artifacts → instalador-windows**.

## Publicar o site online pela Cloudflare (sem Node no seu computador)
1. No painel da Cloudflare: **Workers & Pages → Create → Import a repository** (ou "Connect to Git") e autorize o GitHub.
2. Escolha o repositório `sipsi`. Mantenha o comando de deploy padrão (`npx wrangler deploy`).
3. Depois de criado, abra o Worker → **Settings → Variables and Secrets** e adicione como **Secret**:
   - `DATABASE_URL` — a string de conexão do Neon (região São Paulo, conexão direta);
   - `PASSWORD_PEPPER` — texto longo e aleatório, guardado no seu gerenciador de senhas.
4. Crie as tabelas no Neon pelo **SQL Editor**, com `migrations/0001_init.sql` e depois `migrations/0002_imutabilidade.sql`.
5. Cadastre também o segredo `SETUP_TOKEN` (código seu, 20 caracteres ou mais) e publique. Abra `https://SEU-WORKER.workers.dev/primeiro-acesso`,
   informe o código, o nome, o e-mail e a senha do administrador. A página só funciona enquanto **não existir nenhum usuário**;
   depois de criar o administrador, **remova o segredo `SETUP_TOKEN`**.

> A Cloudflare muda os nomes dos menus com frequência; se algo não estiver igual, siga a documentação atual dela.

## Cuidados
- Mantenha o repositório **privado**.
- **Nunca** envie `.dev.vars`, strings de conexão, senhas, arquivos `seed-demo.sql` ou `usuario-novo.sql`. O `.gitignore` já bloqueia os principais, mas confira antes de enviar.
- Este projeto não tem licença definida de propósito: em repositório privado, todos os direitos ficam reservados. Resolva a questão de propriedade intelectual com a universidade antes de escolher uma licença ou de tornar o código público.
