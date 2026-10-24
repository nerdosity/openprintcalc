// Logica di calcolo pura: nessun accesso al DOM.
import type { ComputeInput, ComputeResult, Consumable, CostLine, Printer, QuoteContext, WattEstimate, WattInput, WattPick } from './types.ts';

export const HIGH_TEMP_RE = /^(ABS|ASA|PC(?!TG)|PA|PP|PEI|PEEK|PEKK|PSU|PVDF)/i;

/** Estrae un numero da un valore grezzo o da {value, estimated}; null se assente/non valido. */
export function unwrap(x: unknown): number | null {
  const raw = x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as { value?: unknown }).value : x;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function isEstimated(x: unknown): boolean {
  return x !== null && typeof x === 'object' && Boolean((x as { estimated?: unknown }).estimated);
}

/** Usura in €/h: somma di costo/vita dei consumabili (voci incomplete e `optional` ignorate). */
export function wearPerHour(consumables: readonly Consumable[] | null | undefined): number {
  if (!Array.isArray(consumables)) return 0;
  let sum = 0;
  for (const c of consumables) {
    if (c?.optional === true) continue;
    const cost = unwrap(c?.cost_eur);
    const life = unwrap(c?.life_h);
    if (cost !== null && life !== null && life > 0) sum += cost / life;
  }
  return sum;
}

export function isHighTemp(material: unknown): boolean {
  return HIGH_TEMP_RE.test(String(material ?? '').trim());
}

/** Potenza media in W: avg_high_temp per ABS/ASA/PC/PA/PP, altrimenti avg_pla (con ripiego sull'altra). */
export function pickWatt(printer: Pick<Printer, 'power_w'> | null | undefined, material: unknown): WattPick {
  const p = printer?.power_w ?? {};
  const highRaw = p.avg_high_temp ?? p.avg_abs_enclosed_or_high_temp;
  const high = unwrap(highRaw);
  const pla = unwrap(p.avg_pla);
  const HK = 'power_w.avg_high_temp' as const, PK = 'power_w.avg_pla' as const;
  if (isHighTemp(material) && high !== null) return { value: high, estimated: isEstimated(highRaw), key: HK };
  if (pla !== null) return { value: pla, estimated: isEstimated(p.avg_pla), key: PK };
  return { value: high, estimated: isEstimated(highRaw), key: HK };
}

/** Prezzo al kg da prezzo bobina e peso bobina (g). */
export function pricePerKg(spoolPrice: unknown, spoolGrams: unknown): number | null {
  const p = Number(spoolPrice), g = Number(spoolGrams);
  return p > 0 && g > 0 ? (p / g) * 1000 : null;
}

const FLOW_PTS: ReadonlyArray<readonly [number, number]> = [[0.25, 3], [0.4, 8], [0.6, 15], [0.8, 24]];

/** Portata massima di fusione (mm3/s) per diametro ugello: interpolazione/estrapolazione lineare sull'area. */
export function meltFlow(d: number): number {
  const pts = FLOW_PTS.map(([x, f]): [number, number] => [x * x, f]);
  const a = d * d;
  let i = 0;
  while (i < pts.length - 2 && a > pts[i + 1]![0]) i++;
  const [a0, f0] = pts[i]!, [a1, f1] = pts[i + 1]!;
  return Math.max(0, f0 + ((a - a0) * (f1 - f0)) / (a1 - a0));
}

