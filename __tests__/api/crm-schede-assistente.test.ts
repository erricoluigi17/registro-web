import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · le colonne della vendita sulla scheda (15/11/2026): «non contattare», stato, riassunto.
 *
 * Le tre cose che l'assistente della vendita scrive sulla famiglia devono essere visibili e correggibili dalla
 * segreteria. Qui si misura il lato del SERVER:
 *  · `PATCH /schede/[id]` con `nonContattare` (vero/falso): stessa sede, stesso gate, stesso storico di prima, e nello
 *    storico i soli nomi dei campi più un booleano;
 *  · `GET /schede` porta `non_contattare` e `prossima_visita_confermata` in ogni riga;
 *  · `GET /schede/[id]` porta le colonne nuove (arrivano con la `select('*')`);
 *  · PRIMA DELLA MIGRAZIONE (colonne assenti) l'elenco e il dettaglio funzionano lo stesso, con un `warn` nel log, e
 *    il solo `PATCH` di «non contattare» risponde 503.
 *
 * Il database è il FINTO di `crm-schede.test.ts`: le righe senza le chiavi nuove sono lo stato «prima della migrazione»,
 * e il caso «la `select` nomina una colonna che non c'è» (`42703`) si simula con un osservatore sul client.
 *
 * Dati di prova soltanto: «Famiglia Prova», `333 000 0001`, un riassunto inventato.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    sedePropria: null as string | null,
    db: {} as Record<string, Record<string, unknown>[]>,
    scritture: [] as unknown[],
    letture: [] as string[],
    errori: {} as Record<string, unknown>,
    /** Le `select` che nominano una colonna della vendita rispondono `42703`, come un database non ancora migrato. */
    senzaColonne: false,
    selectColonneVendita: 0,
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    logOk: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
        if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
        return Promise.resolve({ user: { id: USER, role: h.ruolo, scuola_id: h.sedePropria } })
    },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return {
        ...vero,
        logEvento: (...a: Parameters<typeof vero.logEvento>) => {
            h.logEvento(...a)
            return vero.logEvento(...a)
        },
        logErrore: (...a: Parameters<typeof vero.logErrore>) => {
            h.logErrore(...a)
            return vero.logErrore(...a)
        },
        logOk: (...a: Parameters<typeof vero.logOk>) => {
            h.logOk(...a)
            return vero.logOk(...a)
        },
    }
})

/** Una risposta PostgREST d'errore che resta in piedi a qualunque catena di filtri: `.in().eq().order()…` e poi `await`. */
function rispostaColonnaAssente() {
    const esito = { data: null, error: { code: '42703', message: 'column does not exist' }, count: null, status: 400, statusText: 'Bad Request' }
    const catena: unknown = new Proxy(function () {}, {
        get: (_t, prop) => (prop === 'then' ? (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito).then(ok, ko) : catena),
        apply: () => catena,
    })
    return catena
}

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        const vero = creaFintoSupabase(h.db as DBFinto, h.letture, {
            scritture: h.scritture as Scrittura[],
            errori: h.errori as Record<string, ErrorePostgrest>,
            rpc: {
                anno_di: ({ p_scuola, p_giorno }) => {
                    const riga = (h.db.anni_sede ?? []).find(
                        (r) => r.scuola_id === p_scuola && String(r.inizio) <= String(p_giorno) && String(p_giorno) <= String(r.fine),
                    )
                    return { data: riga ? riga.anno_id : null, error: null }
                },
            },
        })
        return new Proxy(vero, {
            get(target, prop, ricevitore) {
                if (prop !== 'from') return Reflect.get(target, prop, ricevitore)
                return (tabella: string) => {
                    const costruttore = target.from(tabella)
                    return new Proxy(costruttore, {
                        get(t, metodo) {
                            const valore = (t as unknown as Record<string | symbol, unknown>)[metodo]
                            if (metodo !== 'select' || typeof valore !== 'function') return valore
                            return (...argomenti: unknown[]) => {
                                if (/non_contattare|promemoria_conferma/.test(String(argomenti[0] ?? ''))) {
                                    h.selectColonneVendita++
                                    if (h.senzaColonne) return rispostaColonnaAssente()
                                }
                                return (valore as (...a: unknown[]) => unknown).apply(t, argomenti)
                            }
                        },
                    })
                }
            },
        })
    },
}))

