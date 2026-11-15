// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../../helpers/schema-anno-pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Le porte della vendita in SQL (piano del 15/11/2026, compiti 1 e 2): le colonne che l'assistente scrive sulla scheda e
 * sulla visita, il registro delle richieste allargato a quattro operazioni, `crm_ai_aggiorna_scheda`, `crm_ai_conferma`
 * e `crm_ai_sposta`.
 * La preparazione è quella di `migrazione-crm-accesso-ai-sql.test.ts`; la migrazione nuova gira DUE volte, come al merge
 * può capitare.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}

const uuid = (pref: string, n: number) => `${pref}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const SEDE_A = uuid('a0000000', 1)
const SEDE_B = uuid('a0000000', 2)
const P1 = uuid('b0000000', 1)
const P2 = uuid('b0000000', 2) // una collega della sede A
const P_B = uuid('b0000000', 3)
const ADMIN = uuid('b0000000', 9)
const INT_A = uuid('d0000000', 1)
const INT_B = uuid('d0000000', 2)
const INT_C = uuid('d0000000', 3) // una chiave vecchia della sede A, già revocata (ce n'è una sola attiva per sede)
const IMPRONTA_1 = '1'.repeat(64)
const IMPRONTA_2 = '2'.repeat(64)
const TEL = '333 000 0001'
const TEL_NORM = '3330000001'
const TEL2_NORM = '3330000002'
const RIASSUNTO = 'Famiglia Prova: chiede degli orari del nido, richiamare dopo le 17.'
const NOTA_SI = 'Promemoria: la famiglia conferma l’appuntamento.'
const NOTA_NO = 'Promemoria: la famiglia non conferma l’appuntamento.'
// Fra trenta giorni, alle 08:30 UTC: il test non scade col calendario.
const FRA_30 = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 30 * 86_400_000 + 8.5 * 3_600_000).toISOString()
const IERI = new Date(Date.now() - 86_400_000).toISOString()
// Le fasce del giorno di FRA_30 vanno da FRA_30 a tre ore dopo, a slot di 45 minuti.
const piu = (iso: string, minuti: number) => new Date(Date.parse(iso) + minuti * 60_000).toISOString()
const SLOT_2 = piu(FRA_30, 45)
const SLOT_3 = piu(FRA_30, 90)

let db: PGlite
type Esito = Record<string, unknown> & { esito?: string }

const conta = async (tabella: string, dove = 'true') =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.${tabella} WHERE ${dove}`)).rows[0].n)

async function aggiorna(o: {
  integrazione?: string; sede?: string; chiave?: string; impronta?: string
  id?: string | null; tel?: string | null; dati?: unknown
} = {}): Promise<Esito> {
  const r = await db.query<{ r: Esito }>('SELECT public.crm_ai_aggiorna_scheda($1,$2,$3,$4,$5,$6,$7::jsonb) AS r', [
    o.integrazione ?? INT_A, o.sede ?? SEDE_A, o.chiave ?? 'chiave-0001', o.impronta ?? IMPRONTA_1,
    o.id ?? null, o.tel ?? null, o.dati === undefined ? JSON.stringify({ stato: 'contattata' }) : JSON.stringify(o.dati),
  ])
  return r.rows[0].r
}

async function conferma(o: {
  integrazione?: string; sede?: string; chiave?: string; impronta?: string; id?: string | null; confermata?: boolean | null
} = {}): Promise<Esito> {
  const r = await db.query<{ r: Esito }>('SELECT public.crm_ai_conferma($1,$2,$3,$4,$5,$6) AS r', [
    o.integrazione ?? INT_A, o.sede ?? SEDE_A, o.chiave ?? 'chiave-0001', o.impronta ?? IMPRONTA_1,
    o.id ?? null, o.confermata === undefined ? true : o.confermata,
  ])
  return r.rows[0].r
}

/** Una scheda scritta dalla segreteria, con il numero di prova. */
async function scheda(o: { sede?: string; tel?: string; creata?: string; anonimizzata?: boolean } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(`
    INSERT INTO public.crm_schede (scuola_id, genitore_nome, telefono1, telefoni_norm, origine, creata_il, anonimizzata_il)
    VALUES ($1, 'Famiglia Prova', $2, ARRAY[$3::text], 'whatsapp', $4::timestamptz, CASE WHEN $5::boolean THEN now() END)
    RETURNING id
  `, [o.sede ?? SEDE_A, TEL, o.tel ?? TEL_NORM, o.creata ?? new Date().toISOString(), o.anonimizzata ?? false])
  return r.rows[0].id
}

/** Una visita fissata dalla segreteria (fissato_via di default, nessuna integrazione), o da una chiave se c'è `ai`. */
async function visita(o: {
  scheda: string; sede?: string; inizio?: string; stato?: string; persona?: string; ai?: string
}): Promise<string> {
  const r = await db.query<{ id: string }>(`
    INSERT INTO public.crm_appuntamenti (scuola_id, scheda_id, inizio, fine, assegnata_a, stato, fissato_via, integrazione_id)
    VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '45 minutes', $4, $5,
            CASE WHEN $6::uuid IS NULL THEN 'segreteria' ELSE 'ai' END, $6::uuid)
    RETURNING id
  `, [o.sede ?? SEDE_A, o.scheda, o.inizio ?? FRA_30, o.persona ?? P1, o.stato ?? 'in_programma', o.ai ?? null])
  return r.rows[0].id
}

