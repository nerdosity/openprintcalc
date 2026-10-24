import test from 'node:test';
import assert from 'node:assert/strict';
import { compute, computeSla, wearSla, wearPerHour, pickWatt, pricePerKg, isHighTemp, estimateWatts } from '../src/calc.ts';

test('usura = somma costo/vita, ignora voci nulle e valori {value}', () => {
  const w = wearPerHour([
    { name: 'Ugello', cost_eur: { value: 9, estimated: true }, life_h: 400 },
    { name: 'PEI', cost_eur: 40, life_h: { value: 2000 } },
    { name: 'Incompleto', cost_eur: null, life_h: 100 },
  ]);
  assert.ok(Math.abs(w - (9 / 400 + 40 / 2000)) < 1e-12);
});

test('potenza: avg_high_temp per ABS, avg_pla per PLA, ripiego se null', () => {
  const p = { power_w: { avg_pla: { value: 85 }, avg_high_temp: { value: 110, estimated: true } } };
  assert.deepEqual(pickWatt(p, 'ABS'), { value: 110, estimated: true, key: 'power_w.avg_high_temp' });
  assert.equal(pickWatt(p, 'PETG').value, 85);
  assert.equal(pickWatt({ power_w: { avg_pla: 60, avg_high_temp: null } }, 'ASA').value, 60);
  assert.equal(pickWatt({ power_w: null }, 'PLA').value, null);
  assert.ok(Math.abs(pricePerKg(20, 800)! - 25) < 1e-9);
});

test('compute: totali con scarti, ricarico e pezzi', () => {
  const r = compute({
    grams: 100, eurKg: 20, hours: 10, watt: 100, energyRate: 0.3, machineCost: 1000,
    lifeH: 5000, wear: 0.1, laborMin: 30, laborRate: 20, pieces: 3, failPct: 0, markupPct: 50,
  });
  // materiale 2 + energia 0.3 + amm. 2 + usura 1 + lavoro 10
  assert.ok(Math.abs(r.subtotal - 15.3) < 1e-9);
  assert.ok(Math.abs(r.price - 22.95) < 1e-9);
  assert.ok(Math.abs(r.total - 68.85) < 1e-9);
  const f = compute({ grams: 100, eurKg: 20, failPct: 50 });
  assert.ok(Math.abs(f.lines.material - 4) < 1e-9);
});

test('isHighTemp: PA/PPS e varianti sì, PCTG e PETG no', () => {
  for (const m of ['PA', 'PA12-CF', 'PPS', 'PEEK', 'ABS', 'PC']) assert.equal(isHighTemp(m), true, m);
  for (const m of ['PLA', 'PETG', 'PCTG', 'TPU', '']) assert.equal(isHighTemp(m), false, m);
});

test('wearPerHour salta i consumabili optional', () => {
  const w = wearPerHour([
    { name: 'Brass', cost_eur: 10, life_h: 100 },
    { name: 'Hardened', cost_eur: 40, life_h: 100, optional: true },
  ]);
  assert.ok(Math.abs(w - 0.1) < 1e-12);
});

const MK4S = { bedX: 250, bedY: 210, nozzleDiam: 0.4, idleW: 15, bedHeaterW: 220, hotendHeaterW: 40 };

test('estimateWatts: calibrazione MK4S PLA (60/215) ~80 W e ABS (100/255) ~120 W', () => {
  const pla = estimateWatts({ ...MK4S, bedTemp: 60, nozzleTemp: 215 });
  assert.ok(Math.abs(pla.watts - 80) < 2, String(pla.watts));
  assert.equal(pla.base, 27);
  const abs = estimateWatts({ ...MK4S, bedTemp: 100, nozzleTemp: 255 });
  assert.ok(Math.abs(abs.watts - 120) < 3, String(abs.watts));
});

test('estimateWatts: riscaldatori limitano letto/hotend, camera chiusa riduce il letto, default senza dati', () => {
  const cap = estimateWatts({ ...MK4S, bedTemp: 100, nozzleTemp: 255, bedHeaterW: 30, hotendHeaterW: 5 });
  assert.equal(cap.bed, 30);
  assert.equal(cap.hotend, 5);
  const open = estimateWatts({ ...MK4S, bedTemp: 100, nozzleTemp: 255 });
  assert.ok(estimateWatts({ ...MK4S, bedTemp: 100, nozzleTemp: 255, enclosed: true }).bed < open.bed);
  const d = estimateWatts({ bedX: 250, bedY: 210, bedTemp: 60, nozzleTemp: 215 });
  assert.equal(d.base, 24);
  assert.ok(d.hotend <= 40 && d.bed <= 4000 * 0.0525);
});

import { mergeCatalogs } from '../src/catalog.ts';
test('mergeCatalogs: esclude le voci PrusaSlicer gia curate e normalizza le altre', () => {
  const m = mergeCatalogs([{ id: 'a', prusaslicer_models: ['MK4'] }], [
    { id: 'ps-1', vendor: 'V', model: 'M', name: 'V M', bed_mm: [200, 210], nozzles_mm: [0.6, 0.4], prusaslicer_models: ['mk4'] },
    { id: 'ps-2', vendor: 'V', model: 'N', name: 'V N', bed_mm: null, nozzles_mm: [0.6], prusaslicer_models: ['N'] },
  ]);
  assert.deepEqual(m.map((p) => p.id), ['a', 'ps-2']);
  assert.equal(m[1]!.nozzle_mm, 0.6);
  assert.equal(m[1]!.bed_mm, null);
});

