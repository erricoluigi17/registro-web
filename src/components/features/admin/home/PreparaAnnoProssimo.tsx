'use client';

/**
 * LA SCHEDA «PREPARA L'ANNO PROSSIMO» della home Direzione e segreteria.
 *
 * Perché esiste (prova di usabilità 2026-11, segretaria nuova sulla sede Demo): «per una persona nuova non
 * c'è un punto di partenza e le tappe stanno in tre posti diversi del menu». Qui le sei tappe stanno in
 * fila, nell'ordine in cui si fanno, ognuna con il suo stato e un link che porta proprio alla pagina.
 *
 * Non fa niente di nuovo: legge ciò che le pagine vere già leggono.
 *  · il calendario (`useCalendario`) dice QUALE anno è in preparazione e con le iscrizioni aperte;
 *  · `GET /api/admin/anni/[id]` dice cosa manca per aprire le iscrizioni (solo prima di aprirle);
 *  · `GET /api/admin/anni/[id]/cruscotto` dà confermati e chi non ha risposto (solo a iscrizioni aperte:
 *    prima risponderebbe 409);
 *  · la data del passaggio è il giorno dopo l'ultimo giorno aperto dell'anno attivo, come la calcola il
 *    programma (`anno-prossimo.ts`).
 *
 * Con più sedi attive e nessuna scelta non indovina: chiede di sceglierla (una scrittura sulla sede sbagliata
 * archivia nel plesso sbagliato, in silenzio). Senza un anno da preparare, o per chi non è staff di
 * Direzione/segreteria, non si monta affatto.
 *
 * Le tappe che dipendono dal selettore dell'anno (conferme, «a che punto siamo», passaggio) al clic scelgono
 * l'anno nuovo: altrimenti la pagina si apre sull'anno in corso e dice «iscrizioni non aperte».
 */

import { useEffect, useState } from 'react';
import Link, { useLinkStatus } from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, CalendarCheck, Loader2 } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { useSediAttive } from '@/lib/context/sede-context';
import { useCalendario } from '@/lib/context/calendario-context';
import { useAnnoOpzionale } from '@/lib/context/anno-context';
import { useRuoloCockpit } from '@/lib/context/admin-identity';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { logClient, nomeErrore } from '@/lib/logging/client';
import {
  costruisciTappe,
  hrefTappa,
  trovaAnnoDaPreparare,
  type AnnoDaPreparare,
  type IdTappa,
  type LettureAnno,
  type StatoTappa,
  type Tappa,
} from './anno-prossimo';

const RUOLI = new Set(['admin', 'coordinator', 'segreteria']);

/** Le tappe che nella pagina di arrivo leggono l'anno dal selettore e non dall'indirizzo. */
const DIPENDONO_DAL_SELETTORE = new Set<IdTappa>(['conferme', 'puntoSituazione', 'passaggio']);

const CHIAVE_TITOLO: Record<IdTappa, string> = {
  quote: 'preparaTappaQuote',
  documenti: 'preparaTappaDocumenti',
  iscrizioni: 'preparaTappaIscrizioni',
  conferme: 'preparaTappaConferme',
  puntoSituazione: 'preparaTappaPunto',
  passaggio: 'preparaTappaPassaggio',
};

const TONO: Record<StatoTappa | 'caricamento', BadgeTone> = {
  fatto: 'success',
  da_fare: 'warn',
  in_corso: 'inCorso',
  non_disponibile: 'neutral',
  sconosciuto: 'error',
  caricamento: 'neutral',
};

const CHIAVE_STATO: Record<StatoTappa, string> = {
  fatto: 'preparaStatoFatto',
  da_fare: 'preparaStatoDaFare',
  in_corso: 'preparaStatoInCorso',
  non_disponibile: 'preparaStatoNonAncora',
  sconosciuto: 'preparaStatoSconosciuto',
};

type Lettura = { chiave: string; letture: LettureAnno };