import { GET as GET_ELENCO } from '@/app/api/admin/crm/schede/route'
import { GET as GET_DETTAGLIO, PATCH as PATCH_SCHEDA } from '@/app/api/admin/crm/schede/[id]/route'

const USER = '20000000-0000-4000-8000-0000000000aa'
const SEG_A = '20000000-0000-4000-8000-00000000000a'
const S1 = '30000000-0000-4000-8000-000000000001' // sede A, rifiuto acceso, stato e riassunto
const S2 = '30000000-0000-4000-8000-000000000002' // sede A, rifiuto spento, mai toccata dall'assistente
const S3 = '30000000-0000-4000-8000-000000000003' // sede A, una visita confermata e una no
const SB = '30000000-0000-4000-8000-0000000000b1' // sede B

const RIASSUNTO = 'Riassunto di prova: la famiglia preferisce il pomeriggio.\nSecondo capoverso di prova.'
const FUTURO_1 = '2099-01-10T10:00:00.000Z'
const FUTURO_2 = '2099-02-10T10:00:00.000Z'

const scheda = (id: string, sede: string, extra: Record<string, unknown> = {}) => ({
    id,
    scuola_id: sede,
    genitore_nome: 'Famiglia Prova',
    telefono1: '333 000 0001',
    telefono2: null,
    email1: null,
    email2: null,
    telefoni_norm: ['3330000001'],
    email_norm: [],
    origine: 'telefonata',
    routine: null,
    paura: null,
    desiderio: null,
    domanda_da_associare: null,
    creato_da: SEG_A,
    creato_via: 'segreteria',
    creata_il: '2026-10-01T09:00:00.000Z',
    aggiornata_il: '2026-10-01T09:00:00.000Z',
    anonimizzata_il: null,
    ...extra,
})

/** Le colonne che aggiunge la migrazione del 15/11/2026, a riposo. */
const VENDITA_A_RIPOSO = { ai_stato: null, ai_riassunto: null, ai_aggiornata_il: null, non_contattare: false, non_contattare_il: null }

const richiesta = (metodo: string, percorso: string, corpo?: unknown) =>
    new NextRequest(`http://localhost${percorso}`, {
        method: metodo,
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { 'content-type': 'application/json' } }),
    })
const conId = (id: string) => ({ params: Promise.resolve({ id }) })
const elenco = (query = `?scuolaId=${SEDE_A}`) => GET_ELENCO(richiesta('GET', `/api/admin/crm/schede${query}`))
const apri = (id: string) => GET_DETTAGLIO(richiesta('GET', `/api/admin/crm/schede/${id}`), conId(id))
const modifica = (id: string, corpo: unknown) => PATCH_SCHEDA(richiesta('PATCH', `/api/admin/crm/schede/${id}`, corpo), conId(id))

const scritto = (tabella: string, operazione: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const eventiScritti = () => scritto('crm_eventi', 'insert').flatMap((s) => s.valori)
const rigaScheda = (id: string) => h.db.crm_schede.find((s) => s.id === id)!
const righe = async (res: Response) => (await res.json()).data as Record<string, unknown>[]
const tutteLeChiamateDiLog = () => JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls, ...h.logOk.mock.calls])