/** Modello fisico semplificato del consumo medio in W (letto, hotend, fusione, base). */
export function estimateWatts({ bedX, bedY, bedTemp, nozzleDiam, nozzleTemp, ambient = 22, enclosed = false,
  bedHeaterW, hotendHeaterW, idleW = 12, densityGcm3 = 1.24 }: WattInput = {}): WattEstimate {
  const v = (x: unknown, d: number): number => (x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : d);
  const area = (v(bedX, 0) / 1000) * (v(bedY, 0) / 1000);
  const amb = v(ambient, 22) + (enclosed ? 15 : 0);
  const dT = (t: unknown): number => Math.max(0, v(t, 0) - amb);
  const base = v(idleW, 12) + 12;
  const bed = Math.min(v(bedHeaterW, 4000 * area), 18 * area * dT(bedTemp));
  const loss = 0.07 * dT(nozzleTemp);
  const rawMelt = meltFlow(v(nozzleDiam, 0.4)) * (v(densityGcm3, 1.24) / 1000) * 2 * dT(nozzleTemp);
  // il riscaldatore limita dispersione e fusione insieme: tot = min(cap, loss+melt); la dispersione ha la precedenza
  const cap = v(hotendHeaterW, 40);
  const hotend = Math.min(cap, loss);
  const melt = Math.min(rawMelt, cap - hotend);
  return { watts: base + bed + hotend + melt, bed, hotend, melt, base };
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Calcola il preventivo. grams e hours sono riferiti a un pezzo.
 * Il tasso di fallimento aumenta i costi di macchina e materiale (1/(1-f)), non la manodopera.
 */
export function compute(i: ComputeInput): ComputeResult {
  const pieces = Math.max(1, Math.round(n(i.pieces)) || 1);
  const fail = Math.min(Math.max(n(i.failPct), 0), 95) / 100;
  const factor = 1 / (1 - fail);
  const hours = n(i.hours);
  const kwh = (n(i.watt) / 1000) * hours * factor;

  const lines: Record<CostLine, number> = {
    material: (n(i.grams) / 1000) * n(i.eurKg) * factor,
    energy: kwh * n(i.energyRate),
    amort: n(i.lifeH) > 0 ? (n(i.machineCost) / n(i.lifeH)) * hours * factor : 0,
    wear: n(i.wear) * hours * factor,
    labor: (n(i.laborMin) / 60) * n(i.laborRate),
  };
  const subtotal = Object.values(lines).reduce((a, b) => a + b, 0);
  const margin = subtotal * (n(i.markupPct) / 100);
  const price = subtotal + margin;
  return { pieces, factor, kwh, lines, subtotal, margin, price, total: price * pieces };
}

export const eur = (v: unknown): string =>
  Number(v).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const num = (v: unknown, d = 1): string => Number(v).toLocaleString('it-IT', { maximumFractionDigits: d });

export function quoteText(i: ComputeInput, r: ComputeResult, ctx: QuoteContext = {}): string {
  const L = r.lines;
  const out: string[] = ['PREVENTIVO STAMPA 3D', ''];
  if (ctx.printer) out.push(`Stampante: ${ctx.printer}`);
  if (ctx.filament) out.push(`Materiale: ${ctx.filament}`);
  out.push(`Per pezzo: ${num(n(i.grams))} g, ${num(n(i.hours), 2)} h di stampa`);
  out.push(`Pezzi: ${r.pieces}`);
  if (ctx.params?.length) out.push('', 'Parametri di stampa:', ...ctx.params.map((l) => `  ${l}`));
  out.push('');
  out.push(`Materiale      ${eur(L.material)}`);
  out.push(`Energia        ${eur(L.energy)}  (${num(r.kwh, 2)} kWh)`);
  out.push(`Ammortamento   ${eur(L.amort)}`);
  out.push(`Usura          ${eur(L.wear)}`);
  out.push(`Manodopera     ${eur(L.labor)}`);
  if (r.factor > 1.0001) out.push(`(costi di stampa inclusi scarti ${num(n(i.failPct))}%)`);
  out.push('', `Subtotale      ${eur(r.subtotal)}`);
  out.push(`Ricarico ${num(n(i.markupPct), 0)}%  ${eur(r.margin)}`, '');
  out.push(`Prezzo per pezzo: ${eur(r.price)}`);
  out.push(`Totale (${r.pieces} pz): ${eur(r.total)}`);
  return out.join('\n');
}
