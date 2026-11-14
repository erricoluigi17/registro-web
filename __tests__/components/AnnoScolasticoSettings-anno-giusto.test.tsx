import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

import itSettings from '../../messages/it/adminSettings.json'
import itAnno from '../../messages/it/annoListino.json'
import { SEDE_A } from '../fixtures/sedi'
import type { RigaCalendario } from '@/lib/anno-scolastico'
import type { StatoAnno } from '@/lib/anno/tipi'

// =============================================================================
// Lotto E3 · la pagina «Anno scolastico» apre l'anno GIUSTO.
//
// La prova con una segretaria inesperta: si apriva per prima l'anno IN CORSO (con la sua retta e «Riapri le
// domande»), ed era facilissimo modificare l'anno sbagliato. Ora, se esiste un anno in preparazione o con le
// iscrizioni aperte, si apre quello, con un titolo che non lascia dubbi; l'anno in corso resta raggiungibile
// dall'elenco con un titolo diverso. Anni e date sono quelli del calendario finto: nessun anno scritto a mano
// nella pagina. Il documento da consegnare si chiama «Documenti», non «Moduli».
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore-di-rete' }))

const h = vi.hoisted(() => ({
  perSede: {} as Record<string, readonly unknown[]>,
  anno: null as null | { selezionato: string | null },
}))

vi.mock('@/lib/context/anno-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/anno-context')>()),
  useAnnoOpzionale: () => h.anno,
}))
vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({ perSede: h.perSede, loading: false, errore: false, ricarica: vi.fn() }),
  useCalendarioDi: (sede?: string | null) => (sede ? (h.perSede[sede] ?? null) : null),
}))

import { AnnoScolasticoSettings } from '@/components/features/admin/settings/AnnoScolasticoSettings'

const USER = 'aaaabbbb-1111-4111-8111-dddddddddddd'
const ID = { 2025: '22222222-2222-4222-8222-222222222025', 2026: '22222222-2222-4222-8222-222222222026', 2027: '22222222-2222-4222-8222-222222222027' }
const SD = { 2025: '5ed00000-0000-4000-8000-000000002025', 2026: '5ed00000-0000-4000-8000-000000002026', 2027: '5ed00000-0000-4000-8000-000000002027' }

function riga(anno: 2025 | 2026 | 2027, stato: StatoAnno): RigaCalendario {
  return {
    annoId: ID[anno], annoSedeId: SD[anno], annoInizio: anno,
    inizio: `${anno}-09-01`, fine: `${anno + 1}-08-31`,
    ultimoGiornoAperto: `${anno + 1}-07-31`, preparaSuccessivoDal: `${anno + 1}-03-01`,
    stato, domandeAperte: false,
  }
}

const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  h.anno = null
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const metodo = init?.method ?? 'GET'
    const config = metodo === 'GET' ? /\/(quote|moduli|posti|rette|sezioni)$/.exec(String(url)) : null
    const data: Record<string, unknown> = config
      ? config[1] === 'quote' ? { quote: [] } : config[1] === 'moduli' ? { moduli: [] } : config[1] === 'sezioni' ? { sezioni: [] }
        : config[1] === 'rette' ? { rette: [], mesi_effettivi: { retta: [9], servizio: [9] }, fasce_in_uso: [] } : { posti: [] }
      : { mancano: ['quota_conferma', 'quota_nuova', 'moduli_conferma', 'moduli_nuova'] }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data }) })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const monta = (righe: RigaCalendario[]) => {
  h.perSede = { [SEDE_A]: righe }
  return render(<AnnoScolasticoSettings userId={USER} scuolaId={SEDE_A} />)
}
const titolo = () => screen.getByRole('heading', { level: 4 })
const premuto = (etichetta: string) =>
  within(screen.getByRole('list', { name: itSettings.annoElencoAria })).getByRole('button', { name: new RegExp(`^${etichetta}`) })

