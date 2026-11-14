import { describe, it, expect } from 'vitest';
import type { Calendario } from '@/lib/anno-scolastico';
import {
  trovaAnnoDaPreparare,
  costruisciTappe,
  giornoDopo,
  hrefTappa,
} from '@/components/features/admin/home/anno-prossimo';

/**
 * La parte PURA della scheda «Prepara l'anno prossimo» della home Direzione: quale anno si sta
 * preparando (e per quale sede), e le sei tappe nell'ordine giusto con il loro stato.
 */

const SEDE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SEDE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NUOVO_A = 'a0000000-0000-4000-8000-0000000000a2';

function cal(sede: 'A' | 'B', statoNuovo: 'in_preparazione' | 'iscrizioni_aperte' | 'corrente' | 'chiuso' | null): Calendario {
  const corrente = {
    annoId: `anno-corrente-${sede}`,
    annoSedeId: `as-corrente-${sede}`,
    annoInizio: 2026,
    inizio: '2026-09-01',
    fine: '2027-08-31',
    ultimoGiornoAperto: '2027-07-31',
    preparaSuccessivoDal: '2027-03-01',
    stato: 'corrente' as const,
    domandeAperte: false,
  };
  if (statoNuovo === null) return [corrente];
  return [
    corrente,
    {
      annoId: `anno-nuovo-${sede}`,
      annoSedeId: sede === 'A' ? NUOVO_A : `as-nuovo-${sede}`,
      annoInizio: 2027,
      inizio: '2027-09-01',
      fine: '2028-08-31',
      ultimoGiornoAperto: '2028-07-31',
      preparaSuccessivoDal: '2028-03-01',
      stato: statoNuovo,
      domandeAperte: false,
    },
  ];
}

describe('trovaAnnoDaPreparare', () => {
  it('con una sola sede e un anno in preparazione lo trova, con etichetta e data del passaggio', () => {
    const r = trovaAnnoDaPreparare({ [SEDE_A]: cal('A', 'in_preparazione') }, [SEDE_A]);
    expect(r.tipo).toBe('anno');
    if (r.tipo !== 'anno') return;
    expect(r.anno.annoSedeId).toBe(NUOVO_A);
    expect(r.anno.annoId).toBe('anno-nuovo-A');
    expect(r.anno.stato).toBe('in_preparazione');
    expect(r.anno.etichetta).toBe('2027/28');
    // il giorno dopo l'ultimo giorno aperto dell'anno attivo (2027-07-31)
    expect(r.anno.apribileDal).toBe('2027-08-01');
  });

  it('riconosce anche le iscrizioni aperte', () => {
    const r = trovaAnnoDaPreparare({ [SEDE_A]: cal('A', 'iscrizioni_aperte') }, [SEDE_A]);
    expect(r.tipo === 'anno' && r.anno.stato).toBe('iscrizioni_aperte');
  });

  it('senza un anno in preparazione la scheda non c\'è', () => {
    expect(trovaAnnoDaPreparare({ [SEDE_A]: cal('A', null) }, [SEDE_A]).tipo).toBe('nessuna');
    expect(trovaAnnoDaPreparare({ [SEDE_A]: cal('A', 'corrente') }, [SEDE_A]).tipo).toBe('nessuna');
    expect(trovaAnnoDaPreparare({ [SEDE_A]: cal('A', 'chiuso') }, [SEDE_A]).tipo).toBe('nessuna');
    expect(trovaAnnoDaPreparare({}, [SEDE_A]).tipo).toBe('nessuna');
  });

  it('con più sedi attive e un anno da preparare chiede di scegliere la sede, senza indovinare', () => {
    const r = trovaAnnoDaPreparare(
      { [SEDE_A]: cal('A', 'in_preparazione'), [SEDE_B]: cal('B', null) },
      [SEDE_A, SEDE_B],
    );
    expect(r.tipo).toBe('scegli_sede');
  });

  it('con più sedi attive ma nessun anno da preparare non c\'è nulla da chiedere', () => {
    const r = trovaAnnoDaPreparare({ [SEDE_A]: cal('A', null), [SEDE_B]: cal('B', null) }, [SEDE_A, SEDE_B]);
    expect(r.tipo).toBe('nessuna');
  });

  it('una sola sede scelta fra due: guarda solo quella', () => {
    const perSede = { [SEDE_A]: cal('A', null), [SEDE_B]: cal('B', 'in_preparazione') };
    expect(trovaAnnoDaPreparare(perSede, [SEDE_A]).tipo).toBe('nessuna');
    const r = trovaAnnoDaPreparare(perSede, [SEDE_B]);
    expect(r.tipo === 'anno' && r.anno.scuolaId).toBe(SEDE_B);
  });
});

