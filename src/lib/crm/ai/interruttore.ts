/**
 * CRM ASSISTENTE FAMIGLIE · INTERRUTTORE E SEDI.
 *
 * Il canale è spento salvo attivazione esplicita. Anche quando è acceso, una sede
 * senza UUID nell'elenco configurato resta fuori: una voce vuota non apre tutte le sedi.
 */

import { formaConfronto } from '@/lib/auth/scope'

const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function crmAiAttivo(): boolean {
  return process.env.CRM_AI_ATTIVO === '1'
}

function elencoUuid(valore: string | undefined): string[] {
  const sedi = (valore ?? '').split(',').map(formaConfronto)
  return [...new Set(sedi.filter((sede) => FORMA_UUID.test(sede)))]
}

/** Le sedi vere (le scuole reali): entrano solo con CRM_AI_VERO=1. */
export function sediVereAi(): string[] {
  return elencoUuid(process.env.CRM_AI_SEDI_VERE)
}

/** Secondo interruttore, spento di default: apre le sedi elencate in CRM_AI_SEDI_VERE. */
export function ambienteVeroAcceso(): boolean {
  return process.env.CRM_AI_VERO === '1'
}

/**
 * Le sedi effettivamente ammesse: le ammesse tolte le vere, più le vere se l'ambiente vero è acceso.
 * Una vera scritta per sbaglio fra le ammesse non entra a interruttore spento.
 */
export function sediAmmesseAi(): string[] {
  const vere = sediVereAi()
  const demo = elencoUuid(process.env.CRM_AI_SEDI_AMMESSE).filter((sede) => !vere.includes(sede))
  return ambienteVeroAcceso() ? [...new Set([...demo, ...vere])] : demo
}

export function sedeAmmessaAi(scuolaId: string): boolean {
  return sediAmmesseAi().includes(formaConfronto(scuolaId))
}
