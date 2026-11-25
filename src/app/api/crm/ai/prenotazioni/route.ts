import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, ricontrollaChiaveAttiva } from '@/lib/crm/ai/accesso'
import { LIMITE_RIGHE_POSTGREST, recapitiSchede, rispostaTettoRaggiunto, visitaModificabile } from '@/lib/crm/ai/contatti'
import { rispostaErroreDbSchema, rispostaCrmNonRiuscita } from '@/lib/crm/errori'
import type { AppuntamentoRow } from '@/lib/crm/tipi'
import { addGiorni } from '@/lib/format/data'
import { inizioGiornoCivile } from '@/lib/format/confini-giorno'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { parseQuery } from '@/lib/validation/http'

const op = 'crm/ai/prenotazioni'
const querySchema = z.strictObject({
  sede: zUuid,
  giorno: zDataYMD,
}, { error: (issue) => issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined })

type VisitaGiorno = Pick<AppuntamentoRow, 'id' | 'scheda_id' | 'inizio' | 'fine' | 'stato' | 'fissato_via' | 'integrazione_id' | 'promemoria_conferma'>

export const GET = withRoute('crm/ai/prenotazioni:GET', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'prenotazioni_giorno')
  if ('response' in g) return g.response
  const { ai } = g

  const q = parseQuery(request, querySchema)
  if ('response' in q) return chiudiChiamataAi(ai, q.response)

  const altraSede = assertSedeDelToken(ai, q.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const { giorno } = q.data
  const da = inizioGiornoCivile(giorno)
  const a = inizioGiornoCivile(addGiorni(giorno, 1))
  // `zDataYMD` garantisce un giorno esistente: gli estremi null sono solo il tetto dell'anno 9999.
  if (!da || !a) return chiudiChiamataAi(ai, rispostaCrmNonRiuscita())

  const supabase = await createAdminClient()
  const revocata = await ricontrollaChiaveAttiva(supabase, ai)
  if (revocata) return revocata

  const { data, error } = await supabase.from('crm_appuntamenti')
    .select('id, scheda_id, inizio, fine, stato, fissato_via, integrazione_id, promemoria_conferma')
    .eq('scuola_id', ai.scuolaId)
    .eq('stato', 'in_programma')
    .gte('inizio', da)
    .lt('inizio', a)
    .order('inizio', { ascending: true })
    .order('id', { ascending: true })
    .overrideTypes<VisitaGiorno[], { merge: false }>()
  if (error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), op))

  const visite = data ?? []
  if (visite.length >= LIMITE_RIGHE_POSTGREST) return chiudiChiamataAi(ai, rispostaTettoRaggiunto(ai.scuolaId, op))

  const recapiti = await recapitiSchede(supabase, ai.scuolaId, [...new Set(visite.map((v) => v.scheda_id))], op)
  if ('response' in recapiti) return chiudiChiamataAi(ai, recapiti.response)

  const adesso = new Date()
  const prenotazioni = visite.map((v) => {
    const recapito = recapiti.perScheda.get(v.scheda_id)
    return {
      id: v.id, schedaId: v.scheda_id, inizio: v.inizio, fine: v.fine,
      fissataVia: v.fissato_via, modificabile: visitaModificabile(v, ai.integrazioneId, adesso),
      confermata: v.promemoria_conferma ?? null,
      telefono: recapito?.telefono ?? null, nonContattare: recapito?.nonContattare ?? true,
    }
  })
  return chiudiChiamataAi(ai, NextResponse.json({ sede: ai.scuolaId, giorno, prenotazioni }, { headers: { 'Cache-Control': 'no-store' } }))
})
