import { afterEach, describe, expect, it, vi } from 'vitest'
import { ambienteVeroAcceso, crmAiAttivo, sedeAmmessaAi, sediAmmesseAi, sediVereAi } from '@/lib/crm/ai/interruttore'
import { SEDE_A, SEDE_B, SEDE_C } from '../../../fixtures/sedi'

afterEach(() => vi.unstubAllEnvs())

describe('interruttore dell’accesso AI', () => {
  it.each([undefined, '', 'true', 'on', 'yes', '0', ' 1', '1 '])('è spento con %s', (valore) => {
    vi.stubEnv('CRM_AI_ATTIVO', valore)
    expect(crmAiAttivo()).toBe(false)
  })

  it('è acceso solo con «1»', () => {
    vi.stubEnv('CRM_AI_ATTIVO', '1')
    expect(crmAiAttivo()).toBe(true)
  })

  it.each([undefined, '', ' , , ', 'qualsiasi'])('senza UUID validi nessuna sede è ammessa (%s)', (valore) => {
    vi.stubEnv('CRM_AI_SEDI_AMMESSE', valore)
    expect(sediAmmesseAi()).toEqual([])
    expect(sedeAmmessaAi(SEDE_A)).toBe(false)
  })

  it('ammette solo gli UUID dell’elenco, senza doppioni e senza badare a spazi e maiuscole', () => {
    vi.stubEnv('CRM_AI_SEDI_AMMESSE', ` ${SEDE_A.toUpperCase()}, ,errata,${SEDE_B},${SEDE_A} `)
    expect(sediAmmesseAi()).toEqual([SEDE_A, SEDE_B])
    expect(sedeAmmessaAi(` ${SEDE_A.toUpperCase()} `)).toBe(true)
    expect(sedeAmmessaAi(SEDE_B)).toBe(true)
    expect(sedeAmmessaAi(SEDE_C)).toBe(false)
    expect(sedeAmmessaAi('errata')).toBe(false)
  })

  describe('sedi vere dietro CRM_AI_VERO', () => {
    it('sede vera rifiutata a interruttore spento anche se è fra le ammesse', () => {
      vi.stubEnv('CRM_AI_SEDI_AMMESSE', `${SEDE_A},${SEDE_B}`)
      vi.stubEnv('CRM_AI_SEDI_VERE', SEDE_B)
      expect(sedeAmmessaAi(SEDE_B)).toBe(false)
      expect(sediAmmesseAi()).toEqual([SEDE_A])
    })

    it('sede vera ammessa con CRM_AI_VERO=1', () => {
      vi.stubEnv('CRM_AI_SEDI_AMMESSE', SEDE_A)
      vi.stubEnv('CRM_AI_SEDI_VERE', SEDE_B)
      vi.stubEnv('CRM_AI_VERO', '1')
      expect(sedeAmmessaAi(SEDE_B)).toBe(true)
      expect(sediAmmesseAi()).toEqual([SEDE_A, SEDE_B])
    })

    it('CRM_AI_VERO=1 non apre una sede che non è in nessun elenco', () => {
      vi.stubEnv('CRM_AI_SEDI_AMMESSE', SEDE_A)
      vi.stubEnv('CRM_AI_SEDI_VERE', SEDE_B)
      vi.stubEnv('CRM_AI_VERO', '1')
      expect(sedeAmmessaAi(SEDE_C)).toBe(false)
    })

    it('la Demo resta ammessa con l’interruttore spento', () => {
      vi.stubEnv('CRM_AI_SEDI_AMMESSE', SEDE_A)
      vi.stubEnv('CRM_AI_SEDI_VERE', SEDE_B)
      expect(sedeAmmessaAi(SEDE_A)).toBe(true)
    })

    it.each([undefined, '', 'true', '0', 'on', ' 1'])('CRM_AI_VERO = %s vale spento', (valore) => {
      vi.stubEnv('CRM_AI_SEDI_VERE', SEDE_B)
      vi.stubEnv('CRM_AI_VERO', valore)
      expect(ambienteVeroAcceso()).toBe(false)
      expect(sedeAmmessaAi(SEDE_B)).toBe(false)
    })

    it('l’elenco delle vere segue le stesse regole di forma delle ammesse', () => {
      vi.stubEnv('CRM_AI_SEDI_VERE', ` ${SEDE_B.toUpperCase()}, ,errata,${SEDE_B} `)
      expect(sediVereAi()).toEqual([SEDE_B])
    })

    it('solo vere con interruttore spento: nessuna sede può entrare', () => {
      vi.stubEnv('CRM_AI_SEDI_AMMESSE', SEDE_B)
      vi.stubEnv('CRM_AI_SEDI_VERE', SEDE_B)
      expect(sediAmmesseAi()).toEqual([])
    })
  })
})