/** Porta il database «a dopo la migrazione»: le tre schede ricevono le colonne nuove. */
function dopoLaMigrazione() {
    Object.assign(rigaScheda(S1), VENDITA_A_RIPOSO, {
        non_contattare: true,
        non_contattare_il: '2026-11-10T08:00:00.000Z',
        ai_stato: 'non_contattare',
        ai_riassunto: RIASSUNTO,
        ai_aggiornata_il: '2026-11-10T08:00:00.000Z',
    })
    Object.assign(rigaScheda(S2), VENDITA_A_RIPOSO)
    Object.assign(rigaScheda(S3), VENDITA_A_RIPOSO)
    Object.assign(rigaScheda(SB), VENDITA_A_RIPOSO)
    for (const a of h.db.crm_appuntamenti) Object.assign(a, { promemoria_conferma: null, promemoria_conferma_il: null })
    Object.assign(h.db.crm_appuntamenti.find((a) => a.id === 'v3a')!, { promemoria_conferma: false, promemoria_conferma_il: '2026-11-12T09:00:00.000Z' })
    Object.assign(h.db.crm_appuntamenti.find((a) => a.id === 'v3b')!, { promemoria_conferma: true, promemoria_conferma_il: '2026-11-13T09:00:00.000Z' })
}

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.sedePropria = SEDE_A
    h.scritture = []
    h.letture = []
    h.errori = {}
    h.senzaColonne = false
    h.selectColonneVendita = 0
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.logOk.mockClear()
    h.db = {
        anni_sede: [],
        utenti: [
            { id: SEG_A, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
        ],
        utenti_scuole: [],
        // PRIMA della migrazione: nessuna riga porta le colonne della vendita.
        crm_schede: [
            scheda(S1, SEDE_A, { genitore_nome: 'Famiglia Prova Uno', creata_il: '2026-10-01T09:00:00.000Z' }),
            scheda(S2, SEDE_A, { genitore_nome: 'Famiglia Prova Due', telefono1: '333 000 0002', telefoni_norm: ['3330000002'], creata_il: '2026-10-15T09:00:00.000Z' }),
            scheda(S3, SEDE_A, { genitore_nome: 'Famiglia Prova Tre', telefono1: '333 000 0003', telefoni_norm: ['3330000003'], creata_il: '2026-10-20T09:00:00.000Z' }),
            scheda(SB, SEDE_B, { genitore_nome: 'Famiglia Prova Uno B', creata_il: '2026-10-05T09:00:00.000Z' }),
        ],
        crm_bambini: [],
        crm_appuntamenti: [
            { id: 'v1', scuola_id: SEDE_A, scheda_id: S1, inizio: FUTURO_1, fine: '2099-01-10T10:45:00.000Z', assegnata_a: SEG_A, svolto_da: null, stato: 'in_programma' },
            // S3: la prossima visita è la PRIMA (non confermata); la seconda, più in là, è confermata
            { id: 'v3a', scuola_id: SEDE_A, scheda_id: S3, inizio: FUTURO_1, fine: '2099-01-10T10:45:00.000Z', assegnata_a: SEG_A, svolto_da: null, stato: 'in_programma' },
            { id: 'v3b', scuola_id: SEDE_A, scheda_id: S3, inizio: FUTURO_2, fine: '2099-02-10T10:45:00.000Z', assegnata_a: SEG_A, svolto_da: null, stato: 'in_programma' },
        ],
        crm_azioni: [],
        crm_eventi: [{ id: 'e1', scuola_id: SEDE_A, scheda_id: S1, tipo: 'creata', autore: SEG_A, autore_via: 'segreteria', dati: {}, testo: null, creato_il: '2026-10-01T09:00:00.000Z' }],
    }
})

// ── PATCH · «non contattare» ─────────────────────────────────────────────────

