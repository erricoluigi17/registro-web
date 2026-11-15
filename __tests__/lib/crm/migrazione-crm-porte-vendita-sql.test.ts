// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../../helpers/schema-anno-pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Le porte della vendita in SQL (piano del 15/11/2026, compito 1): le colonne che l'assistente scrive sulla scheda e
 * sulla visita, il registro delle richieste allargato a quattro operazioni, `crm_ai_aggiorna_scheda` e `crm_ai_conferma`.
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
const P_B = uuid('b0000000', 3)
const ADMIN = uuid('b0000000', 9)
const INT_A = uuid('d0000000', 1)
const INT_B = uuid('d0000000', 2)
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

/** Una visita fissata dalla segreteria (fissato_via di default, nessuna integrazione). */
async function visita(o: { scheda: string; sede?: string; inizio?: string; stato?: string; persona?: string }): Promise<string> {
  const r = await db.query<{ id: string }>(`
    INSERT INTO public.crm_appuntamenti (scuola_id, scheda_id, inizio, fine, assegnata_a, stato)
    VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '45 minutes', $4, $5)
    RETURNING id
  `, [o.sede ?? SEDE_A, o.scheda, o.inizio ?? FRA_30, o.persona ?? P1, o.stato ?? 'in_programma'])
  return r.rows[0].id
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
      ('${P_B}', '${SEDE_B}', 'segreteria', 'Prova C'),
      ('${ADMIN}', '${SEDE_A}', 'admin', 'Prova D');
    INSERT INTO public.utenti_scuole (utente_id, scuola_id) VALUES ('${P1}', '${SEDE_B}');
  `)
}, 120_000)
afterAll(async () => { if (db) await db.close() })

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.crm_ai_richieste, public.crm_integrazioni, public.crm_schede CASCADE;
    INSERT INTO public.crm_integrazioni (id, scuola_id, nome, token_impronta, token_coda, creata_da)
    VALUES ('${INT_A}', '${SEDE_A}', 'Assistente', '${'a'.repeat(64)}', 'AAAA', '${ADMIN}'),
           ('${INT_B}', '${SEDE_B}', 'Assistente', '${'b'.repeat(64)}', 'BBBB', '${ADMIN}');
  `)
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