test('estimateWatts: il riscaldatore hotend limita dispersione+fusione insieme', () => {
  const r = estimateWatts({ bedX: 250, bedY: 210, bedTemp: 60, nozzleTemp: 255, nozzleDiam: 0.8, hotendHeaterW: 20 });
  assert.ok(Math.abs(r.hotend + r.melt - 20) < 1e-9);
  assert.ok(r.melt > 0);
  const free = estimateWatts({ bedX: 250, bedY: 210, bedTemp: 60, nozzleTemp: 255, nozzleDiam: 0.8, hotendHeaterW: 1000 });
  assert.ok(free.hotend + free.melt > 20);
});

import { bestModelMatch } from '../src/catalog.ts';
test('bestModelMatch: sceglie il modello piu lungo contenuto nell id impostazioni', () => {
  const list = [{ id: 'a', model: 'MK3' }, { id: 'b', model: 'MK3S' }, { id: 'c', model: 'MINI' }];
  assert.equal(bestModelMatch(list, 'Original Prusa MK3S 0.4')!.id, 'b');
  assert.equal(bestModelMatch(list, 'xyz'), null);
});

test('ammortamento: prezzo - residuo + manutenzione x anni; vita = anni x ore/anno', async () => {
  const { amortizationInputs } = await import('../src/calc.ts');
  const a = { enabled: true, price: 1000, residual: 200, years: 4, hoursPerYear: 500, maintenance: 50 };
  assert.deepEqual(amortizationInputs(a), { machineCost: 1000, lifeH: 2000 });
  assert.deepEqual(amortizationInputs({ ...a, years: 0 }), { machineCost: null, lifeH: null });
});

test('ammortamento: residuo oltre il prezzo, prezzo 0 con manutenzione', async () => {
  const { amortizationInputs } = await import('../src/calc.ts');
  const a = { enabled: true, price: 100, residual: 500, years: 2, hoursPerYear: 100, maintenance: 10 };
  assert.deepEqual(amortizationInputs(a), { machineCost: 20, lifeH: 200 });
  assert.deepEqual(amortizationInputs({ ...a, price: 0 }), { machineCost: 20, lifeH: 200 });
  assert.deepEqual(amortizationInputs({ ...a, hoursPerYear: 0 }), { machineCost: null, lifeH: null });
});

test('vendita: commissioni sul prezzo IVA inclusa, imballo/spedizione', async () => {
  const { applySale } = await import('../src/calc.ts');
  const s = { enabled: true, vatPct: 22, platform: 'etsy' as const, feePct: 10, feeFixed: 0.5, packaging: 2, shipping: 8, postMin: 0 };
  const r = applySale(100, s);
  const customer = 110.5 / (1 / 1.22 - 0.1);
  assert.ok(Math.abs(r.customer - customer) < 1e-9);
  assert.ok(Math.abs(r.fees - (customer * 0.1 + 0.5)) < 1e-9);
  assert.ok(Math.abs(r.customer - r.vat - r.fees - 110) < 1e-9); // incasso netto = base
  assert.equal(applySale(100, { ...s, enabled: false }).customer, 100);
});

test('scarto multicolore: riga separata, materiale = totale - scarto, fallimenti inclusi', () => {
  const r = compute({ grams: 100, wasteG: 40, eurKg: 20, failPct: 50 });
  assert.ok(Math.abs(r.lines.material - 2.4) < 1e-9); // 60 g x 20 EUR/kg x 2
  assert.ok(Math.abs(r.lines.waste - 1.6) < 1e-9);
  assert.equal(compute({ grams: 10, wasteG: 50, eurKg: 20 }).lines.material, 0); // scarto limitato al totale
  assert.equal(compute({ grams: 100, eurKg: 20 }).lines.waste, 0);
});

test('computeSla: resina, lavaggio, energia, ammortamento, usura per stampa e per ora, fallimenti e ricarico', () => {
  const base = {
    ml: 25, eurL: 30, ipaMl: 50, ipaEurL: 4, hours: 3, watt: 100, energyRate: 0.3, machineCost: 800, lifeH: 8000,
    wearPrint: 0.12, wearH: 0.045, laborMin: 6, laborRate: 20, pieces: 2, failPct: 0, markupPct: 50,
  };
  const r = computeSla(base);
  assert.ok(Math.abs(r.lines.material - 0.75) < 1e-9);
  assert.ok(Math.abs(r.lines.wash - 0.2) < 1e-9);
  assert.ok(Math.abs(r.lines.energy - 0.09) < 1e-9);
  assert.ok(Math.abs(r.lines.amort - 0.3) < 1e-9);
  assert.ok(Math.abs(r.lines.wear - (0.12 + 0.045 * 3)) < 1e-9);
  assert.ok(Math.abs(r.lines.labor - 2) < 1e-9);
  assert.equal(r.lines.waste, 0);
  assert.ok(Math.abs(r.price - r.subtotal * 1.5) < 1e-9 && Math.abs(r.total - r.price * 2) < 1e-9);
  // i fallimenti (20% -> x1,25) pesano su resina, lavaggio, energia, ammortamento e usura, non sulla manodopera
  const f = computeSla({ ...base, failPct: 20 });
  assert.ok(Math.abs(f.lines.material - 0.75 * 1.25) < 1e-9 && Math.abs(f.lines.wash - 0.25) < 1e-9);
  assert.equal(f.lines.labor, r.lines.labor);
  // usura dai consumabili: FEP a stampe -> €/stampa, LCD a ore -> €/h
  const w = wearSla([{ name: 'FEP', cost_eur: 6, life_prints: { value: 50 } }, { name: 'LCD', cost_eur: 90, life_h: 2000 }]);
  assert.ok(Math.abs(w.perPrint - 0.12) < 1e-12 && Math.abs(w.perHour - 0.045) < 1e-12);
});
