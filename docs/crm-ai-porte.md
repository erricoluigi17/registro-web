# Le porte del CRM per la vendita

Questo è il contratto che legge il motore della vendita sul Mac (il protocollo `Crm` in `motore/vendita/tipi.py`). Elenca le dodici porte sotto `/api/crm/ai` che il motore usa, con rotta, parametri, risposta ed errori. Le regole comuni (chiave, interruttore, limite di chiamate, forma del telefono, codici di errore generali) stanno in [accesso dell’assistente al CRM](crm-accesso-ai.md) e qui non si ripetono.

Negli esempi `BASE_URL` è l’origine HTTPS autorizzata e `CRM_AI_TOKEN` contiene la chiave recuperata dall’archivio locale di segreti. I numeri di telefono, gli identificativi e le date sono inventati.

## Stato: la migrazione non è applicata

La migrazione `supabase/migrations/20261115183417_crm_porte_vendita.sql` aggiunge le colonne della vendita sulla scheda e sulla visita e le funzioni SQL delle porte nuove. Non è applicata: fino al merge e alla sua applicazione le porte nuove rispondono `503 CRM_NON_INSTALLATO`. Le porte nuove sono `sposta`, `aggiorna`, `conferma`, gli appuntamenti del giorno e `non-venute`. La porta `contatti/stato` cambia forma (vedi la sezione 5) e legge le colonne nuove, quindi risponde anch’essa `503` finché la migrazione manca. Le porte `slot`, `prenota`, annulla e `richiami` funzionano come prima. `contatti` e `contatti/nuovi` funzionano come prima solo quando non devono leggere visite o schede già presenti (elenco vuoto, scheda appena creata); altrimenti leggono colonne della migrazione e rispondono `503 CRM_NON_INSTALLATO`. Applicarla lo decide Luigi.

**Ordine di pubblicazione.** Il codice si pubblica solo con la migrazione già applicata. Se va online prima, le letture che toccano le colonne nuove (E1, E2 e E3 della scheda, dei contatti e delle visite) rispondono `503 CRM_NON_INSTALLATO`, e lo spostamento di una visita dalla segreteria (che azzera la conferma del promemoria) dà errore. L’ordine è: applicare la migrazione, poi pubblicare il codice.

L’interruttore resta spento: senza `CRM_AI_ATTIVO=1` ogni porta risponde `404 CRM_AI_SPENTO` e non tocca il database.

## Regole che valgono per tutte le porte

**Chiave e sede.** Ogni chiamata porta `Authorization: Bearer <chiave>`. La `sede` del corpo o della query è sempre quella della chiave, altrimenti `403 SEDE_NON_ACCESSIBILE`.

**Idempotenza.** Ogni scrittura nuova (`sposta`, `aggiorna`, `conferma`) vuole l’header `Idempotency-Key`: da 8 a 128 caratteri fra lettere ASCII, cifre, trattino e sottolineatura, senza dati della famiglia. Header assente o fuori forma: `400`. La regola è la stessa di `prenota`:

- stessa chiave e stesso corpo: stessa risposta di prima, senza riscrivere e senza altri avvisi; nella risposta `ripetuta: true`;
- stessa chiave e corpo diverso: `422 CHIAVE_RIUSATA`. Il confronto comprende anche l’operazione e l’identificativo nell’indirizzo, quindi la stessa chiave su due visite diverse è un corpo diverso;
- tentativo ancora in corso (la prima chiamata non ha finito): `409 CRM_OPERAZIONE_NON_RIUSCITA`; si attende e si ripete con lo stesso corpo e la stessa chiave;
- due chiamate che si incrociano nel database possono far abortire una: `409 CRM_OPERAZIONE_NON_RIUSCITA`, si riprova con la stessa chiave.

Per ripetere lo stesso tentativo dopo un timeout si riusa la stessa chiave; per un tentativo davvero nuovo se ne usa una nuova.

**Intestazioni.**