/** Una GET che non lancia mai: `null` se la rete cade o il server non risponde bene (e lo registra, senza dati). */
async function leggi(url: string, userId: string, operazione: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { 'x-user-id': userId } });
    if (!res.ok) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — richiesta non riuscita`, stato: res.status });
      return null;
    }
    const corpo: unknown = await res.json().catch((err: unknown) => {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — corpo illeggibile: ${nomeErrore(err)}`, stato: res.status });
      return null;
    });
    const data = (corpo as { data?: unknown } | null)?.data;
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch (err: unknown) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — ${nomeErrore(err)}` });
    return null;
  }
}

/**
 * Il segno che il clic è arrivato. Sta DENTRO il `Link` perché `useLinkStatus` legge lo stato del suo Link: finché la pagina
 * di arrivo non è pronta (2-3 secondi) dice «Un attimo…» e mette `aria-busy`, così nessuno clicca due volte pensando che sia
 * rotto. Al posto della freccia gira una rotellina; il riquadro della riga si colora da solo (`has-[…]` sul Link).
 * Niente `loading.tsx` alla radice di `app/`: ha già rotto l'hydration.
 */
function SegnoCaricamento() {
  const t = useTranslations('adminNav');
  const { pending } = useLinkStatus();
  return (
    <span className="flex items-center gap-1.5" data-pending={pending ? 'true' : undefined} aria-busy={pending}>
      <span role="status" className={pending ? 'font-maven text-xs font-semibold text-kidville-green' : 'sr-only'}>
        {pending ? t('preparaCaricamento') : ''}
      </span>
      {pending ? (
        <Loader2 size={16} aria-hidden="true" className="animate-spin text-kidville-green motion-reduce:animate-none" />
      ) : (
        <ArrowRight size={16} aria-hidden="true" className="text-kidville-neutral/60 transition-all group-hover:translate-x-1 group-hover:text-kidville-green" />
      )}
    </span>
  );
}

const numero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function PreparaAnnoProssimo({ userId, withUser }: { userId: string | null; withUser: (href: string) => string }) {
  const ruolo = useRuoloCockpit();
  const { effettive } = useSediAttive();
  const { perSede } = useCalendario();

  if (!RUOLI.has(ruolo)) return null;
  const esito = trovaAnnoDaPreparare(perSede, effettive);
  if (esito.tipo === 'nessuna') return null;
  if (esito.tipo === 'scegli_sede') return <ScegliSede />;
  return <Scheda key={`${esito.anno.annoSedeId}:${esito.anno.stato}`} anno={esito.anno} userId={userId} withUser={withUser} />;
}

function Contenitore({ children }: { children: React.ReactNode }) {
  const t = useTranslations('adminNav');
  return (
    <section
      data-kv-prepara-anno
      aria-labelledby="prepara-anno-titolo"
      className="mt-6 rounded-2xl border border-kidville-line bg-kidville-white p-4 shadow-sm sm:p-5"
    >
      <h3 id="prepara-anno-titolo" className="flex items-center gap-2 font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">
        <CalendarCheck size={20} aria-hidden="true" /> {t('preparaTitolo')}
      </h3>
      {children}
    </section>
  );
}

function ScegliSede() {
  const t = useTranslations('adminNav');
  return (
    <Contenitore>
      <p className="mt-2 font-maven text-sm text-kidville-ink/80">{t('preparaScegliSede')}</p>
    </Contenitore>
  );
}

function Scheda({ anno, userId, withUser }: { anno: AnnoDaPreparare; userId: string | null; withUser: (href: string) => string }) {
  const t = useTranslations('adminNav');
  const locale = useLocale();
  const annoCtx = useAnnoOpzionale();
  const chiave = `${anno.annoSedeId}:${anno.stato}:${userId ?? ''}`;
  const [lettura, setLettura] = useState<Lettura | null>(null);

  useEffect(() => {
    if (!userId) return;
    let attivo = true;
    const base = `/api/admin/anni/${anno.annoSedeId}`;
    const fine = (letture: LettureAnno) => {
      if (attivo) setLettura({ chiave, letture });
    };
    if (anno.stato === 'iscrizioni_aperte') {
      leggi(`${base}/cruscotto`, userId, 'admin/anni/cruscotto:GET').then((d) => {
        const r = d?.risposte;
        const risposte = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : null;
        fine({
          mancano: null,
          cruscotto: risposte ? { confermati: numero(risposte.confermati), nonRisposto: numero(risposte.non_risposto) } : null,
        });
      });
    } else {
      leggi(base, userId, 'admin/anni:GET').then((d) => {
        const m = d?.mancano;
        fine({
          mancano: Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : null,
          cruscotto: null,
        });
      });
    }
    return () => {
      attivo = false;
    };
  }, [anno.annoSedeId, anno.stato, userId, chiave]);

  // Finché la lettura non è arrivata (o l'identità non è risolta) le tappe che ne dipendono dicono «…»,
  // non «non riesco a leggerlo»: sono due cose diverse.
  const caricato = lettura?.chiave === chiave;
  const tappe = costruisciTappe(anno, lettura?.chiave === chiave ? lettura.letture : { mancano: null, cruscotto: null }, oggiFiscaleISO());

  const dataLunga = (ymd: string) => {
    const [a, m, g] = ymd.split('-').map(Number);
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(a, m - 1, g)));
  };

  const dettaglio = (tp: Tappa): string => {
    switch (tp.id) {
      case 'quote':
        return tp.stato === 'da_fare' ? t('preparaQuoteDaFare') : t('preparaQuoteFatto');
      case 'documenti':
        return tp.stato === 'da_fare' ? t('preparaDocumentiDaFare') : t('preparaDocumentiFatto');
      case 'iscrizioni':
        return tp.stato === 'fatto'
          ? t('preparaIscrizioniAperte')
          : `${t('preparaIscrizioniChiuse')}${tp.classiSenzaFascia ? ` ${t('preparaIscrizioniSenzaFascia')}` : ''}`;
      case 'conferme':
        return tp.stato === 'in_corso'
          ? t('preparaConfermeConteggi', { confermati: tp.confermati ?? 0, nonRisposto: tp.nonRisposto ?? 0 })
          : t('preparaConfermeNonAncora');
      case 'puntoSituazione':
        return tp.stato === 'in_corso' ? t('preparaPuntoAperto') : t('preparaPuntoNonAncora');
      case 'passaggio':
        return tp.apribileDal
          ? t(tp.pronto ? 'preparaPassaggioPronto' : 'preparaPassaggioDal', { data: dataLunga(tp.apribileDal) })
          : t('preparaPassaggioSenzaData');
    }
  };

  // Un indirizzo con la sua query riceve `&userId=`, uno senza `?userId=`: la home lo fa già in `withUser`.
  const href = (id: IdTappa) => withUser(hrefTappa(id, anno));

  return (
    <Contenitore>
      <p className="mt-1 font-maven text-sm text-kidville-ink/70">{t('preparaIntro', { anno: anno.etichetta })}</p>
      <ol className="mt-3 divide-y divide-kidville-line">
        {tappe.map((tp, i) => {
          const titolo = t(CHIAVE_TITOLO[tp.id]);
          const inAttesaDiLettura = !caricato && tp.stato === 'sconosciuto';
          return (
            <li key={tp.id}>
              <Link
                href={href(tp.id)}
                aria-label={t('preparaVaiAria', { tappa: titolo })}
                onClick={() => {
                  if (DIPENDONO_DAL_SELETTORE.has(tp.id) && annoCtx && annoCtx.selezionato !== anno.annoId) annoCtx.scegli(anno.annoId);
                }}
                className="group flex min-h-[48px] items-start gap-3 rounded-xl px-1 py-3 hover:bg-kidville-cream has-[[data-pending=true]]:bg-kidville-green-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-kidville-green"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-kidville-green-soft font-barlow text-sm font-black text-kidville-green"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-barlow text-[15px] font-extrabold uppercase text-kidville-green">{titolo}</span>
                  <span className="mt-0.5 block font-maven text-sm text-kidville-ink/75">{dettaglio(tp)}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                  <Badge tone={inAttesaDiLettura ? TONO.caricamento : TONO[tp.stato]}>
                    {inAttesaDiLettura ? t('caricamento') : t(CHIAVE_STATO[tp.stato])}
                  </Badge>
                  <SegnoCaricamento />
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </Contenitore>
  );
}
