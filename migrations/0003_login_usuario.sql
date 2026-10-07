-- Login por nome de usuário; e-mail passa a ser opcional.
-- Compatibilidade: usuários existentes recebem um login derivado do e-mail.
ALTER TABLE usuario ADD COLUMN login TEXT;
DROP INDEX IF EXISTS usuario_email_unico;

DO $$
DECLARE
  r RECORD;
  base TEXT;
  candidato TEXT;
  n INTEGER;
BEGIN
  FOR r IN SELECT id, email FROM usuario ORDER BY id LOOP
    base := lower(regexp_replace(split_part(coalesce(r.email, ''), '@', 1), '[^a-zA-Z0-9._-]', '', 'g'));
    IF base = '' OR length(base) < 3 THEN
      base := 'usuario';
    END IF;
    candidato := left(base, 50);
    n := 0;
    WHILE EXISTS (SELECT 1 FROM usuario WHERE login = candidato AND id <> r.id) LOOP
      n := n + 1;
      candidato := left(base, greatest(1, 50 - length(n::text) - 1)) || '-' || n;
    END LOOP;
    UPDATE usuario SET login = candidato WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE usuario ALTER COLUMN login SET NOT NULL;
ALTER TABLE usuario ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX usuario_login_unico ON usuario (lower(login));
CREATE UNIQUE INDEX usuario_email_unico ON usuario (lower(email)) WHERE email IS NOT NULL;