describe('Anno scolastico: quale anno si apre per primo', () => {
  it('con un anno IN PREPARAZIONE si apre quello, e il titolo dice che lo si sta preparando', () => {
    monta([riga(2025, 'chiuso'), riga(2026, 'corrente'), riga(2027, 'in_preparazione')])
    expect(premuto('2027/28')).toHaveAttribute('aria-pressed', 'true')
    expect(premuto('2026/27')).toHaveAttribute('aria-pressed', 'false')
    expect(titolo()).toHaveTextContent('Stai preparando il 2027/28')
    expect(titolo()).not.toHaveTextContent('2026/27')
  })

  it('con le ISCRIZIONI APERTE si apre quell’anno, con lo stesso titolo', () => {
    monta([riga(2025, 'chiuso'), riga(2026, 'corrente'), riga(2027, 'iscrizioni_aperte')])
    expect(premuto('2027/28')).toHaveAttribute('aria-pressed', 'true')
    expect(titolo()).toHaveTextContent('Stai preparando il 2027/28')
  })

  it('senza un anno da preparare si apre l’anno in corso, col titolo «Anno in corso»', () => {
    monta([riga(2025, 'chiuso'), riga(2026, 'corrente')])
    expect(premuto('2026/27')).toHaveAttribute('aria-pressed', 'true')
    expect(titolo()).toHaveTextContent('Anno in corso: 2026/27')
    expect(titolo()).not.toHaveTextContent('Stai preparando')
  })

  it('l’anno in corso resta raggiungibile, col suo titolo e con l’invito a preparare l’anno dopo', () => {
    monta([riga(2025, 'chiuso'), riga(2026, 'corrente'), riga(2027, 'in_preparazione')])
    fireEvent.click(premuto('2026/27'))
    expect(titolo()).toHaveTextContent('Anno in corso: 2026/27')
    expect(screen.getByText('Per preparare il 2027/28: scegli la sua riga nell’elenco qui sopra.')).toBeInTheDocument()
  })

  it('l’invito non c’è quando l’anno aperto è già quello che si prepara', () => {
    monta([riga(2026, 'corrente'), riga(2027, 'in_preparazione')])
    expect(screen.queryByText(/Per preparare il/)).toBeNull()
  })

  it('il selettore dell’anno su un anno DIVERSO da quello in corso vince (scelta deliberata)', () => {
    h.anno = { selezionato: ID[2025] }
    monta([riga(2025, 'chiuso'), riga(2026, 'corrente'), riga(2027, 'in_preparazione')])
    expect(premuto('2025/26')).toHaveAttribute('aria-pressed', 'true')
    expect(titolo()).toHaveTextContent('Anno chiuso: 2025/26')
  })

  it('il selettore sull’anno in corso (il suo valore di partenza) non toglie il posto all’anno che si prepara', () => {
    h.anno = { selezionato: ID[2026] }
    monta([riga(2025, 'chiuso'), riga(2026, 'corrente'), riga(2027, 'in_preparazione')])
    expect(premuto('2027/28')).toHaveAttribute('aria-pressed', 'true')
  })

  it('l’anno in chiusura ha il suo titolo', () => {
    monta([riga(2025, 'in_chiusura'), riga(2026, 'corrente')])
    fireEvent.click(premuto('2025/26'))
    expect(titolo()).toHaveTextContent('Anno in chiusura: 2025/26')
  })
})

describe('Anno scolastico: «Documenti da consegnare» al posto di «Moduli»', () => {
  it('la scheda, i due blocchi e i messaggi di ciò che manca usano «documenti»', async () => {
    monta([riga(2026, 'corrente'), riga(2027, 'in_preparazione')])
    expect(await screen.findByText('Mancano: quota di conferma, quota di nuova iscrizione, documenti per la conferma, documenti per la nuova iscrizione')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itAnno.schedaModuli })).toHaveTextContent('Documenti')
    fireEvent.click(screen.getByRole('button', { name: itAnno.schedaModuli }))
    expect(await screen.findByRole('group', { name: 'Documenti da consegnare: per chi conferma' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Documenti da consegnare: per chi si iscrive' })).toBeInTheDocument()
  })

  it('nessun testo della sezione dice più «moduli» (il modulo per le famiglie è un’altra cosa)', async () => {
    monta([riga(2026, 'corrente'), riga(2027, 'in_preparazione')])
    await screen.findByText(/Mancano:/)
    fireEvent.click(screen.getByRole('button', { name: itAnno.schedaModuli }))
    await screen.findByRole('group', { name: /per chi conferma/ })
    const testo = (document.body.textContent ?? '').replace(/Il modulo per le famiglie/g, '')
    expect(testo).not.toMatch(/\bmoduli?\b/i)
  })

  it('il catalogo: «Quote e documenti ci sono», e in inglese la stessa chiave esiste', async () => {
    const en = (await import('../../messages/en/adminSettings.json')).default as Record<string, string>
    expect(itSettings.annoIscrizioniPronte).toBe('Quote e documenti ci sono: puoi aprire le iscrizioni.')
    for (const chiave of ['annoTitoloPreparazione', 'annoTitoloInCorso', 'annoTitoloInChiusura', 'annoTitoloChiuso', 'annoInvitoPreparare']) {
      expect(en[chiave], chiave).toBeTruthy()
      expect((itSettings as Record<string, string>)[chiave], chiave).toBeTruthy()
    }
  })
})
