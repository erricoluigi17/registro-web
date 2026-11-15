import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/crm/ai/prenotazioni/[id]/sposta/route'
import { improntaCorpo } from '@/lib/crm/ai/idempotenza'
import type { NotificaEventoParams } from '@/lib/notifiche/triggers'
import { INTEGRAZIONE_A, INTEGRAZIONE_B, TOKEN_B, accendiAi, integrazioniFinte, nessunNomeIn, richiestaAi } from '../fixtures/crm-ai'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type RispostaRpc, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  lette: [] as string[],
  scritture: [] as Scrittura[],
  rpc: vi.fn<(args: Riga) => RispostaRpc | Promise<RispostaRpc>>(),
  notifica: vi.fn<(supabase: unknown, parametri: NotificaEventoParams) => Promise<void>>(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db, h.lette, {
    errori: h.errori,
    scritture: h.scritture,
    rpc: { crm_ai_sposta: h.rpc },
  }),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: async () => ({ ok: true, remaining: 59, retryAfterMs: 0 }),
  rateLimitLocale: () => ({ ok: true, remaining: 299, retryAfterMs: 0 }),
  clientIp: () => '203.0.113.1',
}))
vi.mock('@/lib/notifiche/triggers', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/notifiche/triggers')>()),
  notificaEvento: h.notifica,
}))
vi.mock('@/lib/logging/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
  logOk: h.logOk,
}))

