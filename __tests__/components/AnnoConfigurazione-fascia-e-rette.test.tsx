import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itAnno from '../../messages/it/annoListino.json'
import { AnnoConfigurazione } from '@/components/features/admin/settings/AnnoConfigurazione'

// =============================================================================
// Lotto E3 · «fascia» spiegata e RETTE senza doppioni.
//
// Dalla prova con una segretaria inesperta:
//  · «Fascia» non è mai spiegata, e «Le sezioni non hanno ancora una fascia: vale la retta senza fascia» confonde.
//    Ora una frase breve dice cos'è; quando nessuna classe ha una fascia la scelta sparisce e si dice che la
//    retta vale per tutti.
//  · Nella scheda Rette compariva la riga «Tutte le fasce € 150,00 MODIFICA TOGLI» e, sotto, già un modulo con 150
//    dentro: sembravano due rette. Ora la stessa retta è una cosa sola.
// Uuid e importi finti.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore-di-rete' }))

const ANNO = '44444444-4444-4444-8444-444444444441'
const USER = '11111111-1111-4111-8111-111111111111'
const DIECI = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6]

type RigaRetta = { voce: 'retta'; fascia: string | null; payment_category_id: null; importo: number; mesi: null }
type RigaQuota = { voce: string; fascia: string | null; importo: number; scadenza: null }
const retta = (fascia: string | null, importo: number): RigaRetta => ({ voce: 'retta', fascia, payment_category_id: null, importo, mesi: null })

const fetchMock = vi.fn()
let lettura: { rette: RigaRetta[]; fasce: string[]; quote: RigaQuota[]; mesi?: number[] }

const risposta = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  lettura = { rette: [], fasce: [], quote: [] }
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const metodo = init?.method ?? 'GET'
    if (metodo !== 'GET') return risposta({ success: true, data: { cambiato: true } })
    if (String(url).endsWith('/rette')) {
      return risposta({ success: true, data: { rette: lettura.rette, mesi_effettivi: { retta: lettura.mesi ?? DIECI, servizio: DIECI }, fasce_in_uso: lettura.fasce } })
    }
    if (String(url).endsWith('/quote')) return risposta({ success: true, data: { quote: lettura.quote } })
    return risposta({ success: true, data: { quote: [], moduli: [], posti: [], sezioni: [] } })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')
const corpoPut = () => JSON.parse(String(puts()[puts().length - 1][1].body)) as Record<string, unknown>

async function apriRette() {
  render(<AnnoConfigurazione userId={USER} annoSedeId={ANNO} stato="in_preparazione" onCambiata={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: itAnno.schedaRette }))
  return screen.findByRole('group', { name: itAnno.retteTitolo })
}
async function apriQuote() {
  render(<AnnoConfigurazione userId={USER} annoSedeId={ANNO} stato="in_preparazione" onCambiata={() => {}} />)
  return screen.findByRole('group', { name: itAnno.quotaNuovaTitolo })
}

describe('Rette: nessuna classe ha una fascia', () => {
  it('niente scelta della fascia: si dice che la retta vale per tutti i bambini', async () => {
    const g = await apriRette()
    await within(g).findByText(itAnno.retteSenzaFasce)
    expect(itAnno.retteSenzaFasce).toMatch(/tutti i bambini/)
    expect(within(g).queryByLabelText(itAnno.etichettaFascia)).toBeNull()
    expect(within(g).queryByRole('combobox')).toBeNull()
  })

  it('la retta salvata è UNA cosa sola: nessuna riga con «Modifica» e un modulo già pieno sotto', async () => {
    lettura.rette = [retta(null, 150)]
    const g = await apriRette()
    const campo = (await within(g).findByLabelText(itAnno.etichettaImporto)) as HTMLInputElement
    expect(campo.value).toBe('150')
    expect(within(g).queryByRole('button', { name: itAnno.modifica })).toBeNull()
    expect(within(g).queryByRole('list')).toBeNull()
    // Il campo dice che è la retta già salvata, e che per cambiarla basta scrivere e salvare.
    expect(within(g).getByText(itAnno.retteSalvataNelCampo)).toBeInTheDocument()
    expect(within(g).getAllByRole('button', { name: itAnno.togli })).toHaveLength(1)
  })

  it('cambiare l’importo e premere Salva scrive la retta per tutti (fascia null)', async () => {
    lettura.rette = [retta(null, 150)]
    const g = await apriRette()
    fireEvent.change(await within(g).findByLabelText(itAnno.etichettaImporto), { target: { value: '300' } })
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(corpoPut()).toEqual({ voce: 'retta', fascia: null, importo: 300 })
  })
})

