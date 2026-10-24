import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientQuote, decodeShare, encodeShare, parseClientQuote, ShareError } from '../src/share.ts';

test('round trip: encode/decode restituisce lo stesso oggetto, in base64url', async () => {
  const obj = { s: { values: { grams: 12.5, note: 'àè €' }, ids: ['a', 'b'] } };
  const enc = await encodeShare(obj);
  assert.match(enc, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShare(enc), { ...obj, v: 1 });
});

test('link cliente: solo campi ammessi, nessuna chiave interna', async () => {
  const q = buildClientQuote({
    job: 'Staffa', business: 'Officina 3D', date: '2026-10-24', days: 30, printer: 'Prusa MK4', material: 'PETG',
    pieces: 2, price: 5, total: 10, sale: { base: 12, fees: 0.5, shipping: 2, vat: 2.75, customer: 15.25 }, vatPct: 22, lang: 'it', cur: '€',
  });
  const dec = await decodeShare(await encodeShare({ ...q }));
  const allowed = ['job', 'biz', 'notes', 'date', 'days', 'printer', 'mat', 'params', 'pieces', 'price', 'total', 'sale', 'lang', 'cur', 'v'];
  assert.ok(Object.keys(dec).every((k) => allowed.includes(k)));
  const json = JSON.stringify(dec);
  for (const bad of ['markup', 'margin', 'subtotal', 'lines', 'watt', 'laborRate', 'laborMin', 'eurKg', 'wear', 'machineCost', 'energyRate', 'fees', 'values', 'settings']) {
    assert.ok(!json.includes(bad), bad);
  }
});

test('versione sconosciuta o dati corrotti: ShareError', async () => {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  void w.write(new TextEncoder().encode(JSON.stringify({ v: 99 })));
  void w.close();
  const enc = Buffer.from(await new Response(cs.readable).arrayBuffer()).toString('base64url');
  await assert.rejects(decodeShare(enc), ShareError);
  await assert.rejects(decodeShare('!!non-valido'), ShareError);
});

test('quote ostile rifiutato: numeri negativi/non finiti o payload oltre 1 MB', async () => {
  const bad = { price: -1, total: 10, pieces: 1, date: '2026-10-24', days: 30, lang: 'it', cur: '€' };
  assert.throws(() => parseClientQuote(bad), ShareError);
  assert.throws(() => parseClientQuote({ ...bad, price: 1, sale: { tot: 5, vat: -3 } }) && parseClientQuote({ ...bad, price: 1, pieces: 'x' }), ShareError);
  const big = await encodeShare({ pad: 'a'.repeat(2 * 1024 * 1024) });
  await assert.rejects(decodeShare(big), ShareError);
});

test('days fuori range 1-365 rifiutato', () => {
  const ok = { price: 1, total: 1, pieces: 1, date: '2026-10-24', lang: 'it', cur: '€' };
  for (const days of [0, 366, -5, 1e9]) assert.throws(() => parseClientQuote({ ...ok, days }), ShareError);
  assert.equal(parseClientQuote({ ...ok, days: 365 }).days, 365);
});
