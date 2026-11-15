import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/crm/ai/contatti/aggiorna/route'
import { improntaCorpo } from '@/lib/crm/ai/idempotenza'
import { STATI_FAMIGLIA_AI } from '@/lib/crm/tipi'
import { INTEGRAZIONE_A, INTEGRAZIONE_B, TOKEN_B, accendiAi, integrazioniFinte, nessunNomeIn, richiestaAi } from '../fixtures/crm-ai'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type RispostaRpc, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  lette: [] as string[],
  scritture: [] as Scrittura[],
  rpc: vi.fn<(args: Riga) => RispostaRpc | Promise<RispostaRpc>>(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db, h.lette, {
    errori: h.errori,
    scritture: h.scritture,
    rpc: { crm_ai_aggiorna_scheda: h.rpc },
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
  logOk: h.logOk,
}))

const SCHEDA = '30000000-0000-4000-8000-000000000001'
const CHIAVE = 'aggiorna-0001-a'
const LETTURE_GATE = ['crm_integrazioni', 'crm_integrazioni']
const RIASSUNTO = 'Riassunto riservato sintetico della conversazione'
const DATI_RISERVATI = [RIASSUNTO, 'Famiglia Prova', '333 000 0001']

beforeEach(() => {
  accendiAi([SEDE_A, SEDE_B])
  vi.clearAllMocks()
  h.rpc.mockReset().mockImplementation(() => { throw new Error('RPC non preparata dal test') })
  h.errori = {}
  h.lette = []
  h.scritture = []
  h.db = { crm_integrazioni: integrazioniFinte(), crm_ai_richieste: [] }
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const corpo = (extra: Riga = {}): Riga => ({ sede: SEDE_A, schedaId: SCHEDA, stato: 'contattata', ...extra })
const richiesta = (extra: Riga = {}, { token, chiave = CHIAVE }: { token?: string | null; chiave?: string | null } = {}) =>
  richiestaAi('/api/crm/ai/contatti/aggiorna', { metodo: 'POST', corpo: corpo(extra), token, chiave: chiave ?? undefined })
const chiama = (...args: Parameters<typeof richiesta>) => POST(richiesta(...args))

const esito = (data: Riga): RispostaRpc => ({ data, error: null })
const aggiornata = (extra: Riga = {}): Riga => ({
  esito: 'aggiornata', scheda_id: SCHEDA, stato: 'contattata', non_contattare: false, ...extra,
})
const successo = { schedaId: SCHEDA, stato: 'contattata', nonContattare: false, ripetuta: false }
const improntaDi = (campi: Riga) => improntaCorpo({ operazione: 'aggiorna_scheda', sede: SEDE_A, ...campi })

function registra(impronta: unknown, risposta: Riga | null, extra: Riga = {}) {
  h.db.crm_ai_richieste.push({
    scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, chiave: CHIAVE, operazione: 'aggiorna_scheda',
    impronta, risposta, ...extra,
  })
}

describe('POST /api/crm/ai/contatti/aggiorna', () => {
  it('interruttore spento: 404 senza toccare il database', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const r = await chiama()
    expect(r.status).toBe(404)
    expect(h.lette).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('sede diversa dalla chiave: 403 SEDE_NON_ACCESSIBILE', async () => {
    const r = await chiama({}, { token: TOKEN_B })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each<[string, Riga, string | null]>([
    ['senza Idempotency-Key', {}, null],
    ['chiave troppo corta', {}, 'abc'],
    ['schedaId e telefono insieme', { telefono: '+39 333 000 0001' }, CHIAVE],
    ['né schedaId né telefono', { schedaId: undefined }, CHIAVE],
    ['nessun campo da scrivere', { stato: undefined }, CHIAVE],
    ['nonContattare false', { stato: undefined, nonContattare: false }, CHIAVE],
    ['stato fuori vocabolario', { stato: 'sconosciuto' }, CHIAVE],
    ['riassunto oltre 4000 caratteri', { stato: undefined, riassunto: 'x'.repeat(4001) }, CHIAVE],
    ['telefono troppo corto', { schedaId: undefined, telefono: '123' }, CHIAVE],
    ['schedaId non UUID', { schedaId: 'x' }, CHIAVE],
    ['sede non UUID', { sede: 'x' }, CHIAVE],
  ])('validazione: %s → 400 senza rpc', async (_caso, campi, chiave) => {
    const r = await chiama(campi, { chiave })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'Dati non validi', details: expect.any(Array) })
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('campo in più nel corpo: 400 senza ripeterne il nome', async () => {
    const r = await chiama({ 'Famiglia Prova': 'x' })
    expect(r.status).toBe(400)
    const risposta = await r.json()
    expect(JSON.stringify(risposta)).toContain('Sono presenti campi non ammessi')
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], DATI_RISERVATI)
  })

  it.each(STATI_FAMIGLIA_AI)('lo stato %s è ammesso', async (stato) => {
    h.rpc.mockReturnValueOnce(esito(aggiornata({ stato })))
    const r = await chiama({ stato })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, stato })
  })

  it('+39 333 000 0001 arriva all’rpc come 3330000001, senza scheda', async () => {
    h.rpc.mockReturnValueOnce(esito(aggiornata()))
    const r = await chiama({ schedaId: undefined, telefono: '+39 333 000 0001' })
    expect(r.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({
      p_integrazione_id: INTEGRAZIONE_A, p_scuola_id: SEDE_A, p_chiave: CHIAVE,
      p_impronta: improntaDi({ telefono: '3330000001', stato: 'contattata' }),
      p_scheda_id: null, p_telefono_norm: '3330000001', p_dati: { stato: 'contattata' },
    })
  })

  it('per schedaId passa p_scheda_id minuscolo e i soli campi scritti, riassunto compreso', async () => {
    h.rpc.mockReturnValueOnce(esito(aggiornata({ non_contattare: true, stato: 'non_contattare' })))
    const r = await chiama({
      schedaId: SCHEDA.toUpperCase(), stato: 'non_contattare', riassunto: `  ${RIASSUNTO}  `, nonContattare: true,
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, stato: 'non_contattare', nonContattare: true })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      p_scheda_id: SCHEDA, p_telefono_norm: null,
      p_dati: { stato: 'non_contattare', riassunto: RIASSUNTO, non_contattare: true },
    }))
  })

  it('il riassunto vuoto è ammesso (cancella) e va all’rpc come stringa vuota', async () => {
    h.rpc.mockReturnValueOnce(esito(aggiornata()))
    const r = await chiama({ stato: undefined, riassunto: '' })
    expect(r.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_dati: { riassunto: '' } }))
  })

  it('telefono non normalizzabile: 422 CONTATTO_OBBLIGATORIO prima dell’rpc', async () => {
    const r = await chiama({ schedaId: undefined, telefono: 'abc-defg-hij' })
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'CONTATTO_OBBLIGATORIO' })
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('l’impronta dipende dal corpo, riassunto compreso, e non lo contiene', async () => {
    h.rpc.mockReturnValue(esito(aggiornata()))
    await chiama({ riassunto: 'primo' })
    await chiama({ riassunto: 'secondo' })
    const [a, b] = h.rpc.mock.calls.map(([argomenti]) => String(argomenti.p_impronta))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('la stessa chiave con impronta diversa: 422 CHIAVE_RIUSATA senza rpc', async () => {
    registra('f'.repeat(64), aggiornata())
    const r = await chiama()
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'CHIAVE_RIUSATA' })
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('replay con la stessa chiave: risposta registrata, rpc non chiamata', async () => {
    registra(improntaDi({ schedaId: SCHEDA, stato: 'contattata' }), aggiornata({ non_contattare: true }))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, nonContattare: true, ripetuta: true })
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('riga di registro ancora aperta: 409 senza chiamare l’rpc', async () => {
    registra(improntaDi({ schedaId: SCHEDA, stato: 'contattata' }), null)
    const r = await chiama()
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each([
    { integrazione_id: INTEGRAZIONE_B },
    { scuola_id: SEDE_B },
    { chiave: 'altra-chiave-01' },
  ])('il registro è filtrato su sede, integrazione e chiave (%j)', async (altraRiga) => {
    registra('f'.repeat(64), aggiornata(), altraRiga)
    h.rpc.mockReturnValueOnce(esito(aggiornata()))
    expect((await chiama()).status).toBe(200)
  })

  it('replay dalla RPC (ripetuta true): ripetuta true', async () => {
    h.rpc.mockReturnValueOnce(esito(aggiornata({ ripetuta: true })))
    const r = await chiama()
    expect(await r.json()).toEqual({ ...successo, ripetuta: true })
  })

  it('stato nullo dopo la scrittura (solo riassunto su scheda mai scritta): stato null', async () => {
    h.rpc.mockReturnValueOnce(esito(aggiornata({ stato: null })))
    const r = await chiama({ stato: undefined, riassunto: 'nota' })
    expect(await r.json()).toEqual({ ...successo, stato: null })
  })

  it.each([
    ['non_trovata', 404, 'SCHEDA_NON_TROVATA'],
    ['chiave_riusata', 422, 'CHIAVE_RIUSATA'],
    ['in_corso', 409, 'CRM_OPERAZIONE_NON_RIUSCITA'],
    ['token_non_valido', 401, 'TOKEN_NON_VALIDO'],
  ])('traduce l’esito RPC %s', async (risultato, stato, codice) => {
    h.rpc.mockReturnValueOnce(esito({ esito: risultato, genitore: 'Famiglia Prova' }))
    const r = await chiama()
    expect(r.status).toBe(stato)
    expect(await r.json()).toEqual({ error: expect.any(String), codice })
    if (stato === 401) expect(r.headers.get('www-authenticate')).toBe('Bearer')
  })

  it.each(['40P01', '40001'])('errore Postgres %s: 409 riprovabile, log warn col solo codice', async (code) => {
    h.rpc.mockReturnValueOnce({ data: null, error: { code, message: 'Famiglia Prova', details: RIASSUNTO } })
    const r = await chiama({ riassunto: RIASSUNTO })
    expect(r.status).toBe(409)
    const risposta = await r.json()
    expect(risposta).toEqual({ error: expect.any(String), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'warn', expect.objectContaining({ scuola_id: SEDE_A }), { code })
    expect(h.logErrore).not.toHaveBeenCalled()
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], DATI_RISERVATI)
  })

  it.each([
    ['registro', 'PGRST205', 503, 'CRM_NON_INSTALLATO'],
    ['registro', 'XX000', 500, 'CRM_OPERAZIONE_NON_RIUSCITA'],
    ['rpc', 'PGRST202', 503, 'CRM_NON_INSTALLATO'],
    ['rpc', 'XX000', 500, 'CRM_OPERAZIONE_NON_RIUSCITA'],
  ])('un guasto in %s (%s) conserva solo il codice tecnico', async (dove, code, stato, codice) => {
    const error = { code, message: 'Famiglia Prova', details: RIASSUNTO }
    if (dove === 'registro') h.errori.crm_ai_richieste = error
    else h.rpc.mockReturnValueOnce({ data: null, error })
    const r = await chiama({ riassunto: RIASSUNTO })
    expect(r.status).toBe(stato)
    const risposta = await r.json()
    expect(risposta).toEqual({ error: expect.any(String), codice })
    nessunNomeIn([risposta, h.logErrore.mock.calls, h.logEvento.mock.calls], DATI_RISERVATI)
  })

  it('un esito inatteso della RPC è un 500 registrato senza dati grezzi', async () => {
    h.rpc.mockReturnValueOnce(esito({ esito: RIASSUNTO }))
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 500 }), new Error('Esito inatteso da crm_ai_aggiorna_scheda'))
  })

  it('la scheda restituita diversa da quella chiesta è un esito illeggibile (500)', async () => {
    h.rpc.mockReturnValueOnce(esito(aggiornata({ scheda_id: '30000000-0000-4000-8000-0000000000ff' })))
    const r = await chiama()
    expect(r.status).toBe(500)
  })

  it('il riassunto non compare in nessuna riga di log, in nessun ramo', async () => {
    h.rpc.mockReturnValueOnce(esito(aggiornata()))
    const ok = await chiama({ riassunto: RIASSUNTO })
    registra(improntaDi({ schedaId: SCHEDA, stato: 'contattata', riassunto: RIASSUNTO }), aggiornata())
    const replay = await chiama({ riassunto: RIASSUNTO })
    const riuso = await chiama({ riassunto: RIASSUNTO + ' diverso' })
    const corpi = [await ok.json(), await replay.json(), await riuso.json()]
    nessunNomeIn([corpi, h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls], [RIASSUNTO])
    expect(h.logEvento).toHaveBeenCalled()
  })

  it('con telefono, la scheda scelta dall’rpc è quella della risposta (nessun confronto con un id)', async () => {
    h.rpc.mockReturnValueOnce(esito(aggiornata({ scheda_id: '30000000-0000-4000-8000-0000000000aa' })))
    const r = await chiama({ schedaId: undefined, telefono: '333 000 0002' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ schedaId: '30000000-0000-4000-8000-0000000000aa' })
  })
})
