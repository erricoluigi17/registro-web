import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi';

/**
 * «Un catch che non logga è un bug» (AGENTS.md, Logging obbligatorio, regola 6). Un 200 con il corpo che non
 * si legge come JSON finiva in «non riesco a leggerlo» senza lasciare una riga: da fuori, identico a «tutto ok».
 * Solo dati finti.
 */

const { logClientMock } = vi.hoisted(() => ({ logClientMock: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({ logClient: logClientMock, nomeErrore: () => 'SyntaxError' }));

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }], effettive: [SEDE_A], loading: false }),
}));
vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({
    perSede: {
      [SEDE_A]: [
        { annoId: 'a1', annoSedeId: 'as1', annoInizio: 2026, inizio: '2026-09-01', fine: '2027-08-31', ultimoGiornoAperto: '2027-07-31', preparaSuccessivoDal: '2027-03-01', stato: 'corrente', domandeAperte: false },
        { annoId: 'a2', annoSedeId: 'as2', annoInizio: 2027, inizio: '2027-09-01', fine: '2028-08-31', ultimoGiornoAperto: '2028-07-31', preparaSuccessivoDal: '2028-03-01', stato: 'in_preparazione', domandeAperte: false },
      ],
    },
    loading: false,
    errore: false,
    ricarica: vi.fn(),
  }),
}));
vi.mock('@/lib/context/anno-context', () => ({
  useAnnoOpzionale: () => ({ selezionato: null, scegli: vi.fn() }),
}));
vi.mock('@/lib/context/admin-identity', () => ({ useRuoloCockpit: () => 'segreteria' }));

import { PreparaAnnoProssimo } from '@/components/features/admin/home/PreparaAnnoProssimo';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('PreparaAnnoProssimo — il corpo illeggibile lascia una riga di log', () => {
  it('un 200 con corpo non-JSON registra un warn, senza dati', async () => {
    render(<PreparaAnnoProssimo userId="u1" withUser={(h) => h} />);
    await waitFor(() => expect(logClientMock).toHaveBeenCalled());
    const chiamate = logClientMock.mock.calls.map(([c]) => c as { livello: string; messaggio: string; stato?: number });
    const illeggibile = chiamate.find((c) => /illeggibile/.test(c.messaggio));
    expect(illeggibile).toBeDefined();
    expect(illeggibile!.livello).toBe('warn');
    expect(illeggibile!.stato).toBe(200);
    expect(screen.getByRole('heading', { name: /prepara l’anno prossimo/i })).toBeInTheDocument();
  });
});
