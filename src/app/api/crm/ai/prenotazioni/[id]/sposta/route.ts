import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { dataCivile } from '@/i18n/config'
import { notificaVisitaAssegnata } from '@/lib/crm/agenda'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi, type CodiceAi } from '@/lib/crm/ai/accesso'
import { candidatiPer, caricaAgendaAi } from '@/lib/crm/ai/disponibilita'
import { chiaveIdempotenza, improntaCorpo } from '@/lib/crm/ai/idempotenza'
import { leggiRichiestaAi } from '@/lib/crm/ai/registro'
import { rispostaCrmNonRiuscita, rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { EsitoSpostaAi } from '@/lib/crm/tipi'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData, validationError } from '@/lib/validation/http'

const op = 'crm/ai/sposta'
const istante = z.iso.datetime({ offset: true })
  // Gli orari offerti sono rappresentabili con Date senza arrotondare frazioni di millisecondo.
  .refine((valore) => !/\.\d{3}\d*[1-9]/.test(valore), 'Precisione dell’istante non ammessa')

const campiAmmessi = { error: (issue: { code: string }) =>
  issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined }
const bodySchema = z.strictObject({
  sede: zUuid,
  inizio: istante,
  fine: istante,
}, campiAmmessi).refine((b) => Date.parse(b.fine) > Date.parse(b.inizio), {
  path: ['fine'], message: 'La fine deve essere successiva all’inizio',
})

type RispostaEsito = { risposta: NextResponse; codice?: CodiceAi; entitaId?: string }

function rispostaDaEsito(dati: EsitoSpostaAi | null, ripetuta: boolean, id: string): RispostaEsito {
  switch (dati?.esito) {
    case 'spostata':
    case 'invariata':
      if (dati.appuntamento_id !== id) break
      return {
        risposta: NextResponse.json({
          id: dati.appuntamento_id,
          inizio: new Date(dati.inizio).toISOString(),
          fine: new Date(dati.fine).toISOString(),
          schedaId: dati.scheda_id,
          invariata: dati.esito === 'invariata',
          ripetuta,
        }),
        entitaId: dati.appuntamento_id,
      }
    case 'non_trovato':
      return { risposta: rifiutoAi('ELEMENTO_NON_TROVATO', 404), codice: 'ELEMENTO_NON_TROVATO' }
    case 'stato_non_ammesso':
      return { risposta: rifiutoAi('STATO_NON_AMMESSO', 409), codice: 'STATO_NON_AMMESSO' }
    case 'slot_occupato':
      return { risposta: rifiutoAi('SLOT_OCCUPATO', 409), codice: 'SLOT_OCCUPATO' }
    case 'fuori_disponibilita':
      return { risposta: rifiutoAi('FUORI_DISPONIBILITA', 422), codice: 'FUORI_DISPONIBILITA' }
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
  logErrore({ operazione: op, stato: 500 }, new Error('Esito inatteso da crm_ai_sposta'))
  return { risposta: rispostaCrmNonRiuscita(), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }
}

// Due spostamenti che si incrociano possono far abortire una chiamata: si riprova con la stessa chiave.
const CODICI_CONCORRENZA = new Set(['40P01', '40001'])

export const POST = withRoute(
  'crm/ai/prenotazioni/[id]/sposta:POST',
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const g = await requireIntegrazioneAi(request, 'sposta')
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

    const inizio = new Date(b.data.inizio).toISOString()
    const fine = new Date(b.data.fine).toISOString()
    const impronta = improntaCorpo({ operazione: 'sposta', id, sede: ai.scuolaId, inizio, fine })
    const supabase = await createAdminClient()

    const sposta = async (candidati: string[], durataMin: number) => {
      const { data, error } = await supabase.rpc('crm_ai_sposta', {
        p_integrazione_id: ai.integrazioneId,
        p_scuola_id: ai.scuolaId,
        p_chiave: chiave,
        p_impronta: impronta,
        p_appuntamento_id: id,
        p_inizio: inizio,
        p_durata_min: durataMin,
        p_candidati: candidati,
      })
      if (error) {
        const tecnico = erroreDbSoloCodice(error)
        if (tecnico.code && CODICI_CONCORRENZA.has(tecnico.code)) {
          logEvento('crm', 'warn', { operazione: op, esito: 'ai-sposta-concorrenza', scuola_id: ai.scuolaId, entita_id: id }, tecnico)
          return chiudiChiamataAi(ai, rifiutoAi('CRM_OPERAZIONE_NON_RIUSCITA', 409), { codice: 'CRM_OPERAZIONE_NON_RIUSCITA', entitaId: id })
        }
        return chiudiChiamataAi(ai, rispostaErroreDbSchema(tecnico, op))
      }

      const esito = data as EsitoSpostaAi | null
      const ripetuta = (esito?.esito === 'spostata' || esito?.esito === 'invariata') && esito.ripetuta === true
      const { risposta, codice, entitaId } = rispostaDaEsito(esito, ripetuta, id)
      if (esito?.esito === 'spostata' && esito.appuntamento_id === id && !ripetuta) {
        if (esito.assegnata_a !== esito.assegnata_prima) {
          await notificaVisitaAssegnata(supabase, {
            scuolaId: ai.scuolaId,
            appuntamentoId: esito.appuntamento_id,
            inizio: esito.inizio,
            destinatario: esito.assegnata_a,
          })
        }
        logEvento('crm', 'info', {
          operazione: op, esito: 'ai-visita-spostata', scuola_id: ai.scuolaId, entita_id: esito.appuntamento_id,
        })
      }
      return chiudiChiamataAi(ai, risposta, { codice, entitaId })
    }

    const registro = await leggiRichiestaAi(supabase, ai, chiave, op)
    if ('response' in registro) return registro.response
    if (registro.riga) {
      if (registro.riga.impronta !== impronta) {
        return chiudiChiamataAi(ai, rifiutoAi('CHIAVE_RIUSATA', 422), { codice: 'CHIAVE_RIUSATA' })
      }
      // La funzione rilegge il registro sotto blocco: senza risposta registrata decide lei.
      if (registro.riga.risposta === null) return sposta([], 0)
      const { risposta, codice, entitaId } = rispostaDaEsito(registro.riga.risposta as EsitoSpostaAi, true, id)
      return chiudiChiamataAi(ai, risposta, { codice, entitaId })
    }

    const adesso = new Date()
    const giorno = dataCivile(new Date(inizio))
    const agenda = await caricaAgendaAi(supabase, ai.scuolaId, giorno, giorno, adesso, op)
    if ('response' in agenda) return chiudiChiamataAi(ai, agenda.response)

    // Il nuovo orario può sovrapporsi alla visita stessa: la griglia in fascia lo ammette, decide l'SQL.
    const slot = candidatiPer(agenda.liberi, inizio, fine) ?? candidatiPer(agenda.inFascia, inizio, fine)
    if (!slot) return chiudiChiamataAi(ai, rifiutoAi('FUORI_DISPONIBILITA', 422), { codice: 'FUORI_DISPONIBILITA' })
    return sposta(slot.candidati, slot.durataMin)
  },
)
