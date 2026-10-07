; Instalador do Sipsi (modo local) para Windows - compilado com Inno Setup 6.
; Uso (no Windows, após `npm run empacotar`):  iscc /DVersao=0.2.0 instalador\sipsi.iss
#ifndef Versao
  #define Versao "0.0.0"
#endif

[Setup]
AppId={{6B0F3A52-5C1E-4C57-9A7B-5195F1A0E0A1}
AppName=Sipsi
AppVersion={#Versao}
AppPublisher=Sipsi
DefaultDirName={autopf}\Sipsi
DefaultGroupName=Sipsi
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
OutputDir=..\dist
OutputBaseFilename=Sipsi-Instalador-{#Versao}
UninstallDisplayName=Sipsi

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar um atalho na área de trabalho"; GroupDescription: "Atalhos:"

[Files]
Source: "..\dist\sipsi-win-x64\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Sipsi"; Filename: "{app}\Iniciar Sipsi.bat"; WorkingDir: "{app}"
Name: "{group}\Leia-me"; Filename: "{app}\LEIA-ME.txt"
Name: "{autodesktop}\Sipsi"; Filename: "{app}\Iniciar Sipsi.bat"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Iniciar Sipsi.bat"; WorkingDir: "{app}"; Description: "Abrir o Sipsi agora"; Flags: postinstall nowait skipifsilent

; Os dados ficam em %LOCALAPPDATA%\Sipsi, FORA da pasta do programa: atualizar ou desinstalar não os apaga.
