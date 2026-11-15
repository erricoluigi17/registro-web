import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as NON_VENUTE } from '@/app/api/crm/ai/prenotazioni/non-venute/route'
import { accendiAi, integrazioniFinte, nessunNomeIn, richiestaAi, TOKEN_B, tokenAttivoFinto } from '../fixtures/crm-ai'
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
const TEL_NORM = '3330000001'
const TEL_NORM2 = '3330000002'
const NOME_GENITORE = 'Famiglia Prova'
const NOTA = 'Nota fittizia riservata'
const RIASSUNTO = 'Riassunto riservato della conversazione'
const SEGNATA = '2026-11-15T10:00:00.000Z'
const SEGNATA_DOPO = '2026-11-15T11:00:00.000Z'
const DOPO = '2026-11-15T00:00:00.000Z'
const INIZIO = '2026-11-14T08:00:00.000Z'
const id = (n: number) => '40000000-0000-4000-8000-' + String(n).padStart(12, '0')

const scheda = (campi: Riga = {}): Riga => ({
  id: S1, scuola_id: SEDE_A, genitore_nome: NOME_GENITORE, telefono1: '333 000 0001', telefoni_norm: [TEL_NORM],
  anonimizzata_il: null, routine: NOTA, ai_riassunto: RIASSUNTO, non_contattare: false, ...campi,
})
const visita = (campi: Riga = {}): Riga => ({
  id: id(1), scuola_id: SEDE_A, scheda_id: S1, inizio: INIZIO, fine: '2026-11-14T08:45:00.000Z',
  stato: 'non_presentato', segnato_il: SEGNATA, nota: NOTA, fissato_via: 'segreteria', integrazione_id: null, ...campi,
})

const nonVenute = (campi: Record<string, string> = {}, token?: string | null) =>
  NON_VENUTE(richiestaAi('/api/crm/ai/prenotazioni/non-venute?' + new URLSearchParams({ sede: SEDE_A, dopo: DOPO, ...campi }), { token }))

beforeEach(() => {
  accendiAi([SEDE_A, SEDE_B])
  h.errori = {}
  h.lette = []
  h.tokenAttivo.mockReset().mockImplementation(tokenAttivoFinto(() => h.db))
  h.logErrore.mockClear()
  h.logEvento.mockClear()
  h.db = { crm_integrazioni: integrazioniFinte(), crm_schede: [], crm_appuntamenti: [] }
})
afterEach(() => vi.unstubAllEnvs())

