import { describe, it, expect } from 'vitest';
import { aggiungiUserId } from '@/lib/context/admin-identity';

describe('aggiungiUserId (withUser del cockpit)', () => {
  it('href senza query: usa ?', () => {
    expect(aggiungiUserId('/admin/pagamenti', 'u1')).toBe('/admin/pagamenti?userId=u1');
  });
  it('href con query: usa & (mai due ?)', () => {
    expect(aggiungiUserId('/admin/impostazioni?sezione=mensa', 'u1')).toBe(
      '/admin/impostazioni?sezione=mensa&userId=u1',
    );
  });
  it('href con frammento: il parametro va prima del #', () => {
    expect(aggiungiUserId('/admin/x#sezione', 'u1')).toBe('/admin/x?userId=u1#sezione');
    expect(aggiungiUserId('/admin/x?a=1#sezione', 'u1')).toBe('/admin/x?a=1&userId=u1#sezione');
  });
  it('senza userId: href invariato', () => {
    expect(aggiungiUserId('/admin/x?a=1#f', null)).toBe('/admin/x?a=1#f');
    expect(aggiungiUserId('/admin/x', null)).toBe('/admin/x');
  });
});