describe('PATCH /schede/[id] · nonContattare', () => {
    beforeEach(() => dopoLaMigrazione())

    it('toglierlo: la colonna torna falsa, l’istante si azzera, lo storico dice «acceso: false» e nient’altro', async () => {
        const res = await modifica(S1, { nonContattare: false })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ id: S1, modificata: true })
        expect(rigaScheda(S1)).toMatchObject({ non_contattare: false, non_contattare_il: null })
        // lo stato e il riassunto dell'assistente non si toccano
        expect(rigaScheda(S1)).toMatchObject({ ai_stato: 'non_contattare', ai_riassunto: RIASSUNTO })

        const eventi = eventiScritti()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({ tipo: 'modificata', scheda_id: S1, scuola_id: SEDE_A, autore: USER, autore_via: 'segreteria' })
        expect(eventi[0].dati).toEqual({ campi: 'non_contattare', acceso: false })
        expect(eventi[0].testo ?? null).toBeNull()
    })

    it('rimetterlo: la colonna diventa vera, l’istante è quello di adesso, lo storico dice «acceso: true»', async () => {
        const prima = Date.now()
        const res = await modifica(S2, { nonContattare: true })
        expect(res.status).toBe(200)
        const riga = rigaScheda(S2)
        expect(riga.non_contattare).toBe(true)
        expect(Date.parse(riga.non_contattare_il as string)).toBeGreaterThanOrEqual(prima - 1000)
        expect(eventiScritti()[0].dati).toEqual({ campi: 'non_contattare', acceso: true })
    })

    it('se un istante c’era già (acceso da un’altra mano) resta il primo', async () => {
        Object.assign(rigaScheda(S2), { non_contattare: false, non_contattare_il: '2026-11-01T08:00:00.000Z' })
        await modifica(S2, { nonContattare: true })
        expect(rigaScheda(S2).non_contattare_il).toBe('2026-11-01T08:00:00.000Z')
    })

    it('già com’è: 200, niente scritto, niente storia', async () => {
        const res = await modifica(S1, { nonContattare: true })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ id: S1, modificata: false })
        expect(h.scritture).toHaveLength(0)
    })

    it('l’update porta scuola_id: la riga gemella di un’altra sede non si tocca', async () => {
        h.db.crm_schede.push(scheda(S2, SEDE_B, { ...VENDITA_A_RIPOSO }))
        await modifica(S2, { nonContattare: true })
        expect(h.db.crm_schede.find((s) => s.id === S2 && s.scuola_id === SEDE_A)!.non_contattare).toBe(true)
        expect(h.db.crm_schede.find((s) => s.id === S2 && s.scuola_id === SEDE_B)!.non_contattare).toBe(false)
    })

    it('insieme a un altro campo: due eventi, ciascuno con i suoi nomi di campo', async () => {
        const res = await modifica(S2, { routine: 'Gioca all’aperto', nonContattare: true })
        expect(res.status).toBe(200)
        expect(eventiScritti().map((e) => e.dati)).toEqual([{ campi: 'routine' }, { campi: 'non_contattare', acceso: true }])
        expect(JSON.stringify(eventiScritti())).not.toContain('aperto')
    })

    it('solo il resto del corpo cambia: nessun evento su «non contattare»', async () => {
        await modifica(S1, { routine: 'Gioca all’aperto', nonContattare: true })
        expect(eventiScritti().map((e) => e.dati)).toEqual([{ campi: 'routine' }])
        expect(rigaScheda(S1).non_contattare_il).toBe('2026-11-10T08:00:00.000Z')
    })

    it('il coordinatore e il genitore non entrano: 403, niente scritto', async () => {
        for (const ruolo of ['coordinator', 'educator', 'parent']) {
            h.ruolo = ruolo
            expect((await modifica(S1, { nonContattare: false })).status).toBe(403)
        }
        expect(h.scritture).toHaveLength(0)
    })

    it('la Direzione può, per le sole sedi che ha: una sede che non è sua è un 403', async () => {
        h.ruolo = 'admin'
        h.sedePropria = null
        h.db.utenti_scuole = [{ utente_id: USER, scuola_id: SEDE_A }]
        expect((await modifica(S1, { nonContattare: false })).status).toBe(200)
        expect(rigaScheda(S1).non_contattare).toBe(false)
        h.scritture = []
        expect((await modifica(SB, { nonContattare: true })).status).toBe(403)
        expect(h.scritture).toHaveLength(0)
    })

    it('scheda di un’altra sede → 403 e niente scritto; scheda inesistente → 404', async () => {
        expect((await modifica(SB, { nonContattare: true })).status).toBe(403)
        expect((await modifica('30000000-0000-4000-8000-0000000000ff', { nonContattare: true })).status).toBe(404)
        expect(h.scritture).toHaveLength(0)
    })

    it('un valore che non è vero o falso → 400', async () => {
        expect((await modifica(S1, { nonContattare: 'si' })).status).toBe(400)
        expect((await modifica(S1, { nonContattare: 1 })).status).toBe(400)
        expect((await modifica(S1, { nonContattare: null })).status).toBe(400)
        expect(h.scritture).toHaveLength(0)
    })

    it('guasto dell’update → 500, e nessun evento', async () => {
        h.errori = { 'crm_schede:update': { code: 'XX000' } }
        const res = await modifica(S1, { nonContattare: false })
        expect(res.status).toBe(500)
        expect(eventiScritti()).toHaveLength(0)
    })

    it('la colonna sparisce fra la lettura e l’update (42703) → 503 CRM_NON_INSTALLATO, e nessun evento', async () => {
        h.errori = { 'crm_schede:update': { code: '42703' } }
        const res = await modifica(S1, { nonContattare: false })
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
        expect(eventiScritti()).toHaveLength(0)
    })

    it('il riassunto non finisce in un log né nello storico', async () => {
        await modifica(S1, { nonContattare: false })
        await apri(S1)
        expect(tutteLeChiamateDiLog()).not.toContain('Riassunto di prova')
        expect(JSON.stringify(eventiScritti())).not.toContain('Riassunto di prova')
        expect(JSON.stringify(h.scritture.filter((s) => (s as Scrittura).tabella === 'crm_eventi'))).not.toContain('pomeriggio')
    })

    it('lascia una riga di log col solo esito e gli id', async () => {
        await modifica(S1, { nonContattare: false })
        const riga = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'non-contattare-tolto')
        expect(riga).toBeTruthy()
        expect(riga![2]).toMatchObject({ entita_id: S1, scuola_id: SEDE_A })
        await modifica(S2, { nonContattare: true })
        expect(h.logEvento.mock.calls.some((c) => (c[2] as { esito?: string })?.esito === 'non-contattare-acceso')).toBe(true)
    })
})

