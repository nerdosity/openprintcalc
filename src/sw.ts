// Service worker: cache-first per shell, script, stili, dati e icone.
// Compilato in js/sw.js e copiato alla radice del sito da scripts/copy-sw.ts (che sostituisce BUILD_ID):
// lo scope di un SW e' la cartella in cui sta, quindi per coprire /openprintcalc/ deve stare alla radice.

/** Sostituita a ogni `npm run build`: cambia la cache, quindi il vecchio contenuto viene scartato. */
const BUILD_ID = '__BUILD_ID__';
const CACHE = `openprintcalc-${BUILD_ID}`;

/** Percorsi relativi alla posizione di sw.js (funziona sotto /openprintcalc/ e in locale). */
const SHELL: string[] = JSON.parse('__SHELL__') as string[]; // generata da scripts/copy-sw.ts

interface SwEvent extends Event { waitUntil(p: Promise<unknown>): void }
interface FetchEv extends SwEvent { request: Request; respondWith(r: Promise<Response>): void }
interface Sw {
  addEventListener(type: string, fn: (e: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: Location;
}
const sw = self as unknown as Sw;

sw.addEventListener('install', ((e: SwEvent) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => sw.skipWaiting()));
}) as (e: never) => void);

sw.addEventListener('activate', ((e: SwEvent) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('openprintcalc-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
}) as (e: never) => void);

sw.addEventListener('fetch', ((e: FetchEv) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== sw.location.origin) return; // font e altro: rete normale
  if (req.mode === 'navigate') { // pagine: rete prima, cache se offline
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit ?? caches.match('index.html').then((h) => h ?? Response.error()))));
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit ?? fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); } // es. data/*.json al primo uso
      return res;
    })),
  );
}) as (e: never) => void);