describe('Rette: alcune classi hanno una fascia', () => {
  it('la fascia è spiegata in una frase', async () => {
    lettura.fasce = ['infanzia']
    lettura.rette = [retta(null, 150)]
    const g = await apriRette()
    expect(await within(g).findByText(itAnno.fasciaSpiega)).toBeInTheDocument()
    expect(itAnno.fasciaSpiega).toMatch(/gruppo d’età/)
  })

  it('le righe sono un elenco e il modulo NON c’è finché non si preme «Modifica» o «Aggiungi»', async () => {
    lettura.fasce = ['infanzia']
    lettura.rette = [retta(null, 150), retta('infanzia', 280)]
    const g = await apriRette()
    expect(await within(g).findAllByRole('listitem')).toHaveLength(2)
    expect(within(g).queryByLabelText(itAnno.etichettaImporto)).toBeNull()
    expect(within(g).queryByRole('button', { name: itAnno.salva })).toBeNull()
  })

  it('«Modifica» apre il modulo SULLA riga scelta: fascia fissa, importo già dentro, e lo dice', async () => {
    lettura.fasce = ['infanzia']
    lettura.rette = [retta(null, 150), retta('infanzia', 280)]
    const g = await apriRette()
    const righe = await within(g).findAllByRole('listitem')
    fireEvent.click(within(righe[1]).getByRole('button', { name: itAnno.modifica }))
    const campo = within(g).getByLabelText(itAnno.etichettaImporto) as HTMLInputElement
    expect(campo.value).toBe('280')
    expect(within(g).getByText('Stai cambiando la retta: Infanzia')).toBeInTheDocument()
    expect(within(g).queryByLabelText(itAnno.etichettaFascia)).toBeNull()
    fireEvent.change(campo, { target: { value: '290' } })
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(corpoPut()).toEqual({ voce: 'retta', fascia: 'infanzia', importo: 290 })
  })

  it('«Aggiungi» apre il modulo vuoto, e la scelta offre solo le fasce che non hanno ancora una riga', async () => {
    lettura.fasce = ['infanzia']
    lettura.rette = [retta(null, 150), retta('infanzia', 280)]
    const g = await apriRette()
    fireEvent.click(await within(g).findByRole('button', { name: itAnno.retteAggiungi }))
    const scelta = within(g).getByLabelText(itAnno.etichettaFascia) as HTMLSelectElement
    const voci = Array.from(scelta.options).map((o) => o.textContent)
    expect(voci).not.toContain(itAnno.fasciaTutte)
    expect(voci).not.toContain(itAnno.fasciaInfanzia)
    expect(voci).toContain(itAnno.fasciaPrimaria)
    expect((within(g).getByLabelText(itAnno.etichettaImporto) as HTMLInputElement).value).toBe('')
  })

  it('con tutte le fasce già coperte (Tutte + una riga per fascia) «Aggiungi» non c\'è: non riscriverebbe la riga «Tutte» in silenzio', async () => {
    lettura.fasce = ['infanzia']
    lettura.rette = [retta(null, 150), ...['nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini'].map((f) => retta(f, 280))]
    const g = await apriRette()
    expect(await within(g).findAllByRole('listitem')).toHaveLength(7)
    expect(within(g).queryByRole('button', { name: itAnno.retteAggiungi })).toBeNull()
  })

  it('«Aggiungi» c\'è se manca solo la riga «Tutte» (nessuna fascia libera ma «Tutte» libera)', async () => {
    lettura.fasce = ['infanzia']
    lettura.rette = ['nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini'].map((f) => retta(f, 280))
    const g = await apriRette()
    expect(await within(g).findByRole('button', { name: itAnno.retteAggiungi })).toBeInTheDocument()
  })

  it('senza nessuna retta il modulo c’è subito (non c’è niente da modificare)', async () => {
    lettura.fasce = ['infanzia']
    const g = await apriRette()
    expect(await within(g).findByLabelText(itAnno.etichettaImporto)).toBeInTheDocument()
    expect(within(g).queryByRole('button', { name: itAnno.retteAggiungi })).toBeNull()
  })

  it('dopo il salvataggio il modulo si richiude: resta l’elenco', async () => {
    lettura.fasce = ['infanzia']
    lettura.rette = [retta(null, 150), retta('infanzia', 280)]
    const g = await apriRette()
    const righe = await within(g).findAllByRole('listitem')
    fireEvent.click(within(righe[1]).getByRole('button', { name: itAnno.modifica }))
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    await waitFor(() => expect(within(g).queryByLabelText(itAnno.etichettaImporto)).toBeNull())
  })
})