async function sposta(o: {
  integrazione?: string; sede?: string; chiave?: string; impronta?: string
  id?: string | null; inizio?: string | null; durata?: number | null; candidati?: string[] | null
} = {}): Promise<Esito> {
  const candidati = o.candidati === undefined ? [P1, P2] : o.candidati
  const r = await db.query<{ r: Esito }>('SELECT public.crm_ai_sposta($1,$2,$3,$4,$5,$6::timestamptz,$7,$8::uuid[]) AS r', [
    o.integrazione ?? INT_A, o.sede ?? SEDE_A, o.chiave ?? 'chiave-0001', o.impronta ?? IMPRONTA_1,
    o.id ?? null, o.inizio === undefined ? SLOT_2 : o.inizio, o.durata === undefined ? 45 : o.durata,
    candidati === null ? null : `{${candidati.join(',')}}`,
  ])
  return r.rows[0].r
}

const rigaScheda = async (id: string) =>
  (await db.query<Record<string, unknown>>('SELECT * FROM public.crm_schede WHERE id = $1', [id])).rows[0]
const rigaVisita = async (id: string) =>
  (await db.query<Record<string, unknown>>('SELECT * FROM public.crm_appuntamenti WHERE id = $1', [id])).rows[0]
const eventi = async (dove = 'true') =>
  (await db.query<{ tipo: string; autore_via: string; dati: Record<string, unknown>; testo: string | null }>(
    `SELECT tipo, autore_via, dati, testo FROM public.crm_eventi WHERE ${dove} ORDER BY creato_il, id`,
  )).rows

const ruoliCrm = `
  CREATE TABLE public.cassa_movimenti (id uuid PRIMARY KEY);
  ALTER TABLE public.utenti ADD COLUMN scuola_id uuid REFERENCES public.schools(id),
    ADD COLUMN ruolo text, ADD COLUMN archiviato_il timestamptz, ADD COLUMN nome text, ADD COLUMN cognome text;
  CREATE TABLE public.utenti_scuole (
    utente_id uuid REFERENCES public.utenti(id), scuola_id uuid REFERENCES public.schools(id),
    PRIMARY KEY (utente_id, scuola_id)
  );
`

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [SEDE_A, SEDE_B], fino: 'M3',
    // Le funzioni di contabilità richiedono altre tabelle e non partecipano alla scrittura dell’assistente.
    codaPrima: ruoliCrm + migrazione('_crm_segreteria.sql') + migrazione('_crm_quota_e_settimane.sql').split('-- ── 6)')[0],
  })
  await db.exec(migrazione('_anno_crm_anno_id.sql'))
  await db.exec(migrazione('_crm_accesso_ai.sql'))
  await db.exec(migrazione('_crm_servizi_sede.sql'))
  await db.exec(migrazione('_crm_porte_vendita.sql'))
  await db.exec(migrazione('_crm_porte_vendita.sql'))
  await db.exec(`
    INSERT INTO public.utenti (id, scuola_id, ruolo, cognome) VALUES
      ('${P1}', '${SEDE_A}', 'admin', 'Prova A'),
      ('${P2}', '${SEDE_A}', 'segreteria', 'Prova B'),
      ('${P_B}', '${SEDE_B}', 'segreteria', 'Prova C'),
      ('${ADMIN}', '${SEDE_A}', 'admin', 'Prova D');
    INSERT INTO public.utenti_scuole (utente_id, scuola_id) VALUES ('${P1}', '${SEDE_B}');
  `)
}, 120_000)
afterAll(async () => { if (db) await db.close() })

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.crm_ai_richieste, public.crm_integrazioni, public.crm_schede,
      public.crm_settimane, public.crm_indisponibilita CASCADE;
    INSERT INTO public.crm_integrazioni (id, scuola_id, nome, token_impronta, token_coda, creata_da, revocata_il, revocata_da)
    VALUES ('${INT_A}', '${SEDE_A}', 'Assistente', '${'a'.repeat(64)}', 'AAAA', '${ADMIN}', NULL, NULL),
           ('${INT_B}', '${SEDE_B}', 'Assistente', '${'b'.repeat(64)}', 'BBBB', '${ADMIN}', NULL, NULL),
           ('${INT_C}', '${SEDE_A}', 'Assistente vecchio', '${'c'.repeat(64)}', 'CCCC', '${ADMIN}', now(), '${ADMIN}');
  `)
  // Le fasce valgono per eredità, come in migrazione-crm-accesso-ai-sql.test.ts: la settimana registrata è quella
  // precedente al giorno di FRA_30, tre ore a slot di 45 minuti da FRA_30.
  await db.query(`
    WITH orario AS (SELECT $1::timestamptz AT TIME ZONE 'Europe/Rome' AS civile), settimane AS (
      INSERT INTO public.crm_settimane (scuola_id, settimana)
        SELECT id, date_trunc('week', civile)::date - 7 FROM public.schools, orario
      RETURNING id, scuola_id
    )
    INSERT INTO public.crm_fasce (scuola_id, settimana_id, giorno_settimana, ora_inizio, ora_fine, durata_slot_min)
      SELECT scuola_id, id, extract(isodow FROM civile)::smallint, civile::time,
             (civile + interval '180 minutes')::time, 45
        FROM settimane, orario
  `, [FRA_30])
})

describe('la migrazione', () => {
  it('la migrazione gira due volte senza errori, e il registro ammette le quattro operazioni', async () => {
    // Le due esecuzioni le ha già fatte il beforeAll: qui si guarda cosa hanno lasciato.
    const { rows } = await db.query<{ conname: string; def: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'public.crm_ai_richieste'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%operazione%'
    `)
    expect(rows).toHaveLength(1)
    expect(rows[0].conname).toBe('crm_ai_richieste_operazione')
    for (const op of ['prenota', 'sposta', 'aggiorna_scheda', 'conferma']) expect(rows[0].def).toContain(`'${op}'`)
    await expect(db.query(`
      INSERT INTO public.crm_ai_richieste (scuola_id, integrazione_id, chiave, operazione, impronta)
      VALUES ($1, $2, 'chiave-0001', 'altro', $3)
    `, [SEDE_A, INT_A, IMPRONTA_1])).rejects.toMatchObject({ code: '23514' })
  })

  it('il commento del registro vale per tutte le operazioni, non solo per le prenotazioni', async () => {
    const { rows } = await db.query<{ c: string }>(`SELECT obj_description('public.crm_ai_richieste'::regclass, 'pg_class') AS c`)
    expect(rows[0].c).not.toMatch(/una riga per ogni prenotazione/)
    for (const parola of ['spostamento', 'aggiornamento della scheda', 'conferma']) expect(rows[0].c).toContain(parola)
  })

  it('le colonne nuove: non_contattare nasce falso, il resto vuoto; i vincoli rifiutano stato e riassunto fuori misura', async () => {
    const id = await scheda()
    expect(await rigaScheda(id)).toMatchObject({
      ai_stato: null, ai_riassunto: null, ai_aggiornata_il: null, non_contattare: false, non_contattare_il: null,
    })
    const v = await visita({ scheda: id })
    expect(await rigaVisita(v)).toMatchObject({ promemoria_conferma: null, promemoria_conferma_il: null })
    await expect(db.query(`UPDATE public.crm_schede SET ai_stato = 'boh' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' })
    await expect(db.query(`UPDATE public.crm_schede SET ai_riassunto = repeat('x', 4001) WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514' })
  })
})

