/**
 * Il criterio — PURO — di quali righe di `galleria_media_v2` sono RESIDUI degli spec E2E.
 *
 * Il database della CI è condiviso fra le run e lo ripulisce solo il seed. `gallery-caricamento` carica una
 * foto per ogni variante e la toglie in un `finally`: se la DELETE fallisce (o il test muore prima), la foto
 * resta. La galleria del genitore ordina per `created_at` DECRESCENTE e mostra 12 schede per pagina, mentre le
 * righe del seed hanno il `created_at` del primo seme (l'upsert non lo riscrive): ogni residuo è più recente
 * del video seminato, e al dodicesimo `impaginazione-media` non lo trova più nella prima pagina.
 * Una run rossa sporcava così tutte le successive.
 *
 * Il criterio è STRETTO. Una riga è un residuo solo se, insieme:
 *   · l'`id` NON è fra quelli seminati (mai una riga del seed);
 *   · `uploaded_by` è un docente E2E;
 *   · la sede è una sede E2E (`scuola_id` assente o nulla vale come «non si sa»: l'autore E2E basta, e
 *     un `scuola_id` di un'altra sede NON è mai un residuo);
 *   · il file è nel bucket sotto `uploads/` (una riga senza file da firmare non è una foto caricata da uno spec).
 * I byte si tolgono solo se non stanno sotto `uploads/e2e/`, dove il seed mette i suoi file veri.
 */

export const PREFISSO_FILE_SEED = 'uploads/e2e/'

/** @returns {boolean} */
export function eResiduoGalleriaE2E(riga, { idSeminati, docentiE2E, sediE2E }) {
  if (!riga || typeof riga.id !== 'string') return false
  if (idSeminati.includes(riga.id)) return false
  if (!docentiE2E.includes(riga.uploaded_by)) return false
  if (riga.scuola_id !== undefined && riga.scuola_id !== null && !sediE2E.includes(riga.scuola_id)) return false
  if (typeof riga.file_url !== 'string' || !riga.file_url.startsWith('uploads/')) return false
  return true
}

/** Le righe da togliere e i percorsi del bucket da togliere con loro (mai i file del seed). */
export function residuiGalleriaE2E(righe, perimetro) {
  const residui = (righe ?? []).filter((r) => eResiduoGalleriaE2E(r, perimetro))
  const percorsi = [...new Set(residui.map((r) => r.file_url).filter((p) => !p.startsWith(PREFISSO_FILE_SEED)))]
  return { ids: residui.map((r) => r.id), percorsi }
}
