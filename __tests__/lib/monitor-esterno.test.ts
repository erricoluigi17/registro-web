import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import worker, {
    CRON_BACKUP,
    LINK_GIRI_BACKUP,
    LINK_GIRI_CAMPANELLO,
    MINUTI_BATTITO,
    ORIGINE,
    REPO,
    URL_GIRI_CAMPANELLO,
    URL_VIVO,
    WORKFLOW,
    WORKFLOW_BACKUP,
    chiaveIdempotenza,
    giro,
    giroBackup,
    guardaUltimoGiro,
    lavoroDelCron,
    leggiVivo,
    suonaCampanello,
} from '../../monitor-esterno/worker.mjs'
import { TITOLO_DA_FUORI, mandaEmail } from '../../scripts/campanello/allarme.mjs'

/**
 * IL MONITOR ESTERNO (Worker di Cloudflare), con un `fetch` finto. Ogni caso forza un guasto e
 * pretende il verdetto: il vivo giù fa partire il campanello SUBITO, il battito ogni quarto d'ora lo
 * fa partire comunque, un rifiuto di GitHub finisce nel log con il suo corpo.
 */

const DISPATCH = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`
type Risposta = { status: number; testo?: string } | Error

function fetchFinto(per: Record<string, Risposta[]>) {
    const chiamate: { url: string; verbo?: string; corpo?: string; auth?: string; idem?: string }[] = []
    const indice: Record<string, number> = {}
    const impl = vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
        chiamate.push({
            url,
            verbo: init?.method,
            corpo: init?.body,
            auth: init?.headers?.Authorization,
            idem: init?.headers?.['Idempotency-Key'],
        })
        const seq = per[url]
        if (!seq) throw new Error(`fetch finto: URL non previsto ${url}`)
        const i = Math.min(indice[url] ?? 0, seq.length - 1)
        indice[url] = (indice[url] ?? 0) + 1
        const r = seq[i]
        if (r instanceof Error) throw r
        return { status: r.status, text: async () => r.testo ?? '' }
    })
    return { impl: impl as unknown as typeof fetch, chiamate, a: (u: string) => chiamate.filter((c) => c.url === u) }
}

const OK = { status: 200, testo: '{"stato":"ok"}' }
const GIU = { status: 503, testo: '{"stato":"down"}' }
const PARTITO = { status: 204 }
// Le 10:05 non sono un quarto d'ora; le 10:15 sì.
const FUORI_BATTITO = new Date('2026-10-19T10:05:00Z')
const SUL_BATTITO = new Date('2026-10-19T10:15:00Z')
const RESEND = 'https://api.resend.com/emails'
const ACCETTATA = { status: 200, testo: '{"id":"e1"}' }
type Segreti = { chiaveResend?: string; destinatari?: string }
const SEGRETI: Segreti = { chiaveResend: 're_prova', destinatari: 'a@esempio.test,b@esempio.test' }
const WF_BACKUP = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_BACKUP}`
const DISPATCH_BACKUP = `${WF_BACKUP}/dispatches`
const ABILITA_BACKUP = `${WF_BACKUP}/enable`
const NOTTE = new Date('2026-10-21T02:23:00Z')
const TOKEN = 'ghtok-di-prova'
const SPENTO = { status: 422, testo: '{"message":"Cannot trigger a \'workflow_dispatch\' on a disabled workflow"}' }
const CREDENZIALI = { status: 401, testo: '{"message":"Bad credentials"}' }
// I giri del campanello come li restituisce GitHub: forme copiate dai giri VERI del 25/11/2026
// (`45702607280`, rifiutato alle 21:15 coi minuti finiti; `45704924584`, riuscito alle 21:30).
const GIRI = URL_GIRI_CAMPANELLO
const ID_RIFIUTATO = 45702607280
const ID_RIUSCITO = 45704924584
const jobsDi = (id: number) => `https://api.github.com/repos/${REPO}/actions/runs/${id}/jobs`
const CHECK_RUN = `https://api.github.com/repos/${REPO}/check-runs/139516333609`
const NOTE = `${CHECK_RUN}/annotations`
const MESSAGGIO_MINUTI =
    "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings"
function giroCampanello(campi: Record<string, unknown>) {
    return {
        id: ID_RIUSCITO,
        name: 'Campanello (sito, salute, backup)',
        display_title: 'Campanello (da Cloudflare)',
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-11-25T21:30:11Z',
        ...campi,
    }
}
const elenco = (...giri: Record<string, unknown>[]) => ({
    status: 200,
    testo: JSON.stringify({ total_count: giri.length, workflow_runs: giri }),
})
const lavori = (...jobs: Record<string, unknown>[]) => ({ status: 200, testo: JSON.stringify({ total_count: jobs.length, jobs }) })
const JOB_SENZA_PASSI = {
    id: 139516333609,
    name: 'Guarda il sito e il backup',
    status: 'completed',
    conclusion: 'failure',
    steps: [],
    runner_name: '',
    check_run_url: CHECK_RUN,
}
const NOTA_MINUTI = {
    status: 200,
    testo: JSON.stringify([{ path: '.github', start_line: 1, annotation_level: 'failure', title: '', message: MESSAGGIO_MINUTI, raw_details: '' }]),
}
const GIRI_SANI = elenco(giroCampanello({ id: ID_RIUSCITO, conclusion: 'success' }))
/** Il 25/11: l'ultimo giro partito da Cloudflare è finito `failure` con un job senza passi. */
const ACTIONS_FERME: Record<string, Risposta[]> = {
    [GIRI]: [elenco(giroCampanello({ id: ID_RIFIUTATO, conclusion: 'failure', created_at: '2026-11-25T21:15:11Z' }))],
    [jobsDi(ID_RIFIUTATO)]: [lavori(JOB_SENZA_PASSI)],
    [NOTE]: [NOTA_MINUTI],
}

