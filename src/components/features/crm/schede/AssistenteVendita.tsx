'use client'

import { useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BellOff } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Btn } from '@/components/ui/Btn'
import { STATI_FAMIGLIA_AI, type SchedaRow, type StatoFamigliaAi } from '@/lib/crm/tipi'
import { useDateFormat } from '@/lib/i18n/date'
import { messaggioErrore } from '@/lib/ui/esito-fetch'
import { chiama, scrittura } from './rete'
import { MESSAGGIO_ERRORE, RIQUADRO, TESTO_SECONDARIO, TITOLO_SEZIONE } from './stile'
import { etichetta } from './vocabolari'

/**
 * CRM della segreteria · CHE COSA HA FATTO L'ASSISTENTE DELLA VENDITA CON UNA FAMIGLIA.
 *
 * L'assistente scrive sulla scheda tre cose (`POST /api/crm/ai/contatti/aggiorna`): a che punto è la famiglia
 * (`ai_stato`), un riassunto della conversazione (`ai_riassunto`) e se la famiglia ha chiesto di non essere più
 * contattata (`non_contattare`). Fin qui nessuna schermata le mostrava, e l'assistente poteva accendere il rifiuto
 * senza che una persona potesse vederlo o spegnerlo: è la condizione che il contratto delle porte
 * (`docs/crm-ai-porte.md`, «Prima di accendere `CRM_AI_VERO`») metteva prima di aprire le sedi vere.
 *
 * ── Due pezzi, uno in cima alla scheda e uno in mezzo ─────────────────────────────────────────────
 *  · `AvvisoNonContattare` — in CIMA, solo quando il rifiuto è acceso: dice la data e ha il comando per toglierlo;
 *  · `RiquadroAssistente`  — il riquadro con stato, riassunto e ora dell'ultimo aggiornamento. Quando il rifiuto è
 *    spento ospita il comando per rimetterlo (la segreteria lo segna anche per chi lo chiede al telefono).
 * Tutti e due chiedono una conferma PRIMA di salvare: togliere il rifiuto vuol dire che l'assistente può tornare a
 * scrivere a quella famiglia.
 *
 * ── Prima della migrazione le colonne non ci sono ─────────────────────────────────────────────────
 * Le righe che arrivano dalla route non hanno `non_contattare` (la `select('*')` non può portare una colonna che il
 * database non ha). Allora i due pezzi NON si disegnano — `colonneVendita(scheda)` è falso — e il resto della scheda
 * è quello di sempre. Il riassunto è testo di una famiglia: si mostra qui e non entra mai in un log.
 */

/** La scheda porta le colonne della vendita? (Senza la migrazione del 15/11/2026 non c'è nemmeno `non_contattare`.) */
export function colonneVendita(scheda: Partial<SchedaRow>): boolean {
  return typeof scheda.non_contattare === 'boolean'
}

const eStatoAssistente = (v: unknown): v is StatoFamigliaAi => typeof v === 'string' && (STATI_FAMIGLIA_AI as readonly string[]).includes(v)

/** Il tono del badge per ogni stato: verde se la famiglia va avanti, giallo se serve una persona, rosso se è finita. */
const TONO_STATO: Record<StatoFamigliaAi, BadgeTone> = {
  nuova: 'neutral',
  contattata: 'neutral',
  in_conversazione: 'inCorso',
  appuntamento: 'info',
  confermato: 'success',
  venuta: 'success',
  non_venuta: 'warn',
  non_risponde: 'warn',
  non_interessata: 'neutral',
  non_contattare: 'error',
  a_una_persona: 'evidenza',
}

const urlScheda = (schedaId: string) => `/api/admin/crm/schede/${encodeURIComponent(schedaId)}`

// ════════════════════════════════════════════════════════════════════════════════════════════════
// IL COMANDO: toglie o rimette «non contattare», dopo una conferma
// ════════════════════════════════════════════════════════════════════════════════════════════════

