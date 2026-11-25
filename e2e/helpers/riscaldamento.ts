import type { Browser, Page } from '@playwright/test';

/**
 * IL RISCALDAMENTO — la compilazione di `next dev` fuori dal cronometro delle prove.
 *
 * La suite gira sul server di sviluppo, che compila ogni pagina e ogni rotta API alla PRIMA
 * richiesta e poi la tiene (misurato: nessuna ricompilazione in tutta la suite). Finché la CI
 * aveva 4 processori quel costo stava nei margini. Da metà novembre 2026 il repository è privato
 * e la macchina ne ha 2, con 8 GB invece di 16: la prima visita di una pagina può costare più del
 * tempo che la prova concede.
 *
 * Misurato il 20/11/2026 sulla run 44718868421 (ramo da `main`, `ubuntu-latest` privata):
 * `tablet-verticale › /parent/mensa` è la prima visita di quella pagina in tutta la suite. Il
 * server ha compilato la pagina in 6,7 s e poi `/api/parent/mensa/allergie` in 10,8 s, con il
 * processore in coda per il 40-65% del tempo; l'elenco compare solo dopo quella risposta, e il
 * `poll` delle colonne scade a 15 s. Rosso. In `tablet-orizzontale`, poco dopo, la stessa pagina
 * risponde in 0,2 s ed è verde: la differenza è tutta compilazione.
 *
 * Quel tempo non è una proprietà del prodotto: in produzione le rotte sono già compilate. Ma
 * finisce dentro i `timeout` di prove che misurano larghezze e colonne, e nei progetti a
 * `retries: 0` basta una volta per un rosso che non dice niente sull'impaginazione.
 *
 * COSA FA. Apre ogni rotta con un browser vero e con la sessione del ruolo, e aspetta che la rete
 * si quieti: così si compilano la pagina E le API che il suo codice chiama al caricamento (una
 * richiesta fatta da qui con `fetch` compilerebbe la pagina e non le API).
 *
 * COSA NON FA, ed è il punto. Non controlla niente e non decide niente: non è un primo tentativo
 * della prova, e non può renderla verde. Se la pagina è rotta, lenta o vuota, la prova che segue
 * la apre da capo, la misura con gli stessi tempi di prima e fallisce come prima. Per questo un
 * errore qui dentro si scrive nel registro e non ferma niente: il verdetto resta alla prova.
 *
 * Costa una visita per rotta. A rotte già compilate (il secondo progetto che ripete lo stesso
 * spec) sono un paio di secondi l'una.
 */

/** Quanto deve restare ferma la rete per dirla quieta. */
const QUIETE_MS = 2_000;
/** Oltre questo tempo si passa alla rotta dopo, dicendolo. */
const TETTO_ROTTA_MS = 90_000;

/**
 * Aspetta che non ci siano richieste in volo da `QUIETE_MS`. Non è il `networkidle` di Playwright
 * (500 ms): con il processore saturo fra una risposta e la richiesta successiva della stessa
 * pagina passa anche più di mezzo secondo, e la quiete scatterebbe a metà della cascata — prima
 * che il codice della pagina abbia chiamato l'API ancora da compilare.
 */
function contaRichieste(page: Page) {
  let inVolo = 0;
  let ultimoMovimento = Date.now();
  const parte = () => {
    inVolo += 1;
    ultimoMovimento = Date.now();
  };
  const arriva = () => {
    inVolo = Math.max(0, inVolo - 1);
    ultimoMovimento = Date.now();
  };
  page.on('request', parte);
  page.on('requestfinished', arriva);
  page.on('requestfailed', arriva);
  return {
    async quieta(scadenza: number): Promise<boolean> {
      while (Date.now() < scadenza) {
        if (inVolo === 0 && Date.now() - ultimoMovimento >= QUIETE_MS) return true;
        await page.waitForTimeout(250);
      }
      return false;
    },
  };
}

export async function riscaldaRotte(
  browser: Browser,
  opzioni: { baseURL: string | undefined; storageState: string; rotte: readonly string[] },
): Promise<void> {
  const inizio = Date.now();
  const lente: string[] = [];
  const context = await browser.newContext({
    baseURL: opzioni.baseURL,
    storageState: opzioni.storageState,
    serviceWorkers: 'block',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  });
  try {
    for (const rotta of opzioni.rotte) {
      const page = await context.newPage();
      const partenza = Date.now();
      const scadenza = partenza + TETTO_ROTTA_MS;
      try {
        const richieste = contaRichieste(page);
        await page.goto(rotta, { waitUntil: 'load', timeout: TETTO_ROTTA_MS });
        const ferma = await richieste.quieta(scadenza);
        const secondi = (Date.now() - partenza) / 1000;
        if (!ferma) {
          console.warn(`[riscaldamento] ${rotta}: rete non ferma dopo ${TETTO_ROTTA_MS / 1000} s — proseguo`);
        } else if (secondi >= 8) {
          lente.push(`${rotta} ${secondi.toFixed(1)} s`);
        }
      } catch (errore) {
        // Non si ferma niente: la prova che segue riapre la rotta e dice lei che cosa non va.
        console.warn(
          `[riscaldamento] ${rotta}: visita non riuscita — proseguo:`,
          errore instanceof Error ? errore.message.split('\n')[0] : String(errore),
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
  }
  console.log(
    `[riscaldamento] ${opzioni.rotte.length} rotte in ${((Date.now() - inizio) / 1000).toFixed(1)} s` +
      (lente.length > 0 ? ` — prime compilazioni lunghe: ${lente.join(', ')}` : ''),
  );
}