/** Un `fetch` finto per un giro del monitor: se il test non dice altro, l'ultimo giro del campanello è riuscito. */
function fetchGiro(per: Record<string, Risposta[]>) {
    return fetchFinto({ [GIRI]: [GIRI_SANI], ...per })
}

/** Il mittente del campanello, letto dal suo sorgente: il Worker deve usare lo stesso. */
const MITTENTE_CAMPANELLO = /const MITTENTE = '([^']+)'/.exec(
    readFileSync(join(process.cwd(), 'scripts/campanello/allarme.mjs'), 'utf8'),
)?.[1]

async function unGiroBackup(f: ReturnType<typeof fetchFinto>, token = TOKEN, segreti: Segreti = SEGRETI) {
    const log = vi.fn()
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    const esito = await giroBackup({ quando: NOTTE, token, segreti, fetchImpl: f.impl, log })
    const righeErrore = errore.mock.calls.map((c) => String(c[0]))
    errore.mockRestore()
    return { esito, righe: log.mock.calls.map((c) => String(c[0])), righeErrore }
}

async function unGiro(f: ReturnType<typeof fetchFinto>, quando: Date, token = 'tok', segreti: Segreti = {}) {
    const dormi = vi.fn(async () => {})
    const log = vi.fn()
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    const esito = await giro({ quando, token, segreti, fetchImpl: f.impl, dormi, log })
    const righeErrore = errore.mock.calls.map((c) => String(c[0]))
    errore.mockRestore()
    return { esito, dormi, log, righeErrore }
}

describe('il monitor esterno', () => {
    it('il battito è ogni 15 minuti e il titolo che il campanello cerca è quello dell\'input', () => {
        expect(MINUTI_BATTITO).toBe(15)
        expect(ORIGINE).toBe('cloudflare')
        // Il `run-name` di campanello.yml traduce `origine=cloudflare` nel titolo che `giriDaFuori` filtra.
        const yml = readFileSync(join(process.cwd(), '.github/workflows/campanello.yml'), 'utf8')
        expect(yml).toContain(`inputs.origine == '${ORIGINE}' && ' ${TITOLO_DA_FUORI}'`)
    })

    it('vivo sano fuori dal battito: NON fa partire il campanello', async () => {
        const f = fetchGiro({ [URL_VIVO]: [OK] })

        const { esito } = await unGiro(f, FUORI_BATTITO)

        expect(esito.suonato).toBe(false)
        expect(f.a(DISPATCH)).toHaveLength(0)
        expect(f.a(URL_VIVO)).toHaveLength(1)
    })

    it('vivo sano SUL battito: fa partire il campanello con origine=cloudflare su main', async () => {
        const f = fetchGiro({ [URL_VIVO]: [OK], [DISPATCH]: [PARTITO] })

        const { esito, log } = await unGiro(f, SUL_BATTITO)

        expect(esito.suonato).toBe(true)
        const corpo = JSON.parse(f.a(DISPATCH)[0].corpo!)
        expect(corpo).toEqual({ ref: 'main', inputs: { origine: 'cloudflare' } })
        expect(f.a(DISPATCH)[0].auth).toBe('Bearer tok')
        expect(String(log.mock.calls[0][0])).toContain('battito')
    })

    it('vivo giù due volte fuori dal battito: fa partire SUBITO il campanello, dopo 20 s di attesa fra i tentativi', async () => {
        const f = fetchGiro({ [URL_VIVO]: [GIU], [DISPATCH]: [PARTITO] })

        const { esito, dormi, log } = await unGiro(f, FUORI_BATTITO)

        expect(f.a(URL_VIVO)).toHaveLength(2)
        expect(dormi).toHaveBeenCalledWith(20_000)
        expect(esito.suonato).toBe(true)
        expect(String(log.mock.calls[0][0])).toContain('HTTP 503')
    })

    it('uno scatto isolato (503 poi 200) non sveglia nessuno', async () => {
        const f = fetchGiro({ [URL_VIVO]: [GIU, OK] })

        const { esito } = await unGiro(f, FUORI_BATTITO)

        expect(esito.suonato).toBe(false)
        expect(f.a(DISPATCH)).toHaveLength(0)
    })

    it('una rete che non risponde conta come vivo giù', async () => {
        const f = fetchGiro({ [URL_VIVO]: [new Error('timeout')], [DISPATCH]: [PARTITO] })

        const { esito } = await unGiro(f, FUORI_BATTITO)

        expect(esito.vivo.ok).toBe(false)
        expect(esito.vivo.http).toBeNull()
        expect(esito.suonato).toBe(true)
    })

    it('un rifiuto di GitHub finisce nel log CON il corpo (un 401 senza corpo non dice che il token è scaduto)', async () => {
        const f = fetchGiro({ [URL_VIVO]: [GIU], [DISPATCH]: [{ status: 401, testo: '{"message":"Bad credentials"}' }] })

        const { esito, righeErrore } = await unGiro(f, FUORI_BATTITO)

        expect(esito.suonato).toBe(false)
        expect(righeErrore.join(' ')).toMatch(/401.*Bad credentials/)
        expect(righeErrore.join(' ')).not.toContain('tok')
    })

    it('senza token non chiama GitHub e lo dice', async () => {
        const f = fetchGiro({ [URL_VIVO]: [GIU] })

        const { esito, righeErrore } = await unGiro(f, FUORI_BATTITO, '')

        expect(f.a(DISPATCH)).toHaveLength(0)
        expect(esito.suonato).toBe(false)
        expect(righeErrore.join(' ')).toContain('manca GITHUB_TOKEN_CAMPANELLO')
    })
})