- `Cache-Control: no-store` sulle letture dei contatti nuovi, degli appuntamenti del giorno e delle visite non venute.
- `Retry-After` (secondi) con `429 TROPPE_RICHIESTE`: 60 chiamate al minuto per chiave.
- `WWW-Authenticate: Bearer` con `401 TOKEN_NON_VALIDO`, anche quando la chiave è stata revocata fra il controllo e la scrittura.
- `x-request-id` in ogni risposta: da citare quando si chiede assistenza.

**Cosa non esce mai.** Le risposte non contengono nomi di genitori o bambini, email, note, riassunto, data di nascita completa. Di un bambino al più `{id, nascita: "AAAA-MM", esito}`. Il telefono esce solo dove serve a scrivere alla famiglia: contatti nuovi, appuntamenti del giorno e visite non venute.

**Orari e giorni** sono nel fuso di Roma. Gli istanti sono ISO con fuso.

**Errori comuni.** `400` per corpo, query o header non validi; `401 TOKEN_NON_VALIDO`; `403 SEDE_NON_AMMESSA` e `SEDE_NON_ACCESSIBILE`; `404 CRM_AI_SPENTO`; `429 TROPPE_RICHIESTE`; `503 CRM_NON_INSTALLATO`; `500 CRM_OPERAZIONE_NON_RIUSCITA`. Sotto, per ogni porta, restano i soli codici propri.

## Da metodo del protocollo `Crm` a porta

| Metodo del protocollo `Crm` | Porta | Sezione |
|---|---|---|
| `orari(sede, nascita, adesso)` | `GET /api/crm/ai/slot` (con `nascita` mancante la porta non si può chiamare: la nascita è obbligatoria) | 1 |
| `esegui(azione prenota)` | `POST /api/crm/ai/prenota` | 2 |
| `esegui(azione sposta)` | `POST /api/crm/ai/prenotazioni/{id}/sposta` | 3 |
| `esegui(azione annulla)` | `DELETE /api/crm/ai/prenotazioni/{id}` | 4 |
| `scheda(telefono)` | `POST /api/crm/ai/contatti/stato` | 5 |
| `esegui(azione aggiorna_scheda)` | `POST /api/crm/ai/contatti/aggiorna` | 6 |
| `esegui(azione non_contattare)` | `POST /api/crm/ai/contatti/aggiorna` con `nonContattare: true` | 6 |
| `domani(adesso)` | `GET /api/crm/ai/prenotazioni?giorno=` | 8 |
| `non_venute(dopo)` | `GET /api/crm/ai/prenotazioni/non-venute` | 9 |

Porte senza un metodo del protocollo `Crm`: le usa il motore per altri compiti, non passano dal protocollo.

| Compito del motore (nessun metodo del protocollo) | Porta | Sezione |
|---|---|---|
| conferma del promemoria (risposta della famiglia) | `POST /api/crm/ai/prenotazioni/{id}/conferma` | 7 |
| nuovo contatto da sito o telefonata | `POST /api/crm/ai/contatti` | 10 |
| nuovi contatti della segreteria | `GET /api/crm/ai/contatti/nuovi` | 11 |
| passaggio a una persona (stato `a_una_persona`) | `POST /api/crm/ai/richiami` | 12 |

## Le fasce d’età per sede

Una visita si offre solo se la sede ha il servizio per la fascia del bambino (`etaCoperta` in `slot`, `422 ETA_NON_COPERTA` in `prenota`). L’elenco è fisso: nido e infanzia in tutte e tre le sedi, primaria solo a Giugliano e Cesa (Aversa non ha la primaria). Le fasce si contano dal solo mese di nascita e guardano al prossimo 1° settembre, non a oggi: il nido parte da 3 mesi compiuti a settembre. Il dettaglio sta in «Servizi offerti dalla sede» di [accesso dell’assistente al CRM](crm-accesso-ai.md). L’assistente dice la fascia, mai la classe.

## 1. Orari — GET /api/crm/ai/slot

Query `sede`, `dal`, `al` (`AAAA-MM-GG`, estremi inclusi, al massimo 31 giorni), `nascita` (`AAAA-MM`). Risposta `200`: `{sede, gradi, etaCoperta, troncato, slot: [{inizio, fine}]}`, al massimo 60 coppie, con almeno due ore di anticipo. Inizio e fine vanno sempre usati insieme. Dettagli e errori in [accesso](crm-accesso-ai.md), sezione 1.

