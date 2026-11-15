-- CRM segreteria · Le porte della vendita
-- L’assistente della vendita, sul Mac, tiene sulla scheda lo stato della famiglia, un riassunto e il rifiuto
-- a essere contattata, e registra sulla visita la risposta al promemoria. Il registro delle richieste
-- dell’assistente ammette le operazioni nuove. La applica l’integrazione al merge.
-- Idempotente: deve poter girare due volte di fila. Gli eventi usano clock_timestamp().

-- ── 1) Le colonne della vendita ─────────────────────────────────────────────
-- Il vocabolario di ai_stato è STATI di motore/vendita/tipi.py, nello stesso ordine (e STATI_FAMIGLIA_AI di tipi.ts).
ALTER TABLE public.crm_schede
  ADD COLUMN IF NOT EXISTS ai_stato text NULL
    CHECK (ai_stato IN ('nuova','contattata','in_conversazione','appuntamento','confermato','venuta','non_venuta','non_risponde','non_interessata','non_contattare','a_una_persona')),
  ADD COLUMN IF NOT EXISTS ai_riassunto text NULL CHECK (char_length(ai_riassunto) <= 4000),
  ADD COLUMN IF NOT EXISTS ai_aggiornata_il timestamptz NULL,
  ADD COLUMN IF NOT EXISTS non_contattare boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS non_contattare_il timestamptz NULL;

COMMENT ON COLUMN public.crm_schede.ai_stato IS
  'CRM, vendita: lo stato della famiglia secondo l''assistente (vocabolario di motore/vendita/tipi.py). Nullo finché l''assistente non l''ha scritto.';
COMMENT ON COLUMN public.crm_schede.ai_riassunto IS
  'CRM, vendita: il riassunto della conversazione scritto dall''assistente, fino a 4000 caratteri. Testo di famiglie: non esce dalle rotte /api/crm/ai e non entra nei log né nello storico.';
COMMENT ON COLUMN public.crm_schede.non_contattare IS
  'CRM, vendita: la famiglia ha chiesto di non essere più contattata. L''assistente può solo accenderlo; lo spegne una persona.';
COMMENT ON COLUMN public.crm_schede.non_contattare_il IS
  'CRM, vendita: il primo istante in cui la famiglia ha chiesto di non essere contattata.';

ALTER TABLE public.crm_appuntamenti
  ADD COLUMN IF NOT EXISTS promemoria_conferma boolean NULL,
  ADD COLUMN IF NOT EXISTS promemoria_conferma_il timestamptz NULL;

COMMENT ON COLUMN public.crm_appuntamenti.promemoria_conferma IS
  'CRM, vendita: la risposta della famiglia al promemoria della visita (vero conferma, falso non conferma). Nullo se non ha risposto.';

-- ── 2) Il registro delle richieste: le operazioni ammesse ───────────────────
-- Il vincolo della migrazione del 13/11 è nato dentro la tabella e ha un nome scelto da Postgres: lo si
-- cerca per definizione. Ogni esecuzione toglie i vincoli sull’operazione e rimette quello con il nome.
DO $$
DECLARE
  v_nome text;
BEGIN
  FOR v_nome IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.crm_ai_richieste'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%operazione%'
  LOOP
    EXECUTE format('ALTER TABLE public.crm_ai_richieste DROP CONSTRAINT %I', v_nome);
  END LOOP;
  ALTER TABLE public.crm_ai_richieste ADD CONSTRAINT crm_ai_richieste_operazione CHECK (operazione IN ('prenota','sposta','aggiorna_scheda','conferma'));
END $$;

