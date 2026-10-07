-- Imutabilidade imposta pelo próprio banco: prontuário, documentos clínicos e trilha de
-- auditoria aceitam INSERT, mas recusam UPDATE e DELETE (mesmo que o código do app tenha
-- um bug ou alguém acesse o banco por fora). O executor de migrações (scripts/migrar.ts)
-- envia o arquivo inteiro de uma vez; funções PL/pgSQL usam $$ ... $$.

CREATE FUNCTION recusar_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% é imutável/append-only: % não permitido', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prontuario_entrada_sem_update BEFORE UPDATE ON prontuario_entrada
  FOR EACH ROW EXECUTE FUNCTION recusar_alteracao();
CREATE TRIGGER prontuario_entrada_sem_delete BEFORE DELETE ON prontuario_entrada
  FOR EACH ROW EXECUTE FUNCTION recusar_alteracao();
CREATE TRIGGER documento_clinico_sem_update BEFORE UPDATE ON documento_clinico
  FOR EACH ROW EXECUTE FUNCTION recusar_alteracao();
CREATE TRIGGER documento_clinico_sem_delete BEFORE DELETE ON documento_clinico
  FOR EACH ROW EXECUTE FUNCTION recusar_alteracao();
CREATE TRIGGER log_auditoria_sem_update BEFORE UPDATE ON log_auditoria
  FOR EACH ROW EXECUTE FUNCTION recusar_alteracao();
CREATE TRIGGER log_auditoria_sem_delete BEFORE DELETE ON log_auditoria
  FOR EACH ROW EXECUTE FUNCTION recusar_alteracao();

-- TRUNCATE também apagaria tudo sem passar pelos gatilhos de linha.
CREATE TRIGGER prontuario_entrada_sem_truncate BEFORE TRUNCATE ON prontuario_entrada
  FOR EACH STATEMENT EXECUTE FUNCTION recusar_alteracao();
CREATE TRIGGER documento_clinico_sem_truncate BEFORE TRUNCATE ON documento_clinico
  FOR EACH STATEMENT EXECUTE FUNCTION recusar_alteracao();
CREATE TRIGGER log_auditoria_sem_truncate BEFORE TRUNCATE ON log_auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION recusar_alteracao();