```sh
curl --get "$BASE_URL/api/crm/ai/slot" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  --data-urlencode 'sede=<uuid della sede>' \
  --data-urlencode 'dal=2026-12-01' --data-urlencode 'al=2026-12-07' \
  --data-urlencode 'nascita=2024-03'
```

## 2. Fissare una visita — POST /api/crm/ai/prenota

Con `Idempotency-Key`. Corpo: `sede`, `inizio`, `fine`, `genitoreNome`, `telefono`, `origine`, `bambini` (1–6, ciascuno `nome` e `dataNascita`), facoltativi `email`, `routine`, `paura`, `desiderio`. Risposta `201`: `{id, inizio, fine, schedaId, schedaCreata, ripetuta: false}`; `200` con `ripetuta: true` su un replay.

| HTTP | Codice | Quando |
|---|---|---|
| 409 | `GIA_PRENOTATO` | La famiglia ha già una visita (la risposta riporta `id`, `inizio`, `fine`). |
| 409 | `SLOT_OCCUPATO` | L’orario è stato preso: richiedere gli slot e usare una chiave nuova. |
| 422 | `FUORI_DISPONIBILITA` | La coppia non è più prenotabile. |
| 422 | `ETA_NON_COPERTA` | La sede non offre il servizio per la fascia. |
| 422 | `CONTATTO_OBBLIGATORIO` | Il telefono non è utilizzabile. |
| 422 | `CHIAVE_RIUSATA` | Stessa chiave, corpo diverso. |

```sh
curl -X POST "$BASE_URL/api/crm/ai/prenota" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: prova-0001-abcdef' \
  --data '{"sede":"<uuid della sede>","inizio":"2026-12-02T15:00:00+01:00","fine":"2026-12-02T15:30:00+01:00","genitoreNome":"Famiglia Prova","telefono":"333 000 0001","origine":"whatsapp","bambini":[{"nome":"Bimbo Prova","dataNascita":"2024-03-10"}]}'
```

## 3. Spostare una visita — POST /api/crm/ai/prenotazioni/{id}/sposta

Con `Idempotency-Key`. L’UUID della visita sta nell’indirizzo. Corpo: `sede`, `inizio`, `fine` (la fine è successiva all’inizio; coppia presa da `slot`, con precisione al millisecondo). Si sposta solo una visita fissata da questa stessa chiave e ancora in programma. Lo spostamento è un solo passo: la vecchia ora si libera e la nuova si occupa insieme, quindi non resta mai la famiglia senza visita. Se cambia la persona assegnata, la nuova riceve l’avviso nella campanella.

**200** — `{id, inizio, fine, schedaId, invariata, ripetuta}`. `invariata: true` se l’orario chiesto è quello che la visita ha già (nessuna scrittura, nessun avviso).

**La conferma si azzera.** Dopo uno spostamento `confermata` torna `null`: il promemoria va ripetuto per il nuovo orario. Vale anche quando a spostare la visita è la segreteria dal CRM.

**L’agenda si controlla prima della funzione SQL.** La route verifica la coppia `inizio`–`fine` sulle disponibilità prima di chiamare il database. Quindi lo stesso orario di prima, se la coppia è a meno di due ore da adesso o fuori griglia, dà `422 FUORI_DISPONIBILITA` e non `invariata`; e una visita inesistente o della segreteria su un orario fuori griglia dà `422` invece di `404`.

| HTTP | Codice | Quando |
|---|---|---|
| 404 | `ELEMENTO_NON_TROVATO` | Visita non trovata per quella sede e chiave (anche se fissata dalla segreteria). |
| 409 | `STATO_NON_AMMESSO` | La visita non è più in programma (svolta, non presentata, annullata) o è già finita. |
| 409 | `SLOT_OCCUPATO` | Il nuovo orario è stato preso da altri. |
| 422 | `FUORI_DISPONIBILITA` | La nuova coppia non è nelle disponibilità. |
| 422 | `CHIAVE_RIUSATA` | Stessa chiave, corpo diverso. |

