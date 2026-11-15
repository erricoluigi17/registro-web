# CRM · porte della vendita nuova — piano di attuazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task uses superpowers:test-driven-development.

**Goal:** dare al motore di vendita (repo `kidville-oggi-vendita`, protocollo `Crm` in `motore/vendita/tipi.py`) le porte che mancano nel CRM: spostare un appuntamento in un colpo solo, la scheda completa per telefono, la scrittura di stato/riassunto/«non contattare», gli appuntamenti di un giorno, la conferma del promemoria, gli appuntamenti «non venuta» dopo un istante, e l'interruttore (spento) delle sedi vere.

**Architecture:** si allarga l'accesso AI già presente sul ramo `ripresa-crm` (rotte `src/app/api/crm/ai/**`, gate `requireIntegrazioneAi`, chiave per sede, idempotenza in `crm_ai_richieste`). Ogni scrittura nuova è una funzione SQL in una sola transazione, con lo stesso registro di idempotenza di `crm_ai_prenota`. Le letture sono query PostgREST come E2/E3. Una migrazione nuova, mai applicata: la applica l'integrazione al merge, che decide Luigi.

**Tech Stack:** Next.js (versione del repo: leggere `node_modules/next/dist/docs/` prima di scrivere una rotta), Supabase/PostgREST, zod, vitest, PGlite per le prove dell'SQL.

**Spec:** `~/Developer/kidville-oggi-vendita/docs/superpowers/specs/2026-11-15-vendita-nuova-design.md` (sezioni 5.6, 6, 7, 8, 14) e piano di regia `~/Developer/kidville-oggi-vendita/docs/superpowers/plans/2026-11-15-vendita-nuova-regia.md` (Fase 2). Contratto esistente: `docs/crm-accesso-ai.md`. Piano dell'accesso AI: `~/kidville-web/docs/superpowers/plans/2026-11-10-crm-accesso-ai.md` (sezioni «Vincoli globali», «Trappole di questo repo», «Impalcatura comune dei test delle rotte AI»: da leggere prima di ogni compito di rotta).

## Global Constraints

- Si lavora solo nel worktree `~/kidville-web/.claude/worktrees/crm-porte-vendita`, ramo `crm-porte-vendita`. Mai `main`, mai push, mai merge, mai altri worktree.
- **Nessun accesso al database vero.** Niente `apply_migration`, `execute_sql`, `psql`, `supabase db …`, niente server locale acceso con `CRM_AI_ATTIVO=1` (il server locale parla col database di produzione). Le prove dell'SQL girano in PGlite.
- Mai leggere o stampare `.env*`, chiavi, token. Mai dati personali veri nel codice, nei test, nei commit: numeri `333 000 00NN`, nomi «Famiglia Prova», «Bimbo Prova».
- Regole del repo (`AGENTS.md`): ogni rotta `export const X = withRoute('crm/ai/<percorso>:<METODO>', …)`; validazione `z.strictObject` con il messaggio «Sono presenti campi non ammessi» per le chiavi sconosciute; mai `console.*`; `catch` che non logga è un bug; PostgREST ritorna `{ error }`; mai dati personali nei log (riassunto, nomi e telefoni non entrano mai in `logEvento`).
- Il gate di ogni rotta è: `requireIntegrazioneAi` → `parseBody`/query → `assertSedeDelToken` → (letture) `ricontrollaChiaveAttiva` → lavoro → `chiudiChiamataAi`. Le scritture ricontrollano la chiave dentro la funzione SQL (`crm_ai_token_attivo`).
- Le risposte delle rotte `/api/crm/ai/*` non contengono mai nomi di genitori o bambini, note, riassunto, data di nascita completa (regola del piano del 10/11). Di un bambino al più `{id, nascita: "AAAA-MM", esito}`. Il telefono esce solo dove serve a scrivere alla famiglia: E3, appuntamenti del giorno, «non venute».
- Ogni scrittura nuova richiede l'header `Idempotency-Key` (forma `^[A-Za-z0-9_-]{8,128}$`, `chiaveIdempotenza()`): stessa chiave e stesso corpo = stessa risposta, senza riscrivere; stessa chiave e corpo diverso = `422 CHIAVE_RIUSATA`. L'impronta (`improntaCorpo`) comprende il nome dell'operazione e l'id nell'indirizzo.
- Orari e giorni sempre nel fuso di Roma con gli aiuti del repo (`dataCivile`, `inizioGiornoCivile` di `@/lib/format/confini-giorno`, `addGiorni` di `@/lib/format/data`); mai `new Date(y, m, d)` né `toLocale*` senza fuso.
- Vocabolario dello stato della famiglia, identico a `STATI` di `motore/vendita/tipi.py`, nello stesso ordine: `nuova, contattata, in_conversazione, appuntamento, confermato, venuta, non_venuta, non_risponde, non_interessata, non_contattare, a_una_persona`.
- Nome della migrazione: `supabase/migrations/20261115183417_crm_porte_vendita.sql` (orario non tondo, posteriore alle due del CRM AI). Deve poter girare due volte di fila senza errori (`IF NOT EXISTS`, `CREATE OR REPLACE`, vincoli dentro blocchi `DO`).
- Prove: `npx vitest run <file>` per il singolo file; alla fine `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`.
- Si legge con `Read`/`Grep` (le regole di `.claude/rules/` si attivano sul `Read`), le uscite lunghe passano da `head`/`tail`.
- Commit piccoli, in italiano, che finiscono con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Lo stesso appuntamento viene spostato due volte di seguito con chiavi diverse (la famiglia cambia idea): ci si aspetta un solo appuntamento, all'ultimo orario, e due eventi «spostato»; mai una seconda visita, mai la visita persa. (Compito 2)
2. Lo spostamento verso un orario in cui la persona di oggi è occupata ma una collega è libera: ci si aspetta lo spostamento con la collega e l'avviso nella sua campanella, non `SLOT_OCCUPATO`. (Compiti 2 e 5)
3. Un vecchio tentativo di `aggiorna` ripetuto con la sua chiave dopo una scrittura più nuova: ci si aspetta la risposta registrata allora, senza riscrivere lo stato nuovo. (Compiti 1 e 6)
4. Appuntamenti del giorno nel giorno del cambio d'ora (25/10/2026, 28/03/2027): ci si aspetta che il giorno vada da mezzanotte a mezzanotte di Roma, né un'ora in più né una in meno. (Compito 8)
5. Un appuntamento confermato e poi spostato: ci si aspetta la conferma azzerata (serve un nuovo promemoria); conferma su un appuntamento annullato o già passato: `409 STATO_NON_AMMESSO`. (Compiti 1, 2 e 7)

