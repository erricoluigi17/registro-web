import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'
import type { RigaCalendario } from '@/lib/anno-scolastico'

/**
 * Lotto E1 — «Importa nelle anagrafiche» non può restare senza effetto.
 *
 * La prova di usabilità sulla sede Demo: domanda dell'anno 2027/28 (iscrizioni aperte), classe scelta, retta vuota,
 * clic su «Importa»: nessun messaggio, nessun cambiamento. Il server rispondeva 400 `RETTA_MANCANTE` e la pagina lo
 * mostrava con un `alert()` del browser, che chi collauda (e chi usa l'app dentro una WebView) non vede.
 * Ora ogni rifiuto compare nella pagina, e la retta vuota di un anno prossimo si manda (vale «listino dell'anno»).
 *
 * Solo dati finti.
 */

const { logClientMock, stato } = vi.hoisted(() => ({
  logClientMock: vi.fn(),
  stato: { perSede: {} as Record<string, unknown[]> },
}))

vi.mock('@/lib/logging/client', () => ({ logClient: logClientMock, nomeErrore: () => 'e' }))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'sc-giugliano', nome: 'Kidville Giugliano' }],
    selezionate: [],
    effettive: ['sc-giugliano'],
    sedeCorrente: null,
    reFetchKey: 'sc-giugliano',
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))
vi.mock('@/lib/context/calendario-context', async (importOriginal) => {
  const originale = await importOriginal<typeof import('@/lib/context/calendario-context')>()
  return {
    ...originale,
    useCalendario: () => ({ perSede: stato.perSede, loading: false, errore: false, ricarica: () => {} }),
  }
})

const A26 = '22222222-2222-4222-8222-222222222026'
const A27 = '22222222-2222-4222-8222-222222222027'

function riga(annoId: string, annoInizio: number, statoAnno: string, domandeAperte: boolean): RigaCalendario {
  return {
    annoId, annoInizio, inizio: `${annoInizio}-09-01`, fine: `${annoInizio + 1}-08-31`,
    ultimoGiornoAperto: `${annoInizio + 1}-08-31`, preparaSuccessivoDal: `${annoInizio + 1}-03-01`,
    stato: statoAnno, domandeAperte,
  } as unknown as RigaCalendario
}

const SEZIONI = [{ id: 'sez-1', name: 'GIUGLIANO 3 ANNI', scuola_id: 'sc-giugliano' }]
const DOMANDE = [
  { id: 'sub-corrente', anno_id: A26, nome: 'Bruno Neri' },
  { id: 'sub-prossimo', anno_id: A27, nome: 'Ada Verdi' },
]

function elenco() {
  return DOMANDE.map((d) => ({
    id: d.id, scuola_id: 'sc-giugliano', status: 'pending', assigned_classes: null,
    created_at: '2026-07-20T10:00:00Z', anno_id: d.anno_id,
    riassunto: { bambini: 1, adulti: 1, primo_bambino: d.nome },
  }))
}
function dettaglio(id: string) {
  const d = DOMANDE.find((x) => x.id === id)!
  const [nome, cognome] = d.nome.split(' ')
  return {
    ...elenco().find((x) => x.id === id),
    data: {
      children: [{ nome, cognome, codice_fiscale: 'CF-FINTO', data_nascita: '2022-01-01' }],
      adults: [{ first_name: 'Anna', last_name: cognome, ruolo: 'mother', email: 'a@example.test' }],
    },
  }
}

type Patch = { ok: boolean; status: number; corpo: unknown } | 'rete'
let rispostaPatch: Patch = { ok: true, status: 200, corpo: { success: true } }
const fetchMock = vi.fn()
const alertMock = vi.fn()

function rispondi(url: string, init?: RequestInit): Promise<unknown> {
  const u = String(url)
  const json = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo })
  if (init?.method === 'PATCH') {
    if (rispostaPatch === 'rete') return Promise.reject(new TypeError('rete'))
    const r = rispostaPatch
    return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.corpo })
  }
  if (u.includes('/api/admin/sections')) return json(SEZIONI)
  const m = u.match(/\?id=([^&]+)/)
  if (m) return json({ data: dettaglio(decodeURIComponent(m[1])) })
  return json({ data: elenco(), total: DOMANDE.length })
}

