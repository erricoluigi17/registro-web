import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import itContabilita from '../../messages/it/adminContabilita.json';
import enContabilita from '../../messages/en/adminContabilita.json';
import { RegistraIncassoModal } from '@/components/features/admin/pagamenti/RegistraIncassoModal';

// =============================================================================
// Lotto E4 · prova di facilità d'uso: dopo un pagamento riuscito la finestra «Registra incasso» diceva ancora «Già incassato € 0,00 /
// Resta € 100,00» (sembrava non riuscito) e metteva «Invia fattura» accanto alla conferma (facile da toccare per sbaglio).
// Qui: i numeri si aggiornano subito, la pagina che l'ha aperta è avvisata subito (`onPagato`), e la fattura sta in un punto a parte,
// dopo «Chiudi». Il comportamento della fattura non cambia: è lo stesso `FatturaButton`.
// =============================================================================

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <button type="button" data-testid="fattura-button">Invia fattura</button>,
}));

const voce = {
  id: 'p1',
  descrizione: 'Iscrizione prova',
  importo: 100,
  importo_pagato: 0,
  stato: 'da_pagare',
  tipo: 'singolo',
  alunni: { nome: 'NomeProva', cognome: 'CognomeProva' },
};

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const riga = (etichetta: string) => screen.getByText(new RegExp(`^${etichetta}`)) as HTMLElement;

describe('RegistraIncassoModal · dopo un pagamento riuscito', () => {
  it('saldo completo: «Già incassato» e «Resta» diventano giusti subito, non restano a 0 e 100', async () => {
    render(<RegistraIncassoModal pagamento={voce} userId="u1" onClose={() => {}} onDone={() => {}} />);
    expect(riga(itContabilita.incGiaIncassato).textContent).toMatch(/€\s?0,00/);
    expect(riga(itContabilita.incResta).textContent).toMatch(/€\s?100,00/);
    fireEvent.click(screen.getByRole('button', { name: /Registra € 100,00/ }));
    await screen.findByText(itContabilita.incPagamentoSaldato);
    expect(riga(itContabilita.incGiaIncassato).textContent).toMatch(/€\s?100,00/);
    expect(riga(itContabilita.incResta).textContent).toMatch(/€\s?0,00/);
  });

  it('avvisa SUBITO chi l’ha aperta (`onPagato`), senza aspettare «Chiudi»', async () => {
    const onPagato = vi.fn();
    const onDone = vi.fn();
    render(<RegistraIncassoModal pagamento={voce} userId="u1" onClose={() => {}} onDone={onDone} onPagato={onPagato} />);
    fireEvent.click(screen.getByRole('button', { name: /Registra € 100,00/ }));
    await screen.findByText(itContabilita.incPagamentoSaldato);
    expect(onPagato).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('pagamento parziale: avvisa e si chiude da sé (`onPagato` poi `onDone`)', async () => {
    const onPagato = vi.fn();
    const onDone = vi.fn();
    render(<RegistraIncassoModal pagamento={voce} userId="u1" onClose={() => {}} onDone={onDone} onPagato={onPagato} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /Registra € 40,00/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onPagato).toHaveBeenCalledTimes(1);
  });

  it('un rifiuto del server NON avvisa nessuno e non cambia i numeri', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) }));
    const onPagato = vi.fn();
    render(<RegistraIncassoModal pagamento={voce} userId="u1" onClose={() => {}} onDone={() => {}} onPagato={onPagato} />);
    fireEvent.click(screen.getByRole('button', { name: /Registra € 100,00/ }));
    await screen.findByRole('alert');
    expect(onPagato).not.toHaveBeenCalled();
    expect(riga(itContabilita.incGiaIncassato).textContent).toMatch(/€\s?0,00/);
  });

  it('«Invia fattura» non sta più accanto alla conferma: è in un punto a parte, DOPO «Chiudi»', async () => {
    render(<RegistraIncassoModal pagamento={voce} userId="u1" onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Registra € 100,00/ }));
    const conferma = await screen.findByRole('status');
    expect(conferma.textContent).toContain(itContabilita.incPagamentoSaldato);
    const fattura = screen.getByTestId('fattura-button');
    // non dentro il riquadro di conferma
    expect(within(conferma).queryByTestId('fattura-button')).toBeNull();
    // e dopo il pulsante «Chiudi» nell'ordine della pagina
    const chiudi = screen.getAllByRole('button', { name: itContabilita.incChiudi }).find((b) => b.textContent === itContabilita.incChiudi)!;
    expect(chiudi.compareDocumentPosition(fattura) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // il punto a parte dice che è facoltativa
    expect(screen.getByText(itContabilita.incFatturaFacoltativa)).toBeInTheDocument();
  });

  it.each([['it', itContabilita], ['en', enContabilita]])('(%s) la frase della fattura facoltativa esiste in tutte e due le lingue', (_l, m) => {
    expect((m as unknown as Record<string, string>).incFatturaFacoltativa).toMatch(/\S/);
  });
});