---

## Mappa dei file

| File | Cosa |
|---|---|
| `supabase/migrations/20261115183417_crm_porte_vendita.sql` | colonne nuove, registro allargato, `crm_ai_aggiorna_scheda`, `crm_ai_conferma`, `crm_ai_sposta` |
| `src/lib/crm/tipi.ts` | `STATI_FAMIGLIA_AI`, campi nuovi in `SchedaRow`/`AppuntamentoRow`, tipi degli esiti |
| `src/lib/crm/ai/interruttore.ts` | sedi vere dietro `CRM_AI_VERO` |
| `src/lib/crm/ai/accesso.ts` | operazioni nuove in `OperazioneAi` |
| `src/lib/crm/ai/contatti.ts` | scheda completa (stato, non contattare, visita con `fine`, `fissataVia`, `modificabile`, `confermata`) |
| `src/lib/crm/ai/registro.ts` (nuovo) | lettura comune del registro `crm_ai_richieste` per le scritture nuove |
| `src/app/api/crm/ai/prenotazioni/[id]/sposta/route.ts` | POST sposta |
| `src/app/api/crm/ai/prenotazioni/[id]/conferma/route.ts` | POST conferma del promemoria |
| `src/app/api/crm/ai/prenotazioni/route.ts` | GET appuntamenti di un giorno |
| `src/app/api/crm/ai/prenotazioni/non-venute/route.ts` | GET «non venuta» dopo un istante |
| `src/app/api/crm/ai/contatti/aggiorna/route.ts` | POST stato, riassunto, non contattare |
| `__tests__/lib/crm/migrazione-crm-porte-vendita-sql.test.ts` | prove PGlite delle tre funzioni |
| `__tests__/api/crm-ai-sposta.test.ts`, `crm-ai-conferma.test.ts`, `crm-ai-aggiorna.test.ts`, `crm-ai-prenotazioni-giorno.test.ts`, `crm-ai-non-venute.test.ts` | prove delle rotte |
| `docs/crm-ai-porte.md` | contratto delle porte per il motore |
| `docs/crm-accesso-ai.md`, `PRD REGISTRO ELETTRONICO.md` | allineati |

---

### Compito 1: la migrazione (colonne, registro), `crm_ai_aggiorna_scheda` e `crm_ai_conferma`

**Files:**
- Create: `supabase/migrations/20261115183417_crm_porte_vendita.sql`
- Modify: `src/lib/crm/tipi.ts`, `__tests__/architecture/soglia-fotografia.ts` (`MIGRAZIONI_ATTESE_AL_MERGE`), `__tests__/lib/crm/vocabolari-allineati.test.ts`
- Test: `__tests__/lib/crm/migrazione-crm-porte-vendita-sql.test.ts`