```sh
curl -X POST "$BASE_URL/api/crm/ai/prenotazioni/<uuid della visita>/sposta" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: prova-0002-abcdef' \
  --data '{"sede":"<uuid della sede>","inizio":"2026-12-03T16:00:00+01:00","fine":"2026-12-03T16:30:00+01:00"}'
```

## 4. Annullare una visita — DELETE /api/crm/ai/prenotazioni/{id}

`sede` nella query. **200** — `{id, annullata: true, giaAnnullata}`. Errori `404 ELEMENTO_NON_TROVATO` e `409 STATO_NON_AMMESSO`. Dettagli in [accesso](crm-accesso-ai.md), sezione 3.

```sh
curl -X DELETE --get "$BASE_URL/api/crm/ai/prenotazioni/<uuid della visita>" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" --data-urlencode 'sede=<uuid della sede>'
```

## 5. Scheda per telefono — POST /api/crm/ai/contatti/stato

Corpo `sede`, `telefono`. Non scrive. **200**:

- se la famiglia c’è: `{esiste: true, schedaId, creatoVia, stato, nonContattare, visita, bambini}`;
- se non c’è: `{esiste: false, schedaId: null, creatoVia: null, stato: null, nonContattare: false, visita: null, bambini: []}`.

`creatoVia` è `segreteria` o `ai`. `stato` è uno dei valori del vocabolario sotto, oppure `null` se l’assistente non ne ha ancora scritto uno. `nonContattare` è `true` se la famiglia ha chiesto di non essere contattata: il motore non le scrive. `visita` è `null` oppure `{id, inizio, fine, stato, fissataVia, modificabile, confermata}`: `stato` è `in_programma`, `svolto` o `non_presentato`; `fissataVia` è `segreteria` o `ai`; `modificabile` è `true` solo per una visita fissata da questa stessa chiave, ancora in programma e non ancora finita (le sole su cui `sposta` e annulla possono agire: una visita in programma ma già finita ha `modificabile: false`); `confermata` è la risposta al promemoria (`true`, `false`, o `null` se non c’è). `bambini` è `[{id, nascita, esito}]` con `nascita` in `AAAA-MM` o `null`.

Vocabolario di `stato`, nello stesso ordine di `STATI` del motore: `nuova`, `contattata`, `in_conversazione`, `appuntamento`, `confermato`, `venuta`, `non_venuta`, `non_risponde`, `non_interessata`, `non_contattare`, `a_una_persona`.

Errori propri: `422 CONTATTO_OBBLIGATORIO`; `500` se la lettura raggiunge il tetto tecnico di 1.000 righe.

```sh
curl -X POST "$BASE_URL/api/crm/ai/contatti/stato" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" -H 'Content-Type: application/json' \
  --data '{"sede":"<uuid della sede>","telefono":"333 000 0001"}'
```

## 6. Aggiornare la scheda — POST /api/crm/ai/contatti/aggiorna

Con `Idempotency-Key`. Corpo: `sede`; la scheda per `schedaId` **oppure** per `telefono` (uno solo dei due); almeno uno fra `stato` (uno del vocabolario), `riassunto` (testo fino a 4.000 caratteri; una stringa vuota o di soli spazi lo cancella) e `nonContattare` (solo `true`: toglierlo lo fa una persona, non l’assistente). Un campo non ammesso dà `400`.

**Stato e rifiuto sono indipendenti.** Scrivere `stato: "non_contattare"` non registra il rifiuto: il rifiuto si registra solo con `nonContattare: true`. Per una famiglia che chiede di non essere più contattata il motore manda entrambi.

**200** — `{schedaId, stato, nonContattare, ripetuta}`. `stato` può essere `null` (scheda su cui l’assistente non ha mai scritto uno stato, per esempio dopo il solo riassunto). Il riassunto non torna indietro in nessuna risposta e non entra nei log né nello storico.