describe('Rette: un anno che si può solo leggere', () => {
  it('si vedono le rette come testo, senza campi né pulsanti che scrivono', async () => {
    lettura.rette = [retta(null, 180)]
    render(<AnnoConfigurazione userId={USER} annoSedeId={ANNO} stato="chiuso" onCambiata={() => {}} />)
    const g = await screen.findByRole('group', { name: itAnno.retteTitolo })
    expect(await within(g).findByText('180,00', { exact: false })).toBeInTheDocument()
    expect(within(g).queryByRole('textbox')).toBeNull()
    expect(within(g).queryByRole('button')).toBeNull()
  })

  it('si vede su quali mesi vale la retta (quelli del database, nomi dalla lingua), anche per le righe per fascia', async () => {
    lettura.fasce = ['infanzia']
    lettura.rette = [retta(null, 180), retta('infanzia', 250)]
    lettura.mesi = [9, 10, 11]
    render(<AnnoConfigurazione userId={USER} annoSedeId={ANNO} stato="in_chiusura" onCambiata={() => {}} />)
    const g = await screen.findByRole('group', { name: itAnno.retteTitolo })
    const righe = await within(g).findAllByRole('listitem')
    expect(righe).toHaveLength(2)
    for (const r of righe) expect(r.textContent).toMatch(/Mesi: settembre, ottobre e novembre/)
  })

  it('una sola retta per tutti, sola lettura: anche lì i mesi si leggono', async () => {
    lettura.rette = [retta(null, 180)]
    lettura.mesi = [9, 10]
    render(<AnnoConfigurazione userId={USER} annoSedeId={ANNO} stato="chiuso" onCambiata={() => {}} />)
    const g = await screen.findByRole('group', { name: itAnno.retteTitolo })
    expect(await within(g).findByText(/Mesi: settembre e ottobre/)).toBeInTheDocument()
  })
})

describe('Quote: la fascia c’è solo se serve', () => {
  it('nessuna classe ha una fascia: la scelta non c’è e si dice che la quota vale per tutti', async () => {
    const g = await apriQuote()
    await within(g).findByText(itAnno.quotaSenzaFasce)
    expect(within(g).queryByLabelText(itAnno.etichettaFascia)).toBeNull()
    // …e il resto del modulo (importo, scadenza, Salva) c’è.
    expect(within(g).getByLabelText(itAnno.etichettaImporto)).toBeInTheDocument()
  })

  it('con una fascia in uso la scelta c’è, con la frase che spiega cos’è', async () => {
    lettura.fasce = ['nido_1']
    const g = await apriQuote()
    expect(await within(g).findByLabelText(itAnno.etichettaFascia)).toBeInTheDocument()
    expect(screen.getAllByText(itAnno.fasciaSpiega).length).toBeGreaterThan(0)
  })

  it('una quota già salvata per una fascia tiene visibile la scelta anche se nessuna classe l’ha (si deve poterla cambiare)', async () => {
    lettura.quote = [{ voce: 'quota_nuova', fascia: 'primaria', importo: 100, scadenza: null }]
    const g = await apriQuote()
    expect(await within(g).findByLabelText(itAnno.etichettaFascia)).toBeInTheDocument()
  })

  it('«Tutte le fasce» non compare come nome di riga quando nessuna classe ha una fascia: «Per tutti i bambini»', async () => {
    lettura.quote = [{ voce: 'quota_nuova', fascia: null, importo: 100, scadenza: null }]
    const g = await apriQuote()
    expect(await within(g).findByText(itAnno.fasciaPerTutti)).toBeInTheDocument()
    expect(within(g).queryByText(itAnno.fasciaTutte)).toBeNull()
  })
})
