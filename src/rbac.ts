import type { Papel } from "./auth.ts";
export type { Papel };

/** Papéis com acesso a cada área (espelha as regras do MVP original). */
export const CLINICO: Papel[] = ["admin", "psicologo"];
export const FINANCEIRO: Papel[] = ["admin", "recepcao"];
export const SOMENTE_ADMIN: Papel[] = ["admin"];
