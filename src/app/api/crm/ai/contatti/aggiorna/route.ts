import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi, type CodiceAi } from '@/lib/crm/ai/accesso'
import { chiaveIdempotenza, improntaCorpo } from '@/lib/crm/ai/idempotenza'
import { leggiRichiestaAi } from '@/lib/crm/ai/registro'
import { normalizzaTelefonoAi } from '@/lib/crm/ai/telefono'
import { rispostaCrmNonRiuscita, rispostaErroreDbSchema } from '@/lib/crm/errori'
import { STATI_FAMIGLIA_AI, type EsitoAggiornaSchedaAi } from '@/lib/crm/tipi'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, validationError } from '@/lib/validation/http'

const op = 'crm/ai/contatti/aggiorna'

const campiAmmessi = { error: (issue: { code: string }) =>
  issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined }
const bodySchema = z.strictObject({
  sede: zUuid,
  schedaId: zUuid.optional(),
  telefono: z.string().trim().min(6).max(40).optional(),
  stato: z.enum(STATI_FAMIGLIA_AI).optional(),
  // Il riassunto è un dato della famiglia: entra solo nell'impronta (hash) e nella funzione SQL, mai in un log.
  riassunto: z.string().trim().max(4000).optional(),
  nonContattare: z.literal(true).optional(),
}, campiAmmessi)
  .refine((b) => (b.schedaId === undefined) !== (b.telefono === undefined), {
    path: ['schedaId'], message: 'Indica la scheda o il telefono, uno dei due',
  })
  .refine((b) => b.stato !== undefined || b.riassunto !== undefined || b.nonContattare !== undefined, {
    path: ['stato'], message: 'Indica almeno uno fra stato, riassunto e nonContattare',
  })

type RispostaEsito = { risposta: NextResponse; codice?: CodiceAi; entitaId?: string }

function rispostaDaEsito(dati: EsitoAggiornaSchedaAi | null, ripetuta: boolean, schedaAttesa: string | null): RispostaEsito {
  switch (dati?.esito) {
    case 'aggiornata':
      // Per id la scheda scritta è quella chiesta; per telefono la sceglie la funzione.
      if (schedaAttesa !== null && dati.scheda_id !== schedaAttesa) break
      return {
        risposta: NextResponse.json({
          schedaId: dati.scheda_id,
          stato: dati.stato,
          nonContattare: dati.non_contattare,
          ripetuta,
        }),
        entitaId: dati.scheda_id,
      }
    case 'non_trovata':
      return { risposta: rifiutoAi('SCHEDA_NON_TROVATA', 404), codice: 'SCHEDA_NON_TROVATA' }
    case 'chiave_riusata':
      return { risposta: rifiutoAi('CHIAVE_RIUSATA', 422), codice: 'CHIAVE_RIUSATA' }
    case 'in_corso':
      return { risposta: rifiutoAi('CRM_OPERAZIONE_NON_RIUSCITA', 409), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }
    case 'token_non_valido': {
      const risposta = rifiutoAi('TOKEN_NON_VALIDO', 401)
      risposta.headers.set('WWW-Authenticate', 'Bearer')
      return { risposta, codice: 'TOKEN_NON_VALIDO' }
    }
  }
  logErrore({ operazione: op, stato: 500 }, new Error('Esito inatteso da crm_ai_aggiorna_scheda'))
  return { risposta: rispostaCrmNonRiuscita(), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }
}

// Due scritture sulla stessa scheda che si incrociano possono far abortire una chiamata: si riprova con la stessa chiave.
const CODICI_CONCORRENZA = new Set(['40P01', '40001'])