describe('suonaCampanello', () => {
    it('se GitHub rifiuta l\'input (campanello.yml che non lo dichiara) riprova senza input', async () => {
        const f = fetchFinto({
            [DISPATCH]: [{ status: 422, testo: '{"message":"Unexpected inputs provided: [\\"origine\\"]"}' }, PARTITO],
        })

        const esito = await suonaCampanello({ token: 't', fetchImpl: f.impl })

        expect(esito.ok).toBe(true)
        expect(f.a(DISPATCH).map((c) => JSON.parse(c.corpo!))).toEqual([
            { ref: 'main', inputs: { origine: 'cloudflare' } },
            { ref: 'main' },
        ])
    })

    it('un altro 422 NON si ritenta senza input', async () => {
        const f = fetchFinto({ [DISPATCH]: [{ status: 422, testo: '{"message":"No ref found for: main"}' }] })

        const esito = await suonaCampanello({ token: 't', fetchImpl: f.impl })

        expect(esito.ok).toBe(false)
        expect(f.a(DISPATCH)).toHaveLength(1)
    })
})

describe('leggiVivo', () => {
    it('200 al primo tentativo: non aspetta e non ritenta', async () => {
        const f = fetchFinto({ [URL_VIVO]: [OK] })
        const dormi = vi.fn(async () => {})

        expect(await leggiVivo({ fetchImpl: f.impl, dormi })).toEqual({ ok: true, http: 200, motivo: 'ok' })
        expect(dormi).not.toHaveBeenCalled()
    })
})

describe('wrangler.toml', () => {
    const toml = readFileSync(join(process.cwd(), 'monitor-esterno/wrangler.toml'), 'utf8')

    it('due cron (ogni 5 minuti; alle 02:23 il backup), nessun indirizzo pubblico, nessun segreto nel file', () => {
        expect(toml).toMatch(/^crons\s*=\s*\["\*\/5 \* \* \* \*", "23 2 \* \* \*"\]\s*$/m)
        expect(toml).toContain(`"${CRON_BACKUP}"`)
        expect(toml).toMatch(/^workers_dev\s*=\s*false\s*$/m)
        expect(toml).not.toMatch(/github_pat_|ghp_|re_[A-Za-z0-9]{6,}|\[vars\]|RESEND_API_KEY\s*=|SENTINELLA_DESTINATARI\s*=/)
    })

    it('il Worker lancia il backup alla stessa ora dello schedule di riserva', () => {
        const yml = readFileSync(join(process.cwd(), '.github/workflows/backup-notturno.yml'), 'utf8')
        expect(yml).toContain(`- cron: '${CRON_BACKUP}'`)
    })
})

describe('scheduled: ogni cron fa il suo lavoro', () => {
    async function scatta(
        cron: string,
        scheduledTime: number,
        f: ReturnType<typeof fetchFinto>,
        env: Record<string, string> = { GITHUB_TOKEN_CAMPANELLO: TOKEN },
    ) {
        const promesse: Promise<unknown>[] = []
        vi.stubGlobal('fetch', f.impl)
        const silenzio = vi.spyOn(console, 'log').mockImplementation(() => {})
        const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            await worker.scheduled(
                { cron, scheduledTime },
                env,
                { waitUntil: (p: Promise<unknown>) => promesse.push(p) },
            )
            await Promise.all(promesse)
        } finally {
            vi.unstubAllGlobals()
            silenzio.mockRestore()
            errore.mockRestore()
        }
        return promesse.length
    }

    it('lavoroDelCron: «23 2 * * *» è il backup, tutto il resto è il monitor', () => {
        expect(CRON_BACKUP).toBe('23 2 * * *')
        expect(lavoroDelCron(CRON_BACKUP)).toBe('backup')
        expect(lavoroDelCron('*/5 * * * *')).toBe('monitor')
        expect(lavoroDelCron('')).toBe('monitor')
    })

    it('il cron delle 02:23 lancia il backup e non legge il vivo', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [PARTITO] })

        expect(await scatta(CRON_BACKUP, Date.parse('2026-10-21T02:23:00Z'), f)).toBe(1)

        expect(f.a(DISPATCH_BACKUP)).toHaveLength(1)
        expect(f.a(URL_VIVO)).toHaveLength(0)
    })

    it('il cron dei 5 minuti legge il vivo e l\'ultimo giro del campanello, e non lancia il backup', async () => {
        const f = fetchGiro({ [URL_VIVO]: [OK] })

        expect(await scatta('*/5 * * * *', FUORI_BATTITO.getTime(), f)).toBe(1)

        expect(f.a(URL_VIVO)).toHaveLength(1)
        expect(f.a(GIRI)).toHaveLength(1)
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(0)
    })

    it('il cron dei 5 minuti con le Actions ferme: l\'email parte coi segreti del Worker', async () => {
        const env = { GITHUB_TOKEN_CAMPANELLO: TOKEN, RESEND_API_KEY: 're_prova', SENTINELLA_DESTINATARI: 'a@esempio.test' }
        const f = fetchFinto({ [URL_VIVO]: [OK], ...ACTIONS_FERME, [RESEND]: [ACCETTATA] })

        expect(await scatta('*/5 * * * *', Date.parse('2026-11-25T21:20:00Z'), f, env)).toBe(1)

        expect(f.a(GIRI)[0].auth).toBe(`Bearer ${TOKEN}`)
        expect(f.a(RESEND).map((c) => c.idem)).toEqual([chiaveIdempotenza('actions', new Date('2026-11-25T21:20:00Z'), MESSAGGIO_MINUTI)])
        expect(f.a(RESEND)[0].auth).toBe('Bearer re_prova')
    })

    it('backup rifiutato alle 02:23 e sito giù alle 02:25: un cron non ferma l\'altro, e i segreti del Worker arrivano alle due email', async () => {
        const env = { GITHUB_TOKEN_CAMPANELLO: TOKEN, RESEND_API_KEY: 're_prova', SENTINELLA_DESTINATARI: 'a@esempio.test' }
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [CREDENZIALI],
            [WF_BACKUP]: [CREDENZIALI],
            [URL_VIVO]: [GIU],
            [DISPATCH]: [CREDENZIALI],
            // Stesso token scaduto: anche l'elenco dei giri risponde 401 (illeggibile, nessuna email in più).
            [GIRI]: [CREDENZIALI],
            [RESEND]: [ACCETTATA],
        })

        expect(await scatta(CRON_BACKUP, Date.parse('2026-10-21T02:23:00Z'), f, env)).toBe(1)
        // Il giro dei 5 minuti aspetta 20 s veri fra i due tentativi del vivo: si fa scorrere l'orologio.
        vi.useFakeTimers({ toFake: ['setTimeout'] })
        try {
            const giroDopo = scatta('*/5 * * * *', Date.parse('2026-10-21T02:25:00Z'), f, env)
            await vi.advanceTimersByTimeAsync(20_000)
            expect(await giroDopo).toBe(1)
        } finally {
            vi.useRealTimers()
        }

        expect(f.a(URL_VIVO)).toHaveLength(2)
        expect(f.a(RESEND).map((c) => c.idem)).toEqual(['kidville-backup-non-partito-2026-10-21', 'kidville-vivo-giu-2026-10-21T02'])
        expect(f.a(RESEND).map((c) => c.auth)).toEqual(['Bearer re_prova', 'Bearer re_prova'])
        expect(f.a(RESEND).map((c) => JSON.parse(c.corpo!).to)).toEqual([['a@esempio.test'], ['a@esempio.test']])
    })
})

