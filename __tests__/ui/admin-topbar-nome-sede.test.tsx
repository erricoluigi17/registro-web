import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi';

/**
 * Prova di usabilità 2026-11 (segretaria nuova, sede Demo): «In alto solo "STAFF – Kidville" e l'anno
 * 2026/27: non c'è scritto su quale scuola sono». Con UNA sola sede il selettore non si monta (non c'è
 * niente da scegliere) e la barra non diceva niente. Ora il nome della sede compare in sola lettura, sul
 * desktop (`AdminTopBar`) come sul telefono (`AdminTopBarMobile`, vedi `admin-topbar-mobile.test.tsx`).
 * Con due o più sedi il nome lo dice il selettore: il nome fisso non si ripete.
 */

const stub = vi.hoisted(() => ({
  sedi: [] as { id: string; nome: string }[],
  effettive: [] as string[],
}));

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: 'segreteria', withUser: (h: string) => `${h}?userId=u1` }),
}));
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: stub.sedi,
    selezionate: [],
    effettive: stub.effettive,
    sedeCorrente: stub.effettive.length === 1 ? stub.effettive[0] : null,
    reFetchKey: stub.effettive.join(','),
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}));
vi.mock('@/components/ui/UserMenu', () => ({ UserMenu: () => null }));
vi.mock('@/components/features/admin/AdminSearchPanel', () => ({ AdminSearchPanel: () => null }));
vi.mock('@/components/features/admin/AdminNotificationsPanel', () => ({ AdminNotificationsPanel: () => null }));

import { AdminTopBar } from '@/components/features/admin/AdminTopBar';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })));
  stub.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }];
  stub.effettive = [SEDE_A];
});

describe('AdminTopBar — su quale scuola si lavora', () => {
  it('con una sola sede ne scrive il nome, in sola lettura', () => {
    render(<AdminTopBar />);
    const nome = screen.getByText(NOME_SEDE_A);
    expect(nome).toBeInTheDocument();
    expect(nome.closest('button')).toBeNull();
  });

  it('il nome ha un\'etichetta per chi non vede: dice che è la sede di lavoro', () => {
    render(<AdminTopBar />);
    expect(screen.getByText(/sede di lavoro/i)).toBeInTheDocument();
  });

  it('con due sedi il nome fisso non c\'è: ci pensa il selettore', () => {
    stub.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ];
    stub.effettive = [SEDE_A, SEDE_B];
    const { container } = render(<AdminTopBar />);
    expect(container.querySelector('[data-kv-sede-nome]')).toBeNull();
    expect(screen.getByRole('button', { name: /cambia sede/i })).toBeInTheDocument();
  });
});
