// Parser per i commenti ASCII di un G-code PrusaSlicer (statistiche + blocco config).
// Usato anche da bgcode.ts per i metadati binari (stesse chiavi).
import { fmtNum, hasKey, t } from './i18n.ts';
import type { GcodeData, KV, LineWidth, PrintParams } from './types.ts';

/** "1d 2h 3m 4s" -> secondi (null se non riconosciuto). */
export function parseTime(str: unknown): number | null {
  const s = String(str ?? '');
  const re = /(\d+)\s*([dhms])/g;
  const mult: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0, found = false, m: RegExpExecArray | null;
  while ((m = re.exec(s))) { total += Number(m[1]) * (mult[m[2] ?? ''] ?? 0); found = true; }
  return found ? total : null;
}

/** Righe "; chiave = valore" -> oggetto. Ignora righe non chiave/valore (es. blocco JSON). */
export function parseComments(text: string): KV {
  const kv: KV = {};
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.startsWith(';')) continue;
    const m = /^;\s*([A-Za-z0-9_ \[\]()%./-]+?)\s*=\s*(.*?)\s*$/.exec(raw);
    if (m && m[1] !== undefined && !(m[1] in kv)) kv[m[1]] = m[2] ?? '';
  }
  return kv;
}

const first = (v: unknown, sep: string): string => (String(v ?? '').split(sep)[0] ?? '').trim();

/** Nome base del filamento: primo estrusore, senza virgolette e senza suffisso " @MK4". */
export function baseFilamentName(settingsId: unknown): string {
  return first(settingsId, ';').replace(/^"|"$/g, '').replace(/\s*@.*$/, '').trim();
}

const WIDTHS: ReadonlyArray<readonly [string, string]> = [
  ['external_perimeter_extrusion_width', 'Perimetro esterno'], ['perimeter_extrusion_width', 'Perimetri'],
  ['infill_extrusion_width', 'Riempimento'], ['solid_infill_extrusion_width', 'Riempimento solido'],
  ['top_infill_extrusion_width', 'Superficie superiore'], ['first_layer_extrusion_width', 'Primo strato'],
];

/** "0.45" -> mm, ""/"0" -> auto, "120%" -> percentuale del diametro ugello. null se la chiave manca. */
export function parseWidth(raw: unknown, nozzle: number | null = null): LineWidth | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  const x = parseFloat(s);
  if (s === '' || !Number.isFinite(x) || x === 0) return { kind: 'auto' };
  if (s.endsWith('%')) return { kind: 'pct', pct: x, mm: nozzle ? (x / 100) * nozzle : null };
  return { kind: 'mm', mm: x };
}

const intOf = (v: unknown): number | null => { const x = parseInt(String(v), 10); return Number.isFinite(x) ? x : null; };
const numOf = (v: unknown): number | null => { const x = parseFloat(String(v)); return Number.isFinite(x) ? x : null; };

/** Parametri di stampa informativi dal config (non entrano nel calcolo). */
export function extractParams(kv: KV, nozzle: number | null = null): PrintParams | null {
  const params: PrintParams = {
    perimeters: intOf(kv.perimeters), topSolidLayers: intOf(kv.top_solid_layers),
    bottomSolidLayers: intOf(kv.bottom_solid_layers),
    fillDensity: kv.fill_density ? String(kv.fill_density).trim() : null,
    layerHeight: numOf(kv.layer_height), widths: {},
  };
  for (const [k, label] of WIDTHS) {
    const w = parseWidth(kv[k], nozzle);
    if (w) params.widths[label] = w;
  }
  const any = params.perimeters !== null || params.topSolidLayers !== null || params.bottomSolidLayers !== null ||
    params.fillDensity !== null || params.layerHeight !== null || Object.keys(params.widths).length > 0;
  return any ? params : null;
}

/** Righe di testo per "Parametri di stampa". */
export function paramLines(p: PrintParams | null): string[] {
  if (!p) return [];
  const f = (x: number, d = 2): string => fmtNum(x, d);
  const out: string[] = [];
  if (p.perimeters !== null) out.push(t('pr.perimeters', { v: p.perimeters }));
  if (p.topSolidLayers !== null) out.push(t('pr.top', { v: p.topSolidLayers }));
  if (p.bottomSolidLayers !== null) out.push(t('pr.bottom', { v: p.bottomSolidLayers }));
  if (p.fillDensity) out.push(t('pr.fill', { v: p.fillDensity }));
  if (p.layerHeight !== null) out.push(t('pr.layer', { v: f(p.layerHeight) }));
  for (const [label, w] of Object.entries(p.widths)) {
    const v = w.kind === 'auto' ? t('pr.auto') : w.kind === 'mm' ? `${f(w.mm)} mm`
      : `${f(w.pct, 1)}%${w.mm !== null ? ` (${f(w.mm)} mm)` : ''}`;
    const key = `w.${label}`; // le chiavi di `widths` sono id stabili (italiano), l'etichetta viene dal dizionario
    out.push(t('pr.width', { label: hasKey(key) ? t(key) : label.toLowerCase(), v }));
  }
  return out;
}

/** Da un oggetto chiave/valore (ASCII o INI bgcode) ai dati che servono al calcolatore. */
export function extract(kv: KV): GcodeData {
  let grams: number | null = null;
  const total = parseFloat(kv['total filament used [g]'] ?? '');
  if (Number.isFinite(total)) grams = total;
  else if (kv['filament used [g]']) {
    grams = kv['filament used [g]'].split(',').reduce((a, b) => a + (parseFloat(b) || 0), 0);
  }
  const secs = parseTime(kv['estimated printing time (normal mode)']);
  const density = parseFloat(first(kv.filament_density, ','));
  const cost = parseFloat(first(kv.filament_cost, ';'));
  return {
    grams,
    hours: secs === null ? null : secs / 3600,
    printerModel: kv.printer_model ? first(kv.printer_model, ';') : null,
    printerSettingsId: kv.printer_settings_id ? kv.printer_settings_id.replace(/^"|"$/g, '') : null,
    filamentName: kv.filament_settings_id ? baseFilamentName(kv.filament_settings_id) : null,
    filamentType: kv.filament_type ? first(kv.filament_type, ';') : null,
    density: Number.isFinite(density) ? density : null,
    filamentCost: Number.isFinite(cost) && cost > 0 ? cost : null,
    nozzleTemp: numOf(first(kv.temperature, ',')),
    bedTemp: numOf(first(kv.bed_temperature, ',')),
    nozzleDiameter: numOf(first(kv.nozzle_diameter, ',')),
    params: extractParams(kv, numOf(first(kv.nozzle_diameter, ','))),
  };
}

/** Parsa il testo (anche solo la coda) di un .gcode ASCII. */
export function parseGcode(text: string): GcodeData {
  return extract(parseComments(text));
}
