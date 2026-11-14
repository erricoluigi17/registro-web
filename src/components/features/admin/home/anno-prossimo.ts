/**
 * La scheda «Prepara l'anno prossimo» della home Direzione: la parte PURA (nessun React, nessuna rete).
 *
 * La prova di usabilità con una segretaria nuova (2026-11, sede Demo) ha trovato che le tappe per
 * preparare l'anno dopo stavano in tre punti diversi del menu e che nessuno diceva da dove cominciare.
 * Qui si decide QUALE anno si sta preparando (e per quale sede) e si mettono in fila le sei tappe, nell'ordine
 * in cui si fanno, con il loro stato. I numeri e le date arrivano dalle API che già esistono (impostazioni
 * dell'anno, cruscotto) e dal calendario: questo file non inventa niente e non indovina la sede.
 */
import { annoAttivoDelCalendario, etichettaAnno, type Calendario } from '@/lib/anno-scolastico';

export type StatoAnnoDaPreparare = 'in_preparazione' | 'iscrizioni_aperte';

export interface AnnoDaPreparare {
  scuolaId: string;
  /** `anni_scolastici.id`: serve a scegliere l'anno nel selettore. */
  annoId: string;
  /** `anni_sede.id`: l'anno nuovo di QUESTA sede. */
  annoSedeId: string;
  /** '2027/28'. */
  etichetta: string;
  stato: StatoAnnoDaPreparare;
  /** Il giorno dopo l'ultimo giorno aperto dell'anno attivo, come lo calcola il programma per il passaggio. */
  apribileDal: string | null;
}

export type EsitoScheda =
  | { tipo: 'nessuna' }
  | { tipo: 'scegli_sede' }
  | { tipo: 'anno'; anno: AnnoDaPreparare };

const DA_PREPARARE = new Set<string>(['in_preparazione', 'iscrizioni_aperte']);

/** 'AAAA-MM-GG' + 1 giorno, stringa su stringa (nessun fuso). `null` se la data non è valida. */
export function giornoDopo(ymd: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const [a, mese, g] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(a, mese - 1, g));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mese - 1 || d.getUTCDate() !== g) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function annoDaPreparareDi(scuolaId: string, calendario: Calendario | undefined): AnnoDaPreparare | null {
  let scelto: Calendario[number] | null = null;
  for (const r of calendario ?? []) {
    if (!DA_PREPARARE.has(r.stato)) continue;
    if (!scelto || r.annoInizio < scelto.annoInizio) scelto = r;
  }
  if (!scelto) return null;
  const attivo = annoAttivoDelCalendario(calendario);
  return {
    scuolaId,
    annoId: scelto.annoId,
    annoSedeId: scelto.annoSedeId,
    etichetta: etichettaAnno(scelto.annoInizio, 'breve'),
    stato: scelto.stato as StatoAnnoDaPreparare,
    apribileDal: attivo ? giornoDopo(attivo.ultimoGiornoAperto) : null,
  };
}

/**
 * Quale anno si sta preparando.
 *  · una sola sede attiva: il suo anno in preparazione (o con le iscrizioni aperte), se c'è;
 *  · più sedi attive e almeno una ha un anno da preparare: la scheda chiede di sceglierne una (non indovina:
 *    una scrittura sulla sede sbagliata finisce nel plesso sbagliato, in silenzio);
 *  · altrimenti niente scheda.
 */
export function trovaAnnoDaPreparare(perSede: Record<string, Calendario>, sediAttive: string[]): EsitoScheda {
  const trovati = sediAttive
    .map((id) => annoDaPreparareDi(id, perSede[id]))
    .filter((a): a is AnnoDaPreparare => a !== null);
  if (trovati.length === 0) return { tipo: 'nessuna' };
  if (sediAttive.length > 1) return { tipo: 'scegli_sede' };
  return { tipo: 'anno', anno: trovati[0] };
}

export type IdTappa = 'quote' | 'documenti' | 'iscrizioni' | 'conferme' | 'puntoSituazione' | 'passaggio';
export type StatoTappa = 'fatto' | 'da_fare' | 'in_corso' | 'non_disponibile' | 'sconosciuto';

export interface Tappa {
  id: IdTappa;
  stato: StatoTappa;
  /** Solo `iscrizioni`: manca anche la fascia di qualche classe. */
  classiSenzaFascia?: boolean;
  /** Solo `conferme`. */
  confermati?: number;
  nonRisposto?: number;
  /** Solo `passaggio`. */
  apribileDal?: string | null;
  pronto?: boolean;
}

/** Ciò che le API hanno risposto. `null` = lettura non riuscita o non fatta. */
export interface LettureAnno {
  /** `GET /api/admin/anni/[id]`: i prerequisiti che mancano per aprire le iscrizioni. */
  mancano: string[] | null;
  /** `GET /api/admin/anni/[id]/cruscotto`: solo con le iscrizioni aperte. */
  cruscotto: { confermati: number; nonRisposto: number } | null;
}

const CODICI_QUOTE = ['quota_conferma', 'quota_nuova'];
const CODICI_DOCUMENTI = ['moduli_conferma', 'moduli_nuova'];

/** Le sei tappe, nell'ordine in cui si fanno. `oggi` è 'AAAA-MM-GG' nel fuso di Roma. */
export function costruisciTappe(anno: AnnoDaPreparare, letture: LettureAnno, oggi: string): Tappa[] {
  const aperte = anno.stato === 'iscrizioni_aperte';
  const mancano = letture.mancano;

  // Con le iscrizioni aperte i prerequisiti sono per forza soddisfatti: il programma non le apre altrimenti.
  const prerequisito = (codici: string[]): StatoTappa => {
    if (aperte) return 'fatto';
    if (mancano === null) return 'sconosciuto';
    return mancano.some((m) => codici.includes(m)) ? 'da_fare' : 'fatto';
  };

  const conferme: Tappa = aperte
    ? letture.cruscotto
      ? {
          id: 'conferme',
          stato: 'in_corso',
          confermati: letture.cruscotto.confermati,
          nonRisposto: letture.cruscotto.nonRisposto,
        }
      : { id: 'conferme', stato: 'sconosciuto' }
    : { id: 'conferme', stato: 'non_disponibile' };

  return [
    { id: 'quote', stato: prerequisito(CODICI_QUOTE) },
    { id: 'documenti', stato: prerequisito(CODICI_DOCUMENTI) },
    {
      id: 'iscrizioni',
      stato: aperte ? 'fatto' : 'da_fare',
      ...(!aperte && mancano?.includes('classi_senza_fascia') ? { classiSenzaFascia: true } : {}),
    },
    conferme,
    { id: 'puntoSituazione', stato: aperte ? 'in_corso' : 'non_disponibile' },
    {
      id: 'passaggio',
      stato: 'da_fare',
      apribileDal: anno.apribileDal,
      pronto: anno.apribileDal !== null && oggi >= anno.apribileDal,
    },
  ];
}

/** Dove porta ogni tappa (senza `userId`: lo aggiunge la pagina). Gli indirizzi sono quelli del menu. */
export function hrefTappa(id: IdTappa, anno: { annoSedeId: string }): string {
  switch (id) {
    case 'quote':
    case 'documenti':
    case 'iscrizioni':
      return `/admin/impostazioni?sezione=anno&anno_sede=${anno.annoSedeId}`;
    case 'conferme':
      return '/admin/students/conferme';
    case 'puntoSituazione':
      return '/admin/students/anno-prossimo';
    case 'passaggio':
      return '/admin/students/passaggio';
  }
}