describe('i segreti della prova in locale non vanno online', () => {
    it('git ignora `.dev.vars` e `.wrangler/` del Worker', () => {
        for (const f of ['monitor-esterno/.dev.vars', 'monitor-esterno/.wrangler/tmp/prova.js']) {
            let ignorato = true
            try {
                execFileSync('git', ['check-ignore', '-q', f], { cwd: process.cwd() })
            } catch {
                ignorato = false
            }
            expect(ignorato, `${f} NON è ignorato da git`).toBe(true)
        }
    })
})

describe('mandaEmail e la chiave di Resend', () => {
    const base = {
        chiaveResend: 're_prova',
        destinatari: 'a@esempio.test',
        oggetto: 'o',
        introHtml: 'i',
        link: 'https://esempio.test/giri',
        quando: 'q',
    }

    it('con la chiave manda Idempotency-Key; senza chiave non la manda (il campanello resta com\'è)', async () => {
        const f = fetchFinto({ [RESEND]: [ACCETTATA] })

        await mandaEmail({ ...base, chiaveIdempotenza: 'kidville-backup-non-partito-2026-10-21', fetchImpl: f.impl })
        await mandaEmail({ ...base, fetchImpl: f.impl })

        expect(f.a(RESEND).map((c) => c.idem)).toEqual(['kidville-backup-non-partito-2026-10-21', undefined])
    })
})