describe('PATCH /schede/[id] · nonContattare prima della migrazione', () => {
    it('le colonne non ci sono: 503 CRM_NON_INSTALLATO, niente scritto (nemmeno il resto del corpo), un warn nel log', async () => {
        const res = await modifica(S1, { nonContattare: true, routine: 'Gioca all’aperto' })
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
        expect(h.scritture).toHaveLength(0)
        expect(h.logEvento.mock.calls.some((c) => c[1] === 'warn' && (c[2] as { esito?: string })?.esito === 'colonne-vendita-assenti')).toBe(true)
    })

    it('la modifica di sempre, senza «non contattare», funziona come prima', async () => {
        const res = await modifica(S1, { routine: 'Gioca all’aperto' })
        expect(res.status).toBe(200)
        expect(rigaScheda(S1).routine).toBe('Gioca all’aperto')
        expect(eventiScritti().map((e) => e.dati)).toEqual([{ campi: 'routine' }])
    })
})

// ── GET /schede (elenco) ─────────────────────────────────────────────────────

describe('GET /schede · i segni dell’assistente', () => {
    it('ogni riga dice se la famiglia non va contattata e se la PROSSIMA visita è confermata', async () => {
        dopoLaMigrazione()
        const res = await elenco()
        expect(res.status).toBe(200)
        const per = Object.fromEntries((await righe(res)).map((r) => [r.id as string, r]))
        expect(per[S1]).toMatchObject({ non_contattare: true, prossima_visita_confermata: null })
        expect(per[S2]).toMatchObject({ non_contattare: false, prossima_visita: null, prossima_visita_confermata: null })
        // S3: la prima visita è «non confermata»; quella confermata è la seconda e non conta
        expect(per[S3]).toMatchObject({ non_contattare: false, prossima_visita: FUTURO_1, prossima_visita_confermata: false })
    })

    it('una visita confermata dalla famiglia è `true`', async () => {
        dopoLaMigrazione()
        Object.assign(h.db.crm_appuntamenti.find((a) => a.id === 'v1')!, { promemoria_conferma: true })
        const per = Object.fromEntries((await righe(await elenco())).map((r) => [r.id as string, r]))
        expect(per[S1].prossima_visita_confermata).toBe(true)
    })

    it('le righe della sede B non entrano, e il resto dell’elenco (bambini, visita, richiamo) è quello di prima', async () => {
        dopoLaMigrazione()
        const dati = await righe(await elenco())
        expect(dati.map((r) => r.id)).toEqual([S3, S2, S1])
        expect(dati[2]).toMatchObject({ genitore_nome: 'Famiglia Prova Uno', origine: 'telefonata', prossima_visita: FUTURO_1, prossima_azione: null })
    })

    it('PRIMA della migrazione (la select nomina colonne che non ci sono, 42703) l’elenco funziona lo stesso: stesse righe, segni spenti, un warn', async () => {
        h.senzaColonne = true
        const res = await elenco()
        expect(res.status).toBe(200)
        const dati = await righe(res)
        expect(dati.map((r) => r.id)).toEqual([S3, S2, S1])
        for (const r of dati) expect(r).toMatchObject({ non_contattare: false, prossima_visita_confermata: null })
        // la prossima visita c'è comunque: la lettura di ripiego non l'ha persa
        expect(dati.find((r) => r.id === S3)!.prossima_visita).toBe(FUTURO_1)
        const warn = h.logEvento.mock.calls.filter((c) => c[1] === 'warn' && (c[2] as { esito?: string })?.esito === 'colonne-vendita-assenti')
        expect(warn).toHaveLength(1)
        expect(h.logErrore).not.toHaveBeenCalled()
        expect(h.selectColonneVendita).toBeGreaterThan(0)
    })

    it('database senza colonne e righe senza chiavi (finto «a riposo»): segni spenti, 200', async () => {
        const dati = await righe(await elenco())
        for (const r of dati) expect(r).toMatchObject({ non_contattare: false, prossima_visita_confermata: null })
    })

    it('un guasto vero resta un guasto: 500 CRM_OPERAZIONE_NON_RIUSCITA, non un elenco senza segni', async () => {
        h.errori = { 'crm_schede:select': { code: '08006' } }
        const res = await elenco()
        expect(res.status).toBe(500)
    })

    it('un guasto vero anche dopo il ripiego: 500', async () => {
        h.senzaColonne = true
        h.errori = { 'crm_bambini:select': { code: '08006' } }
        expect((await elenco()).status).toBe(500)
    })

    it('la sede di un’altra segreteria resta un 403', async () => {
        const res = await elenco(`?scuolaId=${SEDE_B}`)
        expect(res.status).toBe(403)
    })
})

