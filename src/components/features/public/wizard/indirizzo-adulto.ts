import type { FormField } from '@/types/database.types'

/**
 * Le cinque coppie «campo della residenza del bambino → campo della residenza dell'adulto», nei nomi della
 * mappatura sul database (`alunni.<x>` ↔ `parents.<y>`). Servono alla casella «Stesso indirizzo del bambino»
 * del passo dell'adulto (terzo giro di prova, 15/11).
 */
const COPPIE: ReadonlyArray<readonly [string, string]> = [
  ['residence_address', 'address'],
  ['residence_street_number', 'residence_street_number'],
  ['residence_city', 'residence_city'],
  ['residence_province', 'residence_province'],
  ['zip_code', 'zip_code'],
]

function trova(campi: FormField[], tabella: 'alunni' | 'parents', colonna: string): FormField | undefined {
  // Prima la mappatura sul database (stabile anche se il builder cambia id ed etichetta); in mancanza,
  // l'id del modello predefinito.
  return campi.find((f) => f.db_mapping === `${tabella}.${colonna}`)
    ?? campi.find((f) => !f.db_mapping && f.id === colonna)
}

/**
 * Le coppie di id (del bambino e dell'adulto) che esistono DAVVERO nel modulo in uso: un campo tolto dal
 * builder da una delle due parti toglie la sua coppia, e senza coppie la casella non si mostra.
 */
export function coppieIndirizzo(campiBambino: FormField[], campiAdulto: FormField[]): Array<{ da: string; a: string }> {
  const coppie: Array<{ da: string; a: string }> = []
  for (const [c, a] of COPPIE) {
    const fb = trova(campiBambino, 'alunni', c)
    const fa = trova(campiAdulto, 'parents', a)
    if (fb && fa) coppie.push({ da: fb.id, a: fa.id })
  }
  return coppie
}