describe('visite non venute', () => {
  it('dà solo le non_presentato della sede della chiave, col telefono e senza dati della famiglia', async () => {
    h.db.crm_schede.push(scheda(), scheda({ id: S2, telefoni_norm: [TEL_NORM2, '3330000009'], non_contattare: true }),
      scheda({ id: '30000000-0000-4000-8000-00000000000b', scuola_id: SEDE_B }))
    h.db.crm_appuntamenti.push(
      visita({ id: id(2), scheda_id: S2, segnato_il: SEGNATA_DOPO }),
      visita(),
      visita({ id: id(3), stato: 'svolto' }),
      visita({ id: id(4), stato: 'in_programma' }),
      visita({ id: id(5), stato: 'annullato' }),
      visita({ id: id(6), scuola_id: SEDE_B, scheda_id: '30000000-0000-4000-8000-00000000000b' }),
      visita({ id: id(7), segnato_il: null }),
    )
    const r = await nonVenute()
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const j = await r.json()
    nessunNomeIn(j, [NOME_GENITORE, NOTA, RIASSUNTO, '333 000 0001', '3330000009', 'fine'])
    expect(j).toEqual({
      prenotazioni: [
        { id: id(1), schedaId: S1, inizio: INIZIO, segnataIl: SEGNATA, telefono: TEL_NORM, nonContattare: false },
        { id: id(2), schedaId: S2, inizio: INIZIO, segnataIl: SEGNATA_DOPO, telefono: TEL_NORM2, nonContattare: true },
      ],
      prossimoDopo: SEGNATA_DOPO,
      prossimoDopoId: id(2),
    })
  })

  it('una scheda anonimizzata ha telefono null', async () => {
    h.db.crm_schede.push(scheda({ id: S_ANON, anonimizzata_il: SEGNATA }))
    h.db.crm_appuntamenti.push(visita({ scheda_id: S_ANON }))
    const j = await (await nonVenute()).json()
    expect(j.prenotazioni[0]).toMatchObject({ schedaId: S_ANON, telefono: null })
    nessunNomeIn(j, [TEL_NORM])
  })

  it('una scheda non trovata ha telefono null e nonContattare true (nel dubbio non si scrive)', async () => {
    h.db.crm_appuntamenti.push(visita({ scheda_id: S_ANON }))
    const j = await (await nonVenute()).json()
    expect(j.prenotazioni[0]).toMatchObject({ schedaId: S_ANON, telefono: null, nonContattare: true })
  })

  it('pagina vuota: cursori null e nessuna scheda letta; l’istante di partenza è escluso', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(visita())
    expect(await (await nonVenute({ dopo: SEGNATA })).json()).toEqual({ prenotazioni: [], prossimoDopo: null, prossimoDopoId: null })
    expect(h.lette).not.toContain('crm_schede')
  })

  it('riprende per ID oltre il limite a pari istante, conservando fuso e microsecondi', async () => {
    const pari = '2026-11-15T10:00:00.123456+01:00'
    const successivo = '2026-11-15T10:00:00.123457+01:00'
    const attesi = Array.from({ length: 105 }, (_, i) => id(i + 1))
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(
      visita({ id: id(0), segnato_il: successivo }),
      ...attesi.toReversed().map((vid) => visita({ id: vid, segnato_il: pari })),
    )

    const pagina1 = await (await nonVenute({ dopo: '2026-11-15T10:00:00.123455+01:00' })).json()
    expect(pagina1.prenotazioni.map((p: { id: string }) => p.id)).toEqual(attesi.slice(0, 100))
    expect(pagina1.prossimoDopo).toBe(pari)
    expect(pagina1.prossimoDopoId).toBe(id(100))

    const pagina2 = await (await nonVenute({ dopo: pagina1.prossimoDopo, dopoId: pagina1.prossimoDopoId })).json()
    expect(pagina2.prenotazioni.map((p: { id: string }) => p.id)).toEqual([...attesi.slice(100), id(0)])
    expect(pagina2.prossimoDopo).toBe(successivo)
    expect(pagina2.prossimoDopoId).toBe(id(0))
    expect(await (await nonVenute({ dopo: pagina2.prossimoDopo, dopoId: pagina2.prossimoDopoId })).json()).toEqual({
      prenotazioni: [], prossimoDopo: null, prossimoDopoId: null,
    })
  })

  it.each([
    { dopo: '2026-11-15T10:00' },
    { dopo: SEGNATA + ',id.not.is.null', dopoId: S1 },
    { dopoId: S1 + '),id.not.is.null' },
    { [NOTA]: 'privato' },
  ] as Record<string, string>[])('respinge query fuori schema prima di leggere le visite', async (campi) => {
    const r = await nonVenute(campi)
    expect(r.status).toBe(400)
    nessunNomeIn(await r.json(), [NOTA, 'id.not.is.null'])
    expect(h.lette).not.toContain('crm_appuntamenti')
  })

  it('a interruttore spento e senza chiave risponde prima del DB', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    expect((await nonVenute({ dopo: 'senza-fuso' })).status).toBe(404)
    vi.stubEnv('CRM_AI_ATTIVO', '1')
    expect((await nonVenute({ dopo: 'senza-fuso' }, null)).status).toBe(401)
    expect(h.lette).toEqual([])
  })

  it('la chiave di un’altra sede non legge niente', async () => {
    h.db.crm_appuntamenti.push(visita())
    expect((await nonVenute({}, TOKEN_B)).status).toBe(403)
    expect(h.lette).not.toContain('crm_appuntamenti')
  })

  it('chiave revocata dopo il gate: 401 e nessuna visita letta', async () => {
    h.db.crm_appuntamenti.push(visita())
    h.tokenAttivo.mockResolvedValueOnce({ data: false, error: null })
    const r = await nonVenute()
    expect(r.status).toBe(401)
    expect(h.lette).not.toContain('crm_appuntamenti')
  })

  it('un errore di lettura non riporta il testo grezzo del DB', async () => {
    h.errori.crm_appuntamenti = { code: '42501', message: NOME_GENITORE, details: TEL_NORM, hint: NOTA }
    const r = await nonVenute()
    expect(r.status).toBe(500)
    nessunNomeIn(await r.json(), [NOME_GENITORE, TEL_NORM, NOTA])
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ operazione: 'crm/ai/prenotazioni/non-venute' }), { code: '42501' })
  })

  it('una colonna della migrazione mancante nelle schede (42703) risponde 503 senza testo grezzo', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(visita())
    h.errori.crm_schede = { code: '42703', message: NOME_GENITORE, details: TEL_NORM, hint: NOTA }
    const r = await nonVenute()
    expect(r.status).toBe(503)
    const j = await r.json()
    expect(j).toMatchObject({ codice: 'CRM_NON_INSTALLATO' })
    nessunNomeIn([j, h.logErrore.mock.calls, h.logEvento.mock.calls], [NOME_GENITORE, TEL_NORM, NOTA])
  })

  it('i log non contengono telefoni', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_appuntamenti.push(visita())
    await nonVenute()
    nessunNomeIn([h.logEvento.mock.calls, h.logErrore.mock.calls], [TEL_NORM, '333 000 0001', NOME_GENITORE])
  })
})
