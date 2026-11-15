import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import type { Calendario } from '@/lib/anno-scolastico';
import { SEDE_A, SEDE_B, NOME_SEDE_A } from '../fixtures/sedi';

/**
 * La scheda «Prepara l'anno prossimo» della home Direzione (prova di usabilità 2026-11): una segretaria
 * nuova non trovava il punto di partenza e le tappe stavano in tre posti del menu.
 *
 * Qui si finge il contesto (sedi attive, calendario, anno scelto, ruolo) e le due letture che la scheda fa
 * (`GET /api/admin/anni/[id]` per ciò che manca; il cruscotto per le conferme). Non si finge la scheda.
 */

const NUOVO = 'a0000000-0000-4000-8000-0000000000a2';

const ctx = vi.hoisted(() => ({
  /** L'indirizzo di cui `useLinkStatus` dice «sta caricando» (null = nessuno). */
  inCaricamento: null as string | null,
  sedi: [] as { id: string; nome: string }[],
  effettive: [] as string[],
  perSede: {} as Record<string, unknown>,
  ruolo: 'segreteria',
  scegli: vi.fn(),
  selezionato: null as string | null,
}));

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ sedi: ctx.sedi, effettive: ctx.effettive, loading: false }),
}));
vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({ perSede: ctx.perSede, loading: false, errore: false, ricarica: vi.fn() }),
}));
vi.mock('@/lib/context/anno-context', () => ({
  useAnnoOpzionale: () => ({ selezionato: ctx.selezionato, scegli: ctx.scegli }),
}));
vi.mock('@/lib/context/admin-identity', () => ({
  useRuoloCockpit: () => ctx.ruolo,
}));

// `useLinkStatus` di Next dice «pending» dentro il `Link` che sta navigando: qui un Link finto lo simula per UN indirizzo.
vi.mock('next/link', async () => {
  const React = await import('react');
  const Pending = React.createContext(false);
  return {
    default: ({ href, children, onClick, ...resto }: { href: string; children: React.ReactNode; onClick?: () => void } & Record<string, unknown>) =>
      React.createElement(
        Pending.Provider,
        { value: ctx.inCaricamento === href },
        React.createElement('a', { href, onClick, ...resto }, children),
      ),
    useLinkStatus: () => ({ pending: React.useContext(Pending) }),
  };
});

import { PreparaAnnoProssimo } from '@/components/features/admin/home/PreparaAnnoProssimo';