| HTTP | Codice | Quando |
|---|---|---|
| 404 | `SCHEDA_NON_TROVATA` | Scheda assente, anonimizzata o di un’altra sede. |
| 422 | `CONTATTO_OBBLIGATORIO` | Il telefono non è utilizzabile. |
| 422 | `CHIAVE_RIUSATA` | Stessa chiave, corpo diverso. |

```sh
curl -X POST "$BASE_URL/api/crm/ai/contatti/aggiorna" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: prova-0003-abcdef' \
  --data '{"sede":"<uuid della sede>","telefono":"333 000 0001","stato":"in_conversazione","riassunto":"<riassunto breve>"}'
```

## 7. Conferma del promemoria — POST /api/crm/ai/prenotazioni/{id}/conferma

Con `Idempotency-Key`. Corpo: `sede`, `confermata` (`true` o `false`). Vale per ogni visita in programma della sede, anche quelle fissate dalla segreteria. Non manda avvisi: l’avviso alla sede lo manda il motore.

**200** — `{id, confermata, ripetuta}`. Errori propri: `404 ELEMENTO_NON_TROVATO` (visita assente, di un’altra sede o di una famiglia anonimizzata), `409 STATO_NON_AMMESSO` (visita non più in programma o già finita), `422 CHIAVE_RIUSATA`.

```sh
curl -X POST "$BASE_URL/api/crm/ai/prenotazioni/<uuid della visita>/conferma" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: prova-0004-abcdef' \
  --data '{"sede":"<uuid della sede>","confermata":true}'
```

## 8. Appuntamenti di un giorno — GET /api/crm/ai/prenotazioni

Query `sede`, `giorno` (`AAAA-MM-GG`, giorno civile di Roma). Sono le visite in programma che iniziano quel giorno, in ordine di orario. Con `Cache-Control: no-store`.

**200** — `{sede, giorno, prenotazioni: [{id, schedaId, inizio, fine, fissataVia, modificabile, confermata, telefono, nonContattare}]}`. `telefono` è il primo recapito normalizzato o `null`; con la scheda non trovata `telefono` è `null` e `nonContattare` è `true`. Le due forme di `modificabile` e `confermata` sono quelle della sezione 5. Il motore salta le famiglie con `nonContattare: true`. Se i risultati raggiungono il tetto tecnico di 1.000 righe la risposta è `500` e non una lista incompleta.

```sh
curl --get "$BASE_URL/api/crm/ai/prenotazioni" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  --data-urlencode 'sede=<uuid della sede>' --data-urlencode 'giorno=2026-12-02'
```

## 9. Visite non venute — GET /api/crm/ai/prenotazioni/non-venute

Query `sede`, `dopo` (istante ISO con fuso), `dopoId` facoltativo. Elenca, fino a 100 per pagina, le visite segnate «non presentato» dopo quell’istante, in ordine di `segnataIl` e poi di `id`. Con `Cache-Control: no-store`.

**200** — `{prenotazioni: [{id, schedaId, inizio, segnataIl, telefono, nonContattare}], prossimoDopo, prossimoDopoId}`. `telefono` può essere `null` (scheda anonimizzata o non trovata); con la scheda non trovata `nonContattare` è `true`, perché nel dubbio non si scrive. Come per i contatti nuovi: dopo ogni pagina si salvano **entrambi** `prossimoDopo` e `prossimoDopoId` e si mandano alla chiamata dopo; la stringa dell’istante si conserva intera, con offset e microsecondi, e si codifica con `--data-urlencode` perché il `+` non diventi uno spazio. A pagina vuota i due cursori sono `null`: si tiene l’ultimo cursore valido.

```sh
curl --get "$BASE_URL/api/crm/ai/prenotazioni/non-venute" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  --data-urlencode 'sede=<uuid della sede>' --data-urlencode 'dopo=2026-12-01T00:00:00+01:00'
```

## 10. Registrare un contatto — POST /api/crm/ai/contatti

Corpo `sede`, `telefono`, `origine`; facoltativi `genitoreNome`, `email`, `bambini`. **201** — `{schedaId, creata: true, visita: null}`; **200** — `{schedaId, creata: false, visita}` se la scheda c’era già. Errore proprio: `422 CONTATTO_OBBLIGATORIO`. Tutto il resto in [accesso](crm-accesso-ai.md), sezione 4.