describe('crm_ai_aggiorna_scheda', () => {
  it('aggiorna per id: scrive stato e riassunto, un evento modificata con i soli nomi dei campi', async () => {
    const id = await scheda()
    const r = await aggiorna({ id, dati: { stato: 'in_conversazione', riassunto: RIASSUNTO } })
    expect(r).toEqual({ esito: 'aggiornata', scheda_id: id, stato: 'in_conversazione', non_contattare: false })
    const riga = await rigaScheda(id)
    expect(riga).toMatchObject({ ai_stato: 'in_conversazione', ai_riassunto: RIASSUNTO, non_contattare: false })
    expect(riga.ai_aggiornata_il).not.toBeNull()
    const ev = await eventi()
    expect(ev).toEqual([{ tipo: 'modificata', autore_via: 'ai', dati: { campi: 'ai_stato,ai_riassunto' }, testo: null }])
    expect(JSON.stringify(ev)).not.toContain('orari del nido')
    expect(await conta('crm_ai_richieste',
      `operazione = 'aggiorna_scheda' AND scheda_id = '${id}' AND conclusa_il IS NOT NULL AND risposta->>'esito' = 'aggiornata'`)).toBe(1)
  })

  it('riassunto vuoto lo cancella; un campo che non cambia non entra nello storico', async () => {
    const id = await scheda()
    await aggiorna({ id, dati: { stato: 'contattata', riassunto: RIASSUNTO } })
    const r = await aggiorna({ id, chiave: 'chiave-0002', impronta: IMPRONTA_2, dati: { stato: 'contattata', riassunto: '' } })
    expect(r.esito).toBe('aggiornata')
    expect(await rigaScheda(id)).toMatchObject({ ai_stato: 'contattata', ai_riassunto: null })
    expect((await eventi()).map((e) => e.dati)).toEqual([{ campi: 'ai_stato,ai_riassunto' }, { campi: 'ai_riassunto' }])
  })

  it('un riassunto di soli spazi lo cancella', async () => {
    const id = await scheda()
    await aggiorna({ id, dati: { riassunto: RIASSUNTO } })
    const r = await aggiorna({ id, chiave: 'chiave-0002', impronta: IMPRONTA_2, dati: { riassunto: '   \n\t ' } })
    expect(r.esito).toBe('aggiornata')
    expect((await rigaScheda(id)).ai_riassunto).toBeNull()
  })

  it('un riassunto di 4000 caratteri passa, di 4001 è rifiutato con 22023', async () => {
    const id = await scheda()
    expect((await aggiorna({ id, dati: { riassunto: 'x'.repeat(4000) } })).esito).toBe('aggiornata')
    expect(((await rigaScheda(id)).ai_riassunto as string).length).toBe(4000)
    await expect(aggiorna({ id, chiave: 'chiave-0002', impronta: IMPRONTA_2, dati: { riassunto: 'y'.repeat(4001) } }))
      .rejects.toMatchObject({ code: '22023' })
    expect((await rigaScheda(id)).ai_riassunto).toBe('x'.repeat(4000))
    expect(await conta('crm_ai_richieste')).toBe(1)
  })

  it('aggiorna per telefono trova la scheda più vecchia della sede, non quella di un’altra sede', async () => {
    const altraSede = await scheda({ sede: SEDE_B, creata: '2026-01-01T08:00:00Z' })
    const vecchia = await scheda({ creata: '2026-02-01T08:00:00Z' })
    const nuova = await scheda({ creata: '2026-03-01T08:00:00Z' })
    const r = await aggiorna({ tel: TEL_NORM, dati: { stato: 'non_risponde' } })
    expect(r).toMatchObject({ esito: 'aggiornata', scheda_id: vecchia, stato: 'non_risponde' })
    expect((await rigaScheda(vecchia)).ai_stato).toBe('non_risponde')
    expect((await rigaScheda(nuova)).ai_stato).toBeNull()
    expect((await rigaScheda(altraSede)).ai_stato).toBeNull()
  })

  it('non_contattare true resta true e conserva il primo istante', async () => {
    const id = await scheda()
    const prima = await aggiorna({ id, dati: { non_contattare: true } })
    expect(prima).toMatchObject({ esito: 'aggiornata', non_contattare: true, stato: null })
    const istante = (await rigaScheda(id)).non_contattare_il as Date
    expect(istante).not.toBeNull()
    const seconda = await aggiorna({ id, chiave: 'chiave-0002', impronta: IMPRONTA_2, dati: { non_contattare: true, stato: 'non_contattare' } })
    expect(seconda).toMatchObject({ esito: 'aggiornata', non_contattare: true, stato: 'non_contattare' })
    const riga = await rigaScheda(id)
    expect(riga.non_contattare).toBe(true)
    expect((riga.non_contattare_il as Date).toISOString()).toBe(istante.toISOString())
    expect((await eventi()).map((e) => e.dati)).toEqual([{ campi: 'non_contattare' }, { campi: 'ai_stato' }])
  })

  it('stessa chiave e stesso corpo: risposta ripetuta, nessuna seconda scrittura', async () => {
    const id = await scheda()
    const prima = await aggiorna({ id, dati: { stato: 'contattata' } })
    await db.query(`UPDATE public.crm_schede SET ai_stato = 'venuta' WHERE id = $1`, [id])
    const seconda = await aggiorna({ id, dati: { stato: 'contattata' } })
    expect(seconda).toEqual({ ...prima, ripetuta: true })
    expect((await rigaScheda(id)).ai_stato).toBe('venuta')
    expect(await conta('crm_eventi')).toBe(1)
    expect(await conta('crm_ai_richieste')).toBe(1)
  })

  it('stessa chiave e impronta diversa: chiave_riusata', async () => {
    const id = await scheda()
    await aggiorna({ id, dati: { stato: 'contattata' } })
    const r = await aggiorna({ id, impronta: IMPRONTA_2, dati: { stato: 'venuta' } })
    expect(r).toEqual({ esito: 'chiave_riusata' })
    expect((await rigaScheda(id)).ai_stato).toBe('contattata')
    expect(await conta('crm_ai_richieste')).toBe(1)
  })

  it('stato fuori vocabolario, chiave sconosciuta in p_dati, non_contattare false, nessun campo: errore 22023', async () => {
    const id = await scheda()
    const errore = { code: '22023' }
    for (const dati of [
      { stato: 'boh' },
      { stato: null },
      { stato: 'contattata', nome: 'Famiglia Prova' },
      { non_contattare: false },
      { non_contattare: 'true' },
      { riassunto: 'x'.repeat(4001) },
      { riassunto: 12 },
      {},
      [],
      null,
    ]) {
      await expect(aggiorna({ id, dati }), JSON.stringify(dati)).rejects.toMatchObject(errore)
    }
    // Esattamente uno fra id e telefono, e il telefono nella forma normalizzata.
    await expect(aggiorna({ id, tel: TEL_NORM })).rejects.toMatchObject(errore)
    await expect(aggiorna({})).rejects.toMatchObject(errore)
    await expect(aggiorna({ tel: TEL })).rejects.toMatchObject(errore)
    // Chiave e impronta nella loro forma.
    await expect(aggiorna({ id, chiave: 'corta' })).rejects.toMatchObject(errore)
    await expect(aggiorna({ id, impronta: 'X'.repeat(64) })).rejects.toMatchObject(errore)
    expect(await conta('crm_ai_richieste')).toBe(0)
    expect(await conta('crm_eventi')).toBe(0)
  })

  it('scheda anonimizzata o di un’altra sede: non_trovata, registro vuoto; lo stesso tentativo più tardi viene rivalutato', async () => {
    const anonima = await scheda({ anonimizzata: true })
    const altrove = await scheda({ sede: SEDE_B, tel: TEL2_NORM })
    expect(await aggiorna({ id: anonima })).toEqual({ esito: 'non_trovata' })
    expect(await aggiorna({ id: altrove, chiave: 'chiave-0002' })).toEqual({ esito: 'non_trovata' })
    expect(await aggiorna({ tel: TEL2_NORM, chiave: 'chiave-0003' })).toEqual({ esito: 'non_trovata' })
    expect(await conta('crm_ai_richieste')).toBe(0)
    expect(await conta('crm_eventi')).toBe(0)
    // Un rifiuto non si scrive: la stessa chiave, quando la scheda c'è, fa il suo lavoro.
    const ora = await scheda({ tel: TEL2_NORM })
    expect(await aggiorna({ tel: TEL2_NORM, chiave: 'chiave-0003' })).toMatchObject({ esito: 'aggiornata', scheda_id: ora })
  })

  it('chiave revocata: token_non_valido', async () => {
    const id = await scheda()
    await db.query('UPDATE public.crm_integrazioni SET revocata_il = now(), revocata_da = $1 WHERE id = $2', [ADMIN, INT_A])
    expect(await aggiorna({ id })).toEqual({ esito: 'token_non_valido' })
    // La chiave di un'altra sede non vale qui.
    expect(await aggiorna({ id, integrazione: INT_B })).toEqual({ esito: 'token_non_valido' })
    expect((await rigaScheda(id)).ai_stato).toBeNull()
    expect(await conta('crm_ai_richieste')).toBe(0)
  })
})

