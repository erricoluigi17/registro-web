# Accesso dell'assistente AI al CRM — piano di implementazione

> **Per chi esegue (agentic workers):** SOTTO-SKILL OBBLIGATORIA: `superpowers:subagent-driven-development`
> (consigliata) oppure `superpowers:executing-plans`. Si lavora compito per compito; i passi usano le
> caselle (`- [ ]`). Ogni compito si chiude col suo commit. **Prima di cominciare leggi per intero
> «Vincoli globali», «Trappole di questo repo» e il tuo compito.** Chi esegue un compito vede solo quello:
> i nomi e i tipi che usano i compiti vicini stanno nel blocco **Interfacce**.

**Obiettivo (Goal):** dare all'assistente automatico di Kidville (un programma che gira sul Mac del
titolare) una porta sua dentro il CRM della segreteria: legge gli orari liberi, fissa e annulla una
visita, registra una famiglia nuova senza doppioni, la mette fra i «Da richiamare». Tutto spento finché
il titolare non lo accende, e acceso solo sulla sede Demo.

**Architettura (Architecture):** sette rotte nuove sotto `/api/crm/ai/`, senza sessione utente: si
entra con una chiave (`Authorization: Bearer …`), una per sede, di cui il database conserva solo
l'impronta (SHA-256). Un gate unico, `requireIntegrazioneAi`, controlla nell'ordine: interruttore,
chiave, sede ammessa, limite di chiamate. Gli orari liberi li calcola il codice che c'è già
(`calcolaSlotLiberi`, `src/lib/crm/slot.ts:127`); la prenotazione la scrive **una funzione del
database** in una sola transazione (`crm_ai_prenota`), così la stessa richiesta non vale due volte, la
stessa famiglia non nasce due volte e due persone non prendono lo stesso orario. Tre rotte per la
Direzione sotto `/api/admin/crm/integrazioni` creano e revocano le chiavi.

**Tecnologie (Tech Stack):** Next.js 16.3.0 (**prima di scrivere una rotta leggi la guida in
`node_modules/next/dist/docs/`**: questa versione ha cambiamenti rispetto a quelle note), Supabase /
PostgREST (`@supabase/supabase-js` 2.x), funzioni `plpgsql`, zod 4, next-intl, vitest 4, PGlite
(`@electric-sql/pglite`, già nel repo) per eseguire l'SQL nei test.

**Specifiche (Spec):**

- `docs/superpowers/specs/2026-10-30-crm-segreteria-design.md` — il CRM. Il paragrafo **§8** descrive
  questo accesso; §2 (anti-obiettivi), §3 (vincoli), §6 (modello) e §12 (verifiche) valgono qui.
- La specifica dell'assistente, **fuori dal repo** (sul Mac del titolare, cartella iCloud
  `KIDVILLE BRAIN/30 MARKETING/2026-11 agenti-vendita/01_agenti-vendita_progetto_2026-11_TUTTE-LE-SEDI.md`,
  paragrafi 2, 5, 6, 7, 8). Chi esegue **non la deve aprire**: tutto quello che serve è ricopiato qui
  sotto, in «Cosa chiede l'assistente in più».

**Scadenza:** provato sulla sede Demo entro il **30/11/2026**.

---

## Cosa chiede l'assistente in più (eccezioni volute alla specifica CRM)

La specifica CRM §8 dice: «L'AI **non legge** le schede esistenti». Il titolare il 10/11/2026 ha
approvato un assistente che ha bisogno di quattro cose in più. Sono **eccezioni volute**, e sono le
uniche:

| # | Eccezione | Perché serve | Rotta | Cosa NON restituisce |
|---|---|---|---|---|
| E1 | Creare la scheda di una famiglia nuova **senza fissare una visita** | Il «Primo contatto» registra ogni lead appena arriva, prima di sapere se verrà in visita | `POST /api/crm/ai/contatti` | nomi, note |
| E2 | Sapere se un numero ha già una scheda e una visita | Per non scrivere due volte alla stessa famiglia e per mandare solo il promemoria | `POST /api/crm/ai/contatti/stato` | nomi di genitori e bambini, note, esiti |
| E3 | Elencare i contatti messi a mano dalla segreteria dopo una certa ora | Anche loro devono ricevere il primo messaggio | `GET /api/crm/ai/contatti/nuovi` | nomi di genitori e bambini, note |
| E4 | Mettere una famiglia nella lista «Da richiamare» | È il «passaggio a una persona» | `POST /api/crm/ai/richiami` | niente oltre agli id |
| E5 | Leggere la nota di una visita, solo per scrivere un richiamo | I richiami automatici (non ancora decisi) | — | **FASE SUCCESSIVA: progettata in fondo, non si costruisce ora** |

In nessuna risposta di nessuna rotta `/api/crm/ai/*` compare il **nome di un bambino**, il nome di un
genitore, una nota o il giorno di nascita. Di un bambino esce al più `{ id, nascita: "AAAA-MM" }`
(anno e mese). Il telefono esce **solo** in E3, perché il programma deve sapere a chi scrivere.

---

## Vincoli globali (Global Constraints)

Valgono per **ogni** compito, anche quando il compito non li ripete.

- **Lingua.** Commenti, messaggi di commit, testi dell'interfaccia e questo piano sono in italiano.
  Ogni stringa mostrata a schermo ha la sua gemella in `messages/en/`.
- **Ramo.** Si lavora sul ramo `crm-accesso-ai`, in un **worktree a parte** (vedi «Prima di
  cominciare»). **Mai** un commit su `main`. ⚠️ **È un'eccezione dichiarata alla regola 1 di `AGENTS.md`**
  («non si crea un branch nuovo a ogni attività: si continua sul branch secondario esistente»): la regia
  del progetto dell'assistente ha chiesto un ramo a parte, perché questo lavoro resta fermo in attesa del
  sì del titolare e non deve bloccare né essere trascinato dagli altri rami aperti (in questi giorni il
  checkout principale e altri worktree portano il lavoro sull'anno scolastico). Vale solo per questo
  piano. Restano vere le altre regole di `AGENTS.md`: PRD aggiornato nello stesso lavoro, log, gate; e,
  **dopo** un rilascio andato a buon fine, si elimina **questo** ramo (locale e remoto) — non i rami
  delle altre sessioni, che non sono tuoi. La PR-B nasce su un ramo nuovo, come vuole la stessa regola
  («un nuovo branch solo dopo un deploy andato a buon fine»). **Nessun merge, nessun deploy, nessuna migrazione sul
  database vero**: sono il Compito 12, che parte solo dopo il sì scritto del titolare.
- **Database di produzione: non si tocca.** Niente `apply_migration`, niente `execute_sql` che scrive,
  niente `supabase db query`, niente `psql`. Nessuna lettura di dati veri di famiglie o bambini. I test
  usano il database finto (`__tests__/fixtures/finto-supabase.ts`) e PGlite.
- **Segreti.** Mai aprire `.env*`. Mai stampare o scrivere in un file una chiave, un token o una
  password. Nei test il token è una costante finta (`'kvai_' + 'A'.repeat(43)`).
- **Repository pubblico, dati di minori.** Mai nomi, telefoni o email veri in codice, test, commenti,
  commit o documenti. Nei test: «Famiglia Prova», «Bimbo Prova», il numero finto `333 000 0001`,
  `prova@example.com`, le sedi `SEDE_A` / `SEDE_B` di `__tests__/fixtures/sedi.ts`. **Mai l'uuid di
  una sede vera** in nessun file (lock `migrazioni-senza-sede-cablata`, che legge anche `.claude/`).
- **Rotte.** Ogni export HTTP è `export const METODO = withRoute('<percorso>:<METODO>', async (…) => …)`
  (`src/lib/logging/with-route.ts:103`). Il gate è la **prima** istruzione dell'handler e viene
  **prima** di `parseBody`/`parseQuery` e di ogni `.from(`/`.rpc(`. Ingressi validati con zod
  (`parseBody`, `parseQuery`, `parseData` di `src/lib/validation/http.ts:87-183`), schemi `.strict()`.
- **PostgREST non lancia.** Ogni `await supabase.from(…)`/`.rpc(…)` torna `{ data, error }`: si guarda
  `error`, sempre. Un `try/catch` attorno non scatta mai.
- **Sede.** Ogni lettura d'elenco e ogni scrittura su una tabella `crm_*` porta
  `.eq('scuola_id', ai.scuolaId)` **nella stessa catena**; ogni `.insert(` porta `scuola_id:`; ogni
  `.rpc('crm_ai_…')` porta `p_scuola_id`. La sede è **quella della chiave**, mai quella scritta nella
  richiesta: la richiesta la dichiara soltanto, e se non coincide è `403`.
- **Log.** Mai `console.*`. Solo `logEvento('crm', livello, campi, err?)` e `logErrore`
  (`src/lib/logging/logger.ts:475,577`). Nei campi **solo**: `operazione`, `esito`, `stato` (numero),
  `error_code`, `scuola_id`, `entita_id`, `integrazione_id`, `ms`, `n`. Mai telefono, nome, email,
  nota, data di nascita, token, impronta. Ogni chiamata lascia **una riga anche quando va bene**
  (l'area `'crm'` è persistita in `app_log`: `logger.ts:188-261`). Un `catch` che non logga è un bug.
- **Risposte d'errore.** Sempre `{ error: <frase>, codice: <CODICE> }`. Ogni `codice` sta in
  `CODICI_ERRORE` (`src/lib/ui/esito-fetch.ts:72`) e ha la frase in `messages/it/shared.json` **e**
  `messages/en/shared.json`. Il testo di un errore del database (`error.message`) non torna mai a chi
  chiama: si usa `rispostaErroreDb` / `rispostaErroreDbSchema` (`src/lib/crm/errori.ts:79,105`).
- **Date.** Gli orari sono di Roma. Mai `new Date(anno, mese, giorno)`, `getDay()`, `getHours()`,
  `getFullYear()`, `toLocale*String` senza fuso. Si usano `dataCivile` (`src/i18n/config.ts:118`),
  `istanteCivile` / `inizioGiornoCivile` (`src/lib/format/confini-giorno.ts:91,107`), `addGiorni`
  (`src/lib/format/data.ts:63`).
- **Niente `.upsert(`** sulle due tabelle nuove (il lock `onconflict-arbitro` non le conosce ancora):
  solo `.insert()`, `.update()` e le `rpc`.
- **Migrazione.** Un solo file nuovo. Nessun `DROP`, `DELETE`, `TRUNCATE`. La applica l'integrazione
  Supabase al merge, mai a mano.
- **Costanti fissate da questo piano** (non cambiarle senza dirlo nel rapporto):
  prefisso della chiave `kvai_`; chiave = `kvai_` + 43 caratteri base64url (32 byte casuali);
  limite **60 chiamate al minuto** per chiave; anticipo minimo di una prenotazione **120 minuti**;
  intervallo massimo di ricerca orari **31 giorni**; al più **60** orari per risposta; al più **100**
  contatti per risposta; chiave di idempotenza: header `Idempotency-Key`, forma `^[A-Za-z0-9_-]{8,128}$`.
- **Interruttori** (variabili d'ambiente, **assenti = spento**): `CRM_AI_ATTIVO` (vale solo `1`) e
  `CRM_AI_SEDI_AMMESSE` (uuid di sede separati da virgola). Non vanno in `variabiliCritiche()` di
  `src/instrumentation.ts`: sono facoltative.

### Trappole di questo repo (già pagate da altri)

1. **`vitest run <file che non esiste>` esce 0.** Dopo ogni corsa leggi la riga `Test Files N passed`
   e controlla che `N` sia quello atteso.
2. **`comando | tail; echo $?` riporta l'uscita di `tail`.** Non mettere pipe dopo vitest quando ti
   serve l'esito. In zsh `PIPESTATUS` non esiste.
3. **`--reporter=basic` non esiste in vitest 4.**
4. **Un test con un finto «piatto» è verde con e senza il codice.** Dopo il verde, rompi di proposito
   la riga che il test deve difendere e guardalo diventare rosso; poi rimetti a posto.
5. **Lock «dati personali nei documenti»** (`__tests__/architecture/pii-nei-file-tracciati.test.ts:212`):
   in un file `.md` o `.txt` tracciato, la parola `telefono`, `data_nascita` o `indirizzo` seguita da
   `:` o `=` e da un valore **fra virgolette** fa cadere il lock. Nei documenti che scrivi (PRD,
   `docs/crm-accesso-ai.md`) usa i segnaposto `"{{telefono}}"`. Per lo stesso motivo in questo piano i
   test mettono il numero finto in una costante `TEL` e scrivono `telefono: TEL`.
6. **Il worktree nuovo non ha `.env.local`** e non deve averlo: `vitest`, `eslint` e `tsc` non ne hanno
   bisogno. Se `npm run build` lo pretende, **fermati e scrivilo nel rapporto**: non copiare il file.
7. **`tsc`/`build` rossi su `.next/dev/types/validator.ts`** dopo aver aggiunto una rotta: sono tipi
   vecchi di `next dev`. Non è un tuo errore: segnalalo, non cancellare cartelle.
8. **Leggi i file con lo strumento `Read`**, non con `cat`: le regole di `.claude/rules/` (rotte,
   migrazioni, test, traduzioni) si attivano solo così.

---

## Da tenere d'occhio (Review Focus)

I casi che più facilmente rompono qualcosa a una famiglia vera. Ognuno ha il suo test nel compito
indicato.

| # | Caso | Cosa ci si aspetta | Dove sta il test |
|---|---|---|---|
| R1 | **Due prenotazioni dello stesso orario nello stesso istante** (assistente + segretaria, o due volte l'assistente) | Una visita sola. L'altra riceve `409 SLOT_OCCUPATO`. Lo garantisce il vincolo `crm_appuntamenti_no_sovrapposti` (`20261030230225_crm_segreteria.sql:166`), non il codice | Compito 1 (PGlite, test 5 e 6) · Compito 6 · prova a mano del Compito 12 (due `curl` insieme) |
| R2 | **Chiave di un'altra sede** (la chiave è di A, la richiesta dice B) | `403 SEDE_NON_ACCESSIBILE`, nessuna lettura e nessuna scrittura; una riga `warn` nel log | Compito 3 · ripetuto in 5, 6, 7, 8, 9 |
| R3 | **Orario libero quando l'ho letto, occupato quando prenoto** | `409 SLOT_OCCUPATO`, mai una visita sovrapposta; la famiglia resta in scheda e l'assistente propone altri orari | Compito 6 |
| R4 | **Lo stesso telefono scritto in modi diversi** (`+39 333 000 0001`, `0039333-0000001`, `333 0000001`) | Una scheda sola. Decide `normalizzaTelefono` (`src/lib/crm/contatti.ts:18`) e la ricerca è nel database, sotto blocco | Compito 1 (test 10) · Compito 8 |
| R5 | **La stessa richiesta ripetuta** (rete caduta, il programma riprova con la stessa `Idempotency-Key`) | Stessa risposta di prima, `ripetuta: true`, nessuna seconda visita. Stessa chiave con un corpo diverso → `422 CHIAVE_RIUSATA` | Compito 1 (test 2 e 3) · Compito 6 |
| R6 | **Orario fuori disponibilità** (la segretaria ha tolto la fascia, o l'orario non è sulla griglia) | `422 FUORI_DISPONIBILITA`, niente visita | Compito 6 |
| R7 | **Chiave revocata** un attimo prima | `401 TOKEN_NON_VALIDO` alla chiamata successiva | Compito 3 |
| R8 | **Il nome di un bambino che torna indietro** in una risposta o in un log | Mai. Un test scorre il JSON di ogni risposta e cerca il nome finto | Compiti 5–9 (`nessunNomeIn`) |
| R9 | **Interruttore spento** | Ogni rotta `/api/crm/ai/*` risponde `404 CRM_AI_SPENTO` prima di guardare la chiave | Compito 3 |
| R10 | **Gemelli** (stessa data di nascita, nomi diversi) | Due bambini, non uno | Compito 1 (test 9) |

**Quello che i test automatici non possono dimostrare.** PGlite ha una connessione sola: la vera
contemporaneità (due transazioni aperte insieme) non si vede in vitest. La dimostrano il vincolo
`EXCLUDE` che è già in produzione dal 30/10 e la prova a mano del Compito 12, passo 7.

---

## Mappa dei file

| File | Nuovo? | Compito | Cosa fa |
|---|---|---|---|
| `supabase/migrations/<AAAAMMGGHHMMSS>_crm_accesso_ai.sql` | nuovo | 1 | Due tabelle (`crm_integrazioni`, `crm_ai_richieste`) e quattro funzioni `crm_ai_*` |
| `src/lib/crm/tipi.ts` (in fondo, dopo riga 336) | modifica | 1 | `IntegrazioneRow`, `RichiestaAiRow` |
| `__tests__/architecture/soglia-fotografia.ts:359` | modifica | 1 | Dichiara la migrazione in `MIGRAZIONI_ATTESE_AL_MERGE` |
| `__tests__/lib/crm/migrazione-crm-accesso-ai.test.ts` | nuovo | 1 | Legge il testo della migrazione |
| `__tests__/lib/crm/migrazione-crm-accesso-ai-sql.test.ts` | nuovo | 1 | **Esegue** la migrazione e le funzioni su PGlite |
| `src/lib/crm/ai/interruttore.ts` | nuovo | 2 | `crmAiAttivo`, `sedeAmmessaAi` |
| `src/lib/crm/ai/token.ts` | nuovo | 2 | Genera la chiave, ne calcola l'impronta, la legge dalla richiesta |
| `src/lib/crm/ai/eta.ts` | nuovo | 2 | Dal mese di nascita agli ordini di scuola possibili |
| `src/lib/crm/ai/idempotenza.ts` | nuovo | 2 | Chiave di idempotenza e impronta del corpo |
| `__tests__/lib/crm/ai/*.test.ts` (4 file) | nuovo | 2 | Prove delle quattro funzioni pure |
| `src/lib/crm/ai/accesso.ts` | nuovo | 3 | Il gate `requireIntegrazioneAi`, `assertSedeDelToken`, `chiudiChiamataAi`, `rifiutoAi` |
| `src/lib/ui/esito-fetch.ts` (dopo riga 3448) | modifica | 3 | Nove codici d'errore nuovi |
| `messages/it/shared.json`, `messages/en/shared.json` | modifica | 3 | Le nove frasi |
| `__tests__/architecture/gate-coverage.test.ts:85-93` | modifica | 3 | `requireIntegrazioneAi` in `GATE_BASE` |
| `__tests__/architecture/corpo-letto-dopo-il-gate.test.ts:79-84` | modifica | 3 | Idem, nella seconda copia dell'elenco |
| `__tests__/fixtures/crm-ai.ts` | nuovo | 3 | Costanti e aiuti dei test delle rotte AI |
| `__tests__/lib/crm/ai/accesso.test.ts` | nuovo | 3 | Prove del gate |
| `src/app/api/admin/crm/integrazioni/route.ts` | nuovo | 4 | `GET` elenco, `POST` crea la chiave |
| `src/app/api/admin/crm/integrazioni/[id]/route.ts` | nuovo | 4 | `DELETE` = revoca |
| `__tests__/api/crm-integrazioni.test.ts` | nuovo | 4 | |
| `src/lib/crm/ai/disponibilita.ts` | nuovo | 5 | Carica i dati dell'agenda e calcola orari e candidati |
| `src/app/api/crm/ai/slot/route.ts` | nuovo | 5 | `GET` orari liberi |
| `__tests__/api/crm-ai-slot.test.ts` | nuovo | 5 | |
| `src/app/api/crm/ai/prenota/route.ts` | nuovo | 6 | `POST` prenota |
| `__tests__/api/crm-ai-prenota.test.ts` | nuovo | 6 | |
| `src/app/api/crm/ai/prenotazioni/[id]/route.ts` | nuovo | 7 | `DELETE` annulla |
| `__tests__/api/crm-ai-annulla.test.ts` | nuovo | 7 | |
| `src/lib/crm/ai/contatti.ts` | nuovo | 8 | Trova la scheda da un numero, sceglie «la visita» |
| `src/app/api/crm/ai/contatti/route.ts` | nuovo | 8 | `POST` E1 |
| `src/app/api/crm/ai/contatti/stato/route.ts` | nuovo | 8 | `POST` E2 |
| `src/app/api/crm/ai/contatti/nuovi/route.ts` | nuovo | 8 | `GET` E3 |
| `__tests__/api/crm-ai-contatti.test.ts` | nuovo | 8 | |
| `src/lib/crm/follow-up.ts:98-143` | modifica | 9 | `pianificaAzione` accetta `autoreVia` |
| `src/lib/crm/ai/richiami.ts` | nuovo | 9 | Motivi del passaggio e scelta della responsabile |
| `src/app/api/crm/ai/richiami/route.ts` | nuovo | 9 | `POST` E4 |
| `__tests__/api/crm-ai-richiami.test.ts` | nuovo | 9 | |
| `__tests__/lib/crm/follow-up.test.ts` (blocco `pianificaAzione`, riga 145) | modifica | 9 | Due casi su `autoreVia` |
| `__tests__/components/crm/schede.test.tsx`, `crm-shell-dettaglio.test.tsx` | modifica | 11 | Una scheda senza bambini si vede bene |
| `src/lib/crm/tab.ts:10` | modifica | 10 | Sesta scheda `integrazioni` |
| `src/components/features/crm/CrmShell.tsx:96-118` | modifica | 10 | La linguetta e il suo pannello |
| `src/components/features/crm/integrazioni/Integrazioni.tsx` | nuovo | 10 | Crea, mostra una volta, revoca |
| `messages/it/crmShell.json`, `messages/en/crmShell.json` | modifica | 10 | Etichette |
| `__tests__/components/crm/crm-shell.test.tsx:30-79` | modifica | 10 | Segnaposto della scheda nuova |
| `__tests__/components/crm/integrazioni.test.tsx` | nuovo | 10 | |
| `__tests__/architecture/isolamento-sede-coverage.test.ts` (numeri) | modifica | 11 | I conteggi salgono |
| `docs/crm-accesso-ai.md` | nuovo | 11 | Il contratto per chi scrive il programma sul Mac |
| `PRD REGISTRO ELETTRONICO.md` (in cima) | modifica | 11 | Voce di changelog |

Niente altro. In particolare **non si toccano**: `src/lib/crm/slot.ts`, `src/lib/crm/settimane.ts`,
`src/lib/crm/contatti.ts`, le rotte `src/app/api/admin/crm/*` esistenti, `src/middleware.ts`
(`/api/*` non viene reindirizzato senza sessione: `src/lib/auth/middleware-rules.ts:113-122`).

## Ordine e parallelo

```
Onda 0   Compito 1 (migrazione)      ∥  Compito 2 (funzioni pure)
Onda 1   Compito 3 (gate, codici, lock)                 ← aspetta 1 e 2
Onda 2   Compito 4 ∥ Compito 5 ∥ Compito 7 ∥ Compito 8 ∥ Compito 9     ← aspettano 3
Onda 3   Compito 6 (aspetta 5)  ∥  Compito 10 (aspetta 4)
Onda 4   Compito 11 (PRD, contratto, numeri del lock, gate intero, PR in bozza)   ← aspetta tutti
🟥       Compito 12 — SOLO dopo il sì scritto del titolare
```

I compiti di una stessa onda non toccano gli stessi file. **Un solo file è condiviso e per questo ha
una regola:** i numeri di `__tests__/architecture/isolamento-sede-coverage.test.ts` li aggiorna **solo
il Compito 11**. Dall'Onda 2 in poi quel lock è rosso **sui numeri** (e solo su quelli): è atteso, non
correggerlo prima.

## Prima di cominciare (una volta sola, chi coordina)

- [ ] Crea il worktree e il ramo, partendo da `origin/main` aggiornato. **Non** fare `git checkout` nel
  checkout principale (`/Users/lerri/kidville-web`): ci lavorano altre sessioni.

```bash
git -C /Users/lerri/kidville-web fetch origin main
```

```bash
git -C /Users/lerri/kidville-web worktree add -b crm-accesso-ai /Users/lerri/kidville-web/.claude/worktrees/crm-accesso-ai origin/main
```

- [ ] Nel worktree: `npm ci` (dentro il worktree, **non** nel checkout principale).
- [ ] Fotografa lo stato di partenza: `npx vitest run __tests__/architecture __tests__/lib/crm __tests__/api/zod-coverage.test.ts`.
  Atteso: tutto verde. Se qualcosa è rosso **prima** di aver scritto una riga, fermati e scrivilo nel
  rapporto: non è materia di questo piano.

---

### Compito 1: la migrazione, i tipi e le prove dell'SQL

**Parallelo:** insieme al Compito 2. **Blocca:** 3, 4, 6, 8, 9.

**File:**
- Crea: `supabase/migrations/<AAAAMMGGHHMMSS>_crm_accesso_ai.sql`
- Modifica: `src/lib/crm/tipi.ts` (aggiungi in fondo, dopo la riga 336)
- Modifica: `__tests__/architecture/soglia-fotografia.ts:359`
- Test: `__tests__/lib/crm/migrazione-crm-accesso-ai.test.ts`, `__tests__/lib/crm/migrazione-crm-accesso-ai-sql.test.ts`

**Interfacce:**
- Consuma: le tabelle `crm_schede`, `crm_bambini`, `crm_appuntamenti`, `crm_eventi` di
  `supabase/migrations/20261030230225_crm_segreteria.sql` (righe 60, 100, 146, 220).
- Produce (le usano i compiti 3–9):
  - tabella `public.crm_integrazioni(id, scuola_id, nome, token_impronta, token_coda, creata_da, creata_il, revocata_il, revocata_da, ultimo_uso_il)`
  - tabella `public.crm_ai_richieste(id, scuola_id, integrazione_id, chiave, operazione, impronta, risposta, scheda_id, appuntamento_id, creata_il, conclusa_il)`
  - `public.crm_ai_registra_contatto(p_scuola_id uuid, p_telefono text, p_telefono_norm text, p_email text, p_email_norm text, p_genitore_nome text, p_origine text, p_bambini jsonb) RETURNS jsonb`
    → `{"scheda_id": uuid, "creata": boolean}`
  - `public.crm_ai_prenota(p_integrazione_id uuid, p_scuola_id uuid, p_chiave text, p_impronta text, p_inizio timestamptz, p_durata_min integer, p_candidati uuid[], p_telefono text, p_telefono_norm text, p_email text, p_email_norm text, p_genitore_nome text, p_origine text, p_bambini jsonb, p_routine text, p_paura text, p_desiderio text) RETURNS jsonb`
    → sempre un oggetto con `esito`, uno fra:
    - `{"esito":"creata","appuntamento_id":uuid,"inizio":ts,"fine":ts,"scheda_id":uuid,"scheda_creata":bool,"assegnata_a":uuid}`
    - `{"esito":"gia_prenotato","appuntamento_id":uuid,"inizio":ts,"fine":ts,"scheda_id":uuid}`
    - `{"esito":"slot_occupato","scheda_id":uuid}`
    - `{"esito":"chiave_riusata"}` · `{"esito":"in_corso"}`
    - una ripetizione restituisce la risposta salvata più `"ripetuta": true`
  - `p_bambini` è un array JSON di `{"nome": text|null, "data_nascita": "AAAA-MM-GG"|null}`
  - tipi TypeScript `IntegrazioneRow`, `RichiestaAiRow`, `EsitoPrenotaAi`

- [ ] **Passo 1: scegli il nome del file.** Il timestamp è l'istante **vero** in UTC, non tondo:

```bash
date -u +%Y%m%d%H%M%S
```

Deve essere maggiore di `20261104173158` (l'ultima migrazione del repo,
`supabase/migrations/20261104173158_voti_periodo_id.sql`). Se `ls supabase/migrations | tail -1`
mostra un file più recente di quello, il tuo deve superare anche quello.

- [ ] **Passo 2: scrivi il test che legge il TESTO** — `__tests__/lib/crm/migrazione-crm-accesso-ai.test.ts`.
  Prendi a modello `__tests__/lib/crm/migrazione-quota-settimane.test.ts` (stessa forma, stesso modo di
  trovare il file). Deve contenere esattamente questi `it`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRAZIONI_ATTESE_AL_MERGE } from '../../architecture/soglia-fotografia'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => /^\d{14}_crm_accesso_ai\.sql$/.test(f))
const SQL = FILE.length === 1 ? readFileSync(join(CARTELLA, FILE[0]), 'utf8') : ''
/** Lo stesso testo senza i commenti `--`: una parola in un commento non conta. */
const CODICE = SQL.split('\n').map((r) => r.replace(/--.*$/, '')).join('\n')
const QUATTRO = ['crm_ai_scheda', 'crm_ai_bambini', 'crm_ai_registra_contatto', 'crm_ai_prenota']

describe('migrazione crm_accesso_ai · il testo', () => {
  it('c’è un solo file, col nome giusto e un istante vero', () => {
    expect(FILE).toHaveLength(1)
    const ts = FILE[0].slice(0, 14)
    expect(ts > '20261104173158').toBe(true)
    expect(ts.slice(10)).not.toBe('0000') // non un orario tondo
  })
  it('le due tabelle hanno scuola_id verso schools e la RLS accesa, senza policy', () => {
    for (const t of ['crm_integrazioni', 'crm_ai_richieste']) {
      expect(CODICE).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t} \\(`))
      expect(CODICE).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY;`))
    }
    expect(CODICE.match(/scuola_id\s+uuid NOT NULL REFERENCES public\.schools\(id\)/g)).toHaveLength(2)
    expect(CODICE).not.toMatch(/create\s+policy/i)
  })
  it('una sola chiave attiva per sede, e l’impronta è unica', () => {
    expect(CODICE).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS crm_integrazioni_una_attiva_per_sede\s+ON public\.crm_integrazioni \(scuola_id\)\s+WHERE revocata_il IS NULL;/)
    expect(CODICE).toMatch(/CONSTRAINT crm_integrazioni_impronta_unica UNIQUE \(token_impronta\)/)
    expect(CODICE).toMatch(/CONSTRAINT crm_ai_richieste_chiave_unica UNIQUE \(integrazione_id, chiave\)/)
  })
  it('il token in chiaro non ha una colonna', () => {
    expect(CODICE).not.toMatch(/\btoken\s+text/i)
  })
  it('niente di distruttivo', () => {
    expect(CODICE).not.toMatch(/\b(DROP|TRUNCATE)\b/i)
    expect(CODICE).not.toMatch(/DELETE\s+FROM/i)
  })
  it.each(QUATTRO)('%s è plpgsql, SECURITY INVOKER, con search_path fissato e solo del service_role', (nome) => {
    const da = CODICE.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`)
    expect(da).toBeGreaterThan(-1)
    const testa = CODICE.slice(da, CODICE.indexOf('AS $$', da))
    expect(testa).toMatch(/LANGUAGE plpgsql/)
    expect(testa).toMatch(/SECURITY INVOKER/)
    expect(testa).toMatch(/SET search_path = public, pg_temp/)
    expect(CODICE).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${nome}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`))
    expect(CODICE).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${nome}\\([^)]*\\) TO service_role;`))
  })
  it('chiude dicendo a PostgREST di rileggere lo schema', () => {
    expect(CODICE.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true)
  })
  it('è dichiarata fra le migrazioni attese al merge (si toglie nella PR-B)', () => {
    expect(Object.keys(MIGRAZIONI_ATTESE_AL_MERGE)).toContain(FILE[0])
  })
})
```

- [ ] **Passo 3: lancialo e guardalo fallire.**

Lancia: `npx vitest run __tests__/lib/crm/migrazione-crm-accesso-ai.test.ts`
Atteso: `Test Files 1 failed`, il primo `it` cade con `expected [] to have a length of 1`.

- [ ] **Passo 4: scrivi il test che ESEGUE l'SQL** — `__tests__/lib/crm/migrazione-crm-accesso-ai-sql.test.ts`.
  Modello dell'impalcatura: `__tests__/lib/crm/migrazione-quota-settimane-sql.test.ts:1-60` (PGlite con
  `btree_gist`, i ruoli finti, la funzione `migrazione(suffisso)`).

```ts
// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}

const uuid = (pref: string, n: number) => `${pref}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const SEDE_A = uuid('a0000000', 1)
const SEDE_B = uuid('a0000000', 2)
const P1 = uuid('b0000000', 1) // una segretaria della sede A
const P2 = uuid('b0000000', 2) // una collega della sede A
// La segretaria della sede B. Serve davvero: il vincolo `crm_appuntamenti_no_sovrapposti` vale per PERSONA
// (`assegnata_a`), non per sede. Una prova «stesso numero in un'altra sede» che usasse P1 alla stessa ora
// prenderebbe `slot_occupato` per colpa della persona, e non direbbe niente sulle schede.
const P_B = uuid('b0000000', 3)
const ADMIN = uuid('b0000000', 9)
const INT_A = uuid('d0000000', 1)
const INT_B = uuid('d0000000', 2)
const IMPRONTA_1 = '1'.repeat(64)
const IMPRONTA_2 = '2'.repeat(64)
const TEL = '333 000 0001'
const TEL_NORM = '3330000001'
const TEL2 = '333 000 0002'
const TEL2_NORM = '3330000002'
const NASCITA = '2023-03-15'
// Fra trenta giorni, alle 08:30 UTC: il test non scade col calendario.
const FRA_30 = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 30 * 86_400_000 + 8.5 * 3_600_000).toISOString()