-- ── 3) crm_ai_aggiorna_scheda: stato, riassunto e rifiuto della famiglia ────
CREATE OR REPLACE FUNCTION public.crm_ai_aggiorna_scheda(
  p_integrazione_id uuid,
  p_scuola_id       uuid,
  p_chiave          text,
  p_impronta        text,
  p_scheda_id       uuid,
  p_telefono_norm   text,
  p_dati            jsonb
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_r             public.crm_ai_richieste%ROWTYPE;
  v_prima         record;
  v_ha_stato      boolean;
  v_ha_riassunto  boolean;
  v_ha_rifiuto    boolean;
  v_stato         text;
  v_riassunto     text;
  v_campi         text[] := '{}';
  v_dopo          record;
  v_risposta      jsonb;
BEGIN
  IF p_integrazione_id IS NULL OR p_scuola_id IS NULL
     OR p_chiave IS NULL OR p_chiave !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_impronta IS NULL OR p_impronta !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'integrazione, sede, chiave e impronta sono obbligatorie' USING ERRCODE = '22023';
  END IF;
  IF (p_scheda_id IS NULL) = (p_telefono_norm IS NULL)
     OR (p_telefono_norm IS NOT NULL AND p_telefono_norm !~ '^[0-9]{9,10}$') THEN
    RAISE EXCEPTION 'serve esattamente uno fra scheda e telefono normalizzato' USING ERRCODE = '22023';
  END IF;

  -- p_dati: un oggetto con almeno una delle tre chiavi, e nessun'altra.
  IF jsonb_typeof(p_dati) IS DISTINCT FROM 'object'
     OR NOT (p_dati ?| ARRAY['stato', 'riassunto', 'non_contattare'])
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_dati) k WHERE k NOT IN ('stato', 'riassunto', 'non_contattare')) THEN
    RAISE EXCEPTION 'dati: stato, riassunto o non_contattare, e nient''altro' USING ERRCODE = '22023';
  END IF;
  v_ha_stato := p_dati ? 'stato';
  v_ha_riassunto := p_dati ? 'riassunto';
  v_ha_rifiuto := p_dati ? 'non_contattare';
  IF v_ha_stato THEN
    IF jsonb_typeof(p_dati->'stato') IS DISTINCT FROM 'string'
       OR (p_dati->>'stato') NOT IN ('nuova','contattata','in_conversazione','appuntamento','confermato','venuta','non_venuta','non_risponde','non_interessata','non_contattare','a_una_persona') THEN
      RAISE EXCEPTION 'stato fuori vocabolario' USING ERRCODE = '22023';
    END IF;
    v_stato := p_dati->>'stato';
  END IF;
  IF v_ha_riassunto THEN
    IF jsonb_typeof(p_dati->'riassunto') IS DISTINCT FROM 'string' OR char_length(p_dati->>'riassunto') > 4000 THEN
      RAISE EXCEPTION 'riassunto: un testo fino a 4000 caratteri' USING ERRCODE = '22023';
    END IF;
    -- La stringa vuota cancella il riassunto.
    v_riassunto := nullif(btrim(p_dati->>'riassunto'), '');
  END IF;
  -- Un’AI non toglie un rifiuto: lo toglie una persona.
  IF v_ha_rifiuto AND p_dati->'non_contattare' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'non_contattare ammette solo true' USING ERRCODE = '22023';
  END IF;

  IF NOT public.crm_ai_token_attivo(p_integrazione_id, p_scuola_id) THEN
    RETURN jsonb_build_object('esito', 'token_non_valido');
  END IF;

  -- Il secondo tentativo con la stessa chiave aspetta il primo e ne rilegge l’esito.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm_ai_richiesta|' || p_integrazione_id::text || '|' || p_chiave, 0));
  SELECT * INTO v_r FROM public.crm_ai_richieste
   WHERE integrazione_id = p_integrazione_id AND scuola_id = p_scuola_id AND chiave = p_chiave;
  IF FOUND THEN
    IF v_r.impronta <> p_impronta THEN
      RETURN jsonb_build_object('esito', 'chiave_riusata');
    END IF;
    IF v_r.risposta IS NULL THEN
      RETURN jsonb_build_object('esito', 'in_corso');
    END IF;
    RETURN v_r.risposta || jsonb_build_object('ripetuta', true);
  END IF;

  -- Una scheda attiva della sede. Per telefono la più vecchia, come la lettura dello stato per numero.
  -- NO KEY UPDATE lascia passare il KEY SHARE delle figlie, come nelle altre funzioni dell’assistente.
  IF p_scheda_id IS NOT NULL THEN
    SELECT s.id, s.ai_stato, s.ai_riassunto, s.non_contattare INTO v_prima
      FROM public.crm_schede s
     WHERE s.id = p_scheda_id AND s.scuola_id = p_scuola_id AND s.anonimizzata_il IS NULL
     FOR NO KEY UPDATE;
  ELSE
    SELECT s.id, s.ai_stato, s.ai_riassunto, s.non_contattare INTO v_prima
      FROM public.crm_schede s
     WHERE s.scuola_id = p_scuola_id AND s.anonimizzata_il IS NULL
       AND s.telefoni_norm && ARRAY[p_telefono_norm]
     ORDER BY s.creata_il, s.id
     LIMIT 1
     FOR NO KEY UPDATE;
  END IF;
  IF NOT FOUND THEN
    -- Un rifiuto non entra nel registro: lo stesso tentativo, più tardi, viene rivalutato.
    RETURN jsonb_build_object('esito', 'non_trovata');
  END IF;

  -- Nello storico, come per la segreteria, i soli nomi delle colonne che cambiano davvero.
  IF v_ha_stato AND v_stato IS DISTINCT FROM v_prima.ai_stato THEN
    v_campi := array_append(v_campi, 'ai_stato');
  END IF;
  IF v_ha_riassunto AND v_riassunto IS DISTINCT FROM v_prima.ai_riassunto THEN
    v_campi := array_append(v_campi, 'ai_riassunto');
  END IF;
  IF v_ha_rifiuto AND NOT v_prima.non_contattare THEN
    v_campi := array_append(v_campi, 'non_contattare');
  END IF;

  UPDATE public.crm_schede
     SET ai_stato          = CASE WHEN v_ha_stato THEN v_stato ELSE ai_stato END,
         ai_riassunto      = CASE WHEN v_ha_riassunto THEN v_riassunto ELSE ai_riassunto END,
         non_contattare    = non_contattare OR v_ha_rifiuto,
         non_contattare_il = CASE WHEN v_ha_rifiuto THEN coalesce(non_contattare_il, clock_timestamp()) ELSE non_contattare_il END,
         ai_aggiornata_il  = clock_timestamp(),
         aggiornata_il     = now()
   WHERE id = v_prima.id AND scuola_id = p_scuola_id
  RETURNING ai_stato, non_contattare INTO v_dopo;

  IF cardinality(v_campi) > 0 THEN
    INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore_via, dati, creato_il)
    VALUES (v_prima.id, p_scuola_id, 'modificata', 'ai',
            jsonb_build_object('campi', array_to_string(v_campi, ',')), clock_timestamp());
  END IF;

  v_risposta := jsonb_build_object('esito', 'aggiornata', 'scheda_id', v_prima.id,
    'stato', v_dopo.ai_stato, 'non_contattare', v_dopo.non_contattare);
  INSERT INTO public.crm_ai_richieste
    (scuola_id, integrazione_id, chiave, operazione, impronta, risposta, scheda_id, conclusa_il)
  VALUES
    (p_scuola_id, p_integrazione_id, p_chiave, 'aggiorna_scheda', p_impronta, v_risposta, v_prima.id, clock_timestamp());
  RETURN v_risposta;
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_aggiorna_scheda(uuid, uuid, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_aggiorna_scheda(uuid, uuid, text, text, uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.crm_ai_aggiorna_scheda(uuid, uuid, text, text, uuid, text, jsonb) IS
  'CRM, accesso AI: scrive sulla scheda attiva della sede (per id, o per telefono la più vecchia) lo stato della famiglia, il riassunto (la stringa vuota lo cancella) e il rifiuto a essere contattata (solo vero; conserva il primo istante). Idempotente sulla chiave di chi chiama: stessa chiave e stessa impronta ripetono la risposta senza riscrivere. Nello storico un evento modificata con i soli nomi dei campi cambiati, mai il riassunto. Solo service_role.';

-- ── 4) crm_ai_conferma: la risposta della famiglia al promemoria ────────────
CREATE OR REPLACE FUNCTION public.crm_ai_conferma(
  p_integrazione_id uuid,
  p_scuola_id       uuid,
  p_chiave          text,
  p_impronta        text,
  p_appuntamento_id uuid,
  p_confermata      boolean
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_r        public.crm_ai_richieste%ROWTYPE;
  v_visita   public.crm_appuntamenti%ROWTYPE;
  v_risposta jsonb;
BEGIN
  IF p_integrazione_id IS NULL OR p_scuola_id IS NULL
     OR p_chiave IS NULL OR p_chiave !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_impronta IS NULL OR p_impronta !~ '^[0-9a-f]{64}$'
     OR p_appuntamento_id IS NULL OR p_confermata IS NULL THEN
    RAISE EXCEPTION 'integrazione, sede, chiave, impronta, visita e risposta sono obbligatorie' USING ERRCODE = '22023';
  END IF;
  IF NOT public.crm_ai_token_attivo(p_integrazione_id, p_scuola_id) THEN
    RETURN jsonb_build_object('esito', 'token_non_valido');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('crm_ai_richiesta|' || p_integrazione_id::text || '|' || p_chiave, 0));
  SELECT * INTO v_r FROM public.crm_ai_richieste
   WHERE integrazione_id = p_integrazione_id AND scuola_id = p_scuola_id AND chiave = p_chiave;
  IF FOUND THEN
    IF v_r.impronta <> p_impronta THEN
      RETURN jsonb_build_object('esito', 'chiave_riusata');
    END IF;
    IF v_r.risposta IS NULL THEN
      RETURN jsonb_build_object('esito', 'in_corso');
    END IF;
    RETURN v_r.risposta || jsonb_build_object('ripetuta', true);
  END IF;

  -- Il promemoria vale per ogni visita della sede, anche quelle fissate dalla segreteria.
  SELECT * INTO v_visita FROM public.crm_appuntamenti
   WHERE id = p_appuntamento_id AND scuola_id = p_scuola_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;
  IF v_visita.stato <> 'in_programma' OR v_visita.fine <= clock_timestamp() THEN
    RETURN jsonb_build_object('esito', 'stato_non_ammesso');
  END IF;

  UPDATE public.crm_appuntamenti
     SET promemoria_conferma = p_confermata,
         promemoria_conferma_il = clock_timestamp(),
         aggiornato_il = clock_timestamp()
   WHERE id = p_appuntamento_id AND scuola_id = p_scuola_id;
  INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore_via, dati, testo, creato_il)
  VALUES (v_visita.scheda_id, p_scuola_id, 'nota', 'ai',
    jsonb_build_object('appuntamento_id', p_appuntamento_id),
    CASE WHEN p_confermata THEN 'Promemoria: la famiglia conferma l’appuntamento.'
         ELSE 'Promemoria: la famiglia non conferma l’appuntamento.' END,
    clock_timestamp());

  v_risposta := jsonb_build_object('esito', 'registrata', 'appuntamento_id', p_appuntamento_id,
    'scheda_id', v_visita.scheda_id, 'confermata', p_confermata);
  INSERT INTO public.crm_ai_richieste
    (scuola_id, integrazione_id, chiave, operazione, impronta, risposta, scheda_id, appuntamento_id, conclusa_il)
  VALUES
    (p_scuola_id, p_integrazione_id, p_chiave, 'conferma', p_impronta, v_risposta, v_visita.scheda_id, p_appuntamento_id, clock_timestamp());
  RETURN v_risposta;
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_conferma(uuid, uuid, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_conferma(uuid, uuid, text, text, uuid, boolean) TO service_role;

COMMENT ON FUNCTION public.crm_ai_conferma(uuid, uuid, text, text, uuid, boolean) IS
  'CRM, accesso AI: registra sulla visita in programma della sede (fissata da chiunque) se la famiglia conferma il promemoria, con una nota a testo fisso nello storico. Una visita annullata, svolta o già finita non si tocca. Idempotente sulla chiave di chi chiama. Solo service_role.';

NOTIFY pgrst, 'reload schema';