function calendario(statoNuovo: 'in_preparazione' | 'iscrizioni_aperte' | 'corrente' | null): Calendario {
  const corrente = {
    annoId: 'anno-corrente',
    annoSedeId: 'as-corrente',
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
      annoId: 'anno-nuovo',
      annoSedeId: NUOVO,
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

const withUser = (h: string) => `${h}${h.includes('?') ? '&' : '?'}userId=u1`;

function rispondi(mancano: string[], cruscotto?: { confermati: number; non_risposto: number }) {
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/cruscotto')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { risposte: { confermati: 0, no: 0, non_risposto: 0, di_partenza: 0, ...cruscotto } } }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { mancano } }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }];
  ctx.effettive = [SEDE_A];
  ctx.perSede = { [SEDE_A]: calendario('in_preparazione') };
  ctx.ruolo = 'segreteria';
  ctx.selezionato = null;
  ctx.inCaricamento = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PreparaAnnoProssimo — quando compare', () => {
  it('compare con un anno in preparazione, con le sei tappe nell\'ordine giusto', async () => {
    rispondi(['quota_conferma']);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    expect(await screen.findByRole('heading', { name: /prepara l’anno prossimo/i })).toBeInTheDocument();
    const righe = screen.getAllByRole('listitem');
    expect(righe).toHaveLength(6);
    const titoli = righe.map((r) => within(r).getByRole('link').getAttribute('aria-label'));
    expect(titoli).toEqual([
      'Apri: Quote e retta',
      'Apri: Documenti da consegnare',
      'Apri: Apri le iscrizioni',
      'Apri: Conferme delle famiglie',
      'Apri: A che punto siamo',
      'Apri: Passaggio d’anno',
    ]);
    await waitFor(() => expect(screen.getByText(/mancano le quote o la retta/i)).toBeInTheDocument());
  });

  it('NON compare senza un anno in preparazione', () => {
    ctx.perSede = { [SEDE_A]: calendario(null) };
    rispondi([]);
    const { container } = render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('NON compare per chi non è Direzione o segreteria', () => {
    ctx.ruolo = 'cuoca';
    rispondi([]);
    const { container } = render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('compare anche per la Direzione', async () => {
    ctx.ruolo = 'admin';
    rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    expect(await screen.findByRole('heading', { name: /prepara l’anno prossimo/i })).toBeInTheDocument();
  });
});

describe('PreparaAnnoProssimo — i link', () => {
  it('ogni tappa porta alla pagina giusta, con lo userId', async () => {
    rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    await screen.findByRole('heading', { name: /prepara l’anno prossimo/i });
    const href = (nome: string) => screen.getByRole('link', { name: nome }).getAttribute('href');
    const impostazioni = (tappa: string) => `/admin/impostazioni?sezione=anno&anno_sede=${NUOVO}&tappa=${tappa}&userId=u1`;
    // Ogni tappa dice alla pagina di arrivo QUALE scheda aprire e a quale blocco portarsi.
    expect(href('Apri: Quote e retta')).toBe(impostazioni('quote'));
    expect(href('Apri: Documenti da consegnare')).toBe(impostazioni('documenti'));
    expect(href('Apri: Apri le iscrizioni')).toBe(impostazioni('iscrizioni'));
    expect(href('Apri: Conferme delle famiglie')).toBe('/admin/students/conferme?userId=u1');
    expect(href('Apri: A che punto siamo')).toBe('/admin/students/anno-prossimo?userId=u1');
    expect(href('Apri: Passaggio d’anno')).toBe('/admin/students/passaggio?userId=u1');
  });

  it('cliccando una tappa che dipende dal selettore dell\'anno sceglie l\'anno nuovo', async () => {
    rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    await screen.findByRole('heading', { name: /prepara l’anno prossimo/i });
    fireEvent.click(screen.getByRole('link', { name: 'Apri: Conferme delle famiglie' }));
    expect(ctx.scegli).toHaveBeenCalledWith('anno-nuovo');
  });

  it('le tappe delle impostazioni non toccano il selettore (l\'anno lo porta l\'indirizzo)', async () => {
    rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    await screen.findByRole('heading', { name: /prepara l’anno prossimo/i });
    fireEvent.click(screen.getByRole('link', { name: 'Apri: Quote e retta' }));
    expect(ctx.scegli).not.toHaveBeenCalled();
  });
});

describe('PreparaAnnoProssimo — più sedi', () => {
  it('con più sedi attive e nessuna scelta chiede di sceglierla, senza fare chiamate', async () => {
    ctx.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: 'Altra sede' },
    ];
    ctx.effettive = [SEDE_A, SEDE_B];
    ctx.perSede = { [SEDE_A]: calendario('in_preparazione'), [SEDE_B]: calendario(null) };
    const fetchMock = rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    expect(await screen.findByText(/scegli prima una sede/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scelta una sede, la scheda mostra le tappe di quella', async () => {
    ctx.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: 'Altra sede' },
    ];
    ctx.effettive = [SEDE_A];
    ctx.perSede = { [SEDE_A]: calendario('in_preparazione'), [SEDE_B]: calendario(null) };
    rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    expect(await screen.findAllByRole('listitem')).toHaveLength(6);
  });
});

describe('PreparaAnnoProssimo — stato delle tappe', () => {
  it('con le iscrizioni aperte mostra «confermati» e «non hanno risposto» dal cruscotto', async () => {
    ctx.perSede = { [SEDE_A]: calendario('iscrizioni_aperte') };
    const fetchMock = rispondi([], { confermati: 31, non_risposto: 9 });
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    expect(await screen.findByText(/31 confermati · 9 non hanno risposto/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/admin/anni/${NUOVO}/cruscotto`)).toBe(true);
  });

  it('prima di aprire le iscrizioni non chiama il cruscotto (risponderebbe 409)', async () => {
    const fetchMock = rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    await screen.findByRole('heading', { name: /prepara l’anno prossimo/i });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/cruscotto'))).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/admin/anni/${NUOVO}`);
  });

  it('il passaggio dice «dal 1 agosto 2027», la data che dà il programma', async () => {
    rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    expect(await screen.findByText(/si fa dal 1 agosto 2027/i)).toBeInTheDocument();
  });

  it('se la lettura fallisce non scrive «fatto»: dice che non riesce a leggerlo, e lascia il link', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) })));
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    await waitFor(() => expect(screen.getAllByText(/non riesco a leggerlo/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/^fatto$/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Apri: Quote e retta' })).toBeInTheDocument();
  });
});

describe('PreparaAnnoProssimo — il primo clic non sembra morto', () => {
  it('mentre una tappa sta caricando la sua riga lo dice subito («Un attimo…») e segna aria-busy', async () => {
    rispondi([]);
    ctx.inCaricamento = '/admin/students/conferme?userId=u1';
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    await screen.findByRole('heading', { name: /prepara l’anno prossimo/i });
    const riga = screen.getByRole('link', { name: 'Apri: Conferme delle famiglie' }).closest('li') as HTMLElement;
    expect(within(riga).getByText('Un attimo…')).toBeInTheDocument();
    expect(riga.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(riga.querySelector('[data-pending="true"]')).not.toBeNull();
  });

  it('le altre righe restano quiete: niente «Un attimo…» dove nessuno ha cliccato', async () => {
    rispondi([]);
    ctx.inCaricamento = '/admin/students/conferme?userId=u1';
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    await screen.findByRole('heading', { name: /prepara l’anno prossimo/i });
    expect(screen.getAllByText('Un attimo…')).toHaveLength(1);
    const quiete = screen.getByRole('link', { name: 'Apri: Quote e retta' }).closest('li') as HTMLElement;
    expect(quiete.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('senza clic non c\'è nessun segno di caricamento', async () => {
    rispondi([]);
    render(<PreparaAnnoProssimo userId="u1" withUser={withUser} />);
    await screen.findByRole('heading', { name: /prepara l’anno prossimo/i });
    expect(screen.queryByText('Un attimo…')).toBeNull();
  });
});