// ── GET /schede/[id] (dettaglio) ─────────────────────────────────────────────

describe('GET /schede/[id] · le colonne della vendita', () => {
    it('la scheda porta stato, riassunto, istante dell’aggiornamento e «non contattare»; la visita porta la conferma', async () => {
        dopoLaMigrazione()
        const res = await apri(S3)
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect(corpo.scheda).toMatchObject({ non_contattare: false, non_contattare_il: null, ai_stato: null, ai_riassunto: null })
        const conferme = Object.fromEntries(corpo.appuntamenti.map((a: Record<string, unknown>) => [a.id, [a.promemoria_conferma, a.promemoria_conferma_il]]))
        expect(conferme.v3a).toEqual([false, '2026-11-12T09:00:00.000Z'])
        expect(conferme.v3b).toEqual([true, '2026-11-13T09:00:00.000Z'])

        const uno = await (await apri(S1)).json()
        expect(uno.scheda).toMatchObject({ non_contattare: true, non_contattare_il: '2026-11-10T08:00:00.000Z', ai_stato: 'non_contattare', ai_riassunto: RIASSUNTO })
    })

    it('PRIMA della migrazione la scheda si apre come sempre, senza le chiavi nuove, e il caso va nel log a livello warn', async () => {
        const res = await apri(S1)
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect('non_contattare' in corpo.scheda).toBe(false)
        expect(corpo.appuntamenti).toHaveLength(1)
        expect(h.logEvento.mock.calls.some((c) => c[1] === 'warn' && (c[2] as { esito?: string })?.esito === 'colonne-vendita-assenti')).toBe(true)
        expect(h.logErrore).not.toHaveBeenCalled()
    })

    it('con le colonne al loro posto non c’è nessun warn', async () => {
        dopoLaMigrazione()
        await apri(S1)
        expect(h.logEvento.mock.calls.some((c) => (c[2] as { esito?: string })?.esito === 'colonne-vendita-assenti')).toBe(false)
    })

    it('il riassunto non esce nei log, e la scheda di un’altra sede è un 403', async () => {
        dopoLaMigrazione()
        await apri(S1)
        expect(tutteLeChiamateDiLog()).not.toContain('Riassunto di prova')
        expect((await apri(SB)).status).toBe(403)
    })
})