let db: PGlite
type Esito = Record<string, unknown> & { esito?: string }

async function prenota(o: Partial<Record<string, unknown>> = {}): Promise<Esito> {
  const p = {
    integrazione: INT_A, sede: SEDE_A, chiave: 'chiave-0001', impronta: IMPRONTA_1, inizio: FRA_30, durata: 45,
    candidati: [P1], tel: TEL, telNorm: TEL_NORM, email: null, emailNorm: null, genitore: 'Famiglia Prova',
    origine: 'whatsapp', bambini: [{ nome: 'Bimbo Prova', data_nascita: NASCITA }], routine: null, paura: null, desiderio: null,
    ...o,
  }
  const r = await db.query<{ r: Esito }>(
    `SELECT public.crm_ai_prenota($1,$2,$3,$4,$5::timestamptz,$6,$7::uuid[],$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17) AS r`,
    [p.integrazione, p.sede, p.chiave, p.impronta, p.inizio, p.durata, `{${(p.candidati as string[]).join(',')}}`,
     p.tel, p.telNorm, p.email, p.emailNorm, p.genitore, p.origine, JSON.stringify(p.bambini), p.routine, p.paura, p.desiderio],
  )
  return r.rows[0].r
}
async function contatto(o: Partial<Record<string, unknown>> = {}): Promise<Esito> {
  const p = { sede: SEDE_A, tel: TEL, telNorm: TEL_NORM, email: null, emailNorm: null, genitore: null, origine: 'sito', bambini: [], ...o }
  const r = await db.query<{ r: Esito }>(
    `SELECT public.crm_ai_registra_contatto($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS r`,
    [p.sede, p.tel, p.telNorm, p.email, p.emailNorm, p.genitore, p.origine, JSON.stringify(p.bambini)],
  )
  return r.rows[0].r
}
const conta = async (tabella: string, dove = 'true') =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.${tabella} WHERE ${dove}`)).rows[0].n)

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA extensions;
    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (id uuid PRIMARY KEY);
    CREATE TABLE public.enrollment_submissions (id uuid PRIMARY KEY);
  `)
  await db.exec(migrazione('_crm_segreteria.sql'))
  // Due volte: la migrazione dev'essere rieseguibile senza danni.
  await db.exec(migrazione('_crm_accesso_ai.sql'))
  await db.exec(migrazione('_crm_accesso_ai.sql'))
  await db.exec(`
    INSERT INTO public.schools (id) VALUES ('${SEDE_A}'), ('${SEDE_B}');
    INSERT INTO public.utenti (id) VALUES ('${P1}'), ('${P2}'), ('${P_B}'), ('${ADMIN}');
  `)
})
afterAll(async () => { await db.close() })

beforeEach(async () => {
  // TRUNCATE qui è nel TEST, non nella migrazione: rimette il database a zero fra una prova e l'altra.
  await db.exec(`TRUNCATE public.crm_ai_richieste, public.crm_integrazioni, public.crm_schede CASCADE;`)
  await db.exec(`
    INSERT INTO public.crm_integrazioni (id, scuola_id, nome, token_impronta, token_coda, creata_da)
    VALUES ('${INT_A}', '${SEDE_A}', 'Assistente', '${'a'.repeat(64)}', 'AAAA', '${ADMIN}'),
           ('${INT_B}', '${SEDE_B}', 'Assistente', '${'b'.repeat(64)}', 'BBBB', '${ADMIN}');
  `)
})

describe('crm_ai_prenota', () => {
  it('1 · famiglia nuova: scheda, bambino, visita e storico in una volta', async () => {
    const r = await prenota()
    expect(r.esito).toBe('creata')
    expect(r.scheda_creata).toBe(true)
    expect(r.assegnata_a).toBe(P1)
    expect(await conta('crm_schede', `creato_via = 'ai' AND creato_da IS NULL AND telefoni_norm = ARRAY['${TEL_NORM}']`)).toBe(1)
    expect(await conta('crm_bambini')).toBe(1)
    expect(await conta('crm_appuntamenti', `fissato_via = 'ai' AND fissato_da IS NULL AND stato = 'in_programma' AND assegnata_a = '${P1}' AND durata_min = 45`)).toBe(1)
    const eventi = await db.query<{ tipo: string; autore_via: string }>(`SELECT tipo, autore_via FROM public.crm_eventi`)
    // In ordine alfabetico: l'orologio di PGlite può dare lo stesso istante a due eventi della stessa transazione.
    expect(eventi.rows.map((e) => e.tipo).sort()).toEqual(['appuntamento_fissato', 'bambino_aggiunto', 'creata'])
    expect(eventi.rows.every((e) => e.autore_via === 'ai')).toBe(true)
    expect(await conta('crm_ai_richieste', `risposta IS NOT NULL AND conclusa_il IS NOT NULL AND appuntamento_id IS NOT NULL`)).toBe(1)
  })
  it('2 · la stessa richiesta ripetuta non crea una seconda visita (R5)', async () => {
    const prima = await prenota()
    const seconda = await prenota()
    expect(seconda.ripetuta).toBe(true)
    expect(seconda.esito).toBe('creata')
    expect(seconda.appuntamento_id).toBe(prima.appuntamento_id)
    expect(await conta('crm_appuntamenti')).toBe(1)
    expect(await conta('crm_schede')).toBe(1)
  })
  it('3 · stessa chiave, corpo diverso: chiave_riusata, e non scrive niente (R5)', async () => {
    await prenota()
    const r = await prenota({ impronta: IMPRONTA_2, tel: TEL2, telNorm: TEL2_NORM })
    expect(r).toEqual({ esito: 'chiave_riusata' })
    expect(await conta('crm_schede')).toBe(1)
  })
  it('4 · la famiglia ha già una visita in programma: gia_prenotato, con l’orario esistente', async () => {
    const prima = await prenota()
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2, tel: '+39 333-0000001' })
    expect(r.esito).toBe('gia_prenotato')
    expect(r.appuntamento_id).toBe(prima.appuntamento_id)
    expect(new Date(r.inizio as string).toISOString()).toBe(FRA_30)
    expect(await conta('crm_appuntamenti')).toBe(1)
    expect(await conta('crm_schede')).toBe(1)
  })
  it('5 · un’altra famiglia sullo stesso orario e sulla stessa persona: slot_occupato (R1, R3)', async () => {
    await prenota()
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2, tel: TEL2, telNorm: TEL2_NORM })
    expect(r.esito).toBe('slot_occupato')
    expect(await conta('crm_appuntamenti')).toBe(1)
    // la famiglia resta in scheda: è un contatto vero, e l'assistente le proporrà un altro orario
    expect(await conta('crm_schede')).toBe(2)
    expect(await conta('crm_ai_richieste', `chiave = 'chiave-0002' AND risposta->>'esito' = 'slot_occupato'`)).toBe(1)
  })
  it('6 · con due candidate, la seconda famiglia va alla collega libera (R1)', async () => {
    await prenota()
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2, tel: TEL2, telNorm: TEL2_NORM, candidati: [P1, P2] })
    expect(r.esito).toBe('creata')
    expect(r.assegnata_a).toBe(P2)
    expect(await conta('crm_appuntamenti')).toBe(2)
  })
  it('7 · lo stesso numero in un’altra sede è un’altra scheda', async () => {
    await prenota()
    // La sede B ha la SUA persona (P_B): alla stessa ora P1 è già occupata dalla visita della sede A.
    const r = await prenota({ integrazione: INT_B, sede: SEDE_B, chiave: 'chiave-000b', candidati: [P_B] })
    expect(r.esito).toBe('creata')
    expect(r.scheda_creata).toBe(true)
    expect(r.assegnata_a).toBe(P_B)
    expect(await conta('crm_schede', `scuola_id = '${SEDE_B}'`)).toBe(1)
    expect(await conta('crm_schede', `scuola_id = '${SEDE_A}'`)).toBe(1)
  })
  it('7-bis · la stessa persona non riceve due sedi alla stessa ora: il vincolo è sulla persona', async () => {
    await prenota()
    const r = await prenota({ integrazione: INT_B, sede: SEDE_B, chiave: 'chiave-000b', candidati: [P1] })
    expect(r.esito).toBe('slot_occupato')
  })
  it('8 · un bambino «perso» torna «aperto», senza doppione', async () => {
    await prenota()
    await db.exec(`UPDATE public.crm_appuntamenti SET stato = 'annullato';
                   UPDATE public.crm_bambini SET esito = 'perso', motivo_perdita = 'prezzo', esito_origine = 'manuale';`)
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2 })
    expect(r.esito).toBe('creata')
    expect(r.scheda_creata).toBe(false)
    expect(await conta('crm_bambini')).toBe(1)
    expect(await conta('crm_bambini', `esito = 'aperto' AND motivo_perdita IS NULL AND esito_origine = 'automatico' AND esito_da IS NULL`)).toBe(1)
    expect(await conta('crm_eventi', `tipo = 'esito_cambiato' AND autore_via = 'ai' AND dati->>'da' = 'perso' AND dati->>'a' = 'aperto'`)).toBe(1)
  })
  it('9 · due gemelli (stessa data, nomi diversi) sono due bambini (R10)', async () => {
    await prenota({ bambini: [{ nome: 'Bimbo Prova', data_nascita: NASCITA }, { nome: 'Bimba Prova', data_nascita: NASCITA }] })
    expect(await conta('crm_bambini')).toBe(2)
  })
  it('una visita in programma ma già PASSATA non blocca una prenotazione nuova', async () => {
    await prenota()
    await db.exec(`UPDATE public.crm_appuntamenti SET inizio = now() - interval '3 days', fine = now() - interval '3 days' + interval '45 minutes';`)
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2 })
    expect(r.esito).toBe('creata')
  })
  it('le tre domande del copione si scrivono solo dove la scheda è vuota', async () => {
    await prenota({ routine: 'dorme al pomeriggio' })
    await db.exec(`UPDATE public.crm_appuntamenti SET stato = 'annullato';`)
    await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2, routine: 'altro testo', paura: 'il distacco' })
    expect(await conta('crm_schede', `routine = 'dorme al pomeriggio' AND paura = 'il distacco' AND desiderio IS NULL`)).toBe(1)
  })
  it('senza candidate o senza sede lancia 22023', async () => {
    await expect(prenota({ candidati: [] })).rejects.toMatchObject({ code: '22023' })
  })
})

describe('crm_ai_registra_contatto', () => {
  it('10 · due volte lo stesso numero, scritto in due modi: una scheda sola (R4)', async () => {
    const prima = await contatto({ bambini: [{ nome: null, data_nascita: NASCITA }] })
    const seconda = await contatto({ tel: '0039 333-0000001' })
    expect(prima.creata).toBe(true)
    expect(seconda).toEqual({ scheda_id: prima.scheda_id, creata: false })
    expect(await conta('crm_schede')).toBe(1)
    // poi arriva la prenotazione col NOME: completa il bambino che c'era, non ne crea un secondo
    await prenota()
    expect(await conta('crm_bambini')).toBe(1)
    expect(await conta('crm_bambini', `nome = 'Bimbo Prova' AND data_nascita::text = '${NASCITA}'`)).toBe(1)
  })
  it('una scheda anonimizzata non si riusa: ne nasce una nuova', async () => {
    const prima = await contatto()
    await db.exec(`UPDATE public.crm_schede SET anonimizzata_il = now();`)
    const seconda = await contatto()
    expect(seconda.creata).toBe(true)
    expect(seconda.scheda_id).not.toBe(prima.scheda_id)
  })
  it('riconosce la famiglia anche dalla sola email', async () => {
    const prima = await contatto({ email: 'Prova@Example.com', emailNorm: 'prova@example.com' })
    const seconda = await contatto({ tel: TEL2, telNorm: TEL2_NORM, email: 'prova@example.com', emailNorm: 'prova@example.com' })
    expect(seconda).toEqual({ scheda_id: prima.scheda_id, creata: false })
  })
})

describe('i vincoli delle due tabelle', () => {
  it('11 · una sola chiave attiva per sede; dopo la revoca se ne può creare un’altra', async () => {
    const altra = `INSERT INTO public.crm_integrazioni (scuola_id, nome, token_impronta, token_coda, creata_da)
                   VALUES ('${SEDE_A}', 'Seconda', '${'c'.repeat(64)}', 'CCCC', '${ADMIN}')`
    await expect(db.exec(altra)).rejects.toMatchObject({ code: '23505' })
    await db.exec(`UPDATE public.crm_integrazioni SET revocata_il = now(), revocata_da = '${ADMIN}' WHERE id = '${INT_A}'`)
    await db.exec(altra)
    expect(await conta('crm_integrazioni', `scuola_id = '${SEDE_A}'`)).toBe(2)
  })
  it('12 · una richiesta non può dichiarare una sede diversa da quella della sua chiave', async () => {
    await expect(
      db.exec(`INSERT INTO public.crm_ai_richieste (scuola_id, integrazione_id, chiave, operazione, impronta)
               VALUES ('${SEDE_B}', '${INT_A}', 'chiave-0009', 'prenota', '${IMPRONTA_1}')`),
    ).rejects.toMatchObject({ code: '23503' })
  })
  it('revocata_il e revocata_da stanno insieme', async () => {
    await expect(db.exec(`UPDATE public.crm_integrazioni SET revocata_il = now() WHERE id = '${INT_A}'`)).rejects.toMatchObject({ code: '23514' })
  })
})
```

- [ ] **Passo 5: lancialo e guardalo fallire.**

Lancia: `npx vitest run __tests__/lib/crm/migrazione-crm-accesso-ai-sql.test.ts`
Atteso: `Test Files 1 failed` con `migrazione *_crm_accesso_ai.sql non trovata`.

- [ ] **Passo 6: scrivi la migrazione.** Il file, per intero (cambia solo `<AAAAMMGGHHMMSS>` nel nome):

```sql
-- =============================================================================
-- CRM DELLA SEGRETERIA · L'ACCESSO DELL'ASSISTENTE AI
--
-- Specifica: docs/superpowers/specs/2026-10-30-crm-segreteria-design.md  (§8)
-- Piano:     docs/superpowers/plans/2026-11-10-crm-accesso-ai.md         (Compito 1)
--
-- ── COSA CONSEGNA ────────────────────────────────────────────────────────────
--   crm_integrazioni   le chiavi dell'assistente: UNA attiva per sede, e del token solo l'impronta
--   crm_ai_richieste   il registro delle prenotazioni chieste, per non eseguirne una due volte
--   crm_ai_scheda, crm_ai_bambini, crm_ai_registra_contatto, crm_ai_prenota
--                      le quattro funzioni che scrivono, ciascuna in UNA transazione
--
-- ── LE SCELTE CHE NON SI VEDONO DAL CODICE ───────────────────────────────────
-- 1. IL TOKEN IN CHIARO NON ESISTE NEL DATABASE. `token_impronta` è lo SHA-256 in esadecimale; `token_coda`
--    sono gli ultimi 4 caratteri, per riconoscerlo a schermo. Chi legge la tabella non può chiamare le rotte.
-- 2. UNA FAMIGLIA NON NASCE DUE VOLTE. `telefoni_norm` è un array: un UNIQUE non lo sa esprimere. Si prende un
--    blocco consultivo di transazione sulla coppia (sede, numero) e POI si cerca: due richieste insieme si
--    mettono in fila, e la seconda trova la scheda della prima.
-- 3. LA STESSA RICHIESTA NON VALE DUE VOLTE. `crm_ai_richieste` ha UNIQUE (integrazione_id, chiave): la
--    seconda `INSERT … ON CONFLICT DO NOTHING` aspetta la prima, non inserisce, e restituisce la risposta salvata.
-- 4. DUE VISITE NON SI SOVRAPPONGONO. Non c'è niente di nuovo: lo impedisce l'EXCLUDE di `crm_appuntamenti`
--    (20261030230225). Qui lo si INTERCETTA per provare la candidata successiva.
-- 5. RLS ACCESA E NESSUNA POLICY, come le altre tabelle `crm_*`: le legge solo il service-role.
-- 6. NESSUN UUID DI SEDE SCRITTO A MANO, nessun DROP, nessun DELETE.
-- 7. GLI EVENTI PORTANO `clock_timestamp()`: nascono nella stessa transazione e vanno letti in ordine.
--
-- ── COME SI APPLICA ──────────────────────────────────────────────────────────
-- La applica l'INTEGRAZIONE Supabase al merge, con la version di questo file: mai a mano.
-- Rieseguibile: riapplicarla non cambia niente. Le fotografie delle guardie si rigenerano nella PR-B.
-- =============================================================================

-- ── 1) crm_integrazioni: le chiavi dell'assistente ───────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_integrazioni (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id       uuid NOT NULL REFERENCES public.schools(id),
  nome            text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 80),
  -- SHA-256 del token, in esadecimale minuscolo: il token in chiaro non si conserva
  token_impronta  text NOT NULL CHECK (token_impronta ~ '^[0-9a-f]{64}$'),
  -- gli ultimi 4 caratteri del token, per riconoscerlo nell'elenco
  token_coda      text NOT NULL CHECK (char_length(token_coda) = 4),
  creata_da       uuid NOT NULL REFERENCES public.utenti(id),
  creata_il       timestamptz NOT NULL DEFAULT now(),
  revocata_il     timestamptz,
  revocata_da     uuid REFERENCES public.utenti(id),
  ultimo_uso_il   timestamptz,
  CONSTRAINT crm_integrazioni_impronta_unica UNIQUE (token_impronta),
  CONSTRAINT crm_integrazioni_revoca CHECK ((revocata_il IS NULL) = (revocata_da IS NULL)),
  -- la chiave a cui punta il registro delle richieste: una richiesta non può cambiare sede
  UNIQUE (id, scuola_id)
);

ALTER TABLE public.crm_integrazioni ENABLE ROW LEVEL SECURITY;

-- una sola chiave ATTIVA per sede (le revocate restano, per la storia)
CREATE UNIQUE INDEX IF NOT EXISTS crm_integrazioni_una_attiva_per_sede
  ON public.crm_integrazioni (scuola_id)
  WHERE revocata_il IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_integrazioni_scuola ON public.crm_integrazioni (scuola_id);
CREATE INDEX IF NOT EXISTS idx_crm_integrazioni_creata_da ON public.crm_integrazioni (creata_da);
CREATE INDEX IF NOT EXISTS idx_crm_integrazioni_revocata_da ON public.crm_integrazioni (revocata_da);

COMMENT ON TABLE public.crm_integrazioni IS
  'CRM segreteria: le chiavi con cui l''assistente AI entra nelle rotte /api/crm/ai. Una attiva per sede. Del token si conserva solo l''impronta SHA-256. RLS accesa e nessuna policy: la legge solo il service-role.';

-- ── 2) crm_ai_richieste: il registro delle prenotazioni chieste ──────────────
CREATE TABLE IF NOT EXISTS public.crm_ai_richieste (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id       uuid NOT NULL REFERENCES public.schools(id),
  integrazione_id uuid NOT NULL,
  -- la chiave di idempotenza scelta da chi chiama (header Idempotency-Key)
  chiave          text NOT NULL CHECK (chiave ~ '^[A-Za-z0-9_-]{8,128}$'),
  operazione      text NOT NULL CHECK (operazione IN ('prenota')),
  -- SHA-256 del corpo della richiesta: stessa chiave con un corpo diverso è un errore di chi chiama
  impronta        text NOT NULL CHECK (impronta ~ '^[0-9a-f]{64}$'),
  -- la risposta data, da ripetere tale e quale; nulla finché la richiesta non è conclusa. Solo id, orari, esito.
  risposta        jsonb,
  scheda_id       uuid REFERENCES public.crm_schede(id) ON DELETE SET NULL,
  appuntamento_id uuid REFERENCES public.crm_appuntamenti(id) ON DELETE SET NULL,
  creata_il       timestamptz NOT NULL DEFAULT now(),
  conclusa_il     timestamptz,
  FOREIGN KEY (integrazione_id, scuola_id) REFERENCES public.crm_integrazioni (id, scuola_id),
  CONSTRAINT crm_ai_richieste_chiave_unica UNIQUE (integrazione_id, chiave)
);

ALTER TABLE public.crm_ai_richieste ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_ai_richieste_scuola ON public.crm_ai_richieste (scuola_id);
CREATE INDEX IF NOT EXISTS idx_crm_ai_richieste_scheda ON public.crm_ai_richieste (scheda_id);
CREATE INDEX IF NOT EXISTS idx_crm_ai_richieste_appuntamento ON public.crm_ai_richieste (appuntamento_id);

COMMENT ON TABLE public.crm_ai_richieste IS
  'CRM segreteria: una riga per ogni prenotazione chiesta dall''assistente AI, con la chiave di idempotenza e la risposta data. Serve a non eseguire due volte la stessa richiesta. Nessun dato personale: solo id, orari ed esito.';

