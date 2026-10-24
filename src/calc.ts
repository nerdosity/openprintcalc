// Logica di calcolo pura: nessun accesso al DOM.
import { fmtCur, fmtNum, t } from './i18n.ts';
import { BASE_BAND, bandLabel } from './energy.ts';
import type { AmortInputs, AmortSettings, ComputeExtras, ComputeInput, ComputeResult, Consumable, CostLine, Printer, QuoteContext, QuoteInput, SaleResult, SlaInput, SaleSettings, WattEstimate, WattInput, WattPick } from './types.ts';

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

/** Usura SLA dai consumabili: voci a numero di stampe (FEP) in €/stampa, voci a ore (LCD) in €/h. `optional` ignorate. */
export function wearSla(consumables: readonly Consumable[] | null | undefined): { perPrint: number; perHour: number } {
  let perPrint = 0, perHour = 0;
  for (const c of Array.isArray(consumables) ? consumables : []) {
    if (c?.optional === true) continue;
    const cost = unwrap(c?.cost_eur), prints = unwrap(c?.life_prints), hours = unwrap(c?.life_h);
    if (cost === null) continue;
    if (prints !== null && prints > 0) perPrint += cost / prints;
    else if (hours !== null && hours > 0) perHour += cost / hours;
  }
  return { perPrint, perHour };
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

/** Scarto multicolore in g, limitato al peso totale: il materiale del pezzo e' totale - scarto. */
export function wasteSplit(grams: unknown, waste: unknown): { part: number; waste: number } {
  const total = Math.max(0, n(grams));
  const w = Math.min(Math.max(0, n(waste)), total);
  return { part: total - w, waste: w };
}

/** kWh ed energia di un pezzo; con le fasce attive somma ore x W x prezzo di fascia (le ore sono della serie intera, quindi / pezzi). */
function energyCost(watt: number, hours: number, factor: number, pieces: number, rate: number, x: ComputeExtras): { kwh: number; energy: number } {
  if (!x.bandHours) {
    const kwh = (watt / 1000) * hours * factor;
    return { kwh, energy: kwh * rate };
  }
  let kwh = 0, energy = 0;
  for (const [band, h] of Object.entries(x.bandHours)) {
    const k = (watt / 1000) * (h / pieces) * factor;
    kwh += k;
    energy += k * (x.bandPrice?.[band] ?? rate);
  }
  return { kwh, energy };
}

/**
 * Calcola il preventivo. grams e hours sono riferiti a un pezzo.
 * Il tasso di fallimento aumenta i costi di macchina e materiale (1/(1-f)), non la manodopera.
 */
export function compute(i: ComputeInput, x: ComputeExtras = {}): ComputeResult {
  const pieces = Math.max(1, Math.round(n(i.pieces)) || 1);
  const fail = Math.min(Math.max(n(i.failPct), 0), 95) / 100;
  const factor = 1 / (1 - fail);
  const hours = n(i.hours);
  const { kwh, energy } = energyCost(n(i.watt), hours, factor, pieces, n(i.energyRate), x);

  const split = wasteSplit(i.grams, i.wasteG);
  const lines: Record<CostLine, number> = {
    material: (split.part / 1000) * n(i.eurKg) * factor,
    waste: (split.waste / 1000) * n(i.eurKg) * factor,
    energy,
    amort: n(i.lifeH) > 0 ? (n(i.machineCost) / n(i.lifeH)) * hours * factor : 0,
    wear: n(i.wear) * hours * factor,
    labor: ((n(i.laborMin) + n(x.postMin)) / 60) * n(i.laborRate),
    wash: 0,
  };
  const subtotal = Object.values(lines).reduce((a, b) => a + b, 0);
  const margin = subtotal * (n(i.markupPct) / 100);
  const price = subtotal + margin;
  return { pieces, factor, kwh, lines, subtotal, margin, price, total: price * pieces, ...(x.bandHours ? { bands: x.bandHours } : {}) };
}

/**
 * Preventivo in modalita' resina. ml e hours sono riferiti a un pezzo (una stampa).
 * Il tasso di fallimento aumenta resina, lavaggio, energia, ammortamento e usura (1/(1-f)), non la manodopera.
 * Usura = €/stampa (pellicola FEP) + €/h x ore (display LCD). Lavaggio = ml IPA x €/L.
 */
export function computeSla(i: SlaInput, x: ComputeExtras = {}): ComputeResult {
  const pieces = Math.max(1, Math.round(n(i.pieces)) || 1);
  const fail = Math.min(Math.max(n(i.failPct), 0), 95) / 100;
  const factor = 1 / (1 - fail);
  const hours = n(i.hours);
  const { kwh, energy } = energyCost(n(i.watt), hours, factor, pieces, n(i.energyRate), x);
  const lines: Record<CostLine, number> = {
    material: (n(i.ml) / 1000) * n(i.eurL) * factor,
    waste: 0,
    wash: (n(i.ipaMl) / 1000) * n(i.ipaEurL) * factor,
    energy,
    amort: n(i.lifeH) > 0 ? (n(i.machineCost) / n(i.lifeH)) * hours * factor : 0,
    wear: (n(i.wearPrint) + n(i.wearH) * hours) * factor,
    labor: ((n(i.laborMin) + n(x.postMin)) / 60) * n(i.laborRate),
  };
  const subtotal = Object.values(lines).reduce((a, b) => a + b, 0);
  const margin = subtotal * (n(i.markupPct) / 100);
  const price = subtotal + margin;
  return { pieces, factor, kwh, lines, subtotal, margin, price, total: price * pieces, ...(x.bandHours ? { bands: x.bandHours } : {}) };
}

/** Costo macchina e vita utile dalla scheda Ammortamento: prezzo - residuo + manutenzione x anni; anni x ore/anno. */
export function amortizationInputs(a: AmortSettings): AmortInputs {
  const price = Math.max(n(a.price), 0), years = n(a.years), perYear = n(a.hoursPerYear);
  if (!(years > 0) || !(perYear > 0)) return { machineCost: null, lifeH: null };
  const residual = Math.min(Math.max(n(a.residual), 0), price);
  return { machineCost: Math.max(0, price - residual) + Math.max(n(a.maintenance), 0) * years, lifeH: years * perYear };
}

/**
 * Costi di vendita sul totale (con ricarico, tutti i pezzi). Imballo e spedizione sono per ordine.
 * Le commissioni si applicano a quanto paga il cliente IVA inclusa: cliente = (base + fisso) / (1/(1+iva) - %).
 */
export function applySale(total: number, s: SaleSettings): SaleResult {
  if (!s.enabled) return { base: total, fees: 0, shipping: 0, vat: 0, customer: total };
  const shipping = n(s.packaging) + n(s.shipping);
  const base = total + shipping;
  const pct = s.platform === 'none' ? 0 : Math.min(Math.max(n(s.feePct), 0), 95) / 100;
  const fixed = s.platform === 'none' ? 0 : n(s.feeFixed);
  const v = n(s.vatPct) / 100;
  const customer = s.platform === 'none' ? base * (1 + v) : (base + fixed) / (1 / (1 + v) - pct);
  const vat = customer * v / (1 + v);
  return { base, fees: customer * pct + fixed, shipping, vat, customer };
}

/** "F1 1,2 h · F3 3,0 h" */
export function bandsText(bands: Readonly<Record<string, number>>): string {
  return Object.entries(bands).filter(([, h]) => h >= 0.005).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, h]) => `${k === BASE_BAND ? t('energy.base') : bandLabel(k)} ${fmtNum(h, 1, 1)} h`).join(' · ');
}

