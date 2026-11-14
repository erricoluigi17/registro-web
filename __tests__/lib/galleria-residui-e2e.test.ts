// @vitest-environment node
import { describe, it, expect } from 'vitest'
// @ts-expect-error modulo .mjs senza tipi
import { eResiduoGalleriaE2E, residuiGalleriaE2E } from '../../scripts/lib/galleria-residui-e2e.mjs'

const SEED = 'e2e00000-0000-4000-8000-000000001005'
const DOC = 'e2e00000-0000-4000-8000-000000000202'
const DOC2 = 'e2e00000-0000-4000-8000-000000000207'
const SEDE = 'e2e00000-0000-4000-8000-000000000001'
const ALTRA = '11111111-0000-4000-8000-000000000001'
const P = { idSeminati: [SEED], docentiE2E: [DOC, DOC2], sediE2E: [SEDE] }
const riga = (extra: Record<string, unknown> = {}) => ({
  id: 'f0000000-0000-4000-8000-000000000001', uploaded_by: DOC, scuola_id: SEDE, file_url: 'uploads/abc/foto.png', ...extra,
})

describe('residui della galleria E2E: criterio stretto', () => {
  it('🔴 la foto lasciata da uno spec (docente E2E, sede E2E, file sotto uploads/) è un residuo', () => {
    expect(eResiduoGalleriaE2E(riga(), P)).toBe(true)
  })
  it('senza la colonna `scuola_id` (DB della CI non migrato) l’autore E2E basta; con `null` anche', () => {
    const senza = riga(); delete (senza as Record<string, unknown>).scuola_id
    expect(eResiduoGalleriaE2E(senza, P)).toBe(true)
    expect(eResiduoGalleriaE2E(riga({ scuola_id: null }), P)).toBe(true)
  })
  it('🔴 mai una riga seminata, mai un altro autore, mai un’altra sede, mai una riga senza file sotto uploads/', () => {
    expect(eResiduoGalleriaE2E(riga({ id: SEED }), P)).toBe(false)
    expect(eResiduoGalleriaE2E(riga({ uploaded_by: ALTRA }), P)).toBe(false)
    expect(eResiduoGalleriaE2E(riga({ scuola_id: ALTRA }), P)).toBe(false)
    expect(eResiduoGalleriaE2E(riga({ file_url: null }), P)).toBe(false)
    expect(eResiduoGalleriaE2E(riga({ file_url: 'altro/foto.png' }), P)).toBe(false)
    expect(eResiduoGalleriaE2E(null, P)).toBe(false)
  })
  it('i byte: si tolgono quelli dei residui, mai quelli sotto uploads/e2e/ (file veri del seed)', () => {
    const r = residuiGalleriaE2E([
      riga({ id: 'f0000000-0000-4000-8000-000000000001' }),
      riga({ id: 'f0000000-0000-4000-8000-000000000002', file_url: 'uploads/e2e/impaginazione-video.mp4' }),
      riga({ id: SEED, file_url: 'uploads/e2e/impaginazione-video.mp4' }),
      riga({ id: 'f0000000-0000-4000-8000-000000000003', uploaded_by: ALTRA }),
    ], P)
    expect(r.ids).toEqual(['f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002'])
    expect(r.percorsi).toEqual(['uploads/abc/foto.png'])
  })
})