describe('il backup delle 02:23 (giroBackup)', () => {
    it('lancia backup-notturno.yml su main con modalita=completo e origine=cloudflare, e lo scrive', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [PARTITO] })

        const { esito, righe, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio).toEqual({ ok: true, esito: 'partito', http: 204, corpo: '' })
        expect(JSON.parse(f.a(DISPATCH_BACKUP)[0].corpo!)).toEqual({
            ref: 'main',
            inputs: { modalita: 'completo', origine: 'cloudflare' },
        })
        expect(f.a(DISPATCH_BACKUP)[0].verbo).toBe('POST')
        expect(f.a(DISPATCH_BACKUP)[0].auth).toBe(`Bearer ${TOKEN}`)
        expect(righe.join(' ')).toContain('monitor-backup: esito=partito')
        expect(righeErrore).toEqual([])
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('workflow spento da GitHub per inattività: lo riattiva e riprova UNA volta, senza email', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [SPENTO, PARTITO],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_inactivity"}' }],
            [ABILITA_BACKUP]: [{ status: 204 }],
        })

        const { esito, righe } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('riattivato-e-partito')
        expect(f.a(ABILITA_BACKUP).map((c) => c.verbo)).toEqual(['PUT'])
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(2)
        expect(righe.join(' ')).toContain('esito=riattivato-e-partito')
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('riattivato ma il secondo lancio è rifiutato: NON riprova una terza volta, e avvisa', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [SPENTO, { status: 500, testo: '{"message":"Server Error"}' }],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_inactivity"}' }],
            [ABILITA_BACKUP]: [{ status: 204 }],
            [RESEND]: [ACCETTATA],
        })

        const { esito, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio).toMatchObject({ ok: false, esito: 'fallito', http: 500 })
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(2)
        expect(f.a(ABILITA_BACKUP)).toHaveLength(1)
        expect(righeErrore.join(' ')).toMatch(/riattivato, ma il lancio è stato rifiutato.*Server Error/)
        expect(f.a(RESEND)).toHaveLength(1)
    })

    it('spento per inattività e riattivazione rifiutata: non rilancia, e avvisa col corpo del rifiuto', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [SPENTO],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_inactivity"}' }],
            [ABILITA_BACKUP]: [{ status: 403, testo: '{"message":"Resource not accessible by personal access token"}' }],
            [RESEND]: [ACCETTATA],
        })

        const { esito, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio).toMatchObject({ ok: false, esito: 'fallito', http: 403 })
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(1)
        expect(righeErrore.join(' ')).toMatch(/riattivazione rifiutata.*Resource not accessible/)
        expect(f.a(RESEND)).toHaveLength(1)
    })

    it('stessa notte, stesso rifiuto: stessa chiave e STESSO testo anche se il cron parte in ritardo (testo diverso = 409)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            const f = fetchFinto({ [DISPATCH_BACKUP]: [CREDENZIALI], [WF_BACKUP]: [CREDENZIALI], [RESEND]: [ACCETTATA] })
            vi.setSystemTime(new Date('2026-10-21T02:23:04Z'))
            await unGiroBackup(f)
            vi.setSystemTime(new Date('2026-10-21T02:41:57Z'))
            await unGiroBackup(f)

            const [prima, seconda] = f.a(RESEND)
            expect(seconda.idem).toBe(prima.idem)
            expect(seconda.corpo).toBe(prima.corpo)
        } finally {
            vi.useRealTimers()
        }
    })

    it('workflow spento A MANO: NON lo riaccende, non manda email, lo scrive', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [SPENTO],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_manually"}' }],
        })

        const { esito, righe } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('spento-a-mano')
        expect(f.a(ABILITA_BACKUP)).toHaveLength(0)
        expect(f.a(RESEND)).toHaveLength(0)
        expect(righe.join(' ')).toContain('esito=spento-a-mano')
    })

    it('GitHub rifiuta (401): console.error col corpo, email con la chiave della notte e il mittente del campanello', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [CREDENZIALI], [WF_BACKUP]: [CREDENZIALI], [RESEND]: [ACCETTATA] })

        const { esito, righe, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('fallito')
        expect(righeErrore.join(' ')).toMatch(/monitor-backup: esito=fallito.*401.*Bad credentials/)
        expect(righeErrore.join(' ')).not.toContain(TOKEN)
        const [email] = f.a(RESEND)
        expect(email.idem).toBe('kidville-backup-non-partito-2026-10-21')
        expect(email.auth).toBe('Bearer re_prova')
        const corpo = JSON.parse(email.corpo!)
        expect(MITTENTE_CAMPANELLO).toBeTruthy()
        expect(corpo.from).toBe(MITTENTE_CAMPANELLO)
        expect(corpo.subject).toBe('Backup notturno NON partito')
        expect(corpo.to).toEqual(['a@esempio.test', 'b@esempio.test'])
        expect(corpo.html).toContain('Bad credentials')
        expect(corpo.html).toContain(LINK_GIRI_BACKUP)
        expect(corpo.html).not.toContain(TOKEN)
        expect(righe.join(' ')).toContain('monitor-email: esito=accettata chiave=kidville-backup-non-partito-2026-10-21')
    })

    it('422 «unexpected inputs» (workflow su main senza `origine`): NON riprova senza input, e avvisa', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [{ status: 422, testo: '{"message":"Unexpected inputs provided: [\\"origine\\"]"}' }],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"active"}' }],
            [RESEND]: [ACCETTATA],
        })

        const { esito } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('fallito')
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(1)
        expect(f.a(RESEND)).toHaveLength(1)
    })

    it('senza token non chiama GitHub, lo dice e manda l\'email', async () => {
        const f = fetchFinto({ [RESEND]: [ACCETTATA] })

        const { esito, righeErrore } = await unGiroBackup(f, '')

        expect(f.a(DISPATCH_BACKUP)).toHaveLength(0)
        expect(esito.lancio.http).toBe(0)
        expect(righeErrore.join(' ')).toContain('manca GITHUB_TOKEN_CAMPANELLO')
        expect(f.a(RESEND)).toHaveLength(1)
    })

    it('senza i segreti di Resend lo scrive in console.error e va avanti', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [{ status: 500, testo: 'boom' }], [WF_BACKUP]: [{ status: 500, testo: 'boom' }] })

        const { esito, righeErrore } = await unGiroBackup(f, TOKEN, {})

        expect(esito.email?.ok).toBe(false)
        expect(righeErrore.join(' ')).toContain('mancano RESEND_API_KEY o SENTINELLA_DESTINATARI')
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('Resend rifiuta: il corpo del rifiuto finisce nel log (un 403 senza corpo non dice perché)', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [CREDENZIALI],
            [WF_BACKUP]: [CREDENZIALI],
            [RESEND]: [{ status: 403, testo: '{"message":"The domain is not verified"}' }],
        })

        const { righeErrore } = await unGiroBackup(f)

        expect(righeErrore.join(' ')).toMatch(/monitor-email: esito=non-spedita.*403.*domain is not verified/)
    })

    it('un rifiuto che riportasse il token (un proxy che rimanda le intestazioni): né il log né l\'email lo contengono', async () => {
        const eco = { status: 502, testo: `<html>Authorization: Bearer ${TOKEN} · token=${TOKEN}</html>` }
        const f = fetchFinto({ [DISPATCH_BACKUP]: [eco], [WF_BACKUP]: [eco], [RESEND]: [ACCETTATA] })

        const { esito, righe, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('fallito')
        expect(righeErrore.join(' ')).toMatch(/monitor-backup: esito=fallito.*HTTP 502.*\[nascosto\]/)
        const [email] = f.a(RESEND)
        for (const testo of [email.corpo!, esito.lancio.corpo, ...righe, ...righeErrore]) {
            expect(testo).not.toContain(TOKEN)
        }
    })

    it('un rifiuto di Resend che riportasse la sua chiave: il log non la contiene', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [CREDENZIALI],
            [WF_BACKUP]: [CREDENZIALI],
            [RESEND]: [{ status: 401, testo: '{"message":"API key re_prova is invalid"}' }],
        })

        const { righe, righeErrore } = await unGiroBackup(f)

        expect(righeErrore.join(' ')).toMatch(/monitor-email: esito=non-spedita.*401.*\[nascosto\] is invalid/)
        expect([...righe, ...righeErrore].join(' ')).not.toContain('re_prova')
    })

    it('la rete cade: esito fallito, col motivo', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [new Error('timeout')], [RESEND]: [ACCETTATA] })

        const { esito } = await unGiroBackup(f)

        expect(esito.lancio).toMatchObject({ ok: false, esito: 'fallito', http: null })
        expect(esito.lancio.corpo).toContain('timeout')
    })
})

