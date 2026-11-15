import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'
import itPublic from '../../messages/it/public.json'
import enPublic from '../../messages/en/public.json'

/**
 * Terzo giro (15/11): al passo dell'adulto bisognava riscrivere a mano la residenza identica a quella del bambino
 * («non c'è "uguale al bambino"»). Ora c'è una casella «Stesso indirizzo del bambino» che copia i cinque campi della
 * residenza e, tolta, li svuota. I campi si riconoscono dalla loro mappatura sul database (`alunni.residence_*` ↔
 * `parents.address`/`parents.residence_*`/`parents.zip_code`), non dal testo: un modulo modificato nel builder
 * continua a funzionare. Solo dati finti.
 */

vi.mock('framer-motion', async () => {
  const React = await import('react')
  const strip = (props: Record<string, unknown>) => {
    const { initial, animate, exit, variants, transition, custom, whileHover, whileTap, layout, layoutId, ...rest } = props
    void initial; void animate; void exit; void variants; void transition
    void custom; void whileHover; void whileTap; void layout; void layoutId
    return rest
  }
  const motion = new Proxy({}, {
    get: (_t, tag: string) =>
      React.forwardRef(function M({ children, ...props }: { children?: React.ReactNode }, ref: React.Ref<HTMLElement>) {
        return React.createElement(tag, { ...strip(props), ref }, children)
      }),
  })
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children) }
})

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

const fetchMock = vi.fn()

const t = (id: string, label: string, db: string, ph: string) => ({ id, type: 'text', label, required: false, db_mapping: db, placeholder: ph })

const CON_INDIRIZZO = {
  schema: {
    version: '1',
    pages: [
      {
        id: 'bambino', title: 'Dati del bambino',
        fields: [
          t('nome', 'Nome', 'alunni.nome', 'Nome bimbo'),
          t('residence_address', 'Indirizzo di Residenza', 'alunni.residence_address', 'Via bimbo'),
          t('residence_street_number', 'Numero Civico', 'alunni.residence_street_number', 'Civico bimbo'),
          t('residence_city', 'Comune di Residenza', 'alunni.residence_city', 'Comune bimbo'),
          t('residence_province', 'Provincia di Residenza', 'alunni.residence_province', 'Prov bimbo'),
          t('zip_code', 'CAP', 'alunni.zip_code', 'CAP bimbo'),
        ],
      },
      {
        id: 'adulto', title: 'Adulto',
        fields: [
          t('first_name', 'Nome adulto', 'parents.first_name', 'Nome adulto'),
          t('address', 'Indirizzo di Residenza', 'parents.address', 'Via adulto'),
          t('residence_street_number', 'Numero Civico', 'parents.residence_street_number', 'Civico adulto'),
          t('residence_city', 'Comune di Residenza', 'parents.residence_city', 'Comune adulto'),
          t('residence_province', 'Provincia di Residenza', 'parents.residence_province', 'Prov adulto'),
          t('zip_code', 'CAP', 'parents.zip_code', 'CAP adulto'),
        ],
      },
    ],
  },
}

const SENZA_INDIRIZZO = {
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'Dati del bambino', fields: [t('nome', 'Nome', 'alunni.nome', 'Nome bimbo')] },
      { id: 'adulto', title: 'Adulto', fields: [t('first_name', 'Nome adulto', 'parents.first_name', 'Nome adulto')] },
    ],
  },
}

function mockFetch(modello: unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/iscrizione/model')) return Promise.resolve({ ok: true, json: async () => modello })
    if (url.includes('/api/iscrizione/sedi')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [{ id: SEDE_A, nome: NOME_SEDE_A }] }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

const scrivi = (ph: string, v: string) => fireEvent.change(screen.getByPlaceholderText(ph), { target: { value: v } })
const valore = (ph: string) => (screen.getByPlaceholderText(ph) as HTMLInputElement).value

async function finoAllAdulto() {
  await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
  scrivi('Nome bimbo', 'Alunno1')
  scrivi('Via bimbo', 'Via Finta')
  scrivi('Civico bimbo', '7')
  scrivi('Comune bimbo', 'Cittafinta')
  scrivi('Prov bimbo', 'NA')
  scrivi('CAP bimbo', '80100')
  fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
  await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
}

describe('EnrollmentWizard — «Stesso indirizzo del bambino»', () => {
  it('spuntata, copia i cinque campi della residenza; tolta, li svuota', async () => {
    mockFetch(CON_INDIRIZZO)
    render(<EnrollmentWizard />)
    await finoAllAdulto()

    const casella = screen.getByRole('checkbox', { name: 'Stesso indirizzo del bambino' })
    expect(valore('Via adulto')).toBe('')
    fireEvent.click(casella)
    await waitFor(() => expect(valore('Via adulto')).toBe('Via Finta'))
    expect(valore('Civico adulto')).toBe('7')
    expect(valore('Comune adulto')).toBe('Cittafinta')
    expect(valore('Prov adulto')).toBe('NA')
    expect(valore('CAP adulto')).toBe('80100')

    // Si rilegge la casella: il passo si ridisegna, e il riferimento di prima può non essere più nella pagina.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stesso indirizzo del bambino' }))
    await waitFor(() => expect(valore('Via adulto')).toBe(''))
    expect(valore('CAP adulto')).toBe('')
    expect((screen.getByRole('checkbox', { name: 'Stesso indirizzo del bambino' }) as HTMLInputElement).checked).toBe(false)
  })

  it('un modulo senza i campi della residenza non mostra la casella', async () => {
    mockFetch(SENZA_INDIRIZZO)
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    scrivi('Nome bimbo', 'Alunno1')
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
    expect(screen.queryByRole('checkbox', { name: 'Stesso indirizzo del bambino' })).toBeNull()
  })

  it('il testo esiste in italiano e in inglese', () => {
    expect(itPublic).toHaveProperty('wizardStessoIndirizzo')
    expect(enPublic).toHaveProperty('wizardStessoIndirizzo')
  })
})
