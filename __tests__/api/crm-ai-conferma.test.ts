import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/crm/ai/prenotazioni/[id]/conferma/route'
import { improntaCorpo } from '@/lib/crm/ai/idempotenza'
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
    rpc: { crm_ai_conferma: h.rpc },
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

const VISITA = '40000000-0000-4000-8000-000000000001'
const SCHEDA = '30000000-0000-4000-8000-000000000001'
const CHIAVE = 'conferma-0001-a'
const LETTURE_GATE = ['crm_integrazioni', 'crm_integrazioni']
const DATI_RISERVATI = ['Nota privata sintetica', 'Famiglia Sintetica', '333 000 0001']

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

const dati = (extra: Riga = {}, esitoSql = 'registrata'): Riga => ({
  esito: esitoSql, appuntamento_id: VISITA, scheda_id: SCHEDA, confermata: true, ...extra,
})
const successo = { id: VISITA, confermata: true, ripetuta: false }
const esito = (data: Riga): RispostaRpc => ({ data, error: null })
const corpo = (extra: Riga = {}) => ({ sede: SEDE_A, confermata: true, ...extra })
const richiesta = (
  extra: Riga = {},
  { token, chiave = CHIAVE, id = VISITA }: { token?: string | null; chiave?: string | null; id?: string } = {},
) => richiestaAi(`/api/crm/ai/prenotazioni/${id}/conferma`, {
  metodo: 'POST', corpo: corpo(extra), token, chiave: chiave ?? undefined,
})
const chiama = (...args: Parameters<typeof richiesta>) =>
  POST(richiesta(...args), { params: Promise.resolve({ id: args[1]?.id ?? VISITA }) })
const impronta = (confermata = true) => improntaCorpo({ operazione: 'conferma', id: VISITA, sede: SEDE_A, confermata })

function registra(improntaRiga: unknown, risposta: Riga | null, extra: Riga = {}) {
  h.db.crm_ai_richieste.push({
    scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, chiave: CHIAVE, operazione: 'conferma',
    impronta: improntaRiga, risposta, ...extra,
  })
}