describe('giornoDopo', () => {
  it('somma un giorno senza fusi', () => {
    expect(giornoDopo('2027-07-31')).toBe('2027-08-01');
    expect(giornoDopo('2027-12-31')).toBe('2028-01-01');
    expect(giornoDopo('2028-02-28')).toBe('2028-02-29');
  });
  it('una data non valida dà null', () => {
    expect(giornoDopo('boh')).toBeNull();
  });
});

describe('costruisciTappe', () => {
  const anno = {
    scuolaId: SEDE_A,
    annoId: 'anno-nuovo-A',
    annoSedeId: NUOVO_A,
    etichetta: '2027/28',
    stato: 'in_preparazione' as const,
    apribileDal: '2027-08-01',
  };

  it('le sei tappe sono nell\'ordine giusto', () => {
    const t = costruisciTappe(anno, { mancano: [], cruscotto: null }, '2027-03-01');
    expect(t.map((x) => x.id)).toEqual(['quote', 'documenti', 'iscrizioni', 'conferme', 'puntoSituazione', 'passaggio']);
  });

  it('prima di aprire le iscrizioni: quote e documenti dicono cosa manca', () => {
    const t = costruisciTappe(
      anno,
      { mancano: ['quota_conferma', 'moduli_nuova', 'classi_senza_fascia'], cruscotto: null },
      '2027-03-01',
    );
    const per = Object.fromEntries(t.map((x) => [x.id, x]));
    expect(per.quote.stato).toBe('da_fare');
    expect(per.documenti.stato).toBe('da_fare');
    expect(per.iscrizioni.stato).toBe('da_fare');
    expect(per.iscrizioni.classiSenzaFascia).toBe(true);
    expect(per.conferme.stato).toBe('non_disponibile');
    expect(per.puntoSituazione.stato).toBe('non_disponibile');
  });

  it('quote fatte e documenti da fare: le due tappe sono separate', () => {
    const t = costruisciTappe(anno, { mancano: ['moduli_conferma'], cruscotto: null }, '2027-03-01');
    expect(t[0].stato).toBe('fatto');
    expect(t[1].stato).toBe('da_fare');
  });

  it('se la lettura dei prerequisiti è fallita lo stato è sconosciuto, non «fatto»', () => {
    const t = costruisciTappe(anno, { mancano: null, cruscotto: null }, '2027-03-01');
    expect(t[0].stato).toBe('sconosciuto');
    expect(t[1].stato).toBe('sconosciuto');
  });

  it('con le iscrizioni aperte: tappe 1-3 fatte e conferme con i due conteggi', () => {
    const t = costruisciTappe(
      { ...anno, stato: 'iscrizioni_aperte' },
      { mancano: null, cruscotto: { confermati: 31, nonRisposto: 9 } },
      '2027-03-01',
    );
    expect(t.slice(0, 3).map((x) => x.stato)).toEqual(['fatto', 'fatto', 'fatto']);
    expect(t[3].stato).toBe('in_corso');
    expect(t[3].confermati).toBe(31);
    expect(t[3].nonRisposto).toBe(9);
    expect(t[4].stato).toBe('in_corso');
  });

  it('con le iscrizioni aperte e il cruscotto illeggibile la tappa conferme è sconosciuta', () => {
    const t = costruisciTappe({ ...anno, stato: 'iscrizioni_aperte' }, { mancano: null, cruscotto: null }, '2027-03-01');
    expect(t[3].stato).toBe('sconosciuto');
  });

  it('passaggio: la data che dà il programma, e «pronto» solo da quel giorno', () => {
    const prima = costruisciTappe(anno, { mancano: [], cruscotto: null }, '2027-07-31')[5];
    expect(prima.apribileDal).toBe('2027-08-01');
    expect(prima.pronto).toBe(false);
    const dopo = costruisciTappe(anno, { mancano: [], cruscotto: null }, '2027-08-01')[5];
    expect(dopo.pronto).toBe(true);
  });
});

describe('hrefTappa', () => {
  it('ogni tappa porta alla pagina vera', () => {
    const anno = { annoSedeId: NUOVO_A };
    expect(hrefTappa('quote', anno)).toBe(`/admin/impostazioni?sezione=anno&anno_sede=${NUOVO_A}`);
    expect(hrefTappa('documenti', anno)).toBe(`/admin/impostazioni?sezione=anno&anno_sede=${NUOVO_A}`);
    expect(hrefTappa('iscrizioni', anno)).toBe(`/admin/impostazioni?sezione=anno&anno_sede=${NUOVO_A}`);
    expect(hrefTappa('conferme', anno)).toBe('/admin/students/conferme');
    expect(hrefTappa('puntoSituazione', anno)).toBe('/admin/students/anno-prossimo');
    expect(hrefTappa('passaggio', anno)).toBe('/admin/students/passaggio');
  });
});
