import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextResponse } from 'next/server'
import { rispostaCrmNonRiuscita, rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { AppuntamentoRow, BambinoRow, SchedaRow } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { meseDiNascita } from './eta'

type Appuntamento = Pick<AppuntamentoRow, 'id' | 'inizio' | 'fine' | 'stato' | 'fissato_via' | 'integrazione_id' | 'promemoria_conferma'>
type AppuntamentoScheda = Appuntamento & Pick<AppuntamentoRow, 'scheda_id'>
type SchedaPerTelefono = Pick<SchedaRow, 'id' | 'creato_via' | 'ai_stato' | 'non_contattare'>
type BambinoScheda = Pick<BambinoRow, 'id' | 'scheda_id' | 'data_nascita' | 'esito' | 'creata_il'>
export const LIMITE_RIGHE_POSTGREST = 1000

export interface VisitaAi {
  id: string
  inizio: string
  fine: string
  stato: Exclude<AppuntamentoRow['stato'], 'annullato'>
  fissataVia: 'segreteria' | 'ai'
  /** Solo la visita fissata da questa stessa chiave, ancora in programma, si può spostare o annullare. */
  modificabile: boolean
  /** Il promemoria è stato confermato dalla famiglia (null: nessuna risposta registrata). */
  confermata: boolean | null
}

export interface BambinoAi {
  id: string
  nascita: string | null
  esito: BambinoRow['esito']
}

interface DettagliScheda {
  visita: VisitaAi | null
  bambini: BambinoAi[]
}

/**
 * Solo la visita fissata da questa stessa chiave, ancora in programma e non ancora finita, si può spostare o annullare
 * (le funzioni SQL rifiutano una visita con `fine <= clock_timestamp()`).
 */
export function visitaModificabile(
  visita: Pick<AppuntamentoRow, 'fissato_via' | 'integrazione_id' | 'stato' | 'fine'>, integrazioneId: string, adesso: Date,
): boolean {
  return visita.fissato_via === 'ai' && visita.integrazione_id === integrazioneId && visita.stato === 'in_programma'
    && Date.parse(visita.fine) > adesso.getTime()
}

/** La prima visita in programma che deve ancora finire, altrimenti l’ultima passata. */
export function visitaDi(appuntamenti: Appuntamento[], adesso: Date, integrazioneId: string): VisitaAi | null {
  const ordinati = appuntamenti
    .filter((v): v is Appuntamento & { stato: VisitaAi['stato'] } => v.stato !== 'annullato')
    .sort((a, b) => Date.parse(a.inizio) - Date.parse(b.inizio) || a.id.localeCompare(b.id))
  const ora = adesso.getTime()
  const visita = ordinati.find((v) => v.stato === 'in_programma' && Date.parse(v.fine) > ora) ?? ordinati.at(-1)
  if (!visita) return null
  return {
    id: visita.id,
    inizio: visita.inizio,
    fine: visita.fine,
    stato: visita.stato,
    fissataVia: visita.fissato_via,
    modificabile: visitaModificabile(visita, integrazioneId, adesso),
    confermata: visita.promemoria_conferma ?? null,
  }
}

/** La scheda attiva più vecchia della sede con quel numero normalizzato. */
export async function schedaPerTelefono(
  supabase: SupabaseClient, scuolaId: string, telefonoNorm: string, operazione: string,
): Promise<{ scheda: SchedaPerTelefono | null } | { response: NextResponse }> {
  const { data, error } = await supabase.from('crm_schede')
    .select('id, creato_via, ai_stato, non_contattare, creata_il')
    .eq('scuola_id', scuolaId)
    .is('anonimizzata_il', null)
    .overlaps('telefoni_norm', [telefonoNorm])
    .order('creata_il', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle<SchedaPerTelefono>()
  if (error) return { response: rispostaErroreDbSchema(erroreDbSoloCodice(error), operazione) }
  return {
    scheda: data
      ? { id: data.id, creato_via: data.creato_via, ai_stato: data.ai_stato, non_contattare: data.non_contattare }
      : null,
  }
}

/** Visite e bambini (solo ID e mese di nascita) delle schede della sede. */
export async function dettagliSchede(
  supabase: SupabaseClient, scuolaId: string, schedaIds: string[], adesso: Date, operazione: string, integrazioneId: string,
): Promise<{ perScheda: Map<string, DettagliScheda> } | { response: NextResponse }> {
  const perScheda = new Map<string, DettagliScheda>()
  if (schedaIds.length === 0) return { perScheda }

  const [appuntamenti, bambini] = await Promise.all([
    supabase.from('crm_appuntamenti')
      .select('id, scheda_id, inizio, fine, stato, fissato_via, integrazione_id, promemoria_conferma')
      .eq('scuola_id', scuolaId)
      .in('scheda_id', schedaIds)
      .neq('stato', 'annullato')
      .overrideTypes<AppuntamentoScheda[], { merge: false }>(),
    supabase.from('crm_bambini')
      .select('id, scheda_id, data_nascita, esito, creata_il')
      .eq('scuola_id', scuolaId)
      .in('scheda_id', schedaIds)
      .order('creata_il', { ascending: true })
      .order('id', { ascending: true })
      .overrideTypes<BambinoScheda[], { merge: false }>(),
  ])
  const errore = appuntamenti.error ?? bambini.error
  if (errore) return { response: rispostaErroreDbSchema(erroreDbSoloCodice(errore), operazione) }

  // Al tetto di PostgREST le righe possono essere state tagliate senza errore.
  if (Math.max(appuntamenti.data?.length ?? 0, bambini.data?.length ?? 0) >= LIMITE_RIGHE_POSTGREST) {
    return { response: rispostaTettoRaggiunto(scuolaId, operazione) }
  }

  const visitePerScheda = new Map<string, Appuntamento[]>()
  for (const visita of appuntamenti.data ?? []) {
    const visite = visitePerScheda.get(visita.scheda_id)
    if (visite) visite.push(visita)
    else visitePerScheda.set(visita.scheda_id, [visita])
  }

  for (const id of schedaIds) {
    perScheda.set(id, { visita: visitaDi(visitePerScheda.get(id) ?? [], adesso, integrazioneId), bambini: [] })
  }
  for (const bambino of bambini.data ?? []) {
    perScheda.get(bambino.scheda_id)?.bambini.push({ id: bambino.id, nascita: meseDiNascita(bambino.data_nascita), esito: bambino.esito })
  }
  return { perScheda }
}

export interface RecapitoScheda {
  /** Il primo numero normalizzato; `null` se la scheda è anonimizzata o non ne ha. */
  telefono: string | null
  nonContattare: boolean
}

/** Telefono e «non contattare» delle schede della sede: nessun nome, nota o riassunto. */
export async function recapitiSchede(
  supabase: SupabaseClient, scuolaId: string, schedaIds: string[], operazione: string,
): Promise<{ perScheda: Map<string, RecapitoScheda> } | { response: NextResponse }> {
  const perScheda = new Map<string, RecapitoScheda>()
  if (schedaIds.length === 0) return { perScheda }

  const { data, error } = await supabase.from('crm_schede')
    .select('id, telefoni_norm, non_contattare, anonimizzata_il')
    .eq('scuola_id', scuolaId)
    .in('id', schedaIds)
    .overrideTypes<Pick<SchedaRow, 'id' | 'telefoni_norm' | 'non_contattare' | 'anonimizzata_il'>[], { merge: false }>()
  if (error) return { response: rispostaErroreDbSchema(erroreDbSoloCodice(error), operazione) }
  if ((data?.length ?? 0) >= LIMITE_RIGHE_POSTGREST) return { response: rispostaTettoRaggiunto(scuolaId, operazione) }

  for (const scheda of data ?? []) {
    perScheda.set(scheda.id, {
      telefono: scheda.anonimizzata_il ? null : scheda.telefoni_norm[0] ?? null,
      nonContattare: scheda.non_contattare,
    })
  }
  return { perScheda }
}

/** Al tetto di PostgREST le righe possono essere state tagliate senza errore: meglio un 500 che un elenco parziale. */
export function rispostaTettoRaggiunto(scuolaId: string, operazione: string): NextResponse {
  logEvento('crm', 'error', {
    operazione, esito: 'max-rows-raggiunto', scuola_id: scuolaId, limite: LIMITE_RIGHE_POSTGREST,
  })
  return rispostaCrmNonRiuscita()
}