beforeEach(() => {
  vi.clearAllMocks()
  rispostaPatch = { ok: true, status: 200, corpo: { success: true } }
  stato.perSede = { 'sc-giugliano': [riga(A26, 2026, 'corrente', false), riga(A27, 2027, 'iscrizioni_aperte', true)] }
  fetchMock.mockImplementation((url: string, init?: RequestInit) => rispondi(url, init))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', alertMock)
  vi.stubGlobal('confirm', vi.fn(() => true))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

import { ModuliRicevuti } from '@/components/features/admin/iscrizioni/ModuliRicevuti'

const patch = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')
async function apriEScegliClasse(nome: string, classe = 'GIUGLIANO 3 ANNI') {
  await waitFor(() => expect(screen.getByText(nome)).toBeInTheDocument())
  fireEvent.click(screen.getByText(nome))
  const select = await screen.findByLabelText(/Classe \/ Sezione/i)
  await waitFor(() => expect(screen.getByRole('option', { name: classe })).toBeInTheDocument())
  if (classe) fireEvent.change(select, { target: { value: classe } })
}
const importa = () => fireEvent.click(screen.getByRole('button', { name: itAdminAltro.ricevutiImporta }))

describe('ModuliRicevuti — l\'import non parte mai in silenzio', () => {
  it('i testi nuovi esistono in italiano e in inglese', () => {
    for (const k of [
      'ricevutiRettaPlaceholderListino', 'ricevutiErroreClasseMancante', 'ricevutiErroreRettaMancante', 'ricevutiImportNonRiuscito',
    ]) {
      expect(itAdminAltro).toHaveProperty(k)
      expect(enAdminAltro).toHaveProperty(k)
    }
  })

  it('anno prossimo, classe scelta e retta vuota: l\'import parte, senza retta, e riesce', async () => {
    render(<ModuliRicevuti />)
    await apriEScegliClasse('Ada Verdi')
    importa()
    await waitFor(() => expect(patch()).toHaveLength(1))
    const corpo = JSON.parse(String((patch()[0][1] as RequestInit).body))
    expect(corpo.rette).toEqual({})
    expect(await screen.findByText(itAdminAltro.ricevutiImportata)).toBeInTheDocument()
  })

  it('anno prossimo: il campo retta dice che vuoto vale il listino e non ha l\'asterisco', async () => {
    render(<ModuliRicevuti />)
    await apriEScegliClasse('Ada Verdi')
    const campo = screen.getByLabelText(itAdminAltro.ricevutiRettaMensile) as HTMLInputElement
    expect(campo.placeholder).toBe(itAdminAltro.ricevutiRettaPlaceholderListino)
  })

  it('il server rifiuta (400 RETTA_MANCANTE): il messaggio compare nella pagina, non in un alert del browser', async () => {
    rispostaPatch = {
      ok: false, status: 400,
      corpo: { error: 'Indicare la retta mensile del bambino 1, oppure il fratello che la paga per lui.', codice: 'RETTA_MANCANTE' },
    }
    render(<ModuliRicevuti />)
    await apriEScegliClasse('Ada Verdi')
    importa()
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(/Indicare la retta mensile del bambino 1/)
    expect(alertMock).not.toHaveBeenCalled()
  })

  it('un codice dell\'anno (409 ANNO_CHIUSO) si vede nella pagina', async () => {
    rispostaPatch = { ok: false, status: 409, corpo: { error: 'L\'anno è chiuso.', codice: 'ANNO_CHIUSO' } }
    render(<ModuliRicevuti />)
    await apriEScegliClasse('Ada Verdi')
    importa()
    expect(await screen.findByRole('alert')).toHaveTextContent('L\'anno è chiuso.')
    expect(alertMock).not.toHaveBeenCalled()
  })

  it('un errore di rete si vede nella pagina e il pulsante torna premibile', async () => {
    rispostaPatch = 'rete'
    render(<ModuliRicevuti />)
    await apriEScegliClasse('Ada Verdi')
    importa()
    expect(await screen.findByRole('alert')).toHaveTextContent(itAdminAltro.ricevutiErroreImport)
    expect(alertMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: itAdminAltro.ricevutiImporta })).toBeEnabled()
  })

  it('classe non scelta: il messaggio sta sotto il campo e non parte nessuna richiesta', async () => {
    render(<ModuliRicevuti />)
    await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada Verdi'))
    await screen.findByLabelText(/Classe \/ Sezione/i)
    importa()
    const campo = screen.getByLabelText(/Classe \/ Sezione/i)
    expect(campo).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getAllByText(itAdminAltro.ricevutiErroreClasseMancante).length).toBeGreaterThan(0)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(patch()).toHaveLength(0)
  })

  it('anno in corso, retta vuota: il campo ha l\'asterisco, il messaggio lo dice prima di inviare', async () => {
    render(<ModuliRicevuti />)
    await apriEScegliClasse('Bruno Neri')
    expect(screen.getByText(/Retta mensile \(€\) \*/)).toBeInTheDocument()
    importa()
    expect(screen.getByLabelText(/Retta mensile/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getAllByText(itAdminAltro.ricevutiErroreRettaMancante).length).toBeGreaterThan(0)
    expect(patch()).toHaveLength(0)
  })
})