```sh
curl -X POST "$BASE_URL/api/crm/ai/contatti" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" -H 'Content-Type: application/json' \
  --data '{"sede":"<uuid della sede>","telefono":"333 000 0001","origine":"sito"}'
```

## 11. Contatti nuovi della segreteria — GET /api/crm/ai/contatti/nuovi

Query `sede`, `dopo`, `dopoId` facoltativo. **200** — `{contatti, prossimoDopo, prossimoDopoId}` con `Cache-Control: no-store`, come per le visite non venute. Dettagli in [accesso](crm-accesso-ai.md), sezione 6.

```sh
curl --get "$BASE_URL/api/crm/ai/contatti/nuovi" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  --data-urlencode 'sede=<uuid della sede>' --data-urlencode 'dopo=2026-12-01T00:00:00+01:00'
```

## 12. Passare alla segreteria — POST /api/crm/ai/richiami

Corpo `sede`, `motivo`, e `schedaId` oppure `telefono` con `origine` e, facoltativo, `genitoreNome`. **201** — `{azioneId, schedaId, creata: true}`; **200** con `creata: false` se il richiamo era già aperto. Errori propri: `404 SCHEDA_NON_TROVATA`, `409 NESSUN_RESPONSABILE`, `422 CONTATTO_OBBLIGATORIO`. Dettagli in [accesso](crm-accesso-ai.md), sezione 7. Dopo un passaggio il motore scrive anche lo stato `a_una_persona` con la porta della sezione 6.

```sh
curl -X POST "$BASE_URL/api/crm/ai/richiami" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" -H 'Content-Type: application/json' \
  --data '{"sede":"<uuid della sede>","telefono":"333 000 0001","origine":"whatsapp","motivo":"chiede_persona"}'
```

## Prima di accendere `CRM_AI_VERO`

Serve una schermata della segreteria che mostri e permetta di togliere `non_contattare`, e che mostri stato, riassunto e conferma del promemoria. Oggi nessuna schermata li mostra: l’assistente può accendere il rifiuto, ma una persona non può né vederlo né spegnerlo. Senza quella schermata `CRM_AI_VERO` resta spento.

## Ambiente vero

Le sedi vere (le scuole reali) sono chiuse per default, con due interruttori sul server.

- `CRM_AI_ATTIVO=1` accende le porte. Spento, ogni porta risponde `404 CRM_AI_SPENTO` senza toccare il database.
- `CRM_AI_SEDI_AMMESSE` elenca le sedi di prova (la sede Demo), UUID separati da virgole.
- `CRM_AI_SEDI_VERE` elenca gli UUID delle sedi vere. Una sede vera entra **solo** se anche `CRM_AI_VERO=1`; scritta per sbaglio in `CRM_AI_SEDI_AMMESSE`, a `CRM_AI_VERO` spento resta fuori.
- `CRM_AI_VERO=1` apre le sedi elencate in `CRM_AI_SEDI_VERE`. È spento di default.

La chiave si crea sulla sede da **CRM → Assistente**, e la crea la Direzione: una chiave attiva per sede. Finché `CRM_AI_VERO` non è acceso la creazione di una chiave per una sede vera è rifiutata con `403 SEDE_NON_AMMESSA`, perché la creazione verifica che la sede sia ammessa. Quindi per aprire una sede vera l’ordine è: applicare la migrazione, poi `CRM_AI_SEDI_VERE` e `CRM_AI_VERO=1`, poi la Direzione crea la chiave di quella sede, e solo dopo si accende `CRM_AI_ATTIVO=1`. Prima di una sede vera la segreteria deve aver segnato le disponibilità, altrimenti `slot` non restituisce orari. Tutto si accende solo col sì di Luigi.

Il server locale di sviluppo parla col database di produzione: per provare una porta si tiene sempre `CRM_AI_ATTIVO=0` e si controlla soltanto che risponda `404 CRM_AI_SPENTO`.