describe('POST /api/crm/ai/prenotazioni/{id}/conferma', () => {
  it('interruttore spento: 404 senza toccare il database', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const req = richiesta({ confermata: null })
    const leggi = vi.spyOn(req, 'json')
    const r = await POST(req, { params: Promise.resolve({ id: VISITA }) })
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ codice: 'CRM_AI_SPENTO' })
    expect(leggi).not.toHaveBeenCalled()
    expect(h.lette).toEqual([])
    expect(h.scritture).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('senza chiave API: 401 TOKEN_NON_VALIDO senza accesso al database', async () => {
    const r = await chiama({}, { token: null })
    expect(r.status).toBe(401)
    expect(await r.json()).toMatchObject({ codice: 'TOKEN_NON_VALIDO' })
    expect(h.lette).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('sede diversa dalla chiave: 403 SEDE_NON_ACCESSIBILE', async () => {
    const r = await chiama({}, { token: TOKEN_B })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.lette).toEqual(LETTURE_GATE)
    expect(h.scritture).toMatchObject([
      { tabella: 'crm_integrazioni', operazione: 'update', colpite: [{ id: INTEGRAZIONE_B, scuola_id: SEDE_B }] },
    ])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('id non UUID: 400', async () => {
    const r = await chiama({}, { id: 'non-un-uuid' })
    expect(r.status).toBe(400)
    expect(h.lette).toEqual(LETTURE_GATE)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each<[string, Riga, string | null]>([
    ['senza Idempotency-Key', {}, null],
    ['chiave troppo corta', {}, 'abc'],
    ['confermata mancante', { confermata: undefined }, CHIAVE],
    ['confermata non booleana (stringa)', { confermata: 'true' }, CHIAVE],
    ['confermata non booleana (numero)', { confermata: 1 }, CHIAVE],
    ['confermata nulla', { confermata: null }, CHIAVE],
    ['sede non UUID', { sede: 'x' }, CHIAVE],
  ])('validazione: %s → 400 senza rpc', async (_caso, campi, chiave) => {
    const r = await chiama(campi, { chiave })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'Dati non validi', details: expect.any(Array) })
    expect(h.lette).toEqual(LETTURE_GATE)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('campo in più nel corpo: 400 senza ripeterne il nome', async () => {
    const r = await chiama({ [DATI_RISERVATI[1]]: 'x' })
    expect(r.status).toBe(400)
    const risposta = await r.json()
    expect(JSON.stringify(risposta)).toContain('Sono presenti campi non ammessi')
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], DATI_RISERVATI)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('registrata (famiglia conferma): 200 con id, confermata e ripetuta false', async () => {
    h.rpc.mockReturnValueOnce(esito(dati()))
    const r = await chiama()
    expect(r.status).toBe(200)
    const risposta = await r.json()
    expect(risposta).toEqual(successo)
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'info', expect.objectContaining({
      esito: 'ai-visita-confermata', scuola_id: SEDE_A, entita_id: VISITA,
    }))
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], DATI_RISERVATI)
  })

  it('registrata (famiglia non conferma): confermata false', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ confermata: false })))
    const r = await chiama({ confermata: false })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, confermata: false })
  })

  it('visita fissata dalla segreteria: 200 (la regola vera sta nella funzione SQL)', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ scheda_id: '30000000-0000-4000-8000-000000000009' })))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(successo)
  })

  it('replay (ripetuta dalla RPC): ripetuta true e nessun log di nuova conferma', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ ripetuta: true })))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, ripetuta: true })
    expect(h.logEvento).not.toHaveBeenCalledWith('crm', 'info', expect.objectContaining({ esito: 'ai-visita-confermata' }))
  })

  it('gli argomenti passati all’rpc', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ confermata: false })))
    await chiama({ confermata: false })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({
      p_integrazione_id: INTEGRAZIONE_A, p_scuola_id: SEDE_A, p_chiave: CHIAVE,
      p_impronta: impronta(false), p_appuntamento_id: VISITA, p_confermata: false,
    })
  })

  it('l’impronta comprende operazione, id e risposta', async () => {
    h.rpc.mockReturnValue(esito(dati()))
    await chiama()
    await chiama({}, { id: '40000000-0000-4000-8000-000000000002' })
    await chiama({ confermata: false })
    const [a, b, c] = h.rpc.mock.calls.map(([argomenti]) => argomenti.p_impronta)
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('un id maiuscolo è passato minuscolo e dà la stessa impronta', async () => {
    h.rpc.mockReturnValueOnce(esito(dati()))
    await chiama({}, { id: VISITA.toUpperCase() })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_appuntamento_id: VISITA, p_impronta: impronta() }))
  })

  it('la stessa chiave con impronta diversa: 422 CHIAVE_RIUSATA senza rpc', async () => {
    registra('f'.repeat(64), dati())
    const r = await chiama()
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'CHIAVE_RIUSATA' })
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('la stessa chiave con risposta opposta: CHIAVE_RIUSATA', async () => {
    registra(impronta(false), dati({ confermata: false }))
    const r = await chiama({ confermata: true })
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'CHIAVE_RIUSATA' })
  })

  it('risposta registrata: la ripete con ripetuta true, senza rpc', async () => {
    registra(impronta(), dati())
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, ripetuta: true })
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('riga di registro ancora senza risposta: 409 senza chiamare l’rpc', async () => {
    registra(impronta(), null)
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
    registra('f'.repeat(64), dati(), altraRiga)
    h.rpc.mockReturnValueOnce(esito(dati()))
    expect((await chiama()).status).toBe(200)
  })

  it.each([
    ['non_trovato', 404, 'ELEMENTO_NON_TROVATO'],
    ['stato_non_ammesso', 409, 'STATO_NON_AMMESSO'],
    ['chiave_riusata', 422, 'CHIAVE_RIUSATA'],
    ['in_corso', 409, 'CRM_OPERAZIONE_NON_RIUSCITA'],
    ['token_non_valido', 401, 'TOKEN_NON_VALIDO'],
  ])('traduce l’esito RPC %s e limita la risposta ai soli campi pubblici', async (risultato, stato, codice) => {
    h.rpc.mockReturnValueOnce(esito({ ...dati(), esito: risultato, genitore: 'Famiglia Sintetica' }))
    const r = await chiama()
    expect(r.status).toBe(stato)
    expect(await r.json()).toEqual({ error: expect.any(String), codice })
    if (stato === 401) expect(r.headers.get('www-authenticate')).toBe('Bearer')
  })

  it.each(['40P01', '40001'])('errore Postgres %s: 409 riprovabile, log warn col solo codice', async (code) => {
    h.rpc.mockReturnValueOnce({ data: null, error: { code, message: 'Famiglia Sintetica', details: 'Nota privata sintetica' } })
    const r = await chiama()
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
    const error = { code, message: 'Famiglia Sintetica', details: 'Nota privata sintetica' }
    if (dove === 'registro') h.errori.crm_ai_richieste = error
    else h.rpc.mockReturnValueOnce({ data: null, error })
    const r = await chiama()
    expect(r.status).toBe(stato)
    const risposta = await r.json()
    expect(risposta).toEqual({ error: expect.any(String), codice })
    nessunNomeIn([risposta, h.logErrore.mock.calls, h.logEvento.mock.calls], DATI_RISERVATI)
    if (dove === 'registro') expect(h.rpc).not.toHaveBeenCalled()
  })

  it('un esito inatteso della RPC è un 500 registrato senza dati grezzi', async () => {
    h.rpc.mockReturnValueOnce(esito({ esito: 'Nota privata sintetica' }))
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: expect.any(String), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 500 }), new Error('Esito inatteso da crm_ai_conferma'))
  })

  it('registrata con id diverso da quello richiesto è un esito illeggibile (500)', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ appuntamento_id: '40000000-0000-4000-8000-0000000000ff' })))
    const r = await chiama()
    expect(r.status).toBe(500)
  })
})
