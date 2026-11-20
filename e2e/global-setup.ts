import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Prima di ogni run: cartella storageState + seed deterministico (idempotente).
export default function globalSetup() {
  mkdirSync(path.join(__dirname, '.auth'), { recursive: true });
  // MISURA (ramo di prova, non va in main): solo in CI, un processo a parte che stampa
  // memoria e carico ogni 30 s nel registro della suite. Muore con la macchina.
  if (process.env.CI) {
    spawn('bash', [path.join(__dirname, 'misura-ci.sh'), String(process.pid)], { stdio: 'inherit', detached: true }).unref();
  }
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'seed-e2e.mjs')], {
    stdio: 'inherit',
  });
}
