import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, ricontrollaChiaveAttiva } from '@/lib/crm/ai/accesso'
import { recapitiSchede } from '@/lib/crm/ai/contatti'
import { rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { AppuntamentoRow } from '@/lib/crm/tipi'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseQuery } from '@/lib/validation/http'

const op = 'crm/ai/prenotazioni/non-venute'
const querySchema = z.strictObject({
  sede: zUuid,
  dopo: z.iso.datetime({ offset: true }),
  dopoId: zUuid.optional(),
}, { error: (issue) => issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined })

type VisitaNonVenuta = Pick<AppuntamentoRow, 'id' | 'scheda_id' | 'inizio' | 'segnato_il'>

export const GET = withRoute('crm/ai/prenotazioni/non-venute:GET', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'non_venute')
  if ('response' in g) return g.response
  const { ai } = g

  const q = parseQuery(request, querySchema)
  if ('response' in q) return chiudiChiamataAi(ai, q.response)

  const altraSede = assertSedeDelToken(ai, q.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const supabase = await createAdminClient()
  const revocata = await ricontrollaChiaveAttiva(supabase, ai)
  if (revocata) return revocata

  const { dopo, dopoId } = q.data
  const selezione = supabase.from('crm_appuntamenti')
    .select('id, scheda_id, inizio, segnato_il')
    .eq('scuola_id', ai.scuolaId)
    .eq('stato', 'non_presentato')

  // ISO e UUID sono già validati. Conserviamo i microsecondi del database nel cursore.
  const pagina = dopoId
    ? selezione.or(`segnato_il.gt."${dopo}",and(segnato_il.eq."${dopo}",id.gt.${dopoId})`)
    : selezione.gt('segnato_il', dopo)
  const { data, error } = await pagina
    .order('segnato_il', { ascending: true })
    .order('id', { ascending: true })
    .limit(100)
    .overrideTypes<VisitaNonVenuta[], { merge: false }>()
  if (error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), op))

  const visite = data ?? []
  const recapiti = await recapitiSchede(supabase, ai.scuolaId, [...new Set(visite.map((v) => v.scheda_id))], op)
  if ('response' in recapiti) return chiudiChiamataAi(ai, recapiti.response)

  const prenotazioni = visite.map((v) => {
    const recapito = recapiti.perScheda.get(v.scheda_id)
    return {
      id: v.id, schedaId: v.scheda_id, inizio: v.inizio, segnataIl: v.segnato_il,
      telefono: recapito?.telefono ?? null, nonContattare: recapito?.nonContattare ?? true,
    }
  })
  const ultima = visite.at(-1)
  return chiudiChiamataAi(ai, NextResponse.json({
    prenotazioni, prossimoDopo: ultima?.segnato_il ?? null, prossimoDopoId: ultima?.id ?? null,
  }, { headers: { 'Cache-Control': 'no-store' } }))
})