describe('crm_ai_conferma', () => {
  it('conferma su una visita della segreteria: registrata, nota con testo fisso', async () => {
    const s = await scheda()
    const v = await visita({ scheda: s })
    const r = await conferma({ id: v })
    expect(r).toEqual({ esito: 'registrata', appuntamento_id: v, scheda_id: s, confermata: true })
    const riga = await rigaVisita(v)
    expect(riga.promemoria_conferma).toBe(true)
    expect(riga.promemoria_conferma_il).not.toBeNull()
    expect(riga.stato).toBe('in_programma')
    expect(await eventi()).toEqual([{ tipo: 'nota', autore_via: 'ai', dati: { appuntamento_id: v }, testo: NOTA_SI }])
    expect(await conta('crm_ai_richieste',
      `operazione = 'conferma' AND appuntamento_id = '${v}' AND scheda_id = '${s}' AND conclusa_il IS NOT NULL`)).toBe(1)
  })

  it('conferma ripetuta con la stessa chiave: ripetuta, una sola nota', async () => {
    const v = await visita({ scheda: await scheda() })
    const prima = await conferma({ id: v })
    const seconda = await conferma({ id: v })
    expect(seconda).toEqual({ ...prima, ripetuta: true })
    expect(await conta('crm_eventi', `tipo = 'nota'`)).toBe(1)
    expect(await conferma({ id: v, impronta: IMPRONTA_2, confermata: false })).toEqual({ esito: 'chiave_riusata' })
    expect((await rigaVisita(v)).promemoria_conferma).toBe(true)
  })

  it('conferma false dopo true con chiave nuova: confermata false', async () => {
    const v = await visita({ scheda: await scheda() })
    await conferma({ id: v })
    const r = await conferma({ id: v, chiave: 'chiave-0002', impronta: IMPRONTA_2, confermata: false })
    expect(r).toMatchObject({ esito: 'registrata', confermata: false })
    expect((await rigaVisita(v)).promemoria_conferma).toBe(false)
    expect((await eventi()).map((e) => e.testo)).toEqual([NOTA_SI, NOTA_NO])
  })

  it('conferma su visita annullata, svolta o già finita: stato_non_ammesso', async () => {
    const s = await scheda()
    const annullata = await visita({ scheda: s, stato: 'annullato' })
    const svolta = await visita({ scheda: s, stato: 'svolto' })
    const finita = await visita({ scheda: s, inizio: IERI })
    for (const [i, id] of [annullata, svolta, finita].entries()) {
      expect(await conferma({ id, chiave: `chiave-000${i}` })).toEqual({ esito: 'stato_non_ammesso' })
    }
    expect(await conta('crm_appuntamenti', 'promemoria_conferma IS NOT NULL')).toBe(0)
    expect(await conta('crm_eventi')).toBe(0)
    expect(await conta('crm_ai_richieste')).toBe(0)
  })

  it('visita di un’altra sede: non_trovato', async () => {
    const v = await visita({ scheda: await scheda({ sede: SEDE_B }), sede: SEDE_B, persona: P_B })
    expect(await conferma({ id: v })).toEqual({ esito: 'non_trovato' })
    expect(await conferma({ id: uuid('e0000000', 1), chiave: 'chiave-0002' })).toEqual({ esito: 'non_trovato' })
    expect((await rigaVisita(v)).promemoria_conferma).toBeNull()
    expect(await conta('crm_ai_richieste')).toBe(0)
  })

  it('visita di una scheda anonimizzata: non_trovato, la visita non si tocca', async () => {
    const v = await visita({ scheda: await scheda({ anonimizzata: true }) })
    expect(await conferma({ id: v })).toEqual({ esito: 'non_trovato' })
    expect((await rigaVisita(v)).promemoria_conferma).toBeNull()
    expect(await conta('crm_eventi')).toBe(0)
    expect(await conta('crm_ai_richieste')).toBe(0)
  })

  it('chiave revocata: token_non_valido; argomenti mancanti: 22023', async () => {
    const v = await visita({ scheda: await scheda() })
    await expect(conferma({ id: null })).rejects.toMatchObject({ code: '22023' })
    await expect(conferma({ id: v, confermata: null })).rejects.toMatchObject({ code: '22023' })
    await expect(conferma({ id: v, chiave: 'con spazi dentro' })).rejects.toMatchObject({ code: '22023' })
    await db.query('UPDATE public.crm_integrazioni SET revocata_il = now(), revocata_da = $1 WHERE id = $2', [ADMIN, INT_A])
    expect(await conferma({ id: v })).toEqual({ esito: 'token_non_valido' })
    expect((await rigaVisita(v)).promemoria_conferma).toBeNull()
  })
})

