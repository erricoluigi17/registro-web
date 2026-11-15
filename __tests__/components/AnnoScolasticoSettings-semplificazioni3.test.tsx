import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'

import { SEDE_A } from '../fixtures/sedi'
import type { RigaCalendario } from '@/lib/anno-scolastico'
import type { StatoAnno } from '@/lib/anno/tipi'

// =============================================================================
// Terzo lotto di semplificazioni · F1 · la pagina «Anno scolastico» dopo il terzo giro della segretaria inesperta.
//
//  · una tappa della home apre LA SCHEDA giusta (Quote / Documenti) e porta la pagina al blocco;
//  · ogni pulsante «Salva» dice cosa salva;
//  · prima di aprire le iscrizioni la pagina dice UNA frase sulle classi, non due che si contraddicono;
//  · le spunte le fa la segreteria; la scadenza della quota dice da quando decorre.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore-di-rete' }))

const h = vi.hoisted(() => ({
  perSede: {} as Record<string, readonly unknown[]>,
  query: '',
  sezioni: [] as unknown[],
  moduli: [] as unknown[],
}))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(h.query) }))
vi.mock('@/lib/context/anno-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/anno-context')>()),
  useAnnoOpzionale: () => null,
}))
vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({ perSede: h.perSede, loading: false, errore: false, ricarica: vi.fn() }),
  useCalendarioDi: (sede?: string | null) => (sede ? (h.perSede[sede] ?? null) : null),
}))

import { AnnoScolasticoSettings } from '@/components/features/admin/settings/AnnoScolasticoSettings'

const USER = 'aaaabbbb-1111-4111-8111-dddddddddddd'
const A26 = '22222222-2222-4222-8222-222222222026'
const A27 = '22222222-2222-4222-8222-222222222027'
const S26 = '5ed00000-0000-4000-8000-000000002026'
const S27 = '5ed00000-0000-4000-8000-000000002027'

function riga(anno: 2026 | 2027, stato: StatoAnno): RigaCalendario {
  return {
    annoId: anno === 2026 ? A26 : A27,
    annoSedeId: anno === 2026 ? S26 : S27,
    annoInizio: anno,
    inizio: `${anno}-09-01`,
    fine: `${anno + 1}-08-31`,
    ultimoGiornoAperto: `${anno + 1}-07-31`,
    preparaSuccessivoDal: `${anno + 1}-03-01`,
    stato,
    domandeAperte: false,
  }
}

const scrollIntoView = vi.fn()
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  h.query = ''
  h.sezioni = []
  h.moduli = []
  h.perSede = { [SEDE_A]: [riga(2026, 'corrente'), riga(2027, 'in_preparazione')] }
  Element.prototype.scrollIntoView = scrollIntoView
  fetchMock.mockImplementation((url: string) => {
    const config = /\/(quote|moduli|posti|rette|sezioni)$/.exec(String(url))
    const data: Record<string, unknown> = config
      ? config[1] === 'quote' ? { quote: [] }
        : config[1] === 'moduli' ? { moduli: h.moduli }
          : config[1] === 'sezioni' ? { sezioni: h.sezioni }
            : config[1] === 'rette' ? { rette: [], mesi_effettivi: { retta: [9], servizio: [9] }, fasce_in_uso: [] }
              : { posti: [] }
      : { mancano: ['quota_conferma', 'quota_nuova', 'moduli_conferma', 'moduli_nuova'] }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data }) })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const monta = () => render(<AnnoScolasticoSettings userId={USER} scuolaId={SEDE_A} annoSedeIdIniziale={S27} />)
const scheda = (nome: string) => screen.getByRole('button', { name: nome })

