import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi';

/**
 * La home Direzione (`/admin`) dopo la prova di usabilità 2026-11:
 *  · il pulsante in alto, che si chiamava «Iscrizioni» ma porta all'ELENCO DELLE DOMANDE RICEVUTE, ora lo dice;
 *  · la scheda «Prepara l'anno prossimo» sta nella pagina (compare con un anno in preparazione).
 * Qui si monta la pagina vera con il contesto finto.
 *
 * Sul «primo clic che non fa niente» del diario: l'indirizzo del pulsante è `?tab=ricevuti&userId=…`
 * (la home ha il suo `withUser`, che aggiunge `&` quando c'è già una query), e il pulsante è un `Link`
 * senza gestori di clic sopra di sé. Il test lo fissa.
 */

const ctx = vi.hoisted(() => ({ conAnno: true }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => '/admin',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u1', ready: true }),
}));
vi.mock('@/components/features/admin/DashboardCharts', () => ({
  StudentiPerClasseChart: () => <div data-testid="grafico-alunni" />,
}));
vi.mock('@/lib/context/admin-identity', () => ({ useRuoloCockpit: () => 'segreteria' }));
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }], effettive: [SEDE_A], loading: false }),
}));
vi.mock('@/lib/context/anno-context', () => ({ useAnnoOpzionale: () => null }));
vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({
    perSede: {
      [SEDE_A]: [
        {
          annoId: 'a1', annoSedeId: 's1', annoInizio: 2026, inizio: '2026-09-01', fine: '2027-08-31',
          ultimoGiornoAperto: '2027-07-31', preparaSuccessivoDal: '2027-03-01', stato: 'corrente', domandeAperte: false,
        },
        ...(ctx.conAnno
          ? [{
              annoId: 'a2', annoSedeId: 's2', annoInizio: 2027, inizio: '2027-09-01', fine: '2028-08-31',
              ultimoGiornoAperto: '2028-07-31', preparaSuccessivoDal: '2028-03-01', stato: 'in_preparazione', domandeAperte: false,
            }]
          : []),
      ],
    },
    loading: false,
    errore: false,
    ricarica: vi.fn(),
  }),
}));

import AdminDashboardPage from '@/app/(dashboard)/admin/page';

beforeEach(() => {
  ctx.conAnno = true;
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) })));
});

describe('Home Direzione — il pulsante delle domande ricevute', () => {
  it('si chiama «Domande ricevute», non più «Iscrizioni»', () => {
    render(<AdminDashboardPage />);
    expect(screen.getByRole('link', { name: /domande ricevute/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^iscrizioni$/i })).toBeNull();
  });

  it('porta all\'elenco delle domande ricevute, con la query ben formata', () => {
    render(<AdminDashboardPage />);
    expect(screen.getByRole('link', { name: /domande ricevute/i })).toHaveAttribute(
      'href',
      '/admin/modulistica?tab=ricevuti&userId=u1',
    );
  });
});

describe('Home Direzione — la scheda «Prepara l\'anno prossimo»', () => {
  it('compare nella pagina con un anno in preparazione', async () => {
    render(<AdminDashboardPage />);
    expect(await screen.findByRole('heading', { name: /prepara l’anno prossimo/i })).toBeInTheDocument();
  });

  it('non compare senza un anno in preparazione', () => {
    ctx.conAnno = false;
    render(<AdminDashboardPage />);
    expect(screen.queryByRole('heading', { name: /prepara l’anno prossimo/i })).toBeNull();
  });
});
