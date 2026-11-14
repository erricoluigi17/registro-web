-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- `demo_ripristina` toglie anche i GENITORI DI PROVA nati dopo la partenza (14/11/2026)
--
-- Quando una prova iscrive un bambino dal modulo pubblico e la segreteria lo importa, nascono un alunno, un genitore (`parents`, col suo
-- `auth_user_id`), il suo utente (`utenti`, ruolo `genitore`) e l'utente di accesso (`auth.users`). Fino a ieri `demo_ripristina` toglieva
-- domanda e alunno e lasciava gli altri tre fra le righe `lasciate`: il freno SQL nega i DELETE a mano, e giustamente. La strada prevista per la
-- Demo è questa funzione, che adesso li toglie, con criteri STRETTI. Un genitore si toglie solo se valgono TUTTE queste condizioni:
--   1. la riga `parents` è nata dopo la partenza;
--   2. dopo l'azzeramento non ha più alcun legame con alcun alunno (`student_parents`, `legame_genitori_alunni`, `student_guardians` e ogni altra
--      tabella che lega un genitore a un alunno: si leggono dalle chiavi esterne VERE, non da un elenco scritto qui);
--   3. il suo utente (se c'è) ha ruolo `genitore`, è nato dopo la partenza, ha come sede (se ne ha una) solo una sede `e2e00000…` e non ha righe in
--      `utenti_scuole` per una sede che non comincia per `e2e00000`;
--   4. l'email dell'utente di accesso (`auth.users`) finisce in `.test`: è il dominio riservato dallo standard (RFC 2606), non può essere di
--      una persona vera ed è quello che le prove usano per regola.
-- In più non deve restargli attaccata nessuna riga che una chiave esterna NO ACTION/RESTRICT non lascerebbe cancellare (firme, voci, registri…): in
-- quel caso il genitore resta. Si tolgono con lui gli inviti con le credenziali (contengono l'email) e le accettazioni dei consensi (senza chiave
-- esterna); il resto (notifiche, sottoscrizioni push, sedi dell'utente, chat…) va via a cascata. Ordine: dipendenti → `parents` → `utenti` → `auth.users`.
-- Un genitore che non rispetta anche una sola condizione RESTA e compare in `lasciate`, con tabella e uuid. Un genitore legato a un alunno di una
-- sede VERA non è roba della prova: non si tocca e non si elenca. Nel riassunto solo uuid e conteggi, mai l'email.
--
-- `CREATE OR REPLACE` delle funzioni, stessa firma e stessi grant di `20261114124928_demo_funzioni_ripristino.sql` (NON modificata: è già applicata
-- in produzione). Si conservano le sue correzioni: il confronto su `fattura_stato`, le chiavi esterne composte, l'interruttore `anno_chiuso.oblio`
-- rimesso al valore di prima, solo i vincoli nati differiti messi IMMEDIATE e poi di nuovo DEFERRED. Nessuna sede è scritta qui.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── L'aiuto: i legami di un genitore con gli alunni ───────────────────────────────────────────
-- 0 = nessun legame · 1 = legami solo con alunni di sedi di prova (e2e00000…) · 2 = almeno un legame con un alunno di una sede VERA, o un legame che non
-- si sa leggere (in dubbio si ferma). Un legame è una riga di una tabella che ha una chiave esterna verso `parents` o `utenti` E una verso `alunni`
-- (student_parents, legame_genitori_alunni, student_guardians e ogni altra: si leggono dal catalogo, non da un elenco).
CREATE OR REPLACE FUNCTION public.demo_i_genitore_legami(p_parent uuid, p_utente uuid) RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $leg$
DECLARE
  fk      record;
  al      record;
  v_tot   bigint;
  v_vere  bigint;
  v_cod   integer := 0;
BEGIN
  FOR fk IN
    SELECT quote_ident(ns.nspname) || '.' || quote_ident(cl.relname) AS da, c.conrelid AS rel,
           (c.confrelid = 'public.parents'::regclass) AS su_parents,
           (SELECT string_agg(format('x.%I = r.%I', pa.attname, rf.attname), ' AND ' ORDER BY k.ord)
              FROM unnest(c.conkey, c.confkey) WITH ORDINALITY k(a, rr, ord)
              JOIN pg_attribute pa ON pa.attrelid = c.conrelid AND pa.attnum = k.a
              JOIN pg_attribute rf ON rf.attrelid = c.confrelid AND rf.attnum = k.rr) AS cond
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE c.contype = 'f' AND ns.nspname = 'public'
       AND c.confrelid IN ('public.parents'::regclass, 'public.utenti'::regclass)
       AND c.conrelid <> c.confrelid
       AND EXISTS (SELECT 1 FROM pg_constraint c2 WHERE c2.conrelid = c.conrelid AND c2.contype = 'f' AND c2.confrelid = 'public.alunni'::regclass)
     ORDER BY 1, c.conname
  LOOP
    FOR al IN
      SELECT pa.attname AS col, cardinality(c2.conkey) AS n
        FROM pg_constraint c2 JOIN pg_attribute pa ON pa.attrelid = c2.conrelid AND pa.attnum = c2.conkey[1]
       WHERE c2.conrelid = fk.rel AND c2.contype = 'f' AND c2.confrelid = 'public.alunni'::regclass
    LOOP
      IF al.n <> 1 THEN RETURN 2; END IF;
      EXECUTE format(
        'SELECT count(*), count(*) FILTER (WHERE left(a.scuola_id::text, 8) IS DISTINCT FROM ''e2e00000'') FROM public.%s r JOIN %s x ON %s JOIN public.alunni a ON a.id = x.%I WHERE r.id = $1',
        CASE WHEN fk.su_parents THEN 'parents' ELSE 'utenti' END, fk.da, fk.cond, al.col)
        INTO v_tot, v_vere USING CASE WHEN fk.su_parents THEN p_parent ELSE p_utente END;
      IF v_vere > 0 THEN RETURN 2; END IF;
      IF v_tot > 0 THEN v_cod := 1; END IF;
    END LOOP;
  END LOOP;
  RETURN v_cod;
END
$leg$;

-- ── demo_ripristina ───────────────────────────────────────────────────────────────────────────
-- Passi 1, 2, 3, 4 e 4bis del pacchetto del 14/11/2026 in un colpo solo, nella transazione della chiamata (un errore annulla tutto).
-- Con `p_prova_a_secco` (default) fa tutto e alza DEMO_PROVA_A_SECCO col riassunto: non resta scritto niente.
-- L'ORDINE conta: i periodi di scrutinio vanno via PRIMA dei gettoni (l'interruttore dell'oblio, se serve, lascia un gettone che il
-- passo dei gettoni toglie subito dopo); poi stati e cronologia; poi incassi e sezioni degli anni nati dopo, che fermerebbero
-- l'azzeramento; infine l'azzeramento dell'anno nuovo, che rimette configurazione, frequenze e date dalla fotografia.
CREATE OR REPLACE FUNCTION public.demo_ripristina(
  p_scuola         uuid,
  p_partenza       timestamptz,
  p_prova_a_secco  boolean DEFAULT true,
  p_fotografia     jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $demo$
DECLARE
  v_sede        uuid := p_scuola;
  v_dal         timestamptz := p_partenza;
  v_foto        jsonb;
  v_elenco      uuid[];
  v_cand        uuid[];
  v_anno        uuid;       -- anni_sede.id dell'anno nuovo
  v_anno_id     uuid;       -- anni_scolastici.id dell'anno nuovo
  v_etichetta   text;
  v_n           integer;
  v_tot         integer;
  v_oblio       text;
  v_differiti   text;
  v_cascata     jsonb := '{}'::jsonb;
  r_casc        record;
  v_tolte       integer;
  v_rimesse     integer;
  v_lasciate    integer;
  v_inv         integer;
  v_cron        integer;
  v_giusto      boolean;
  v_nati        uuid[];
  v_nati_anni   uuid[];
  v_usi         text;
  v_solo        uuid[];
  v_cnt         jsonb;
  fk            record;
  v_part        jsonb;
  v_par         uuid;
  v_y           record;
  v_tab         record;
  v_g           record;
  v_msg         text;
  v_dett        text;
  v_anno0       uuid;       -- l'anno nuovo, trovato dall'etichetta della fotografia (prima del ripristino può essere ancora `corrente`)
  v_annoid0     uuid;
  v_r_gettoni   integer := 0;
  v_r_passaggi  integer := 0;
  v_r_cron      integer := 0;
  v_r_stati     integer := 0;
  v_r_incassi   integer := 0;
  v_r_incassi_fuori integer := 0;
  v_r_sezioni   integer := 0;
  v_r_scrutinio integer := 0;
  v_esito       jsonb;
  v_gen_par     uuid[];
  v_gen_ute     uuid[];
BEGIN
  -- ── 0 · LA GUARDIA: prima di toccare qualsiasi riga ──────────────────────────────────────────
  PERFORM public.demo_i_guardia(p_scuola);
  IF p_partenza IS NULL THEN
    RAISE EXCEPTION 'DEMO_PARTENZA: la partenza (l''istante della fotografia) è obbligatoria';
  END IF;
  IF v_dal > now() THEN
    RAISE EXCEPTION 'DEMO_PARTENZA: la data di partenza è nel futuro';
  END IF;
  v_foto := public.demo_i_fotografia(p_scuola, p_partenza, p_fotografia);

  -- Le tabelle di lavoro (si buttano al COMMIT; ricrearle è lecito se la funzione gira due volte nella stessa transazione).
  DROP TABLE IF EXISTS pg_temp._azzera_cand;
  CREATE TEMP TABLE pg_temp._azzera_cand (tabella text NOT NULL, id uuid NOT NULL, bloccata boolean NOT NULL DEFAULT false, PRIMARY KEY (tabella, id)) ON COMMIT DROP;
  DROP TABLE IF EXISTS pg_temp._azzera_esito;
  CREATE TEMP TABLE pg_temp._azzera_esito (ordine serial, gruppo integer NOT NULL DEFAULT 0, voce text NOT NULL, tolte integer DEFAULT 0, rimesse integer DEFAULT 0, lasciate integer DEFAULT 0,
    CHECK (gruppo = 1 OR (tolte IS NOT NULL AND rimesse IS NOT NULL AND lasciate IS NOT NULL))) ON COMMIT DROP;
  DROP TABLE IF EXISTS pg_temp._azzera_lasciate;
  CREATE TEMP TABLE pg_temp._azzera_lasciate (tabella text NOT NULL, id uuid NOT NULL) ON COMMIT DROP;
  DROP TABLE IF EXISTS pg_temp._demo_stati;
  CREATE TEMP TABLE pg_temp._demo_stati (anno_sede_id uuid PRIMARY KEY, stato text, domande_aperte boolean) ON COMMIT DROP;
  DROP TABLE IF EXISTS pg_temp._demo_genitori;
  CREATE TEMP TABLE pg_temp._demo_genitori (parent_id uuid PRIMARY KEY, utente_id uuid, legami integer NOT NULL DEFAULT 0, ok boolean NOT NULL DEFAULT true) ON COMMIT DROP;

  -- ── 1 · La fotografia è fatta come deve (la sede è già verificata dalla guardia) ──────────
  IF jsonb_typeof(v_foto) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_foto->'etichetta') IS DISTINCT FROM 'string' OR (v_foto->>'etichetta') !~ '^[0-9]{4}/[0-9]{2}$'
     OR (v_foto->>'stato') IS NULL OR (v_foto->>'stato') NOT IN ('in_preparazione', 'iscrizioni_aperte')
     OR jsonb_typeof(v_foto->'domande_aperte') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_foto->'listino') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_foto->'moduli') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_foto->'posti') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_foto->'conteggi') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['frequenze', 'pagamenti', 'sezioni', 'domande']) k
                 WHERE jsonb_typeof(v_foto->'conteggi'->k) IS DISTINCT FROM 'number') THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: la fotografia non ha la forma attesa (etichetta, stato, domande_aperte, listino, moduli, posti, conteggi)';
  END IF;
  -- Le quattro date dell'anno nuovo (e, sotto, dell'anno di partenza): date vere, nel formato AAAA-MM-GG.
  IF public.demo_i_date_ok(v_foto->'date') IS NOT TRUE THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: le date dell''anno nuovo non hanno la forma attesa (inizio, fine, ultimo_giorno_aperto, prepara_successivo_dal)';
  END IF;
  v_etichetta := v_foto->>'etichetta';
  v_part := CASE WHEN jsonb_typeof(v_foto->'partenza') = 'object' THEN v_foto->'partenza' END;
  IF v_foto ? 'partenza' AND jsonb_typeof(v_foto->'partenza') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: la parte «partenza» della fotografia non ha la forma attesa';
  END IF;
  IF v_part IS NOT NULL THEN
    IF jsonb_typeof(v_part->'etichetta') IS DISTINCT FROM 'string' OR (v_part->>'etichetta') !~ '^[0-9]{4}/[0-9]{2}$'
       OR public.demo_i_date_ok(v_part->'date') IS NOT TRUE
       OR jsonb_typeof(v_part->'frequenze') IS DISTINCT FROM 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'frequenze') e
                   WHERE jsonb_typeof(e) <> 'object' OR e->>'id' !~ '^[0-9a-f-]{36}$'
                      OR (e->>'stato') IS NULL) THEN  -- lo stato lo giudica il CHECK di `frequenze` al momento di riscriverlo (senza elencarlo qui: lock `uscito`)
      RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: le frequenze dell''anno di partenza non hanno la forma attesa';
    END IF;
  END IF;

  -- ── 2bis · L'anno nuovo, dall'etichetta della fotografia (prima del ripristino può essere ancora `corrente`) ──
  SELECT a.id, a.anno_id INTO v_anno0, v_annoid0
    FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id
   WHERE a.scuola_id = v_sede AND y.etichetta_breve = v_etichetta AND a.creato_il < v_dal;
  IF v_anno0 IS NULL THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: l''anno % della fotografia non esiste in questa sede (o è nato dopo la partenza)', v_etichetta;
  END IF;
  SELECT count(*) INTO v_inv FROM public.anno_invarianti() WHERE righe <> 0;
  RAISE NOTICE 'prima: anno nuovo %, % invarianti non a zero', v_etichetta, v_inv;

  -- ══ PASSI 4 e 4bis · i periodi di scrutinio nati dopo la partenza (2026/27 e 2025/26 nel pacchetto del 14/11) ═══════════════════
  -- Prima dei gettoni, e con l'interruttore dell'oblio acceso solo per questo DELETE: se la guardia dell'anno chiuso fosse accesa, la
  -- cancellazione di un periodo di un anno chiuso la fermerebbe, e l'oblio lascia un gettone (creato adesso, dunque dopo la partenza)
  -- che il passo seguente toglie. Con la guardia spenta, come oggi, l'interruttore non cambia niente. Si rispegne subito.
  v_oblio := current_setting('anno_chiuso.oblio', true);
  PERFORM set_config('anno_chiuso.oblio', 'on', true);
  -- Ciò che la cancellazione si porta dietro A CASCATA (ON DELETE CASCADE dal periodo): gli scrutini e i giudizi descrittivi. Si contano
  -- prima, perché finiscano nell'esito: la prova a secco li mostra, e si legge PRIMA del vero.
  FOR r_casc IN SELECT t.nome FROM (VALUES ('scrutini'), ('scrutinio_giudizio_descrittivo')) t(nome) WHERE to_regclass('public.' || t.nome) IS NOT NULL LOOP
    EXECUTE format('SELECT count(*) FROM public.%I x WHERE x.periodo_id IN (SELECT sp.id FROM public.scrutinio_periodi sp WHERE sp.scuola_id = $1 AND sp.creato_il >= $2)', r_casc.nome)
      INTO v_n USING v_sede, v_dal;
    v_cascata := v_cascata || jsonb_build_object(r_casc.nome, v_n);
  END LOOP;
  DELETE FROM public.scrutinio_periodi sp WHERE sp.scuola_id = v_sede AND sp.creato_il >= v_dal;
  GET DIAGNOSTICS v_r_scrutinio = ROW_COUNT;
  -- si rimette il valore che c'era (locale alla transazione: `true`), non un `off` a mano
  PERFORM set_config('anno_chiuso.oblio', coalesce(v_oblio, 'off'), true);

  -- ══ PASSO 1 · il ripristino: gettoni, passaggi, cronologia, stati ═══════════════════════════════════════════════════════════
  -- Gli stati alla partenza: l'anno nuovo e l'anno di partenza dalla fotografia; gli altri anni nati prima dalla loro ultima riga di
  -- cronologia precedente alla partenza (un anno senza cronologia resta com'è). Le domande aperte dell'anno di partenza: quelle della
  -- fotografia, o chiuse se la fotografia non lo dice.
  INSERT INTO pg_temp._demo_stati (anno_sede_id, stato, domande_aperte)
    SELECT a.id,
           CASE WHEN y.etichetta_breve = v_etichetta THEN v_foto->>'stato'
                WHEN v_part IS NOT NULL AND y.etichetta_breve = v_part->>'etichetta' THEN 'corrente'
                ELSE (SELECT st.stato FROM public.anni_sede_stati st WHERE st.anno_sede_id = a.id AND st.dal < v_dal ORDER BY st.dal DESC, st.id DESC LIMIT 1) END,
           CASE WHEN y.etichetta_breve = v_etichetta THEN (v_foto->>'domande_aperte')::boolean
                WHEN v_part IS NOT NULL AND y.etichetta_breve = v_part->>'etichetta' THEN coalesce((v_part->>'domande_aperte')::boolean, false)
                ELSE false END
      FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id
     WHERE a.scuola_id = v_sede AND a.creato_il < v_dal;
  DELETE FROM pg_temp._demo_stati i WHERE i.stato IS NULL;
  SELECT count(*) INTO v_n FROM pg_temp._demo_stati i WHERE i.stato NOT IN ('in_preparazione', 'iscrizioni_aperte', 'corrente', 'in_chiusura', 'chiuso');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_FOTOGRAFIA: % anni con uno stato che non conosco', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_temp._demo_stati i WHERE i.stato = 'corrente';
  IF v_n > 1 THEN
    RAISE EXCEPTION 'RIPRISTINO_FOTOGRAFIA: % anni corrente alla partenza invece di uno', v_n;
  END IF;

  SELECT count(*) INTO v_r_passaggi FROM public.passaggi_anno p WHERE p.scuola_id = v_sede AND p.creato_il >= v_dal;
  SELECT count(*) INTO v_r_gettoni FROM public.correzioni_anno_chiuso c
   WHERE c.anno_sede_id IN (SELECT a.id FROM public.anni_sede a WHERE a.scuola_id = v_sede) AND c.creata_il >= v_dal;
  -- 1a · i gettoni di correzione (le righe d'uso vanno via a cascata)
  DELETE FROM public.correzioni_anno_chiuso c
   WHERE c.anno_sede_id IN (SELECT a.id FROM public.anni_sede a WHERE a.scuola_id = v_sede) AND c.creata_il >= v_dal;
  -- 1b · i passaggi (anteprima, confermato, annullato)
  DELETE FROM public.passaggi_anno p WHERE p.scuola_id = v_sede AND p.creato_il >= v_dal;
  -- 1c · la cronologia degli stati dopo la partenza, solo degli anni che esistevano già
  DELETE FROM public.anni_sede_stati s WHERE s.anno_sede_id IN (SELECT i.anno_sede_id FROM pg_temp._demo_stati i) AND s.dal >= v_dal;
  GET DIAGNOSTICS v_r_cron = ROW_COUNT;
  -- 1d · gli stati in DUE passaggi: prima chi NON torna `corrente` (libera l'indice «un solo corrente per sede»), poi chi lo torna
  UPDATE public.anni_sede a SET stato = i.stato, domande_aperte = i.domande_aperte
    FROM pg_temp._demo_stati i
   WHERE a.id = i.anno_sede_id AND a.scuola_id = v_sede AND i.stato <> 'corrente'
     AND (a.stato, a.domande_aperte) IS DISTINCT FROM (i.stato, i.domande_aperte);
  GET DIAGNOSTICS v_r_stati = ROW_COUNT;
  UPDATE public.anni_sede a SET stato = i.stato, domande_aperte = i.domande_aperte
    FROM pg_temp._demo_stati i
   WHERE a.id = i.anno_sede_id AND a.scuola_id = v_sede AND i.stato = 'corrente'
     AND (a.stato, a.domande_aperte) IS DISTINCT FROM (i.stato, i.domande_aperte);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_r_stati := v_r_stati + v_n;
  -- una riga di cronologia scritta dagli UPDATE di sopra non è una riga della partenza: via anche quella
  DELETE FROM public.anni_sede_stati s WHERE s.anno_sede_id IN (SELECT i.anno_sede_id FROM pg_temp._demo_stati i) AND s.dal >= v_dal;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_r_cron := v_r_cron + v_n;

  SELECT count(*) INTO v_n FROM public.passaggi_anno p WHERE p.scuola_id = v_sede AND p.creato_il >= v_dal;
  IF v_n <> 0 THEN RAISE EXCEPTION 'RIPRISTINO_CONTEGGI: restano % passaggi dopo la partenza', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.correzioni_anno_chiuso c
   WHERE c.anno_sede_id IN (SELECT a.id FROM public.anni_sede a WHERE a.scuola_id = v_sede) AND c.creata_il >= v_dal;
  IF v_n <> 0 THEN RAISE EXCEPTION 'RIPRISTINO_CONTEGGI: restano % gettoni dopo la partenza', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.anni_sede_stati s WHERE s.anno_sede_id IN (SELECT i.anno_sede_id FROM pg_temp._demo_stati i) AND s.dal >= v_dal;
  IF v_n <> 0 THEN RAISE EXCEPTION 'RIPRISTINO_CONTEGGI: restano % righe di cronologia dopo la partenza', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_temp._demo_stati i JOIN public.anni_sede a ON a.id = i.anno_sede_id
   WHERE a.stato IS DISTINCT FROM i.stato OR a.domande_aperte IS DISTINCT FROM i.domande_aperte;
  IF v_n <> 0 THEN RAISE EXCEPTION 'RIPRISTINO_CONTEGGI: % anni non coincidono con la fotografia', v_n; END IF;

  -- ══ PASSO 2 · le righe della prova che l'azzeramento non copre e che gli impedirebbero di partire ═══════════════════════════
  -- 2a · gli incassi nati dopo la partenza su voci nate dopo la partenza (senza, l'azzeramento non tocca la voce pagata). Il trigger
  --      `incassi_ricalcola` riporta la voce a «da pagare». Un incasso nato dopo su una voce che c'era già alla partenza NON si tocca:
  --      si conta nel risultato, la decide il titolare.
  SELECT count(*) INTO v_r_incassi_fuori FROM public.incassi i JOIN public.pagamenti pg ON pg.id = i.pagamento_id
   WHERE pg.scuola_id = v_sede AND pg.creato_il < v_dal AND i.creato_il >= v_dal;
  DELETE FROM public.incassi i
   WHERE i.creato_il >= v_dal AND i.pagamento_id IN (SELECT pg.id FROM public.pagamenti pg WHERE pg.scuola_id = v_sede AND pg.creato_il >= v_dal);
  GET DIAGNOSTICS v_r_incassi = ROW_COUNT;
  -- 2b · le sezioni degli anni NATI dopo la partenza e successivi all'anno nuovo (il tick prepara il 2028/29 con le sue sezioni): senza,
  --      l'azzeramento si ferma con AZZERA_ANNI_NATI_USATI. Se a una sezione è attaccato altro, resta, e l'azzeramento si ferma con i conteggi.
  INSERT INTO pg_temp._azzera_cand (tabella, id)
    SELECT 'sections', se.id FROM public.sections se
     WHERE se.scuola_id = v_sede AND se.created_at >= v_dal
       AND se.anno_id IN (SELECT a.anno_id FROM public.anni_sede a
                           WHERE a.scuola_id = v_sede AND a.creato_il >= v_dal AND a.inizio > (SELECT n.inizio FROM public.anni_sede n WHERE n.id = v_anno0));
  PERFORM public.demo_i_blocca('sections',
    ARRAY['utenti_sezioni', 'utenti_sezioni_materie', 'materie', 'sezione_materia_obiettivo', 'orario_settimanale', 'campanelle', 'tempo_scuola', 'locker_config']);
  PERFORM public.demo_i_blocca_nipoti('sections', 'materie', 'section_id', ARRAY['utenti_sezioni_materie', 'sezione_materia_obiettivo', 'orario_settimanale']);
  DELETE FROM public.sections se WHERE se.id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'sections' AND NOT k.bloccata);
  GET DIAGNOSTICS v_r_sezioni = ROW_COUNT;
  DELETE FROM pg_temp._azzera_cand WHERE tabella = 'sections';

  -- ══ PASSO 3 · l'azzeramento dell'anno nuovo, dalla fotografia ═══════════════════════════════════════════════════════════════
  -- ── 3 · L'anno nuovo: l'unico anno della sede in preparazione o con le iscrizioni aperte, nato prima della partenza ──
  SELECT coalesce(array_agg(a.id), ARRAY[]::uuid[]) INTO v_cand
    FROM public.anni_sede a
   WHERE a.scuola_id = v_sede AND a.stato IN ('in_preparazione', 'iscrizioni_aperte') AND a.creato_il < v_dal;
  IF cardinality(v_cand) <> 1 THEN
    SELECT EXISTS (SELECT 1 FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id
                    WHERE a.scuola_id = v_sede AND y.etichetta_breve = v_etichetta AND a.stato = 'corrente')
      INTO v_giusto;
    IF v_giusto THEN
      RAISE EXCEPTION 'AZZERA_PRIMA_IL_RIPRISTINO: l''anno % è già corrente: il ripristino precedente non è riuscito', v_etichetta;
    END IF;
    RAISE EXCEPTION 'AZZERA_ANNO_NUOVO_NON_UNO: la sede ha % anni in preparazione o con le iscrizioni aperte nati prima della partenza, invece di uno', cardinality(v_cand);
  END IF;
  v_anno := v_cand[1];
  SELECT a.anno_id INTO v_anno_id
    FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id WHERE a.id = v_anno AND y.etichetta_breve = v_etichetta;
  IF v_anno_id IS NULL THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: la fotografia parla del %, ma l''anno nuovo trovato è un altro', v_etichetta;
  END IF;

  -- Se il ripristino non è stato eseguito restano passaggi (anteprime) dopo la partenza: si esegue prima quello.
  SELECT count(*) INTO v_n FROM public.passaggi_anno pan WHERE pan.scuola_id = v_sede AND pan.creato_il >= v_dal;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'AZZERA_PRIMA_IL_RIPRISTINO: restano % passaggi dopo la partenza: il ripristino precedente non è riuscito', v_n;
  END IF;

  -- L'anno di partenza: dopo il ripristino è di nuovo `corrente`, e tutte le sue frequenze della fotografia esistono ancora.
  IF v_part IS NOT NULL THEN
    SELECT a.id INTO v_par FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id
     WHERE a.scuola_id = v_sede AND y.etichetta_breve = v_part->>'etichetta';
    IF v_par IS NULL THEN
      RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: l''anno di partenza % della fotografia non esiste in questa sede', v_part->>'etichetta';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.anni_sede a WHERE a.id = v_par AND a.stato = 'corrente') THEN
      RAISE EXCEPTION 'AZZERA_PRIMA_IL_RIPRISTINO: l''anno di partenza % non è tornato corrente: il ripristino precedente non è riuscito', v_part->>'etichetta';
    END IF;
    SELECT count(*) INTO v_n FROM jsonb_to_recordset(v_part->'frequenze') AS rj(id uuid)
     WHERE NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.id = rj.id AND f.anno_sede_id = v_par);
    IF v_n > 0 THEN
      RAISE EXCEPTION 'AZZERA_FREQUENZA_SPARITA: % frequenze dell''anno di partenza della fotografia non ci sono più (o sono di un altro anno)', v_n;
    END IF;
  END IF;

  -- Ogni riga di configurazione della fotografia è di QUESTO anno (altrimenti la fotografia è di un'altra sede o di un altro anno).
  SELECT count(*) INTO v_n FROM (
    SELECT e->>'anno_sede_id' AS a FROM jsonb_array_elements(v_foto->'listino') e
    UNION ALL SELECT e->>'anno_sede_id' FROM jsonb_array_elements(v_foto->'moduli') e
    UNION ALL SELECT e->>'anno_sede_id' FROM jsonb_array_elements(v_foto->'posti') e) t
   WHERE t.a IS DISTINCT FROM v_anno::text;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: % righe della fotografia non sono dell''anno nuovo di questa sede', v_n;
  END IF;

  -- ── 4 · La data torna con i conteggi della fotografia: le righe nate PRIMA della partenza sono tante quante la fotografia dice ──
  SELECT count(*) INTO v_n FROM public.frequenze f WHERE f.anno_sede_id = v_anno AND f.creata_il < v_dal;
  IF v_n <> (v_foto->'conteggi'->>'frequenze')::integer THEN
    RAISE EXCEPTION 'AZZERA_DATA: la partenza non torna con la fotografia: % frequenze prima della data, la fotografia ne ha %', v_n, v_foto->'conteggi'->>'frequenze';
  END IF;
  SELECT count(*) INTO v_n FROM public.pagamenti pg WHERE pg.scuola_id = v_sede AND pg.anno_id = v_anno_id AND pg.creato_il < v_dal;
  IF v_n <> (v_foto->'conteggi'->>'pagamenti')::integer THEN
    RAISE EXCEPTION 'AZZERA_DATA: la partenza non torna con la fotografia: % voci di pagamento prima della data, la fotografia ne ha %', v_n, v_foto->'conteggi'->>'pagamenti';
  END IF;
  SELECT count(*) INTO v_n FROM public.sections se WHERE se.scuola_id = v_sede AND se.anno_id = v_anno_id AND se.created_at < v_dal;
  IF v_n <> (v_foto->'conteggi'->>'sezioni')::integer THEN
    RAISE EXCEPTION 'AZZERA_DATA: la partenza non torna con la fotografia: % sezioni prima della data, la fotografia ne ha %', v_n, v_foto->'conteggi'->>'sezioni';
  END IF;
  SELECT count(*) INTO v_n FROM public.enrollment_submissions e WHERE e.scuola_id = v_sede AND e.anno_id = v_anno_id AND e.created_at < v_dal;
  IF v_n <> (v_foto->'conteggi'->>'domande')::integer THEN
    RAISE EXCEPTION 'AZZERA_DATA: la partenza non torna con la fotografia: % domande prima della data, la fotografia ne ha %', v_n, v_foto->'conteggi'->>'domande';
  END IF;



  -- ── 6 · LE CANCELLAZIONI, in quest'ordine: chi tiene gli altri per primo ──────────────────

  -- 6a · le frequenze dell'anno nuovo nate dopo la partenza (le spunte dei moduli vanno via a cascata)
  SELECT count(*) INTO v_n FROM public.frequenze_moduli fm JOIN public.frequenze f ON f.id = fm.frequenza_id
   WHERE f.anno_sede_id = v_anno AND f.creata_il >= v_dal;
  DELETE FROM public.frequenze f WHERE f.anno_sede_id = v_anno AND f.creata_il >= v_dal;
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte) VALUES ('frequenze dell''anno nuovo', v_tolte), ('spunte dei moduli (a cascata)', v_n);

  -- 6a bis · le frequenze dell'anno di PARTENZA nate dopo la partenza (un bambino registrato nell'anno in corso durante il collaudo):
  --          si tolgono come le altre righe nate dopo, se non hanno legami; altrimenti restano e si elencano
  IF v_par IS NOT NULL THEN
    INSERT INTO pg_temp._azzera_cand (tabella, id) SELECT 'frequenze', f.id FROM public.frequenze f
       WHERE f.anno_sede_id = v_par AND f.creata_il >= v_dal
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'frequenze') e WHERE e->>'id' = f.id::text);  -- quelle della fotografia ESISTEVANO alla partenza, qualunque cosa dica la data
    PERFORM public.demo_i_blocca('frequenze', ARRAY['frequenze_moduli'], 'continua_da');
    DELETE FROM public.frequenze f WHERE f.id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'frequenze' AND NOT k.bloccata);
    GET DIAGNOSTICS v_tolte = ROW_COUNT;
    INSERT INTO pg_temp._azzera_lasciate SELECT k.tabella, k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'frequenze' AND k.bloccata;
    GET DIAGNOSTICS v_lasciate = ROW_COUNT;
    INSERT INTO pg_temp._azzera_esito (voce, tolte, lasciate) VALUES ('frequenze nate dopo la partenza nell''anno di partenza (lasciate: con legami)', v_tolte, v_lasciate);
  END IF;

  -- 6c · le voci di pagamento dell'anno nuovo nate dopo la partenza; resta quella con un incasso, una fattura o un movimento collegato
  INSERT INTO pg_temp._azzera_cand (tabella, id, bloccata)
    SELECT 'pagamenti', pg.id,
           (coalesce(pg.importo_pagato, 0) <> 0 OR pg.data_incasso IS NOT NULL
            OR pg.fattura_aruba_id IS NOT NULL OR coalesce(pg.fattura_stato::text, 'non_richiesta') <> 'non_richiesta' OR pg.fattura_emessa_il IS NOT NULL OR coalesce(pg.stato, 'da_pagare') <> 'da_pagare')
           -- `fattura_stato` è un enum NOT NULL con predefinito 'non_richiesta': «IS NOT NULL» sarebbe sempre vero e bloccherebbe ogni voce
      FROM public.pagamenti pg
     WHERE pg.scuola_id = v_sede AND pg.anno_id = v_anno_id AND pg.creato_il >= v_dal;
  PERFORM public.demo_i_blocca('pagamenti', ARRAY['pagamenti_quote', 'solleciti', 'fatture_coda'], 'parent_payment_id');
  PERFORM public.demo_i_blocca_nipoti('pagamenti', 'pagamenti_quote', 'pagamento_id', ARRAY[]::text[]);
  -- Il blocco dei nipoti può aver fermato una figlia: la madre che la ha come figlia resta con lei. Si ripete il giro madre/figlia.
  PERFORM public.demo_i_blocca('pagamenti', ARRAY['pagamenti_quote', 'solleciti', 'fatture_coda'], 'parent_payment_id');
  DELETE FROM public.pagamenti pg WHERE pg.id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'pagamenti' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO pg_temp._azzera_lasciate SELECT k.tabella, k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'pagamenti' AND k.bloccata;
  GET DIAGNOSTICS v_lasciate = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, lasciate) VALUES ('voci di pagamento dell''anno nuovo (lasciate: con incasso o collegate)', v_tolte, v_lasciate);

  -- 6d · le domande del modulo pubblico dirette all'anno nuovo (le decisioni vanno via a cascata)
  INSERT INTO pg_temp._azzera_cand (tabella, id)
    SELECT 'enrollment_submissions', e.id FROM public.enrollment_submissions e
     WHERE e.scuola_id = v_sede AND e.anno_id = v_anno_id AND e.created_at >= v_dal;
  PERFORM public.demo_i_blocca('enrollment_submissions', ARRAY['iscrizioni_decisioni', 'iscrizioni_inviti_credenziali']);
  -- Accogliere la domanda ha creato un invito con le credenziali: va via con la domanda (nasce con lei, nella Demo, dopo la partenza). L'ACCOUNT
  -- che ha creato (parents, utenti) NON si cancella mai: se è nato dopo la partenza si elenca fra le righe lasciate.
  INSERT INTO pg_temp._azzera_lasciate
    SELECT DISTINCT 'parents', ic.parent_id FROM public.iscrizioni_inviti_credenziali ic JOIN public.parents pr ON pr.id = ic.parent_id
     WHERE pr.created_at >= v_dal AND ic.submission_id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND NOT k.bloccata)
       AND NOT EXISTS (SELECT 1 FROM pg_temp._azzera_lasciate la WHERE la.tabella = 'parents' AND la.id = ic.parent_id);
  INSERT INTO pg_temp._azzera_lasciate
    SELECT DISTINCT 'utenti', u.id FROM public.iscrizioni_inviti_credenziali ic JOIN public.utenti u ON u.id = ic.auth_user_id
     WHERE u.creato_il >= v_dal AND ic.submission_id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND NOT k.bloccata)
       AND NOT EXISTS (SELECT 1 FROM pg_temp._azzera_lasciate la WHERE la.tabella = 'utenti' AND la.id = u.id);
  -- Le domande non hanno copia nella scatola nera: se una famiglia VERA avesse scritto con un link della Demo, la sua domanda sparirebbe senza
  -- traccia. L'esito ne elenca gli uuid, non solo il numero (la scrittura vera la fa il DELETE qui sotto). Le righe per uuid non portano numeri (NULL): il totale è nella riga «domande del modulo pubblico».
  -- gruppo 1: in fondo, dopo tutti i conteggi (gruppo 0), qualunque sia il numero delle domande.
  INSERT INTO pg_temp._azzera_esito (gruppo, voce, tolte, rimesse, lasciate)
    SELECT 1, 'domanda tolta · ' || k.id::text, NULL, NULL, NULL FROM pg_temp._azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND NOT k.bloccata ORDER BY k.id;
  DELETE FROM public.iscrizioni_inviti_credenziali ic WHERE ic.submission_id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte) VALUES ('inviti con le credenziali tolti con le domande (senza copia: contengono l''email)', v_tolte);
  DELETE FROM public.enrollment_submissions e WHERE e.id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO pg_temp._azzera_lasciate SELECT k.tabella, k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND k.bloccata;
  GET DIAGNOSTICS v_lasciate = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, lasciate) VALUES ('domande del modulo pubblico', v_tolte, v_lasciate);

  -- 6e · gli alunni nati dopo la partenza, solo se non resta loro NIENTE altrove (le tracce automatiche dello storico vanno via con loro)
  INSERT INTO pg_temp._azzera_cand (tabella, id)
    SELECT 'alunni', al.id FROM public.alunni al WHERE al.scuola_id = v_sede AND al.creato_il >= v_dal;
  PERFORM public.demo_i_blocca('alunni', ARRAY['alunni_classi_storico', 'storici_revisioni', 'storici_collegamenti', 'student_parents', 'legame_genitori_alunni'], 'retta_a_carico_di');
  -- I legami con i genitori nascono accogliendo la domanda (student_parents va via a cascata, legame_genitori_alunni no): si tolgono con l'alunno
  -- che se ne va. L'ACCOUNT non si cancella mai: se è nato dopo la partenza si elenca fra le righe lasciate.
  INSERT INTO pg_temp._azzera_lasciate
    SELECT DISTINCT 'parents', sp.parent_id FROM public.student_parents sp JOIN public.parents pr ON pr.id = sp.parent_id
     WHERE pr.created_at >= v_dal AND sp.student_id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'alunni' AND NOT k.bloccata)
       AND NOT EXISTS (SELECT 1 FROM pg_temp._azzera_lasciate la WHERE la.tabella = 'parents' AND la.id = sp.parent_id);
  INSERT INTO pg_temp._azzera_lasciate
    SELECT DISTINCT 'utenti', u.id FROM public.legame_genitori_alunni lg JOIN public.utenti u ON u.id = lg.genitore_id
     WHERE u.creato_il >= v_dal AND lg.alunno_id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'alunni' AND NOT k.bloccata)
       AND NOT EXISTS (SELECT 1 FROM pg_temp._azzera_lasciate la WHERE la.tabella = 'utenti' AND la.id = u.id);
  DELETE FROM public.legame_genitori_alunni lg WHERE lg.alunno_id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'alunni' AND NOT k.bloccata);
  DELETE FROM public.alunni al WHERE al.id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'alunni' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO pg_temp._azzera_lasciate SELECT k.tabella, k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'alunni' AND k.bloccata;
  GET DIAGNOSTICS v_lasciate = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, lasciate) VALUES ('alunni nati dopo la partenza (lasciati: con righe altrove)', v_tolte, v_lasciate);
  -- Il CRM non si cancella: trattiene il suo alunno o la sua domanda, e si elenca per uuid (così si sa PERCHÉ quell'alunno resta).
  INSERT INTO pg_temp._azzera_lasciate
    SELECT 'crm_bambini', cb.id FROM public.crm_bambini cb
     WHERE cb.alunno_id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'alunni' AND k.bloccata)
        OR cb.domanda_id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND k.bloccata);
  INSERT INTO pg_temp._azzera_lasciate
    SELECT 'crm_schede', cs.id FROM public.crm_schede cs
     WHERE cs.domanda_da_associare IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND k.bloccata);

  -- 6e bis · i GENITORI DI PROVA nati dopo la partenza (le condizioni stanno nell'intestazione di questa migrazione). Si fa DOPO gli alunni
  --          (i legami nascono accogliendo la domanda e se ne sono andati con loro) e PRIMA delle sezioni. Senza `auth.users` (un banco di prova
  --          che non lo ha) non si toglie niente: la condizione dell'email non si può verificare.
  IF to_regclass('auth.users') IS NOT NULL THEN
    INSERT INTO pg_temp._demo_genitori (parent_id, utente_id, legami)
      SELECT pr.id, pr.auth_user_id, public.demo_i_genitore_legami(pr.id, pr.auth_user_id)
        FROM public.parents pr WHERE pr.created_at >= v_dal;
    -- legato a un alunno di una sede VERA (o a un legame che non si sa leggere): non è roba della prova, non si tocca e non si elenca
    DELETE FROM pg_temp._demo_genitori g WHERE g.legami = 2;
    -- 2 · ha ancora un legame con un alunno (di prova, ma rimasto)
    UPDATE pg_temp._demo_genitori g SET ok = false WHERE g.legami <> 0;
    -- 4 · l'email dell'utente di accesso finisce in .test (senza utente di accesso non si può verificare: resta)
    UPDATE pg_temp._demo_genitori g SET ok = false
     WHERE g.ok AND NOT EXISTS (SELECT 1 FROM auth.users au WHERE au.id = g.utente_id AND right(lower(btrim(au.email)), 5) = '.test');
    -- 3 · il suo utente (se c'è) è un genitore nato dopo la partenza, con sede solo di prova
    UPDATE pg_temp._demo_genitori g SET ok = false
     WHERE g.ok AND EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = g.utente_id
                              AND (u.ruolo IS DISTINCT FROM 'genitore' OR u.creato_il IS NULL OR u.creato_il < v_dal
                                   OR (u.scuola_id IS NOT NULL AND left(u.scuola_id::text, 8) <> 'e2e00000')));
    UPDATE pg_temp._demo_genitori g SET ok = false
     WHERE g.ok AND EXISTS (SELECT 1 FROM public.utenti_scuole us WHERE us.utente_id = g.utente_id AND left(us.scuola_id::text, 8) <> 'e2e00000');
    -- Ciò che resta attaccato e una chiave NO ACTION/RESTRICT non lascerebbe cancellare (letto dal catalogo, non da un elenco): il genitore resta.
    -- Inviti con le credenziali e consensi si tolgono con lui (sotto); il resto (notifiche, push, sedi dell'utente…) va via a cascata.
    FOR fk IN
      SELECT quote_ident(ns.nspname) || '.' || quote_ident(cl.relname) AS da, c.confrelid::regclass::text AS rif,
             (c.confrelid = 'public.parents'::regclass) AS su_parents,
             (SELECT string_agg(format('x.%I = r.%I', pa.attname, rf.attname), ' AND ' ORDER BY k.ord)
                FROM unnest(c.conkey, c.confkey) WITH ORDINALITY k(a, rr, ord)
                JOIN pg_attribute pa ON pa.attrelid = c.conrelid AND pa.attnum = k.a
                JOIN pg_attribute rf ON rf.attrelid = c.confrelid AND rf.attnum = k.rr) AS cond
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       WHERE c.contype = 'f' AND ns.nspname = 'public'
         AND c.confrelid IN ('public.parents'::regclass, 'public.utenti'::regclass, 'auth.users'::regclass)
         AND c.conrelid <> c.confrelid AND c.confdeltype IN ('a', 'r')
         AND cl.relname NOT IN ('iscrizioni_inviti_credenziali', 'consensi_accettazioni')
       ORDER BY 1, c.conname
    LOOP
      EXECUTE format('UPDATE pg_temp._demo_genitori g SET ok = false WHERE g.ok AND EXISTS (SELECT 1 FROM %s r JOIN %s x ON %s WHERE r.id = %s)',
                     fk.rif, fk.da, fk.cond, CASE WHEN fk.su_parents THEN 'g.parent_id' ELSE 'g.utente_id' END);
    END LOOP;
    -- L'utente di accesso lo usa anche un altro genitore che resta: non si toglie da sotto i piedi
    UPDATE pg_temp._demo_genitori g SET ok = false
     WHERE g.ok AND EXISTS (SELECT 1 FROM public.parents p2 WHERE p2.auth_user_id = g.utente_id AND p2.id <> g.parent_id
                              AND NOT EXISTS (SELECT 1 FROM pg_temp._demo_genitori h WHERE h.parent_id = p2.id AND h.ok));

    -- chi resta si elenca, per tabella e uuid (una sola volta: può esserci già, se la sua domanda o il suo alunno se ne sono andati)
    INSERT INTO pg_temp._azzera_lasciate
      SELECT 'parents', g.parent_id FROM pg_temp._demo_genitori g
       WHERE NOT g.ok AND NOT EXISTS (SELECT 1 FROM pg_temp._azzera_lasciate la WHERE la.tabella = 'parents' AND la.id = g.parent_id);
    INSERT INTO pg_temp._azzera_lasciate
      SELECT DISTINCT 'utenti', u.id FROM pg_temp._demo_genitori g JOIN public.utenti u ON u.id = g.utente_id
       WHERE NOT g.ok AND u.creato_il >= v_dal AND NOT EXISTS (SELECT 1 FROM pg_temp._azzera_lasciate la WHERE la.tabella = 'utenti' AND la.id = u.id);
    SELECT count(*) INTO v_lasciate FROM pg_temp._demo_genitori g WHERE NOT g.ok;

    SELECT coalesce(array_agg(g.parent_id), ARRAY[]::uuid[]), coalesce(array_agg(g.utente_id) FILTER (WHERE g.utente_id IS NOT NULL), ARRAY[]::uuid[])
      INTO v_gen_par, v_gen_ute FROM pg_temp._demo_genitori g WHERE g.ok;
    -- le righe che dipendono da loro e che le chiavi non portano via: l'invito con le credenziali (l'email) e le accettazioni dei consensi (senza chiave)
    IF to_regclass('public.iscrizioni_inviti_credenziali') IS NOT NULL THEN
      DELETE FROM public.iscrizioni_inviti_credenziali ic WHERE ic.parent_id = ANY (v_gen_par) OR ic.auth_user_id = ANY (v_gen_ute);
    END IF;
    IF to_regclass('public.consensi_accettazioni') IS NOT NULL THEN
      DELETE FROM public.consensi_accettazioni cc WHERE cc.parent_id = ANY (v_gen_par);
    END IF;
    -- poi, nell'ordine delle chiavi: genitore → utente → utente di accesso
    DELETE FROM public.parents pr WHERE pr.id = ANY (v_gen_par);
    GET DIAGNOSTICS v_tolte = ROW_COUNT;
    DELETE FROM public.utenti u WHERE u.id = ANY (v_gen_ute);
    DELETE FROM auth.users au WHERE au.id = ANY (v_gen_ute);
    DELETE FROM pg_temp._azzera_lasciate la WHERE (la.tabella = 'parents' AND la.id = ANY (v_gen_par)) OR (la.tabella = 'utenti' AND la.id = ANY (v_gen_ute));
  ELSE
    v_tolte := 0; v_lasciate := 0;
  END IF;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, lasciate) VALUES ('genitori di prova nati dopo la partenza (solo email .test, senza legami né sedi vere)', v_tolte, v_lasciate);

  -- 6f · le sezioni dell'anno nuovo nate dopo la partenza; le copie (docenti, materie, orario, campanelle…) vanno via a cascata
  INSERT INTO pg_temp._azzera_cand (tabella, id)
    SELECT 'sections', se.id FROM public.sections se WHERE se.scuola_id = v_sede AND se.anno_id = v_anno_id AND se.created_at >= v_dal;
  PERFORM public.demo_i_blocca('sections',
    ARRAY['utenti_sezioni', 'utenti_sezioni_materie', 'materie', 'sezione_materia_obiettivo', 'orario_settimanale', 'campanelle',
          'tempo_scuola', 'locker_config']);
  -- sections → materie → (valutazioni, registro, scrutini…): le copie che vanno via con la materia non bloccano, il resto sì
  PERFORM public.demo_i_blocca_nipoti('sections', 'materie', 'section_id',
    ARRAY['utenti_sezioni_materie', 'sezione_materia_obiettivo', 'orario_settimanale']);
  DELETE FROM public.sections se WHERE se.id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'sections' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO pg_temp._azzera_lasciate SELECT k.tabella, k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'sections' AND k.bloccata;
  GET DIAGNOSTICS v_lasciate = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, lasciate) VALUES ('sezioni dell''anno nuovo (lasciate: ancora usate)', v_tolte, v_lasciate);

  -- 6g · gli anni nati DURANTE il collaudo, successivi all'anno nuovo (il viaggio nel tempo fa nascere al tick il 2028/29, in preparazione,
  --      con le copie di listino, moduli e posti). Se a un anno così punta altro (sezioni, frequenze, domande, voci…) il blocco si ferma
  --      con i conteggi per tabella e non tocca niente. Le chiavi esterne si leggono dal database, non da un elenco scritto qui.
  SELECT coalesce(array_agg(a.id), ARRAY[]::uuid[]), coalesce(array_agg(a.anno_id), ARRAY[]::uuid[]) INTO v_nati, v_nati_anni
    FROM public.anni_sede a
   WHERE a.scuola_id = v_sede AND a.creato_il >= v_dal AND a.id <> v_anno
     AND a.inizio > (SELECT n.inizio FROM public.anni_sede n WHERE n.id = v_anno);
  IF cardinality(v_nati) > 0 THEN
    -- Gli anni «solo di questa sede» (nessun'altra sede ha una riga su quell'anno globale): QUALUNQUE riga che punta a uno di loro è sospetta,
    -- anche in una tabella senza `scuola_id`. Per un anno globale che un'altra sede usa, valgono solo le righe di questa sede.
    SELECT coalesce(array_agg(y.id), ARRAY[]::uuid[]) INTO v_solo
      FROM unnest(v_nati_anni) y(id) WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede o WHERE o.anno_id = y.id AND o.scuola_id <> v_sede);
    v_cnt := '{}'::jsonb;
    -- (a) le chiavi verso `anni_sede`, anche su PIÙ colonne ((scuola_id, anno_id) è la forma di 25 tabelle): il filtro nasce da tutte le coppie
    --     colonna/colonna referenziata
    FOR fk IN
      SELECT quote_ident(ns.nspname) || '.' || quote_ident(cl.relname) AS da, cl.relname AS nome,
             (SELECT string_agg(CASE rf.attname
                                  WHEN 'id'        THEN format('x.%I = ANY ($1)', pa.attname)
                                  WHEN 'scuola_id' THEN format('x.%I = $3', pa.attname)
                                  WHEN 'anno_id'   THEN format('x.%I = ANY ($2)', pa.attname)
                                  ELSE format('x.%I IS NOT NULL', pa.attname) END, ' AND ' ORDER BY k.ord)
                FROM unnest(c.conkey, c.confkey) WITH ORDINALITY k(a, r, ord)
                JOIN pg_attribute pa ON pa.attrelid = c.conrelid AND pa.attnum = k.a
                JOIN pg_attribute rf ON rf.attrelid = c.confrelid AND rf.attnum = k.r) AS filtro
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       WHERE c.contype = 'f' AND c.confrelid = 'public.anni_sede'::regclass
         AND c.conrelid <> c.confrelid AND ns.nspname = 'public'
         AND cl.relname NOT IN ('listino_voci', 'moduli_richiesti', 'posti_autorizzati', 'anni_sede_stati')
       ORDER BY 2, c.conname
    LOOP
      EXECUTE format('SELECT count(*) FROM %s x WHERE %s', fk.da, fk.filtro) INTO v_n USING v_nati, v_nati_anni, v_sede;
      IF v_n > 0 THEN
        v_cnt := jsonb_set(v_cnt, ARRAY[fk.nome], to_jsonb(greatest(coalesce((v_cnt->>fk.nome)::integer, 0), v_n)));
      END IF;
    END LOOP;
    -- (b) le chiavi verso `anni_scolastici`, anche su più colonne: si legge la colonna che punta a `id`; una chiave composta che non punta a `id`
    --     non si sa leggere, e in dubbio si ferma
    FOR fk IN
      SELECT quote_ident(ns.nspname) || '.' || quote_ident(cl.relname) AS da, cl.relname AS nome,
             (SELECT pa.attname FROM unnest(c.conkey, c.confkey) k(a, rr)
                JOIN pg_attribute pa ON pa.attrelid = c.conrelid AND pa.attnum = k.a
                JOIN pg_attribute rf ON rf.attrelid = c.confrelid AND rf.attnum = k.rr AND rf.attname = 'id' LIMIT 1) AS colonna,
             EXISTS (SELECT 1 FROM pg_attribute sc WHERE sc.attrelid = c.conrelid AND sc.attname = 'scuola_id' AND NOT sc.attisdropped) AS ha_sede
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       WHERE c.contype = 'f' AND c.confrelid = 'public.anni_scolastici'::regclass
         AND c.conrelid <> c.confrelid AND ns.nspname = 'public' AND cl.relname <> 'anni_sede'
       ORDER BY 2, 3
    LOOP
      IF fk.colonna IS NULL THEN
        RAISE EXCEPTION 'AZZERA_FK_NON_LETTA: la tabella % ha una chiave verso anni_scolastici che non punta a id: non si sa leggere, si ferma', fk.nome;
      END IF;
      EXECUTE format('SELECT count(*) FROM %s x WHERE x.%I = ANY ($1)', fk.da, fk.colonna) INTO v_n USING v_solo;
      IF fk.ha_sede THEN
        EXECUTE format('SELECT count(*) FROM %s x WHERE x.scuola_id = $2 AND x.%I = ANY ($1) AND NOT (x.%I = ANY ($3))', fk.da, fk.colonna, fk.colonna)
          INTO v_tot USING v_nati_anni, v_sede, v_solo;
        v_n := v_n + v_tot;
      END IF;
      IF v_n > 0 THEN
        v_cnt := jsonb_set(v_cnt, ARRAY[fk.nome], to_jsonb(greatest(coalesce((v_cnt->>fk.nome)::integer, 0), v_n)));
      END IF;
    END LOOP;
    SELECT coalesce(string_agg(j.key || '=' || j.value, ', ' ORDER BY j.key), '') INTO v_usi FROM jsonb_each_text(v_cnt) j;
    IF v_usi <> '' THEN
      RAISE EXCEPTION 'AZZERA_ANNI_NATI_USATI: % anni nati nel collaudo hanno ancora righe attaccate (%): si guardano a mano', cardinality(v_nati), v_usi;
    END IF;
    SELECT (SELECT count(*) FROM public.listino_voci lv WHERE lv.anno_sede_id = ANY (v_nati))
         + (SELECT count(*) FROM public.moduli_richiesti mr WHERE mr.anno_sede_id = ANY (v_nati))
         + (SELECT count(*) FROM public.posti_autorizzati po WHERE po.anno_sede_id = ANY (v_nati))
         + (SELECT count(*) FROM public.anni_sede_stati st WHERE st.anno_sede_id = ANY (v_nati))
      INTO v_n;
    -- listino, moduli, posti e storia degli stati vanno via a cascata con l'anno
    DELETE FROM public.anni_sede a WHERE a.id = ANY (v_nati) AND a.scuola_id = v_sede;
    GET DIAGNOSTICS v_tolte = ROW_COUNT;
    INSERT INTO pg_temp._azzera_esito (voce, tolte) VALUES ('anni nati nel collaudo', v_tolte), ('righe di listino, moduli, posti e storia di quegli anni (a cascata)', v_n);
    -- La riga GLOBALE dell'anno (`anni_scolastici`) si toglie solo se non la punta più nessuno (un'altra sede può già averla).
    INSERT INTO pg_temp._azzera_cand (tabella, id) SELECT 'anni_scolastici', y.id FROM public.anni_scolastici y WHERE y.id = ANY (v_nati_anni);
    PERFORM public.demo_i_blocca('anni_scolastici', ARRAY[]::text[]);
    DELETE FROM public.anni_scolastici y WHERE y.id IN (SELECT k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'anni_scolastici' AND NOT k.bloccata);
    GET DIAGNOSTICS v_tolte = ROW_COUNT;
    INSERT INTO pg_temp._azzera_lasciate SELECT k.tabella, k.id FROM pg_temp._azzera_cand k WHERE k.tabella = 'anni_scolastici' AND k.bloccata;
    GET DIAGNOSTICS v_lasciate = ROW_COUNT;
    INSERT INTO pg_temp._azzera_esito (voce, tolte, lasciate) VALUES ('righe globali degli anni nati (lasciate: usate da altre sedi)', v_tolte, v_lasciate);
  END IF;

  -- 6h · le DATE dei due anni (inizio, fine, ultimo giorno aperto, «prepara il successivo dal»): un confine spostato durante il collaudo
  --      (`sposta_confine_anno`) torna dov'era. Si fa DOPO le cancellazioni (restano solo le righe che non se ne vanno) e prima di rimettere le
  --      frequenze (la loro data di uscita si valida sul periodo dell'anno). `sposta_confine_anno` rifiuta lo spostamento se nei giorni che
  --      cambiano anno ci sono righe già assegnate all'anno che li perde (CONFINE_CON_RIGHE): un UPDATE diretto non ha quel controllo, quindi lo
  --      rifà questo blocco, con le stesse tabelle del registro. Righe nate DOPO lo spostamento nei giorni spostati: si fermano qui.
  v_cnt := '{}'::jsonb;
  v_dett := '';
  FOR v_y IN
    SELECT ys.anno_id AS anno_id, ys.id AS anno_sede, ys.inizio AS cur_i, ys.fine AS cur_f, (d.dt->>'inizio')::date AS foto_i, (d.dt->>'fine')::date AS foto_f
      FROM public.anni_sede ys
      JOIN (SELECT v_anno AS id, v_foto->'date' AS dt UNION ALL SELECT v_par, v_part->'date' WHERE v_part IS NOT NULL) d ON d.id = ys.id
  LOOP
    FOR v_tab IN
      SELECT atb.tabella FROM public.anno_tabelle atb
       WHERE atb.modo = 'data' OR (atb.modo = 'dichiarato' AND (atb.colonna_data IS NOT NULL OR atb.tabella = 'frequenze'))
       ORDER BY atb.tabella
    LOOP
      -- i giorni che l'anno PERDE: prima del nuovo inizio e/o dopo la nuova fine
      FOR v_g IN
        SELECT v_y.cur_i AS dal, least(v_y.cur_f, v_y.foto_i - 1) AS al WHERE v_y.cur_i < v_y.foto_i
        UNION ALL
        SELECT greatest(v_y.cur_i, v_y.foto_f + 1), v_y.cur_f WHERE v_y.cur_f > v_y.foto_f
      LOOP
        IF v_tab.tabella = 'frequenze' THEN
          -- stesso criterio della funzione di produzione (anno, sede, ingresso O uscita nei giorni), con UNA eccezione: la data d'USCITA delle frequenze
          -- della FOTOGRAFIA non conta, perché il 6i la riscrive com'era (un passaggio confermato dopo aver allungato l'anno le ha fatte uscire proprio in
          -- quei giorni). La data d'INGRESSO conta sempre, anche per quelle della fotografia: il 6i non la rimette, quindi una frequenza il cui ingresso
          -- il collaudo ha spostato nei giorni persi resterebbe fuori dal suo anno. Quelle si guardano a mano: si rimette la data, non si cancella la riga.
          SELECT count(*) INTO v_n FROM public.frequenze fx
           WHERE fx.anno_sede_id = v_y.anno_sede AND fx.scuola_id = v_sede
             AND (fx.data_ingresso BETWEEN v_g.dal AND v_g.al
                  OR (fx.data_uscita BETWEEN v_g.dal AND v_g.al
                      AND fx.id NOT IN (SELECT (fz->>'id')::uuid FROM jsonb_array_elements(coalesce(v_part->'frequenze', '[]'::jsonb)) fz)));
        ELSE
          v_n := public.anno_conta_righe_assegnate_nei_giorni(v_tab.tabella, v_y.anno_id, v_sede, v_g.dal, v_g.al);
        END IF;
        IF v_n > 0 THEN
          v_cnt := jsonb_set(v_cnt, ARRAY[v_tab.tabella], to_jsonb(coalesce((v_cnt->>v_tab.tabella)::bigint, 0) + v_n));
          v_dett := v_dett || E'\n  anni_sede ' || v_y.anno_sede || ' (anno ' || v_y.anno_id || ') dal ' || v_g.dal || ' al ' || v_g.al || ': ' || v_tab.tabella || ' ' || v_n;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF v_cnt <> '{}'::jsonb THEN
    RAISE EXCEPTION E'AZZERA_CONFINE_CON_RIGHE: nei giorni che tornerebbero all\'altro anno ci sono righe già assegnate all\'anno che li perde (tabella → righe): %. Per anno e giorni:%\nSono righe nate o cambiate nel collaudo, datate in quei giorni: si guardano a mano, poi si rilancia', v_cnt::text, v_dett;
  END IF;
  -- Un UNICO UPDATE per tutte le righe: i vincoli di continuità e di non sovrapposizione sono differiti e si giudicano sul risultato finale.
  UPDATE public.anni_sede ys
     SET inizio = (d.dt->>'inizio')::date, fine = (d.dt->>'fine')::date,
         ultimo_giorno_aperto = (d.dt->>'ultimo_giorno_aperto')::date, prepara_successivo_dal = (d.dt->>'prepara_successivo_dal')::date
    FROM (SELECT v_anno AS id, v_foto->'date' AS dt
          UNION ALL SELECT v_par, v_part->'date' WHERE v_part IS NOT NULL) d
   WHERE ys.id = d.id
     AND (ys.inizio, ys.fine, ys.ultimo_giorno_aperto, ys.prepara_successivo_dal)
         IS DISTINCT FROM ((d.dt->>'inizio')::date, (d.dt->>'fine')::date, (d.dt->>'ultimo_giorno_aperto')::date, (d.dt->>'prepara_successivo_dal')::date);
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, rimesse) VALUES ('date degli anni rimesse come nella fotografia (anni cambiati)', v_rimesse);

  -- 6i · le frequenze dell'anno di PARTENZA com'erano nella fotografia: stato, data di uscita e «no» (il passaggio confermato fa uscire chi non
  --      ha risposto e chi ha detto «no»; un «no» registrato PRIMA della partenza resta). L'anno è di nuovo `corrente`, e lo specchio verso la
  --      scheda dell'alunno riallinea `alunni`.
  v_rimesse := 0;
  IF v_part IS NOT NULL THEN
    UPDATE public.frequenze f
       SET stato = rj.stato, data_uscita = rj.data_uscita, non_rinnova_il = rj.non_rinnova_il, non_rinnova_motivo = rj.non_rinnova_motivo
      FROM jsonb_to_recordset(v_part->'frequenze') AS rj(id uuid, stato text, data_uscita date, non_rinnova_il timestamptz, non_rinnova_motivo text)
     WHERE f.id = rj.id AND f.anno_sede_id = v_par
       AND (f.stato, f.data_uscita, f.non_rinnova_il, f.non_rinnova_motivo) IS DISTINCT FROM (rj.stato, rj.data_uscita, rj.non_rinnova_il, rj.non_rinnova_motivo);
    GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  END IF;
  INSERT INTO pg_temp._azzera_esito (voce, rimesse) VALUES ('frequenze dell''anno di partenza rimesse come nella fotografia', v_rimesse);

  -- ── 7 · LO STATO dell'anno nuovo, come nella fotografia; la cronologia degli stati scritta dopo la partenza va via ──
  UPDATE public.anni_sede a SET stato = v_foto->>'stato', domande_aperte = (v_foto->>'domande_aperte')::boolean
   WHERE a.id = v_anno AND a.scuola_id = v_sede
     AND (a.stato, a.domande_aperte) IS DISTINCT FROM (v_foto->>'stato', (v_foto->>'domande_aperte')::boolean);  -- solo se c'è qualcosa da rimettere
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  DELETE FROM public.anni_sede_stati st WHERE st.anno_sede_id = v_anno AND st.dal >= v_dal;
  GET DIAGNOSTICS v_cron = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, rimesse) VALUES ('stato e domande aperte dell''anno nuovo (tolte: righe di cronologia)', v_cron, v_rimesse);

  -- ── 8 · LA CONFIGURAZIONE come nella fotografia: stesse righe, stessi uuid. Si tolgono le righe che non c'erano, si correggono
  --      quelle cambiate, si rimettono quelle sparite. (Le spunte dei moduli delle frequenze vecchie restano: i moduli non si riscrivono.)
  -- 8a · listino
  DELETE FROM public.listino_voci l
   WHERE l.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'listino') e WHERE e->>'id' = l.id::text);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  UPDATE public.listino_voci l
     SET voce = rl.voce, fascia = rl.fascia, payment_category_id = rl.payment_category_id, importo = rl.importo, mesi = rl.mesi, scadenza = rl.scadenza
    FROM jsonb_populate_recordset(NULL::public.listino_voci, v_foto->'listino') rl
   WHERE l.id = rl.id AND l.anno_sede_id = v_anno AND to_jsonb(l) <> to_jsonb(rl);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.listino_voci
    SELECT rl.* FROM jsonb_populate_recordset(NULL::public.listino_voci, v_foto->'listino') rl
     WHERE NOT EXISTS (SELECT 1 FROM public.listino_voci lv WHERE lv.id = rl.id);
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, rimesse) VALUES ('listino (tolte: righe in più; rimesse: corrette o ricreate)', v_tolte, v_n + v_rimesse);

  -- 8b · moduli richiesti
  DELETE FROM public.moduli_richiesti mr
   WHERE mr.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'moduli') e WHERE e->>'id' = mr.id::text);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  UPDATE public.moduli_richiesti mr
     SET lista = rm.lista, codice = rm.codice, titolo = rm.titolo, ordine = rm.ordine
    FROM jsonb_populate_recordset(NULL::public.moduli_richiesti, v_foto->'moduli') rm
   WHERE mr.id = rm.id AND mr.anno_sede_id = v_anno AND to_jsonb(mr) <> to_jsonb(rm);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.moduli_richiesti
    SELECT rm.* FROM jsonb_populate_recordset(NULL::public.moduli_richiesti, v_foto->'moduli') rm
     WHERE NOT EXISTS (SELECT 1 FROM public.moduli_richiesti mr WHERE mr.id = rm.id);
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, rimesse) VALUES ('moduli richiesti (tolte: righe in più; rimesse: corrette o ricreate)', v_tolte, v_n + v_rimesse);

  -- 8c · posti autorizzati
  DELETE FROM public.posti_autorizzati po
   WHERE po.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'posti') e WHERE e->>'id' = po.id::text);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  UPDATE public.posti_autorizzati po
     SET fascia = rp.fascia, posti = rp.posti, fonte = rp.fonte
    FROM jsonb_populate_recordset(NULL::public.posti_autorizzati, v_foto->'posti') rp
   WHERE po.id = rp.id AND po.anno_sede_id = v_anno AND to_jsonb(po) <> to_jsonb(rp);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.posti_autorizzati
    SELECT rp.* FROM jsonb_populate_recordset(NULL::public.posti_autorizzati, v_foto->'posti') rp
     WHERE NOT EXISTS (SELECT 1 FROM public.posti_autorizzati po WHERE po.id = rp.id);
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  INSERT INTO pg_temp._azzera_esito (voce, tolte, rimesse) VALUES ('posti autorizzati (tolte: righe in più; rimesse: corrette o ricreate)', v_tolte, v_n + v_rimesse);

  -- I vincoli differiti di `anni_sede` (continuità, domande solo con anno aperto, periodi senza sovrapposizioni) si giudicano di solito al COMMIT:
  -- li si giudica ORA, così la prova a secco (che si ferma prima del COMMIT) cade negli stessi casi dell'esecuzione vera.
  -- (Solo i vincoli di `public` NATI differiti, e a fine controllo si rimettono differiti: la funzione va comunque chiamata da sola, non
  -- dentro un blocco di più istruzioni dell'editor, che ne risentirebbe se aveva già cambiato la modalità dei vincoli.)
  SELECT string_agg(DISTINCT quote_ident(co.conname), ', ') INTO v_differiti
    FROM pg_constraint co JOIN pg_namespace ns ON ns.oid = co.connamespace
   WHERE ns.nspname = 'public' AND co.condeferrable AND co.condeferred;
  IF v_differiti IS NOT NULL THEN
    EXECUTE 'SET CONSTRAINTS ' || v_differiti || ' IMMEDIATE';
    EXECUTE 'SET CONSTRAINTS ' || v_differiti || ' DEFERRED';   -- giudicati ora, poi rimessi come erano nati
  END IF;

  -- ── 9 · DOPO: i conti devono tornare, altrimenti il blocco si ferma e annulla tutto ────────
  SELECT count(*) INTO v_n FROM public.frequenze f WHERE f.anno_sede_id = v_anno AND f.creata_il >= v_dal;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % frequenze dell''anno nuovo dopo la partenza', v_n;
  END IF;
  IF v_part IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM jsonb_to_recordset(v_part->'frequenze') AS rj(id uuid, stato text, data_uscita date, non_rinnova_il timestamptz, non_rinnova_motivo text)
      JOIN public.frequenze f ON f.id = rj.id
     WHERE (f.stato, f.data_uscita, f.non_rinnova_il, f.non_rinnova_motivo) IS DISTINCT FROM (rj.stato, rj.data_uscita, rj.non_rinnova_il, rj.non_rinnova_motivo);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'AZZERA_CONTEGGI: % frequenze dell''anno di partenza non coincidono con la fotografia', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.frequenze f WHERE f.anno_sede_id = v_par AND f.id IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_part->'frequenze') e);
    IF v_n <> jsonb_array_length(v_part->'frequenze') THEN
      RAISE EXCEPTION 'AZZERA_CONTEGGI: delle % frequenze della fotografia ne restano %', jsonb_array_length(v_part->'frequenze'), v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.frequenze f
     WHERE f.anno_sede_id = v_par AND f.creata_il >= v_dal AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'frequenze') e WHERE e->>'id' = f.id::text);
    SELECT count(*) INTO v_tot FROM pg_temp._azzera_lasciate WHERE tabella = 'frequenze';
    IF v_n <> v_tot THEN
      RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % frequenze dell''anno di partenza nate dopo la partenza, ma le lasciate sono %', v_n, v_tot;
    END IF;
  END IF;
  SELECT count(*) INTO v_n FROM public.pagamenti pg WHERE pg.scuola_id = v_sede AND pg.anno_id = v_anno_id AND pg.creato_il >= v_dal;
  SELECT count(*) INTO v_tot FROM pg_temp._azzera_lasciate WHERE tabella = 'pagamenti';
  IF v_n <> v_tot THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % voci di pagamento dopo la partenza, ma le lasciate sono %', v_n, v_tot;
  END IF;
  SELECT count(*) INTO v_n FROM public.enrollment_submissions e WHERE e.scuola_id = v_sede AND e.anno_id = v_anno_id AND e.created_at >= v_dal;
  SELECT count(*) INTO v_tot FROM pg_temp._azzera_lasciate WHERE tabella = 'enrollment_submissions';
  IF v_n <> v_tot THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % domande dopo la partenza, ma le lasciate sono %', v_n, v_tot;
  END IF;
  SELECT count(*) INTO v_n FROM public.alunni al WHERE al.scuola_id = v_sede AND al.creato_il >= v_dal;
  SELECT count(*) INTO v_tot FROM pg_temp._azzera_lasciate WHERE tabella = 'alunni';
  IF v_n <> v_tot THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % alunni nati dopo la partenza, ma i lasciati sono %', v_n, v_tot;
  END IF;
  SELECT count(*) INTO v_n FROM public.sections se WHERE se.scuola_id = v_sede AND se.anno_id = v_anno_id AND se.created_at >= v_dal;
  SELECT count(*) INTO v_tot FROM pg_temp._azzera_lasciate WHERE tabella = 'sections';
  IF v_n <> v_tot THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % sezioni dopo la partenza, ma le lasciate sono %', v_n, v_tot;
  END IF;
  SELECT count(*) INTO v_n FROM public.anni_sede a
   WHERE a.id = v_anno AND (a.stato IS DISTINCT FROM v_foto->>'stato' OR a.domande_aperte IS DISTINCT FROM (v_foto->>'domande_aperte')::boolean);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: lo stato dell''anno nuovo non coincide con la fotografia';
  END IF;
  SELECT count(*) INTO v_n FROM public.anni_sede a
   WHERE a.scuola_id = v_sede AND a.creato_il >= v_dal AND a.inizio > (SELECT n.inizio FROM public.anni_sede n WHERE n.id = v_anno);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % anni nati dopo la partenza', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.anni_sede_stati st WHERE st.anno_sede_id = v_anno AND st.dal >= v_dal;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % righe di cronologia dell''anno nuovo dopo la partenza', v_n;
  END IF;
  -- La configurazione coincide con la fotografia, riga per riga, in entrambe le direzioni.
  SELECT (SELECT count(*) FROM public.listino_voci l WHERE l.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'listino') e WHERE e = to_jsonb(l)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'listino') e WHERE NOT EXISTS (SELECT 1 FROM public.listino_voci l WHERE l.anno_sede_id = v_anno AND to_jsonb(l) = e))
       + (SELECT count(*) FROM public.moduli_richiesti mr WHERE mr.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'moduli') e WHERE e = to_jsonb(mr)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'moduli') e WHERE NOT EXISTS (SELECT 1 FROM public.moduli_richiesti mr WHERE mr.anno_sede_id = v_anno AND to_jsonb(mr) = e))
       + (SELECT count(*) FROM public.posti_autorizzati po WHERE po.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'posti') e WHERE e = to_jsonb(po)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'posti') e WHERE NOT EXISTS (SELECT 1 FROM public.posti_autorizzati po WHERE po.anno_sede_id = v_anno AND to_jsonb(po) = e))
    INTO v_n;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: % righe di listino, moduli o posti non coincidono con la fotografia', v_n;
  END IF;

  SELECT count(*) INTO v_inv FROM public.anno_invarianti() WHERE righe <> 0;
  RAISE NOTICE 'dopo: anno nuovo % com''era alla fotografia, % invarianti non a zero', v_etichetta, v_inv;

  -- ── 10 · IL RISULTATO: solo uuid e conteggi ───────────────────────────────────────────────
  v_esito := jsonb_build_object(
    'sede', v_sede,
    'partenza', v_dal,
    'a_secco', p_prova_a_secco,
    'ripristino', jsonb_build_object('gettoni', v_r_gettoni, 'passaggi', v_r_passaggi, 'cronologia', v_r_cron, 'anni_rimessi', v_r_stati),
    'righe_non_coperte', jsonb_build_object('incassi', v_r_incassi, 'sezioni_di_anni_nati_dopo', v_r_sezioni, 'scrutinio_periodi', v_r_scrutinio),
    'cascata_dei_periodi_di_scrutinio', v_cascata,
    'incassi_su_voci_precedenti_non_toccati', v_r_incassi_fuori,
    'azzeramento', (SELECT coalesce(jsonb_agg(jsonb_build_object('voce', zx.voce, 'tolte', zx.tolte, 'rimesse', zx.rimesse, 'lasciate', zx.lasciate) ORDER BY zx.gruppo, zx.ordine), '[]'::jsonb)
                      FROM pg_temp._azzera_esito zx WHERE zx.gruppo = 0),
    'domande_tolte', (SELECT coalesce(jsonb_agg(substring(zx.voce FROM '[0-9a-f-]{36}$') ORDER BY zx.ordine), '[]'::jsonb) FROM pg_temp._azzera_esito zx WHERE zx.gruppo = 1),
    'lasciate', (SELECT coalesce(jsonb_agg(jsonb_build_object('tabella', zl.tabella, 'id', zl.id) ORDER BY zl.tabella, zl.id), '[]'::jsonb) FROM pg_temp._azzera_lasciate zl),
    'invarianti_non_a_zero', v_inv);

  -- La PROVA A SECCO: il messaggio di un'eccezione è l'unica cosa che l'editor mostra di sicuro, e l'eccezione annulla tutto.
  IF p_prova_a_secco THEN
    RAISE EXCEPTION E'DEMO_PROVA_A_SECCO: prova a secco, non è stato scritto niente. Per scrivere davvero: p_prova_a_secco = false.\n%', v_esito::text;
  END IF;

  -- Il successo si registra (l'assenza di log non distingue «tutto ok» da «non è mai partito niente»). Soli uuid e conteggi; mai un errore.
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'demo_ripristina: sede di prova riportata alla partenza', v_sede,
            'demo-ripristina:' || v_sede::text,
            jsonb_build_object('campi', jsonb_build_object('operazione', 'demo-ripristina', 'esito', 'ok',
              'incassi', v_r_incassi, 'scrutinio_periodi', v_r_scrutinio, 'gettoni', v_r_gettoni, 'passaggi', v_r_passaggi)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'demo_ripristina: riga di log non scritta [%]', SQLSTATE;
  END;
  RETURN v_esito;
END
$demo$;

-- ── demo_controllo ────────────────────────────────────────────────────────────────────────────
-- I controlli finali, di SOLA LETTURA (il passo 5 del pacchetto, generalizzato: niente uuid scritti a mano, tutto dalla fotografia).
-- Ogni riga deve avere ok = true. Senza partenza prende l'ultima fotografia salvata della sede.
CREATE OR REPLACE FUNCTION public.demo_controllo(p_scuola uuid, p_partenza timestamptz DEFAULT NULL, p_fotografia jsonb DEFAULT NULL)
RETURNS TABLE (controllo text, ok boolean, dettaglio text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $ctl$
DECLARE
  v_foto   jsonb;
  v_dal    timestamptz;
  v_part   jsonb;
  v_nuovo  uuid;
  v_nuovo_anno uuid;
  v_par    uuid;
  v_n      bigint;
  v_n2     bigint;
BEGIN
  PERFORM public.demo_i_guardia(p_scuola);
  v_foto := public.demo_i_fotografia(p_scuola, p_partenza, p_fotografia);
  v_dal := (v_foto->>'scattata_il')::timestamptz;
  v_part := CASE WHEN jsonb_typeof(v_foto->'partenza') = 'object' THEN v_foto->'partenza' END;
  SELECT a.id, a.anno_id INTO v_nuovo, v_nuovo_anno FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id
   WHERE a.scuola_id = p_scuola AND y.etichetta_breve = v_foto->>'etichetta';
  IF v_part IS NOT NULL THEN
    SELECT a.id INTO v_par FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id
     WHERE a.scuola_id = p_scuola AND y.etichetta_breve = v_part->>'etichetta';
  END IF;

  controllo := 'anno di partenza corrente, domande come alla fotografia (chiuse se la fotografia non lo dice)';
  SELECT (a.stato = 'corrente' AND a.domande_aperte = coalesce((v_part->>'domande_aperte')::boolean, false)), a.stato || '/' || a.domande_aperte INTO ok, dettaglio FROM public.anni_sede a WHERE a.id = v_par;
  ok := coalesce(ok, v_part IS NULL); dettaglio := coalesce(dettaglio, 'assente'); RETURN NEXT;

  controllo := 'anno nuovo com''era alla fotografia (stato e domande)';
  SELECT (a.stato = v_foto->>'stato' AND a.domande_aperte = (v_foto->>'domande_aperte')::boolean), a.stato || '/' || a.domande_aperte INTO ok, dettaglio FROM public.anni_sede a WHERE a.id = v_nuovo;
  ok := coalesce(ok, false); dettaglio := coalesce(dettaglio, 'assente'); RETURN NEXT;

  controllo := 'gli anni nati prima della partenza e non in corso sono chiusi';
  SELECT count(*) FILTER (WHERE a.stato <> 'chiuso') INTO v_n FROM public.anni_sede a
   WHERE a.scuola_id = p_scuola AND a.creato_il < v_dal AND a.id IS DISTINCT FROM v_par AND a.id IS DISTINCT FROM v_nuovo;
  ok := v_n = 0; dettaglio := v_n || ' non chiusi'; RETURN NEXT;

  controllo := 'nessun anno nato dopo la partenza';
  SELECT count(*) INTO v_n FROM public.anni_sede a WHERE a.scuola_id = p_scuola AND a.creato_il >= v_dal;
  ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'al più un anno corrente';
  SELECT count(*) INTO v_n FROM public.anni_sede a WHERE a.scuola_id = p_scuola AND a.stato = 'corrente';
  ok := v_n <= 1; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'frequenze dell''anno di partenza come nella fotografia';
  IF v_part IS NULL THEN
    ok := true; dettaglio := 'nessun anno di partenza'; RETURN NEXT;
  ELSE
    SELECT count(*) INTO v_n FROM jsonb_to_recordset(v_part->'frequenze') AS rj(id uuid, stato text, data_uscita date, non_rinnova_il timestamptz, non_rinnova_motivo text)
      LEFT JOIN public.frequenze f ON f.id = rj.id AND f.anno_sede_id = v_par
     WHERE f.id IS NULL OR (f.stato, f.data_uscita, f.non_rinnova_il, f.non_rinnova_motivo) IS DISTINCT FROM (rj.stato, rj.data_uscita, rj.non_rinnova_il, rj.non_rinnova_motivo);
    ok := v_n = 0; dettaglio := v_n || ' diverse'; RETURN NEXT;
  END IF;

  controllo := 'nessuna frequenza nata dopo la partenza nell''anno di partenza';
  SELECT count(*) INTO v_n FROM public.frequenze f WHERE f.anno_sede_id = v_par AND f.creata_il >= v_dal
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_part->'frequenze', '[]'::jsonb)) e WHERE e->>'id' = f.id::text);
  ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'frequenze dell''anno nuovo come alla fotografia';
  SELECT count(*) INTO v_n FROM public.frequenze f WHERE f.anno_sede_id = v_nuovo;
  ok := v_n = (v_foto->'conteggi'->>'frequenze')::bigint; dettaglio := v_n || ' (fotografia ' || (v_foto->'conteggi'->>'frequenze') || ')'; RETURN NEXT;

  controllo := 'sezioni dell''anno nuovo come alla fotografia';
  SELECT count(*) INTO v_n FROM public.sections s WHERE s.scuola_id = p_scuola AND s.anno_id = v_nuovo_anno;
  ok := v_n = (v_foto->'conteggi'->>'sezioni')::bigint; dettaglio := v_n || ' (fotografia ' || (v_foto->'conteggi'->>'sezioni') || ')'; RETURN NEXT;

  controllo := 'domande dell''anno nuovo come alla fotografia';
  SELECT count(*) INTO v_n FROM public.enrollment_submissions e WHERE e.scuola_id = p_scuola AND e.anno_id = v_nuovo_anno;
  ok := v_n = (v_foto->'conteggi'->>'domande')::bigint; dettaglio := v_n || ' (fotografia ' || (v_foto->'conteggi'->>'domande') || ')'; RETURN NEXT;

  controllo := 'voci di pagamento dell''anno nuovo come alla fotografia';
  SELECT count(*) INTO v_n FROM public.pagamenti g WHERE g.scuola_id = p_scuola AND g.anno_id = v_nuovo_anno;
  ok := v_n = (v_foto->'conteggi'->>'pagamenti')::bigint; dettaglio := v_n || ' (fotografia ' || (v_foto->'conteggi'->>'pagamenti') || ')'; RETURN NEXT;

  controllo := 'listino, moduli e posti dell''anno nuovo come alla fotografia';
  SELECT (SELECT count(*) FROM public.listino_voci l WHERE l.anno_sede_id = v_nuovo AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'listino') e WHERE e = to_jsonb(l)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'listino') e WHERE NOT EXISTS (SELECT 1 FROM public.listino_voci l WHERE l.anno_sede_id = v_nuovo AND to_jsonb(l) = e))
       + (SELECT count(*) FROM public.moduli_richiesti m WHERE m.anno_sede_id = v_nuovo AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'moduli') e WHERE e = to_jsonb(m)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'moduli') e WHERE NOT EXISTS (SELECT 1 FROM public.moduli_richiesti m WHERE m.anno_sede_id = v_nuovo AND to_jsonb(m) = e))
       + (SELECT count(*) FROM public.posti_autorizzati po WHERE po.anno_sede_id = v_nuovo AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'posti') e WHERE e = to_jsonb(po)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'posti') e WHERE NOT EXISTS (SELECT 1 FROM public.posti_autorizzati po WHERE po.anno_sede_id = v_nuovo AND to_jsonb(po) = e))
    INTO v_n;
  ok := v_n = 0; dettaglio := v_n || ' righe diverse'; RETURN NEXT;

  controllo := 'gettoni dell''anno chiuso dopo la partenza';
  SELECT count(*) INTO v_n FROM public.correzioni_anno_chiuso c WHERE c.anno_sede_id IN (SELECT a.id FROM public.anni_sede a WHERE a.scuola_id = p_scuola) AND c.creata_il >= v_dal;
  ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'passaggi dopo la partenza';
  SELECT count(*) INTO v_n FROM public.passaggi_anno p WHERE p.scuola_id = p_scuola AND p.creato_il >= v_dal;
  ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'cronologia degli stati dopo la partenza';
  SELECT count(*) INTO v_n FROM public.anni_sede_stati t WHERE t.anno_sede_id IN (SELECT a.id FROM public.anni_sede a WHERE a.scuola_id = p_scuola) AND t.dal >= v_dal;
  ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'incassi di prova (su voci nate dopo la partenza)';
  SELECT count(*) INTO v_n FROM public.incassi i JOIN public.pagamenti pg ON pg.id = i.pagamento_id
   WHERE pg.scuola_id = p_scuola AND pg.creato_il >= v_dal AND i.creato_il >= v_dal;
  ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'periodi di scrutinio nati dopo la partenza';
  SELECT count(*) INTO v_n FROM public.scrutinio_periodi sp WHERE sp.scuola_id = p_scuola AND sp.creato_il >= v_dal;
  ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'sezioni nate dopo la partenza (anni nati dopo)';
  SELECT count(*) INTO v_n FROM public.sections s WHERE s.scuola_id = p_scuola AND s.created_at >= v_dal AND s.anno_id IS DISTINCT FROM v_nuovo_anno;
  ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;

  controllo := 'nessun genitore di prova (email .test) nato dopo la partenza e senza legami';
  IF to_regclass('auth.users') IS NULL THEN
    ok := true; dettaglio := 'auth.users assente'; RETURN NEXT;
  ELSE
    SELECT count(*) INTO v_n FROM public.parents pr
     WHERE pr.created_at >= v_dal AND pr.auth_user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = pr.auth_user_id AND right(lower(btrim(au.email)), 5) = '.test')
       AND public.demo_i_genitore_legami(pr.id, pr.auth_user_id) = 0;
    ok := v_n = 0; dettaglio := v_n::text; RETURN NEXT;
  END IF;
END
$ctl$;

REVOKE ALL ON FUNCTION public.demo_i_genitore_legami(uuid, uuid)                       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.demo_ripristina(uuid, timestamptz, boolean, jsonb)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.demo_controllo(uuid, timestamptz, jsonb)                FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.demo_ripristina(uuid, timestamptz, boolean, jsonb)   TO service_role;
GRANT EXECUTE ON FUNCTION public.demo_controllo(uuid, timestamptz, jsonb)             TO service_role;
