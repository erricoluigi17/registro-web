import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as GIORNO } from '@/app/api/crm/ai/prenotazioni/route'
import { accendiAi, INTEGRAZIONE_A, integrazioniFinte, nessunNomeIn, richiestaAi, TOKEN_B, tokenAttivoFinto } from '../fixtures/crm-ai'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  lette: [] as string[],
  tokenAttivo: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db, h.lette, {
    errori: h.errori,
    rpc: { crm_ai_token_attivo: h.tokenAttivo },
    maxRighe: 1000,
  }),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: async () => ({ ok: true, remaining: 59, retryAfterMs: 0 }),
  rateLimitLocale: () => ({ ok: true, remaining: 299, retryAfterMs: 0 }),
  clientIp: () => '203.0.113.1',
}))
vi.mock('@/lib/logging/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))

const S1 = '30000000-0000-4000-8000-000000000001'
const S2 = '30000000-0000-4000-8000-000000000002'
const S_ANON = '30000000-0000-4000-8000-000000000003'
const V1 = '40000000-0000-4000-8000-000000000001'
const V2 = '40000000-0000-4000-8000-000000000002'
const V3 = '40000000-0000-4000-8000-000000000003'
const TEL_NORM = '3330000001'
const TEL_NORM2 = '3330000002'
const NOME_GENITORE = 'Famiglia Prova'
const NOTA = 'Nota fittizia riservata'
const RIASSUNTO = 'Riassunto riservato della conversazione'
const GIORNO_X = '2026-11-18'

const scheda = (campi: Riga = {}): Riga => ({
  id: S1, scuola_id: SEDE_A, genitore_nome: NOME_GENITORE, telefono1: '333 000 0001', telefoni_norm: [TEL_NORM],
  anonimizzata_il: null, routine: NOTA, ai_riassunto: RIASSUNTO, non_contattare: false, ...campi,
})
const visita = (campi: Riga = {}): Riga => ({
  id: V1, scuola_id: SEDE_A, scheda_id: S1, inizio: '2026-11-18T08:00:00.000Z', fine: '2026-11-18T08:45:00.000Z',
  stato: 'in_programma', nota: NOTA, fissato_via: 'segreteria', integrazione_id: null, promemoria_conferma: null, ...campi,
})

const giorno = (campi: Record<string, string> = {}, token?: string | null) =>
  GIORNO(richiestaAi('/api/crm/ai/prenotazioni?' + new URLSearchParams({ sede: SEDE_A, giorno: GIORNO_X, ...campi }), { token }))

const idsDi = async (r: Response) => ((await r.json()).prenotazioni as { id: string }[]).map((p) => p.id)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'))
  accendiAi([SEDE_A, SEDE_B])
  h.errori = {}
  h.lette = []
  h.tokenAttivo.mockReset().mockImplementation(tokenAttivoFinto(() => h.db))
  h.logErrore.mockClear()
  h.logEvento.mockClear()
  h.db = { crm_integrazioni: integrazioniFinte(), crm_schede: [], crm_appuntamenti: [] }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('appuntamenti del giorno', () => {
  it('dà solo le in_programma del giorno, anche quelle della segreteria, ordinate per inizio e id', async () => {
    h.db.crm_schede.push(scheda(), scheda({ id: S2, telefoni_norm: [TEL_NORM2, '3330000009'], non_contattare: true }))
    h.db.crm_appuntamenti.push(
      visita({ id: V3, scheda_id: S2, inizio: '2026-11-18T09:00:00.000Z', fine: '2026-11-18T09:45:00.000Z', fissato_via: 'ai', integrazione_id: INTEGRAZIONE_A, promemoria_conferma: true }),
      visita({ id: V2, scheda_id: S1 }),
      visita({ id: V1, scheda_id: S1, fissato_via: 'ai', integrazione_id: INTEGRAZIONE_A, promemoria_conferma: false }),
    )
    const r = await giorno()
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const j = await r.json()
    nessunNomeIn(j, [NOME_GENITORE, NOTA, RIASSUNTO, '333 000 0001', '3330000009'])
    expect(j).toEqual({
      sede: SEDE_A, giorno: GIORNO_X,
      prenotazioni: [
        { id: V1, schedaId: S1, inizio: '2026-11-18T08:00:00.000Z', fine: '2026-11-18T08:45:00.000Z', fissataVia: 'ai', modificabile: true, confermata: false, telefono: TEL_NORM, nonContattare: false },
        { id: V2, schedaId: S1, inizio: '2026-11-18T08:00:00.000Z', fine: '2026-11-18T08:45:00.000Z', fissataVia: 'segreteria', modificabile: false, confermata: null, telefono: TEL_NORM, nonContattare: false },
        { id: V3, schedaId: S2, inizio: '2026-11-18T09:00:00.000Z', fine: '2026-11-18T09:45:00.000Z', fissataVia: 'ai', modificabile: true, confermata: true, telefono: TEL_NORM2, nonContattare: true },
      ],
    })
  })

  it('una visita dell’AI fissata da un’altra chiave non è modificabile', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(visita({ fissato_via: 'ai', integrazione_id: '50000000-0000-4000-8000-0000000000cc' }))
    expect((await (await giorno()).json()).prenotazioni[0]).toMatchObject({ fissataVia: 'ai', modificabile: false })
  })

  it('una visita dell’AI in programma ma già finita non è modificabile (la funzione SQL la rifiuterebbe)', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(visita({ fissato_via: 'ai', integrazione_id: INTEGRAZIONE_A }))
    vi.setSystemTime(new Date('2026-11-18T08:44:00.000Z'))
    expect((await (await giorno()).json()).prenotazioni[0]).toMatchObject({ fissataVia: 'ai', modificabile: true })
    vi.setSystemTime(new Date('2026-11-18T08:45:00.000Z'))
    expect((await (await giorno()).json()).prenotazioni[0]).toMatchObject({ fissataVia: 'ai', modificabile: false })
  })

  it('con la scheda non trovata il telefono è null e nonContattare è true (nel dubbio non si scrive)', async () => {
    h.db.crm_appuntamenti.push(visita())
    expect((await (await giorno()).json()).prenotazioni[0]).toMatchObject({ telefono: null, nonContattare: true })
  })

  it('esclude annullate, svolte, non presentate, del giorno dopo e di un’altra sede', async () => {
    h.db.crm_schede.push(scheda(), scheda({ id: S2, scuola_id: SEDE_B }))
    h.db.crm_appuntamenti.push(
      visita(),
      visita({ id: V2, stato: 'annullato' }),
      visita({ id: V3, stato: 'svolto' }),
      visita({ id: '40000000-0000-4000-8000-000000000004', stato: 'non_presentato' }),
      visita({ id: '40000000-0000-4000-8000-000000000005', inizio: '2026-11-19T08:00:00.000Z', fine: '2026-11-19T08:45:00.000Z' }),
      visita({ id: '40000000-0000-4000-8000-000000000006', scuola_id: SEDE_B, scheda_id: S2 }),
    )
    expect(await idsDi(await giorno())).toEqual([V1])
  })

  it.each([
    { giorno: '2026-10-25', prima: '2026-10-24T22:00:00.000Z', primaEsclusa: '2026-10-24T21:59:00.000Z', ultima: '2026-10-25T22:30:00.000Z', dopo: '2026-10-25T23:00:00.000Z' },
    { giorno: '2027-03-28', prima: '2027-03-27T23:00:00.000Z', primaEsclusa: '2027-03-27T22:59:00.000Z', ultima: '2027-03-28T21:30:00.000Z', dopo: '2027-03-28T22:00:00.000Z' },
  ])('giorno del cambio d’ora $giorno: entrano le 00:00 e le 23:30 di Roma, non quelle dei giorni accanto', async (c) => {
    const id = (n: number) => '40000000-0000-4000-8000-0000000001' + String(n).padStart(2, '0')
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(
      visita({ id: id(1), inizio: c.primaEsclusa }),
      visita({ id: id(2), inizio: c.prima }),
      visita({ id: id(3), inizio: c.ultima }),
      visita({ id: id(4), inizio: c.dopo }),
    )
    expect(await idsDi(await giorno({ giorno: c.giorno }))).toEqual([id(2), id(3)])
  })

  it('una scheda anonimizzata ha telefono null, senza dati della famiglia', async () => {
    h.db.crm_schede.push(scheda({ id: S_ANON, anonimizzata_il: '2026-11-01T10:00:00.000Z' }))
    h.db.crm_appuntamenti.push(visita({ scheda_id: S_ANON }))
    const j = await (await giorno()).json()
    expect(j.prenotazioni[0]).toMatchObject({ schedaId: S_ANON, telefono: null })
    nessunNomeIn(j, [TEL_NORM, NOME_GENITORE])
  })

  it('un giorno vuoto non legge le schede', async () => {
    const r = await giorno()
    expect(await r.json()).toEqual({ sede: SEDE_A, giorno: GIORNO_X, prenotazioni: [] })
    expect(h.lette).not.toContain('crm_schede')
  })

  it.each([
    { giorno: '2026-02-30' },
    { giorno: '18/11/2026' },
    { giorno: '2026-11-18T10:00' },
    { extra: '1' },
    { [NOTA]: 'privato' },
  ] as Record<string, string>[])('respinge un giorno malformato o un parametro in più: 400', async (campi) => {
    const r = await giorno(campi)
    expect(r.status).toBe(400)
    nessunNomeIn(await r.json(), [NOTA])
    expect(h.lette).not.toContain('crm_appuntamenti')
  })

  it('senza giorno risponde 400', async () => {
    const r = GIORNO(richiestaAi('/api/crm/ai/prenotazioni?' + new URLSearchParams({ sede: SEDE_A })))
    expect((await r).status).toBe(400)
  })

  it('a interruttore spento risponde 404 prima del DB', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const r = await giorno({ giorno: 'no' })
    expect(r.status).toBe(404)
    expect(h.lette).toEqual([])
  })

  it('senza chiave risponde 401 prima del DB', async () => {
    const r = await giorno({}, null)
    expect(r.status).toBe(401)
    expect(h.lette).toEqual([])
  })

  it('la chiave di un’altra sede non legge niente della sede richiesta', async () => {
    h.db.crm_appuntamenti.push(visita())
    const r = await giorno({}, TOKEN_B)
    expect(r.status).toBe(403)
    expect(h.lette).not.toContain('crm_appuntamenti')
  })

  it('chiave revocata dopo il gate: 401 e nessuna visita letta', async () => {
    h.db.crm_appuntamenti.push(visita())
    h.tokenAttivo.mockResolvedValueOnce({ data: false, error: null })
    const r = await giorno()
    expect(r.status).toBe(401)
    expect(await r.json()).toMatchObject({ codice: 'TOKEN_NON_VALIDO' })
    expect(h.lette).not.toContain('crm_appuntamenti')
  })

  it('un errore di lettura non riporta il testo grezzo del DB', async () => {
    h.errori.crm_appuntamenti = { code: '42501', message: NOME_GENITORE, details: TEL_NORM, hint: NOTA }
    const r = await giorno()
    expect(r.status).toBe(500)
    nessunNomeIn(await r.json(), [NOME_GENITORE, TEL_NORM, NOTA])
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ operazione: 'crm/ai/prenotazioni' }), { code: '42501' })
  })

  it('una colonna della migrazione mancante nelle schede (42703) risponde 503 senza testo grezzo', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(visita())
    h.errori.crm_schede = { code: '42703', message: NOME_GENITORE, details: TEL_NORM, hint: NOTA }
    const r = await giorno()
    expect(r.status).toBe(503)
    const j = await r.json()
    expect(j).toMatchObject({ codice: 'CRM_NON_INSTALLATO' })
    nessunNomeIn([j, h.logErrore.mock.calls, h.logEvento.mock.calls], [NOME_GENITORE, TEL_NORM, NOTA])
  })

  it('un elenco di visite troncato da PostgREST non produce una risposta parziale', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti = Array.from({ length: 1001 }, (_, i) => visita({
      id: '70000000-0000-4000-8000-' + String(i).padStart(12, '0'),
    }))
    const r = await giorno()
    expect(r.status).toBe(500)
    const j = await r.json()
    expect(j).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(j).not.toHaveProperty('prenotazioni')
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({
      esito: 'max-rows-raggiunto', scuola_id: SEDE_A, limite: 1000,
    }))
  })

  it('i log non contengono telefoni', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(visita())
    await giorno()
    nessunNomeIn([h.logEvento.mock.calls, h.logErrore.mock.calls], [TEL_NORM, '333 000 0001', NOME_GENITORE])
  })
})
