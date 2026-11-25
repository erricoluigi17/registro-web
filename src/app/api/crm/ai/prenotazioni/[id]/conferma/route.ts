import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi, type CodiceAi } from '@/lib/crm/ai/accesso'
import { chiaveIdempotenza, improntaCorpo } from '@/lib/crm/ai/idempotenza'
import { leggiRichiestaAi } from '@/lib/crm/ai/registro'
import { rispostaCrmNonRiuscita, rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { EsitoConfermaAi } from '@/lib/crm/tipi'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData, validationError } from '@/lib/validation/http'

const op = 'crm/ai/conferma'

const campiAmmessi = { error: (issue: { code: string }) =>
  issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined }
const bodySchema = z.strictObject({
  sede: zUuid,
  confermata: z.boolean(),
}, campiAmmessi)

type RispostaEsito = { risposta: NextResponse; codice?: CodiceAi; entitaId?: string }

function rispostaDaEsito(dati: EsitoConfermaAi | null, ripetuta: boolean, id: string): RispostaEsito {
  switch (dati?.esito) {
    case 'registrata':
      if (dati.appuntamento_id !== id) break
      return {
        risposta: NextResponse.json({ id: dati.appuntamento_id, confermata: dati.confermata, ripetuta }),
        entitaId: dati.appuntamento_id,
      }
    case 'non_trovato':
      return { risposta: rifiutoAi('ELEMENTO_NON_TROVATO', 404), codice: 'ELEMENTO_NON_TROVATO' }
    case 'stato_non_ammesso':
      return { risposta: rifiutoAi('STATO_NON_AMMESSO', 409), codice: 'STATO_NON_AMMESSO' }
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
  logErrore({ operazione: op, stato: 500 }, new Error('Esito inatteso da crm_ai_conferma'))
  return { risposta: rispostaCrmNonRiuscita(), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }
}

// Due chiamate che si incrociano possono far abortire una: si riprova con la stessa chiave.
const CODICI_CONCORRENZA = new Set(['40P01', '40001'])

// Nessuna notifica: l'avviso alla sede lo manda il motore.
export const POST = withRoute(
  'crm/ai/prenotazioni/[id]/conferma:POST',
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const g = await requireIntegrazioneAi(request, 'conferma')
    if ('response' in g) return g.response
    const { ai } = g

    const p = parseData(zUuid, (await context.params).id)
    if ('response' in p) return chiudiChiamataAi(ai, p.response)
    const id = p.data.toLowerCase()

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

    const { confermata } = b.data
    const impronta = improntaCorpo({ operazione: 'conferma', id, sede: ai.scuolaId, confermata })
    const supabase = await createAdminClient()

    const registro = await leggiRichiestaAi(supabase, ai, chiave, op)
    if ('response' in registro) return registro.response
    if (registro.riga) {
      if (registro.riga.impronta !== impronta) {
        return chiudiChiamataAi(ai, rifiutoAi('CHIAVE_RIUSATA', 422), { codice: 'CHIAVE_RIUSATA' })
      }
      // Una riga ancora senza risposta è una chiamata in corso: si riprova più tardi, senza toccare l'rpc.
      if (registro.riga.risposta === null) {
        return chiudiChiamataAi(ai, rifiutoAi('CRM_OPERAZIONE_NON_RIUSCITA', 409), { codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
      }
      const { risposta, codice, entitaId } = rispostaDaEsito(registro.riga.risposta as EsitoConfermaAi, true, id)
      return chiudiChiamataAi(ai, risposta, { codice, entitaId })
    }

    const { data, error } = await supabase.rpc('crm_ai_conferma', {
      p_integrazione_id: ai.integrazioneId,
      p_scuola_id: ai.scuolaId,
      p_chiave: chiave,
      p_impronta: impronta,
      p_appuntamento_id: id,
      p_confermata: confermata,
    })
    if (error) {
      const tecnico = erroreDbSoloCodice(error)
      if (tecnico.code && CODICI_CONCORRENZA.has(tecnico.code)) {
        logEvento('crm', 'warn', { operazione: op, esito: 'ai-conferma-concorrenza', scuola_id: ai.scuolaId, entita_id: id }, tecnico)
        return chiudiChiamataAi(ai, rifiutoAi('CRM_OPERAZIONE_NON_RIUSCITA', 409), { codice: 'CRM_OPERAZIONE_NON_RIUSCITA', entitaId: id })
      }
      return chiudiChiamataAi(ai, rispostaErroreDbSchema(tecnico, op))
    }

    const esito = data as EsitoConfermaAi | null
    const ripetuta = esito?.esito === 'registrata' && esito.ripetuta === true
    const { risposta, codice, entitaId } = rispostaDaEsito(esito, ripetuta, id)
    if (esito?.esito === 'registrata' && esito.appuntamento_id === id && !ripetuta) {
      logEvento('crm', 'info', {
        operazione: op, esito: 'ai-visita-confermata', scuola_id: ai.scuolaId, entita_id: esito.appuntamento_id,
      })
    }
    return chiudiChiamataAi(ai, risposta, { codice, entitaId })
  },
)