**Interfaces:**
- Consumes: le migrazioni esistenti; la preparazione PGlite di `__tests__/lib/crm/migrazione-crm-accesso-ai-sql.test.ts` righe 1–130 (`creaDbAnnoPr2`, `ruoliCrm`, le costanti `SEDE_A`, `INT_A`, `P1`…): copiarla, aggiungendo `migrazione('_crm_servizi_sede.sql')` e due volte `migrazione('_crm_porte_vendita.sql')`.
- Produces:
  - colonne `crm_schede.ai_stato text NULL CHECK (ai_stato IN (<STATI>))`, `crm_schede.ai_riassunto text NULL CHECK (char_length(ai_riassunto) <= 4000)`, `crm_schede.ai_aggiornata_il timestamptz NULL`, `crm_schede.non_contattare boolean NOT NULL DEFAULT false`, `crm_schede.non_contattare_il timestamptz NULL`; `crm_appuntamenti.promemoria_conferma boolean NULL`, `crm_appuntamenti.promemoria_conferma_il timestamptz NULL`;
  - `crm_ai_richieste.operazione` ammette `prenota`, `sposta`, `aggiorna_scheda`, `conferma` (il vincolo `CHECK` si sostituisce dentro un `DO`, cercandolo per definizione in `pg_constraint`);
  - `public.crm_ai_aggiorna_scheda(p_integrazione_id uuid, p_scuola_id uuid, p_chiave text, p_impronta text, p_scheda_id uuid, p_telefono_norm text, p_dati jsonb) RETURNS jsonb`;
  - `public.crm_ai_conferma(p_integrazione_id uuid, p_scuola_id uuid, p_chiave text, p_impronta text, p_appuntamento_id uuid, p_confermata boolean) RETURNS jsonb`;
  - in `tipi.ts`: `STATI_FAMIGLIA_AI` (`as const`, ordine dei Global Constraints) e `type StatoFamigliaAi`; i campi nuovi in `SchedaRow` e `AppuntamentoRow`; `EsitoAggiornaSchedaAi`, `EsitoConfermaAi` (unioni discriminate su `esito`).

Regole comuni alle due funzioni (le stesse di `crm_ai_prenota`, righe 549–571 della migrazione del 13/11): argomenti obbligatori e forme di chiave e impronta controllati con `RAISE … ERRCODE '22023'`; `crm_ai_token_attivo` falso → `{esito:'token_non_valido'}`; `pg_advisory_xact_lock(hashtextextended('crm_ai_richiesta|' || integrazione || '|' || chiave, 0))`; riga del registro con la stessa chiave: impronta diversa → `{esito:'chiave_riusata'}`, risposta nulla → `{esito:'in_corso'}`, altrimenti `risposta || {ripetuta:true}`. Solo l'esito riuscito si scrive nel registro (con `operazione`, `scheda_id` o `appuntamento_id`, `conclusa_il`): un rifiuto non scrive niente, e lo stesso tentativo ripetuto più tardi viene rivalutato. `SECURITY INVOKER`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`, `COMMENT ON FUNCTION`. Gli eventi usano `clock_timestamp()` e `autore_via = 'ai'`; nessun testo libero della famiglia negli eventi.

