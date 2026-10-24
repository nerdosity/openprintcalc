// .3mf / .gcode.3mf: Bambu/Orca (slice_info.config + plate_1.gcode) e PrusaSlicer (solo config).
import { extract, parseComments } from '../gcode.ts';
import { parseGcodeText } from './gcode-text.ts';
import { emptyPrint } from './types.ts';
import type { ParsedPrint, ParseWarning } from './types.ts';
import { openZip } from './zip.ts';

const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

export async function parseThreeMf(buffer: ArrayBuffer): Promise<ParsedPrint> {
  const zip = openZip(buffer);
  const dec = new TextDecoder();
  const warnings: ParseWarning[] = [];
  let r: ParsedPrint | null = null;

  const plate = zip.names.find((n) => n === 'Metadata/plate_1.gcode') ?? zip.names.find((n) => /^Metadata\/plate_\d+\.gcode$/.test(n));
  if (plate) {
    try { r = parseGcodeText(dec.decode(await zip.readEntry(plate))); }
    catch (e) { warnings.push({ key: 'warn.plateUnreadable', params: { err: e instanceof Error ? e.message : String(e) } }); }
  }

  if (zip.has('Metadata/slice_info.config')) {
    const xml = dec.decode(await zip.readEntry('Metadata/slice_info.config'));
    const fil = [...xml.matchAll(/<filament\b[^>]*>/g)].map((m) => m[0]);
    const perId: number[] = [];
    for (const f of fil) {
      const id = parseInt(attr(f, 'id') ?? '', 10), g = parseFloat(attr(f, 'used_g') ?? '');
      if (Number.isFinite(id) && id > 0 && Number.isFinite(g)) perId[id - 1] = g;
    }
    const grams = Array.from(perId, (x) => x ?? 0);
    const metas = [...xml.matchAll(/<metadata\b[^>]*>/g)].map((m) => m[0]);
    const meta = (key: string): string | null => {
      const t = metas.find((x) => attr(x, 'key') === key);
      return t ? attr(t, 'value') : null;
    };
    const pred = parseFloat(meta('prediction') ?? '');
    const weight = parseFloat(meta('weight') ?? '');
    r ??= emptyPrint('bambustudio');
    if (r.hours === null && Number.isFinite(pred)) r.hours = pred / 3600; // unita assunta: secondi (non verificata)
    // il peso di slice_info vale piu' di una stima dalla lunghezza e riempie un peso mancante
    const sliceGrams = Number.isFinite(weight) ? weight : grams.length ? grams.reduce((x, y) => x + y, 0) : null;
    const estimated = r.warnings.some((w) => w.key === 'warn.gramsFromLength');
    if (sliceGrams !== null && (r.grams === null || estimated)) {
      r.grams = sliceGrams;
      r.warnings = r.warnings.filter((w) => w.key !== 'warn.gramsFromLength' && w.key !== 'warn.noWeight');
    }
    if (!r.perExtruderGrams.length && grams.length) r.perExtruderGrams = grams;
    if (r.nozzleDiameter === null) {
      const nd = parseFloat(meta('nozzle_diameters') ?? '');
      if (Number.isFinite(nd)) r.nozzleDiameter = nd;
    }
    const f0 = fil[0];
    if (r.filamentType === null && f0) r.filamentType = attr(f0, 'type');
  }

  if (r) { r.warnings.push(...warnings); return r; }

  if (zip.has('Metadata/Slic3r_PE.config')) {
    const kv = parseComments(dec.decode(await zip.readEntry('Metadata/Slic3r_PE.config')));
    const d = extract(kv);
    const p = emptyPrint('prusaslicer');
    p.printerModel = d.printerModel; p.printerSettingsId = d.printerSettingsId; p.filamentType = d.filamentType;
    p.filamentSettingsId = kv.filament_settings_id ? (kv.filament_settings_id.split(';')[0] ?? '').replace(/^"|"$/g, '').trim() : null;
    p.filamentCost = d.filamentCost; p.filamentDensity = d.density; p.nozzleDiameter = d.nozzleDiameter;
    p.nozzleTemp = d.nozzleTemp; p.bedTemp = d.bedTemp; p.params = d.params;
    p.warnings.push(...warnings, { key: 'warn.prusa3mf' });
    return p;
  }
  const u = emptyPrint();
  u.warnings.push(...warnings, { key: 'warn.no3mf' });
  return u;
}
