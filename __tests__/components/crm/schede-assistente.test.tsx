import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import { ElencoSchede } from '@/components/features/crm/schede/ElencoSchede'
import { DettaglioScheda } from '@/components/features/crm/schede/DettaglioScheda'

/**
 * CRM della segreteria · le colonne della vendita nella scheda e nell'elenco (15/11/2026).
 *
 * Una segretaria deve vedere che cosa ha fatto l'assistente con una famiglia: se ha chiesto di non essere più contattata
 * (e poter togliere o rimettere il rifiuto, con una conferma), a che punto è, il riassunto e se ha confermato
 * l'appuntamento. Qui si misura che cosa si disegna e che cosa parte verso il server; il server ha i suoi test
 * (`__tests__/api/crm-schede-assistente.test.ts`).
 *
 * Prima della migrazione le chiavi nuove non arrivano dalla route: la scheda e l'elenco sono quelli di sempre.
 *
 * L'impianto è quello di `schede.test.tsx`: il catalogo si legge da disco e una chiave che non c'è fa cadere il test, `fetch`
 * è finto e una chiamata senza regola non passa in silenzio. Nomi, numeri e testi sono inventati.
 */

vi.mock('next-intl', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { IntlMessageFormat } = await import('intl-messageformat')
  const cartella = join(process.cwd(), 'messages/it')
  const catalogo: Record<string, unknown> = {}
  for (const file of readdirSync(cartella)) {
    if (file.endsWith('.json')) catalogo[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'))
  }
  const risolvi = (ns: string | undefined, chiave: string): string => {
    let v: unknown = ns ? catalogo[ns] : catalogo
    for (const pezzo of chiave.split('.')) v = (v as Record<string, unknown> | undefined)?.[pezzo]
    if (typeof v !== 'string') throw new Error(`Chiave di catalogo inesistente: ${ns ?? ''}.${chiave}`)
    return v
  }
  const useTranslations = (ns?: string) => {
    const t = (chiave: string, valori?: Record<string, unknown>) => {
      const testo = risolvi(ns, chiave)
      return valori === undefined ? testo : String(new IntlMessageFormat(testo, 'it').format(valori))
    }
    return Object.assign(t, {
      rich: (chiave: string) => risolvi(ns, chiave),
      markup: (chiave: string) => risolvi(ns, chiave),
      raw: (chiave: string) => risolvi(ns, chiave),
      has: (chiave: string) => {
        try {
          risolvi(ns, chiave)
          return true
        } catch {
          return false
        }
      },
    })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

interface Chiamata {
  url: string
  metodo: string
  corpo: Record<string, unknown> | null
}
interface Risposta {
  stato?: number
  corpo?: unknown
}
interface Rotta {
  metodo: string
  url: RegExp
  risposta: (c: Chiamata) => Risposta
}

const h = vi.hoisted(() => ({
  query: '',
  chiamate: [] as { url: string; metodo: string; corpo: Record<string, unknown> | null }[],
  rotte: [] as { metodo: string; url: RegExp; risposta: (c: { url: string; metodo: string; corpo: Record<string, unknown> | null }) => { stato?: number; corpo?: unknown } }[],
  nonGestite: [] as string[],
  logClient: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/admin/crm',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Errore'),
}))

// ── le schermate di altri compiti: marcatori che espongono le props ricevute ─────
vi.mock('@/components/features/crm/collegamento/BadgeCollegamento', () => ({
  BadgeCollegamento: ({ bambino }: { bambino: { id: string } }) => <span data-testid="badge-collegamento" data-bambino-id={bambino.id} />,
}))
vi.mock('@/components/features/crm/collegamento/AssociaDomanda', () => ({
  AssociaDomanda: (p: { scuolaId: string; schedaId: string; bambino: { id: string } }) => (
    <span data-testid="associa-domanda" data-scuola-id={p.scuolaId} data-scheda-id={p.schedaId} data-bambino-id={p.bambino.id} />
  ),
}))
vi.mock('@/components/features/crm/collegamento/AvvisoDomandaDaAssociare', () => ({
  AvvisoDomandaDaAssociare: ({ scheda }: { scheda: { id: string; domanda_da_associare: string } }) => (
    <span data-testid="avviso-domanda" data-scheda-id={scheda.id} data-domanda={scheda.domanda_da_associare} />
  ),
}))
vi.mock('@/components/features/crm/follow-up/AzioniScheda', () => ({
  AzioniScheda: (p: { scuolaId: string; schedaId: string }) => (
    <span data-testid="azioni-scheda" data-scuola-id={p.scuolaId} data-scheda-id={p.schedaId} />
  ),
}))
vi.mock('@/components/features/crm/agenda/FissaVisita', () => ({
  FissaVisita: (p: { scuolaId: string; schedaId?: string; appuntamento?: { id: string }; onFatto: () => void; onAnnulla: () => void }) => (
    <div data-testid="fissa-visita" data-scuola-id={p.scuolaId} data-scheda-id={p.schedaId} data-appuntamento-id={p.appuntamento?.id}>
      <button type="button" onClick={p.onFatto}>
        visita-fatta
      </button>
      <button type="button" onClick={p.onAnnulla}>
        visita-annullata
      </button>
    </div>
  ),
}))

// ── i due pezzi della quota e dell'alunno: marcatori che espongono le props e il gesto «è cambiato qualcosa» ──
vi.mock('@/components/features/crm/schede/QuotaIscrizione', () => ({
  QuotaIscrizione: (p: { schedaId: string; bambino: { id: string }; onCambiata: () => void }) => (
    <div data-testid="quota-iscrizione" data-scheda-id={p.schedaId} data-bambino-id={p.bambino.id}>
      <button type="button" onClick={p.onCambiata}>
        quota-cambiata
      </button>
    </div>
  ),
}))
vi.mock('@/components/features/crm/schede/CollegaAlunno', () => ({
  CollegaAlunno: (p: { schedaId: string; scuolaId: string; bambino: { id: string }; onCambiata: () => void }) => (
    <div data-testid="collega-alunno" data-scheda-id={p.schedaId} data-scuola-id={p.scuolaId} data-bambino-id={p.bambino.id}>
      <button type="button" onClick={p.onCambiata}>
        alunno-cambiato
      </button>
    </div>
  ),
}))

// ── fetch finto ───────────────────────────────────────────────────────────────────
/** Registra una regola. L'ULTIMA registrata vince: un test può correggere ciò che ha messo `beforeEach`. */
function rispondi(metodo: string, url: RegExp, risposta: Risposta | ((c: Chiamata) => Risposta)) {
  const regola: Rotta = { metodo, url, risposta: typeof risposta === 'function' ? risposta : () => risposta }
  h.rotte.unshift(regola)
}

const chiamateA = (metodo: string, url: RegExp) => h.chiamate.filter((c) => c.metodo === metodo && url.test(c.url))

beforeEach(() => {
  h.query = ''
  h.chiamate.length = 0
  h.rotte.length = 0
  h.nonGestite.length = 0
  h.logClient.mockClear()
  window.history.replaceState(null, '', '/admin/crm?tab=schede')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const metodo = (init?.method ?? 'GET').toUpperCase()
      const chiamata: Chiamata = { url, metodo, corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null }
      h.chiamate.push(chiamata)
      const rotta = h.rotte.find((r) => r.metodo === metodo && r.url.test(url))
      if (!rotta) {
        h.nonGestite.push(`${metodo} ${url}`)
        return new Response('{}', { status: 599 })
      }
      const { stato = 200, corpo = {} } = rotta.risposta(chiamata)
      return new Response(JSON.stringify(corpo), { status: stato, headers: { 'content-type': 'application/json' } })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Una chiamata senza regola è una schermata che parla con una route che il test non conosce.
  expect(h.nonGestite).toEqual([])
})

// ── le fixture: sempre «Famiglia Prova», mai una famiglia vera ─────────────────────
const ID_SCHEDA = 'scheda-1'
const URL_DETTAGLIO = /\/api\/admin\/crm\/schede\/scheda-1(\?|$)/

function scheda(over: Record<string, unknown> = {}) {
  return {
    id: ID_SCHEDA,
    scuola_id: SEDE_A,
    genitore_nome: 'Famiglia Prova',
    telefono1: '333 000 0001',
    telefono2: null,
    email1: 'prova@example.com',
    email2: null,
    telefoni_norm: ['3330000001'],
    email_norm: ['prova@example.com'],
    origine: 'telefonata',
    routine: null,
    paura: null,
    desiderio: null,
    domanda_da_associare: null,
    creato_da: null,
    creato_via: 'segreteria',
    creata_il: '2026-10-01T09:00:00.000Z',
    aggiornata_il: '2026-10-01T09:00:00.000Z',
    anonimizzata_il: null,
    ...over,
  }
}

function bambino(over: Record<string, unknown> = {}) {
  return {
    id: 'bambino-1',
    scuola_id: SEDE_A,
    scheda_id: ID_SCHEDA,
    nome: 'Bambino Prova',
    data_nascita: '2024-03-05',
    anno_ingresso: 'prossimo',
    esito: 'aperto',
    motivo_perdita: null,
    motivo_nota: null,
    esito_origine: null,
    esito_da: null,
    esito_il: null,
    domanda_id: null,
    domanda_figlio: null,
    domanda_collegata_il: null,
    nota_collegamento: null,
    da_verificare: false,
    quota_importo: null,
    quota_metodo: null,
    quota_anno: null,
    quota_stato: null,
    quota_blocco_motivo: null,
    quota_saldata_il: null,
    quota_segnata_da: null,
    quota_cassa_movimento_id: null,
    quota_pagamento_id: null,
    alunno_id: null,
    alunno_collegato_il: null,
    creata_il: '2026-10-01T09:00:00.000Z',
    aggiornata_il: '2026-10-01T09:00:00.000Z',
    ...over,
  }
}

const EVENTO_NOTA = {
  id: 'evento-2',
  scuola_id: SEDE_A,
  scheda_id: ID_SCHEDA,
  tipo: 'nota',
  autore: 'utente-1',
  autore_via: 'segreteria',
  dati: {},
  testo: 'Nota di prova due',
  creato_il: '2026-10-02T10:00:00.000Z',
  autore_persona: { id: 'utente-1', nome: 'Prova', cognome: 'Segreteria' },
}
const EVENTO_CREATA = {
  id: 'evento-1',
  scuola_id: SEDE_A,
  scheda_id: ID_SCHEDA,
  tipo: 'creata',
  autore: 'utente-1',
  autore_via: 'segreteria',
  dati: { bambini: 1 },
  testo: null,
  creato_il: '2026-10-01T09:00:00.000Z',
  autore_persona: { id: 'utente-1', nome: 'Prova', cognome: 'Segreteria' },
}

function dettaglio(over: Record<string, unknown> = {}) {
  return {
    scheda: scheda(),
    bambini: [bambino()],
    appuntamenti: [],
    azioni_aperte: [],
    eventi: [EVENTO_NOTA, EVENTO_CREATA],
    eventi_totale: 2,
    ...over,
  }
}

const apriDettaglio = async () => {
  render(<DettaglioScheda schedaId={ID_SCHEDA} onChiudi={vi.fn()} />)
  return screen.findByRole('region', { name: 'Storico' })
}


// ── le colonne della vendita, come le porta la route dopo la migrazione ──────────────
const RIASSUNTO = 'Riassunto di prova: preferisce il pomeriggio.\nSecondo capoverso di prova.'

/** Una scheda DOPO la migrazione: rifiuto spento, l'assistente non ha scritto niente. */
const vendita = (over: Record<string, unknown> = {}) => ({
  ai_stato: null,
  ai_riassunto: null,
  ai_aggiornata_il: null,
  non_contattare: false,
  non_contattare_il: null,
  ...over,
})

const appuntamento = (over: Record<string, unknown> = {}) => ({
  id: 'app-1',
  scuola_id: SEDE_A,
  scheda_id: ID_SCHEDA,
  inizio: '2099-01-10T10:00:00.000Z',
  fine: '2099-01-10T10:45:00.000Z',
  assegnata_a: 'utente-1',
  fissato_via: 'segreteria',
  stato: 'in_programma',
  svolto_da: null,
  assegnata_a_persona: { id: 'utente-1', nome: 'Prova', cognome: 'Segreteria' },
  svolto_da_persona: null,
  ...over,
})

const RIGA_ASSISTENTE = /Assistente della vendita/

// ════════════════════════════════════════════════════════════════════════════════
describe('scheda · «non contattare»', () => {
  const acceso = () =>
    dettaglio({ scheda: scheda(vendita({ non_contattare: true, non_contattare_il: '2026-11-10T08:00:00.000Z' })) })

  it('acceso: un avviso in CIMA alla scheda, con la data e le parole di una segretaria', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: acceso() })
    await apriDettaglio()

    const avviso = screen.getByRole('region', { name: 'Non contattare' })
    expect(within(avviso).getByText(/Questa famiglia ha chiesto di non essere più contattata/)).toBeInTheDocument()
    expect(within(avviso).getByText(/Dal .*2026/)).toBeInTheDocument()
    // «in cima»: prima della famiglia e di tutto il resto
    const famiglia = screen.getByRole('region', { name: 'Famiglia' })
    expect(avviso.compareDocumentPosition(famiglia) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('acceso: nell’avviso c’è «Togli», e il comando «Segna» non c’è (è già segnato)', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: acceso() })
    await apriDettaglio()
    expect(screen.getByRole('button', { name: 'Togli «non contattare»' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Segna «non contattare»' })).not.toBeInTheDocument()
  })

  it('togliere chiede PRIMA una conferma e non parte finché non la si dà', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: acceso() })
    await apriDettaglio()

    fireEvent.click(screen.getByRole('button', { name: 'Togli «non contattare»' }))
    const conferma = screen.getByRole('group', { name: 'Togliere «non contattare»?' })
    expect(within(conferma).getByText('L’assistente potrà tornare a scrivere a questa famiglia.')).toBeInTheDocument()
    expect(chiamateA('PATCH', URL_DETTAGLIO)).toHaveLength(0)

    fireEvent.click(within(conferma).getByRole('button', { name: 'Annulla' }))
    expect(screen.queryByRole('group', { name: 'Togliere «non contattare»?' })).not.toBeInTheDocument()
    expect(chiamateA('PATCH', URL_DETTAGLIO)).toHaveLength(0)
  })

  it('confermato: PATCH con il solo `nonContattare: false`, poi la scheda si rilegge', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: acceso() })
    rispondi('PATCH', URL_DETTAGLIO, { corpo: { id: ID_SCHEDA, modificata: true } })
    await apriDettaglio()
    const letture = chiamateA('GET', URL_DETTAGLIO).length

    fireEvent.click(screen.getByRole('button', { name: 'Togli «non contattare»' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, toglilo' }))

    await waitFor(() => expect(chiamateA('PATCH', URL_DETTAGLIO)).toHaveLength(1))
    expect(chiamateA('PATCH', URL_DETTAGLIO)[0].corpo).toEqual({ nonContattare: false })
    await waitFor(() => expect(chiamateA('GET', URL_DETTAGLIO).length).toBeGreaterThan(letture))
  })

  it('un doppio clic su «Sì» non manda due richieste', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: acceso() })
    rispondi('PATCH', URL_DETTAGLIO, { corpo: { id: ID_SCHEDA, modificata: true } })
    await apriDettaglio()
    fireEvent.click(screen.getByRole('button', { name: 'Togli «non contattare»' }))
    const si = screen.getByRole('button', { name: 'Sì, toglilo' })
    fireEvent.click(si)
    fireEvent.click(si)
    await waitFor(() => expect(chiamateA('PATCH', URL_DETTAGLIO)).toHaveLength(1))
  })

  it('se il salvataggio non riesce lo dice, e il rifiuto resta com’è (niente rilettura)', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: acceso() })
    rispondi('PATCH', URL_DETTAGLIO, { stato: 503, corpo: { error: 'Il CRM non è ancora disponibile su questo ambiente.', codice: 'CRM_NON_INSTALLATO' } })
    await apriDettaglio()
    const letture = chiamateA('GET', URL_DETTAGLIO).length

    fireEvent.click(screen.getByRole('button', { name: 'Togli «non contattare»' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, toglilo' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(chiamateA('GET', URL_DETTAGLIO)).toHaveLength(letture)
    expect(screen.getByRole('region', { name: 'Non contattare' })).toBeInTheDocument()
  })

  it('spento: l’avviso non c’è e il riquadro offre «Segna»; confermato parte `nonContattare: true`', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ scheda: scheda(vendita()) }) })
    rispondi('PATCH', URL_DETTAGLIO, { corpo: { id: ID_SCHEDA, modificata: true } })
    await apriDettaglio()

    expect(screen.queryByRole('region', { name: 'Non contattare' })).not.toBeInTheDocument()
    const riquadro = screen.getByRole('region', { name: RIGA_ASSISTENTE })
    fireEvent.click(within(riquadro).getByRole('button', { name: 'Segna «non contattare»' }))
    expect(screen.getByText('L’assistente non le scriverà più, finché non lo togli.')).toBeInTheDocument()
    expect(chiamateA('PATCH', URL_DETTAGLIO)).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Sì, segna' }))
    await waitFor(() => expect(chiamateA('PATCH', URL_DETTAGLIO)).toHaveLength(1))
    expect(chiamateA('PATCH', URL_DETTAGLIO)[0].corpo).toEqual({ nonContattare: true })
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('scheda · il riquadro dell’assistente', () => {
  it('stato in parole di segreteria, riassunto a capo come scritto, ora dell’ultimo aggiornamento', async () => {
    rispondi('GET', URL_DETTAGLIO, {
      corpo: dettaglio({
        scheda: scheda(vendita({ ai_stato: 'a_una_persona', ai_riassunto: RIASSUNTO, ai_aggiornata_il: '2026-11-12T09:30:00.000Z' })),
      }),
    })
    await apriDettaglio()

    const riquadro = screen.getByRole('region', { name: RIGA_ASSISTENTE })
    expect(within(riquadro).getByText('Passata alla segreteria')).toBeInTheDocument()
    const riassunto = within(riquadro).getByText(/Riassunto di prova: preferisce il pomeriggio\./)
    // il testo ha il suo a capo, e la riga lo rispetta
    expect(riassunto.textContent).toBe(RIASSUNTO)
    expect(riassunto.className).toContain('whitespace-pre-wrap')
    expect(within(riquadro).getByText(/Aggiornato il .*2026/)).toBeInTheDocument()
  })

  it('il riassunto è testo, non HTML: un tag scritto da una famiglia non diventa un elemento', async () => {
    rispondi('GET', URL_DETTAGLIO, {
      corpo: dettaglio({ scheda: scheda(vendita({ ai_riassunto: 'Prova <img src=x onerror=alert(1)> fine' })) }),
    })
    const storico = await apriDettaglio()
    const riquadro = screen.getByRole('region', { name: RIGA_ASSISTENTE })
    expect(riquadro.querySelector('img')).toBeNull()
    expect(within(riquadro).getByText(/Prova <img src=x onerror=alert\(1\)> fine/)).toBeInTheDocument()
    expect(storico).toBeInTheDocument()
  })

  it('ogni stato del vocabolario ha le sue parole: mai il codice del database a schermo', async () => {
    const { STATI_FAMIGLIA_AI } = await import('@/lib/crm/tipi')
    for (const stato of STATI_FAMIGLIA_AI) {
      cleanup()
      h.rotte.length = 0
      rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ scheda: scheda(vendita({ ai_stato: stato })) }) })
      await apriDettaglio()
      const riquadro = screen.getByRole('region', { name: RIGA_ASSISTENTE })
      expect(riquadro.textContent, `stato ${stato}`).not.toMatch(/[a-z]_[a-z]/)
      expect(within(riquadro).queryByText(stato)).not.toBeInTheDocument()
      expect(within(riquadro).queryByText('L’assistente non ha ancora scritto niente su questa famiglia.')).not.toBeInTheDocument()
    }
  })

  it('l’assistente non ha mai scritto niente: il riquadro lo dice in una riga, senza stato né riassunto', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ scheda: scheda(vendita()) }) })
    await apriDettaglio()
    const riquadro = screen.getByRole('region', { name: RIGA_ASSISTENTE })
    expect(within(riquadro).getByText('L’assistente non ha ancora scritto niente su questa famiglia.')).toBeInTheDocument()
    expect(within(riquadro).queryByText('A che punto è')).not.toBeInTheDocument()
    expect(within(riquadro).queryByText('Riassunto della conversazione')).not.toBeInTheDocument()
  })

  it('nessuna parola tecnica a schermo: né «lead», né i nomi dei campi, né la sigla «AI stato»', async () => {
    rispondi('GET', URL_DETTAGLIO, {
      corpo: dettaglio({
        scheda: scheda(vendita({ non_contattare: true, non_contattare_il: '2026-11-10T08:00:00.000Z', ai_stato: 'non_contattare', ai_riassunto: RIASSUNTO })),
        appuntamenti: [appuntamento({ promemoria_conferma: true, promemoria_conferma_il: '2026-11-12T09:00:00.000Z' })],
      }),
    })
    await apriDettaglio()
    const testo = document.body.textContent ?? ''
    expect(testo).not.toMatch(/\blead\b/i)
    expect(testo).not.toMatch(/ai_stato|ai_riassunto|ai_aggiornata|non_contattare|promemoria_conferma|AI stato/)
  })

  it('PRIMA della migrazione (nessuna chiave nuova) il riquadro e l’avviso non ci sono e la scheda è quella di sempre', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    const storico = await apriDettaglio()
    expect(screen.queryByRole('region', { name: RIGA_ASSISTENTE })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Non contattare' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /non contattare/i })).not.toBeInTheDocument()
    // il resto c'è
    expect(screen.getByRole('region', { name: 'Famiglia' })).toBeInTheDocument()
    expect(within(storico).getByText('Nota di prova due')).toBeInTheDocument()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('scheda · la risposta al promemoria dell’appuntamento', () => {
  const apriConAppuntamento = async (a: Record<string, unknown>) => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ scheda: scheda(vendita()), appuntamenti: [appuntamento(a)] }) })
    await apriDettaglio()
    return screen.getByRole('region', { name: 'Visite' })
  }

  it('confermato: lo dice, con quando ha risposto', async () => {
    const visite = await apriConAppuntamento({ promemoria_conferma: true, promemoria_conferma_il: '2026-11-12T09:00:00.000Z' })
    expect(within(visite).getByText('La famiglia conferma l’appuntamento')).toBeInTheDocument()
    expect(within(visite).getByText(/risposta del .*2026/)).toBeInTheDocument()
  })

  it('non confermato (ha detto di no): lo dice', async () => {
    const visite = await apriConAppuntamento({ promemoria_conferma: false, promemoria_conferma_il: '2026-11-12T09:00:00.000Z' })
    expect(within(visite).getByText('La famiglia non conferma l’appuntamento')).toBeInTheDocument()
    expect(within(visite).queryByText('La famiglia conferma l’appuntamento')).not.toBeInTheDocument()
  })

  it('nessuna risposta, appuntamento ancora in programma: «non ha ancora risposto»', async () => {
    const visite = await apriConAppuntamento({ promemoria_conferma: null, promemoria_conferma_il: null })
    expect(within(visite).getByText('La famiglia non ha ancora risposto al promemoria')).toBeInTheDocument()
  })

  it('un appuntamento già svolto senza risposta non dice niente', async () => {
    const visite = await apriConAppuntamento({ stato: 'svolto', promemoria_conferma: null })
    expect(within(visite).queryByText(/promemoria|conferma/)).not.toBeInTheDocument()
  })

  it('PRIMA della migrazione la colonna non c’è e la riga non dice niente', async () => {
    const visite = await apriConAppuntamento({})
    expect(within(visite).queryByText(/promemoria|conferma/)).not.toBeInTheDocument()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('scheda · lo storico dice i cambi dell’assistente e della segreteria', () => {
  const evento = (over: Record<string, unknown>) => ({
    id: 'evento-x',
    scuola_id: SEDE_A,
    scheda_id: ID_SCHEDA,
    tipo: 'modificata',
    autore: null,
    autore_via: 'ai',
    dati: {},
    testo: null,
    creato_il: '2026-11-12T09:00:00.000Z',
    autore_persona: null,
    ...over,
  })
  const apriConEventi = async (eventi: Record<string, unknown>[]) => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ scheda: scheda(vendita()), eventi, eventi_totale: eventi.length }) })
    return apriDettaglio()
  }

  it('l’assistente ha scritto stato, riassunto e rifiuto: i tre campi hanno un nome leggibile, e l’autore è l’assistente', async () => {
    const storico = await apriConEventi([evento({ dati: { campi: 'ai_stato,ai_riassunto,non_contattare' } })])
    expect(within(storico).getByText('Modificato: a che punto è, secondo l’assistente, riassunto dell’assistente, «non contattare»')).toBeInTheDocument()
    expect(within(storico).getByText('Assistente AI')).toBeInTheDocument()
  })

  it('la segreteria che toglie «non contattare»: una frase, con l’autore', async () => {
    const storico = await apriConEventi([
      evento({ id: 'e-tolto', autore_via: 'segreteria', autore: 'utente-1', autore_persona: { id: 'utente-1', nome: 'Prova', cognome: 'Segreteria' }, dati: { campi: 'non_contattare', acceso: false } }),
    ])
    expect(within(storico).getByText('«Non contattare» tolto: la famiglia può essere ricontattata')).toBeInTheDocument()
    expect(within(storico).getByText('Prova Segreteria')).toBeInTheDocument()
  })

  it('la segreteria che lo rimette', async () => {
    const storico = await apriConEventi([evento({ autore_via: 'segreteria', dati: { campi: 'non_contattare', acceso: true } })])
    expect(within(storico).getByText('Segnata come «non contattare»')).toBeInTheDocument()
  })

  it('la conferma del promemoria che scrive l’assistente (una nota con un testo fisso) si legge nello storico', async () => {
    const storico = await apriConEventi([
      evento({ tipo: 'nota', dati: { appuntamento_id: 'app-1' }, testo: 'Promemoria: la famiglia conferma l’appuntamento.' }),
    ])
    expect(within(storico).getByText('Promemoria: la famiglia conferma l’appuntamento.')).toBeInTheDocument()
    expect(within(storico).getByText('Assistente AI')).toBeInTheDocument()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('elenco · i segni sulla riga', () => {
  const URL_ELENCO = /\/api\/admin\/crm\/schede\?/
  const URL_PERSONE = /\/api\/admin\/crm\/persone\?/

  const riga = (n: number, over: Record<string, unknown> = {}) => ({
    id: `scheda-${n}`,
    genitore_nome: `Famiglia Prova ${n}`,
    origine: 'telefonata',
    creata_il: '2026-10-01T09:00:00.000Z',
    bambini: [{ id: `bambino-${n}`, nome: `Bambino Prova ${n}`, esito: 'aperto', domanda_id: null }],
    prossima_visita: null,
    prossima_azione: null,
    ...over,
  })
  const mostra = async (righe: Record<string, unknown>[]) => {
    rispondi('GET', URL_PERSONE, { corpo: { data: [] } })
    rispondi('GET', URL_ELENCO, { corpo: { data: righe, totale: righe.length, pagina: 1, perPagina: 50 } })
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)
    return screen.findByRole('list', { name: 'Famiglie' })
  }
  const voce = (lista: HTMLElement, nome: RegExp) => within(lista).getByRole('button', { name: nome })

  it('«non contattare» è un segno visibile accanto al nome', async () => {
    const lista = await mostra([riga(1, { non_contattare: true }), riga(2, { non_contattare: false })])
    expect(within(voce(lista, /Famiglia Prova 1/)).getByText('Non contattare')).toBeInTheDocument()
    expect(within(voce(lista, /Famiglia Prova 2/)).queryByText('Non contattare')).not.toBeInTheDocument()
  })

  it('la prossima visita confermata ha il suo segno; «non confermata» (ha detto di no) pure; senza risposta niente', async () => {
    const lista = await mostra([
      riga(1, { prossima_visita: '2099-01-10T10:00:00.000Z', prossima_visita_confermata: true }),
      riga(2, { prossima_visita: '2099-01-10T10:00:00.000Z', prossima_visita_confermata: false }),
      riga(3, { prossima_visita: '2099-01-10T10:00:00.000Z', prossima_visita_confermata: null }),
    ])
    expect(within(voce(lista, /Famiglia Prova 1/)).getByText('Appuntamento confermato')).toBeInTheDocument()
    expect(within(voce(lista, /Famiglia Prova 2/)).getByText('Appuntamento non confermato')).toBeInTheDocument()
    expect(within(voce(lista, /Famiglia Prova 3/)).queryByText(/Appuntamento (non )?confermato/)).not.toBeInTheDocument()
  })

  it('senza una prossima visita il segno di conferma non c’è, anche se il campo dicesse vero', async () => {
    const lista = await mostra([riga(1, { prossima_visita: null, prossima_visita_confermata: true })])
    expect(within(voce(lista, /Famiglia Prova 1/)).queryByText(/Appuntamento (non )?confermato/)).not.toBeInTheDocument()
  })

  it('PRIMA della migrazione le righe non portano i campi nuovi: l’elenco è quello di sempre, senza segni', async () => {
    const lista = await mostra([riga(1, { prossima_visita: '2099-01-10T10:00:00.000Z' })])
    const v = voce(lista, /Famiglia Prova 1/)
    expect(within(v).queryByText('Non contattare')).not.toBeInTheDocument()
    expect(within(v).queryByText(/Appuntamento (non )?confermato/)).not.toBeInTheDocument()
    expect(within(v).getByText(/Visita:/)).toBeInTheDocument()
  })
})
