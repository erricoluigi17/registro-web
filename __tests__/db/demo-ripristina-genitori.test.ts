import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SEDE_VERA, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'
import { creaBancoAzzera } from '../helpers/banco-azzera'

/**
 * `demo_ripristina` TOGLIE ANCHE I GENITORI DI PROVA (14/11/2026), provato su PGlite: mai su Demo né su produzione.
 *
 * Un genitore nato dopo la partenza si toglie (con il suo `utenti` e il suo `auth.users`) solo se valgono TUTTE le condizioni: nessun legame con alcun
 * alunno rimasto, utente `genitore` nato dopo la partenza e senza sedi vere, email di accesso che finisce in `.test`, nessuna riga attaccata che una
 * chiave NO ACTION non lascerebbe cancellare. Ogni test qui sotto rompe UNA condizione e guarda il genitore RESTARE; uno solo le rispetta tutte e lo
 * guarda andare via. Nel riassunto solo uuid e conteggi, mai l'email.
 */

const DEMO = 'e2e00000-0000-4000-8000-00000000d000'
const MIGRAZIONI = ['20261114124928_demo_funzioni_ripristino.sql', '20261114195853_demo_ripristina_genitori_di_prova.sql']
  .map((n) => fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations', n), 'utf8'))

const id = (n: number) => `44444444-4444-4444-8444-4444444444${String(n).padStart(2, '0')}`
const AL = { a: id(1), b: id(2) }

let b: BancoPassaggio
let annoNuovoId: string
let annoVecchioId: string
let sezioneVecchia: string

beforeAll(async () => {
  b = await creaBancoAzzera()
  const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
  await b.db.exec(`ALTER TABLE public.incassi ADD COLUMN IF NOT EXISTS creato_il timestamptz NOT NULL DEFAULT now()`)
  // Lo schema dei genitori com'è in produzione (il banco condiviso ha solo gli uuid): l'utente di accesso, il ruolo e le sedi, i legami e ciò che
  // si porta dietro una cancellazione. Le azioni ON DELETE sono quelle VERE (lette dalle migrazioni).
  await b.db.exec(`
    CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
    ALTER TABLE public.utenti ADD COLUMN IF NOT EXISTS email text, ADD COLUMN IF NOT EXISTS ruolo text, ADD COLUMN IF NOT EXISTS scuola_id uuid;
    ALTER TABLE public.utenti ADD CONSTRAINT utenti_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE public.parents ADD CONSTRAINT parents_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE TABLE public.utenti_scuole (utente_id uuid NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE, scuola_id uuid NOT NULL);
    ALTER TABLE public.legame_genitori_alunni ADD CONSTRAINT legame_genitori_alunni_genitore_id_fkey FOREIGN KEY (genitore_id) REFERENCES public.utenti(id) NOT VALID;
    CREATE TABLE public.student_guardians (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
      parent_id uuid REFERENCES public.parents(id) ON DELETE SET NULL,
      utenti_id uuid REFERENCES public.utenti(id) ON DELETE SET NULL);
    CREATE TABLE public.notifiche (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), utente_id uuid NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE);
    CREATE TABLE public.firme_documenti (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), utente_id uuid NOT NULL REFERENCES public.utenti(id));
    CREATE TABLE public.consensi_accettazioni (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_id uuid NOT NULL);
  `)
  for (const m of MIGRAZIONI) await b.db.exec(m)

  await q(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Demo di prova')`, [DEMO])
  await q(`SELECT public.anni_sede_crea_per_sede($1, DATE '2026-11-06')`, [DEMO])
  const anno = async (inizio: number) =>
    (await q(`SELECT s.id, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = $2`, [DEMO, inizio])).rows[0] as { id: string; anno_id: string }
  annoVecchioId = (await anno(2026)).anno_id
  annoNuovoId = (await anno(2027)).anno_id
  sezioneVecchia = await una<string>(b.db,
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Girasoli', 'infanzia', 'infanzia') RETURNING id`, [DEMO, annoVecchioId])
  for (const a of Object.values(AL)) await q(`INSERT INTO public.alunni (id, scuola_id, stato, section_id) VALUES ($1, $2, 'iscritto', $3)`, [a, DEMO, sezioneVecchia])
}, 240_000)
afterAll(async () => {
  await b?.db.close()
})

const conta = (sql: string, p: unknown[] = []) => una<number>(b.db, `SELECT count(*)::int FROM (${sql}) x`, p)
const adesso = () => una<string>(b.db, `SELECT now()::text`)

type Esito = {
  azzeramento: { voce: string; tolte: number; rimesse: number; lasciate: number }[]
  lasciate: { tabella: string; id: string }[]
}
const VOCE = /^genitori di prova nati dopo la partenza/

async function ripristina(partenza: string): Promise<Esito> {
  return JSON.parse(await una<string>(b.db, `SELECT public.demo_ripristina($1::uuid, $2::timestamptz, false)::text`, [DEMO, partenza]))
}
const voce = (e: Esito) => e.azzeramento.find((v) => VOCE.test(v.voce))!

type Gen = { parent: string; auth: string | null; utente: string | null }
/** Un genitore con tutto ciò che nasce accogliendo una domanda; ogni opzione ne rompe una condizione. */
async function genitore(o: {
  email?: string | null
  parentPrima?: boolean
  utente?: false | { ruolo?: string; prima?: boolean; scuola?: string | null; sedi?: string[] }
  legame?: { via: 'student_parents' | 'legame' | 'guardians'; alunno: string }
} = {}): Promise<Gen> {
  const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
  const email = o.email === undefined ? `famiglia-${Math.random().toString(36).slice(2, 8)}@kidville.test` : o.email
  const auth = email === null ? null : await una<string>(b.db, `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [email])
  const prima = `now() - interval '1 day'`
  let utente: string | null = null
  if (auth && o.utente !== false) {
    const u = { ruolo: 'genitore', prima: false, scuola: DEMO as string | null, sedi: [DEMO], ...o.utente }
    await q(`INSERT INTO public.utenti (id, email, ruolo, scuola_id, creato_il) VALUES ($1, 'x', $2, $3, ${u.prima ? prima : 'now()'})`, [auth, u.ruolo, u.scuola])
    for (const s of u.sedi) await q(`INSERT INTO public.utenti_scuole (utente_id, scuola_id) VALUES ($1, $2)`, [auth, s])
    utente = auth
  }
  const parent = await una<string>(b.db,
    `INSERT INTO public.parents (auth_user_id, created_at) VALUES ($1, ${o.parentPrima ? prima : 'now()'}) RETURNING id`, [auth])
  if (o.legame?.via === 'student_parents') await q(`INSERT INTO public.student_parents (student_id, parent_id) VALUES ($1, $2)`, [o.legame.alunno, parent])
  if (o.legame?.via === 'legame') await q(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [utente, o.legame.alunno])
  if (o.legame?.via === 'guardians') await q(`INSERT INTO public.student_guardians (alunno_id, parent_id) VALUES ($1, $2)`, [o.legame.alunno, parent])
  return { parent, auth, utente }
}
const esiste = async (g: Gen) => ({
  parents: await conta(`SELECT 1 FROM public.parents WHERE id = $1`, [g.parent]),
  utenti: g.utente ? await conta(`SELECT 1 FROM public.utenti WHERE id = $1`, [g.utente]) : 0,
  auth: g.auth ? await conta(`SELECT 1 FROM auth.users WHERE id = $1`, [g.auth]) : 0,
})
const RIMASTO = { parents: 1, utenti: 1, auth: 1 }
const ANDATO = { parents: 0, utenti: 0, auth: 0 }
const partenza = async () => {
  const p = await adesso()
  await b.db.query(`SELECT public.demo_fotografa($1::uuid)`, [DEMO])
  return p
}

describe('demo_ripristina · i genitori di prova', () => {
  it('un genitore .test nato dopo la partenza, senza legami né sedi vere, va via con il suo utente, il suo accesso e ciò che gli sta attaccato', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore()
      // ciò che gli sta attaccato: notifica (a cascata), invito con le credenziali (SET NULL: si toglie a mano), consenso (senza chiave)
      await b.db.query(`INSERT INTO public.notifiche (utente_id) VALUES ($1)`, [g.utente])
      await b.db.query(`INSERT INTO public.iscrizioni_inviti_credenziali (auth_user_id, parent_id) VALUES ($1, $2)`, [g.auth, g.parent])
      await b.db.query(`INSERT INTO public.consensi_accettazioni (parent_id) VALUES ($1)`, [g.parent])
      expect(await esiste(g)).toEqual(RIMASTO)

      const e = await ripristina(p)
      expect(await esiste(g), 'genitore, utente e accesso sono andati').toEqual(ANDATO)
      expect(await conta(`SELECT 1 FROM public.utenti_scuole WHERE utente_id = $1`, [g.auth])).toBe(0)
      expect(await conta(`SELECT 1 FROM public.notifiche WHERE utente_id = $1`, [g.auth])).toBe(0)
      expect(await conta(`SELECT 1 FROM public.iscrizioni_inviti_credenziali WHERE auth_user_id = $1`, [g.auth]), 'l’invito con l’email è andato').toBe(0)
      expect(await conta(`SELECT 1 FROM public.consensi_accettazioni WHERE parent_id = $1`, [g.parent]), 'il consenso è andato').toBe(0)
      expect(voce(e)).toMatchObject({ tolte: 1, lasciate: 0 })
      expect(e.lasciate.filter((l) => l.tabella === 'parents' || l.tabella === 'utenti')).toEqual([])
      expect(JSON.stringify(e), 'mai l’email nel riassunto').not.toMatch(/kidville\.test|@/)
    })
  })

  it('il giro vero: domanda, alunno, genitore, utente, invito e legami nati dopo la partenza vanno via TUTTI, e non restano fra le lasciate', async () => {
    await inRollback(b.db, async () => {
      const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
      const p = await partenza()
      const domanda = await una<string>(b.db,
        `INSERT INTO public.enrollment_submissions (scuola_id, anno_id, data, status) VALUES ($1, $2, '{}'::jsonb, 'pending') RETURNING id`, [DEMO, annoNuovoId])
      const nuovo = await una<string>(b.db, `INSERT INTO public.alunni (scuola_id, stato) VALUES ($1, 'iscritto') RETURNING id`, [DEMO])
      const g = await genitore({ legame: { via: 'student_parents', alunno: nuovo } })
      await q(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [g.utente, nuovo])
      await q(`INSERT INTO public.iscrizioni_inviti_credenziali (auth_user_id, parent_id, submission_id) VALUES ($1, $2, $3)`, [g.auth, g.parent, domanda])

      const e = await ripristina(p)
      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [nuovo]), 'l’alunno è andato').toBe(0)
      expect(await conta(`SELECT 1 FROM public.enrollment_submissions WHERE id = $1`, [domanda]), 'la domanda è andata').toBe(0)
      expect(await esiste(g), 'e con loro il genitore').toEqual(ANDATO)
      expect(e.lasciate.filter((l) => l.tabella === 'parents' || l.tabella === 'utenti'), 'né il genitore né il suo utente sono “lasciati”').toEqual([])
      expect(voce(e)).toMatchObject({ tolte: 1, lasciate: 0 })
    })
  })

  it('email che non finisce in .test → RESTA e compare fra le lasciate (parents e utenti), per uuid', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore({ email: 'mamma@example.com' })
      const furbo = await genitore({ email: 'mamma@kidville.test.example.com' })
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(await esiste(furbo), 'il suffisso deve essere proprio .test').toEqual(RIMASTO)
      expect(e.lasciate).toContainEqual({ tabella: 'parents', id: g.parent })
      expect(e.lasciate).toContainEqual({ tabella: 'utenti', id: g.utente })
      expect(voce(e)).toMatchObject({ tolte: 0, lasciate: 2 })
      expect(JSON.stringify(e)).not.toMatch(/example\.com/)
    })
  })

  it('senza utente di accesso non si può verificare l’email → RESTA', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore({ email: null })
      const e = await ripristina(p)
      expect(await conta(`SELECT 1 FROM public.parents WHERE id = $1`, [g.parent])).toBe(1)
      expect(e.lasciate).toContainEqual({ tabella: 'parents', id: g.parent })
    })
  })

  it('genitore nato PRIMA della partenza → resta, e non è nemmeno elencato (non è roba della prova)', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore({ parentPrima: true, utente: { prima: true } })
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(e.lasciate.map((l) => l.id)).not.toContain(g.parent)
      expect(voce(e)).toMatchObject({ tolte: 0, lasciate: 0 })
    })
  })

  it('utente nato prima della partenza, anche se il genitore è nato dopo → resta', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore({ utente: { prima: true } })
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(e.lasciate).toContainEqual({ tabella: 'parents', id: g.parent })
    })
  })

  it('un utente che non è un genitore (docente) → resta', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore({ utente: { ruolo: 'docente' } })
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(e.lasciate).toContainEqual({ tabella: 'parents', id: g.parent })
    })
  })

  it.each([
    ['student_parents', 'student_parents'],
    ['legame_genitori_alunni', 'legame'],
    ['student_guardians (tabella trovata dal catalogo, non da un elenco)', 'guardians'],
  ] as const)('legame ancora vivo con un alunno che NON è stato tolto (%s) → resta e compare fra le lasciate', async (_n, via) => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore({ legame: { via, alunno: AL.a } })
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [AL.a]), 'l’alunno c’è ancora').toBe(1)
      expect(e.lasciate).toContainEqual({ tabella: 'parents', id: g.parent })
      expect(voce(e)).toMatchObject({ tolte: 0, lasciate: 1 })
    })
  })

  it('l’utente ha una riga in utenti_scuole per una sede VERA → resta (anche con una sede di prova accanto)', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore({ utente: { sedi: [DEMO, SEDE_VERA] } })
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(await conta(`SELECT 1 FROM public.utenti_scuole WHERE utente_id = $1`, [g.auth])).toBe(2)
      expect(e.lasciate).toContainEqual({ tabella: 'parents', id: g.parent })
    })
  })

  it('l’utente ha come sede principale una sede VERA → resta', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore({ utente: { scuola: SEDE_VERA, sedi: [] } })
      await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
    })
  })

  it('gli resta attaccata una riga che la chiave non lascerebbe cancellare (una firma) → resta, senza errore', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore()
      await b.db.query(`INSERT INTO public.firme_documenti (utente_id) VALUES ($1)`, [g.utente])
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(e.lasciate).toContainEqual({ tabella: 'parents', id: g.parent })
    })
  })

  it('un genitore legato a un alunno di una sede VERA non è roba della prova: non si tocca e non si elenca', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const vero = await una<string>(b.db, `INSERT INTO public.alunni (scuola_id, stato) VALUES ($1, 'iscritto') RETURNING id`, [SEDE_VERA])
      const g = await genitore({ legame: { via: 'student_parents', alunno: vero } })
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(await conta(`SELECT 1 FROM public.student_parents WHERE parent_id = $1`, [g.parent])).toBe(1)
      expect(e.lasciate.map((l) => l.id)).not.toContain(g.parent)
      expect(voce(e)).toMatchObject({ tolte: 0, lasciate: 0 })
    })
  })

  it('l’utente di accesso lo usa anche un altro genitore che resta → resta anche questo (l’accesso non si toglie da sotto i piedi)', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      // in produzione l'accesso può essere indicato da più righe: il banco ha un indice unico che qui si toglie
      await b.db.exec(`ALTER TABLE public.parents DROP CONSTRAINT parents_auth_user_id_key`)
      const g = await genitore()
      await b.db.query(`INSERT INTO public.parents (auth_user_id, created_at) VALUES ($1, now() - interval '1 day')`, [g.auth])
      const e = await ripristina(p)
      expect(await esiste(g)).toEqual(RIMASTO)
      expect(e.lasciate).toContainEqual({ tabella: 'parents', id: g.parent })
    })
  })

  it('la prova a secco non scrive niente e dice lo stesso conteggio del vero', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore()
      await b.db.query(`INSERT INTO public.consensi_accettazioni (parent_id) VALUES ($1)`, [g.parent])
      await b.db.exec('SAVEPOINT secco')
      const msg = await b.db.query(`SELECT public.demo_ripristina($1::uuid, $2::timestamptz)`, [DEMO, p]).then(() => 'nessun errore', (e: Error) => e.message)
      await b.db.exec('ROLLBACK TO SAVEPOINT secco')
      await b.db.exec('RELEASE SAVEPOINT secco')
      expect(msg).toMatch(/DEMO_PROVA_A_SECCO/)
      const riassunto = JSON.parse(msg.slice(msg.indexOf('{'))) as Esito
      expect(voce(riassunto)).toMatchObject({ tolte: 1, lasciate: 0 })
      expect(msg).not.toMatch(/kidville\.test|@/)
      expect(await esiste(g), 'a secco: tutto com’era').toEqual(RIMASTO)
      expect(await conta(`SELECT 1 FROM public.consensi_accettazioni WHERE parent_id = $1`, [g.parent])).toBe(1)
      const vero = await ripristina(p)
      expect(voce(vero)).toMatchObject({ tolte: voce(riassunto).tolte, lasciate: voce(riassunto).lasciate })
      expect(await esiste(g)).toEqual(ANDATO)
    })
  })

  it('demo_controllo: il controllo nuovo non è ok finché c’è un genitore di prova senza legami, ed è ok dopo il ripristino', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const NOME = 'nessun genitore di prova (email .test) nato dopo la partenza e senza legami'
      const controllo = async () => {
        const righe = (await b.db.query<{ controllo: string; ok: boolean; dettaglio: string }>(`SELECT * FROM public.demo_controllo($1::uuid)`, [DEMO])).rows
        return righe.find((r) => r.controllo === NOME)
      }
      expect(await controllo(), 'senza genitori è ok').toMatchObject({ ok: true, dettaglio: '0' })
      const g = await genitore()
      expect(await controllo()).toMatchObject({ ok: false, dettaglio: '1' })
      await ripristina(p)
      expect(await esiste(g)).toEqual(ANDATO)
      expect(await controllo()).toMatchObject({ ok: true, dettaglio: '0' })
      // un genitore .test con un legame non conta: il controllo parla solo di quelli senza
      await genitore({ legame: { via: 'student_parents', alunno: AL.b } })
      expect(await controllo()).toMatchObject({ ok: true })
      // e nemmeno uno con un’email che non è .test: il controllo cerca solo i genitori di prova
      await genitore({ email: 'mamma@example.com' })
      expect(await controllo()).toMatchObject({ ok: true, dettaglio: '0' })
    })
  })

  it('una sede senza il prefisso e2e00000 è rifiutata (DEMO_SEDE_NON_DI_PROVA) e nessun genitore viene toccato', async () => {
    await inRollback(b.db, async () => {
      const p = await partenza()
      const g = await genitore()
      for (const sql of [
        `SELECT public.demo_ripristina('${SEDE_VERA}'::uuid, '${p}'::timestamptz, false)`,
        `SELECT public.demo_ripristina('${SEDE_VERA}'::uuid, '${p}'::timestamptz, true)`,
        `SELECT * FROM public.demo_controllo('${SEDE_VERA}'::uuid)`,
      ]) {
        await b.db.exec('SAVEPOINT g')
        await expect(b.db.query(sql), sql).rejects.toThrow(/DEMO_SEDE_NON_DI_PROVA/)
        await b.db.exec('ROLLBACK TO SAVEPOINT g')
        await b.db.exec('RELEASE SAVEPOINT g')
      }
      expect(await esiste(g)).toEqual(RIMASTO)
    })
  })

  it('l’aiuto dei legami non è chiamabile da anon, authenticated né service_role', async () => {
    const r = await una<boolean>(b.db,
      `SELECT has_function_privilege('service_role', 'public.demo_i_genitore_legami(uuid, uuid)', 'EXECUTE')
              OR has_function_privilege('authenticated', 'public.demo_i_genitore_legami(uuid, uuid)', 'EXECUTE')
              OR has_function_privilege('anon', 'public.demo_i_genitore_legami(uuid, uuid)', 'EXECUTE')`)
    expect(r).toBe(false)
  })
})