-- ── 3) crm_ai_scheda: trova la scheda di una famiglia, o la crea ─────────────
CREATE OR REPLACE FUNCTION public.crm_ai_scheda(
  p_scuola_id      uuid,
  p_telefono       text,
  p_telefono_norm  text,
  p_email          text,
  p_email_norm     text,
  p_genitore_nome  text,
  p_origine        text,
  p_bambini_n      integer
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_scuola_id IS NULL OR p_telefono_norm IS NULL OR p_telefono_norm !~ '^[0-9]{9,10}$' OR p_origine IS NULL THEN
    RAISE EXCEPTION 'sede, telefono normalizzato e origine sono obbligatori' USING ERRCODE = '22023';
  END IF;

  -- Prima il numero, poi l'email: sempre in quest'ordine, così due richieste non si aspettano a vicenda.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm_ai|' || p_scuola_id::text || '|t|' || p_telefono_norm, 0));
  IF p_email_norm IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('crm_ai|' || p_scuola_id::text || '|e|' || p_email_norm, 0));
  END IF;

  -- La più vecchia: è quella a cui la segreteria è abituata. Una scheda anonimizzata non si riusa.
  SELECT s.id INTO v_id
    FROM public.crm_schede s
   WHERE s.scuola_id = p_scuola_id
     AND s.anonimizzata_il IS NULL
     AND (s.telefoni_norm && ARRAY[p_telefono_norm]
          OR (p_email_norm IS NOT NULL AND s.email_norm && ARRAY[p_email_norm]))
   ORDER BY s.creata_il ASC, s.id ASC
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('scheda_id', v_id, 'creata', false);
  END IF;

  INSERT INTO public.crm_schede
    (scuola_id, genitore_nome, telefono1, email1, telefoni_norm, email_norm, origine, creato_da, creato_via)
  VALUES
    (p_scuola_id, nullif(btrim(p_genitore_nome), ''), p_telefono, p_email, ARRAY[p_telefono_norm],
     CASE WHEN p_email_norm IS NULL THEN '{}'::text[] ELSE ARRAY[p_email_norm] END,
     p_origine, NULL, 'ai')
  RETURNING id INTO v_id;

  INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore, autore_via, dati, creato_il)
  VALUES (v_id, p_scuola_id, 'creata', NULL, 'ai', jsonb_build_object('bambini', coalesce(p_bambini_n, 0)), clock_timestamp());

  RETURN jsonb_build_object('scheda_id', v_id, 'creata', true);
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_scheda(uuid, text, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_scheda(uuid, text, text, text, text, text, text, integer) TO service_role;

COMMENT ON FUNCTION public.crm_ai_scheda(uuid, text, text, text, text, text, text, integer) IS
  'CRM, accesso AI: trova nella sede la scheda con quel telefono (o quell''email) normalizzato, oppure la crea con creato_via = ai. Prende un blocco consultivo sulla coppia sede+numero: due richieste insieme non creano due schede. Solo service_role.';

-- ── 4) crm_ai_bambini: aggiunge alla scheda i bambini che non ci sono ────────
CREATE OR REPLACE FUNCTION public.crm_ai_bambini(
  p_scheda_id  uuid,
  p_scuola_id  uuid,
  p_bambini    jsonb
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  b        record;
  v_id     uuid;
  v_esito  text;
  v_nuovi  integer := 0;
BEGIN
  IF p_bambini IS NULL OR jsonb_typeof(p_bambini) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR b IN
    SELECT nullif(btrim(x.nome), '') AS nome, x.data_nascita AS nato
      FROM jsonb_to_recordset(p_bambini) AS x(nome text, data_nascita date)
  LOOP
    IF b.nome IS NULL AND b.nato IS NULL THEN
      CONTINUE;
    END IF;

    -- È lo stesso bambino se: le date ci sono e coincidono (e i nomi non si contraddicono), oppure
    -- manca una delle due date e i nomi coincidono. Due gemelli con nomi diversi restano due.
    v_id := NULL;
    SELECT c.id, c.esito INTO v_id, v_esito
      FROM public.crm_bambini c
     WHERE c.scheda_id = p_scheda_id
       AND c.scuola_id = p_scuola_id
       AND (
            (b.nato IS NOT NULL AND c.data_nascita = b.nato
              AND (b.nome IS NULL OR c.nome IS NULL OR lower(btrim(c.nome)) = lower(b.nome)))
         OR ((b.nato IS NULL OR c.data_nascita IS NULL)
              AND b.nome IS NOT NULL AND lower(btrim(c.nome)) = lower(b.nome))
       )
     ORDER BY c.creata_il ASC, c.id ASC
     LIMIT 1
     FOR UPDATE;

    IF v_id IS NULL THEN
      INSERT INTO public.crm_bambini (scuola_id, scheda_id, nome, data_nascita, anno_ingresso)
      VALUES (p_scuola_id, p_scheda_id, b.nome, b.nato, 'non_indicato')
      RETURNING id INTO v_id;
      INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore, autore_via, dati, creato_il)
      VALUES (p_scheda_id, p_scuola_id, 'bambino_aggiunto', NULL, 'ai', jsonb_build_object('bambino_id', v_id), clock_timestamp());
      v_nuovi := v_nuovi + 1;
    ELSE
      -- completa quello che mancava, senza sovrascrivere ciò che ha scritto la segreteria
      UPDATE public.crm_bambini
         SET nome = coalesce(nome, b.nome),
             data_nascita = coalesce(data_nascita, b.nato),
             aggiornata_il = now()
       WHERE id = v_id AND scuola_id = p_scuola_id
         AND ((nome IS NULL AND b.nome IS NOT NULL) OR (data_nascita IS NULL AND b.nato IS NOT NULL));

      -- una famiglia data per persa che torna a chiedere la visita è di nuovo aperta
      IF v_esito = 'perso' THEN
        UPDATE public.crm_bambini
           SET esito = 'aperto', motivo_perdita = NULL, motivo_nota = NULL,
               esito_origine = 'automatico', esito_da = NULL, esito_il = now(), aggiornata_il = now()
         WHERE id = v_id AND scuola_id = p_scuola_id;
        INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore, autore_via, dati, creato_il)
        VALUES (p_scheda_id, p_scuola_id, 'esito_cambiato', NULL, 'ai',
                jsonb_build_object('bambino_id', v_id, 'da', 'perso', 'a', 'aperto'), clock_timestamp());
      END IF;
    END IF;
  END LOOP;

  RETURN v_nuovi;
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_bambini(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_bambini(uuid, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.crm_ai_bambini(uuid, uuid, jsonb) IS
  'CRM, accesso AI: aggiunge alla scheda i bambini che non ci sono (per data di nascita o per nome), completa i dati mancanti di quelli che ci sono e riapre un bambino dato per perso. Torna quanti ne ha aggiunti. Solo service_role.';

-- ── 5) crm_ai_registra_contatto: una famiglia nuova, senza visita ────────────
CREATE OR REPLACE FUNCTION public.crm_ai_registra_contatto(
  p_scuola_id      uuid,
  p_telefono       text,
  p_telefono_norm  text,
  p_email          text,
  p_email_norm     text,
  p_genitore_nome  text,
  p_origine        text,
  p_bambini        jsonb
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_s      jsonb;
  v_scheda uuid;
  v_n      integer := 0;
BEGIN
  IF p_bambini IS NOT NULL AND jsonb_typeof(p_bambini) = 'array' THEN
    v_n := jsonb_array_length(p_bambini);
  END IF;
  v_s := public.crm_ai_scheda(p_scuola_id, p_telefono, p_telefono_norm, p_email, p_email_norm, p_genitore_nome, p_origine, v_n);
  v_scheda := (v_s->>'scheda_id')::uuid;
  PERFORM public.crm_ai_bambini(v_scheda, p_scuola_id, p_bambini);
  RETURN v_s;
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_registra_contatto(uuid, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_registra_contatto(uuid, text, text, text, text, text, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.crm_ai_registra_contatto(uuid, text, text, text, text, text, text, jsonb) IS
  'CRM, accesso AI: registra una famiglia che ha chiesto informazioni, senza fissare una visita. Se nella sede c''e'' gia'' una scheda con quel numero o quell''email, torna quella. Solo service_role.';

-- ── 6) crm_ai_prenota: fissa una visita, una volta sola ──────────────────────
CREATE OR REPLACE FUNCTION public.crm_ai_prenota(
  p_integrazione_id uuid,
  p_scuola_id       uuid,
  p_chiave          text,
  p_impronta        text,
  p_inizio          timestamptz,
  p_durata_min      integer,
  p_candidati       uuid[],
  p_telefono        text,
  p_telefono_norm   text,
  p_email           text,
  p_email_norm      text,
  p_genitore_nome   text,
  p_origine         text,
  p_bambini         jsonb,
  p_routine         text,
  p_paura           text,
  p_desiderio       text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_r        public.crm_ai_richieste%ROWTYPE;
  v_s        jsonb;
  v_scheda   uuid;
  v_creata   boolean;
  v_app      uuid;
  v_persona  uuid;
  v_scelta   uuid;
  v_fine     timestamptz;
  v_gia      record;
  v_risposta jsonb;
  v_n        integer := 0;
BEGIN
  IF p_integrazione_id IS NULL OR p_scuola_id IS NULL OR p_chiave IS NULL OR p_impronta IS NULL
     OR p_inizio IS NULL OR p_durata_min IS NULL OR p_candidati IS NULL OR cardinality(p_candidati) = 0 THEN
    RAISE EXCEPTION 'chiave, sede, orario, durata e almeno una candidata sono obbligatori' USING ERRCODE = '22023';
  END IF;

  -- 1 · LA STESSA RICHIESTA NON VALE DUE VOLTE. Se un'altra transazione sta inserendo la stessa chiave,
  --     questa INSERT la aspetta; se quella va a buon fine qui non si inserisce niente.
  INSERT INTO public.crm_ai_richieste (scuola_id, integrazione_id, chiave, operazione, impronta)
  VALUES (p_scuola_id, p_integrazione_id, p_chiave, 'prenota', p_impronta)
  ON CONFLICT (integrazione_id, chiave) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO v_r
      FROM public.crm_ai_richieste
     WHERE integrazione_id = p_integrazione_id AND chiave = p_chiave
       FOR UPDATE;
    IF v_r.impronta <> p_impronta THEN
      RETURN jsonb_build_object('esito', 'chiave_riusata');
    END IF;
    IF v_r.risposta IS NULL THEN
      RETURN jsonb_build_object('esito', 'in_corso');
    END IF;
    RETURN v_r.risposta || jsonb_build_object('ripetuta', true);
  END IF;

  v_fine := p_inizio + make_interval(mins => p_durata_min);
  IF jsonb_typeof(p_bambini) = 'array' THEN
    v_n := jsonb_array_length(p_bambini);
  END IF;

  -- 2 · LA FAMIGLIA: quella che c'è, o una nuova (sotto blocco: vedi crm_ai_scheda)
  v_s := public.crm_ai_scheda(p_scuola_id, p_telefono, p_telefono_norm, p_email, p_email_norm, p_genitore_nome, p_origine, v_n);
  v_scheda := (v_s->>'scheda_id')::uuid;
  v_creata := (v_s->>'creata')::boolean;

  -- 3 · HA GIÀ UNA VISITA CHE DEVE ANCORA VENIRE? Allora non se ne fissa una seconda.
  IF NOT v_creata THEN
    SELECT a.id, a.inizio, a.fine INTO v_gia
      FROM public.crm_appuntamenti a
     WHERE a.scheda_id = v_scheda AND a.scuola_id = p_scuola_id
       AND a.stato = 'in_programma' AND a.fine > now()
     ORDER BY a.inizio ASC
     LIMIT 1;
    IF FOUND THEN
      v_risposta := jsonb_build_object('esito', 'gia_prenotato', 'appuntamento_id', v_gia.id,
                                       'inizio', v_gia.inizio, 'fine', v_gia.fine, 'scheda_id', v_scheda);
      UPDATE public.crm_ai_richieste
         SET risposta = v_risposta, scheda_id = v_scheda, appuntamento_id = v_gia.id, conclusa_il = clock_timestamp()
       WHERE integrazione_id = p_integrazione_id AND chiave = p_chiave;
      RETURN v_risposta;
    END IF;
  END IF;

  -- 4 · I BAMBINI e le tre domande del copione (solo dove la scheda è ancora vuota)
  PERFORM public.crm_ai_bambini(v_scheda, p_scuola_id, p_bambini);
  UPDATE public.crm_schede
     SET genitore_nome = coalesce(genitore_nome, nullif(btrim(p_genitore_nome), '')),
         routine       = coalesce(routine, nullif(btrim(p_routine), '')),
         paura         = coalesce(paura, nullif(btrim(p_paura), '')),
         desiderio     = coalesce(desiderio, nullif(btrim(p_desiderio), '')),
         aggiornata_il = now()
   WHERE id = v_scheda AND scuola_id = p_scuola_id;

  -- 5 · LA VISITA: la prima candidata libera. L'EXCLUDE di crm_appuntamenti rifiuta la sovrapposizione
  --     (exclusion_violation, 23P01): si prova la successiva.
  FOREACH v_persona IN ARRAY p_candidati LOOP
    BEGIN
      INSERT INTO public.crm_appuntamenti
        (scuola_id, scheda_id, inizio, fine, durata_min, assegnata_a, fissato_da, fissato_via, stato)
      VALUES
        (p_scuola_id, v_scheda, p_inizio, v_fine, p_durata_min, v_persona, NULL, 'ai', 'in_programma')
      RETURNING id INTO v_app;
      v_scelta := v_persona;
      EXIT;
    EXCEPTION WHEN exclusion_violation THEN
      v_app := NULL;
    END;
  END LOOP;

  IF v_app IS NULL THEN
    -- Nessuna candidata libera. La famiglia resta in scheda: è un contatto vero.
    v_risposta := jsonb_build_object('esito', 'slot_occupato', 'scheda_id', v_scheda);
    UPDATE public.crm_ai_richieste
       SET risposta = v_risposta, scheda_id = v_scheda, conclusa_il = clock_timestamp()
     WHERE integrazione_id = p_integrazione_id AND chiave = p_chiave;
    RETURN v_risposta;
  END IF;

  INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore, autore_via, dati, creato_il)
  VALUES (v_scheda, p_scuola_id, 'appuntamento_fissato', NULL, 'ai',
          jsonb_build_object('appuntamento_id', v_app, 'inizio', p_inizio, 'durata_min', p_durata_min, 'assegnata_a', v_scelta),
          clock_timestamp());

  v_risposta := jsonb_build_object('esito', 'creata', 'appuntamento_id', v_app, 'inizio', p_inizio, 'fine', v_fine,
                                   'scheda_id', v_scheda, 'scheda_creata', v_creata, 'assegnata_a', v_scelta);
  UPDATE public.crm_ai_richieste
     SET risposta = v_risposta, scheda_id = v_scheda, appuntamento_id = v_app, conclusa_il = clock_timestamp()
   WHERE integrazione_id = p_integrazione_id AND chiave = p_chiave;
  RETURN v_risposta;
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_prenota(uuid, uuid, text, text, timestamptz, integer, uuid[], text, text, text, text, text, text, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_prenota(uuid, uuid, text, text, timestamptz, integer, uuid[], text, text, text, text, text, text, jsonb, text, text, text) TO service_role;

COMMENT ON FUNCTION public.crm_ai_prenota(uuid, uuid, text, text, timestamptz, integer, uuid[], text, text, text, text, text, text, jsonb, text, text, text) IS
  'CRM, accesso AI: fissa una visita in UNA transazione. Stessa chiave = stessa risposta (idempotenza); famiglia gia'' nota = stessa scheda; famiglia gia'' prenotata = gia_prenotato; nessuna candidata libera = slot_occupato (lo decide l''EXCLUDE di crm_appuntamenti). Solo service_role.';

-- ── 7) PostgREST rilegge lo schema ───────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
```

Regole se qualcosa non torna (non improvvisare):
- Se PGlite rifiuta `hashtextextended`, usa `hashtext(…)::bigint` nelle due righe del blocco consultivo
  e scrivilo nel rapporto. Non togliere il blocco.
- Se il test «il token in chiaro non ha una colonna» cade per colpa di un commento, è il commento a
  essere scritto male: `CODICE` è già senza commenti.
- La parola `DROP`, `TRUNCATE` o `DELETE FROM` non deve comparire nel file **nemmeno in un commento
  eseguibile**; nei commenti `--` è tollerata dal test, ma evitala.

- [ ] **Passo 7: dichiara la migrazione fra quelle attese al merge.** `MIGRAZIONI_ATTESE_AL_MERGE` **non è
  un contatore** (non c'è nessun «+1» da fare): è un oggetto `{ '<nome del file>': '<ragione>' }`, oggi
  vuoto. Si cambia **una riga sola**, la 359, che da `= {}` diventa l'oggetto qui sotto con **una** voce;
  se nel frattempo qualcun altro ne ha aggiunta una, la tua si **aggiunge** alla sua, non la sostituisce. In
  `__tests__/architecture/soglia-fotografia.ts`, riga 359, l'oggetto oggi è vuoto
  (`export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {}`). Diventa (col nome
  vero del tuo file):

```ts
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {
    '<AAAAMMGGHHMMSS>_crm_accesso_ai.sql':
        'Accesso dell\'assistente AI al CRM, PR-A: la migrazione crea due tabelle nuove (`crm_integrazioni`, ' +
        '`crm_ai_richieste`), tutte e due con `scuola_id`, FK verso `schools`, `utenti`, `crm_schede` e ' +
        '`crm_appuntamenti`, un UNIQUE parziale e due UNIQUE normali, e la RLS accesa senza policy; più quattro ' +
        'funzioni `crm_ai_*` solo del service_role. La applica l\'integrazione Supabase al merge, con la version ' +
        'del file, mai a mano; il merge lo fa il titolare. La voce si toglie nella PR-B, dopo il merge: si ' +
        'rigenerano le fotografie dalla produzione e si censiscono le FK verso `utenti` in `tracce-docente-voci.ts`.',
}
```

  Sopra la riga, aggiungi un commento datato di due righe nello stile di quelli che ci sono già (chi,
  quando, perché). La ragione **deve** contenere le parole «integrazione» e `PR-B`
  (`__tests__/architecture/soglia-fotografia.test.ts:286-292`).

- [ ] **Passo 8: aggiungi i tipi** in fondo a `src/lib/crm/tipi.ts`:

```ts
/** Una chiave dell'assistente AI (`crm_integrazioni`). Il token in chiaro non c'è: solo l'impronta. */
export interface IntegrazioneRow {
  id: string
  scuola_id: string
  nome: string
  token_impronta: string
  /** gli ultimi 4 caratteri del token, per riconoscerlo a schermo */
  token_coda: string
  creata_da: string
  creata_il: string
  revocata_il: string | null
  revocata_da: string | null
  ultimo_uso_il: string | null
}

/** Una prenotazione chiesta dall'assistente (`crm_ai_richieste`). */
export interface RichiestaAiRow {
  id: string
  scuola_id: string
  integrazione_id: string
  chiave: string
  operazione: 'prenota'
  impronta: string
  risposta: Record<string, unknown> | null
  scheda_id: string | null
  appuntamento_id: string | null
  creata_il: string
  conclusa_il: string | null
}

/** Quello che `crm_ai_prenota` restituisce. */
export type EsitoPrenotaAi =
  | { esito: 'creata'; appuntamento_id: string; inizio: string; fine: string; scheda_id: string; scheda_creata: boolean; assegnata_a: string; ripetuta?: true }
  | { esito: 'gia_prenotato'; appuntamento_id: string; inizio: string; fine: string; scheda_id: string; ripetuta?: true }
  | { esito: 'slot_occupato'; scheda_id: string; ripetuta?: true }
  | { esito: 'chiave_riusata' }
  | { esito: 'in_corso' }
```

- [ ] **Passo 9: lancia tutto quello che riguarda la migrazione.**

Lancia: `npx vitest run __tests__/lib/crm/migrazione-crm-accesso-ai.test.ts __tests__/lib/crm/migrazione-crm-accesso-ai-sql.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/fk-scuola-id.test.ts __tests__/architecture/fk-nuove-con-indice.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts __tests__/lib/crm/vocabolari-allineati.test.ts`
Atteso: `Test Files 12 passed`.

Se `fk-nuove-con-indice` cade su una colonna, manca un indice che **comincia** da quella colonna:
aggiungilo (`CREATE INDEX IF NOT EXISTS idx_<tabella>_<colonna> …`), non il commento di deroga.

- [ ] **Passo 10: prova che i test guardano davvero.** Nella migrazione cambia per un momento
  `AND a.fine > now()` in `AND true` → il test «una visita in programma ma già PASSATA…» deve diventare
  rosso. Rimetti a posto. Poi togli per un momento il blocco `EXCEPTION WHEN exclusion_violation` → il
  test 6 deve diventare rosso. Rimetti a posto e rilancia: verde.

- [ ] **Passo 11: commit.**

```bash
git add supabase/migrations/*_crm_accesso_ai.sql src/lib/crm/tipi.ts __tests__/architecture/soglia-fotografia.ts __tests__/lib/crm/migrazione-crm-accesso-ai.test.ts __tests__/lib/crm/migrazione-crm-accesso-ai-sql.test.ts
```

```bash
git commit -m "CRM, accesso AI: la migrazione (chiavi, registro delle richieste, quattro funzioni) provata su PGlite"
```

(I messaggi di commit finiscono con la riga di attribuzione che la sessione indica, se la indica.)

---

### Compito 2: le quattro funzioni pure

**Parallelo:** insieme al Compito 1. **Blocca:** 3 e tutti i successivi.

**File:**
- Crea: `src/lib/crm/ai/interruttore.ts`, `src/lib/crm/ai/token.ts`, `src/lib/crm/ai/eta.ts`, `src/lib/crm/ai/idempotenza.ts`
- Test: `__tests__/lib/crm/ai/interruttore.test.ts`, `token.test.ts`, `eta.test.ts`, `idempotenza.test.ts`

**Interfacce:**
- Consuma: `formaConfronto` da `@/lib/auth/scope` (già usata in `src/lib/crm/accesso.ts:5`); `createHash`,
  `randomBytes` da `node:crypto`.
- Produce:

```ts
// src/lib/crm/ai/interruttore.ts
/** L'interruttore generale: acceso SOLO se `process.env.CRM_AI_ATTIVO === '1'`. */
export function crmAiAttivo(): boolean
/** Le sedi in cui l'assistente può entrare: `CRM_AI_SEDI_AMMESSE`, uuid separati da virgola. Vuoto = nessuna. */
export function sediAmmesseAi(): string[]
export function sedeAmmessaAi(scuolaId: string): boolean

// src/lib/crm/ai/token.ts
export const PREFISSO_TOKEN = 'kvai_'
/** `kvai_` + 43 caratteri base64url. */
export const FORMA_TOKEN: RegExp // /^kvai_[A-Za-z0-9_-]{43}$/
export function generaToken(): { token: string; impronta: string; coda: string }
/** SHA-256 esadecimale minuscolo. */
export function improntaToken(token: string): string
/** Il token dall'header `Authorization: Bearer …`, o `null` se manca o non ha la forma giusta. */
export function tokenDaRichiesta(request: Request): string | null

// src/lib/crm/ai/eta.ts
export type Grado = 'nido' | 'infanzia' | 'primaria'
/**
 * Gli ordini di scuola a cui un bambino nato in `nascita` (`AAAA-MM`) può entrare nell'anno scolastico in
 * corso o nel prossimo, visti da `oggi` (`AAAA-MM-GG`, giorno di Roma). Sempre nell'ordine nido, infanzia, primaria.
 */
export function gradiPerNascita(nascita: string, oggi: string): Grado[]
/** `2023-03-15` → `2023-03`. `null` resta `null`. */
export function meseDiNascita(dataNascita: string | null | undefined): string | null

// src/lib/crm/ai/idempotenza.ts
export const FORMA_CHIAVE_IDEMPOTENZA: RegExp // /^[A-Za-z0-9_-]{8,128}$/
/** La chiave dall'header `Idempotency-Key`, o `null` se manca o non ha la forma giusta. */
export function chiaveIdempotenza(request: Request): string | null
/** SHA-256 esadecimale del corpo, con le chiavi degli oggetti in ordine alfabetico a ogni livello. */
export function improntaCorpo(corpo: unknown): string
```

**La regola dell'età** *(scelta di Claude, da confermare col titolare — vedi in fondo)*. Sia `A` l'anno
in cui è cominciato l'anno scolastico in corso (da agosto in poi è l'anno di `oggi`, prima è l'anno
precedente: la stessa soglia di `annoScolasticoCorrente`, `src/lib/anno-scolastico.ts:25`). Per ognuno
dei due anni `A` e `A+1` si calcola `eta = anno − annoDiNascita` (gli anni che il bambino compie entro
il 31 dicembre):

| `eta` | ordine | anticipo (nati da gennaio ad aprile) |
|---|---|---|
| da 0 a 2 | nido | se `eta = 2` anche infanzia |
| da 3 a 5 | infanzia | se `eta = 5` anche primaria |
| da 6 a 10 | primaria | — |
| meno di 0, oppure 11 e oltre | nessuno | — |

Un mese di nascita **dopo** il mese di `oggi` (un bambino non ancora nato) dà `[]`. Una stringa che non
è `AAAA-MM` dà `[]`.

- [ ] **Passo 1: scrivi i quattro test.**

`__tests__/lib/crm/ai/eta.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { gradiPerNascita, meseDiNascita } from '@/lib/crm/ai/eta'

describe('gradiPerNascita', () => {
  const OGGI = '2026-11-10' // anno scolastico 2026/27: A = 2026
  it.each([
    ['2026-10', ['nido']],
    ['2025-03', ['nido', 'infanzia']], // nel 2027 compie 2 anni ed è nato a marzo: anticipo
    ['2024-06', ['nido', 'infanzia']], // nido quest'anno, infanzia l'anno prossimo
    ['2022-09', ['infanzia']],
    ['2021-02', ['infanzia', 'primaria']],
    ['2016-05', ['primaria']],
    ['2015-05', []],
    ['2027-01', []], // non ancora nato
    ['marzo 2023', []],
    ['2023-13', []],
  ])('%s → %j', (nascita, attesi) => {
    expect(gradiPerNascita(nascita, OGGI)).toEqual(attesi)
  })
  it('prima di agosto l’anno scolastico in corso è cominciato l’anno prima', () => {
    // 31/07/2026: A = 2025. Nato a settembre 2022: 3 anni nel 2025, 4 nel 2026.
    expect(gradiPerNascita('2022-09', '2026-07-31')).toEqual(['infanzia'])
    // Nato a giugno 2023: nel 2025 ne compie 2 (nido), nel 2026 ne compie 3 (infanzia).
    expect(gradiPerNascita('2023-06', '2026-07-31')).toEqual(['nido', 'infanzia'])
  })
})

describe('meseDiNascita', () => {
  it('toglie il giorno', () => {
    expect(meseDiNascita('2023-03-15')).toBe('2023-03')
    expect(meseDiNascita(null)).toBeNull()
    expect(meseDiNascita('15/03/2023')).toBeNull()
  })
})
```

`__tests__/lib/crm/ai/token.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FORMA_TOKEN, generaToken, improntaToken, tokenDaRichiesta } from '@/lib/crm/ai/token'

const req = (auth?: string) => new Request('http://localhost/x', { headers: auth ? { authorization: auth } : {} })
const FINTO = 'kvai_' + 'A'.repeat(43)

describe('token dell’assistente', () => {
  it('genera un token con la forma giusta, la sua impronta e la sua coda', () => {
    const t = generaToken()
    expect(t.token).toMatch(FORMA_TOKEN)
    expect(t.impronta).toBe(improntaToken(t.token))
    expect(t.impronta).toMatch(/^[0-9a-f]{64}$/)
    expect(t.coda).toBe(t.token.slice(-4))
    expect(generaToken().token).not.toBe(t.token)
  })
  it('l’impronta è lo SHA-256 esadecimale (valore noto)', () => {
    expect(improntaToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('legge il token solo da «Bearer <token>» ben formato', () => {
    expect(tokenDaRichiesta(req(`Bearer ${FINTO}`))).toBe(FINTO)
    expect(tokenDaRichiesta(req(`bearer ${FINTO}`))).toBe(FINTO)
    expect(tokenDaRichiesta(req())).toBeNull()
    expect(tokenDaRichiesta(req(FINTO))).toBeNull()
    expect(tokenDaRichiesta(req('Bearer kvai_corto'))).toBeNull()
    expect(tokenDaRichiesta(req(`Bearer ${FINTO} altro`))).toBeNull()
    expect(tokenDaRichiesta(req(`Basic ${FINTO}`))).toBeNull()
  })
})
```

`__tests__/lib/crm/ai/interruttore.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { crmAiAttivo, sedeAmmessaAi, sediAmmesseAi } from '@/lib/crm/ai/interruttore'
import { SEDE_A, SEDE_B } from '../../../fixtures/sedi'

afterEach(() => vi.unstubAllEnvs())

describe('interruttore dell’accesso AI', () => {
  it('senza variabile è spento', () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    expect(crmAiAttivo()).toBe(false)
  })
  it('è acceso solo con «1»', () => {
    for (const v of ['true', 'on', 'yes', '0', ' 1']) {
      vi.stubEnv('CRM_AI_ATTIVO', v)
      expect(crmAiAttivo(), v).toBe(false)
    }
    vi.stubEnv('CRM_AI_ATTIVO', '1')
    expect(crmAiAttivo()).toBe(true)
  })
  it('senza elenco nessuna sede è ammessa', () => {
    vi.stubEnv('CRM_AI_SEDI_AMMESSE', '')
    expect(sediAmmesseAi()).toEqual([])
    expect(sedeAmmessaAi(SEDE_A)).toBe(false)
  })
  it('ammette solo le sedi dell’elenco, senza badare a spazi e maiuscole', () => {
    vi.stubEnv('CRM_AI_SEDI_AMMESSE', ` ${SEDE_A.toUpperCase()} , `)
    expect(sedeAmmessaAi(SEDE_A)).toBe(true)
    expect(sedeAmmessaAi(SEDE_B)).toBe(false)
  })
})
```

`__tests__/lib/crm/ai/idempotenza.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { chiaveIdempotenza, improntaCorpo } from '@/lib/crm/ai/idempotenza'

const req = (k?: string) => new Request('http://localhost/x', { headers: k ? { 'idempotency-key': k } : {} })

describe('idempotenza', () => {
  it('legge la chiave solo se ha la forma giusta', () => {
    expect(chiaveIdempotenza(req('conv-123_a-0001'))).toBe('conv-123_a-0001')
    expect(chiaveIdempotenza(req())).toBeNull()
    expect(chiaveIdempotenza(req('corta'))).toBeNull()
    expect(chiaveIdempotenza(req('con spazi dentro'))).toBeNull()
    expect(chiaveIdempotenza(req('x'.repeat(129)))).toBeNull()
  })
  it('l’impronta non dipende dall’ordine delle chiavi, a nessun livello', () => {
    const a = improntaCorpo({ sede: 's', bambini: [{ nome: 'Bimbo Prova', dataNascita: '2023-03-15' }] })
    const b = improntaCorpo({ bambini: [{ dataNascita: '2023-03-15', nome: 'Bimbo Prova' }], sede: 's' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
  it('l’ordine degli elementi di un array invece conta, e un valore diverso cambia l’impronta', () => {
    expect(improntaCorpo({ x: [1, 2] })).not.toBe(improntaCorpo({ x: [2, 1] }))
    expect(improntaCorpo({ x: 1 })).not.toBe(improntaCorpo({ x: 2 }))
  })
})
```

- [ ] **Passo 2: lanciali e guardali fallire.**

Lancia: `npx vitest run __tests__/lib/crm/ai`
Atteso: `Test Files 4 failed` (i moduli non esistono).

- [ ] **Passo 3: scrivi i quattro moduli** con le firme del blocco Interfacce. Note che la firma non dice:
  - `generaToken`: `PREFISSO_TOKEN + randomBytes(32).toString('base64url')`.
  - `tokenDaRichiesta`: una sola espressione regolare sull'intero header, `/^Bearer (kvai_[A-Za-z0-9_-]{43})$/i`.
  - `sediAmmesseAi`: `split(',')`, `trim`, scarta i vuoti; il confronto in `sedeAmmessaAi` passa da
    `formaConfronto` su entrambi i lati.
  - `gradiPerNascita`: l'anno e il mese si leggono **dalle stringhe** (`Number(nascita.slice(0, 4))`),
    mai da un `Date`.
  - Ogni file comincia con un commento di testata nello stile di `src/lib/crm/contatti.ts:1-8`: che
    cosa fa e perché, in italiano.

- [ ] **Passo 4: lanciali e guardali passare.**

Lancia: `npx vitest run __tests__/lib/crm/ai`
Atteso: `Test Files 4 passed`.

- [ ] **Passo 5: lint e tipi sui file nuovi.**

Lancia: `npx eslint src/lib/crm/ai __tests__/lib/crm/ai --max-warnings 0` → nessun errore.
Lancia: `npx tsc --noEmit` → nessun errore.

- [ ] **Passo 6: commit.**

```bash
git add src/lib/crm/ai/interruttore.ts src/lib/crm/ai/token.ts src/lib/crm/ai/eta.ts src/lib/crm/ai/idempotenza.ts __tests__/lib/crm/ai
```

```bash
git commit -m "CRM, accesso AI: interruttore, token, età e idempotenza (funzioni pure)"
```

---
### Compito 3: il gate, i codici d'errore e i due lock

**Aspetta:** 1 e 2. **Blocca:** 4, 5, 6, 7, 8, 9. Non va in parallelo con nessuno: tocca file condivisi.

**File:**
- Crea: `src/lib/crm/ai/accesso.ts`
- Crea: `__tests__/fixtures/crm-ai.ts`
- Modifica: `src/lib/ui/esito-fetch.ts` (dopo la riga 3448, in coda al blocco dei codici del CRM)
- Modifica: `messages/it/shared.json`, `messages/en/shared.json` (accanto a `erroreCrmSlotOccupato`, riga ~759)
- Modifica: `__tests__/architecture/gate-coverage.test.ts:85-93` e `:650-653`
- Modifica: `__tests__/architecture/corpo-letto-dopo-il-gate.test.ts:79-84`
- Test: `__tests__/lib/crm/ai/accesso.test.ts`

**Interfacce:**
- Consuma: `crmAiAttivo`, `sedeAmmessaAi`, `sediAmmesseAi` (`@/lib/crm/ai/interruttore`); `tokenDaRichiesta`,
  `improntaToken` (`@/lib/crm/ai/token`); `rateLimit(key, { limit, windowMs })` →
  `{ ok, remaining, retryAfterMs }` (`src/lib/security/rate-limit.ts:405`); `createAdminClient`
  (`src/lib/supabase/server-client.ts:182`); `rispostaErroreDb` (`src/lib/crm/errori.ts:79`);
  `rifiutoSede` (`src/lib/auth/rifiuto-sede.ts:61`); `formaConfronto` (`@/lib/auth/scope`).
- Produce:

```ts
// src/lib/crm/ai/accesso.ts
export type OperazioneAi = 'slot' | 'prenota' | 'annulla' | 'contatto' | 'contatto_stato' | 'contatti_nuovi' | 'richiamo'

/** Chi sta chiamando: la chiave (per id) e la SUA sede. È l'unica sede su cui la chiamata può lavorare. */
export interface ContestoAi {
  integrazioneId: string
  scuolaId: string
  operazione: OperazioneAi
  /** `Date.now()` all'ingresso, per la durata nel registro */
  inizioMs: number
}

export const LIMITE_CHIAMATE_AI = { limit: 60, windowMs: 60_000 } as const

/** I codici che le rotte AI possono rispondere (tutti dichiarati in `CODICI_ERRORE`). */
export type CodiceAi =
  | 'CRM_AI_SPENTO' | 'TOKEN_NON_VALIDO' | 'SEDE_NON_AMMESSA' | 'TROPPE_RICHIESTE'
  | 'GIA_PRENOTATO' | 'SLOT_OCCUPATO' | 'FUORI_DISPONIBILITA' | 'CHIAVE_RIUSATA' | 'ETA_NON_COPERTA'
  | 'NESSUN_RESPONSABILE' | 'CONTATTO_OBBLIGATORIO' | 'SCHEDA_NON_TROVATA' | 'ELEMENTO_NON_TROVATO'
  | 'STATO_NON_AMMESSO' | 'INTEGRAZIONE_ESISTENTE' | 'CRM_OPERAZIONE_NON_RIUSCITA'

/** `{ error: <frase italiana del catalogo>, codice, ...extra }` con lo stato dato. */
export function rifiutoAi(codice: CodiceAi, stato: number, extra?: Record<string, string | boolean | null>): NextResponse

/**
 * IL GATE di tutte le rotte `/api/crm/ai/*`. Nell'ordine: interruttore → chiave → sede ammessa → limite.
 * Torna il contesto, oppure la risposta di rifiuto già pronta.
 */
export async function requireIntegrazioneAi(
  request: Request,
  operazione: OperazioneAi,
): Promise<{ ai: ContestoAi } | { response: NextResponse }>

/** La sede dichiarata nella richiesta è quella della chiave? `null` se sì; altrimenti 403 `SEDE_NON_ACCESSIBILE`. */
export function assertSedeDelToken(ai: ContestoAi, sedeDichiarata: string): NextResponse | null

/** Scrive la riga di registro della chiamata (una per chiamata, anche quando va bene) e restituisce la risposta. */
export function chiudiChiamataAi(
  ai: ContestoAi,
  risposta: NextResponse,
  extra?: { codice?: string; entitaId?: string | null },
): NextResponse
```

```ts
// __tests__/fixtures/crm-ai.ts
export const TOKEN_A: string            // 'kvai_' + 'A'.repeat(43) — la chiave della SEDE_A
export const TOKEN_B: string            // 'kvai_' + 'B'.repeat(43) — la chiave della SEDE_B
export const TOKEN_REVOCATO: string     // 'kvai_' + 'R'.repeat(43)
export const INTEGRAZIONE_A = '50000000-0000-4000-8000-00000000000a'
export const INTEGRAZIONE_B = '50000000-0000-4000-8000-00000000000b'
export const INTEGRAZIONE_REVOCATA = '50000000-0000-4000-8000-0000000000ff'
export const ADMIN_AI = '20000000-0000-4000-8000-0000000000ad'
/** Le tre righe di `crm_integrazioni` (A attiva, B attiva, una revocata della SEDE_A), con le impronte vere dei tre token. */
export function integrazioniFinte(): Record<string, unknown>[]
/** Una richiesta alle rotte AI. `token: null` = senza header. `chiave` = header `Idempotency-Key`. */
export function richiestaAi(percorso: string, o?: { metodo?: 'GET' | 'POST' | 'DELETE'; token?: string | null; corpo?: unknown; chiave?: string }): NextRequest
/** Accende l'interruttore e ammette quelle sedi (`vi.stubEnv`). Chi la usa chiama `vi.unstubAllEnvs()` in `afterEach`. */
export function accendiAi(sedi: string[]): void
/** Cade se nel JSON compare una di quelle parole: è il test «nessun nome di bambino nelle risposte». */
export function nessunNomeIn(json: unknown, parole: string[]): void
```

**Le risposte del gate, esatte:**

| Quando | Stato | `codice` | Altro |
|---|---|---|---|
| `crmAiAttivo()` è falso | 404 | `CRM_AI_SPENTO` | non guarda la chiave, non tocca il database |
| header assente o malformato | 401 | `TOKEN_NON_VALIDO` | header `WWW-Authenticate: Bearer` |
| impronta non trovata, o chiave revocata | 401 | `TOKEN_NON_VALIDO` | stessa risposta nei due casi: non si dice quale |
| la sede della chiave non è in `CRM_AI_SEDI_AMMESSE` | 403 | `SEDE_NON_AMMESSA` | |
| limite superato | 429 | `TROPPE_RICHIESTE` | header `Retry-After: <secondi, arrotondati per eccesso>` |
| la tabella non esiste (`PGRST205`/`42P01`) | 503 | `CRM_NON_INSTALLATO` | lo fa `rispostaErroreDb` |
| tutto bene | — | — | torna `{ ai }` e aggiorna `ultimo_uso_il` |

- [ ] **Passo 1: aggiungi i nove codici.** Prima controlla che non esistano già:

```bash
grep -n "TOKEN_NON_VALIDO\|SEDE_NON_AMMESSA\|CRM_AI_SPENTO\|GIA_PRENOTATO\|FUORI_DISPONIBILITA\|CHIAVE_RIUSATA\|ETA_NON_COPERTA\|INTEGRAZIONE_ESISTENTE\|NESSUN_RESPONSABILE" src/lib/ui/esito-fetch.ts
```

Atteso: nessuna riga. (Se uno esiste già, **non** ridichiararlo: due chiavi uguali nello stesso oggetto
non compilano. Usa quello che c'è e scrivilo nel rapporto.)

In `src/lib/ui/esito-fetch.ts`, subito dopo `CONTATTO_OBBLIGATORIO: 'erroreCrmContattoObbligatorio',`
(riga 3448), con un commento di testata nello stile del blocco sopra (righe 3407-3420) che elenca stato e
significato di ciascuno:

```ts
    TOKEN_NON_VALIDO: 'erroreCrmAiTokenNonValido',
    SEDE_NON_AMMESSA: 'erroreCrmAiSedeNonAmmessa',
    CRM_AI_SPENTO: 'erroreCrmAiSpento',
    GIA_PRENOTATO: 'erroreCrmAiGiaPrenotato',
    FUORI_DISPONIBILITA: 'erroreCrmAiFuoriDisponibilita',
    CHIAVE_RIUSATA: 'erroreCrmAiChiaveRiusata',
    ETA_NON_COPERTA: 'erroreCrmAiEtaNonCoperta',
    INTEGRAZIONE_ESISTENTE: 'erroreCrmAiIntegrazioneEsistente',
    NESSUN_RESPONSABILE: 'erroreCrmAiNessunResponsabile',
```

In `messages/it/shared.json` (accanto a `erroreCrmSlotOccupato`; **apostrofi tipografici** `’`, mai `'`):

```json
  "erroreCrmAiTokenNonValido": "La chiave dell’assistente manca, è sbagliata o è stata revocata.",
  "erroreCrmAiSedeNonAmmessa": "L’accesso dell’assistente non è attivo per questa sede.",
  "erroreCrmAiSpento": "L’accesso dell’assistente è spento.",
  "erroreCrmAiGiaPrenotato": "Questa famiglia ha già una visita in programma.",
  "erroreCrmAiFuoriDisponibilita": "Questo orario non è fra quelli disponibili.",
  "erroreCrmAiChiaveRiusata": "Questa chiave di richiesta è già stata usata per una richiesta diversa.",
  "erroreCrmAiEtaNonCoperta": "In questa sede non c’è una classe per l’età del bambino.",
  "erroreCrmAiIntegrazioneEsistente": "Questa sede ha già una chiave attiva. Revocala prima di crearne un’altra.",
  "erroreCrmAiNessunResponsabile": "In questa sede non c’è nessuno a cui affidare il richiamo.",
```

In `messages/en/shared.json`, le stesse chiavi:

```json
  "erroreCrmAiTokenNonValido": "The assistant key is missing, wrong or has been revoked.",
  "erroreCrmAiSedeNonAmmessa": "Assistant access is not enabled for this school.",
  "erroreCrmAiSpento": "Assistant access is switched off.",
  "erroreCrmAiGiaPrenotato": "This family already has a visit scheduled.",
  "erroreCrmAiFuoriDisponibilita": "This time is not among the available ones.",
  "erroreCrmAiChiaveRiusata": "This request key has already been used for a different request.",
  "erroreCrmAiEtaNonCoperta": "This school has no class for the child’s age.",
  "erroreCrmAiIntegrazioneEsistente": "This school already has an active key. Revoke it before creating another one.",
  "erroreCrmAiNessunResponsabile": "There is nobody in this school to assign the call-back to.",
```

- [ ] **Passo 2: insegna il gate nuovo ai due lock.**
  - `__tests__/architecture/gate-coverage.test.ts`, elenco `GATE_BASE` (righe 85-93): aggiungi in coda

    ```ts
        // Le rotte `/api/crm/ai/*` non hanno una sessione: chi chiama è l'assistente, e lo dice una chiave
        // (Bearer) di cui il database conserva l'impronta. Il gate nega senza chiave, con una chiave revocata,
        // fuori dalle sedi ammesse e a interruttore spento (piano 2026-11-10-crm-accesso-ai, Compito 3).
        'requireIntegrazioneAi',
    ```

    e nello stesso file, dopo il ciclo delle righe 650-653, aggiungi la prova che il gate esiste davvero
    con quel nome:

    ```ts
        const aiSrc = fs.readFileSync(path.join(LIB_ROOT, 'crm', 'ai', 'accesso.ts'), 'utf8')
        expect(aiSrc, 'requireIntegrazioneAi non esiste più: aggiorna GATE_BASE').toContain('export async function requireIntegrazioneAi')
    ```

    **Non** toccare `PUBBLICHE` (riga 349) né i suoi tetti: le rotte AI hanno un gate, non sono pubbliche.
  - `__tests__/architecture/corpo-letto-dopo-il-gate.test.ts`, la seconda copia dell'elenco (righe 79-84):
    aggiungi `'requireIntegrazioneAi',` con una riga di commento.

- [ ] **Passo 3: scrivi la fixture** `__tests__/fixtures/crm-ai.ts` con le firme del blocco Interfacce.
  `integrazioniFinte()` restituisce:

```ts
[
  { id: INTEGRAZIONE_A, scuola_id: SEDE_A, nome: 'Assistente', token_impronta: improntaToken(TOKEN_A), token_coda: 'AAAA',
    creata_da: ADMIN_AI, creata_il: '2026-11-10T09:00:00.000Z', revocata_il: null, revocata_da: null, ultimo_uso_il: null },
  { id: INTEGRAZIONE_B, scuola_id: SEDE_B, nome: 'Assistente', token_impronta: improntaToken(TOKEN_B), token_coda: 'BBBB',
    creata_da: ADMIN_AI, creata_il: '2026-11-10T09:00:00.000Z', revocata_il: null, revocata_da: null, ultimo_uso_il: null },
  { id: INTEGRAZIONE_REVOCATA, scuola_id: SEDE_A, nome: 'Vecchia', token_impronta: improntaToken(TOKEN_REVOCATO), token_coda: 'RRRR',
    creata_da: ADMIN_AI, creata_il: '2026-11-01T09:00:00.000Z', revocata_il: '2026-11-09T09:00:00.000Z', revocata_da: ADMIN_AI, ultimo_uso_il: null },
]
```

  `richiestaAi` costruisce `new NextRequest('http://localhost' + percorso, …)` con
  `content-type: application/json` quando c'è un corpo, `authorization: 'Bearer ' + token` (default
  `TOKEN_A`; con `token: null` niente header) e `idempotency-key` quando c'è `chiave`.

- [ ] **Passo 4: scrivi il test del gate** — `__tests__/lib/crm/ai/accesso.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../../fixtures/sedi'
import { INTEGRAZIONE_A, TOKEN_A, TOKEN_B, TOKEN_REVOCATO, accendiAi, integrazioniFinte, richiestaAi } from '../../../fixtures/crm-ai'
import { improntaToken } from '@/lib/crm/ai/token'

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
  scritture: [] as unknown[],
  tabelleToccate: [] as string[],
  limite: { ok: true, remaining: 59, retryAfterMs: 0 },
  rateLimit: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const vero = creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori as Record<string, ErrorePostgrest>, scritture: h.scritture as Scrittura[] })
    return new Proxy(vero, {
      get(bersaglio, prop, ricevitore) {
        if (prop !== 'from') return Reflect.get(bersaglio, prop, ricevitore)
        return (tabella: string) => { h.tabelleToccate.push(tabella); return bersaglio.from(tabella) }
      },
    })
  },
}))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: (...a: unknown[]) => h.rateLimit(...a) }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: (...a: unknown[]) => h.logEvento(...a) }
})

import { LIMITE_CHIAMATE_AI, assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi } from '@/lib/crm/ai/accesso'

const corpo = async (r: Response) => (await r.json()) as { error?: string; codice?: string }

beforeEach(() => {
  accendiAi([SEDE_A, SEDE_B])
  h.db = { crm_integrazioni: integrazioniFinte() }
  h.errori = {}
  h.scritture = []
  h.tabelleToccate = []
  h.limite = { ok: true, remaining: 59, retryAfterMs: 0 }
  h.rateLimit = vi.fn(async () => h.limite)
  h.logEvento = vi.fn()
})
afterEach(() => vi.unstubAllEnvs())

describe('requireIntegrazioneAi', () => {
  it('R9 · a interruttore spento risponde 404 e non guarda né la chiave né il database', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('response' in g && g.response.status).toBe(404)
    expect('response' in g && (await corpo(g.response)).codice).toBe('CRM_AI_SPENTO')
    expect(h.tabelleToccate).toEqual([])
    expect(h.rateLimit).not.toHaveBeenCalled()
  })
  it.each([
    ['senza header', null],
    ['malformata', 'kvai_corta'],
    ['sconosciuta', 'kvai_' + 'Z'.repeat(43)],
    ['R7 · revocata', TOKEN_REVOCATO],
  ])('chiave %s → 401 TOKEN_NON_VALIDO', async (_nome, token) => {
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot', { token }), 'slot')
    expect('response' in g).toBe(true)
    if (!('response' in g)) return
    expect(g.response.status).toBe(401)
    expect((await corpo(g.response)).codice).toBe('TOKEN_NON_VALIDO')
    expect(g.response.headers.get('www-authenticate')).toBe('Bearer')
    expect(h.rateLimit).not.toHaveBeenCalled()
  })
  it('una sede fuori dall’elenco delle ammesse → 403 SEDE_NON_AMMESSA', async () => {
    accendiAi([SEDE_B])
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('response' in g && g.response.status).toBe(403)
    expect('response' in g && (await corpo(g.response)).codice).toBe('SEDE_NON_AMMESSA')
  })
  it('con l’elenco delle sedi vuoto lascia una riga di livello error: è configurazione mancante', async () => {
    accendiAi([])
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect(h.logEvento.mock.calls.some((c) => c[0] === 'crm' && c[1] === 'error' && c[2].esito === 'ai-sedi-ammesse-vuote')).toBe(true)
  })
  it('chiave buona: torna il contesto con la sede DELLA CHIAVE, e scrive l’ultimo uso', async () => {
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('ai' in g && g.ai).toMatchObject({ integrazioneId: INTEGRAZIONE_A, scuolaId: SEDE_A, operazione: 'slot' })
    expect(h.rateLimit).toHaveBeenCalledWith(`crm-ai:${INTEGRAZIONE_A}`, LIMITE_CHIAMATE_AI)
    expect(LIMITE_CHIAMATE_AI).toEqual({ limit: 60, windowMs: 60_000 })
    const riga = h.db.crm_integrazioni.find((r) => r.id === INTEGRAZIONE_A)
    expect(typeof riga?.ultimo_uso_il).toBe('string')
  })
  it('la chiave della sede B dà la sede B', async () => {
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot', { token: TOKEN_B }), 'slot')
    expect('ai' in g && g.ai.scuolaId).toBe(SEDE_B)
  })
  it('oltre il limite → 429 TROPPE_RICHIESTE con Retry-After in secondi', async () => {
    h.limite = { ok: false, remaining: 0, retryAfterMs: 12_300 }
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('response' in g && g.response.status).toBe(429)
    expect('response' in g && g.response.headers.get('retry-after')).toBe('13')
    expect('response' in g && (await corpo(g.response)).codice).toBe('TROPPE_RICHIESTE')
  })
  it('se la tabella delle chiavi non esiste risponde 503 CRM_NON_INSTALLATO, non 401', async () => {
    h.errori = { crm_integrazioni: { code: 'PGRST205', message: 'tabella assente' } }
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('response' in g && g.response.status).toBe(503)
    expect('response' in g && (await corpo(g.response)).codice).toBe('CRM_NON_INSTALLATO')
  })
  it('né il token né la sua impronta finiscono mai in un log', async () => {
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot', { token: TOKEN_REVOCATO }), 'slot')
    const tutto = JSON.stringify(h.logEvento.mock.calls)
    for (const segreto of [TOKEN_A, TOKEN_REVOCATO, improntaToken(TOKEN_A), improntaToken(TOKEN_REVOCATO)]) {
      expect(tutto).not.toContain(segreto)
    }
  })
})

describe('assertSedeDelToken', () => {
  const ai = { integrazioneId: INTEGRAZIONE_A, scuolaId: SEDE_A, operazione: 'slot' as const, inizioMs: 0 }
  it('la sede della chiave passa, anche scritta in maiuscolo', () => {
    expect(assertSedeDelToken(ai, SEDE_A)).toBeNull()
    expect(assertSedeDelToken(ai, SEDE_A.toUpperCase())).toBeNull()
  })
  it('R2 · un’altra sede → 403 SEDE_NON_ACCESSIBILE, con una riga warn', async () => {
    const r = assertSedeDelToken(ai, SEDE_B)
    expect(r?.status).toBe(403)
    expect((await corpo(r as Response)).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'warn' && c[2].esito === 'ai-sede-diversa-dalla-chiave')).toBe(true)
  })
})

describe('chiudiChiamataAi e rifiutoAi', () => {
  const ai = { integrazioneId: INTEGRAZIONE_A, scuolaId: SEDE_A, operazione: 'prenota' as const, inizioMs: Date.now() }
  it('una riga per chiamata, anche quando va bene, con i soli campi ammessi', () => {
    const r = chiudiChiamataAi(ai, rifiutoAi('GIA_PRENOTATO', 409), { codice: 'GIA_PRENOTATO' })
    expect(r.status).toBe(409)
    const riga = h.logEvento.mock.calls.find((c) => c[2].esito === 'ai-chiamata')
    expect(riga?.[0]).toBe('crm')
    expect(riga?.[1]).toBe('warn')
    expect(Object.keys(riga?.[2] ?? {}).sort()).toEqual(['entita_id', 'error_code', 'esito', 'integrazione_id', 'ms', 'operazione', 'scuola_id', 'stato'])
    expect(riga?.[2]).toMatchObject({ operazione: 'crm/ai:prenota', stato: 409, error_code: 'GIA_PRENOTATO', scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A })
  })
  it('rifiutoAi mette la frase del catalogo, il codice e gli extra', async () => {
    const r = rifiutoAi('GIA_PRENOTATO', 409, { inizio: '2026-11-17T08:00:00.000Z' })
    expect(await r.json()).toEqual({
      error: 'Questa famiglia ha già una visita in programma.',
      codice: 'GIA_PRENOTATO',
      inizio: '2026-11-17T08:00:00.000Z',
    })
  })
})
```

- [ ] **Passo 5: lancialo e guardalo fallire.**

Lancia: `npx vitest run __tests__/lib/crm/ai/accesso.test.ts`
Atteso: `Test Files 1 failed` (il modulo `@/lib/crm/ai/accesso` non esiste).

- [ ] **Passo 6: scrivi `src/lib/crm/ai/accesso.ts`.** `requireIntegrazioneAi` fa **questi otto passi, in
  quest'ordine**, e a ogni rifiuto esce subito (`op` è `'crm/ai:' + operazione`):

  | # | Controllo | Se non passa | Riga di log |
  |---|---|---|---|
  | 1 | `crmAiAttivo()` | `rifiutoAi('CRM_AI_SPENTO', 404)` | `warn`, `esito: 'ai-rifiutata'`, `error_code: 'CRM_AI_SPENTO'` — al più una al minuto |
  | 2 | `tokenDaRichiesta(request)` non è `null` | `rifiutoAi('TOKEN_NON_VALIDO', 401)` + header `WWW-Authenticate: Bearer` | come sopra, `error_code: 'TOKEN_NON_VALIDO'` — al più una al minuto |
  | 3 | la lettura di `crm_integrazioni` per impronta non dà `error` | `rispostaErroreDb(error, 'crm/ai/accesso:requireIntegrazioneAi')` (503 se la tabella manca, 500 altrimenti) | la scrive `rispostaErroreDb` |
  | 4 | la riga esiste **e** `revocata_il` è nullo | `401 TOKEN_NON_VALIDO`, identica al passo 2 | come al passo 2 |
  | 5 | `sediAmmesseAi().length > 0` | `rifiutoAi('SEDE_NON_AMMESSA', 403)` | **`error`**: vedi la riga di codice qui sotto |
  | 6 | `sedeAmmessaAi(riga.scuola_id)` | `rifiutoAi('SEDE_NON_AMMESSA', 403)` | `warn`, `esito: 'ai-rifiutata'`, `error_code: 'SEDE_NON_AMMESSA'`, `integrazione_id`, `scuola_id` — sempre |
  | 7 | `(await rateLimit('crm-ai:' + riga.id, LIMITE_CHIAMATE_AI)).ok` | `rifiutoAi('TROPPE_RICHIESTE', 429)` + header `Retry-After: String(Math.ceil(retryAfterMs / 1000))` | `warn`, `esito: 'ai-rifiutata'`, `error_code: 'TROPPE_RICHIESTE'`, `integrazione_id`, `scuola_id` — sempre |
  | 8 | scrive `ultimo_uso_il` | **non rifiuta mai** | se fallisce: `error`, `esito: 'ai-ultimo-uso-non-scritto'` |

  Poi torna `{ ai: { integrazioneId: riga.id, scuolaId: riga.scuola_id, operazione, inizioMs } }`
  (`inizioMs` è il `Date.now()` preso alla **prima** riga della funzione).

  Il passo 5 è la riga che il test «con l'elenco delle sedi vuoto…» pretende. Interruttore acceso ed
  elenco vuoto vuol dire che qualcuno ha acceso `CRM_AI_ATTIVO` e ha dimenticato `CRM_AI_SEDI_AMMESSE`:
  è configurazione mancante, cioè livello `error` (`AGENTS.md`, «Logging», regola 4), e si scrive
  **ogni volta**, senza il tetto di una al minuto:

  ```ts
  if (sediAmmesseAi().length === 0) {
    logEvento('crm', 'error', { operazione: op, esito: 'ai-sedi-ammesse-vuote', stato: 403, integrazione_id: riga.id, scuola_id: riga.scuola_id })
    return { response: rifiutoAi('SEDE_NON_AMMESSA', 403) }
  }
  ```

  `assertSedeDelToken`, quando rifiuta, scrive
  `logEvento('multi_sede', 'warn', { operazione: 'crm/ai:' + ai.operazione, esito: 'ai-sede-diversa-dalla-chiave', integrazione_id: ai.integrazioneId, sede_id: ai.scuolaId })`
  e restituisce `rifiutoSede('SEDE_NON_ACCESSIBILE')`. (La sede **dichiarata** nella richiesta non si
  logga: è un valore scelto da chi chiama.)

  Altre regole che firme e test non dicono:
  - `rifiutoAi` prende la frase come fa `rifiutoSede` (`src/lib/auth/rifiuto-sede.ts:1-3, 59-66`):
    `import it from '../../../../messages/it/shared.json'` e `CATALOGO[CODICI_ERRORE[codice]]`.
  - La ricerca della chiave è **una** lettura:
    `supabase.from('crm_integrazioni').select('id, scuola_id, revocata_il').eq('token_impronta', impronta).maybeSingle()`.
    `error` → `rispostaErroreDb(error, 'crm/ai/accesso:requireIntegrazioneAi')`.
  - L'ultimo uso: `.update({ ultimo_uso_il: new Date().toISOString() }).eq('id', id).eq('scuola_id', scuolaId)`.
    Se fallisce **non** si rifiuta la chiamata: `logEvento('crm', 'error', { operazione, esito: 'ai-ultimo-uso-non-scritto', integrazione_id }, error)` e si va avanti.
  - I rifiuti **prima** della chiave (interruttore spento, chiave non valida) scrivono una riga `warn`
    (`esito: 'ai-rifiutata'`, `error_code`, `stato`, `operazione: 'crm/ai:<operazione>'`), ma **al più
    una al minuto per istanza**: chiunque può bussare a queste rotte, e senza un tetto riempirebbe
    `app_log`. Il modello è `SILENZIO_LOG_MS` / `ultimoLogDegrado` in `src/lib/security/rate-limit.ts:158, 183, 245-248`.
    I rifiuti **dopo** la chiave (sede non ammessa, limite) si loggano sempre, con `integrazione_id`.
  - `chiudiChiamataAi`: livello `error` se lo stato è ≥ 500, `warn` se ≥ 400, altrimenti `info`. Campi
    esatti: `operazione: 'crm/ai:' + ai.operazione`, `esito: 'ai-chiamata'`, `stato`, `error_code`
    (`extra.codice ?? null`), `scuola_id`, `integrazione_id`, `entita_id` (`extra.entitaId ?? null`),
    `ms` (`Date.now() - ai.inizioMs`).
  - Nel file la parola `createAdminClient` compare (il gate apre il suo client): va bene, non è un file
    di rotta.

- [ ] **Passo 7: lancia il test del gate e i lock toccati.**

Lancia: `npx vitest run __tests__/lib/crm/ai/accesso.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/architecture/corpo-letto-dopo-il-gate.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-plurali-e-glossario.test.ts __tests__/architecture/logging-coverage.test.ts`
Atteso: `Test Files 7 passed`.

- [ ] **Passo 8: prova che il test guarda davvero.** In `requireIntegrazioneAi` togli per un momento il
  controllo `revocata_il` → il caso «R7 · revocata» deve diventare rosso. Rimetti a posto.

- [ ] **Passo 9: commit.**

```bash
git add src/lib/crm/ai/accesso.ts src/lib/ui/esito-fetch.ts messages/it/shared.json messages/en/shared.json __tests__/fixtures/crm-ai.ts __tests__/lib/crm/ai/accesso.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/architecture/corpo-letto-dopo-il-gate.test.ts
```

```bash
git commit -m "CRM, accesso AI: il gate a chiave (interruttore, impronta, sede ammessa, limite) e i suoi codici d'errore"
```

---

## Impalcatura comune dei test delle rotte AI (la leggono i compiti 5, 6, 7, 8 e 9)

Ogni file `__tests__/api/crm-ai-*.test.ts` comincia così. Il gate è quello **vero**: così «chiave di
un'altra sede» si prova sul serio in ogni rotta. È finto solo quello che sta fuori: il database, il
limite, le notifiche.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { INTEGRAZIONE_A, INTEGRAZIONE_B, TOKEN_B, accendiAi, integrazioniFinte, nessunNomeIn, richiestaAi } from '../fixtures/crm-ai'

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
  scritture: [] as unknown[],
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
  chiamateRpc: [] as { nome: string; args: Record<string, unknown> }[],
  notifica: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    creaFintoSupabase(h.db as DBFinto, [], {
      errori: h.errori as Record<string, ErrorePostgrest>,
      scritture: h.scritture as Scrittura[],
      rpc: Object.fromEntries(
        ['crm_ai_prenota', 'crm_ai_registra_contatto'].map((nome) => [
          nome,
          async (args: Riga) => {
            h.chiamateRpc.push({ nome, args })
            const impl = h.rpc[nome]
            if (!impl) throw new Error(`rpc ${nome} non preparata dal test`)
            return impl(args)
          },
        ]),
      ),
    }),
}))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: async () => ({ ok: true, remaining: 59, retryAfterMs: 0 }) }))
vi.mock('@/lib/notifiche/triggers', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/notifiche/triggers')>()
  return { ...vero, notificaEvento: (...a: unknown[]) => h.notifica(...a) }
})

const U1 = '20000000-0000-4000-8000-000000000001' // segreteria della SEDE_A
const U2 = '20000000-0000-4000-8000-000000000002' // una collega della SEDE_A
const U_B = '20000000-0000-4000-8000-00000000000b' // segreteria della SEDE_B
const TEL = '333 000 0001'
const TEL_NORM = '3330000001'
// Lo stesso numero scritto in altri modi, e un testo che non è un numero (in costanti: vedi la trappola 5).
const TEL_PREFISSO = '+39 333-0000001'
const TEL_0039 = '0039 333-0000001'
const TEL_NON_NUMERO = 'non lo so'
const NASCITA = '2022-09-15'
const NOME_BIMBO = 'Bimbo Prova'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T07:00:00.000Z')) // lunedì 16/11/2026, 08:00 a Roma
  accendiAi([SEDE_A, SEDE_B])
  h.errori = {}
  h.scritture = []
  h.rpc = {}
  h.chiamateRpc = []
  h.notifica = vi.fn().mockResolvedValue(undefined)
  h.db = {
    crm_integrazioni: integrazioniFinte(),
    utenti: [
      { id: U1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: U2, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: U_B, nome: 'Marta', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
    ],
    utenti_scuole: [],
    sections: [{ id: 'sez-1', scuola_id: SEDE_A, name: 'Coccinelle', school_type: 'infanzia' }],
    crm_schede: [],
    crm_bambini: [],
    crm_appuntamenti: [],
    crm_settimane: [],
    crm_fasce: [],
    crm_indisponibilita: [],
    crm_eventi: [],
    crm_azioni: [],
    crm_ai_richieste: [],
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** Come `programma` di `__tests__/api/crm-appuntamenti.test.ts:119-141`: una testata e le sue fasce. */
let contatore = 0
function programma(utenteId: string | null, fasce: Riga[], settimana = '2026-11-16', sede = SEDE_A) {
  const id = `s-${++contatore}`
  h.db.crm_settimane.push({ id, scuola_id: sede, utente_id: utenteId, settimana, aggiornata_da: null, aggiornata_il: '2026-11-10T09:00:00.000Z' })
  fasce.forEach((f, n) =>
    h.db.crm_fasce.push({ id: `${id}-f${n}`, scuola_id: sede, settimana_id: id, giorno_settimana: 2, ora_inizio: '09:00:00', ora_fine: '10:30:00', durata_slot_min: 45, ...f }),
  )
}
const scritte = (tabella: string, operazione: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
```

Con `programma(null, [{}])` la **sede** A riceve martedì 17/11/2026 dalle 9:00 alle 10:30 di Roma: due
orari da 45 minuti, `2026-11-17T08:00:00.000Z` e `2026-11-17T08:45:00.000Z` (a novembre Roma è UTC+1).
Le persone libere sono `U1` e `U2`, in ordine di cognome e nome: `[U1, U2]`.

Se il finto database rifiuta un filtro («non emulato»), **non aggirarlo**: l'elenco di quelli che sa
applicare è in `__tests__/fixtures/finto-supabase.ts:23-26`; scegli un filtro di quell'elenco.

Tre casi vanno in **ogni** file `crm-ai-*.test.ts` (cambia solo la rotta):

```ts
it('R9 · a interruttore spento risponde 404 CRM_AI_SPENTO', async () => {
  vi.stubEnv('CRM_AI_ATTIVO', '')
  const r = await <HANDLER>(<richiesta valida>)
  expect(r.status).toBe(404)
})
it('senza chiave risponde 401 TOKEN_NON_VALIDO e non scrive niente', async () => {
  const r = await <HANDLER>(<richiesta valida con token: null>)
  expect(r.status).toBe(401)
  expect(h.scritture.filter((s) => (s as Scrittura).tabella !== 'crm_integrazioni')).toEqual([])
  expect(h.chiamateRpc).toEqual([])
})
it('R2 · la chiave della sede B su una richiesta che dichiara la sede A → 403 SEDE_NON_ACCESSIBILE, e non scrive niente', async () => {
  const r = await <HANDLER>(<richiesta valida con token: TOKEN_B, che dichiara sede: SEDE_A>)
  expect(r.status).toBe(403)
  expect((await r.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
  expect(h.scritture.filter((s) => (s as Scrittura).tabella !== 'crm_integrazioni')).toEqual([])
  expect(h.chiamateRpc).toEqual([])
})
```

E ogni rotta ha questa **forma** (cambia `operazione` e lo schema). L'ordine delle righe non si cambia:
lo controllano i lock `gate-coverage` e `corpo-letto-dopo-il-gate`.

```ts
export const POST = withRoute('crm/ai/<nome>:POST', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, '<operazione>')   // 1 · il gate, per primo
  if ('response' in g) return g.response
  const { ai } = g

  const b = await parseBody(request, bodySchema)                   // 2 · poi il corpo
  if ('response' in b) return chiudiChiamataAi(ai, b.response)

  const altraSede = assertSedeDelToken(ai, b.data.sede)            // 3 · la sede dichiarata è quella della chiave
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const supabase = await createAdminClient()                       // 4 · solo ora il database
  // … il lavoro, sempre con ai.scuolaId …
  return chiudiChiamataAi(ai, NextResponse.json({ … }, { status: 201 }), { entitaId: … })
})
```

Ogni uscita dell'handler dopo il gate passa da `chiudiChiamataAi`: è il registro delle chiamate.

---

### Compito 4: le chiavi — creare, elencare, revocare (solo Direzione)

**Aspetta:** 3. **Parallelo con:** 5, 7, 8, 9. **Blocca:** 10.

**File:**
- Crea: `src/app/api/admin/crm/integrazioni/route.ts`, `src/app/api/admin/crm/integrazioni/[id]/route.ts`
- Test: `__tests__/api/crm-integrazioni.test.ts`

**Interfacce:**
- Consuma: `requireCrm` (`src/lib/crm/accesso.ts:29`); `resolveScuoleAttive`, `restringiSedi`,
  `resolveScuolaScrittura` (`@/lib/auth/scope`, usati così in `src/app/api/admin/crm/schede/route.ts:127-139, 329-331`);
  `assertSedeInScope`, `elementoNonTrovato` (`src/lib/crm/agenda.ts:94, 102`); `rispostaErroreDbSchema`
  (`src/lib/crm/errori.ts:105`); `generaToken` (`@/lib/crm/ai/token`); `crmAiAttivo`, `sedeAmmessaAi`
  (`@/lib/crm/ai/interruttore`); `rifiutoAi` (`@/lib/crm/ai/accesso`).
- Produce (le usa il Compito 10):

| Rotta | Chi | Richiesta | Risposta |
|---|---|---|---|
| `GET /api/admin/crm/integrazioni?scuolaId=<uuid>` | admin | — | `200 { "data": [{ "id", "nome", "coda", "creataIl", "revocataIl", "ultimoUsoIl" }], "aiAttivo": bool, "sedeAmmessa": bool }` — dalla più recente; **mai** `token_impronta` |
| `POST /api/admin/crm/integrazioni` | admin | `{ "scuolaId": uuid, "nome": "testo 1–80" }` | `201 { "id": uuid, "token": "kvai_…" }` — il token si vede **solo qui** |
| `DELETE /api/admin/crm/integrazioni/<id>` | admin | — | `200 { "id": uuid, "revocata": true }` (anche se era già revocata) |

Rifiuti: segreteria → `403 SOLO_ADMIN` (la frase e la forma sono quelle di
`src/app/api/admin/crm/statistiche/route.ts:110-111`); sede non dell'utente → `403 SEDE_NON_ACCESSIBILE`;
sede non in `CRM_AI_SEDI_AMMESSE` (solo `POST`) → `403 SEDE_NON_AMMESSA`; la sede ha già una chiave
attiva (`23505` sull'indice `crm_integrazioni_una_attiva_per_sede`) → `409 INTEGRAZIONE_ESISTENTE`;
chiave inesistente → `404 ELEMENTO_NON_TROVATO`.

- [ ] **Passo 1: scrivi il test** `__tests__/api/crm-integrazioni.test.ts`. Impalcatura: quella di
  `__tests__/api/crm-appuntamenti.test.ts:18-62` (gate di ruolo finto con `h.ruolo`, `scuoleDiUtente`
  vero, database finto). Sedi e utenti come lì (`ADMIN` con `utenti_scuole` su A e B). In `beforeEach`:
  `h.ruolo = 'admin'`, `h.userId = ADMIN`, `h.attive = [SEDE_A, SEDE_B]`,
  `h.db.crm_integrazioni = integrazioniFinte()` e `accendiAi([SEDE_A, SEDE_B])` (con
  `vi.unstubAllEnvs()` in `afterEach`); da `../fixtures/crm-ai` si importano anche `TOKEN_A`,
  `INTEGRAZIONE_A`, `INTEGRAZIONE_B`, `INTEGRAZIONE_REVOCATA`. Casi, con questi nomi e queste asserzioni:

```ts
it('la segreteria non crea, non elenca e non revoca: 403 SOLO_ADMIN', async () => {
  h.ruolo = 'segreteria'
  for (const r of [await GET(get(`?scuolaId=${SEDE_A}`)), await POST(post({ scuolaId: SEDE_A, nome: 'Assistente' })), await DELETE(del(), ctx(INTEGRAZIONE_A))]) {
    expect(r.status).toBe(403)
    expect((await r.json()).codice).toBe('SOLO_ADMIN')
  }
  expect(scritte('crm_integrazioni', 'insert')).toHaveLength(0)
})
it('crea la chiave: la risposta porta il token, il database solo l’impronta', async () => {
  h.db.crm_integrazioni = []
  const r = await POST(post({ scuolaId: SEDE_A, nome: 'Assistente' }))
  expect(r.status).toBe(201)
  const { id, token } = await r.json()
  expect(token).toMatch(/^kvai_[A-Za-z0-9_-]{43}$/)
  const riga = h.db.crm_integrazioni[0]
  expect(riga).toMatchObject({ id, scuola_id: SEDE_A, nome: 'Assistente', token_impronta: improntaToken(token), token_coda: token.slice(-4), creata_da: ADMIN })
  expect(JSON.stringify(h.db)).not.toContain(token)
})
it('la sede non ammessa non riceve una chiave: 403 SEDE_NON_AMMESSA', async () => {
  accendiAi([SEDE_B])
  h.db.crm_integrazioni = []
  const r = await POST(post({ scuolaId: SEDE_A, nome: 'Assistente' }))
  expect(r.status).toBe(403)
  expect((await r.json()).codice).toBe('SEDE_NON_AMMESSA')
  expect(h.db.crm_integrazioni).toHaveLength(0)
})
it('la sede ha già una chiave attiva (23505): 409 INTEGRAZIONE_ESISTENTE', async () => {
  h.errori = { 'crm_integrazioni:insert': { code: '23505', message: 'duplicate key' } }
  const r = await POST(post({ scuolaId: SEDE_A, nome: 'Seconda' }))
  expect(r.status).toBe(409)
  expect((await r.json()).codice).toBe('INTEGRAZIONE_ESISTENTE')
})
it('l’elenco non porta mai l’impronta, e dice se l’interruttore è acceso per quella sede', async () => {
  const r = await GET(get(`?scuolaId=${SEDE_A}`))
  const j = await r.json()
  expect(j.aiAttivo).toBe(true)
  expect(j.sedeAmmessa).toBe(true)
  expect(j.data.map((x: { id: string }) => x.id)).toEqual([INTEGRAZIONE_A, INTEGRAZIONE_REVOCATA])
  expect(Object.keys(j.data[0]).sort()).toEqual(['coda', 'creataIl', 'id', 'nome', 'revocataIl', 'ultimoUsoIl'])
  expect(JSON.stringify(j)).not.toContain(improntaToken(TOKEN_A))
})
it('un’admin non vede le chiavi di una sede che non è sua: 403 SEDE_NON_ACCESSIBILE', async () => {
  h.attive = [SEDE_A]
  h.db.utenti_scuole = [{ utente_id: ADMIN, scuola_id: SEDE_A }]
  expect((await GET(get(`?scuolaId=${SEDE_B}`))).status).toBe(403)
  expect((await DELETE(del(), ctx(INTEGRAZIONE_B))).status).toBe(403)
  expect(h.db.crm_integrazioni.find((x) => x.id === INTEGRAZIONE_B)?.revocata_il).toBeNull()
})
it('revoca: scrive quando e chi, e la seconda volta risponde lo stesso 200 senza riscrivere', async () => {
  const r1 = await DELETE(del(), ctx(INTEGRAZIONE_A))
  expect(await r1.json()).toEqual({ id: INTEGRAZIONE_A, revocata: true })
  const riga = h.db.crm_integrazioni.find((x) => x.id === INTEGRAZIONE_A)
  expect(riga?.revocata_da).toBe(ADMIN)
  const quando = riga?.revocata_il
  expect(typeof quando).toBe('string')
  const r2 = await DELETE(del(), ctx(INTEGRAZIONE_A))
  expect(r2.status).toBe(200)
  expect(h.db.crm_integrazioni.find((x) => x.id === INTEGRAZIONE_A)?.revocata_il).toBe(quando)
})
it('una chiave che non esiste: 404 ELEMENTO_NON_TROVATO', async () => {
  expect((await DELETE(del(), ctx('50000000-0000-4000-8000-000000000404'))).status).toBe(404)
})
it('D1 · ruotare: revoca la chiave consegnata, poi ne crea una nuova per la stessa sede', async () => {
  expect((await DELETE(del(), ctx(INTEGRAZIONE_A))).status).toBe(200)
  const r = await POST(post({ scuolaId: SEDE_A, nome: 'Assistente' }))
  expect(r.status).toBe(201)
  const { id, token } = await r.json()
  expect(token).not.toBe(TOKEN_A)
  const attive = h.db.crm_integrazioni.filter((x) => x.scuola_id === SEDE_A && x.revocata_il === null)
  expect(attive.map((x) => x.id)).toEqual([id])
  // la vecchia resta in elenco, revocata: la storia non si cancella
  expect(h.db.crm_integrazioni.find((x) => x.id === INTEGRAZIONE_A)?.revocata_il).not.toBeNull()
})
```

  (Che la chiave vecchia smetta **subito** di funzionare lo prova il caso «R7 · revocata» del Compito 3;
  che il database non ammetta due chiavi attive per la stessa sede lo prova la prova SQL 11 del Compito 1.)

**Come si revoca e si ruota una chiave già consegnata** (va scritto anche in `docs/crm-accesso-ai.md`,
Compito 11): la chiave vive in due posti soli — l'impronta nel database e il testo nel programma sul Mac.

1. «CRM → Assistente → **Revoca**» (o `DELETE /api/admin/crm/integrazioni/<id>`). Da quell'istante ogni
   chiamata con quella chiave riceve `401 TOKEN_NON_VALIDO`: non c'è un periodo di tolleranza.
2. «**Crea la chiave**»: ne nasce una nuova per la stessa sede. Si copia subito (si vede una volta sola).
3. La si mette nel programma sul Mac al posto della vecchia e lo si riavvia.

Fra il passo 1 e il passo 3 l'assistente non raggiunge il CRM: risponde alle famiglie ma non fissa
visite. Per questo la rotazione si fa in un momento tranquillo e in un colpo solo. **Non esistono due
chiavi attive insieme** (indice `crm_integrazioni_una_attiva_per_sede`): è una *scelta di Claude*, la
più semplice da ragionare; se un giorno servisse cambiare chiave senza nessun buco, si toglie quel
vincolo con una migrazione. Se si sospetta che una chiave sia finita in mani sbagliate: passo 1
**subito**, il resto dopo. Le visite già fissate con la chiave vecchia restano e si possono annullare
con la nuova (l'annullamento guarda sede e `fissato_via`, non la chiave).

- [ ] **Passo 2: lancialo e guardalo fallire.**

Lancia: `npx vitest run __tests__/api/crm-integrazioni.test.ts` → `Test Files 1 failed` (le rotte non esistono).

- [ ] **Passo 3: scrivi le due rotte.** Regole:
  - Nomi di `withRoute`: `'admin/crm/integrazioni:GET'`, `'admin/crm/integrazioni:POST'`,
    `'admin/crm/integrazioni/[id]:DELETE'`.
  - In ogni handler: `requireCrm(request)` per primo, poi `if (auth.user.role !== 'admin')` → `403
    SOLO_ADMIN` con una riga `logEvento('multi_sede', 'warn', { operazione, esito: 'integrazioni-non-admin', utente: auth.user.id, ruolo: auth.user.role })`,
    **poi** `createAdminClient()`. **Mai** `requireStaff(` diretto (lock `crm-gate-requirecrm`).
  - `GET`: schema `z.object({ scuolaId: zUuid })`; sede con `resolveScuoleAttive` + `restringiSedi`
    (se `null` o vuoto → `rifiutoSede('SEDE_NON_ACCESSIBILE')`); lettura
    `.from('crm_integrazioni').select('id, nome, token_coda, creata_il, revocata_il, ultimo_uso_il').in('scuola_id', scuole).order('creata_il', { ascending: false })`.
  - `POST`: schema `z.object({ scuolaId: zUuid, nome: z.string().trim().min(1).max(80) }).strict()`;
    sede con `resolveScuolaScrittura(request, supabase, auth.user, b.data.scuolaId)`; poi
    `sedeAmmessaAi(scuolaId)`; poi `generaToken()` e `.insert({ scuola_id: scuolaId, nome, token_impronta, token_coda, creata_da: auth.user.id }).select('id').single()`.
    Il `23505` si intercetta **prima** di chiamare `rispostaErroreDbSchema` (che lo tradurrebbe in
    `GIA_COLLEGATO`, `src/lib/crm/errori.ts:88-93`): `if (error?.code === '23505') return rifiutoAi('INTEGRAZIONE_ESISTENTE', 409)`.
    Successo: `logEvento('crm', 'info', { operazione, esito: 'integrazione-creata', scuola_id, entita_id: id })`.
    Il token **non** si logga.
  - `DELETE`: `parseData(zUuid, rawId)` come in `src/app/api/admin/crm/appuntamenti/[id]/route.ts:90-93`;
    legge la riga (`select('id, scuola_id, revocata_il')`), `404` se non c'è, `assertSedeInScope`, e se
    `revocata_il` è nullo:
    `.update({ revocata_il: adesso, revocata_da: auth.user.id }).eq('id', id).eq('scuola_id', riga.scuola_id).is('revocata_il', null).select('id')`.
    Successo: `logEvento('crm', 'info', { operazione, esito: 'integrazione-revocata', scuola_id, entita_id: id })`.
    È una **revoca**, non una cancellazione: la riga resta.

- [ ] **Passo 4: lancia il test e i lock delle rotte admin.**

Lancia: `npx vitest run __tests__/api/crm-integrazioni.test.ts __tests__/architecture/crm-gate-requirecrm.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts`
Atteso: `Test Files 6 passed`.

- [ ] **Passo 5: commit.**

```bash
git add src/app/api/admin/crm/integrazioni __tests__/api/crm-integrazioni.test.ts
```

```bash
git commit -m "CRM, accesso AI: la Direzione crea, elenca e revoca le chiavi dell'assistente"
```

---

### Compito 5: gli orari liberi — `GET /api/crm/ai/slot`

**Aspetta:** 3. **Parallelo con:** 4, 7, 8, 9. **Blocca:** 6. Leggi prima «Impalcatura comune».

**File:**
- Crea: `src/lib/crm/ai/disponibilita.ts`, `src/app/api/crm/ai/slot/route.ts`
- Test: `__tests__/api/crm-ai-slot.test.ts`

**Interfacce:**
- Consuma: `calcolaSlotLiberi`, `SlotLibero` (`src/lib/crm/slot.ts:41, 127`); `caricaFasceEffettive`
  (`src/lib/crm/settimane.ts:217`, **lancia** sull'errore); `personeDellaSede`
  (`src/lib/crm/accesso.ts:164`, **lancia**); `tabellaAssente`, `rispostaErroreDb`
  (`src/lib/crm/errori.ts:79, 100`); `gradiPerNascita`, `Grado` (`@/lib/crm/ai/eta`); `zAnnoMese`,
  `zDataYMD`, `zUuid` (`src/lib/validation/common.ts:13, 34, 58`); `inizioGiornoCivile`, `addGiorni`,
  `dataCivile`; il gate del Compito 3.
- Produce (li usa il Compito 6):

```ts
// src/lib/crm/ai/disponibilita.ts
export const ANTICIPO_MINIMO_MIN = 120
export const GIORNI_MAX_AI = 31
export const SLOT_MAX_AI = 60

export interface AgendaAi {
  /** gli orari liberi, come li calcola `calcolaSlotLiberi` (con le persone) */
  liberi: SlotLibero[]
  /** gli stessi orari calcolati SENZA le visite: servono a distinguere «occupato» da «fuori disponibilità» */
  inFascia: SlotLibero[]
}

/**
 * Legge visite in programma, fasce, assenze e persone della sede per i giorni `dal`…`al` e calcola gli orari.
 * `adesso` è l'istante vero: l'anticipo minimo lo aggiunge la funzione. Un guasto diventa la risposta pronta
 * (503 se le tabelle delle settimane non ci sono, 500 altrimenti).
 */
export async function caricaAgendaAi(
  supabase: SupabaseClient, scuolaId: string, dal: string, al: string, adesso: Date, operazione: string,
): Promise<AgendaAi | { response: NextResponse }>

/** Gli orari da mostrare all'assistente: senza persone, senza doppioni (stesso inizio e stessa fine), in ordine. */
export function orariPerAssistente(liberi: SlotLibero[]): { inizio: string; fine: string }[]

/**
 * Chi può ricevere a quell'ora, in ordine di preferenza, e quanto dura la visita. `null` se l'orario non è libero.
 * Si guarda il PRIMO orario libero che comincia a `inizioIso` e si raccolgono le persone di tutti gli orari con
 * lo stesso inizio e la stessa fine: la persona di una fascia sua, poi le `personeLibere` di una fascia della sede.
 */
export function candidatiPer(liberi: SlotLibero[], inizioIso: string): { candidati: string[]; durataMin: number; fine: string } | null

/** La sede ha almeno una sezione di uno di quegli ordini di scuola? (`public.sections.school_type`) */
export async function sedeCopre(
  supabase: SupabaseClient, scuolaId: string, gradi: Grado[], operazione: string,
): Promise<{ coperta: boolean } | { response: NextResponse }>
```

**La rotta:**

`GET /api/crm/ai/slot?sede=<uuid>&dal=<AAAA-MM-GG>&al=<AAAA-MM-GG>&nascita=<AAAA-MM>` — tutti e quattro
obbligatori. `al ≥ dal`, e al più 31 giorni dopo `dal`. `nascita` è **anno e mese**, non il giorno: è
tutto quello che serve per sapere l'ordine di scuola, e il giorno di nascita non viaggia in un indirizzo.
Il parametro si chiama `nascita` apposta: la redazione dei log (`src/lib/logging/redact.ts:103`) copre i
nomi che contengono quella parola.

Risposta `200`:

```json
{
  "sede": "<uuid>",
  "gradi": ["infanzia"],
  "etaCoperta": true,
  "troncato": false,
  "slot": [
    { "inizio": "2026-11-17T08:00:00.000Z", "fine": "2026-11-17T08:45:00.000Z" },
    { "inizio": "2026-11-17T08:45:00.000Z", "fine": "2026-11-17T09:30:00.000Z" }
  ]
}
```

- `gradi`: quello che dice `gradiPerNascita(nascita, dataCivile())`.
- `etaCoperta`: `false` se `gradi` è vuoto o se la sede non ha sezioni di nessuno di quegli ordini.
  **Allora `slot` è `[]` e lo stato resta `200`**: non è un errore, è una risposta («per questa età in
  questa sede non c'è una classe»).
- `slot`: istanti ISO UTC, in ordine, al più 60; `troncato: true` se ce n'erano di più.
- Niente persone, niente nomi: chi riceve lo decide la prenotazione.
- L'età oggi **non cambia quali orari** escono (le fasce del CRM non distinguono per ordine di scuola):
  decide solo se la sede è adatta. È scritto in «Scelte di Claude».

Rifiuti: quelli del gate; `400` di validazione; `403 SEDE_NON_ACCESSIBILE`; `503 CRM_NON_INSTALLATO`.

- [ ] **Passo 1: scrivi il test** `__tests__/api/crm-ai-slot.test.ts` (impalcatura comune +
  `import { GET } from '@/app/api/crm/ai/slot/route'`):

```ts
const url = (o: Record<string, string> = {}) =>
  '/api/crm/ai/slot?' + new URLSearchParams({ sede: SEDE_A, dal: '2026-11-16', al: '2026-11-22', nascita: '2022-09', ...o }).toString()
const chiama = (o: Record<string, string> = {}, token?: string | null) => GET(richiestaAi(url(o), { token }))

describe('GET /api/crm/ai/slot', () => {
  // + i tre casi comuni (interruttore spento, senza chiave, chiave di un'altra sede)

  it('dà gli orari liberi della sede, senza persone', async () => {
    programma(null, [{}])
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      sede: SEDE_A,
      gradi: ['infanzia'],
      etaCoperta: true,
      troncato: false,
      slot: [
        { inizio: '2026-11-17T08:00:00.000Z', fine: '2026-11-17T08:45:00.000Z' },
        { inizio: '2026-11-17T08:45:00.000Z', fine: '2026-11-17T09:30:00.000Z' },
      ],
    })
  })
  it('una fascia della persona e una della sede alla stessa ora danno UN orario, non due', async () => {
    programma(null, [{}])
    programma(U1, [{}])
    expect((await (await chiama()).json()).slot).toHaveLength(2)
  })
  it('un orario resta libero finché almeno una persona è libera, e sparisce quando sono occupate tutte', async () => {
    programma(null, [{}])
    const visita = (id: string, chi: string) => ({ id, scuola_id: SEDE_A, scheda_id: 'x', inizio: '2026-11-17T08:00:00.000Z', fine: '2026-11-17T08:45:00.000Z', durata_min: 45, assegnata_a: chi, stato: 'in_programma' })
    h.db.crm_appuntamenti.push(visita('v1', U1))
    expect((await (await chiama()).json()).slot.map((s: { inizio: string }) => s.inizio)).toEqual(['2026-11-17T08:00:00.000Z', '2026-11-17T08:45:00.000Z'])
    h.db.crm_appuntamenti.push(visita('v2', U2))
    expect((await (await chiama()).json()).slot.map((s: { inizio: string }) => s.inizio)).toEqual(['2026-11-17T08:45:00.000Z'])
  })
  it('non propone niente nelle prossime due ore', async () => {
    // lunedì 16/11, sono le 08:00 di Roma: fascia 9:00–12:00 → 9:00 e 9:45 sono troppo vicine
    programma(null, [{ giorno_settimana: 1, ora_fine: '12:00:00' }])
    expect((await (await chiama()).json()).slot.map((s: { inizio: string }) => s.inizio)).toEqual(['2026-11-16T09:30:00.000Z', '2026-11-16T10:15:00.000Z'])
  })
  it('un’assenza di tutta la sede toglie gli orari', async () => {
    programma(null, [{}])
    h.db.crm_indisponibilita.push({ id: 'i1', scuola_id: SEDE_A, utente_id: null, dal: '2026-11-16T23:00:00.000Z', al: '2026-11-17T23:00:00.000Z', motivo: 'chiusura' })
    expect((await (await chiama()).json()).slot).toEqual([])
  })
  it('gli orari di un’altra sede non escono mai', async () => {
    programma(null, [{}], '2026-11-16', SEDE_B)
    expect((await (await chiama()).json()).slot).toEqual([])
  })
  it('età che la sede non copre: 200, etaCoperta false, nessun orario', async () => {
    programma(null, [{}])
    const j = await (await chiama({ nascita: '2016-05' })).json()
    expect(j).toMatchObject({ gradi: ['primaria'], etaCoperta: false, slot: [] })
  })
  it('basta che la sede copra UNO degli ordini possibili', async () => {
    programma(null, [{}])
    const j = await (await chiama({ nascita: '2024-06' })).json()
    expect(j.gradi).toEqual(['nido', 'infanzia'])
    expect(j.etaCoperta).toBe(true)
    expect(j.slot).toHaveLength(2)
  })
  it.each([
    ['manca la nascita', { nascita: '' }],
    ['nascita col giorno', { nascita: '2022-09-15' }],
    ['al prima di dal', { al: '2026-11-15' }],
    ['più di 31 giorni', { al: '2026-12-18' }],
    ['sede non uuid', { sede: 'giugliano' }],
  ])('validazione: %s → 400', async (_nome, o) => {
    expect((await chiama(o)).status).toBe(400)
  })
  it('senza le tabelle delle settimane risponde 503 CRM_NON_INSTALLATO', async () => {
    h.errori = { crm_settimane: { code: 'PGRST205', message: 'assente' } }
    const r = await chiama()
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CRM_NON_INSTALLATO')
  })
  it('R8 · nella risposta non c’è nessun nome', async () => {
    programma(null, [{}])
    h.db.crm_schede.push({ id: 'x', scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova' })
    nessunNomeIn(await (await chiama()).json(), ['Prova', 'Anna', 'Elena', U1, U2])
  })
})
```

- [ ] **Passo 2: lancialo e guardalo fallire.**

Lancia: `npx vitest run __tests__/api/crm-ai-slot.test.ts` → `Test Files 1 failed`.

- [ ] **Passo 3: scrivi `src/lib/crm/ai/disponibilita.ts`.** `caricaAgendaAi` fa le stesse quattro
  letture di `GET /api/admin/crm/appuntamenti` (`src/app/api/admin/crm/appuntamenti/route.ts:79-146`),
  per **una** sede:
  - visite: `.from('crm_appuntamenti').select('assegnata_a, inizio, fine, stato').eq('scuola_id', scuolaId).eq('stato', 'in_programma').lt('inizio', a).gt('fine', da)`
    con `da = inizioGiornoCivile(dal)` e `a = inizioGiornoCivile(addGiorni(al, 1))`;
  - fasce: `caricaFasceEffettive(supabase, scuolaId, dal, al)` dentro `try/catch` (lancia). **Qui la
    regola è diversa dall'agenda della segreteria:** se le tabelle non ci sono (`tabellaAssente(err)`)
    si risponde `503` con `rispostaErroreDb` (che lo logga), non si prosegue senza fasce;
  - assenze: `.from('crm_indisponibilita').select('*').eq('scuola_id', scuolaId).lt('dal', a).gt('al', da)`;
  - persone: `personeDellaSede(supabase, scuolaId)` dentro `try/catch`.
  - Poi due volte `calcolaSlotLiberi`, con
    `adesso: new Date(adesso.getTime() + ANTICIPO_MINIMO_MIN * 60_000)`,
    `fasce` filtrate come alle righe 137-139 di quella rotta (solo della sede o di persone ancora della
    sede) e `persone: persone.map((p) => p.id)`: una con le visite lette (`liberi`), una con
    `appuntamenti: []` (`inFascia`).
  - `sedeCopre`: se `gradi` è vuoto torna `{ coperta: false }` senza leggere; altrimenti
    `.from('sections').select('id').eq('scuola_id', scuolaId).in('school_type', gradi).limit(1)`.
  - `candidatiPer`: confronta gli istanti con `Date.parse`, non le stringhe (`…Z` e `…+00:00` sono lo
    stesso istante). L'ordine dei candidati: prima le persone degli orari «di persona» nell'ordine in
    cui arrivano, poi le `personeLibere`; senza doppioni.

- [ ] **Passo 4: scrivi la rotta** `src/app/api/crm/ai/slot/route.ts` con la forma dell'impalcatura
  (qui `parseQuery`, `withRoute('crm/ai/slot:GET', …)`, operazione `'slot'`). Schema:

```ts
const querySchema = z
  .object({ sede: zUuid, dal: zDataYMD, al: zDataYMD, nascita: zAnnoMese })
  .strict()
  .refine((q) => q.al >= q.dal, { message: 'La data finale precede quella iniziale', path: ['al'] })
  .refine((q) => q.al <= addGiorni(q.dal, GIORNI_MAX_AI), { message: `L’intervallo non può superare ${GIORNI_MAX_AI} giorni`, path: ['al'] })
```

  Ordine del lavoro: `gradiPerNascita` → `sedeCopre` → se non coperta rispondi subito con `slot: []`
  **senza** leggere l'agenda → `caricaAgendaAi` → `orariPerAssistente(liberi)` → taglia a `SLOT_MAX_AI`.

- [ ] **Passo 5: lancia il test e i lock.**

Lancia: `npx vitest run __tests__/api/crm-ai-slot.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/architecture/corpo-letto-dopo-il-gate.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/date-con-timezone.test.ts __tests__/architecture/date-senza-fuso.test.ts`
Atteso: `Test Files 7 passed`.
(`isolamento-sede-coverage` è rosso sui numeri fino al Compito 11: è atteso. Se è rosso per **altro** —
una lettura senza `scuola_id` — è un difetto tuo: correggilo.)

- [ ] **Passo 6: prova che il test guarda davvero.** In `caricaAgendaAi` togli `.eq('scuola_id', scuolaId)`
  dalla lettura delle visite o delle fasce → «gli orari di un'altra sede non escono mai» o il caso delle
  persone occupate deve diventare rosso. Rimetti a posto.

- [ ] **Passo 7: commit.**

```bash
git add src/lib/crm/ai/disponibilita.ts src/app/api/crm/ai/slot __tests__/api/crm-ai-slot.test.ts
```

```bash
git commit -m "CRM, accesso AI: gli orari liberi per sede ed età, senza persone e senza nomi"
```

---

### Compito 6: la prenotazione — `POST /api/crm/ai/prenota`

**Aspetta:** 5 (e 1, 3). **Parallelo con:** 10. Leggi prima «Impalcatura comune».

**File:**
- Crea: `src/app/api/crm/ai/prenota/route.ts`
- Test: `__tests__/api/crm-ai-prenota.test.ts`

**Interfacce:**
- Consuma: `caricaAgendaAi`, `candidatiPer`, `sedeCopre` (Compito 5); `chiaveIdempotenza`,
  `improntaCorpo` (Compito 2); `gradiPerNascita`, `meseDiNascita`; `normalizzaTelefono`,
  `normalizzaEmail` (`src/lib/crm/contatti.ts:18, 28`); `ORIGINI` (`src/lib/crm/tipi.ts:17`);
  `notificaVisitaAssegnata` (`src/lib/crm/agenda.ts:192`); `rispostaErroreDbSchema`; `validationError`
  (`src/lib/validation/http.ts:48`); la funzione `crm_ai_prenota` e il tipo `EsitoPrenotaAi` (Compito 1).
- Produce: la rotta.

**Richiesta.** Header obbligatorio `Idempotency-Key` (8–128 caratteri fra lettere, cifre, `_` e `-`).
Corpo (ogni altro campo è un errore: lo schema è `strict`):

```json
{
  "sede": "<uuid>",
  "inizio": "2026-11-17T08:00:00.000Z",
  "genitoreNome": "Famiglia Prova",
  "telefono": "{{telefono}}",
  "email": "prova@example.com",
  "origine": "whatsapp",
  "bambini": [{ "nome": "Bimbo Prova", "dataNascita": "2022-09-15" }],
  "routine": "…",
  "paura": "…",
  "desiderio": "…"
}
```

| Campo | Regola |
|---|---|
| `sede` | `zUuid`; deve essere la sede della chiave |
| `inizio` | `z.iso.datetime({ offset: true })`: un istante **preso dalla risposta di `/slot`** |
| `genitoreNome` | `z.string().trim().min(1).max(120)` |
| `telefono` | `z.string().trim().min(6).max(40)`; se `normalizzaTelefono` dà `null` → `422 CONTATTO_OBBLIGATORIO` |
| `email` | facoltativa, `zOpzionale(z.string().trim().max(200))` |
| `origine` | `z.enum(ORIGINI)` — il canale da cui è arrivata la famiglia |
| `bambini` | da 1 a 6; ognuno `{ nome: z.string().trim().min(1).max(100), dataNascita: zDataYMD }`, `strict` |
| `routine`, `paura`, `desiderio` | facoltative, `zOpzionale(z.string().trim().max(2000))` |

**Risposte:**

| Stato | Corpo | Quando |
|---|---|---|
| `201` | `{ "id": "<uuid visita>", "inizio": "<ISO>", "fine": "<ISO>", "schedaId": "<uuid>", "schedaCreata": true, "ripetuta": false }` | visita fissata |
| `200` | lo stesso corpo, con `"ripetuta": true` | la stessa richiesta (stessa chiave, stesso corpo) era già andata a buon fine — **anche se nel frattempo l'orario risulta occupato** (lo occupa lei) o la fascia è stata tolta |
| `409` | `{ "error", "codice": "GIA_PRENOTATO", "id": "<uuid visita>", "inizio": "<ISO>", "fine": "<ISO>" }` | la famiglia ha già una visita che deve ancora venire |
| `409` | `{ "error", "codice": "SLOT_OCCUPATO" }` | l'orario non è più libero (anche quando lo scopre il database) |
| `422` | `{ "error", "codice": "FUORI_DISPONIBILITA" }` | l'orario non è fra quelli che la sede offre, o è entro le prossime due ore |
| `422` | `{ "error", "codice": "ETA_NON_COPERTA" }` | nessun bambino della richiesta ha un'età che la sede copre |
| `422` | `{ "error", "codice": "CHIAVE_RIUSATA" }` | stessa `Idempotency-Key`, corpo diverso |
| `422` | `{ "error", "codice": "CONTATTO_OBBLIGATORIO" }` | il telefono non è un numero |
| `409` | `{ "error", "codice": "CRM_OPERAZIONE_NON_RIUSCITA" }` | esito `in_corso` (la stessa richiesta è ancora in lavorazione): si riprova fra poco |
| `400` | `{ "error": "Dati non validi", "details": […] }` | corpo non valido o header mancante |

In **nessuna** risposta ci sono il nome del bambino, il nome del genitore, il telefono, la data di
nascita o chi riceve. Gli istanti escono sempre come `new Date(x).toISOString()`.

- [ ] **Passo 1: scrivi il test** `__tests__/api/crm-ai-prenota.test.ts` (impalcatura comune +
  `import { POST } from '@/app/api/crm/ai/prenota/route'`):

```ts
const VISITA = '40000000-0000-4000-8000-000000000001'
const SCHEDA = '30000000-0000-4000-8000-000000000001'
const INIZIO = '2026-11-17T08:00:00.000Z'
const FINE = '2026-11-17T08:45:00.000Z'
const corpoBuono = (o: Record<string, unknown> = {}) => ({
  sede: SEDE_A, inizio: INIZIO, genitoreNome: 'Famiglia Prova', telefono: TEL, origine: 'whatsapp',
  bambini: [{ nome: NOME_BIMBO, dataNascita: NASCITA }], ...o,
})
const chiama = (o: Record<string, unknown> = {}, extra: { token?: string | null; chiave?: string | null } = {}) =>
  POST(richiestaAi('/api/crm/ai/prenota', { metodo: 'POST', corpo: corpoBuono(o), token: extra.token, chiave: extra.chiave === null ? undefined : (extra.chiave ?? 'conv-0001-slot-a') }))
const creata = (o: Record<string, unknown> = {}) => ({
  data: { esito: 'creata', appuntamento_id: VISITA, inizio: '2026-11-17T08:00:00+00:00', fine: '2026-11-17T08:45:00+00:00', scheda_id: SCHEDA, scheda_creata: true, assegnata_a: U1, ...o },
  error: null,
})

describe('POST /api/crm/ai/prenota', () => {
  beforeEach(() => programma(null, [{}]))
  // + i tre casi comuni (interruttore spento, senza chiave, chiave di un'altra sede)

  it('fissa la visita: passa alla funzione la sede DELLA CHIAVE, il numero normalizzato e le candidate libere', async () => {
    h.rpc.crm_ai_prenota = () => creata()
    const r = await chiama({ telefono: TEL_PREFISSO, email: ' Prova@Example.com ' })
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual({ id: VISITA, inizio: INIZIO, fine: FINE, schedaId: SCHEDA, schedaCreata: true, ripetuta: false })
    expect(h.chiamateRpc).toHaveLength(1)
    expect(h.chiamateRpc[0].args).toMatchObject({
      p_integrazione_id: INTEGRAZIONE_A,
      p_scuola_id: SEDE_A,
      p_chiave: 'conv-0001-slot-a',
      p_inizio: INIZIO,
      p_durata_min: 45,
      p_candidati: [U1, U2],
      p_telefono_norm: TEL_NORM,
      p_email_norm: 'prova@example.com',
      p_genitore_nome: 'Famiglia Prova',
      p_origine: 'whatsapp',
      p_bambini: [{ nome: NOME_BIMBO, data_nascita: NASCITA }],
    })
    expect(h.chiamateRpc[0].args.p_impronta).toMatch(/^[0-9a-f]{64}$/)
  })
  it('avvisa la segretaria a cui è andata la visita, con giorno e ora soltanto', async () => {
    h.rpc.crm_ai_prenota = () => creata({ assegnata_a: U2 })
    await chiama()
    expect(h.notifica).toHaveBeenCalledTimes(1)
    const [, n] = h.notifica.mock.calls[0]
    expect(n).toMatchObject({ tipo: 'crm_visita_assegnata', scuolaId: SEDE_A, utenteIds: [U2], entitaId: VISITA })
    nessunNomeIn(n, ['Prova', TEL, TEL_NORM])
  })
  it('R5 · la stessa richiesta ripetuta: 200, ripetuta true, nessuna seconda notifica', async () => {
    h.rpc.crm_ai_prenota = () => creata({ ripetuta: true })
    const r = await chiama()
    expect(r.status).toBe(200)
    expect((await r.json()).ripetuta).toBe(true)
    expect(h.notifica).not.toHaveBeenCalled()
  })
  it('R5 · due richieste con lo stesso corpo hanno la stessa impronta; cambiando un bambino cambia', async () => {
    h.rpc.crm_ai_prenota = () => creata()
    await chiama()
    await chiama()
    await chiama({ bambini: [{ nome: 'Bimba Prova', dataNascita: NASCITA }] })
    const [a, b, c] = h.chiamateRpc.map((x) => x.args.p_impronta)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
  it('A1 · R5 · ripetizione quando l’orario è ormai occupato (dalla prima richiesta): stesso esito e stesso id, non SLOT_OCCUPATO', async () => {
    // 1 · la prima richiesta riesce: se ne prende l'impronta, come l'ha calcolata la rotta
    h.rpc.crm_ai_prenota = () => creata()
    expect((await chiama()).status).toBe(201)
    const impronta = h.chiamateRpc[0].args.p_impronta as string
    // 2 · lo stato che la funzione vera lascia nel database: la riga del registro e l'orario pieno
    h.db.crm_ai_richieste.push({
      id: 'r-1', scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, chiave: 'conv-0001-slot-a', operazione: 'prenota', impronta,
      risposta: { esito: 'creata', appuntamento_id: VISITA, inizio: '2026-11-17T08:00:00+00:00', fine: '2026-11-17T08:45:00+00:00', scheda_id: SCHEDA, scheda_creata: true, assegnata_a: U1 },
      scheda_id: SCHEDA, appuntamento_id: VISITA,
    })
    for (const [id, chi] of [[VISITA, U1], ['v2', U2]]) {
      h.db.crm_appuntamenti.push({ id, scuola_id: SEDE_A, scheda_id: SCHEDA, inizio: INIZIO, fine: FINE, durata_min: 45, assegnata_a: chi, stato: 'in_programma' })
    }
    h.rpc.crm_ai_prenota = () => { throw new Error('una ripetizione non deve arrivare alla funzione') }
    h.notifica.mockClear()
    // 3 · il programma riprova, identico
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: VISITA, inizio: INIZIO, fine: FINE, schedaId: SCHEDA, schedaCreata: true, ripetuta: true })
    expect(h.chiamateRpc).toHaveLength(1) // solo la prima
    expect(h.notifica).not.toHaveBeenCalled()
  })
  it('A1 · la ripetizione vale anche se la segretaria nel frattempo ha tolto la fascia', async () => {
    h.rpc.crm_ai_prenota = () => creata()
    await chiama()
    const impronta = h.chiamateRpc[0].args.p_impronta as string
    h.db.crm_ai_richieste.push({ id: 'r-1', scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, chiave: 'conv-0001-slot-a', operazione: 'prenota', impronta,
      risposta: { esito: 'creata', appuntamento_id: VISITA, inizio: INIZIO, fine: FINE, scheda_id: SCHEDA, scheda_creata: true, assegnata_a: U1 } })
    h.db.crm_fasce = []
    const r = await chiama()
    expect(r.status).toBe(200)
    expect((await r.json()).id).toBe(VISITA)
  })
  it('A1 · un rifiuto salvato si ripete uguale: slot_occupato resta 409 SLOT_OCCUPATO', async () => {
    h.rpc.crm_ai_prenota = () => creata()
    await chiama()
    const impronta = h.chiamateRpc[0].args.p_impronta as string
    h.db.crm_ai_richieste.push({ id: 'r-1', scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, chiave: 'conv-0001-slot-a', operazione: 'prenota', impronta,
      risposta: { esito: 'slot_occupato', scheda_id: SCHEDA } })
    const r = await chiama()
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('SLOT_OCCUPATO')
    expect(h.chiamateRpc).toHaveLength(1)
  })
  it('A1 · stessa chiave con un corpo diverso la riconosce già la rotta: 422, senza funzione', async () => {
    h.db.crm_ai_richieste.push({ id: 'r-1', scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, chiave: 'conv-0001-slot-a', operazione: 'prenota', impronta: 'f'.repeat(64),
      risposta: { esito: 'creata', appuntamento_id: VISITA, inizio: INIZIO, fine: FINE, scheda_id: SCHEDA, scheda_creata: true, assegnata_a: U1 } })
    const r = await chiama()
    expect(r.status).toBe(422)
    expect((await r.json()).codice).toBe('CHIAVE_RIUSATA')
    expect(h.chiamateRpc).toEqual([])
  })
  it('A1 · la chiave di un’altra chiave-assistente non conta: il registro si legge per integrazione e per sede', async () => {
    h.db.crm_ai_richieste.push({ id: 'r-1', scuola_id: SEDE_B, integrazione_id: INTEGRAZIONE_B, chiave: 'conv-0001-slot-a', operazione: 'prenota', impronta: 'f'.repeat(64),
      risposta: { esito: 'creata', appuntamento_id: VISITA, inizio: INIZIO, fine: FINE, scheda_id: SCHEDA, scheda_creata: true, assegnata_a: U_B } })
    h.rpc.crm_ai_prenota = () => creata()
    expect((await chiama()).status).toBe(201)
  })
  it('R5 · stessa chiave, corpo diverso, scoperta dalla funzione (due richieste insieme): 422 CHIAVE_RIUSATA', async () => {
    h.rpc.crm_ai_prenota = () => ({ data: { esito: 'chiave_riusata' }, error: null })
    const r = await chiama()
    expect(r.status).toBe(422)
    expect((await r.json()).codice).toBe('CHIAVE_RIUSATA')
  })
  it('la famiglia ha già una visita: 409 GIA_PRENOTATO con il solo orario esistente', async () => {
    h.rpc.crm_ai_prenota = () => ({ data: { esito: 'gia_prenotato', appuntamento_id: VISITA, inizio: '2026-11-19T15:30:00+00:00', fine: '2026-11-19T16:15:00+00:00', scheda_id: SCHEDA }, error: null })
    const r = await chiama()
    expect(r.status).toBe(409)
    const j = await r.json()
    expect(j).toMatchObject({ codice: 'GIA_PRENOTATO', id: VISITA, inizio: '2026-11-19T15:30:00.000Z', fine: '2026-11-19T16:15:00.000Z' })
    expect(Object.keys(j).sort()).toEqual(['codice', 'error', 'fine', 'id', 'inizio'])
  })
  it('R3 · l’orario è già preso da tutte le persone: 409 SLOT_OCCUPATO senza nemmeno chiamare la funzione', async () => {
    for (const [id, chi] of [['v1', U1], ['v2', U2]]) {
      h.db.crm_appuntamenti.push({ id, scuola_id: SEDE_A, scheda_id: 'x', inizio: INIZIO, fine: FINE, durata_min: 45, assegnata_a: chi, stato: 'in_programma' })
    }
    const r = await chiama()
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('SLOT_OCCUPATO')
    expect(h.chiamateRpc).toEqual([])
  })
  it('R1 · l’orario era libero ma lo ha preso qualcuno un attimo prima: lo dice il database, 409 SLOT_OCCUPATO', async () => {
    h.rpc.crm_ai_prenota = () => ({ data: { esito: 'slot_occupato', scheda_id: SCHEDA }, error: null })
    const r = await chiama()
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('SLOT_OCCUPATO')
    expect(h.notifica).not.toHaveBeenCalled()
  })
  it('con una sola persona libera passa solo lei', async () => {
    h.db.crm_appuntamenti.push({ id: 'v1', scuola_id: SEDE_A, scheda_id: 'x', inizio: INIZIO, fine: FINE, durata_min: 45, assegnata_a: U1, stato: 'in_programma' })
    h.rpc.crm_ai_prenota = () => creata({ assegnata_a: U2 })
    await chiama()
    expect(h.chiamateRpc[0].args.p_candidati).toEqual([U2])
  })
  it.each([
    ['fuori dalla griglia', '2026-11-17T08:10:00.000Z'],
    ['fuori dalla fascia', '2026-11-17T14:00:00.000Z'],
    ['nel passato', '2026-11-10T08:00:00.000Z'],
  ])('R6 · orario %s: 422 FUORI_DISPONIBILITA, niente funzione', async (_nome, inizio) => {
    const r = await chiama({ inizio })
    expect(r.status).toBe(422)
    expect((await r.json()).codice).toBe('FUORI_DISPONIBILITA')
    expect(h.chiamateRpc).toEqual([])
  })
  it('lo stesso istante scritto con un altro fuso è lo stesso orario', async () => {
    h.rpc.crm_ai_prenota = () => creata()
    expect((await chiama({ inizio: '2026-11-17T09:00:00+01:00' })).status).toBe(201)
    expect(h.chiamateRpc[0].args.p_inizio).toBe(INIZIO)
  })
  it('età che la sede non copre: 422 ETA_NON_COPERTA', async () => {
    const r = await chiama({ bambini: [{ nome: NOME_BIMBO, dataNascita: '2016-05-10' }] })
    expect(r.status).toBe(422)
    expect((await r.json()).codice).toBe('ETA_NON_COPERTA')
    expect(h.chiamateRpc).toEqual([])
  })
  it('telefono che non è un numero: 422 CONTATTO_OBBLIGATORIO', async () => {
    const r = await chiama({ telefono: TEL_NON_NUMERO })
    expect(r.status).toBe(422)
    expect((await r.json()).codice).toBe('CONTATTO_OBBLIGATORIO')
  })
  it.each([
    ['senza Idempotency-Key', {}, { chiave: null }],
    ['chiave troppo corta', {}, { chiave: 'abc' }],
    ['senza bambini', { bambini: [] }, {}],
    ['bambino senza nome', { bambini: [{ dataNascita: NASCITA }] }, {}],
    ['campo in più', { assegnataA: U1 }, {}],
    ['inizio senza fuso', { inizio: '2026-11-17T09:00' }, {}],
    ['origine inventata', { origine: 'tiktok' }, {}],
  ])('validazione: %s → 400', async (_nome, o, extra) => {
    expect((await chiama(o, extra as { chiave?: string | null })).status).toBe(400)
    expect(h.chiamateRpc).toEqual([])
  })
  it('se la funzione non è installata risponde 503 CRM_NON_INSTALLATO', async () => {
    h.rpc.crm_ai_prenota = () => ({ data: null, error: { code: 'PGRST202', message: 'funzione assente' } })
    const r = await chiama()
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CRM_NON_INSTALLATO')
  })
  it('R8 · il nome del bambino, il genitore e il telefono non tornano in nessuna risposta', async () => {
    h.rpc.crm_ai_prenota = () => creata()
    nessunNomeIn(await (await chiama()).json(), [NOME_BIMBO, 'Prova', TEL, TEL_NORM, NASCITA])
    h.rpc.crm_ai_prenota = () => ({ data: { esito: 'gia_prenotato', appuntamento_id: VISITA, inizio: INIZIO, fine: FINE, scheda_id: SCHEDA }, error: null })
    nessunNomeIn(await (await chiama({}, { chiave: 'conv-0001-slot-b' })).json(), [NOME_BIMBO, 'Prova', TEL, TEL_NORM, NASCITA])
  })
})
```

- [ ] **Passo 2: lancialo e guardalo fallire.**

Lancia: `npx vitest run __tests__/api/crm-ai-prenota.test.ts` → `Test Files 1 failed`.

- [ ] **Passo 3: scrivi la rotta** `src/app/api/crm/ai/prenota/route.ts` —
  `withRoute('crm/ai/prenota:POST', …)`, operazione `'prenota'`, forma dell'impalcatura. Dopo il passo 3
  dell'impalcatura (sede della chiave), nell'ordine:
  1. `chiaveIdempotenza(request)`; se `null` →
     `validationError([{ path: ['Idempotency-Key'], message: 'Header Idempotency-Key mancante o non valido' }])`.
  2. `normalizzaTelefono(b.telefono)`; `null` → `rifiutoAi('CONTATTO_OBBLIGATORIO', 422)`.
     `normalizzaEmail(b.email)` (può essere `null`).
  3. `inizioIso = new Date(b.inizio).toISOString()`.
  4. L'impronta: `improntaCorpo({ ...b, sede: ai.scuolaId, inizio: inizioIso, telefono: telefonoNorm, email: emailNorm })`
     (così lo stesso numero scritto in due modi è la stessa richiesta).
  5. **LA CHIAVE SI GUARDA PER PRIMA, prima dell'età e dell'agenda.** È il punto che un revisore ha
     trovato sbagliato nella prima stesura: se l'assistente ripete una richiesta già riuscita (la
     risposta si era persa per strada), l'orario adesso è occupato **dalla sua stessa visita**, e un
     controllo dell'agenda fatto prima risponderebbe `409 SLOT_OCCUPATO` invece dell'esito vero.
     Quindi:
     `supabase.from('crm_ai_richieste').select('impronta, risposta').eq('scuola_id', ai.scuolaId).eq('integrazione_id', ai.integrazioneId).eq('chiave', chiave).maybeSingle()`
     (`error` → `rispostaErroreDbSchema(error, op)`).
     - la riga c'è e `impronta` è diversa → `rifiutoAi('CHIAVE_RIUSATA', 422)`, fine;
     - la riga c'è, `impronta` è uguale e `risposta` non è nulla → si restituisce **quella** risposta,
       tradotta come al punto 10, con `ripetuta: true`: stesso esito e stesso `id` della prima volta
       (`200` per una `creata`; lo **stesso** `409` per un `gia_prenotato` o uno `slot_occupato`
       salvati). Niente età, niente agenda, niente funzione, niente notifica;
     - la riga non c'è, oppure c'è con `risposta` nulla (la prima richiesta è ancora in volo) → si va
       avanti: decide la funzione, che la chiave la ricontrolla **sotto blocco** (è lei a garantire che
       due richieste gemelle arrivate insieme non valgano due volte; questa lettura serve alle
       ripetizioni arrivate **dopo**).
  6. Età: l'unione dei `gradiPerNascita(meseDiNascita(dataNascita), dataCivile())` di tutti i bambini →
     `sedeCopre(supabase, ai.scuolaId, gradi, op)`; non coperta → `rifiutoAi('ETA_NON_COPERTA', 422)`.
  7. Agenda del **solo giorno** della visita: `giorno = dataCivile(new Date(inizioIso))`,
     `caricaAgendaAi(supabase, ai.scuolaId, giorno, giorno, new Date(), op)`.
  8. `candidatiPer(agenda.liberi, inizioIso)`. Se `null`: `candidatiPer(agenda.inFascia, inizioIso)` c'è →
     `rifiutoAi('SLOT_OCCUPATO', 409)`; non c'è → `rifiutoAi('FUORI_DISPONIBILITA', 422)`.
     (Questi tre rifiuti — età, occupato, fuori disponibilità — **non** si salvano nel registro: non
     hanno scritto niente, e riprovarli con la stessa chiave rifà semplicemente il controllo.)
  9. `supabase.rpc('crm_ai_prenota', { p_integrazione_id: ai.integrazioneId, p_scuola_id: ai.scuolaId, p_chiave, p_impronta, p_inizio: inizioIso, p_durata_min: c.durataMin, p_candidati: c.candidati, p_telefono: b.telefono, p_telefono_norm, p_email: b.email ?? null, p_email_norm, p_genitore_nome: b.genitoreNome, p_origine: b.origine, p_bambini: b.bambini.map((x) => ({ nome: x.nome, data_nascita: x.dataNascita })), p_routine: b.routine ?? null, p_paura: b.paura ?? null, p_desiderio: b.desiderio ?? null })`.
     `error` → `rispostaErroreDbSchema(error, op)` (funzione assente → 503).
  10. Traduci `data.esito` secondo la tabella delle risposte, con **una** funzione locale
     `rispostaDaEsito(esito: EsitoPrenotaAi, ripetuta: boolean)` usata sia qui sia al punto 5. Un `esito` sconosciuto è un guasto:
     `logErrore({ operazione: op, stato: 500 }, new Error('esito inatteso da crm_ai_prenota'))` e
     `500 CRM_OPERAZIONE_NON_RIUSCITA`.
  11. Solo per `creata` **non** ripetuta: `await notificaVisitaAssegnata(supabase, { scuolaId: ai.scuolaId, appuntamentoId, inizio, destinatario: data.assegnata_a })`
      (non lancia: è a tentativo) e
      `logEvento('crm', 'info', { operazione: op, esito: 'ai-visita-fissata', scuola_id: ai.scuolaId, entita_id: appuntamentoId })`.
  12. Chiudi con `chiudiChiamataAi(ai, risposta, { codice, entitaId: appuntamentoId ?? null })`.

  La rotta **non** scrive direttamente su nessuna tabella (del registro `crm_ai_richieste` fa solo una
  lettura): scrive solo la funzione. Così non può
  lasciare una prenotazione a metà.

- [ ] **Passo 4: lancia il test e i lock.**

Lancia: `npx vitest run __tests__/api/crm-ai-prenota.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/architecture/corpo-letto-dopo-il-gate.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/errori-postgrest-guardati.test.ts`
Atteso: `Test Files 6 passed`.

- [ ] **Passo 5: prova che il test guarda davvero.** Sposta per un momento la lettura del registro
  (punto 5) **dopo** `candidatiPer` (punto 8) → il primo caso «A1» deve diventare rosso con
  `expected 409 to be 200`. Rimetti a posto. Poi: passa per un momento `b.data.sede` al posto di
  `ai.scuolaId` in `p_scuola_id` e lancia: il caso comune R2 resta verde (lo ferma `assertSedeDelToken`),
  quindi togli **anche** quella guardia → R2 deve diventare rosso. Rimetti a posto tutte e due.

- [ ] **Passo 6: commit.**

```bash
git add src/app/api/crm/ai/prenota __tests__/api/crm-ai-prenota.test.ts
```

```bash
git commit -m "CRM, accesso AI: la prenotazione (solo orari liberi, una volta sola, senza doppioni di famiglia)"
```

---

### Compito 7: annullare — `DELETE /api/crm/ai/prenotazioni/[id]`

**Aspetta:** 3. **Parallelo con:** 4, 5, 8, 9. Leggi prima «Impalcatura comune».

**File:**
- Crea: `src/app/api/crm/ai/prenotazioni/[id]/route.ts`
- Test: `__tests__/api/crm-ai-annulla.test.ts`

**Interfacce:**
- Consuma: il gate; `registraEvento` (`src/lib/crm/eventi.ts:24`); `rispostaErroreDb`; `rifiutoAi`;
  `parseData`, `parseQuery`; `zUuid`.
- Produce: la rotta.

`DELETE /api/crm/ai/prenotazioni/<uuid>?sede=<uuid>` — annulla una visita **fissata dall'assistente**
(`fissato_via = 'ai'`) **nella sede della chiave**, ancora `in_programma`.

| Stato | Corpo | Quando |
|---|---|---|
| `200` | `{ "id": "<uuid>", "annullata": true, "giaAnnullata": false }` | annullata ora |
| `200` | `{ "id": "<uuid>", "annullata": true, "giaAnnullata": true }` | era già annullata: ripetere non è un errore |
| `404` | `{ "error", "codice": "ELEMENTO_NON_TROVATO" }` | non esiste, è di un'altra sede, **oppure l'ha fissata la segreteria**: la stessa risposta nei tre casi |
| `409` | `{ "error", "codice": "STATO_NON_AMMESSO" }` | è già svolta o «non presentato» |

- [ ] **Passo 1: scrivi il test** `__tests__/api/crm-ai-annulla.test.ts`:

```ts
import { DELETE } from '@/app/api/crm/ai/prenotazioni/[id]/route'

const VISITA = '40000000-0000-4000-8000-000000000001'
const SCHEDA = '30000000-0000-4000-8000-000000000001'
const ctx = (id = VISITA) => ({ params: Promise.resolve({ id }) })
const chiama = (o: { id?: string; sede?: string; token?: string | null } = {}) =>
  DELETE(richiestaAi(`/api/crm/ai/prenotazioni/${o.id ?? VISITA}?sede=${o.sede ?? SEDE_A}`, { metodo: 'DELETE', token: o.token }), ctx(o.id))
const visita = (o: Riga = {}): Riga => ({
  id: VISITA, scuola_id: SEDE_A, scheda_id: SCHEDA, inizio: '2026-11-17T08:00:00.000Z', fine: '2026-11-17T08:45:00.000Z', durata_min: 45,
  assegnata_a: U1, fissato_da: null, fissato_via: 'ai', stato: 'in_programma', aggiornato_il: '2026-11-10T09:00:00.000Z', ...o,
})
const stato = () => h.db.crm_appuntamenti.find((x) => x.id === VISITA)?.stato

describe('DELETE /api/crm/ai/prenotazioni/[id]', () => {
  beforeEach(() => {
    h.db.crm_schede.push({ id: SCHEDA, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova' })
    h.db.crm_appuntamenti.push(visita())
  })
  // + i tre casi comuni (nel caso R2: token TOKEN_B con ?sede=SEDE_A → 403, e la visita resta in_programma)

  it('annulla la visita fissata dall’assistente e lo scrive nello storico come «ai»', async () => {
    const r = await chiama()
    expect(await r.json()).toEqual({ id: VISITA, annullata: true, giaAnnullata: false })
    expect(stato()).toBe('annullato')
    const eventi = scritte('crm_eventi', 'insert').flatMap((s) => s.valori)
    expect(eventi).toHaveLength(1)
    expect(eventi[0]).toMatchObject({ tipo: 'appuntamento_annullato', autore: null, autore_via: 'ai', scheda_id: SCHEDA, scuola_id: SEDE_A, dati: { appuntamento_id: VISITA } })
  })
  it('ripetuta: 200 con giaAnnullata true, senza un secondo evento', async () => {
    await chiama()
    const r = await chiama()
    expect(await r.json()).toEqual({ id: VISITA, annullata: true, giaAnnullata: true })
    expect(scritte('crm_eventi', 'insert')).toHaveLength(1)
  })
  it('una visita fissata dalla SEGRETERIA non si tocca: 404', async () => {
    h.db.crm_appuntamenti = [visita({ fissato_via: 'segreteria', fissato_da: U1 })]
    const r = await chiama()
    expect(r.status).toBe(404)
    expect((await r.json()).codice).toBe('ELEMENTO_NON_TROVATO')
    expect(stato()).toBe('in_programma')
  })
  it('una visita di un’altra sede non esiste, per questa chiave: 404', async () => {
    h.db.crm_appuntamenti = [visita({ scuola_id: SEDE_B })]
    expect((await chiama()).status).toBe(404)
    expect(stato()).toBe('in_programma')
  })
  it.each(['svolto', 'non_presentato'])('una visita «%s» non si annulla: 409 STATO_NON_AMMESSO', async (s) => {
    h.db.crm_appuntamenti = [visita({ stato: s })]
    const r = await chiama()
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('STATO_NON_AMMESSO')
    expect(stato()).toBe(s)
  })
  it('id che non è un uuid → 400; visita inesistente → 404', async () => {
    expect((await chiama({ id: 'abc' })).status).toBe(400)
    expect((await chiama({ id: '40000000-0000-4000-8000-000000000404' })).status).toBe(404)
  })
})
```

- [ ] **Passo 2: lancialo e guardalo fallire.** `npx vitest run __tests__/api/crm-ai-annulla.test.ts` → `Test Files 1 failed`.

- [ ] **Passo 3: scrivi la rotta** — `withRoute('crm/ai/prenotazioni/[id]:DELETE', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => …)`,
  operazione `'annulla'`. Dopo il gate: `parseData(zUuid, (await context.params).id)`,
  `parseQuery(request, z.object({ sede: zUuid }).strict())`, `assertSedeDelToken`. Poi:
  1. Leggi: `.from('crm_appuntamenti').select('id, scheda_id, stato').eq('id', id).eq('scuola_id', ai.scuolaId).eq('fissato_via', 'ai').maybeSingle()`.
     Niente → `404`. `annullato` → `200` con `giaAnnullata: true`. `svolto`/`non_presentato` → `409`.
  2. Scrivi **solo se è ancora in programma** (stessa regola di `aggiornaSeInProgramma`,
     `src/app/api/admin/crm/appuntamenti/[id]/route.ts:69-82`):
     `.update({ stato: 'annullato', aggiornato_il: adesso }).eq('id', id).eq('scuola_id', ai.scuolaId).eq('fissato_via', 'ai').eq('stato', 'in_programma').select('id')`.
     Nessuna riga colpita → `409 STATO_NON_AMMESSO` (una collega l'ha chiusa nel frattempo), e niente evento.
  3. `registraEvento(supabase, { schedaId, scuolaId: ai.scuolaId, tipo: 'appuntamento_annullato', autore: null, autoreVia: 'ai', dati: { appuntamento_id: id } })`.
  4. `logEvento('crm', 'info', { operazione: op, esito: 'ai-visita-annullata', scuola_id: ai.scuolaId, entita_id: id })`.

- [ ] **Passo 4: lancia il test e i lock** (gli stessi sei del Compito 6, con il file di questo compito).
  Atteso: `Test Files 6 passed`.

- [ ] **Passo 5: commit.**

```bash
git add "src/app/api/crm/ai/prenotazioni" __tests__/api/crm-ai-annulla.test.ts
```

```bash
git commit -m "CRM, accesso AI: annullare una visita fissata dall'assistente"
```

---

### Compito 8: i contatti — registrare (E1), sapere lo stato (E2), elencare i nuovi (E3)

**Aspetta:** 3 (e 1). **Parallelo con:** 4, 5, 7, 9. Leggi prima «Impalcatura comune».

**File:**
- Crea: `src/lib/crm/ai/contatti.ts`
- Crea: `src/app/api/crm/ai/contatti/route.ts`, `src/app/api/crm/ai/contatti/stato/route.ts`, `src/app/api/crm/ai/contatti/nuovi/route.ts`
- Test: `__tests__/api/crm-ai-contatti.test.ts`

**Interfacce:**
- Consuma: il gate; `normalizzaTelefono`, `normalizzaEmail`; `meseDiNascita` (`@/lib/crm/ai/eta`);
  `ORIGINI`; `rispostaErroreDb`, `rispostaErroreDbSchema`; la funzione `crm_ai_registra_contatto`.
- Produce:

```ts
// src/lib/crm/ai/contatti.ts
export interface VisitaAi { id: string; inizio: string; stato: 'in_programma' | 'svolto' | 'non_presentato' }

/**
 * «La visita» di una scheda, per l'assistente: la prossima `in_programma` che deve ancora finire; se non c'è,
 * l'ultima fra quelle svolte, non presentate o in programma ma già passate. Le annullate non contano. `null` se nessuna.
 */
export function visitaDi(appuntamenti: Pick<AppuntamentoRow, 'id' | 'inizio' | 'fine' | 'stato'>[], adesso: Date): VisitaAi | null

/** La scheda più vecchia e non anonimizzata della sede con quel numero normalizzato. */
export async function schedaPerTelefono(
  supabase: SupabaseClient, scuolaId: string, telefonoNorm: string, operazione: string,
): Promise<{ scheda: { id: string; creato_via: Via } | null } | { response: NextResponse }>

/** Visite e bambini (solo id e mese di nascita) di un gruppo di schede della sede. */
export async function dettagliSchede(
  supabase: SupabaseClient, scuolaId: string, schedaIds: string[], adesso: Date, operazione: string,
): Promise<{ perScheda: Map<string, { visita: VisitaAi | null; bambini: { id: string; nascita: string | null }[] }> } | { response: NextResponse }>
```

**Le tre rotte:**

**E1 · `POST /api/crm/ai/contatti`** — operazione `'contatto'`. Registra una famiglia, senza visita.

```json
{ "sede": "<uuid>", "telefono": "{{telefono}}", "genitoreNome": "Famiglia Prova", "email": "prova@example.com",
  "origine": "sito", "bambini": [{ "nome": "Bimbo Prova", "dataNascita": "2022-09-15" }] }
```

`sede`, `telefono` e `origine` obbligatori; `genitoreNome` e `email` facoltativi; `bambini` facoltativo
(da 0 a 6), e di ogni bambino `nome` e `dataNascita` sono **tutti e due facoltativi** (il modulo del
sito oggi non chiede né l'uno né l'altra). Schema `strict`.

| Stato | Corpo |
|---|---|
| `201` | `{ "schedaId": "<uuid>", "creata": true, "visita": null }` |
| `200` | `{ "schedaId": "<uuid>", "creata": false, "visita": { "id", "inizio", "stato" } }` oppure `"visita": null` — la famiglia c'era già |
| `422` | `CONTATTO_OBBLIGATORIO` — il telefono non è un numero |

**E2 · `POST /api/crm/ai/contatti/stato`** — operazione `'contatto_stato'`. È una **lettura**, ma è
`POST` perché il telefono non deve stare in un indirizzo (gli indirizzi finiscono nei registri dei
server). Corpo `{ "sede": "<uuid>", "telefono": "{{telefono}}" }`, `strict`.

| Stato | Corpo |
|---|---|
| `200` | `{ "esiste": false, "schedaId": null, "creatoVia": null, "visita": null, "bambini": [] }` |
| `200` | `{ "esiste": true, "schedaId": "<uuid>", "creatoVia": "segreteria", "visita": { "id": "<uuid>", "inizio": "<ISO>", "stato": "in_programma" }, "bambini": [{ "id": "<uuid>", "nascita": "2022-09" }] }` |

**E3 · `GET /api/crm/ai/contatti/nuovi?sede=<uuid>&dopo=<ISO con fuso>`** — operazione
`'contatti_nuovi'`. Le schede **create dalla segreteria** (`creato_via = 'segreteria'`) dopo
quell'istante, non anonimizzate, dalla più vecchia, al più 100.

```json
{
  "contatti": [
    { "schedaId": "<uuid>", "creataIl": "<ISO>", "telefono": "{{telefono}}", "origine": "telefonata",
      "visita": null, "bambini": [{ "id": "<uuid>", "nascita": "2022-09" }] }
  ],
  "prossimoDopo": "<ISO dell'ultima riga, da passare come «dopo» alla chiamata successiva; null se l'elenco è vuoto>"
}
```

`telefono` è il primo numero **normalizzato** (`telefoni_norm[0]`, dieci cifre) oppure `null` se la
scheda ha solo un'email. È l'unico dato di contatto che esce da queste rotte, ed esce perché il
programma deve sapere a chi scrivere. **Mai** `genitore_nome`, mai un nome di bambino, mai le note.

- [ ] **Passo 1: scrivi il test** `__tests__/api/crm-ai-contatti.test.ts`:

```ts
import { POST as REGISTRA } from '@/app/api/crm/ai/contatti/route'
import { POST as STATO } from '@/app/api/crm/ai/contatti/stato/route'
import { GET as NUOVI } from '@/app/api/crm/ai/contatti/nuovi/route'
import { visitaDi } from '@/lib/crm/ai/contatti'

const S1 = '30000000-0000-4000-8000-000000000001'
const S2 = '30000000-0000-4000-8000-000000000002'
const S_AI = '30000000-0000-4000-8000-000000000003'
const S_B = '30000000-0000-4000-8000-00000000000b'
const B1 = '60000000-0000-4000-8000-000000000001'
const V1 = '40000000-0000-4000-8000-000000000001'
const scheda = (o: Riga = {}): Riga => ({
  id: S1, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova', telefono1: TEL, telefoni_norm: [TEL_NORM], email_norm: [],
  origine: 'telefonata', creato_via: 'segreteria', creata_il: '2026-11-15T10:00:00.000Z', anonimizzata_il: null, ...o,
})
const registra = (o: Record<string, unknown> = {}, token?: string | null) =>
  REGISTRA(richiestaAi('/api/crm/ai/contatti', { metodo: 'POST', token, corpo: { sede: SEDE_A, telefono: TEL, origine: 'sito', ...o } }))
const stato = (o: Record<string, unknown> = {}, token?: string | null) =>
  STATO(richiestaAi('/api/crm/ai/contatti/stato', { metodo: 'POST', token, corpo: { sede: SEDE_A, telefono: TEL, ...o } }))
const nuovi = (dopo = '2026-11-15T00:00:00.000Z', sede = SEDE_A, token?: string | null) =>
  NUOVI(richiestaAi(`/api/crm/ai/contatti/nuovi?sede=${sede}&dopo=${encodeURIComponent(dopo)}`, { token }))

describe('visitaDi', () => {
  const ADESSO = new Date('2026-11-16T07:00:00.000Z')
  const v = (id: string, inizio: string, stato: string) => ({ id, inizio, fine: new Date(Date.parse(inizio) + 45 * 60_000).toISOString(), stato }) as never
  it('preferisce la prossima in programma', () => {
    expect(visitaDi([v('a', '2026-11-10T08:00:00.000Z', 'svolto'), v('b', '2026-11-20T08:00:00.000Z', 'in_programma'), v('c', '2026-11-18T08:00:00.000Z', 'in_programma')], ADESSO))
      .toEqual({ id: 'c', inizio: '2026-11-18T08:00:00.000Z', stato: 'in_programma' })
  })
  it('senza visite future dà l’ultima fatta; le annullate non contano', () => {
    expect(visitaDi([v('a', '2026-11-10T08:00:00.000Z', 'svolto'), v('b', '2026-11-12T08:00:00.000Z', 'annullato')], ADESSO))
      .toEqual({ id: 'a', inizio: '2026-11-10T08:00:00.000Z', stato: 'svolto' })
    expect(visitaDi([v('b', '2026-11-12T08:00:00.000Z', 'annullato')], ADESSO)).toBeNull()
  })
})

describe('POST /api/crm/ai/contatti (E1)', () => {
  // + i tre casi comuni
  it('famiglia nuova: 201, e alla funzione arrivano la sede della chiave e il numero normalizzato', async () => {
    h.rpc.crm_ai_registra_contatto = () => ({ data: { scheda_id: S1, creata: true }, error: null })
    const r = await registra({ telefono: TEL_0039, bambini: [{ dataNascita: NASCITA }] })
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual({ schedaId: S1, creata: true, visita: null })
    expect(h.chiamateRpc[0].args).toMatchObject({
      p_scuola_id: SEDE_A, p_telefono_norm: TEL_NORM, p_email: null, p_email_norm: null, p_genitore_nome: null, p_origine: 'sito',
      p_bambini: [{ nome: null, data_nascita: NASCITA }],
    })
  })
  it('R4 · famiglia già nota: 200, creata false, con la sua visita', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push({ id: V1, scuola_id: SEDE_A, scheda_id: S1, inizio: '2026-11-18T08:00:00.000Z', fine: '2026-11-18T08:45:00.000Z', stato: 'in_programma' })
    h.rpc.crm_ai_registra_contatto = () => ({ data: { scheda_id: S1, creata: false }, error: null })
    const r = await registra()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ schedaId: S1, creata: false, visita: { id: V1, inizio: '2026-11-18T08:00:00.000Z', stato: 'in_programma' } })
  })
  it('telefono che non è un numero: 422 CONTATTO_OBBLIGATORIO, niente funzione', async () => {
    const r = await registra({ telefono: TEL_NON_NUMERO })
    expect(r.status).toBe(422)
    expect(h.chiamateRpc).toEqual([])
  })
  it('validazione: senza origine, o con un campo in più → 400', async () => {
    expect((await registra({ origine: undefined })).status).toBe(400)
    expect((await registra({ nota: 'testo libero' })).status).toBe(400)
  })
})

describe('POST /api/crm/ai/contatti/stato (E2)', () => {
  // + i tre casi comuni
  it('numero sconosciuto: esiste false', async () => {
    expect(await (await stato()).json()).toEqual({ esiste: false, schedaId: null, creatoVia: null, visita: null, bambini: [] })
  })
  it('R4 · riconosce il numero scritto in un altro modo, e dà solo id, visita e mesi di nascita', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_bambini.push({ id: B1, scuola_id: SEDE_A, scheda_id: S1, nome: NOME_BIMBO, data_nascita: NASCITA, creata_il: '2026-11-15T10:00:00.000Z' })
    h.db.crm_appuntamenti.push({ id: V1, scuola_id: SEDE_A, scheda_id: S1, inizio: '2026-11-18T08:00:00.000Z', fine: '2026-11-18T08:45:00.000Z', stato: 'in_programma' })
    const j = await (await stato({ telefono: TEL_PREFISSO })).json()
    expect(j).toEqual({
      esiste: true, schedaId: S1, creatoVia: 'segreteria',
      visita: { id: V1, inizio: '2026-11-18T08:00:00.000Z', stato: 'in_programma' },
      bambini: [{ id: B1, nascita: '2022-09' }],
    })
    nessunNomeIn(j, [NOME_BIMBO, 'Prova', NASCITA, TEL, TEL_NORM])
  })
  it('lo stesso numero in un’altra sede non esiste, per questa chiave', async () => {
    h.db.crm_schede.push(scheda({ id: S_B, scuola_id: SEDE_B }))
    expect((await (await stato()).json()).esiste).toBe(false)
  })
  it('una scheda anonimizzata non esiste', async () => {
    h.db.crm_schede.push(scheda({ anonimizzata_il: '2026-11-01T00:00:00.000Z' }))
    expect((await (await stato()).json()).esiste).toBe(false)
  })
  it('non scrive niente', async () => {
    h.db.crm_schede.push(scheda())
    await stato()
    expect(h.scritture.filter((s) => (s as Scrittura).tabella !== 'crm_integrazioni')).toEqual([])
  })
})

describe('GET /api/crm/ai/contatti/nuovi (E3)', () => {
  // + i tre casi comuni (R2: nuovi(undefined, SEDE_A, TOKEN_B) → 403)
  beforeEach(() => {
    h.db.crm_schede.push(
      scheda(), // S1, della segreteria, 15/11 10:00
      scheda({ id: S2, telefono1: null, telefoni_norm: [], email_norm: ['prova@example.com'], creata_il: '2026-11-15T11:00:00.000Z' }),
      scheda({ id: S_AI, creato_via: 'ai', telefoni_norm: ['3330000003'], creata_il: '2026-11-15T12:00:00.000Z' }),
      scheda({ id: S_B, scuola_id: SEDE_B, creata_il: '2026-11-15T12:30:00.000Z' }),
    )
    h.db.crm_bambini.push({ id: B1, scuola_id: SEDE_A, scheda_id: S1, nome: NOME_BIMBO, data_nascita: NASCITA, creata_il: '2026-11-15T10:00:00.000Z' })
  })
  it('dà solo le schede messe a mano dalla segreteria, della sede della chiave, dalla più vecchia', async () => {
    const j = await (await nuovi()).json()
    expect(j).toEqual({
      contatti: [
        { schedaId: S1, creataIl: '2026-11-15T10:00:00.000Z', telefono: TEL_NORM, origine: 'telefonata', visita: null, bambini: [{ id: B1, nascita: '2022-09' }] },
        { schedaId: S2, creataIl: '2026-11-15T11:00:00.000Z', telefono: null, origine: 'telefonata', visita: null, bambini: [] },
      ],
      prossimoDopo: '2026-11-15T11:00:00.000Z',
    })
    nessunNomeIn(j, [NOME_BIMBO, 'Prova', NASCITA])
  })
  it('«dopo» è escluso: richiamando con prossimoDopo non torna la stessa scheda', async () => {
    expect((await (await nuovi('2026-11-15T11:00:00.000Z')).json())).toEqual({ contatti: [], prossimoDopo: null })
    expect((await (await nuovi('2026-11-15T10:00:00.000Z')).json()).contatti.map((c: { schedaId: string }) => c.schedaId)).toEqual([S2])
  })
  it('validazione: «dopo» senza fuso → 400', async () => {
    expect((await nuovi('2026-11-15T10:00')).status).toBe(400)
  })
})
```

- [ ] **Passo 2: lancialo e guardalo fallire.** `npx vitest run __tests__/api/crm-ai-contatti.test.ts` → `Test Files 1 failed`.

- [ ] **Passo 3: scrivi `src/lib/crm/ai/contatti.ts`.** Letture, tutte con `.eq('scuola_id', scuolaId)`:
  - `schedaPerTelefono`: `.from('crm_schede').select('id, creato_via, creata_il').eq('scuola_id', scuolaId).is('anonimizzata_il', null).overlaps('telefoni_norm', [telefonoNorm]).order('creata_il', { ascending: true }).limit(1)`
    (lo stesso `overlaps` di `src/app/api/admin/crm/schede/route.ts:306-312`).
  - `dettagliSchede`: se `schedaIds` è vuoto torna una mappa vuota senza leggere. Altrimenti due letture:
    `crm_appuntamenti` (`select('id, scheda_id, inizio, fine, stato')`, `.in('scheda_id', schedaIds)`,
    `.neq('stato', 'annullato')`) e `crm_bambini` (`select('id, scheda_id, data_nascita, creata_il')`,
    `.in('scheda_id', schedaIds)`, ordinati per `creata_il` e poi `id`). **Dalla tabella dei bambini non
    si seleziona la colonna `nome`**: quello che non si legge non può uscire.
  - `visitaDi`: «deve ancora finire» = `Date.parse(fine) > adesso.getTime()`.

- [ ] **Passo 4: scrivi le tre rotte** con la forma dell'impalcatura. Nomi:
  `'crm/ai/contatti:POST'`, `'crm/ai/contatti/stato:POST'`, `'crm/ai/contatti/nuovi:GET'`. Schemi:

```ts
// contatti
const bambinoSchema = z.object({ nome: zOpzionale(z.string().trim().min(1).max(100)), dataNascita: zOpzionale(zDataYMD) }).strict()
const bodySchema = z.object({
  sede: zUuid,
  telefono: z.string().trim().min(6).max(40),
  genitoreNome: zOpzionale(z.string().trim().min(1).max(120)),
  email: zOpzionale(z.string().trim().max(200)),
  origine: z.enum(ORIGINI),
  bambini: z.array(bambinoSchema).max(6).optional(),
}).strict()
// contatti/stato
const statoSchema = z.object({ sede: zUuid, telefono: z.string().trim().min(6).max(40) }).strict()
// contatti/nuovi
const nuoviSchema = z.object({ sede: zUuid, dopo: z.iso.datetime({ offset: true }) }).strict()
```

  - **E1**: normalizza → `supabase.rpc('crm_ai_registra_contatto', { p_scuola_id: ai.scuolaId, p_telefono: b.telefono, p_telefono_norm, p_email: b.email ?? null, p_email_norm, p_genitore_nome: b.genitoreNome ?? null, p_origine: b.origine, p_bambini: (b.bambini ?? []).map((x) => ({ nome: x.nome ?? null, data_nascita: x.dataNascita ?? null })) })`
    → `error` → `rispostaErroreDbSchema`. Se `creata` è falso, `dettagliSchede` per dare `visita`.
    Stato `201` se creata, `200` altrimenti. Log di successo:
    `logEvento('crm', 'info', { operazione: op, esito: creata ? 'ai-contatto-creato' : 'ai-contatto-gia-presente', scuola_id: ai.scuolaId, entita_id: schedaId })`.
  - **E2**: `schedaPerTelefono` → se non c'è, la risposta «esiste false»; se c'è, `dettagliSchede`.
  - **E3**: `.from('crm_schede').select('id, creata_il, telefoni_norm, origine').eq('scuola_id', ai.scuolaId).eq('creato_via', 'segreteria').is('anonimizzata_il', null).gt('creata_il', new Date(q.dopo).toISOString()).order('creata_il', { ascending: true }).order('id', { ascending: true }).limit(100)`,
    poi `dettagliSchede`. `telefono: telefoni_norm[0] ?? null`.

- [ ] **Passo 5: lancia il test e i lock** (i sei del Compito 6, col file di questo compito).
  Atteso: `Test Files 6 passed`.

- [ ] **Passo 6: prova che il test guarda davvero.** Aggiungi per un momento `nome` alla `select` dei
  bambini e mettilo nella risposta di E2 → `nessunNomeIn` deve cadere. Rimetti a posto.

- [ ] **Passo 7: commit.**

```bash
git add src/lib/crm/ai/contatti.ts src/app/api/crm/ai/contatti __tests__/api/crm-ai-contatti.test.ts
```

```bash
git commit -m "CRM, accesso AI: registrare una famiglia senza doppioni, saperne lo stato, elencare i contatti messi a mano"
```

---

### Compito 9: «Da richiamare» — `POST /api/crm/ai/richiami` (E4)

**Aspetta:** 3 (e 1). **Parallelo con:** 4, 5, 7, 8. Leggi prima «Impalcatura comune».

**File:**
- Modifica: `src/lib/crm/follow-up.ts:98-143` (`pianificaAzione`)
- Crea: `src/lib/crm/ai/richiami.ts`, `src/app/api/crm/ai/richiami/route.ts`
- Test: `__tests__/api/crm-ai-richiami.test.ts`; aggiungi un caso a `__tests__/lib/crm/follow-up.test.ts`

**Interfacce:**
- Consuma: il gate; `pianificaAzione` (`src/lib/crm/follow-up.ts:98`); `registraEvento`;
  `personeDellaSede`, `PersonaCrm` (`src/lib/crm/accesso.ts:145, 164`); `normalizzaTelefono`;
  `dataCivile`; la funzione `crm_ai_registra_contatto`; `AutoreVia` (`src/lib/crm/tipi.ts:79`).
- Produce:

```ts
// src/lib/crm/follow-up.ts — pianificaAzione riceve UN campo in più, facoltativo
//   autoreVia?: AutoreVia   // se manca resta la regola di oggi: 'segreteria' se c'è un autore, altrimenti 'sistema'

// src/lib/crm/ai/richiami.ts
export const MOTIVI_PASSAGGIO = ['chiede_persona', 'prezzo', 'sconto', 'salute', 'reclamo', 'non_so', 'incomprensione', 'vocale', 'altro'] as const
export type MotivoPassaggio = (typeof MOTIVI_PASSAGGIO)[number]
/** La frase FISSA che finisce nello storico. Mai testo preso dalla conversazione. */
export const ETICHETTA_PASSAGGIO: Record<MotivoPassaggio, string>
/**
 * A chi va il richiamo: chi aveva l'ultima visita non annullata della scheda, se è ancora della sede; altrimenti
 * la prima persona di segreteria (in ordine di cognome e nome); altrimenti la prima persona. `null` se la sede è vuota.
 */
export function scegliResponsabile(persone: PersonaCrm[], assegnatariaUltimaVisita: string | null): string | null
```

`ETICHETTA_PASSAGGIO`, esatta:

| motivo | frase |
|---|---|
| `chiede_persona` | `chiede di parlare con una persona` |
| `prezzo` | `insiste sul prezzo` |
| `sconto` | `chiede uno sconto` |
| `salute` | `messaggio sulla salute, da leggere in chat` |
| `reclamo` | `reclamo` |
| `non_so` | `domanda a cui l’assistente non sa rispondere` |
| `incomprensione` | `due scambi senza capirsi` |
| `vocale` | `vocale non chiaro` |
| `altro` | `altro` |

**La rotta.** Operazione `'richiamo'`. Corpo `strict`, con **uno solo** fra `schedaId` e `telefono`:

```json
{ "sede": "<uuid>", "schedaId": "<uuid>", "motivo": "chiede_persona" }
```

```json
{ "sede": "<uuid>", "telefono": "{{telefono}}", "genitoreNome": "Famiglia Prova", "origine": "whatsapp", "motivo": "prezzo" }
```

Con `telefono`, `origine` è obbligatoria (se la famiglia non è ancora nel CRM, nasce la scheda: è lo
stesso «trova o crea» di E1). `motivo` è uno di `MOTIVI_PASSAGGIO`: **non esiste un campo di testo
libero**, perché il testo di una conversazione può contenere dati di salute.

| Stato | Corpo | Quando |
|---|---|---|
| `201` | `{ "azioneId": "<uuid>", "schedaId": "<uuid>", "creata": true }` | richiamo messo in lista, per oggi |
| `200` | `{ "azioneId": "<uuid>", "schedaId": "<uuid>", "creata": false }` | la scheda aveva già un «richiamare» aperto: non se ne crea un secondo |
| `404` | `SCHEDA_NON_TROVATA` | `schedaId` non è una scheda della sede della chiave |
| `409` | `NESSUN_RESPONSABILE` | nella sede non c'è nessuno a cui affidarlo |
| `422` | `CONTATTO_OBBLIGATORIO` | il telefono non è un numero |

**Fuori da una transazione, apposta.** Questa rotta fa fino a tre scritture una dopo l'altra (la scheda,
se manca; il richiamo; la nota). Se si ferma a metà, **riprovare la stessa richiesta la completa**: la
scheda si ritrova per numero, un «richiamare» aperto non si duplica. Per questo non serve una funzione
del database come per la prenotazione. (`POST /api/crm/ai/prenota`, invece, **non crea nessun richiamo**:
il primo follow-up nasce quando la segretaria segna la visita «svolta»,
`src/app/api/admin/crm/appuntamenti/[id]/route.ts:197-210`, com'è sempre stato.)

Cosa scrive: una riga in `crm_azioni` (`tipo: 'richiamare'`, scadenza alle 10:30 di Roma di **oggi**: la
lista «Da richiamare» mostra le azioni con scadenza fino a oggi,
`src/app/api/admin/crm/azioni/route.ts:99-116`), l'evento `azione_pianificata` con `autore_via: 'ai'`, e
un evento `nota` con `autore_via: 'ai'` e `testo: 'Passaggio dell’assistente: <frase>.'` — così la
segretaria, aprendo la scheda, legge **perché** deve richiamare.

- [ ] **Passo 1: scrivi i test.** In `__tests__/lib/crm/follow-up.test.ts` aggiungi, nel blocco che già
  prova `pianificaAzione` (stessa impalcatura di quel file):

```ts
it('con autoreVia «ai» lo storico dice ai, anche senza autore', async () => {
  // prepara il finto come gli altri casi di pianificaAzione in questo file
  await pianificaAzione(supabase, { schedaId: SCHEDA, scuolaId: SEDE_A, tipo: 'richiamare', giorno: '2026-11-16', responsabile: U1, autore: null, autoreVia: 'ai' })
  expect(eventoScritto()).toMatchObject({ tipo: 'azione_pianificata', autore: null, autore_via: 'ai' })
})
it('senza autoreVia resta la regola di sempre: sistema se non c’è un autore', async () => {
  await pianificaAzione(supabase, { schedaId: SCHEDA, scuolaId: SEDE_A, tipo: 'richiamare', giorno: '2026-11-16', responsabile: U1, autore: null })
  expect(eventoScritto()).toMatchObject({ autore_via: 'sistema' })
})
```

  (`supabase`, `SCHEDA`, `U1`, `eventoScritto` sono i nomi che quel file usa già per gli stessi oggetti:
  adattali a quelli veri del file, non crearne di paralleli.)

  `__tests__/api/crm-ai-richiami.test.ts`:

```ts
import { POST } from '@/app/api/crm/ai/richiami/route'
import { ETICHETTA_PASSAGGIO, MOTIVI_PASSAGGIO, scegliResponsabile } from '@/lib/crm/ai/richiami'

const S1 = '30000000-0000-4000-8000-000000000001'
const S_B = '30000000-0000-4000-8000-00000000000b'
const ADMIN = '20000000-0000-4000-8000-0000000000ad'
const chiama = (o: Record<string, unknown> = {}, token?: string | null) =>
  POST(richiestaAi('/api/crm/ai/richiami', { metodo: 'POST', token, corpo: { sede: SEDE_A, schedaId: S1, motivo: 'chiede_persona', ...o } }))
const azioni = () => scritte('crm_azioni', 'insert').flatMap((s) => s.valori)
const eventi = () => scritte('crm_eventi', 'insert').flatMap((s) => s.valori)

describe('scegliResponsabile', () => {
  const p = (id: string, ruolo: 'segreteria' | 'admin', cognome: string) => ({ id, nome: 'X', cognome, ruolo })
  const persone = [p(ADMIN, 'admin', 'Alfa'), p(U1, 'segreteria', 'Beta'), p(U2, 'segreteria', 'Gamma')]
  it('chi aveva l’ultima visita, se è ancora della sede', () => expect(scegliResponsabile(persone, U2)).toBe(U2))
  it('altrimenti la prima di segreteria, non la Direzione', () => {
    expect(scegliResponsabile(persone, null)).toBe(U1)
    expect(scegliResponsabile(persone, 'non-più-della-sede')).toBe(U1)
  })
  it('se c’è solo la Direzione, lei; se non c’è nessuno, null', () => {
    expect(scegliResponsabile([p(ADMIN, 'admin', 'Alfa')], null)).toBe(ADMIN)
    expect(scegliResponsabile([], null)).toBeNull()
  })
  it('ogni motivo ha la sua frase', () => {
    for (const m of MOTIVI_PASSAGGIO) expect(ETICHETTA_PASSAGGIO[m].length).toBeGreaterThan(3)
    expect(ETICHETTA_PASSAGGIO.salute).toBe('messaggio sulla salute, da leggere in chat')
  })
})

describe('POST /api/crm/ai/richiami (E4)', () => {
  beforeEach(() => {
    h.db.crm_schede.push({ id: S1, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova', telefoni_norm: [TEL_NORM], creato_via: 'ai', anonimizzata_il: null })
    h.db.crm_schede.push({ id: S_B, scuola_id: SEDE_B, genitore_nome: 'Famiglia Prova', telefoni_norm: [TEL_NORM], creato_via: 'ai', anonimizzata_il: null })
  })
  // + i tre casi comuni

  it('mette la famiglia in lista per OGGI alle 10:30 di Roma, affidata alla prima di segreteria', async () => {
    const r = await chiama()
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j).toMatchObject({ schedaId: S1, creata: true })
    expect(azioni()).toHaveLength(1)
    expect(azioni()[0]).toMatchObject({ scuola_id: SEDE_A, scheda_id: S1, tipo: 'richiamare', scadenza: '2026-11-16T09:30:00.000Z', responsabile: U1 })
  })
  it('lo storico dice che è stato l’assistente, e perché, con una frase fissa', async () => {
    await chiama({ motivo: 'salute' })
    const e = eventi()
    expect(e.map((x) => x.tipo)).toEqual(['azione_pianificata', 'nota'])
    expect(e.every((x) => x.autore === null && x.autore_via === 'ai')).toBe(true)
    expect(e[1].testo).toBe('Passaggio dell’assistente: messaggio sulla salute, da leggere in chat.')
  })
  it('va a chi aveva l’ultima visita della scheda', async () => {
    h.db.crm_appuntamenti.push({ id: 'v1', scuola_id: SEDE_A, scheda_id: S1, inizio: '2026-11-12T08:00:00.000Z', fine: '2026-11-12T08:45:00.000Z', stato: 'svolto', assegnata_a: U2 })
    await chiama()
    expect(azioni()[0].responsabile).toBe(U2)
  })
  it('se la scheda ha già un «richiamare» aperto non ne crea un secondo: 200, creata false', async () => {
    h.db.crm_azioni.push({ id: 'az-1', scuola_id: SEDE_A, scheda_id: S1, tipo: 'richiamare', scadenza: '2026-11-16T09:30:00.000Z', responsabile: U1, fatta_il: null, cancellata_il: null })
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ azioneId: 'az-1', schedaId: S1, creata: false })
    expect(azioni()).toHaveLength(0)
  })
  it('un richiamo già FATTO non conta: se ne crea uno nuovo', async () => {
    h.db.crm_azioni.push({ id: 'az-1', scuola_id: SEDE_A, scheda_id: S1, tipo: 'richiamare', scadenza: '2026-11-10T09:30:00.000Z', responsabile: U1, fatta_il: '2026-11-10T10:00:00.000Z', cancellata_il: null })
    expect((await chiama()).status).toBe(201)
  })
  it('la scheda di un’altra sede non esiste, per questa chiave: 404 SCHEDA_NON_TROVATA', async () => {
    const r = await chiama({ schedaId: S_B })
    expect(r.status).toBe(404)
    expect((await r.json()).codice).toBe('SCHEDA_NON_TROVATA')
    expect(azioni()).toHaveLength(0)
  })
  it('col telefono: trova o crea la scheda con la funzione, poi mette in lista', async () => {
    h.rpc.crm_ai_registra_contatto = () => ({ data: { scheda_id: S1, creata: false }, error: null })
    const r = await chiama({ schedaId: undefined, telefono: TEL_PREFISSO, origine: 'whatsapp', genitoreNome: 'Famiglia Prova' })
    expect(r.status).toBe(201)
    expect(h.chiamateRpc[0].args).toMatchObject({ p_scuola_id: SEDE_A, p_telefono_norm: TEL_NORM, p_origine: 'whatsapp', p_bambini: [] })
    expect(azioni()[0].scheda_id).toBe(S1)
  })
  it('sede senza persone: 409 NESSUN_RESPONSABILE, niente in lista', async () => {
    h.db.utenti = h.db.utenti.filter((u) => u.scuola_id !== SEDE_A)
    const r = await chiama()
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('NESSUN_RESPONSABILE')
    expect(azioni()).toHaveLength(0)
  })
  it.each([
    ['né scheda né telefono', { schedaId: undefined }],
    ['tutti e due', { telefono: TEL, origine: 'whatsapp' }],
    ['telefono senza origine', { schedaId: undefined, telefono: TEL }],
    ['motivo inventato', { motivo: 'boh' }],
    ['testo libero', { nota: 'ha la febbre' }],
  ])('validazione: %s → 400', async (_nome, o) => {
    expect((await chiama(o)).status).toBe(400)
  })
  it('R8 · la risposta porta solo id', async () => {
    const j = await (await chiama()).json()
    expect(Object.keys(j).sort()).toEqual(['azioneId', 'creata', 'schedaId'])
  })
})
```

- [ ] **Passo 2: lanciali e guardali fallire.**

Lancia: `npx vitest run __tests__/api/crm-ai-richiami.test.ts __tests__/lib/crm/follow-up.test.ts`
Atteso: `Test Files 2 failed` (in `follow-up.test.ts` cadono solo i due casi nuovi: gli altri restano verdi).

- [ ] **Passo 3: modifica `pianificaAzione`** (`src/lib/crm/follow-up.ts`). Nel tipo del secondo
  argomento (righe 100-108) aggiungi `autoreVia?: AutoreVia` (importa il tipo da `./tipi`); alla riga 135
  `autoreVia: a.autore ? 'segreteria' : 'sistema'` diventa
  `autoreVia: a.autoreVia ?? (a.autore ? 'segreteria' : 'sistema')`. Aggiorna il commento della funzione
  con una riga. **Nient'altro** in quel file.

- [ ] **Passo 4: scrivi `src/lib/crm/ai/richiami.ts` e la rotta** `withRoute('crm/ai/richiami:POST', …)`.
  Schema:

```ts
const bodySchema = z
  .object({
    sede: zUuid,
    schedaId: zOpzionale(zUuid),
    telefono: zOpzionale(z.string().trim().min(6).max(40)),
    genitoreNome: zOpzionale(z.string().trim().min(1).max(120)),
    origine: zOpzionale(z.enum(ORIGINI)),
    motivo: z.enum(MOTIVI_PASSAGGIO),
  })
  .strict()
  .refine((b) => (b.schedaId === undefined) !== (b.telefono === undefined), { message: 'Serve la scheda oppure il telefono, non tutti e due', path: ['schedaId'] })
  .refine((b) => b.telefono === undefined || b.origine !== undefined, { message: 'Con il telefono serve l’origine', path: ['origine'] })
```

  Ordine del lavoro, dopo gate, corpo e sede:
  1. La scheda. Con `schedaId`: `.from('crm_schede').select('id').eq('id', schedaId).eq('scuola_id', ai.scuolaId).maybeSingle()`
     → niente → `rifiutoAi('SCHEDA_NON_TROVATA', 404)`. Con `telefono`: normalizza (`null` → `422`), poi
     `rpc('crm_ai_registra_contatto', { p_scuola_id: ai.scuolaId, …, p_bambini: [] })`.
  2. Un «richiamare» aperto c'è già?
     `.from('crm_azioni').select('id').eq('scuola_id', ai.scuolaId).eq('scheda_id', schedaId).eq('tipo', 'richiamare').is('fatta_il', null).is('cancellata_il', null).limit(1)`
     → se c'è, `200` con `creata: false`.
  3. La responsabile: `personeDellaSede(supabase, ai.scuolaId)` (in `try/catch`: lancia) e l'ultima
     visita non annullata della scheda
     (`.from('crm_appuntamenti').select('assegnata_a, inizio').eq('scuola_id', ai.scuolaId).eq('scheda_id', schedaId).neq('stato', 'annullato').order('inizio', { ascending: false }).limit(1)`)
     → `scegliResponsabile` → `null` → `rifiutoAi('NESSUN_RESPONSABILE', 409)`.
  4. `pianificaAzione(supabase, { schedaId, scuolaId: ai.scuolaId, tipo: 'richiamare', giorno: dataCivile(), responsabile, autore: null, autoreVia: 'ai' })`
     → `null` → `rifiutoAi('CRM_OPERAZIONE_NON_RIUSCITA', 500)` (la funzione ha già scritto il motivo nel log).
  5. `registraEvento(supabase, { schedaId, scuolaId: ai.scuolaId, tipo: 'nota', autore: null, autoreVia: 'ai', testo: `Passaggio dell’assistente: ${ETICHETTA_PASSAGGIO[b.motivo]}.` })`.
  6. `logEvento('crm', 'info', { operazione: op, esito: 'ai-richiamo-in-lista', scuola_id: ai.scuolaId, entita_id: schedaId })`.

- [ ] **Passo 5: lancia i test e i lock.**

Lancia: `npx vitest run __tests__/api/crm-ai-richiami.test.ts __tests__/lib/crm/follow-up.test.ts __tests__/api/crm-azioni.test.ts __tests__/api/crm-appuntamenti.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/architecture/corpo-letto-dopo-il-gate.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts`
Atteso: `Test Files 8 passed` (i test di azioni e appuntamenti provano che `pianificaAzione` non è
cambiata per chi la usava già).

- [ ] **Passo 6: commit.**

```bash
git add src/lib/crm/follow-up.ts src/lib/crm/ai/richiami.ts src/app/api/crm/ai/richiami __tests__/api/crm-ai-richiami.test.ts __tests__/lib/crm/follow-up.test.ts
```

```bash
git commit -m "CRM, accesso AI: l'assistente mette una famiglia fra i «Da richiamare», con il perché nello storico"
```

---

### Compito 10: la scheda «Integrazioni» nella pagina del CRM

**Aspetta:** 4. **Parallelo con:** 6.

**File:**
- Modifica: `src/lib/crm/tab.ts:10`
- Modifica: `src/components/features/crm/CrmShell.tsx:96-101` (opzioni) e `:114-118` (pannelli)
- Crea: `src/components/features/crm/integrazioni/Integrazioni.tsx`
- Modifica: `messages/it/crmShell.json`, `messages/en/crmShell.json`
- Modifica: `__tests__/components/crm/crm-shell.test.tsx:30-79`
- Test: `__tests__/components/crm/integrazioni.test.tsx`

**Interfacce:**
- Consuma: le tre rotte del Compito 4 (forme lì). Il modo di chiamarle e di mostrare gli errori è quello
  degli altri pannelli del CRM: **apri prima** `src/components/features/crm/` e prendi a modello il
  pannello più piccolo (quello della disponibilità), compreso come legge `codice` dalle risposte
  (`src/lib/ui/esito-fetch.ts`).
- Produce: `export function Integrazioni({ scuolaId }: { scuolaId: string })`.

**Cosa si vede** (testi esatti, chiavi in `crmShell.json`):

| Chiave | Italiano | Inglese |
|---|---|---|
| `tabIntegrazioni` | `Assistente` | `Assistant` |
| `integrazioniTitolo` | `Chiave dell’assistente` | `Assistant key` |
| `integrazioniSpiegazione` | `Con questa chiave l’assistente automatico legge gli orari liberi e fissa le visite di questa sede. Si vede una volta sola, quando la crei.` | `With this key the automatic assistant reads free times and books visits for this school. It is shown only once, when you create it.` |
| `integrazioniSpento` | `L’accesso dell’assistente è spento per questa sede.` | `Assistant access is switched off for this school.` |
| `integrazioniSoloDirezione` | `Questa pagina è riservata alla Direzione.` | `This page is for the Management only.` |
| `integrazioniNessuna` | `Nessuna chiave attiva.` | `No active key.` |
| `integrazioniCrea` | `Crea la chiave` | `Create the key` |
| `integrazioniNome` | `Nome della chiave` | `Key name` |
| `integrazioniCopia` | `Copia la chiave` | `Copy the key` |
| `integrazioniCopiaOra` | `Copiala adesso: quando chiudi questa finestra non la potrai più rivedere.` | `Copy it now: once you close this box you will not be able to see it again.` |
| `integrazioniRevoca` | `Revoca` | `Revoke` |
| `integrazioniRevocaConferma` | `Revocare la chiave? L’assistente smette subito di funzionare per questa sede.` | `Revoke the key? The assistant stops working for this school at once.` |
| `integrazioniAttiva` | `Attiva · finisce per {coda}` | `Active · ends in {coda}` |
| `integrazioniRevocata` | `Revocata il {data}` | `Revoked on {data}` |
| `integrazioniUltimoUso` | `Ultimo uso: {data}` | `Last used: {data}` |
| `integrazioniMaiUsata` | `Mai usata` | `Never used` |

Comportamento:
- All'apertura chiama `GET`. Con `403 SOLO_ADMIN` mostra solo `integrazioniSoloDirezione` (la linguetta
  la vedono anche le segretarie: è una *scelta di Claude*, vedi in fondo).
- Se `aiAttivo` o `sedeAmmessa` è falso mostra `integrazioniSpento` e **non** il pulsante «Crea».
- Con una chiave attiva: la riga `integrazioniAttiva`, l'ultimo uso, il pulsante «Revoca» (con conferma).
  Senza: `integrazioniNessuna` e il modulo «Crea» (nome precompilato `Assistente`).
- Dopo «Crea», il token della risposta sta **solo nello stato del componente**: si mostra in un riquadro
  con `integrazioniCopiaOra` e il pulsante «Copia» (`navigator.clipboard.writeText`). **Mai** in
  `localStorage`, mai in un log, mai nell'indirizzo. Chiuso il riquadro, lo stato si svuota.
- Le date si mostrano con l'aiuto che usano gli altri pannelli (`formatData` di `@/lib/i18n/date`), mai
  `toLocaleString` senza fuso.

- [ ] **Passo 1: scrivi i test.**
  - In `__tests__/components/crm/crm-shell.test.tsx`: aggiungi il `vi.mock` del componente nuovo sul
    modello di quelli alle righe 30-70
    (`vi.mock('@/components/features/crm/integrazioni/Integrazioni', () => ({ Integrazioni: ({ scuolaId }) => <Segnaposto nome="integrazioni" dati={{ 'scuola-id': scuolaId }} /> }))`,
    con la stessa forma degli altri) e la riga `integrazioni: 'integrazioni'` in `SEGNAPOSTO_DI`
    (righe 73-79).
  - Nello stesso file, **le due prove che contano le schede**:
    - riga 108, `it('tabDaParametro ripiega sull’agenda per tutto ciò che non è una delle cinque', …)`:
      il nome diventa «…una delle sei»; il corpo non cambia (scorre già `TAB_CRM`), ma aggiungi
      `expect(tabDaParametro('integrazioni')).toBe('integrazioni')` e `expect(TAB_CRM).toHaveLength(6)`;
    - riga 117, `it('le cinque linguette ci sono tutte, con il loro nome in italiano', …)`: il nome
      diventa «le sei linguette…» e l'elenco alla riga 119 diventa
      `['Agenda', 'Da richiamare', 'Schede', 'Disponibilità', 'Statistiche', 'Assistente']`. Così com'è
      oggi quella prova resterebbe **verde senza guardare la scheda nuova**: è proprio il verde falso
      da evitare.
  - Cerca altri «cinque» rimasti:
    `grep -rn "cinque" src/lib/crm/tab.ts src/components/features/crm/CrmShell.tsx __tests__/components/crm/crm-shell.test.tsx __tests__/pages/admin-crm-pagina.test.tsx`
    → dopo le correzioni, nessuna riga che parli delle schede.
  - `__tests__/components/crm/integrazioni.test.tsx`, con `fetch` finto come negli altri test di
    `__tests__/components/crm/` (prendi l'impalcatura da `disponibilita-settimana.test.tsx`). Casi:

```
it('con 403 SOLO_ADMIN mostra «Questa pagina è riservata alla Direzione.» e nessun pulsante')
it('con aiAttivo false mostra «L’accesso dell’assistente è spento per questa sede.» e non il pulsante «Crea la chiave»')
it('senza chiavi mostra «Nessuna chiave attiva.» e il modulo con il nome «Assistente»')
it('crea: manda POST { scuolaId, nome: "Assistente" }, mostra il token UNA volta e il testo «Copiala adesso…»')
it('chiuso il riquadro, il token non è più nel documento (document.body.textContent non lo contiene)')
it('con una chiave attiva mostra «Attiva · finisce per AAAA» e «Revoca»; la revoca chiede conferma e manda DELETE /api/admin/crm/integrazioni/<id>')
it('con 409 INTEGRAZIONE_ESISTENTE mostra la frase del catalogo e non un token')
```

  Il token finto dei test è `'kvai_' + 'T'.repeat(43)`. In ogni caso aspetta la **presenza** di un testo
  (`await screen.findByText(…)`), mai l'assenza di un errore.

- [ ] **Passo 2: lanciali e guardali fallire.**

Lancia: `npx vitest run __tests__/components/crm/integrazioni.test.tsx __tests__/components/crm/crm-shell.test.tsx`
Atteso: `Test Files 2 failed`.

- [ ] **Passo 3: scrivi il codice.**
  - `src/lib/crm/tab.ts:10`: `TAB_CRM = ['agenda', 'richiamare', 'schede', 'disponibilita', 'statistiche', 'integrazioni'] as const`.
  - **I commenti che dicono «cinque» diventano falsi: correggili nello stesso commit** (un commento che
    descrive un mondo che non c'è più viene letto come vero dal prossimo che passa):
    `src/lib/crm/tab.ts:2` («LE CINQUE SCHEDE DELLA PAGINA» → «LE SEI SCHEDE…», con una riga che dice
    che la sesta, «Assistente», è della Direzione); `src/components/features/crm/CrmShell.tsx:18`
    («cinque schede e un pannello di dettaglio»), `:20` («── LE CINQUE SCHEDE ──») e `:21` («non è una
    delle cinque»); `__tests__/components/crm/crm-shell.test.tsx:21` e `:37` (i due commenti di testata).
  - `CrmShell.tsx`: una voce in `opzioni` (`{ id: 'integrazioni', label: t('tabIntegrazioni'), icon: KeyRound }`,
    icona da `lucide-react` come le altre) e il pannello `{tab === 'integrazioni' && <Integrazioni scuolaId={scuolaId} />}`.
  - Il componente e le chiavi di traduzione, nelle due lingue.

- [ ] **Passo 4: lancia i test e i lock dell'interfaccia.**

Lancia: `npx vitest run __tests__/components/crm __tests__/pages/admin-crm-pagina.test.tsx __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-plurali-e-glossario.test.ts __tests__/architecture/date-con-timezone.test.ts`
Atteso: tutti verdi (controlla che `Test Files` conti anche i due file di questo compito).

- [ ] **Passo 5: commit.**

```bash
git add src/lib/crm/tab.ts src/components/features/crm/CrmShell.tsx src/components/features/crm/integrazioni messages/it/crmShell.json messages/en/crmShell.json __tests__/components/crm/crm-shell.test.tsx __tests__/components/crm/integrazioni.test.tsx
```

```bash
git commit -m "CRM, accesso AI: la scheda «Assistente» per creare e revocare la chiave"
```

---

### Compito 11: i numeri del lock, il contratto, il PRD, il gate intero, la PR in bozza

**Aspetta:** tutti i compiti da 1 a 10. Lo fa **una** persona sola.

**File:**
- Modifica: `__tests__/architecture/isolamento-sede-coverage.test.ts` (i tre numeri: cerca
  `routeConServiceRole`, `handlerControllati`, `handlerEsentati`)
- Crea: `docs/crm-accesso-ai.md`
- Modifica: `PRD REGISTRO ELETTRONICO.md` (in cima, prima della riga 1)
- Test: `__tests__/components/crm/schede.test.tsx` (un caso in più)

- [ ] **Passo 1: una scheda senza bambini si vede bene.** L'assistente crea schede **senza bambini** (il
  modulo del sito non chiede niente del bambino); la segreteria finora no
  (`src/app/api/admin/crm/schede/route.ts:89`: `bambini … .min(1)`). In
  `__tests__/components/crm/schede.test.tsx` aggiungi un caso, con l'impalcatura di quel file: l'elenco
  riceve una scheda con `bambini: []`, `origine: 'sito'` → la riga compare (si aspetta la presenza del
  nome «Famiglia Prova») e non c'è nessun errore di rendering. Fai lo stesso per il pannello di
  dettaglio in `__tests__/components/crm/crm-shell-dettaglio.test.tsx` (scheda con `bambini: []`). Se
  uno dei due cade, **correggi il componente** (un elenco vuoto deve mostrare «nessun bambino», non
  rompersi) e scrivilo nel rapporto.

- [ ] **Passo 2: i numeri del lock sull'isolamento per sede.**

Lancia: `npx vitest run __tests__/architecture/isolamento-sede-coverage.test.ts`
Atteso: rosso **solo** sul test dei numeri. Leggi i valori misurati nel messaggio d'errore. Devono essere:
`routeConServiceRole` **+9** (da 384 a 393), `handlerControllati` **+10** (da 593 a 603),
`handlerEsentati` **invariato** (109).

  - Se i numeri misurati sono questi, aggiornali nel file con un commento datato sopra, nello stile di
    quelli che ci sono già («10/11/2026 · accesso AI al CRM: 7 rotte `crm/ai/*` e 2 `admin/crm/integrazioni*`,
    tutte con la sede della chiave o di chi è entrato»).
  - Se `handlerEsentati` è salito, **fermati**: una rotta nuova sta leggendo o scrivendo senza
    `scuola_id`. Trova quale (il messaggio del lock la nomina) e correggila; non alzare il numero.
  - Se il lock è rosso per una riga precisa (`.from('crm_…')` senza `.eq('scuola_id', …)`, `.rpc(…)`
    senza `p_scuola_id`), è un difetto: correggi la rotta.

- [ ] **Passo 3: scrivi il contratto** `docs/crm-accesso-ai.md`, per chi scrive il programma sul Mac (non
  conosce questo repo). Contenuto, in italiano semplice:
  1. che cos'è, e che è **spento** finché il titolare non lo accende; le due variabili d'ambiente;
  2. come ci si autentica (`Authorization: Bearer`), che la chiave si crea da «CRM → Assistente», e che
     va tenuta fuori da iCloud e da ogni file condiviso;
  3. per ognuna delle 7 rotte: metodo, indirizzo, corpo, risposte, codici d'errore — **ricopiati dalle
     tabelle di questo piano** (compiti 5–9), con un esempio `curl` ciascuna;
  4. le regole d'uso: `Idempotency-Key` nuova per ogni tentativo di prenotazione e uguale quando si
     riprova la **stessa**; l'orario di `/prenota` va preso da `/slot`; dopo `409 SLOT_OCCUPATO` si
     richiede `/slot` e si riprova con una chiave nuova; `429` → aspettare i secondi di `Retry-After`;
     `404 CRM_AI_SPENTO` e `503` → non riprovare a raffica, avvisare il titolare;
  5. cosa **non** torna mai (nomi, note, giorno di nascita) e perché;
  6. il limite: 60 chiamate al minuto per chiave.

  ⚠️ Trappola 5: negli esempi il numero di telefono è **sempre** il segnaposto `"{{telefono}}"`, mai un
  numero fra virgolette accanto alla parola. Nessun uuid di sede vero: `<uuid della sede>`.

- [ ] **Passo 4: il PRD.** In cima a `PRD REGISTRO ELETTRONICO.md` aggiungi un blocco con la forma di
  quelli che ci sono già (guarda le prime 20 righe del file):

```
## 🤖 Changelog — CRM: la porta dell'assistente automatico (orari, prenotazioni, contatti, «Da richiamare») — 2026-11-<GG> (branch `crm-accesso-ai`)

**Stato:** 🟡 sul branch `crm-accesso-ai`, PR in bozza verso `main`; il merge lo fa il titolare. **Spento di default** (`CRM_AI_ATTIVO`), e ammesso solo sulle sedi di `CRM_AI_SEDI_AMMESSE`: finché il titolare non dice altro, la sola sede Demo. Una migrazione (`<nome del file>`), la applica l'integrazione al merge.
```

  seguito da: **Perché** (2–3 righe: specifica CRM §8 e l'assistente approvato il 10/11); **Cosa c'è**
  (le 7 rotte in una tabella: rotta · cosa fa · cosa non restituisce; le 3 rotte della Direzione; la
  scheda «Assistente»); **Le quattro eccezioni** alla regola «l'AI non legge le schede» (E1–E4) e E5
  rimandata; **Come è protetto** (chiave per sede con sola impronta, revoca, 60 chiamate al minuto,
  registro in `app_log` senza dati personali, idempotenza, blocco per famiglia, vincolo anti
  sovrapposizione); **Cosa non c'è ancora** (l'elenco «Fase successiva» qui sotto); **Come si prova** (i
  file di test e la prova a mano del Compito 12). Aggiorna anche, nel blocco del CRM che elenca permessi
  e schermate (righe ~625-669), la riga «Token AI | Solo §8» con le quattro eccezioni.

- [ ] **Passo 5: il gate intero.** Uno alla volta, senza pipe:

Lancia: `npx eslint . --max-warnings 0` → `0 problems`.
Lancia: `npx tsc --noEmit` → nessun errore.
Lancia: `npx vitest run` → tutto verde. Annota la riga `Test Files … passed` nel rapporto.
Lancia: `npm run build` → build riuscita. (Se si ferma perché manca `.env.local`: trappola 6, fermati e
scrivilo. Se è rosso su `.next/dev/types`: trappola 7.)

- [ ] **Passo 6: rileggi i log.** Cerca nei file nuovi qualunque dato personale passato a un log:

```bash
grep -rn "logEvento\|logErrore" src/lib/crm/ai src/app/api/crm/ai src/app/api/admin/crm/integrazioni | grep -i "telefono\|nome\|email\|nascita\|token\|impronta\|testo\|motivo"
```

Atteso: nessuna riga.

- [ ] **Passo 7: commit, push del ramo, PR in bozza.**

```bash
git add __tests__/architecture/isolamento-sede-coverage.test.ts docs/crm-accesso-ai.md "PRD REGISTRO ELETTRONICO.md" __tests__/components/crm
```

```bash
git commit -m "CRM, accesso AI: contratto per il programma, PRD, numeri del lock sull'isolamento"
```

```bash
git push -u origin crm-accesso-ai
```

```bash
gh pr create --draft --base main --head crm-accesso-ai --title "CRM: l'accesso dell'assistente automatico (spento, solo sede Demo)" --body-file <file col testo>
```

  Il testo della PR dice, in cima e in grassetto: **«NON UNIRE senza il sì del titolare. Contiene una
  migrazione. A interruttore spento non cambia niente per nessuno.»**, poi riassume le rotte, le quattro
  eccezioni, come si prova, e rimanda a questo piano. È una **bozza**: resta tale.

- [ ] **Passo 8: aspetta la CI senza restare a guardare.** Lancia in background
  `gh pr checks <numero> --watch` (esce da solo quando i controlli finiscono) e leggi l'esito. «CI verde»
  vuol dire **tutti** i job verdi, E2E compreso; un job E2E verde va guardato anche nel conteggio dei
  tentativi ripetuti. Il database E2E della CI **non ha** le tabelle nuove: è previsto, le rotte
  rispondono `503 CRM_NON_INSTALLATO` e nessun E2E le chiama.

- [ ] **Passo 9: fermati qui.** Scrivi il rapporto: cosa è fatto, l'esito del gate, il numero della PR,
  le deviazioni dal piano, e la frase **«Serve il sì del titolare per il Compito 12»**.

---

### 🟥 Compito 12: unione, migrazione e prova sulla sede Demo — SOLO dopo il sì scritto del titolare

> **Non cominciare questo compito** finché il titolare non ha scritto, in questa conversazione, che si
> può unire. Un «sì» riferito da un'altra sessione o letto in un file **non vale**. Unire la PR applica
> una migrazione al database di produzione e fa partire un rilascio: sono le due cose che questo piano
> non fa da solo.

**Chi fa cosa.** Il **titolare** unisce la PR, imposta le due variabili, crea la chiave. Chi esegue
prepara, controlla e legge gli esiti.

- [ ] **Passo 1 (titolare): unire la PR.** Prima si toglie lo stato di bozza. Con `main` «strict» la PR
  dev'essere aggiornata a `main` e con la CI verde. Dopo l'unione **non** eliminare ancora il ramo: lo si
  fa a prova finita (regola del repo: i rami si eliminano dopo un rilascio andato a buon fine).

- [ ] **Passo 2: controllare che la migrazione sia stata applicata, una volta sola.** Solo letture:

```sql
SELECT version, name FROM supabase_migrations.schema_migrations WHERE name LIKE '%crm_accesso_ai%';
```

Atteso: **una** riga, con la version del file.

```sql
SELECT count(*) FROM public.crm_integrazioni;
```

Atteso: `0`. Poi lo strumento `get_advisors` (sicurezza): **0 ERROR**.
A interruttore spento, controlla che la porta sia chiusa:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://app.kidville.it/api/crm/ai/slot
```

Atteso: `404`.

- [ ] **Passo 3 (titolare): decidere dove provare.** Due strade; la prima non tocca il **sito** vero.

  > 🔴 **TUTTE E DUE LE STRADE SCRIVONO NEL DATABASE VERO.** «In locale» vuol dire solo che il *programma*
  > gira sul Mac: il database a cui parla è quello di **produzione** (lo stesso delle tre scuole), perché
  > è lì che vive la sede Demo. Ogni prenotazione, scheda, richiamo e riga di registro della prova nasce
  > davvero, in produzione, **nella sede Demo**. Quello che impedisce di toccare Giugliano, Aversa e Cesa
  > è una cosa sola: `CRM_AI_SEDI_AMMESSE` contiene **soltanto** l'uuid della Demo, e l'unica chiave che
  > esiste è della Demo. Prima di lanciare il primo comando, rileggi quella variabile.

  - **A · in locale (consigliata per la prima prova).** Il server locale parla col database di
    produzione, quindi vede la sede Demo. Si avvia **dando le due variabili sulla riga di comando**,
    senza toccare `.env.local`:

    ```bash
    CRM_AI_ATTIVO=1 CRM_AI_SEDI_AMMESSE="$SEDE_DEMO" npx next dev -p 3100
    ```

    `SEDE_DEMO` è una variabile della shell con l'uuid della sede Demo. **Non va scritto in nessun file
    del repo**, né in una nota, né in un messaggio di commit. Si ottiene in uno di questi due modi
    (l'uuid non compare nell'indirizzo delle pagine: la sede sta in un cookie):
    1. **Dall'app, senza database.** Entrare come Direzione, scegliere la sede **Demo** nel selettore
       delle sedi, aprire «CRM → Agenda» con gli strumenti per sviluppatori del browser aperti sulla
       scheda «Rete» (in Chrome: `⌥⌘I`, poi «Network»). La richiesta a
       `/api/admin/crm/appuntamenti?scuolaId=…&dal=…&al=…` porta l'uuid nel parametro `scuolaId`
       (la rotta lo pretende: `src/app/api/admin/crm/appuntamenti/route.ts:50-51`). Si copia quel valore.
    2. **Con una lettura** (nessun dato personale: è l'elenco delle sedi), dall'editor SQL di Supabase o
       con lo strumento di sola lettura:

       ```sql
       SELECT id, nome FROM public.schools WHERE nome ~* '\mdemo\M';
       ```

       Atteso: **una** riga. Se ne escono zero o più di una, fermati e chiedi al titolare.

    Poi, nel terminale (il valore si incolla, non si scrive in un file):

    ```bash
    read SEDE_DEMO
    ```
  - **B · sul sito vero.** Il titolare aggiunge `CRM_AI_ATTIVO=1` e `CRM_AI_SEDI_AMMESSE=<uuid Demo>`
    alle variabili di produzione su Vercel e rilascia di nuovo. Da quel momento la porta è aperta **solo
    per la sede Demo** e solo a chi ha la chiave. È il passo che serve al programma sul Mac.

- [ ] **Passo 4 (titolare): preparare la sede Demo.** Entrare come Direzione, sede Demo, «CRM →
  Disponibilità»: controllare che la settimana prossima abbia almeno una fascia della sede (se manca,
  aggiungerla: per esempio martedì 9:00–10:30). Poi «CRM → Assistente → Crea la chiave», copiarla, e
  metterla in una variabile della shell **senza che compaia a schermo**:

    ```bash
    read -s KV_AI_TOKEN
    ```

  (si incolla e si preme Invio: non viene mostrata né salvata nella cronologia).

- [ ] **Passo 5: la prova a mano.** `BASE` è `http://localhost:3100` (strada A) o `https://app.kidville.it`
  (strada B). I dati sono finti. Servono `curl` e `jq`.

    ```bash
    TEL='333 000 0001'; DAL=$(date -v+1d +%F); AL=$(date -v+14d +%F)
    ```

  1. **Un orario libero.**

    ```bash
    curl -s "$BASE/api/crm/ai/slot?sede=$SEDE_DEMO&dal=$DAL&al=$AL&nascita=2022-09" -H "Authorization: Bearer $KV_AI_TOKEN" | jq '{etaCoperta, n: (.slot|length), primo: .slot[0]}'
    ```

    Atteso: `etaCoperta: true`, `n` almeno 1, `primo` con `inizio` e `fine`. Nessun nome nella risposta.
    Metti il primo orario in una variabile: `INIZIO=<valore di primo.inizio>`.

  2. **Una prenotazione.**

    ```bash
    curl -s -X POST "$BASE/api/crm/ai/prenota" -H "Authorization: Bearer $KV_AI_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: prova-demo-0001" --data "$(jq -n --arg s "$SEDE_DEMO" --arg i "$INIZIO" --arg t "$TEL" '{sede: $s, inizio: $i, genitoreNome: "Famiglia Prova", telefono: $t, origine: "whatsapp", bambini: [{nome: "Bimbo Prova", dataNascita: "2022-09-15"}]}')" -w "\n%{http_code}\n"
    ```

    Atteso: `201`, con `id`, `inizio`, `fine`, `schedaId`, `schedaCreata: true`, `ripetuta: false`. Nel
    CRM, sede Demo: la visita è in agenda a quell'ora, la scheda «Famiglia Prova» esiste con origine
    WhatsApp e lo storico dice «assistente»; la segretaria assegnata ha la notifica «Visita assegnata a te».

  3. **La stessa richiesta ripetuta (R5).** Rilancia **identico** il comando del punto 2.
    Atteso: `200`, stesso `id`, `ripetuta: true`. In agenda la visita è **una**.
    ⚠️ È il caso A1: se a quell'ora riceveva una persona sola, l'orario adesso è occupato proprio da
    questa visita, e la risposta giusta resta `200` con lo stesso `id` — **mai** `409 SLOT_OCCUPATO`.

  4. **Il doppione rifiutato.** Stesso comando, ma con `Idempotency-Key: prova-demo-0002` e il telefono
    scritto in un altro modo (`TEL='+39 333-0000001'`).
    Atteso: `409`, `codice: "GIA_PRENOTATO"`, con l'orario della visita che c'è già. Nel CRM la scheda
    «Famiglia Prova» è **una sola**.

  5. **L'orario occupato.** Un'altra famiglia sullo stesso orario: `TEL='333 000 0002'`,
    `Idempotency-Key: prova-demo-0003`. Se la sede ha due persone libere a quell'ora la risposta è `201`
    (va alla collega): ripeti con `TEL='333 000 0003'` e `prova-demo-0004` finché le persone finiscono.
    Atteso alla fine: `409`, `codice: "SLOT_OCCUPATO"`; e `/slot` non propone più quell'orario.

  5-bis. **Ripetizione con l'orario ormai pieno (A1).** Adesso che a quell'ora non c'è più nessuno
    libero, rilancia **ancora** il comando del punto 2, identico (`Idempotency-Key: prova-demo-0001`).
    Atteso: `200`, lo stesso `id` del punto 2, `ripetuta: true`. Poi rilancia identica l'ultima
    richiesta del punto 5 (quella finita in `409`): atteso di nuovo `409 SLOT_OCCUPATO`. Una ripetizione
    dà sempre l'esito della prima volta, in tutti e due i versi.

  6. **La chiave di un'altra sede (R2).** Rilancia il punto 1 con l'uuid di un'altra sede al posto di
    `$SEDE_DEMO` (basta cambiare una cifra). Atteso: `403`.

  7. **Due prenotazioni nello stesso istante (R1).** Prendi un orario libero nuovo (`INIZIO2`) e lancia
    insieme due richieste per due famiglie diverse:

    ```bash
    for n in 5 6; do curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/api/crm/ai/prenota" -H "Authorization: Bearer $KV_AI_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: prova-demo-000$n" --data "$(jq -n --arg s "$SEDE_DEMO" --arg i "$INIZIO2" --arg t "333 000 000$n" '{sede: $s, inizio: $i, genitoreNome: "Famiglia Prova", telefono: $t, origine: "sito", bambini: [{nome: "Bimbo Prova", dataNascita: "2022-09-15"}]}')" & done; wait
    ```

    Atteso: con **una** persona libera a quell'ora, un `201` e un `409`; con due persone, due `201` su
    due persone diverse. In nessun caso due visite sovrapposte per la stessa persona (lo si vede in agenda).

  8. **Annullare.** `curl -s -X DELETE "$BASE/api/crm/ai/prenotazioni/<id del punto 2>?sede=$SEDE_DEMO" -H "Authorization: Bearer $KV_AI_TOKEN"`
    → `200`, `annullata: true`. In agenda la visita non c'è più; `/slot` ripropone l'orario.

  9. **La revoca (R7).** Il titolare preme «Revoca» in «CRM → Assistente». Rilancia il punto 1.
    Atteso: `401`. Poi ne crea una nuova per il programma.

  10. **Il registro.** Sola lettura, solo conteggi:

    ```sql
    SELECT contesto->'campi'->>'operazione' AS operazione, contesto->'campi'->>'stato' AS stato, count(*)
      FROM app_log
     WHERE evento = 'crm' AND contesto->'campi'->>'esito' = 'ai-chiamata' AND creato_il > now() - interval '2 hours'
     GROUP BY 1, 2 ORDER BY 1, 2;
    ```

    Atteso: una riga per ogni coppia operazione/stato provata. (Se i nomi delle colonne di `app_log` non
    sono questi, guarda la query d'esempio in `src/lib/security/rate-limit.ts:152-153`.) Apri **una**
    riga per intero e controlla che non ci siano telefono, nomi o token.

- [ ] **Passo 6: lasciare pulito.** Spegnere il server locale e azzerare le variabili:
  `unset KV_AI_TOKEN SEDE_DEMO`. Poi la sede Demo. La prova ha creato schede con i numeri finti da
  `3330000001` a `3330000006`, le loro visite, i loro eventi e le righe del registro con chiave
  `prova-demo-…`. Ripulire è un `DELETE`: **chi esegue non lo lancia** (il freno
  `.claude/hooks/supabase_sql_freno.py` lo nega, e va bene così). Lo **mostra** al titolare, che lo
  esegue dall'editor SQL di Supabase, mettendo l'uuid della Demo al posto di `<uuid della sede Demo>`
  nelle tre istruzioni.

  Prima si **conta** (è una lettura):

  ```sql
  SELECT
    (SELECT count(*) FROM public.crm_schede
      WHERE scuola_id = '<uuid della sede Demo>' AND creato_via = 'ai'
        AND telefoni_norm && ARRAY['3330000001','3330000002','3330000003','3330000004','3330000005','3330000006']) AS schede_di_prova,
    (SELECT count(*) FROM public.crm_ai_richieste
      WHERE scuola_id = '<uuid della sede Demo>' AND chiave LIKE 'prova-demo-%') AS richieste_di_prova;
  ```

  Atteso: `schede_di_prova` fra 2 e 6, `richieste_di_prova` fra 4 e 8 (dipende da quante volte si è
  ripetuto il punto 5). **Se `schede_di_prova` è più alto, non cancellare**: c'è dentro qualcosa che
  non è di questa prova. Poi, in una transazione sola:

  ```sql
  BEGIN;
  DELETE FROM public.crm_ai_richieste
   WHERE scuola_id = '<uuid della sede Demo>' AND chiave LIKE 'prova-demo-%';
  DELETE FROM public.crm_schede
   WHERE scuola_id = '<uuid della sede Demo>' AND creato_via = 'ai'
     AND telefoni_norm && ARRAY['3330000001','3330000002','3330000003','3330000004','3330000005','3330000006'];
  COMMIT;
  ```

  La seconda porta via da sola bambini, visite, richiami e storico di quelle schede (le chiavi verso
  `crm_schede` sono `ON DELETE CASCADE`: `20261030230225_crm_segreteria.sql:130, 164, 201, 232`). Tre
  cose restano, ed è giusto: le notifiche «Visita assegnata a te» già arrivate alle persone della Demo;
  le righe di `app_log` (non hanno dati personali e scadono con la loro conservazione); la chiave
  revocata nell'elenco di «CRM → Assistente». Le condizioni `creato_via = 'ai'` e i sei numeri finti
  fanno sì che le 9 schede del tutorial che la Demo aveva già **non vengano toccate**. Dopo, si riconta
  con la prima istruzione: atteso `0` e `0`.

- [ ] **Passo 7: la PR-B** (la prima cosa della sessione successiva, su un ramo nuovo):
  1. rigenerare le fotografie dalla produzione con i loro generatori
     (`node __tests__/fixtures/migrazioni-fotografia.mjs`, `indici-unici-fotografia.mjs`,
     `fk-utenti-fotografia.mjs`; in `scripts/`: `rls-fotografia.mjs`, `fk-sede-fotografia.mjs`,
     `tabelle-sede-fotografia.mjs`);
  2. svuotare `MIGRAZIONI_ATTESE_AL_MERGE` (`__tests__/architecture/soglia-fotografia.ts:359`) con la
     riga datata `// SVUOTATA il …`;
  3. **nella stessa PR**, censire le FK nuove verso `utenti` in `src/lib/personale/tracce-docente-voci.ts`
     (`crm_integrazioni.creata_da`, `crm_integrazioni.revocata_da`; forma delle voci alle righe 657-663),
     con le loro chiavi in `messages/{it,en}/adminAltro.json` — prima o dopo le fotografie il lock
     `tracce-docente-dichiarate` è rosso;
  4. aggiungere a `__tests__/lib/crm/migrazione-crm-accesso-ai.test.ts` il controllo inverso (la
     migrazione **è** nella fotografia e **non** è più fra le attese), come fa
     `__tests__/lib/crm/migrazione-crm.test.ts:128-137`;
  5. PRD: lo stato del changelog passa da 🟡 a ✅.

---

## Fase successiva (progettata, **non** si costruisce con questo piano)

**E5 · la nota della visita, solo per i richiami.** Quando il titolare avrà scritto le regole dei
richiami automatici:

- rotta `POST /api/crm/ai/richiami/contesto`, corpo `{ "sede", "schedaId" }`, operazione nuova
  `'richiamo_contesto'`;
- risposta `{ "visita": { "id", "inizio", "stato" } | null, "nota": "<testo>" | null, "bloccata": bool }`;
- `nota` è il testo dell'ultimo evento `nota` o `telefonata` scritto **dalla segreteria** dopo l'ultima
  visita svolta della scheda (`crm_eventi.testo`, `autore_via = 'segreteria'`);
- prima di uscire il testo passa da due filtri fatti dal **server**, non dall'AI: (1) i nomi dei
  bambini della scheda (`crm_bambini.nome`) diventano «il bambino»; (2) se il testo contiene una parola
  di un elenco sulla salute (allergia, diagnosi, 104, certificato, terapia, farmaco, …) la risposta è
  `nota: null, bloccata: true`;
- ha un interruttore **suo** (`CRM_AI_NOTE_ATTIVO`), spento, e un limite più basso (10 al minuto);
- ogni lettura lascia un evento nello storico della scheda: serve un tipo nuovo di evento, quindi una
  migrazione che allarga `crm_eventi_tipo_check` e il test `vocabolari-allineati`.

Va deciso col titolare e col consulente privacy **prima** di scrivere una riga: è l'unica rotta da cui
esce testo libero su un bambino.

**Altre cose rimandate, da tenere in vista:**

- **Consenso a WhatsApp dei contatti messi a mano.** `crm_schede` non ha una colonna che dica «la
  segretaria ha chiesto il permesso». Finché non c'è, E3 restituisce **tutti** i contatti messi a mano.
- **Notifica alla segretaria quando l'assistente annulla.** Oggi la visita sparisce dall'agenda senza
  avviso (serve un tipo nuovo nel catalogo delle notifiche, `src/lib/notifiche/tipi.ts:366`).
- **Pulizia di `crm_ai_richieste`.** Le righe non servono dopo qualche settimana: un lavoro pianificato
  che le toglie dopo 90 giorni (è un `DELETE`: va approvato dal titolare).
- **La prova di concorrenza su un Postgres vero**, sul modello di
  `.github/workflows/prova-concorrenza-posti.yml` (due sessioni `psql` sul database della CI).
- **Le tre sedi vere.** Si accendono aggiungendo il loro uuid a `CRM_AI_SEDI_AMMESSE` e creando una
  chiave ciascuna: nessun codice da cambiare. Serve che le segretarie abbiano inserito gli orari.
- **Età e orari.** Se un giorno le fasce saranno diverse per nido, infanzia e primaria, `/slot` ha già
  il dato per filtrarle.
- **Anonimizzazione a 12 mesi** (specifica CRM §9): quando arriverà il lavoro che svuota le schede,
  dovrà svuotare anche `crm_ai_richieste.scheda_id`.

---

## Cosa serve dal titolare

1. **Il sì per il Compito 12** (unire la PR, cioè applicare la migrazione e rilasciare). Fino ad allora
   tutto resta sul ramo.
2. **L'uuid della sede Demo** al momento della prova, dato a voce o in una variabile della shell: non va
   scritto in nessun file.
3. **Dove accendere**: solo in locale per la prova (strada A), o anche sul sito vero (strada B)? Al
   programma sul Mac serve la B.
4. **La regola dell'età** va bene? (nido fino a 2 anni compiuti entro dicembre, infanzia da 3 a 5,
   primaria da 6 a 10; i nati da gennaio ad aprile possono anticipare.) Se il nido di una sede parte da
   un'età minima, o una sede non accetta anticipi, va detto.
5. **Chi riceve le visite fissate dall'assistente** quando la fascia è «della sede»: oggi va alla prima
   persona libera in ordine alfabetico. Va bene, o c'è una persona da preferire in ogni sede?
6. **A chi va un «Da richiamare»** quando la famiglia non ha mai avuto una visita: oggi alla prima
   segretaria in ordine alfabetico. Va bene?
7. **Il consenso a WhatsApp dei contatti messi a mano**: basta la parola della segretaria, o serve una
   casella sulla scheda (che oggi non c'è)?
8. **Quando l'assistente annulla una visita**, la segretaria deve ricevere una notifica?
9. **La scheda «Assistente»** la vedono tutte, ma la usa solo la Direzione. Va bene, o va nascosta alle
   segretarie?

## Scelte di Claude (non le ha decise il titolare: si possono cambiare)

Ognuna si può ribaltare senza toccare il resto.

- **Una chiave per sede**, non una chiave con più sedi (la specifica CRM §6 diceva «sedi ammesse»): così
  la sede non può mai essere sbagliata da chi chiama.
- **Due interruttori** nelle variabili d'ambiente (`CRM_AI_ATTIVO`, `CRM_AI_SEDI_AMMESSE`) più la chiave:
  per aprire una sede servono tutte e tre le cose.
- **A interruttore spento le rotte rispondono 404**, come se non esistessero.
- **La prenotazione è una funzione del database** (`crm_ai_prenota`), non una sequenza di chiamate: è
  l'unico modo di avere insieme «una volta sola», «una famiglia sola» e «nessuna sovrapposizione».
- **`/slot` non dà le persone** e `/prenota` non accetta una persona (la specifica CRM §8 prevedeva
  `persona` facoltativa): l'assistente non nomina nessuno, quindi non gli serve.
- **`/slot` chiede anno e mese di nascita**, non il giorno; e l'età decide solo se la sede è adatta, non
  quali orari.
- **Anticipo minimo di 2 ore**, ricerca su 31 giorni al più, 60 orari al più.
- **Limite di 60 chiamate al minuto** per chiave.
- **Se l'orario è occupato, la famiglia resta comunque in scheda** (è un contatto vero).
- **`GIA_PRENOTATO` guarda solo le visite che devono ancora venire**: una visita «in programma» ma di
  giorni fa (non ancora chiusa dalla segretaria) non blocca una prenotazione nuova.
- **L'assistente annulla solo le visite fissate dall'assistente** nella sua sede (la specifica diceva
  «fatte da quel token»: così sopravvive al cambio di chiave).
- **E2 è una `POST`** anche se legge: il telefono non deve stare in un indirizzo.
- **E3 restituisce il telefono normalizzato e nient'altro di personale.**
- **«Da richiamare» nasce per oggi alle 10:30**, e il motivo è una scelta fra nove voci fisse: niente
  testo libero.
- **Le schede create dall'assistente possono non avere bambini** (il modulo del sito non li chiede).
- **Il registro delle chiamate è `app_log`** (area `crm`, esito `ai-chiamata`), non una tabella nuova.
- **La scheda «Assistente» è visibile a tutte** e risponde «riservata alla Direzione» alle segretarie.
- **La regola dell'età** e **la scelta di chi riceve** (punti 4, 5 e 6 qui sopra).