describe('chiaveIdempotenza', () => {
    it('una per notte per il backup, una per ora per il sito giù; solo caratteri che Resend accetta', () => {
        expect(chiaveIdempotenza('backup', new Date('2026-10-21T02:23:00Z'))).toBe('kidville-backup-non-partito-2026-10-21')
        expect(chiaveIdempotenza('vivo', new Date('2026-10-19T10:05:00Z'))).toBe('kidville-vivo-giu-2026-10-19T10')
        expect(chiaveIdempotenza('vivo', new Date('2026-10-19T10:55:00Z'))).toBe('kidville-vivo-giu-2026-10-19T10')
        expect(chiaveIdempotenza('vivo', new Date('2026-10-19T11:00:00Z'))).toBe('kidville-vivo-giu-2026-10-19T11')
        for (const k of [chiaveIdempotenza('backup', NOTTE), chiaveIdempotenza('vivo', NOTTE), chiaveIdempotenza('actions', NOTTE, MESSAGGIO_MINUTI)]) {
            expect(k).toMatch(/^[A-Za-z0-9:_.-]{1,256}$/)
        }
    })

    it('Actions ferme: una per giorno e per motivo (stesso giorno e stesso messaggio = stessa chiave)', () => {
        const mattina = chiaveIdempotenza('actions', new Date('2026-11-25T03:05:00Z'), MESSAGGIO_MINUTI)
        expect(mattina).toMatch(/^kidville-actions-ferme-2026-11-25-[0-9a-f]{8}$/)
        expect(chiaveIdempotenza('actions', new Date('2026-11-25T21:15:00Z'), MESSAGGIO_MINUTI)).toBe(mattina)
        expect(chiaveIdempotenza('actions', new Date('2026-11-26T03:05:00Z'), MESSAGGIO_MINUTI)).toMatch(/^kidville-actions-ferme-2026-11-26-/)
        expect(chiaveIdempotenza('actions', new Date('2026-11-25T03:05:00Z'), 'un altro motivo')).not.toBe(mattina)
    })
})

