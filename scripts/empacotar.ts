/**
 * Monta o pacote "pronto para usar" do modo local, para o sistema em que for executado:
 * runtime do Node embutido + app + dependências de produção + atalho de inicialização.
 * O usuário final NÃO precisa instalar o Node.
 *
 *   npm run empacotar        -> dist/sipsi-<win|mac|linux>-<arch>/
 *
 * O pacote do Windows é transformado em instalador (.exe) por instalador/sipsi.iss (Inno Setup).
 */
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const [maior, menor] = process.versions.node.split(".").map(Number) as [number, number];
if (maior < 22 || (maior === 22 && menor < 18)) {
  console.error(`Use Node 22.18 ou mais novo para empacotar (o pacote leva este mesmo Node). Atual: ${process.versions.node}`);
  process.exit(1);
}

const raiz = fileURLToPath(new URL("../", import.meta.url));
const versao: string = JSON.parse(readFileSync(join(raiz, "package.json"), "utf8")).version;
const plat = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const nome = `sipsi-${plat}-${process.arch}`;
const destino = join(raiz, "dist", nome);

rmSync(destino, { recursive: true, force: true });
mkdirSync(join(destino, "runtime"), { recursive: true });
mkdirSync(join(destino, "app"), { recursive: true });

copyFileSync(process.execPath, join(destino, "runtime", plat === "win" ? "node.exe" : "node"));
cpSync(join(raiz, "src"), join(destino, "app", "src"), { recursive: true });
cpSync(join(raiz, "migrations"), join(destino, "app", "migrations"), { recursive: true });
for (const f of ["package.json", "package-lock.json"]) copyFileSync(join(raiz, f), join(destino, "app", f));
execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: join(destino, "app"), stdio: "inherit", shell: plat === "win" });

const LEIA = `SIPSI ${versao} - modo local

Para abrir: dê dois cliques em "${plat === "win" ? "Iniciar Sipsi.bat" : plat === "mac" ? "Iniciar Sipsi.command" : "iniciar-sipsi.sh"}".
Na primeira vez, a janela pede o nome, o e-mail e a senha do administrador. Depois, o navegador abre sozinho.
Mantenha a janela aberta enquanto usa o Sipsi; fechar a janela encerra o sistema.

Onde ficam os seus dados (NÃO apague; faça backup):
  ${plat === "win" ? "%LOCALAPPDATA%\\Sipsi\\dados" : plat === "mac" ? "~/Library/Application Support/Sipsi/dados" : "~/.local/share/Sipsi/dados"}
O arquivo "segredo-sipsi.txt", na pasta acima, é indispensável para entrar: guarde uma cópia SEPARADA dos dados.
Atualizar o programa não apaga os dados. Desinstalar também não.
`;
writeFileSync(join(destino, "LEIA-ME.txt"), LEIA);

const EXEC = `--disable-warning=ExperimentalWarning app/src/local/iniciar.ts`;
if (plat === "win") {
  const bat = [
    "@echo off",
    "chcp 65001 >nul",
    "title Sipsi",
    'cd /d "%~dp0"',
    'if not defined SIPSI_DADOS set "SIPSI_DADOS=%LOCALAPPDATA%\\Sipsi\\dados"',
    'if not defined SIPSI_PEPPER_ARQUIVO set "SIPSI_PEPPER_ARQUIVO=%LOCALAPPDATA%\\Sipsi\\segredo-sipsi.txt"',
    'if not exist "%LOCALAPPDATA%\\Sipsi" mkdir "%LOCALAPPDATA%\\Sipsi"',
    "set SIPSI_ABRIR_NAVEGADOR=1",
    `"runtime\\node.exe" ${EXEC.replace(/\//g, "\\")}`,
    "echo.",
    "echo O Sipsi foi encerrado. Pressione uma tecla para fechar.",
    "pause >nul",
    "",
  ].join("\r\n");
  writeFileSync(join(destino, "Iniciar Sipsi.bat"), bat);
} else {
  const base = plat === "mac" ? '"$HOME/Library/Application Support/Sipsi"' : '"${XDG_DATA_HOME:-$HOME/.local/share}/Sipsi"';
  const sh = `#!/bin/bash
cd "$(dirname "$0")" || exit 1
BASE=${base}
mkdir -p "$BASE"
export SIPSI_DADOS="\${SIPSI_DADOS:-$BASE/dados}"
export SIPSI_PEPPER_ARQUIVO="\${SIPSI_PEPPER_ARQUIVO:-$BASE/segredo-sipsi.txt}"
export SIPSI_ABRIR_NAVEGADOR=1
./runtime/node ${EXEC}
echo
read -r -p "O Sipsi foi encerrado. Pressione Enter para fechar." _
`;
  const arq = join(destino, plat === "mac" ? "Iniciar Sipsi.command" : "iniciar-sipsi.sh");
  writeFileSync(arq, sh);
  chmodSync(arq, 0o755);
  chmodSync(join(destino, "runtime", "node"), 0o755);
}
console.log(`Pacote pronto: dist/${nome}  (Sipsi ${versao})`);
