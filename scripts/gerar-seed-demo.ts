/**
 * Gera seed-demo.sql com dados FICTÍCIOS de demonstração (3 usuários, 3 pacientes,
 * sessões, lançamentos e um instrumento de rastreio de exemplo).
 *
 *   PASSWORD_PEPPER=<o mesmo valor do Worker> npx tsx scripts/gerar-seed-demo.ts
 *   DATABASE_URL=... npx tsx scripts/executar-sql.ts seed-demo.sql   # SOMENTE desenvolvimento/demonstração
 *
 * O instrumento "EABS-DEMO" é FICTÍCIO (não é PHQ-9, GAD-7 nem escala validada).
 * Escalas reais devem ser cadastradas a partir da fonte oficial, citando-a.
 * Senha dos usuários de demonstração: 123456.
 */
import { hashSenha } from "../src/crypto.ts";
import { agoraUtc } from "../src/util.ts";

const q = (v: string | number | null): string =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

function linha(tabela: string, colunas: Record<string, string | number | null>): string {
  return `INSERT INTO ${tabela} (${Object.keys(colunas).join(", ")}) VALUES (${Object.values(colunas).map(q).join(", ")});`;
}

const FUSO = "America/Sao_Paulo";

/** "YYYY-MM-DDTHH:MM" no horário de Brasília, `dias` dias antes de `base`. */
function localIso(base: Date, dias: number): string {
  const d = new Date(base.getTime() - dias * 86_400_000);
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

export async function gerarSeedSql(pepper: string, agora: Date = new Date()): Promise<string> {
  const ts = agoraUtc(agora);
  const sql: string[] = ["-- Dados fictícios de demonstração do Sipsi (gerado por scripts/gerar-seed-demo.ts)"];

  sql.push(linha("psicologo", { id: 1, nome: "Dra. Carla Menezes", crp: "06/123456", email: "carla@clinica.com", ativo: 1 }));

  const senha = await hashSenha("123456", pepper);
  const usuarios: [number, string, string, string, number | null][] = [
    [1, "Admin da Clínica", "admin@clinica.com", "admin", null],
    [2, "Ana (Recepção)", "recepcao@clinica.com", "recepcao", null],
    [3, "Dra. Carla Menezes", "carla@clinica.com", "psicologo", 1],
  ];
  for (const [id, nome, email, papel, psicologo_id] of usuarios) {
    sql.push(linha("usuario", { id, nome, email, senha_hash: senha, papel, ativo: 1, psicologo_id, criado_em: ts }));
  }

  // CPFs fictícios com dígitos verificadores válidos.
  const pacientes: [number, string, string, string, string, string][] = [
    [1, "João Pereira", "529.982.247-25", "joao@email.com", "(11) 90000-0001", "1990-05-12"],
    [2, "Maria Santos", "111.444.777-35", "maria@email.com", "(11) 90000-0002", "1985-08-30"],
    [3, "Pedro Lima", "123.456.789-09", "pedro@email.com", "(11) 90000-0003", "1998-01-20"],
  ];
  for (const [id, nome, cpf, email, telefone, data_nascimento] of pacientes) {
    sql.push(linha("paciente", { id, nome, cpf, email, telefone, data_nascimento, ativo: 1, criado_em: ts }));
  }

  // [id, paciente, dias atrás (negativo = futuro), valor em centavos, status]
  const sessoes: [number, number, number, number, string][] = [
    [1, 1, 14, 15000, "realizada"],
    [2, 1, 7, 15000, "realizada"],
    [3, 2, 3, 18000, "realizada"],
    [4, 2, 10, 18000, "falta"],
    [5, 3, -2, 15000, "agendada"],
  ];
  for (const [id, paciente_id, dias, valor_centavos, status] of sessoes) {
    sql.push(linha("sessao", { id, paciente_id, psicologo_id: 1, data_hora: localIso(agora, dias), duracao_min: 50, valor_centavos, status, criado_em: ts }));
  }
  // Lançamentos das sessões realizadas (pago se tiver mais de 10 dias).
  let idLanc = 1;
  for (const [id, paciente_id, dias, valor_centavos, status] of sessoes) {
    if (status !== "realizada") continue;
    const pago = dias > 10;
    const data = localIso(agora, dias).slice(0, 10);
    sql.push(linha("lancamento_financeiro", {
      id: idLanc++, sessao_id: id, paciente_id, valor_centavos, status: pago ? "pago" : "pendente",
      forma_pagamento: pago ? "pix" : null, data_vencimento: data, data_pagamento: pago ? data : null, criado_em: ts,
    }));
  }

  sql.push(linha("instrumento", {
    id: 1, nome: "Escala de Autopercepção de Bem-Estar Semanal (exemplo demonstrativo)", sigla: "EABS-DEMO",
    fonte_citacao: "Instrumento fictício criado para fins de demonstração do MVP acadêmico.", ativo: 1,
  }));
  const perguntas = [
    "Nas últimas duas semanas, com que frequência você se sentiu motivado(a) com suas atividades diárias?",
    "Nas últimas duas semanas, com que frequência você teve dificuldade para dormir?",
    "Nas últimas duas semanas, com que frequência você se sentiu ansioso(a) ou tenso(a)?",
  ];
  const opcoes: [string, number][] = [["Nunca", 0], ["Raramente", 1], ["Às vezes", 2], ["Frequentemente", 3]];
  let idOpcao = 1;
  perguntas.forEach((texto, i) => {
    const idPergunta = i + 1;
    sql.push(linha("pergunta_instrumento", { id: idPergunta, instrumento_id: 1, ordem: idPergunta, texto }));
    opcoes.forEach(([t, v], j) => sql.push(linha("opcao_resposta", { id: idOpcao++, pergunta_id: idPergunta, texto: t, valor_numerico: v, ordem: j })));
  });
  const regras: [number, number, string, string][] = [
    [0, 2, "Sem indícios relevantes de sofrimento", "normal"],
    [3, 5, "Sinais leves — acompanhar na próxima sessão", "atencao"],
    [6, 8, "Sinais moderados — atenção recomendada", "alerta"],
    [9, 9, "Sinais importantes — atenção prioritária", "critico"],
  ];
  regras.forEach(([faixa_min, faixa_max, interpretacao, nivel_alerta], i) =>
    sql.push(linha("regra_pontuacao", { id: i + 1, instrumento_id: 1, faixa_min, faixa_max, interpretacao, nivel_alerta })),
  );
  // Os INSERTs acima usam ids explícitos: alinha as sequências do Postgres para os próximos ids.
  for (const t of ["psicologo", "usuario", "paciente", "sessao", "lancamento_financeiro", "instrumento", "pergunta_instrumento", "opcao_resposta", "regra_pontuacao"]) {
    sql.push(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1), (SELECT COUNT(*) > 0 FROM ${t}));`);
  }
  return sql.join("\n") + "\n";
}

// Execução direta (npx tsx scripts/gerar-seed-demo.ts)
const direto = typeof process !== "undefined" && process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "§");
if (direto) {
  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper) {
    console.error("Defina PASSWORD_PEPPER (o mesmo valor do segredo do Worker). Ex.: PASSWORD_PEPPER=xxxx npx tsx scripts/gerar-seed-demo.ts");
    process.exit(1);
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync("seed-demo.sql", await gerarSeedSql(pepper));
  console.log("Gerado: seed-demo.sql  (usuários: admin@clinica.com, recepcao@clinica.com, carla@clinica.com | senha: 123456)");
}
