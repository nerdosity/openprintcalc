import test from 'node:test';
import assert from 'node:assert/strict';
import { splitHoursByBand, easter, isHoliday } from '../src/energy.ts';

const near = (a: number | undefined, b: number): void => assert.ok(Math.abs((a ?? 0) - b) < 1e-9, `${a} != ${b}`);

test('sabato, domenica e festivi (Pasquetta) secondo ARERA', () => {
  assert.deepEqual(easter(2026), { month: 3, day: 5 });
  assert.ok(isHoliday(new Date(2026, 3, 6)) && !isHoliday(new Date(2026, 3, 7)));
  // sabato 06:00, 3 h: 1 h F3 poi 2 h F2
  const sat = splitHoursByBand(new Date(2026, 9, 24, 6, 0), 3, 'tri');
  near(sat.F3, 1); near(sat.F2, 2); assert.equal(sat.F1, undefined);
  // domenica 10:00 e Pasquetta (lunedi) 10:00: tutto F3
  near(splitHoursByBand(new Date(2026, 9, 25, 10, 0), 2, 'tri').F3, 2);
  near(splitHoursByBand(new Date(2026, 3, 6, 10, 0), 2, 'tri').F3, 2);
});

test('stampa a cavallo di mezzanotte: venerdi 22:00 per 4 h', () => {
  const r = splitHoursByBand(new Date(2026, 9, 23, 22, 0), 4, 'tri');
  near(r.F2, 1); near(r.F3, 3); // 22-23 F2, poi F3 fino alle 02 di sabato
  const bi = splitHoursByBand(new Date(2026, 9, 23, 17, 30), 2, 'bi');
  near(bi.F1, 1.5); near(bi.F23, 0.5);
});

test('stampa lunga oltre 20000 h: nessun tetto, ore conservate', () => {
  const r = splitHoursByBand(new Date(2026, 0, 5, 0, 0), 25000, 'tri');
  near(Object.values(r).reduce((a, b) => a + b, 0), 25000);
});

test('fasce personalizzate con nomi duplicati restano distinte; from == to = 24 h', () => {
  const bands = [
    { name: 'X', day: 'weekday' as const, from: 8, to: 12, price: 0.1 },
    { name: 'X', day: 'weekday' as const, from: 12, to: 12, price: 0.2 },
  ];
  const r = splitHoursByBand(new Date(2026, 9, 23, 8, 0), 6, 'custom', bands);
  assert.equal(Object.keys(r).length, 2);
  near(Object.values(r).reduce((a, b) => a + b, 0), 6);
  assert.ok(isHoliday(new Date(2026, 9, 4)));
});