export const eur = fmtCur;
const num = (v: unknown, d = 1): string => fmtNum(v, d);

export function quoteText(i: QuoteInput, r: ComputeResult, ctx: QuoteContext = {}): string {
  const L = r.lines;
  const out: string[] = [t('q.title')];
  if (ctx.business) out.push(ctx.business);
  out.push('');
  if (ctx.printer) out.push(t('q.printer', { v: ctx.printer }));
  if (ctx.filament) out.push(t(ctx.resin ? 'q.resin' : 'q.material', { v: ctx.filament }));
  out.push(ctx.resin ? t('q.perPieceMl', { ml: num(n(i.ml)), h: num(n(i.hours), 2) }) : t('q.perPiece', { g: num(n(i.grams)), h: num(n(i.hours), 2) }));
  out.push(t('q.pieces', { n: r.pieces }));
  if (ctx.params?.length) out.push('', t('q.params'), ...ctx.params.map((l) => `  ${l}`));
  out.push('');
  const row = (label: string, v: number, extra = ''): string => `${label.padEnd(Math.max(15, label.length + 1))}${eur(v)}${extra}`;
  out.push(row(t(ctx.resin ? 'line.resin' : 'line.material'), L.material));
  if (L.waste > 0) out.push(row(t('line.waste'), L.waste));
  if (L.wash > 0) out.push(row(t('line.wash'), L.wash));
  out.push(row(t('line.energy'), L.energy, `  (${r.bands ? bandsText(r.bands) : `${num(r.kwh, 2)} kWh`})`));
  out.push(row(t('line.amort'), L.amort));
  out.push(row(t('line.wear'), L.wear));
  out.push(row(t('line.labor'), L.labor));
  if (r.factor > 1.0001) out.push(t('q.fail', { n: num(n(i.failPct)) }));
  out.push('', row(t('res.sub'), r.subtotal));
  out.push(`${t('res.markupN', { n: num(n(i.markupPct), 0) })}  ${eur(r.margin)}`, '');
  out.push(t('q.price', { v: eur(r.price) }));
  out.push(t('q.totalPz', { n: r.pieces, v: eur(r.total) }));
  const s = ctx.sale;
  if (s) {
    out.push('');
    if (s.fees > 0) out.push(row(t('line.fees'), s.fees));
    if (s.shipping > 0) out.push(row(t('line.ship'), s.shipping));
    out.push(row(t('line.vat', { n: num(ctx.vatPct ?? 0, 1) }), s.vat));
    out.push(row(t('res.customer'), s.customer));
  }
  if (ctx.notes) out.push('', ctx.notes);
  return out.join('\n');
}