describe('il secondo canale quando il sito è giù', () => {
    it('sito giù E campanello rifiutato: parte l\'email, con la chiave dell\'ora', async () => {
        const f = fetchGiro({ [URL_VIVO]: [GIU], [DISPATCH]: [CREDENZIALI], [RESEND]: [ACCETTATA] })

        const { esito, log } = await unGiro(f, FUORI_BATTITO, 'tok', SEGRETI)

        expect(esito.suonato).toBe(false)
        expect(f.a(RESEND)).toHaveLength(1)
        expect(f.a(RESEND)[0].idem).toBe('kidville-vivo-giu-2026-10-19T10')
        expect(JSON.parse(f.a(RESEND)[0].corpo!).subject).toBe('Sito giù e campanello NON partito')
        expect(esito.email?.ok).toBe(true)
        expect(log.mock.calls.map((c) => String(c[0])).join(' ')).toContain('monitor-email: esito=accettata')
    })

    it('dentro la stessa ora il testo non cambia anche se cambia il guasto (stessa chiave, messaggio diverso = 409)', async () => {
        const f = fetchGiro({
            [URL_VIVO]: [GIU, GIU, { status: 502, testo: 'Bad gateway' }],
            [DISPATCH]: [CREDENZIALI],
            [RESEND]: [ACCETTATA],
        })

        await unGiro(f, FUORI_BATTITO, 'tok', SEGRETI)
        await unGiro(f, new Date('2026-10-19T10:40:00Z'), 'tok', SEGRETI)

        const [prima, seconda] = f.a(RESEND)
        expect(seconda.idem).toBe(prima.idem)
        expect(seconda.corpo).toBe(prima.corpo)
    })

    it('battito rifiutato col sito sano: nessuna email (lo vede `monitor-esterno-muto`)', async () => {
        const f = fetchGiro({ [URL_VIVO]: [OK], [DISPATCH]: [CREDENZIALI] })

        const { esito } = await unGiro(f, SUL_BATTITO, 'tok', SEGRETI)

        expect(esito.suonato).toBe(false)
        expect(esito.email).toBeNull()
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('sito giù e campanello partito: nessuna email dal Worker (l\'allarme lo manda il campanello)', async () => {
        const f = fetchGiro({ [URL_VIVO]: [GIU], [DISPATCH]: [PARTITO] })

        const { esito } = await unGiro(f, FUORI_BATTITO, 'tok', SEGRETI)

        expect(esito.suonato).toBe(true)
        expect(esito.email).toBeNull()
        expect(f.a(RESEND)).toHaveLength(0)
    })
})

describe('il giro accettato e NON eseguito (25/11/2026: minuti di Actions finiti)', () => {
    // Le 10:05 del 25/11: fuori dal battito, quindi nessun lancio; il controllo dei giri si fa lo stesso.
    const MATTINA = new Date('2026-11-25T10:05:00Z')
    const CHIAVE_MINUTI = chiaveIdempotenza('actions', MATTINA, MESSAGGIO_MINUTI)

    it('sito sano, ultimo giro finito «failure» senza passi: l\'email delle Actions ferme col messaggio di GitHub', async () => {
        const f = fetchFinto({ [URL_VIVO]: [OK], ...ACTIONS_FERME, [RESEND]: [ACCETTATA] })

        const { esito, log, righeErrore } = await unGiro(f, MATTINA, TOKEN, SEGRETI)

        expect(f.a(DISPATCH)).toHaveLength(0)
        expect(esito.actions).toMatchObject({ esito: 'rifiutato', giro: { id: ID_RIFIUTATO, conclusione: 'failure' } })
        expect(righeErrore.join(' ')).toContain(`monitor-actions: esito=rifiutato giro=${ID_RIFIUTATO} conclusione=failure`)
        expect(righeErrore.join(' ')).toContain('passi=0: The job was not started because recent account payments have failed')
        // Le tre letture vanno a GitHub col token, in GET.
        for (const u of [GIRI, jobsDi(ID_RIFIUTATO), NOTE]) {
            expect(f.a(u).map((c) => [c.verbo, c.auth])).toEqual([['GET', `Bearer ${TOKEN}`]])
        }
        const [email] = f.a(RESEND)
        expect(f.a(RESEND)).toHaveLength(1)
        expect(email.idem).toBe(CHIAVE_MINUTI)
        const corpo = JSON.parse(email.corpo!)
        expect(corpo.subject).toBe('GitHub Actions non esegue il campanello')
        expect(corpo.html).toContain('recent account payments have failed')
        expect(corpo.html).toContain('Billing &amp; plans')
        expect(corpo.html).toContain(LINK_GIRI_CAMPANELLO)
        expect(corpo.html).not.toContain(TOKEN)
        expect(esito.emailActions?.ok).toBe(true)
        // Col sito sano nessuna email del vivo.
        expect(esito.email).toBeNull()
        expect(log.mock.calls.map((c) => String(c[0])).join(' ')).toContain(`monitor-email: esito=accettata chiave=${CHIAVE_MINUTI}`)
    })

    it('sito GIÙ, lancio accettato (204) ma GitHub non esegue i giri: parte ANCHE l\'email oraria del sito giù', async () => {
        const f = fetchFinto({ [URL_VIVO]: [GIU], [DISPATCH]: [PARTITO], ...ACTIONS_FERME, [RESEND]: [ACCETTATA] })

        const { esito, righeErrore } = await unGiro(f, MATTINA, TOKEN, SEGRETI)

        expect(esito.suonato).toBe(true)
        expect(f.a(RESEND).map((c) => c.idem)).toEqual([CHIAVE_MINUTI, 'kidville-vivo-giu-2026-11-25T10'])
        expect(JSON.parse(f.a(RESEND)[1].corpo!).subject).toBe('Sito giù e campanello NON partito')
        expect(esito.email?.ok).toBe(true)
        expect(righeErrore.join(' ')).toContain(`campanello accettato, ma GitHub non esegue i giri (l'ultimo, ${ID_RIFIUTATO}`)
    })

    it('un «failure» CON dei passi è un giro vero finito male: nessuna email (il sito l\'ha guardato)', async () => {
        const conPassi = { ...JOB_SENZA_PASSI, steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success', number: 1 }] }
        const f = fetchFinto({ [URL_VIVO]: [OK], ...ACTIONS_FERME, [jobsDi(ID_RIFIUTATO)]: [lavori(conPassi)] })

        const { esito, log } = await unGiro(f, MATTINA, TOKEN, SEGRETI)

        expect(esito.actions).toMatchObject({ esito: 'ok', giro: { id: ID_RIFIUTATO, conclusione: 'failure' } })
        expect(f.a(NOTE)).toHaveLength(0)
        expect(f.a(RESEND)).toHaveLength(0)
        expect(log.mock.calls.map((c) => String(c[0])).join(' ')).toContain(`monitor-actions: esito=ok giro=${ID_RIFIUTATO} conclusione=failure`)
    })

    it('ultimo giro riuscito: nessuna email, nessuna lettura dei job, e il successo si scrive', async () => {
        const f = fetchGiro({ [URL_VIVO]: [OK] })

        const { esito, log, righeErrore } = await unGiro(f, MATTINA, TOKEN, SEGRETI)

        expect(esito.actions.esito).toBe('ok')
        expect(f.a(jobsDi(ID_RIUSCITO))).toHaveLength(0)
        expect(f.a(RESEND)).toHaveLength(0)
        expect(esito.emailActions).toBeNull()
        expect(righeErrore).toEqual([])
        expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
            'monitor: vivo ok, nessun giro del campanello',
            `monitor-actions: esito=ok giro=${ID_RIUSCITO} conclusione=success`,
        ])
    })

    it('conta il giro partito da Cloudflare, non quello lanciato a mano', async () => {
        // Più recente un giro a mano riuscito, poi il giro da Cloudflare rifiutato: è questo che conta.
        const aManoPrima = fetchFinto({
            ...ACTIONS_FERME,
            [GIRI]: [elenco(giroCampanello({ id: 1, display_title: 'Campanello' }), giroCampanello({ id: ID_RIFIUTATO, conclusion: 'failure' }))],
        })
        expect(await guardaUltimoGiro({ token: TOKEN, fetchImpl: aManoPrima.impl })).toMatchObject({ esito: 'rifiutato', giro: { id: ID_RIFIUTATO } })

        // Più recente un giro a mano rifiutato, poi quello da Cloudflare riuscito: tutto bene, e i job del giro a mano non si leggono.
        const aManoRifiutato = fetchFinto({
            [GIRI]: [elenco(giroCampanello({ id: 2, display_title: 'Campanello', conclusion: 'failure' }), giroCampanello({ id: ID_RIUSCITO }))],
        })
        expect(await guardaUltimoGiro({ token: TOKEN, fetchImpl: aManoRifiutato.impl })).toMatchObject({ esito: 'ok', giro: { id: ID_RIUSCITO } })
        expect(aManoRifiutato.a(jobsDi(2))).toHaveLength(0)
    })

    it('stesso giorno, giri diversi, stesso motivo: stessa chiave e STESSO testo (testo diverso = 409 di Resend)', async () => {
        const ALTRO = 45710000000
        const f = fetchFinto({
            [URL_VIVO]: [OK],
            ...ACTIONS_FERME,
            [GIRI]: [
                elenco(giroCampanello({ id: ID_RIFIUTATO, conclusion: 'failure' })),
                elenco(giroCampanello({ id: ALTRO, conclusion: 'failure', created_at: '2026-11-25T18:30:11Z' })),
            ],
            [jobsDi(ALTRO)]: [lavori(JOB_SENZA_PASSI)],
            [RESEND]: [ACCETTATA],
        })

        await unGiro(f, MATTINA, TOKEN, SEGRETI)
        await unGiro(f, new Date('2026-11-25T18:40:00Z'), TOKEN, SEGRETI)

        const [prima, seconda] = f.a(RESEND)
        expect(f.a(jobsDi(ALTRO))).toHaveLength(1)
        expect(seconda.idem).toBe(prima.idem)
        expect(seconda.corpo).toBe(prima.corpo)
        expect(seconda.corpo).not.toContain(String(ALTRO))
    })

    it('annotazione non leggibile (403): l\'email parte lo stesso e dice perché', async () => {
        const f = fetchFinto({
            [URL_VIVO]: [OK],
            ...ACTIONS_FERME,
            [NOTE]: [{ status: 403, testo: '{"message":"Resource not accessible by personal access token"}' }],
            [RESEND]: [ACCETTATA],
        })

        const { esito } = await unGiro(f, MATTINA, TOKEN, SEGRETI)

        expect(esito.actions.esito).toBe('rifiutato')
        expect(esito.actions.messaggio).toMatch(/^annotazione non leggibile: HTTP 403 .*Resource not accessible/)
        expect(JSON.parse(f.a(RESEND)[0].corpo!).html).toContain('annotazione non leggibile: HTTP 403')
    })

    it('«startup_failure» senza nessun job (un campanello.yml che GitHub non legge): rifiutato anche questo', async () => {
        const f = fetchFinto({
            [GIRI]: [elenco(giroCampanello({ id: ID_RIFIUTATO, conclusion: 'startup_failure' }))],
            [jobsDi(ID_RIFIUTATO)]: [lavori()],
        })

        expect(await guardaUltimoGiro({ token: TOKEN, fetchImpl: f.impl })).toEqual({
            esito: 'rifiutato',
            giro: { id: ID_RIFIUTATO, conclusione: 'startup_failure', creato: '2026-11-25T21:30:11Z' },
            messaggio: 'GitHub non ha creato nessun job (nessuna annotazione da leggere)',
        })
    })

    it('un check run che non è di api.github.com: il token non ci va, e il rifiuto vale lo stesso', async () => {
        const altrove = 'https://altrove.esempio.test/check-runs/1'
        const f = fetchFinto({ ...ACTIONS_FERME, [jobsDi(ID_RIFIUTATO)]: [lavori({ ...JOB_SENZA_PASSI, check_run_url: altrove })] })

        const esito = await guardaUltimoGiro({ token: TOKEN, fetchImpl: f.impl })

        expect(f.chiamate.filter((c) => c.url.startsWith(altrove))).toHaveLength(0)
        expect(esito).toMatchObject({ esito: 'rifiutato', messaggio: expect.stringContaining('non di api.github.com') })
    })

    it('GitHub non dà l\'elenco dei giri (401): lo scrive col corpo e senza il token, nessuna email delle Actions', async () => {
        const eco = { status: 401, testo: `{"message":"Bad credentials","eco":"Bearer ${TOKEN}"}` }
        const f = fetchFinto({ [URL_VIVO]: [OK], [GIRI]: [eco] })

        const { esito, righeErrore } = await unGiro(f, MATTINA, TOKEN, SEGRETI)

        expect(esito.actions).toMatchObject({ esito: 'illeggibile', http: 401 })
        expect(righeErrore.join(' ')).toMatch(/monitor-actions: esito=illeggibile HTTP 401 .*Bad credentials/)
        expect(righeErrore.join(' ')).not.toContain(TOKEN)
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('una risposta che non è JSON o una rete che cade: illeggibile, senza lanciare', async () => {
        for (const r of [{ status: 200, testo: '<html>manutenzione</html>' }, new Error('timeout')]) {
            const f = fetchFinto({ [GIRI]: [r] })
            expect(await guardaUltimoGiro({ token: TOKEN, fetchImpl: f.impl })).toMatchObject({ esito: 'illeggibile', http: null })
        }
    })

    it('nessun giro partito da Cloudflare fra gli ultimi: lo dice, nessuna email', async () => {
        const f = fetchFinto({ [URL_VIVO]: [OK], [GIRI]: [elenco(giroCampanello({ display_title: 'Campanello', conclusion: 'failure' }))] })

        const { esito, log } = await unGiro(f, MATTINA, TOKEN, SEGRETI)

        expect(esito.actions).toEqual({ esito: 'nessun-giro' })
        expect(log.mock.calls.map((c) => String(c[0])).join(' ')).toContain('monitor-actions: esito=nessun-giro')
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('senza token non legge i giri e lo dice', async () => {
        const f = fetchFinto({})

        expect(await guardaUltimoGiro({ token: '', fetchImpl: f.impl })).toMatchObject({ esito: 'illeggibile', http: 0 })
        expect(f.chiamate).toHaveLength(0)
    })
})
