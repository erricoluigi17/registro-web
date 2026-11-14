import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * Lotto E3 · il modulo delle famiglie SCRIVE il nome della scuola, insieme all'anno.
 *
 * Dalla prova con una segretaria inesperta: «non scrive mai il nome della scuola, quindi chi incolla il
 * link sbagliato non se ne accorge». Il nome arriva dalla stessa API pubblica che già dice gli anni
 * (`/api/iscrizione/anni`, campo `scuola_nome`); quando la sede si sceglie dall'elenco, dall'elenco stesso.
 * Uuid e nomi finti.
 */

vi.mock('framer-motion', async () => {
  const React = await import('react')
  const strip = (props: Record<string, unknown>) => {
    const { initial, animate, exit, variants, transition, custom, whileHover, whileTap, layout, layoutId, ...rest } = props
    void initial; void animate; void exit; void variants; void transition
    void custom; void whileHover; void whileTap; void layout; void layoutId
    return rest
  }
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef(function M({ children, ...props }: { children?: React.ReactNode }, ref: React.Ref<HTMLElement>) {
          return React.createElement(tag, { ...strip(props), ref }, children)
        }),
    },
  )
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children) }
})

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

const A_PROSS = { anno_id: 'a3333333-3333-4333-8333-333333333333', etichetta_breve: '2027/28', ingresso: 'inizio' as const }
const A_CORR = { anno_id: 'a2222222-2222-4222-8222-222222222222', etichetta_breve: '2026/27', ingresso: 'durante' as const }

const modello = {
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'Dati del bambino', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true, placeholder: 'Nome bimbo' }] },
      { id: 'adulto', title: 'Adulto', fields: [{ id: 'first_name', type: 'text', label: 'Nome adulto', required: true, placeholder: 'Nome adulto' }] },
    ],
  },
}

const fetchMock = vi.fn()

function mockFetch(opts: { sedi?: { id: string; nome: string }[]; anni?: unknown[]; scuolaNome?: string | null }) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/iscrizione/model')) return Promise.resolve({ ok: true, json: async () => modello })
    if (url.includes('/api/iscrizione/sedi')) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: opts.sedi ?? [] }) })
    if (url.includes('/api/iscrizione/anni')) {
      const anni = opts.anni ?? [A_PROSS]
      const data: Record<string, unknown> = { anni, scelta: anni.length > 1, chiuso: false }
      if (opts.scuolaNome !== null) data.scuola_nome = opts.scuolaNome ?? NOME_SEDE_A
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

describe('EnrollmentWizard · il nome della scuola in testa', () => {
  it('col link della sede: «Domanda di iscrizione — <scuola> — <anno>» in testa, dal nome che dà l’API degli anni', async () => {
    mockFetch({ anni: [A_PROSS] })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    expect(await screen.findByText(`Domanda di iscrizione — ${NOME_SEDE_A} — 2027/28`)).toBeInTheDocument()
  })

  it('la sede scelta dall’elenco: il nome è quello della sede scelta, non di un’altra', async () => {
    mockFetch({
      sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
      anni: [A_PROSS],
      scuolaNome: null, // l'API degli anni tace: il nome può venire solo dall'elenco, dalla sede scelta
    })
    render(<EnrollmentWizard />)
    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(NOME_SEDE_B) }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    expect(await screen.findByText(`Domanda di iscrizione — ${NOME_SEDE_B} — 2027/28`)).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(`Domanda di iscrizione — ${NOME_SEDE_A}`))).toBeNull()
  })

  it('con due anni la riga col nome compare anche prima della scelta dell’anno, senza l’anno', async () => {
    mockFetch({ anni: [A_CORR, A_PROSS] })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: /2027\/28/ })).toBeInTheDocument())
    expect(screen.getByText(`Domanda di iscrizione — ${NOME_SEDE_A}`)).toBeInTheDocument()
  })

  it('l’API non dice il nome (database in ritardo): nessuna riga, e nessun «undefined» o «null» a schermo', async () => {
    mockFetch({ anni: [A_PROSS], scuolaNome: null })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByText(/Domanda di iscrizione/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/undefined|null/)
  })
})