export const POST = withRoute('crm/ai/contatti/aggiorna:POST', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'aggiorna_scheda')
  if ('response' in g) return g.response
  const { ai } = g

  const b = await parseBody(request, bodySchema)
  if ('response' in b) return chiudiChiamataAi(ai, b.response)

  const altraSede = assertSedeDelToken(ai, b.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const chiave = chiaveIdempotenza(request)
  if (chiave === null) {
    return chiudiChiamataAi(ai, validationError([
      { path: ['Idempotency-Key'], message: 'Header Idempotency-Key mancante o non valido' },
    ]))
  }

  const { schedaId: schedaIdGrezzo, telefono, stato, riassunto, nonContattare } = b.data
  const schedaId = schedaIdGrezzo?.toLowerCase() ?? null
  const telefonoNorm = telefono === undefined ? null : normalizzaTelefonoAi(telefono)
  if (telefono !== undefined && telefonoNorm === null) {
    return chiudiChiamataAi(ai, rifiutoAi('CONTATTO_OBBLIGATORIO', 422), { codice: 'CONTATTO_OBBLIGATORIO' })
  }

  const dati = {
    ...(stato !== undefined && { stato }),
    ...(riassunto !== undefined && { riassunto }),
    ...(nonContattare !== undefined && { non_contattare: nonContattare }),
  }
  // L'impronta non ammette undefined: entrano solo i campi presenti, col telefono già normalizzato.
  const impronta = improntaCorpo({
    operazione: 'aggiorna_scheda',
    sede: ai.scuolaId,
    ...(schedaId !== null && { schedaId }),
    ...(telefonoNorm !== null && { telefono: telefonoNorm }),
    ...dati,
  })
  const supabase = await createAdminClient()

  const registro = await leggiRichiestaAi(supabase, ai, chiave, op)
  if ('response' in registro) return registro.response
  if (registro.riga) {
    if (registro.riga.impronta !== impronta) {
      return chiudiChiamataAi(ai, rifiutoAi('CHIAVE_RIUSATA', 422), { codice: 'CHIAVE_RIUSATA' })
    }
    // Una riga aperta la chiude chi l'ha aperta: la funzione rifiuta argomenti vuoti, quindi qui non si richiama.
    if (registro.riga.risposta === null) {
      return chiudiChiamataAi(ai, rifiutoAi('CRM_OPERAZIONE_NON_RIUSCITA', 409), { codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    }
    const { risposta, codice, entitaId } = rispostaDaEsito(registro.riga.risposta as EsitoAggiornaSchedaAi, true, schedaId)
    return chiudiChiamataAi(ai, risposta, { codice, entitaId })
  }

  const { data, error } = await supabase.rpc('crm_ai_aggiorna_scheda', {
    p_integrazione_id: ai.integrazioneId,
    p_scuola_id: ai.scuolaId,
    p_chiave: chiave,
    p_impronta: impronta,
    p_scheda_id: schedaId,
    p_telefono_norm: telefonoNorm,
    p_dati: dati,
  })
  if (error) {
    const tecnico = erroreDbSoloCodice(error)
    if (tecnico.code && CODICI_CONCORRENZA.has(tecnico.code)) {
      logEvento('crm', 'warn', { operazione: op, esito: 'ai-aggiorna-scheda-concorrenza', scuola_id: ai.scuolaId }, tecnico)
      return chiudiChiamataAi(ai, rifiutoAi('CRM_OPERAZIONE_NON_RIUSCITA', 409), { codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    }
    return chiudiChiamataAi(ai, rispostaErroreDbSchema(tecnico, op))
  }

  const esito = data as EsitoAggiornaSchedaAi | null
  const ripetuta = esito?.esito === 'aggiornata' && esito.ripetuta === true
  const { risposta, codice, entitaId } = rispostaDaEsito(esito, ripetuta, schedaId)
  if (esito?.esito === 'aggiornata' && !ripetuta && risposta.status === 200) {
    logEvento('crm', 'info', {
      operazione: op, esito: 'ai-scheda-aggiornata', scuola_id: ai.scuolaId, entita_id: esito.scheda_id,
    })
  }
  return chiudiChiamataAi(ai, risposta, { codice, entitaId })
})