`crm_ai_aggiorna_scheda`: esattamente uno fra `p_scheda_id` e `p_telefono_norm` (`^[0-9]{9,10}$`). `p_dati` è un oggetto con almeno una delle chiavi `stato` (uno degli STATI), `riassunto` (testo fino a 4000; stringa vuota = cancella), `non_contattare` (solo `true`: un'AI non toglie un rifiuto, lo toglie una persona); altre chiavi o valori → `22023`. Scheda cercata nella sede, non anonimizzata, `FOR NO KEY UPDATE`; per telefono la più vecchia (`creata_il`, poi `id`) con `telefoni_norm && ARRAY[p_telefono_norm]`. Non trovata → `{esito:'non_trovata'}`. Scrive solo i campi presenti, `ai_aggiornata_il = clock_timestamp()`, `aggiornata_il = now()`, `non_contattare_il = coalesce(non_contattare_il, clock_timestamp())`. Un evento `modificata` con i soli nomi dei campi, nella stessa forma che usa la segreteria (`src/app/api/admin/crm/schede/[id]/route.ts:271`). Esito riuscito: `{esito:'aggiornata', scheda_id, stato, non_contattare}`.

`crm_ai_conferma`: l'appuntamento della sede, **fissato da chiunque** (anche la segreteria), `FOR NO KEY UPDATE`. Non trovato → `{esito:'non_trovato'}`; `stato <> 'in_programma'` o `fine <= clock_timestamp()` → `{esito:'stato_non_ammesso'}`. Scrive `promemoria_conferma`, `promemoria_conferma_il`; evento `nota` con `dati {appuntamento_id}` e testo fisso «Promemoria: la famiglia conferma l’appuntamento.» oppure «Promemoria: la famiglia non conferma l’appuntamento.». Esito: `{esito:'registrata', appuntamento_id, scheda_id, confermata}`.

- [ ] **Step 1: scrivi le prove che falliscono** in `migrazione-crm-porte-vendita-sql.test.ts`:
  - `la migrazione gira due volte senza errori` (lo fa già il `beforeAll`; un `it` che legge `pg_constraint` e trova le quattro operazioni ammesse);
  - `aggiorna per id: scrive stato e riassunto, un evento modificata con i soli nomi dei campi` → `esito 'aggiornata'`, colonne scritte, `crm_eventi.dati` senza il testo del riassunto;
  - `aggiorna per telefono trova la scheda più vecchia della sede, non quella di un'altra sede`;
  - `non_contattare true resta true e conserva il primo istante` (due chiamate con chiavi diverse; `non_contattare_il` invariato);
  - `stessa chiave e stesso corpo: risposta ripetuta, nessuna seconda scrittura` (cambia la colonna a mano fra le due chiamate e verifica che la seconda non la riscriva, e `ripetuta: true`);
  - `stessa chiave e impronta diversa: chiave_riusata`;
  - `stato fuori vocabolario, chiave sconosciuta in p_dati, non_contattare false, nessun campo: errore 22023`;
  - `scheda anonimizzata o di un'altra sede: non_trovata, registro vuoto`;
  - `chiave revocata: token_non_valido`;
  - `conferma su una visita della segreteria: registrata, nota con testo fisso`;
  - `conferma ripetuta con la stessa chiave: ripetuta, una sola nota`; `conferma false dopo true con chiave nuova: confermata false`;
  - `conferma su visita annullata, svolta o già finita: stato_non_ammesso`; `visita di un'altra sede: non_trovato`.
- [ ] **Step 2:** `npx vitest run __tests__/lib/crm/migrazione-crm-porte-vendita-sql.test.ts` → FAIL (migrazione assente).
- [ ] **Step 3:** scrivi la migrazione (colonne, vincolo del registro, due funzioni, `NOTIFY pgrst, 'reload schema';` in fondo) e i tipi in `tipi.ts`; aggiungi `STATI_FAMIGLIA_AI` alla prova dei vocabolari allineati (colonna `crm_schede.ai_stato`); dichiara il file in `MIGRAZIONI_ATTESE_AL_MERGE` con «L’integrazione applica al merge le colonne della vendita e tre funzioni CRM AI; fotografie nella PR-B.».
- [ ] **Step 4:** la prova del passo 2 passa; passano anche `npx vitest run __tests__/lib/crm __tests__/architecture __tests__/db`. Se una fotografia di colonne (`__tests__/fixtures/colonne-azzera-*`) o di migrazioni chiede di essere aggiornata, leggi il commento del suo test e segui la procedura che descrive; non rigenerarla alla cieca.
- [ ] **Step 5: commit** `CRM AI: colonne della vendita, aggiorna scheda e conferma del promemoria in SQL`.

### Compito 2: `crm_ai_sposta` in un colpo solo

**Files:**
- Modify: `supabase/migrations/20261115183417_crm_porte_vendita.sql`, `src/lib/crm/tipi.ts`
- Test: `__tests__/lib/crm/migrazione-crm-porte-vendita-sql.test.ts`

**Interfaces:**
- Consumes: `crm_ai_token_attivo`, `crm_ai_candidati(p_scuola_id, p_inizio, p_durata_min, p_candidati)`, il registro del Compito 1.
- Produces: `public.crm_ai_sposta(p_integrazione_id uuid, p_scuola_id uuid, p_chiave text, p_impronta text, p_appuntamento_id uuid, p_inizio timestamptz, p_durata_min integer, p_candidati uuid[]) RETURNS jsonb`; in `tipi.ts` `EsitoSpostaAi`.

Comportamento (dopo controlli, chiave e registro come nel Compito 1):
1. Visita `WHERE id = p_appuntamento_id AND scuola_id = p_scuola_id AND integrazione_id = p_integrazione_id AND fissato_via = 'ai'` `FOR NO KEY UPDATE` (stessa regola di `crm_ai_annulla`: l'assistente sposta solo ciò che ha fissato la sua chiave). Non trovata → `{esito:'non_trovato'}`. `stato <> 'in_programma'` o `fine <= clock_timestamp()` → `{esito:'stato_non_ammesso'}`.
2. Stesso inizio e stessa durata → `{esito:'invariata', appuntamento_id, inizio, fine, scheda_id, assegnata_a}` (registrato; nessuna scrittura né evento).
3. `p_inizio < clock_timestamp() + interval '120 minutes'` → `{esito:'fuori_disponibilita'}`. `crm_ai_candidati` vuoto → `{esito:'fuori_disponibilita'}`.
4. Candidate in ordine: prima la persona già assegnata, se è fra le candidate, poi le altre nell'ordine ricevuto. Per ciascuna, in un blocco `BEGIN … EXCEPTION WHEN exclusion_violation`, `UPDATE` della **stessa riga**: `inizio`, `fine = p_inizio + durata`, `durata_min`, `assegnata_a`, `promemoria_conferma = NULL`, `promemoria_conferma_il = NULL`, `aggiornato_il = clock_timestamp()`. È un solo `UPDATE`: la famiglia non resta mai senza posto, e se nessuna candidata è libera la visita resta com'era → `{esito:'slot_occupato'}`.
5. Eventi: `appuntamento_spostato` con `dati {appuntamento_id, inizio_prima, inizio_dopo, durata_min}`; se cambia persona anche `appuntamento_riassegnato` con `dati {appuntamento_id, assegnata_prima, assegnata_dopo}` (le stesse chiavi della segreteria, `src/app/api/admin/crm/appuntamenti/[id]/route.ts:148-165`).
6. Esito: `{esito:'spostata', appuntamento_id, inizio, fine, scheda_id, assegnata_a, assegnata_prima}`, registrato con `operazione 'sposta'`.

- [ ] **Step 1: prove che falliscono:**
  - `sposta: stessa riga, nuovo orario, conferma azzerata, evento spostato` (conta le righe di `crm_appuntamenti` della scheda: 1);
  - `due spostamenti di seguito con chiavi diverse: una visita, all'ultimo orario, due eventi` (Review Focus 1);
  - `la persona di oggi è occupata all'ora nuova: passa alla collega libera, evento riassegnato` (Review Focus 2);
  - `nessuna candidata libera: slot_occupato e la visita resta all'orario di prima`;
  - `stesso orario: invariata, nessun evento`;
  - `meno di due ore da adesso, o fuori dalle fasce: fuori_disponibilita`;
  - `visita fissata dalla segreteria o da un'altra chiave: non_trovato`; `visita annullata o passata: stato_non_ammesso`;
  - `stessa chiave: ripetuta senza secondo evento`; `stessa chiave, orario diverso: chiave_riusata`.
- [ ] **Step 2:** la prova fallisce (funzione assente).
- [ ] **Step 3:** aggiungi la funzione alla migrazione e `EsitoSpostaAi` a `tipi.ts`.
- [ ] **Step 4:** `npx vitest run __tests__/lib/crm/migrazione-crm-porte-vendita-sql.test.ts __tests__/lib/crm/migrazione-crm-accesso-ai-sql.test.ts` → PASS.
- [ ] **Step 5: commit** `CRM AI: spostare una visita in un colpo solo, in SQL`.

### Compito 3: le sedi vere dietro un interruttore spento

**Files:**
- Modify: `src/lib/crm/ai/interruttore.ts`, `src/lib/crm/ai/accesso.ts` (solo il messaggio del log «sedi ammesse vuote» se cambia condizione)
- Test: `__tests__/lib/crm/ai/interruttore.test.ts`, `__tests__/lib/crm/ai/accesso.test.ts`

**Interfaces:**
- Produces: `sediVereAi(): string[]` (da `CRM_AI_SEDI_VERE`, stesse regole di forma di `sediAmmesseAi`), `ambienteVeroAcceso(): boolean` (`process.env.CRM_AI_VERO === '1'`), e `sedeAmmessaAi(scuolaId)` che diventa: ammessa se è in `CRM_AI_SEDI_AMMESSE` **e non** in `CRM_AI_SEDI_VERE`, oppure se `CRM_AI_VERO=1` **e** è in `CRM_AI_SEDI_VERE`. `sediAmmesseAi()` resta per il controllo «nessuna sede configurata» e restituisce l'unione effettivamente ammessa.

Senza `CRM_AI_VERO=1` nessuna sede elencata fra le vere entra, anche se qualcuno la scrive per sbaglio fra le ammesse. La chiave resta una per sede (indice `crm_integrazioni_una_attiva_per_sede`): non si tocca.

- [ ] **Step 1: prove che falliscono** in `interruttore.test.ts`: `sede vera rifiutata a interruttore spento anche se è fra le ammesse`; `sede vera ammessa con CRM_AI_VERO=1`; `CRM_AI_VERO=1 non apre una sede che non è in nessun elenco`; `la Demo resta ammessa con l'interruttore spento`; `CRM_AI_VERO diverso da "1" (es. "true", "0") vale spento`. In `accesso.test.ts`: `una chiave di una sede vera, interruttore spento: 403 SEDE_NON_AMMESSA`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** implementa in `interruttore.ts`.
- [ ] **Step 4:** `npx vitest run __tests__/lib/crm/ai __tests__/lib/middleware-crm-ai.test.ts` → PASS.
- [ ] **Step 5: commit** `CRM AI: le sedi vere entrano solo con CRM_AI_VERO acceso (spento di default)`.

### Compito 4: la scheda completa per telefono (E2 allargata)

**Files:**
- Modify: `src/lib/crm/ai/contatti.ts`, `src/app/api/crm/ai/contatti/stato/route.ts`, `src/app/api/crm/ai/contatti/route.ts` e `src/app/api/crm/ai/contatti/nuovi/route.ts` (solo per il nuovo parametro di `dettagliSchede`), `src/lib/crm/ai/accesso.ts` (`OperazioneAi` con tutte le operazioni nuove: `'sposta' | 'aggiorna_scheda' | 'conferma' | 'prenotazioni_giorno' | 'non_venute'`)
- Test: `__tests__/api/crm-ai-contatti.test.ts`, `__tests__/api/crm-ai-privacy-integrazione.test.ts` se fissa la forma

**Interfaces:**
- Consumes: le colonne del Compito 1.
- Produces:
  - `dettagliSchede(supabase, scuolaId, schedaIds, adesso, operazione, integrazioneId: string)`; `VisitaAi` diventa `{id, inizio, fine, stato, fissataVia: 'segreteria' | 'ai', modificabile: boolean, confermata: boolean | null}` con `modificabile = fissato_via === 'ai' && integrazione_id === integrazioneId && stato === 'in_programma'`; ogni bambino `{id, nascita, esito}`.
  - risposta 200 di `POST /api/crm/ai/contatti/stato`: `{esiste: true, schedaId, creatoVia, stato: StatoFamigliaAi | null, nonContattare: boolean, visita, bambini}`; senza scheda `{esiste: false, schedaId: null, creatoVia: null, stato: null, nonContattare: false, visita: null, bambini: []}`. Si aggiunge `fine` alla select delle visite e `ai_stato, non_contattare` a quella di `schedaPerTelefono`.

La regola della visita resta quella di `visitaDi` (la prima in programma che deve ancora finire, altrimenti l'ultima non annullata), qualunque sia chi l'ha fissata.

- [ ] **Step 1: prove che falliscono** in `crm-ai-contatti.test.ts` (blocco E2): `visita fissata a mano dalla segreteria: compare, fissataVia segreteria, modificabile false`; `visita fissata da questa chiave: modificabile true`; `stato e nonContattare dalla scheda`; `scheda senza stato: stato null, nonContattare false`; `nessun nome, nota o riassunto nella risposta` (usa `nessunNomeIn` con il nome del genitore, del bambino e una frase del riassunto messi nel finto database).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** implementa; aggiorna i test di E1/E3 che controllano la forma esatta di `visita`.
- [ ] **Step 4:** `npx vitest run __tests__/api/crm-ai-contatti.test.ts __tests__/api/crm-ai-privacy-integrazione.test.ts __tests__/architecture` → PASS.
- [ ] **Step 5: commit** `CRM AI: la scheda per telefono dice stato, non contattare e chi ha fissato la visita`.

### Compito 5: `POST /api/crm/ai/prenotazioni/{id}/sposta`

**Files:**
- Create: `src/app/api/crm/ai/prenotazioni/[id]/sposta/route.ts`, `src/lib/crm/ai/registro.ts`
- Test: `__tests__/api/crm-ai-sposta.test.ts`

**Interfaces:**
- Consumes: `crm_ai_sposta` (Compito 2), `caricaAgendaAi`, `candidatiPer`, `notificaVisitaAssegnata`, `chiaveIdempotenza`, `improntaCorpo`.
- Produces:
  - `src/lib/crm/ai/registro.ts`: `leggiRichiestaAi(supabase, ai: ContestoAi, chiave: string, operazione: string): Promise<{ riga: { impronta: string; risposta: unknown } | null } | { response: NextResponse }>` (la lettura che oggi `prenota/route.ts:126-131` fa a mano; `prenota` non si tocca).
  - Rotta: `{id}` UUID nell'indirizzo; corpo `z.strictObject({sede: zUuid, inizio: istante, fine: istante})` con la stessa validazione degli istanti di `prenota/route.ts:21-23` e `fine > inizio`; `Idempotency-Key` obbligatoria; impronta `improntaCorpo({operazione: 'sposta', id, sede, inizio, fine})` con gli istanti in ISO.

Percorso: gate `'sposta'` → corpo → sede → chiave → registro (impronta diversa → 422 `CHIAVE_RIUSATA`; risposta registrata → la si ripete con `ripetuta: true`) → agenda del giorno del nuovo inizio → `candidatiPer(agenda.liberi, …) ?? candidatiPer(agenda.inFascia, …)` (la seconda serve quando il nuovo orario si sovrappone alla visita stessa: decide l'SQL) → nessuna coppia → 422 `FUORI_DISPONIBILITA` → `rpc('crm_ai_sposta', …)`.

| esito SQL | HTTP |
|---|---|
| `spostata` | 200 `{id, inizio, fine, schedaId, invariata: false, ripetuta}`; se `assegnata_a ≠ assegnata_prima` e non ripetuta, `notificaVisitaAssegnata` alla nuova persona; log `ai-visita-spostata` |
| `invariata` | 200 `{id, inizio, fine, schedaId, invariata: true, ripetuta}` |
| `non_trovato` | 404 `ELEMENTO_NON_TROVATO` |
| `stato_non_ammesso` | 409 `STATO_NON_AMMESSO` |
| `slot_occupato` | 409 `SLOT_OCCUPATO` |
| `fuori_disponibilita` | 422 `FUORI_DISPONIBILITA` |
| `chiave_riusata` | 422 `CHIAVE_RIUSATA` |
| `in_corso` | 409 `CRM_OPERAZIONE_NON_RIUSCITA` |
| `token_non_valido` | 401 `TOKEN_NON_VALIDO` con `WWW-Authenticate: Bearer` |
| altro / errore | 500 come `prenota` |

- [ ] **Step 1: prove che falliscono** (impalcatura del piano del 10/11, sezione «Impalcatura comune dei test delle rotte AI»; modello `__tests__/api/crm-ai-prenota.test.ts`): una per riga della tabella; `senza Idempotency-Key: 400`; `campo in più nel corpo: 400 senza ripeterne il nome`; `sede diversa dalla chiave: 403 SEDE_NON_ACCESSIBILE`; `id non UUID: 400`; `interruttore spento: 404 senza toccare il database`; `replay: nessuna seconda notifica`; `cambio di persona: una notifica alla nuova persona` (Review Focus 2); `gli argomenti passati all'rpc: p_inizio ISO, p_durata_min dalla coppia, p_candidati dall'agenda`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** implementa `registro.ts` e la rotta.
- [ ] **Step 4:** `npx vitest run __tests__/api/crm-ai-sposta.test.ts __tests__/architecture` → PASS (i lock `crm-ai-gate`, `logging-coverage`, `zod-coverage`, `errori-con-codice`, `isolamento-sede-coverage` vedono la rotta nuova; se uno chiede di dichiararla in un elenco, dichiarala).
- [ ] **Step 5: commit** `CRM AI: la rotta per spostare una visita`.

### Compito 6: `POST /api/crm/ai/contatti/aggiorna`

**Files:**
- Create: `src/app/api/crm/ai/contatti/aggiorna/route.ts`
- Test: `__tests__/api/crm-ai-aggiorna.test.ts`

**Interfaces:**
- Consumes: `crm_ai_aggiorna_scheda` (Compito 1), `leggiRichiestaAi` (Compito 5), `normalizzaTelefonoAi`, `STATI_FAMIGLIA_AI`.
- Produces: corpo `z.strictObject({sede: zUuid, schedaId: zUuid.optional(), telefono: z.string().trim().min(6).max(40).optional(), stato: z.enum(STATI_FAMIGLIA_AI).optional(), riassunto: z.string().trim().max(4000).optional(), nonContattare: z.literal(true).optional()})`, con esattamente uno fra `schedaId` e `telefono` e almeno uno fra `stato`, `riassunto`, `nonContattare` (altrimenti 400). `Idempotency-Key` obbligatoria; impronta `improntaCorpo({operazione: 'aggiorna_scheda', ...corpo, telefono: <normalizzato>})`. Il riassunto non entra mai in log, impronta a parte.

| esito SQL | HTTP |
|---|---|
| `aggiornata` | 200 `{schedaId, stato, nonContattare, ripetuta}` |
| `non_trovata` | 404 `SCHEDA_NON_TROVATA` |
| `chiave_riusata` / `in_corso` / `token_non_valido` | come Compito 5 |
| telefono non normalizzabile | 422 `CONTATTO_OBBLIGATORIO`, prima dell'rpc |

- [ ] **Step 1: prove che falliscono:** una per riga; `schedaId e telefono insieme, o nessuno dei due: 400`; `nessun campo da scrivere: 400`; `nonContattare false: 400`; `stato fuori vocabolario: 400`; `+39 333 000 0001 arriva all'rpc come 3330000001`; `replay con la stessa chiave: risposta registrata, rpc non chiamata` (Review Focus 3); `il riassunto non compare in nessuna riga di log` (spia su `logEvento`/registro come in `crm-ai-privacy-integrazione.test.ts`).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** `npx vitest run __tests__/api/crm-ai-aggiorna.test.ts __tests__/architecture` → PASS.
- [ ] **Step 5: commit** `CRM AI: scrivere stato, riassunto e «non contattare» sulla scheda`.

### Compito 7: `POST /api/crm/ai/prenotazioni/{id}/conferma`

**Files:**
- Create: `src/app/api/crm/ai/prenotazioni/[id]/conferma/route.ts`
- Test: `__tests__/api/crm-ai-conferma.test.ts`

**Interfaces:**
- Consumes: `crm_ai_conferma` (Compito 1), `leggiRichiestaAi`.
- Produces: corpo `z.strictObject({sede: zUuid, confermata: z.boolean()})`; `Idempotency-Key` obbligatoria; impronta `improntaCorpo({operazione: 'conferma', id, sede, confermata})`. `registrata` → 200 `{id, confermata, ripetuta}`; `non_trovato` → 404 `ELEMENTO_NON_TROVATO`; `stato_non_ammesso` → 409 `STATO_NON_AMMESSO`; gli altri come Compito 5. Nessuna notifica: l'avviso alla sede lo manda il motore.

- [ ] **Step 1: prove che falliscono:** una per esito; `confermata mancante o non booleana: 400`; `replay: rpc non chiamata`; `visita della segreteria: 200` (il finto rpc risponde `registrata`; la regola vera è provata nel Compito 1).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** `npx vitest run __tests__/api/crm-ai-conferma.test.ts __tests__/architecture` → PASS.
- [ ] **Step 5: commit** `CRM AI: la conferma del promemoria sulla visita`.

### Compito 8: le due letture — appuntamenti del giorno e «non venute»

**Files:**
- Create: `src/app/api/crm/ai/prenotazioni/route.ts` (GET), `src/app/api/crm/ai/prenotazioni/non-venute/route.ts` (GET)
- Test: `__tests__/api/crm-ai-prenotazioni-giorno.test.ts`, `__tests__/api/crm-ai-non-venute.test.ts`

**Interfaces:**
- Consumes: le colonne del Compito 1; `ricontrollaChiaveAttiva`; il cursore di `contatti/nuovi/route.ts:37-68` (stesso filtro `or(...)`, stessa validazione di `dopo`/`dopoId`).
- Produces:
  - `GET /api/crm/ai/prenotazioni?sede=<uuid>&giorno=AAAA-MM-GG` (operazione `prenotazioni_giorno`): visite `in_programma` della sede con `inizio` in `[inizioGiornoCivile(giorno), inizioGiornoCivile(addGiorni(giorno, 1)))`, ordinate per `inizio`, `id`, di chiunque le abbia fissate. 200 `{sede, giorno, prenotazioni: [{id, schedaId, inizio, fine, fissataVia, modificabile, confermata, telefono, nonContattare}]}` con `Cache-Control: no-store`. `telefono` = primo di `telefoni_norm` della scheda (o `null`, anche per una scheda anonimizzata). Due query (visite, poi schede `in` gli id), con il controllo del tetto di 1.000 righe come `dettagliSchede` → 500.
  - `GET /api/crm/ai/prenotazioni/non-venute?sede=<uuid>&dopo=<ISO con fuso>&dopoId=<uuid facoltativo>` (operazione `non_venute`): visite della sede con `stato = 'non_presentato'` e `segnato_il` dopo il cursore (`segnato_il`, poi `id`), fino a 100. 200 `{prenotazioni: [{id, schedaId, inizio, segnataIl, telefono, nonContattare}], prossimoDopo, prossimoDopoId}`, cursori `null` a pagina vuota, `Cache-Control: no-store`.

- [ ] **Step 1: prove che falliscono.** Giorno: `solo le in_programma del giorno, anche quelle della segreteria`; `annullate, svolte, del giorno dopo e di un'altra sede escluse`; `giorno del cambio d'ora 2026-10-25: una visita alle 00:30 e una alle 23:30 di Roma entrano, una alle 00:30 del 26 no` e lo stesso per `2027-03-28` (Review Focus 4); `giorno malformato o parametro in più: 400`; `telefono e nonContattare dalla scheda, nessun nome`; `chiave revocata dopo il gate: 401`. Non venute: `ordine e cursore come E3, anche a parità di istante`; `solo non_presentato, solo la sede della chiave`; `pagina vuota: cursori null`; `dopo senza fuso: 400`.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** `npx vitest run __tests__/api/crm-ai-prenotazioni-giorno.test.ts __tests__/api/crm-ai-non-venute.test.ts __tests__/architecture` → PASS.
- [ ] **Step 5: commit** `CRM AI: gli appuntamenti di un giorno e le visite «non venuta»`.

### Compito 9: contratto, documentazione, PRD, gate intero, prova in sviluppo

**Files:**
- Create: `docs/crm-ai-porte.md`
- Modify: `docs/crm-accesso-ai.md` (le API diventano dodici; rimando al nuovo documento; le due variabili nuove), `PRD REGISTRO ELETTRONICO.md` (voce di changelog datata 15/11/2026 sul modello di quelle del CRM AI: stato 🟡, migrazione attesa al merge, interruttore spento)

**Interfaces:**
- Consumes: tutte le rotte.
- Produces: `docs/crm-ai-porte.md`, il contratto che legge la Fase 4 del motore: per ogni porta che il protocollo `Crm` usa (`slot`, `prenota`, `sposta`, `annulla`, scheda per telefono, `aggiorna`, `richiami`, appuntamenti del giorno, `conferma`, `non-venute`, `contatti`, `contatti/nuovi`) rotta, parametri, risposta, errori, esempio `curl` con dati inventati (`<uuid della sede>`, `333 000 0001`); una tabella «metodo del protocollo `Crm` → porta»; la sezione «Ambiente vero» (`CRM_AI_SEDI_VERE`, `CRM_AI_VERO`, spento; una chiave per sede creata dalla Direzione in CRM → Assistente; si accende solo col sì di Luigi); le fasce per sede (rimando a «Servizi offerti dalla sede» di `docs/crm-accesso-ai.md`: nido dai 3 mesi e infanzia in tutte e tre, primaria solo Giugliano e Cesa, età contata a settembre); la regola di idempotenza; la nota «la migrazione non è applicata: fino al merge le porte nuove rispondono `503 CRM_NON_INSTALLATO`».

- [ ] **Step 1:** verifica senza scrivere codice che le fasce siano già quelle decise: `migrazione-crm-servizi-sede-sql.test.ts` e `eta.test.ts` devono contenere Aversa senza primaria e il nido dai 3 mesi a settembre; se un caso manca, aggiungi la prova (non il codice).
- [ ] **Step 2:** scrivi `docs/crm-ai-porte.md`, aggiorna `docs/crm-accesso-ai.md` e il PRD.
- [ ] **Step 3: gate:** `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`, `npm run build` → tutti verdi (riporta i numeri).
- [ ] **Step 4: prova in sviluppo senza database:** `npx next dev -p 3117` **senza** `CRM_AI_ATTIVO` (spento: le rotte non leggono e non scrivono il database); con `curl` ogni rotta nuova risponde `404` con `codice: "CRM_AI_SPENTO"`. Poi ferma il server. Nessuna prova con l'interruttore acceso: il server locale parla col database di produzione.
- [ ] **Step 5: commit** `CRM AI: contratto delle porte della vendita, documentazione e PRD`.

---

## Cosa resta a Luigi (non si fa qui)

- Applicare la migrazione (al merge di `ripresa-crm` e di questo ramo) e la prova vera sulla sede Demo (Compito 12 del piano del 10/11).
- Accendere `CRM_AI_VERO` e creare le chiavi delle tre sedi vere, all'accensione.

## Scelte di Claude (si possono cambiare)

- L'assistente sposta solo le visite fissate dalla sua chiave, come già per l'annullamento; la scheda dice `modificabile: false` per quelle della segreteria, così il motore passa la famiglia a una persona.
- La conferma del promemoria vale anche per le visite fissate dalla segreteria.
- `non_contattare` l'assistente lo mette ma non lo toglie.
- Le risposte continuano a non contenere nomi, note né riassunto (regola del 10/11); il motore tiene i nomi nella sua copia della scheda.
- Nel registro di idempotenza entra solo l'esito riuscito delle scritture nuove: un rifiuto non scrive niente e si può ritentare con la stessa chiave.
- Le sedi vere hanno un elenco e un interruttore propri (`CRM_AI_SEDI_VERE`, `CRM_AI_VERO`), separati da quelli della Demo.
