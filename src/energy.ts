// Fasce orarie dell'energia (ARERA) e ripartizione delle ore di stampa. Funzioni pure, nessun DOM.
import type { CustomBand, DayKind, EnergyMode, EnergySettings } from './types.ts';

/** Pasqua (algoritmo di Meeus/Jones/Butcher): mese 0-11 e giorno. */
export function easter(year: number): { month: number; day: number } {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const x = h + l - 7 * m + 114;
  return { month: Math.floor(x / 31) - 1, day: (x % 31) + 1 };
}

/** Festivi nazionali fissi (mese 0-11 + giorno); Pasquetta si calcola. */
// 9-4 = 4 ottobre, San Francesco d'Assisi: festa nazionale dal 2026 (L. 151/2025).
const FIXED = ['0-1', '0-6', '3-25', '4-1', '5-2', '7-15', '9-4', '10-1', '11-8', '11-25', '11-26'];
export function isHoliday(d: Date): boolean {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  if (FIXED.includes(`${m}-${day}`)) return true;
  const e = easter(y);
  const monday = new Date(y, e.month, e.day + 1);
  return monday.getMonth() === m && monday.getDate() === day;
}

/** Tipo di giorno: i festivi valgono come domenica. */
export function dayKind(d: Date): DayKind {
  if (isHoliday(d) || d.getDay() === 0) return 'sun';
  return d.getDay() === 6 ? 'sat' : 'weekday';
}

function triBand(kind: DayKind, h: number): 'F1' | 'F2' | 'F3' {
  if (kind === 'sun') return 'F3';
  if (kind === 'sat') return h >= 7 && h < 23 ? 'F2' : 'F3';
  if (h >= 8 && h < 19) return 'F1';
  return (h >= 7 && h < 8) || (h >= 19 && h < 23) ? 'F2' : 'F3';
}

/** Nome visualizzato di una fascia personalizzata. */
export const bandName = (b: CustomBand, i: number): string => b.name.trim() || `#${i + 1}`;
/** Chiave di una fascia personalizzata: l'indice la identifica (i nomi possono ripetersi), il nome serve solo alla vista. */
export const customKey = (b: CustomBand, i: number): string => `c${i}:${bandName(b, i)}`;
/** Etichetta da mostrare per una chiave di fascia. */
export const bandLabel = (k: string): string => k.replace(/^c\d+:/, '');
/** Chiave delle ore non coperte da nessuna fascia personalizzata. */
export const BASE_BAND = 'base';

function bandAt(d: Date, mode: EnergyMode, custom: readonly CustomBand[]): string {
  const kind = dayKind(d), h = d.getHours();
  if (mode === 'tri') return triBand(kind, h);
  if (mode === 'bi') return triBand(kind, h) === 'F1' ? 'F1' : 'F23';
  const i = custom.findIndex((b) => b.day === kind && (b.from === b.to || (b.from < b.to ? h >= b.from && h < b.to : h >= b.from || h < b.to)));
  const hit = custom[i];
  return hit ? customKey(hit, i) : BASE_BAND;
}

/** Ripartisce `hours` ore di stampa a partire da `start` (ora locale) tra le fasce: ore per fascia. */
export function splitHoursByBand(start: Date, hours: number, mode: EnergyMode, custom: readonly CustomBand[] = []): Record<string, number> {
  const out: Record<string, number> = {};
  let left = Number.isFinite(hours) ? Math.max(0, hours) * 3600000 : 0;
  let t = start.getTime();
  if (!Number.isFinite(t)) return out;
  for (; left > 1e-6;) {
    const cur = new Date(t);
    const next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), cur.getHours() + 1).getTime();
    const seg = Math.min(left, Math.max(next - t, 1));
    const b = bandAt(cur, mode, custom);
    out[b] = (out[b] ?? 0) + seg / 3600000;
    t += seg;
    left -= seg;
  }
  return out;
}

/** Prezzo €/kWh per fascia; le ore non coperte (personalizzata) usano `baseRate`. */
export function bandPrices(e: EnergySettings, baseRate: number): Record<string, number> {
  if (e.mode === 'tri') return { F1: e.f1, F2: e.f2, F3: e.f3 };
  if (e.mode === 'bi') return { F1: e.f1, F23: e.f23 };
  const out: Record<string, number> = { [BASE_BAND]: baseRate };
  e.bands.forEach((b, i) => { out[customKey(b, i)] = b.price; });
  return out;
}