describe('crm_ai_sposta', () => {
  const istante = (x: unknown) => new Date(x as string | Date).toISOString()

  it('sposta: stessa riga, nuovo orario, conferma azzerata, evento spostato', async () => {
    const s = await scheda()
    const v = await visita({ scheda: s, ai: INT_A })
    await conferma({ id: v, chiave: 'conferma-0001' })
    expect((await rigaVisita(v)).promemoria_conferma).toBe(true)
    const r = await sposta({ id: v })
    expect(r).toMatchObject({ esito: 'spostata', appuntamento_id: v, scheda_id: s, assegnata_a: P1, assegnata_prima: P1 })
    expect(Object.keys(r).sort()).toEqual(['appuntamento_id', 'assegnata_a', 'assegnata_prima', 'esito', 'fine', 'inizio', 'scheda_id'])
    expect(istante(r.inizio)).toBe(SLOT_2)
    expect(istante(r.fine)).toBe(SLOT_3)
    expect(await conta('crm_appuntamenti', `scheda_id = '${s}'`)).toBe(1)
    const riga = await rigaVisita(v)
    expect(istante(riga.inizio)).toBe(SLOT_2)
    expect(istante(riga.fine)).toBe(SLOT_3)
    expect(riga).toMatchObject({
      durata_min: 45, assegnata_a: P1, stato: 'in_programma', fissato_via: 'ai', integrazione_id: INT_A,
      promemoria_conferma: null, promemoria_conferma_il: null,
    })
    const ev = await eventi(`tipo LIKE 'appuntamento_%'`)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ tipo: 'appuntamento_spostato', autore_via: 'ai', testo: null })
    expect(Object.keys(ev[0].dati).sort()).toEqual(['appuntamento_id', 'durata_min', 'inizio_dopo', 'inizio_prima'])
    expect(ev[0].dati).toMatchObject({ appuntamento_id: v, durata_min: 45 })
    expect(istante(ev[0].dati.inizio_prima)).toBe(FRA_30)
    expect(istante(ev[0].dati.inizio_dopo)).toBe(SLOT_2)
    expect(await conta('crm_ai_richieste',
      `operazione = 'sposta' AND appuntamento_id = '${v}' AND scheda_id = '${s}' AND conclusa_il IS NOT NULL AND risposta->>'esito' = 'spostata'`)).toBe(1)
  })

  it('la persona già assegnata ha la precedenza, anche se arriva dopo fra le candidate', async () => {
    const v = await visita({ scheda: await scheda(), ai: INT_A, persona: P1 })
    const r = await sposta({ id: v, candidati: [P2, P1] })
    expect(r).toMatchObject({ esito: 'spostata', assegnata_a: P1, assegnata_prima: P1 })
    expect(await conta('crm_eventi', `tipo = 'appuntamento_riassegnato'`)).toBe(0)
  })

  it('la persona già assegnata non è fra le candidate: passa alla prima libera, nell’ordine ricevuto', async () => {
    const v = await visita({ scheda: await scheda(), ai: INT_A, persona: P1 })
    const r = await sposta({ id: v, candidati: [P2] })
    expect(r).toMatchObject({ esito: 'spostata', assegnata_a: P2, assegnata_prima: P1 })
    expect((await rigaVisita(v)).assegnata_a).toBe(P2)
  })

  it('due spostamenti di seguito con chiavi diverse: una visita, all’ultimo orario, due eventi', async () => {
    const s = await scheda()
    const v = await visita({ scheda: s, ai: INT_A })
    expect((await sposta({ id: v })).esito).toBe('spostata')
    expect((await sposta({ id: v, chiave: 'chiave-0002', impronta: IMPRONTA_2, inizio: SLOT_3 })).esito).toBe('spostata')
    expect(await conta('crm_appuntamenti', `scheda_id = '${s}'`)).toBe(1)
    expect(istante((await rigaVisita(v)).inizio)).toBe(SLOT_3)
    const ev = await eventi(`tipo = 'appuntamento_spostato'`)
    expect(ev.map((e) => [istante(e.dati.inizio_prima), istante(e.dati.inizio_dopo)])).toEqual([[FRA_30, SLOT_2], [SLOT_2, SLOT_3]])
    expect(await conta('crm_ai_richieste', `operazione = 'sposta'`)).toBe(2)
  })

  it('la persona di oggi è occupata all’ora nuova: passa alla collega libera, evento riassegnato', async () => {
    const s = await scheda()
    const v = await visita({ scheda: s, ai: INT_A, persona: P1 })
    // P1 ha già un'altra famiglia all'ora nuova.
    await visita({ scheda: await scheda({ tel: TEL2_NORM }), inizio: SLOT_2, persona: P1 })
    const r = await sposta({ id: v, candidati: [P1, P2] })
    expect(r).toMatchObject({ esito: 'spostata', appuntamento_id: v, assegnata_a: P2, assegnata_prima: P1 })
    const riga = await rigaVisita(v)
    expect(riga.assegnata_a).toBe(P2)
    expect(istante(riga.inizio)).toBe(SLOT_2)
    const ev = await eventi(`scheda_id = '${s}' AND tipo LIKE 'appuntamento_%'`)
    // I due eventi sono scritti dalla stessa chiamata: l'ordine fra istanti uguali non conta.
    expect(ev.map((e) => e.tipo).sort()).toEqual(['appuntamento_riassegnato', 'appuntamento_spostato'])
    const riass = ev.find((e) => e.tipo === 'appuntamento_riassegnato')!
    expect(riass).toMatchObject({ autore_via: 'ai', dati: { appuntamento_id: v, assegnata_prima: P1, assegnata_dopo: P2 } })
    expect(Object.keys(riass.dati).sort()).toEqual(['appuntamento_id', 'assegnata_dopo', 'assegnata_prima'])
  })

  it('nessuna candidata libera: slot_occupato e la visita resta all’orario di prima', async () => {
    const s = await scheda()
    const v = await visita({ scheda: s, ai: INT_A, persona: P1 })
    await conferma({ id: v, chiave: 'conferma-0001' })
    await visita({ scheda: await scheda({ tel: TEL2_NORM }), inizio: SLOT_2, persona: P1 })
    await visita({ scheda: await scheda({ tel: '3330000003' }), inizio: SLOT_2, persona: P2 })
    expect(await sposta({ id: v, candidati: [P1, P2] })).toEqual({ esito: 'slot_occupato' })
    const riga = await rigaVisita(v)
    expect(istante(riga.inizio)).toBe(FRA_30)
    expect(riga).toMatchObject({ assegnata_a: P1, stato: 'in_programma', promemoria_conferma: true })
    expect(await conta('crm_eventi', `tipo LIKE 'appuntamento_%'`)).toBe(0)
    expect(await conta('crm_ai_richieste', `operazione = 'sposta'`)).toBe(0)
  })

  it('stesso orario: invariata, nessun evento', async () => {
    const s = await scheda()
    const v = await visita({ scheda: s, ai: INT_A })
    await conferma({ id: v, chiave: 'conferma-0001' })
    const prima = await rigaVisita(v)
    const r = await sposta({ id: v, inizio: FRA_30, durata: 45, candidati: [P2] })
    expect(r).toMatchObject({ esito: 'invariata', appuntamento_id: v, scheda_id: s, assegnata_a: P1 })
    expect(Object.keys(r).sort()).toEqual(['appuntamento_id', 'assegnata_a', 'esito', 'fine', 'inizio', 'scheda_id'])
    expect(istante(r.inizio)).toBe(FRA_30)
    expect(istante(r.fine)).toBe(SLOT_2)
    expect(await rigaVisita(v)).toEqual(prima)
    expect(await conta('crm_eventi', `tipo LIKE 'appuntamento_%'`)).toBe(0)
    expect(await conta('crm_ai_richieste', `operazione = 'sposta' AND risposta->>'esito' = 'invariata'`)).toBe(1)
  })

  it('meno di due ore da adesso, o fuori dalle fasce: fuori_disponibilita', async () => {
    const v = await visita({ scheda: await scheda(), ai: INT_A })
    const casi: Array<{ inizio: string; durata?: number }> = [
      { inizio: piu(new Date().toISOString(), 60) }, // fra un'ora
      { inizio: piu(FRA_30, 10) }, // fuori dalla griglia
      { inizio: piu(FRA_30, 24 * 60) }, // un giorno senza fasce
      { inizio: SLOT_2, durata: 30 }, // una durata che le fasce non hanno
      { inizio: piu(FRA_30, 180) }, // oltre la fine della fascia
    ]
    for (const [i, c] of casi.entries()) {
      expect(await sposta({ id: v, chiave: `chiave-000${i}`, ...c }), JSON.stringify(c)).toEqual({ esito: 'fuori_disponibilita' })
    }
    // Un'assenza della persona all'ora nuova la toglie dalle candidate.
    await db.query(`INSERT INTO public.crm_indisponibilita (scuola_id, utente_id, dal, al, motivo) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 'ferie')`,
      [SEDE_A, P1, SLOT_2, SLOT_3])
    expect(await sposta({ id: v, chiave: 'chiave-0009', candidati: [P1] })).toEqual({ esito: 'fuori_disponibilita' })
    expect(istante((await rigaVisita(v)).inizio)).toBe(FRA_30)
    expect(await conta('crm_eventi')).toBe(0)
    expect(await conta('crm_ai_richieste')).toBe(0)
  })

  it('visita fissata dalla segreteria, da un’altra chiave, di un’altra sede o di una scheda anonimizzata: non_trovato', async () => {
    const s = await scheda()
    const segreteria = await visita({ scheda: s })
    const altraChiave = await visita({ scheda: await scheda({ tel: TEL2_NORM }), ai: INT_C, persona: P2 })
    const altraSede = await visita({ scheda: await scheda({ sede: SEDE_B }), sede: SEDE_B, persona: P_B, ai: INT_B })
    const anonima = await visita({ scheda: await scheda({ anonimizzata: true }), ai: INT_A, inizio: SLOT_3 })
    for (const [i, id] of [segreteria, altraChiave, altraSede, anonima, uuid('e0000000', 1)].entries()) {
      expect(await sposta({ id, chiave: `chiave-000${i}`, inizio: piu(FRA_30, 135) }), id).toEqual({ esito: 'non_trovato' })
    }
    expect(istante((await rigaVisita(segreteria)).inizio)).toBe(FRA_30)
    expect(await conta('crm_eventi')).toBe(0)
    expect(await conta('crm_ai_richieste')).toBe(0)
  })

  it('visita annullata o passata: stato_non_ammesso', async () => {
    const s = await scheda()
    const annullata = await visita({ scheda: s, ai: INT_A, stato: 'annullato' })
    const svolta = await visita({ scheda: s, ai: INT_A, stato: 'svolto', inizio: SLOT_3 })
    const passata = await visita({ scheda: s, ai: INT_A, inizio: IERI })
    for (const [i, id] of [annullata, svolta, passata].entries()) {
      expect(await sposta({ id, chiave: `chiave-000${i}` })).toEqual({ esito: 'stato_non_ammesso' })
    }
    expect((await rigaVisita(annullata)).stato).toBe('annullato')
    expect(await conta('crm_eventi')).toBe(0)
    expect(await conta('crm_ai_richieste')).toBe(0)
  })

  it('stessa chiave: ripetuta senza secondo evento', async () => {
    const v = await visita({ scheda: await scheda(), ai: INT_A })
    const prima = await sposta({ id: v })
    expect(prima.esito).toBe('spostata')
    const seconda = await sposta({ id: v })
    expect(seconda).toEqual({ ...prima, ripetuta: true })
    expect(await conta('crm_eventi', `tipo = 'appuntamento_spostato'`)).toBe(1)
    expect(await conta('crm_ai_richieste')).toBe(1)
  })

  it('stessa chiave, orario diverso: chiave_riusata', async () => {
    const v = await visita({ scheda: await scheda(), ai: INT_A })
    await sposta({ id: v })
    expect(await sposta({ id: v, impronta: IMPRONTA_2, inizio: SLOT_3 })).toEqual({ esito: 'chiave_riusata' })
    expect(istante((await rigaVisita(v)).inizio)).toBe(SLOT_2)
    expect(await conta('crm_eventi', `tipo = 'appuntamento_spostato'`)).toBe(1)
  })

  it('argomenti non validi: 22023; chiave revocata o di un’altra sede: token_non_valido', async () => {
    const v = await visita({ scheda: await scheda(), ai: INT_A })
    const errore = { code: '22023' }
    await expect(sposta({ id: null })).rejects.toMatchObject(errore)
    await expect(sposta({ id: v, inizio: null })).rejects.toMatchObject(errore)
    await expect(sposta({ id: v, inizio: 'infinity' })).rejects.toMatchObject(errore)
    await expect(sposta({ id: v, durata: null })).rejects.toMatchObject(errore)
    await expect(sposta({ id: v, durata: 10 })).rejects.toMatchObject(errore)
    await expect(sposta({ id: v, durata: 241 })).rejects.toMatchObject(errore)
    await expect(sposta({ id: v, candidati: [] })).rejects.toMatchObject(errore)
    await expect(sposta({ id: v, chiave: 'corta' })).rejects.toMatchObject(errore)
    await expect(sposta({ id: v, impronta: 'X'.repeat(64) })).rejects.toMatchObject(errore)
    expect(await sposta({ id: v, integrazione: INT_B })).toEqual({ esito: 'token_non_valido' })
    await db.query('UPDATE public.crm_integrazioni SET revocata_il = now(), revocata_da = $1 WHERE id = $2', [ADMIN, INT_A])
    expect(await sposta({ id: v })).toEqual({ esito: 'token_non_valido' })
    expect(istante((await rigaVisita(v)).inizio)).toBe(FRA_30)
    expect(await conta('crm_ai_richieste')).toBe(0)
  })
})
