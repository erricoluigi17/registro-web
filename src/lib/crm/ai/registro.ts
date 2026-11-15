import type { NextResponse } from 'next/server'
import { chiudiChiamataAi, type ContestoAi } from '@/lib/crm/ai/accesso'
import { rispostaErroreDbSchema } from '@/lib/crm/errori'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * CRM ASSISTENTE FAMIGLIE · LETTURA DEL REGISTRO DELLE RICHIESTE.
 *
 * La riga della chiave di idempotenza della sede e della chiave API: filtra per sede, integrazione e
 * chiave, non per operazione. Una chiave riusata per un'altra operazione ha un'altra impronta, e chi
 * chiama la rifiuta come `CHIAVE_RIUSATA`. `operazione` serve solo al nome nel log di un guasto.
 */
export async function leggiRichiestaAi(
  supabase: SupabaseClient, ai: ContestoAi, chiave: string, operazione: string,
): Promise<{ riga: { impronta: string; risposta: unknown } | null } | { response: NextResponse }> {
  const { data, error } = await supabase.from('crm_ai_richieste')
    .select('impronta, risposta')
    .eq('scuola_id', ai.scuolaId)
    .eq('integrazione_id', ai.integrazioneId)
    .eq('chiave', chiave)
    .maybeSingle<{ impronta: string; risposta: unknown }>()
  if (error) return { response: chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), operazione)) }
  return { riga: data }
}