const U1 = '20000000-0000-4000-8000-000000000001'
const U2 = '20000000-0000-4000-8000-000000000002'
const U_B = '20000000-0000-4000-8000-00000000000b'
const VISITA = '40000000-0000-4000-8000-000000000001'
const SCHEDA = '30000000-0000-4000-8000-000000000001'
const INIZIO = '2026-11-17T08:00:00.000Z'
const FINE = '2026-11-17T08:45:00.000Z'
const FINE_BREVE = '2026-11-17T08:30:00.000Z'
const CHIAVE = 'sposta-0001-a'
const LETTURE_GATE = ['crm_integrazioni', 'crm_integrazioni']
const DATI_RISERVATI = ['Nota privata sintetica', 'Famiglia Sintetica', '333 000 0001']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T07:00:00.000Z'))
  accendiAi([SEDE_A, SEDE_B])
  vi.clearAllMocks()
  h.rpc.mockReset().mockImplementation(() => { throw new Error('RPC non preparata dal test') })
  h.notifica.mockReset().mockResolvedValue(undefined)
  h.errori = {}
  h.lette = []
  h.scritture = []
  h.db = {
    crm_integrazioni: integrazioniFinte(),
    crm_ai_richieste: [],
    utenti: [
      { id: U2, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: U1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: U_B, nome: 'Marta', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
    ],
    utenti_scuole: [],
    crm_servizi_sede: [],
    crm_schede: [],
    crm_bambini: [],
    crm_appuntamenti: [],
    crm_settimane: [],
    crm_fasce: [],
    crm_indisponibilita: [],
    crm_eventi: [],
    crm_azioni: [],
  }
  programma(null)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function programma(utenteId: string | null, fascia: Riga = {}, sede = SEDE_A) {
  const id = `s-${h.db.crm_settimane.length + 1}`
  h.db.crm_settimane.push({ id, scuola_id: sede, utente_id: utenteId, settimana: '2026-11-16' })
  h.db.crm_fasce.push({
    id: `${id}-f`, scuola_id: sede, settimana_id: id,
    giorno_settimana: 2, ora_inizio: '09:00:00', ora_fine: '10:30:00', durata_slot_min: 45, ...fascia,
  })
}

const dati = (extra: Riga = {}, esitoSql = 'spostata'): Riga => ({
  esito: esitoSql, appuntamento_id: VISITA, inizio: '2026-11-17T08:00:00+00:00', fine: '2026-11-17T08:45:00+00:00',
  scheda_id: SCHEDA, assegnata_a: U1, assegnata_prima: U1, ...extra,
})
const successo = { id: VISITA, inizio: INIZIO, fine: FINE, schedaId: SCHEDA, invariata: false, ripetuta: false }
const esito = (data: Riga): RispostaRpc => ({ data, error: null })
const corpo = (extra: Riga = {}) => ({ sede: SEDE_A, inizio: INIZIO, fine: FINE, ...extra })
const richiesta = (
  extra: Riga = {},
  { token, chiave = CHIAVE, id = VISITA }: { token?: string | null; chiave?: string | null; id?: string } = {},
) => richiestaAi(`/api/crm/ai/prenotazioni/${id}/sposta`, {
  metodo: 'POST', corpo: corpo(extra), token, chiave: chiave ?? undefined,
})
const chiama = (...args: Parameters<typeof richiesta>) =>
  POST(richiesta(...args), { params: Promise.resolve({ id: args[1]?.id ?? VISITA }) })

function registra(impronta: unknown, risposta: Riga | null, extra: Riga = {}) {
  h.db.crm_ai_richieste.push({
    scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, chiave: CHIAVE, operazione: 'sposta',
    impronta, risposta, ...extra,
  })
}

describe('POST /api/crm/ai/prenotazioni/{id}/sposta', () => {
  it('interruttore spento: 404 senza toccare il database', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const req = richiesta({ fine: null })
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
    expect(h.notifica).not.toHaveBeenCalled()
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
    ['inizio senza fuso', { inizio: '2026-11-17T09:00' }, CHIAVE],
    ['inizio con frazione non rappresentabile', { inizio: '2026-11-17T08:00:00.000001Z' }, CHIAVE],
    ['fine mancante', { fine: undefined }, CHIAVE],
    ['fine precedente', { fine: '2026-11-17T07:55:00.000Z' }, CHIAVE],
    ['fine uguale', { fine: INIZIO }, CHIAVE],
    ['sede non UUID', { sede: 'x' }, CHIAVE],
  ])('validazione: %s → 400 senza accesso al CRM', async (_caso, campi, chiave) => {
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

  it('spostata: 200, nessun cambio di persona, nessun avviso', async () => {
    h.rpc.mockReturnValueOnce(esito(dati()))
    const r = await chiama()
    expect(r.status).toBe(200)
    const risposta = await r.json()
    expect(risposta).toEqual(successo)
    expect(h.notifica).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'info', expect.objectContaining({
      esito: 'ai-visita-spostata', scuola_id: SEDE_A, entita_id: VISITA,
    }))
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], DATI_RISERVATI)
  })

  it('cambio di persona: una notifica alla nuova persona', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ assegnata_a: U2, assegnata_prima: U1 })))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(successo)
    expect(h.notifica).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      tipo: 'crm_visita_assegnata', scuolaId: SEDE_A, utenteIds: [U2], entitaId: VISITA,
      corpo: 'martedì 17 novembre, ore 09:00',
    }))
  })

  it('la visita resta spostata se l’avviso fallisce', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ assegnata_a: U2 })))
    h.notifica.mockRejectedValueOnce({ code: 'XX000' })
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(successo)
  })

  it('replay (ripetuta dalla RPC): ripetuta true e nessuna seconda notifica', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ assegnata_a: U2, ripetuta: true })))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, ripetuta: true })
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('invariata: 200 con invariata true e nessun avviso', async () => {
    h.rpc.mockReturnValueOnce(esito({ ...dati(), esito: 'invariata', assegnata_prima: undefined }))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, invariata: true })
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('gli argomenti passati all’rpc: p_inizio ISO, p_durata_min dalla coppia, p_candidati dall’agenda', async () => {
    h.rpc.mockReturnValueOnce(esito(dati()))
    await chiama({ inizio: '2026-11-17T09:00:00+01:00', fine: '2026-11-17T09:45:00.000+01:00' })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({
      p_integrazione_id: INTEGRAZIONE_A, p_scuola_id: SEDE_A, p_chiave: CHIAVE,
      p_impronta: improntaCorpo({ operazione: 'sposta', id: VISITA, sede: SEDE_A, inizio: INIZIO, fine: FINE }),
      p_appuntamento_id: VISITA, p_inizio: INIZIO, p_durata_min: 45, p_candidati: [U1, U2],
    })
    expect(h.lette).toContain('crm_appuntamenti')
  })

  it('l’impronta comprende operazione e id: un altro id con lo stesso corpo ha un’impronta diversa', async () => {
    h.rpc.mockReturnValue(esito(dati()))
    await chiama()
    await chiama({}, { id: '40000000-0000-4000-8000-000000000002' })
    const [a, b] = h.rpc.mock.calls.map(([argomenti]) => argomenti.p_impronta)
    expect(a).not.toBe(b)
  })

  it('un id maiuscolo è passato minuscolo', async () => {
    h.rpc.mockReturnValueOnce(esito(dati()))
    await chiama({}, { id: VISITA.toUpperCase() })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_appuntamento_id: VISITA }))
  })

  it('una durata diversa usa la coppia scelta', async () => {
    h.db.crm_fasce = []
    h.db.crm_settimane = []
    programma(U1)
    programma(U2, { durata_slot_min: 30 })
    h.rpc.mockReturnValueOnce(esito(dati({ fine: FINE_BREVE, assegnata_a: U2 })))
    const r = await chiama({ fine: FINE_BREVE })
    expect(r.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_durata_min: 30, p_candidati: [U2] }))
  })

  it('se il nuovo orario si sovrappone alla visita stessa, i candidati vengono dalla griglia in fascia', async () => {
    for (const persona of [U1, U2]) {
      h.db.crm_appuntamenti.push({
        scuola_id: SEDE_A, scheda_id: SCHEDA, inizio: INIZIO, fine: FINE,
        durata_min: 45, assegnata_a: persona, stato: 'in_programma',
      })
    }
    h.rpc.mockReturnValueOnce(esito(dati()))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_candidati: [U1, U2], p_durata_min: 45 }))
  })

  it.each([
    ['coppia non offerta', { fine: '2026-11-17T08:35:00.000Z' }],
    ['fuori dalla fascia', { inizio: '2026-11-17T14:00:00.000Z', fine: '2026-11-17T14:45:00.000Z' }],
  ])('nessuna coppia (%s): 422 FUORI_DISPONIBILITA senza rpc', async (_caso, campi) => {
    const r = await chiama(campi)
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'FUORI_DISPONIBILITA' })
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('la stessa chiave con impronta diversa: 422 CHIAVE_RIUSATA prima dell’agenda', async () => {
    registra('f'.repeat(64), dati())
    const r = await chiama()
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'CHIAVE_RIUSATA' })
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('una chiave già usata per un’altra operazione ha un’altra impronta: CHIAVE_RIUSATA', async () => {
    registra(improntaCorpo({ operazione: 'prenota', sede: SEDE_A }), dati(), { operazione: 'prenota' })
    const r = await chiama()
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'CHIAVE_RIUSATA' })
  })

  it('risposta registrata: la ripete con ripetuta true, senza agenda, rpc o notifica', async () => {
    registra(improntaCorpo({ operazione: 'sposta', id: VISITA, sede: SEDE_A, inizio: INIZIO, fine: FINE }),
      dati({ assegnata_a: U2 }))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, ripetuta: true })
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('riga di registro ancora aperta: la RPC decide con candidati vuoti', async () => {
    registra(improntaCorpo({ operazione: 'sposta', id: VISITA, sede: SEDE_A, inizio: INIZIO, fine: FINE }), null)
    h.rpc.mockReturnValueOnce(esito({ esito: 'in_corso' }))
    const r = await chiama()
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_candidati: [], p_durata_min: 0 }))
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
    ['slot_occupato', 409, 'SLOT_OCCUPATO'],
    ['fuori_disponibilita', 422, 'FUORI_DISPONIBILITA'],
    ['chiave_riusata', 422, 'CHIAVE_RIUSATA'],
    ['in_corso', 409, 'CRM_OPERAZIONE_NON_RIUSCITA'],
    ['token_non_valido', 401, 'TOKEN_NON_VALIDO'],
  ])('traduce l’esito RPC %s e limita la risposta ai soli campi pubblici', async (risultato, stato, codice) => {
    h.rpc.mockReturnValueOnce(esito({ ...dati(), esito: risultato, genitore: 'Famiglia Sintetica' }))
    const r = await chiama()
    expect(r.status).toBe(stato)
    expect(await r.json()).toEqual({ error: expect.any(String), codice })
    if (stato === 401) expect(r.headers.get('www-authenticate')).toBe('Bearer')
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it.each(['40P01', '40001'])('errore Postgres %s (deadlock o serializzazione): 409 riprovabile, log warn col solo codice', async (code) => {
    h.rpc.mockReturnValueOnce({ data: null, error: { code, message: 'Famiglia Sintetica', details: 'Nota privata sintetica' } })
    const r = await chiama()
    expect(r.status).toBe(409)
    const risposta = await r.json()
    expect(risposta).toEqual({ error: expect.any(String), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'warn', expect.objectContaining({ scuola_id: SEDE_A }), { code })
    expect(h.logErrore).not.toHaveBeenCalled()
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], DATI_RISERVATI)
    expect(h.notifica).not.toHaveBeenCalled()
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
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 500 }), new Error('Esito inatteso da crm_ai_sposta'))
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('spostata con id diverso da quello richiesto è un esito illeggibile (500)', async () => {
    h.rpc.mockReturnValueOnce(esito(dati({ appuntamento_id: '40000000-0000-4000-8000-0000000000ff' })))
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(h.notifica).not.toHaveBeenCalled()
  })
})