function ComandoNonContattare({ schedaId, acceso, onCambiato }: { schedaId: string; acceso: boolean; onCambiato: () => void }) {
  const t = useTranslations('crmSchede')
  const [conferma, setConferma] = useState(false)
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)
  // Un secondo clic mentre il primo è in volo non deve far partire un secondo salvataggio.
  const inVolo = useRef(false)

  // `acceso` è lo stato di adesso: il comando porta la scheda dall'altra parte.
  const prefisso = acceso ? 'nonContattareTogli' : 'nonContattareSegna'

  const salva = async () => {
    if (inVolo.current) return
    inVolo.current = true
    setInCorso(true)
    setErrore(null)
    const res = await chiama('non-contattare', urlScheda(schedaId), scrittura('PATCH', { nonContattare: !acceso }))
    let rilettura = false
    if (res === null) setErrore(t('nonContattareErrore'))
    else if (!res.ok) setErrore(await messaggioErrore(res, t('nonContattareErrore')))
    else rilettura = true
    inVolo.current = false
    setInCorso(false)
    if (rilettura) {
      setConferma(false)
      onCambiato()
    }
  }

  return (
    <div className="space-y-2">
      {conferma ? (
        <div role="group" aria-label={t(`${prefisso}Domanda`)} className="flex flex-col gap-2 rounded-card border border-kidville-line bg-kidville-white p-3">
          <p className="font-maven text-sm font-bold text-kidville-ink">{t(`${prefisso}Domanda`)}</p>
          <p className="font-maven text-xs text-kidville-sub">{t(`${prefisso}Dettaglio`)}</p>
          <div className="flex flex-wrap gap-2">
            <Btn variant={acceso ? 'primary' : 'danger'} size="sm" disabled={inCorso} onClick={() => void salva()}>
              {t(`${prefisso}Conferma`)}
            </Btn>
            <Btn variant="ghost" size="sm" disabled={inCorso} onClick={() => setConferma(false)}>
              {t('annulla')}
            </Btn>
          </div>
        </div>
      ) : (
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => {
            setErrore(null)
            setConferma(true)
          }}
        >
          {t(prefisso)}
        </Btn>
      )}
      {errore !== null && (
        <p role="alert" className={MESSAGGIO_ERRORE}>
          {errore}
        </p>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// IN CIMA ALLA SCHEDA
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Il rifiuto acceso, ben visibile in cima alla scheda. Non si disegna se è spento o se la migrazione non c'è. */
export function AvvisoNonContattare({ scheda, onCambiato }: { scheda: SchedaRow; onCambiato: () => void }) {
  const t = useTranslations('crmSchede')
  const date = useDateFormat()
  if (scheda.non_contattare !== true) return null
  return (
    <section aria-label={t('nonContattareTitolo')} className="space-y-3 rounded-card border-2 border-kidville-error-strong bg-kidville-error-soft p-4">
      <div className="flex flex-wrap items-center gap-2">
        <BellOff size={18} aria-hidden="true" className="shrink-0 text-kidville-error-strong" />
        <h3 className="font-barlow text-base font-black uppercase text-kidville-error-strong">{t('nonContattareTitolo')}</h3>
        {typeof scheda.non_contattare_il === 'string' && (
          <span className="font-maven text-xs font-semibold text-kidville-error-strong">{t('nonContattareDal', { data: date.dataLunga(scheda.non_contattare_il) })}</span>
        )}
      </div>
      <p className="font-maven text-sm text-kidville-ink">{t('nonContattareAvviso')}</p>
      <ComandoNonContattare schedaId={scheda.id} acceso onCambiato={onCambiato} />
    </section>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// IL RIQUADRO
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Stato, riassunto e ora dell'ultimo aggiornamento. Si disegna sempre quando le colonne ci sono (anche se
 * l'assistente non ha scritto niente: serve a dire che è così, e ospita il comando per rimettere «non contattare»).
 */
export function RiquadroAssistente({ scheda, onCambiato }: { scheda: SchedaRow; onCambiato: () => void }) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const date = useDateFormat()
  const id = useId()
  if (!colonneVendita(scheda)) return null

  const stato = eStatoAssistente(scheda.ai_stato) ? scheda.ai_stato : null
  const riassunto = typeof scheda.ai_riassunto === 'string' && scheda.ai_riassunto.trim() !== '' ? scheda.ai_riassunto : null
  const aggiornata = typeof scheda.ai_aggiornata_il === 'string' ? scheda.ai_aggiornata_il : null
  const vuoto = stato === null && riassunto === null

  return (
    <section aria-labelledby={id} className={`${RIQUADRO} space-y-3`}>
      <h3 id={id} className={TITOLO_SEZIONE}>
        {t('assistenteTitolo')}
      </h3>

      {vuoto ? (
        <p className={TESTO_SECONDARIO}>{t('assistenteVuoto')}</p>
      ) : (
        <dl className="space-y-3">
          {stato !== null && (
            <div>
              <dt className={TESTO_SECONDARIO}>{t('assistenteStato')}</dt>
              <dd className="mt-1">
                <Badge tone={TONO_STATO[stato]}>{etichetta(tc, 'statiAssistente', stato)}</Badge>
              </dd>
            </div>
          )}
          {riassunto !== null && (
            <div>
              <dt className={TESTO_SECONDARIO}>{t('assistenteRiassunto')}</dt>
              {/* A capo come l'ha scritto l'assistente; fino a 4000 caratteri, quindi la riga scorre invece di allungare la scheda. */}
              <dd className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-maven text-sm text-kidville-ink">{riassunto}</dd>
            </div>
          )}
          {aggiornata !== null && <p className={TESTO_SECONDARIO}>{t('assistenteAggiornata', { quando: date.dataOra(aggiornata) })}</p>}
        </dl>
      )}

      {/* Acceso, il comando sta nell'avviso in cima alla scheda; spento, sta qui. */}
      {scheda.non_contattare === false && <ComandoNonContattare schedaId={scheda.id} acceso={false} onCambiato={onCambiato} />}
    </section>
  )
}