describe('una tappa della home apre la scheda giusta e porta la pagina al blocco', () => {
  it('?tappa=documenti → la scheda «Documenti» è quella aperta', async () => {
    h.query = 'tappa=documenti'
    monta()
    await screen.findByRole('group', { name: 'Quote, documenti, posti e classi' })
    expect(scheda('Documenti')).toHaveAttribute('aria-pressed', 'true')
    expect(scheda('Quote')).toHaveAttribute('aria-pressed', 'false')
  })

  it('?tappa=quote → la scheda «Quote» è quella aperta', async () => {
    h.query = 'tappa=quote'
    monta()
    await screen.findByRole('group', { name: 'Quote, documenti, posti e classi' })
    expect(scheda('Quote')).toHaveAttribute('aria-pressed', 'true')
  })

  it('?tappa=documenti → la pagina scorre fino al blocco «Quote, documenti, posti e classi»', async () => {
    h.query = 'tappa=documenti'
    monta()
    const blocco = await screen.findByRole('group', { name: 'Quote, documenti, posti e classi' })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(scrollIntoView.mock.contexts[0]).toBe(blocco)
  })

  it('?tappa=iscrizioni → la pagina scorre fino al blocco «Apri le iscrizioni»', async () => {
    h.query = 'tappa=iscrizioni'
    monta()
    const blocco = await screen.findByRole('group', { name: 'Apri le iscrizioni' })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(scrollIntoView.mock.contexts[0]).toBe(blocco)
  })

  it('senza ?tappa la pagina non scorre da sola e parte da «Quote»', async () => {
    monta()
    await screen.findByRole('group', { name: 'Quote, documenti, posti e classi' })
    expect(scheda('Quote')).toHaveAttribute('aria-pressed', 'true')
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

describe('ogni pulsante «Salva» dice cosa salva', () => {
  it('le date: «Salva la fine dell’anno» e «Salva le date», mai un «Salva» nudo', async () => {
    monta()
    await screen.findByRole('group', { name: 'Quote, documenti, posti e classi' })
    expect(screen.getByRole('button', { name: 'Salva le date' })).toBeInTheDocument()
    // La fine dell’anno si imposta solo su un anno che ha un successivo: l’anno in corso.
    fireEvent.click(within(screen.getByRole('list', { name: 'Anni scolastici della sede' })).getByRole('button', { name: /^2026\/27/ }))
    expect(screen.getByRole('button', { name: 'Salva la fine dell’anno' })).toBeInTheDocument()
  })

  it('le due quote hanno ciascuna il suo pulsante', async () => {
    monta()
    expect(await screen.findByRole('button', { name: 'Salva la quota di conferma' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Salva la quota di iscrizione' })).toBeInTheDocument()
  })

  it('in tutta la pagina non resta nessun pulsante che si chiami solo «Salva»', async () => {
    monta()
    await screen.findByRole('button', { name: 'Salva la quota di conferma' })
    expect(screen.queryByRole('button', { name: 'Salva' })).toBeNull()
    // …nemmeno nelle altre schede.
    for (const nome of ['Rette', 'Documenti', 'Posti']) {
      fireEvent.click(scheda(nome))
      await waitFor(() => expect(scheda(nome)).toHaveAttribute('aria-pressed', 'true'))
      await waitFor(() => expect(screen.queryByText('Caricamento…')).toBeNull())
      expect(screen.queryByRole('button', { name: 'Salva' })).toBeNull()
    }
  })

  it('la scheda Posti: un «Salva i posti» per fascia, con la fascia nel nome accessibile', async () => {
    h.query = ''
    monta()
    fireEvent.click(scheda('Posti'))
    expect(await screen.findByRole('button', { name: 'Salva i posti: Infanzia' })).toHaveTextContent('Salva i posti')
  })
})

describe('classi: una sola frase, che dice la verità', () => {
  it('prima di aprire le iscrizioni non dice «premi Copia» e dice che si copiano da sole', async () => {
    h.sezioni = []
    monta()
    const classi = await screen.findByRole('group', { name: 'Classi dell’anno' })
    await waitFor(() => expect(within(classi).queryByText('Caricamento…')).toBeNull())
    expect(classi.textContent).toMatch(/si copiano da sole quando apri le iscrizioni/)
    expect(classi.textContent).toMatch(/puoi copiarle adesso/)
    expect(classi.textContent).not.toMatch(/premi/i)
    expect(classi.textContent).not.toMatch(/Non ci sono ancora classi/)
  })

  it('a iscrizioni aperte, con l’elenco vuoto, invita ancora a copiarle', async () => {
    h.perSede = { [SEDE_A]: [riga(2026, 'corrente'), riga(2027, 'iscrizioni_aperte')] }
    h.sezioni = []
    monta()
    const classi = await screen.findByRole('group', { name: 'Classi dell’anno' })
    await waitFor(() => expect(classi.textContent).toMatch(/Non ci sono ancora classi/))
  })
})

describe('parole giuste', () => {
  it('le spunte le fa la segreteria, non le famiglie', async () => {
    h.moduli = [{ lista: 'conferma', codice: 'certificato', titolo: 'Certificato vaccinale', ordine: 1 }]
    monta()
    fireEvent.click(scheda('Documenti'))
    expect(await screen.findByText(/spunte già fatte dalla segreteria/)).toBeInTheDocument()
    expect(screen.queryByText(/spunte già fatte dalle famiglie/)).toBeNull()
  })

  it('la scadenza automatica della quota dice da quando decorre', async () => {
    monta()
    const nota = await screen.findAllByText(/Senza una data, la quota scade dopo trenta giorni/)
    expect(nota[0].textContent).toMatch(/da quando nasce per il bambino/)
    expect(nota[0].textContent).toMatch(/domanda viene accolta/)
    expect(nota[0].textContent).toMatch(/Non conta il giorno in cui salvi qui/)
  })
})
