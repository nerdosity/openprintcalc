// Link condivisibili: stato compresso (deflate-raw) in base64url nell'hash dell'URL. Nessun accesso al DOM.
import type { SaleResult } from './types.ts';

export const SHARE_VERSION = 1;

export class ShareError extends Error {}

/** Tetto ai byte decompressi: protegge da bombe di decompressione. */
const MAX_DECOMPRESSED = 1024 * 1024;

/* ---------- codifica ---------- */

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  void w.write(data).then(() => w.close()).catch(() => { /* l'errore emerge dalla lettura */ });
  const r = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    size += (value as Uint8Array).length;
    if (size > MAX_DECOMPRESSED) { void r.cancel().catch(() => undefined); throw new ShareError('Link troppo grande.'); }
    chunks.push(value as Uint8Array);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** JSON -> deflate-raw -> base64url. Il payload porta sempre la versione `v`. */
export async function encodeShare(obj: Record<string, unknown>): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ ...obj, v: SHARE_VERSION }));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

/** Inverso di encodeShare. Lancia ShareError se il testo e' illeggibile o la versione e' sconosciuta. */
export async function decodeShare(str: string): Promise<Record<string, unknown>> {
  let obj: unknown;
  try {
    const bytes = await pipe(fromBase64Url(str.trim()), new DecompressionStream('deflate-raw'));
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw e instanceof ShareError ? e : new ShareError('Link non valido o danneggiato.');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ShareError('Link non valido o danneggiato.');
  const rec = obj as Record<string, unknown>;
  if (rec.v !== SHARE_VERSION) throw new ShareError(`Versione del link non supportata: ${String(rec.v)}.`);
  return rec;
}

/* ---------- link cliente ---------- */

/** Unico contenuto ammesso nel link cliente: nessun costo interno, ricarico, tariffa, potenza o consumabile. */
export interface ClientQuote {
  job?: string; biz?: string; notes?: string;
  /** data di emissione, YYYY-MM-DD */
  date: string;
  /** giorni di validita' */
  days: number;
  printer?: string; mat?: string; params?: string[];
  pieces: number;
  /** prezzo per pezzo e totale, gia' con ricarico */
  price: number; total: number;
  /** solo con Vendita attiva: imballo+spedizione, aliquota e importo IVA, totale cliente */
  sale?: { ship: number; vatPct: number; vat: number; tot: number };
  lang: 'it' | 'en';
  cur: string;
}

export interface ClientQuoteInput {
  job?: string; business?: string; notes?: string; date: string; days: number;
  printer?: string; material?: string; params?: readonly string[];
  pieces: number; price: number; total: number;
  sale?: SaleResult; vatPct?: number; lang: 'it' | 'en'; cur: string;
}

/** Costruisce il payload cliente scegliendo solo i campi ammessi (lista bianca, non filtro). */
export function buildClientQuote(i: ClientQuoteInput): ClientQuote {
  const q: ClientQuote = { date: i.date, days: i.days, pieces: i.pieces, price: i.price, total: i.total, lang: i.lang, cur: i.cur };
  const text = (k: 'job' | 'biz' | 'notes' | 'printer' | 'mat', v: string | undefined): void => { if (v?.trim()) q[k] = v.trim(); };
  text('job', i.job); text('biz', i.business); text('notes', i.notes); text('printer', i.printer); text('mat', i.material);
  if (i.params?.length) q.params = [...i.params];
  if (i.sale) q.sale = { ship: i.sale.shipping, vatPct: i.vatPct ?? 0, vat: i.sale.vat, tot: i.sale.customer };
  return q;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = 600): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

/** Valida un payload decodificato (potenzialmente ostile) e lo riduce ai soli campi ammessi. */
export function parseClientQuote(o: Record<string, unknown>): ClientQuote {
  if (!isNum(o.price) || !isNum(o.total) || !isNum(o.pieces)) throw new ShareError('Link non valido o danneggiato.');
  const s = o.sale;
  const sale = s !== null && typeof s === 'object' && isNum((s as Record<string, unknown>).tot) ? (s as Record<string, unknown>) : null;
  const num = (v: unknown): number => (isNum(v) && v >= 0 ? v : 0);
  if (o.price < 0 || o.total < 0 || o.pieces < 0) throw new ShareError('Link non valido o danneggiato.');
  if (o.days !== undefined && !(isNum(o.days) && o.days >= 1 && o.days <= 365)) throw new ShareError('Link non valido o danneggiato.');
  const q: ClientQuote = {
    date: str(o.date, 10) ?? '', days: isNum(o.days) ? Math.round(o.days) : 30, pieces: o.pieces, price: o.price, total: o.total,
    lang: o.lang === 'en' ? 'en' : 'it', cur: str(o.cur, 4) ?? '€',
  };
  const job = str(o.job, 80), biz = str(o.biz, 80), notes = str(o.notes, 500), printer = str(o.printer, 120), mat = str(o.mat, 120);
  if (job) q.job = job;
  if (biz) q.biz = biz;
  if (notes) q.notes = notes;
  if (printer) q.printer = printer;
  if (mat) q.mat = mat;
  if (Array.isArray(o.params)) q.params = o.params.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 200));
  if (sale) q.sale = { ship: num(sale.ship), vatPct: num(sale.vatPct), vat: num(sale.vat), tot: num(sale.tot) };
  return q;
}
