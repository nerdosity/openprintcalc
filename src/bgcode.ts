// Lettore minimale di .bgcode (libbgcode): legge solo i blocchi di metadati.
import { extract } from './gcode.ts';
import { t } from './i18n.ts';
import type { BgcodeResult, KV } from './types.ts';

const META_TYPES = new Set([0, 2, 3, 4]); // file, slicer, printer, print
const COMP_NAMES: Record<number, string> = { 2: 'heatshrink 11-4', 3: 'heatshrink 12-4' };

function parseIniKv(text: string): KV {
  const kv: KV = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return kv;
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param buf inizio del file (bastano pochi MB: i metadati precedono il G-code)
 */
export async function parseBgcode(buf: ArrayBuffer): Promise<BgcodeResult> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (buf.byteLength < 10 || String.fromCharCode(...bytes.slice(0, 4)) !== 'GCDE') {
    throw new Error(t('bgcode.badSig'));
  }
  const checksum = view.getUint16(8, true) === 1 ? 4 : 0;
  const decoder = new TextDecoder();
  const warnings: string[] = [];
  const merged: Record<number, KV> = { 0: {}, 2: {}, 3: {}, 4: {} };
  let pos = 10;

  while (pos + 8 <= buf.byteLength) {
    const type = view.getUint16(pos, true);
    const truncMsg = t('bgcode.truncHdr');
    const comp = view.getUint16(pos + 2, true);
    const rawSize = view.getUint32(pos + 4, true);
    let hdr = 8, dataSize = rawSize;
    if (comp !== 0) {
      if (pos + 12 > buf.byteLength) { warnings.push(truncMsg); break; }
      dataSize = view.getUint32(pos + 8, true); hdr = 12;
    }
    if (type === 1) break; // primo blocco G-code: i metadati sono finiti
    const params = type === 5 ? 6 : 2;
    if (pos + hdr + params > buf.byteLength) { warnings.push(truncMsg); break; }
    const start = pos + hdr + params;
    if (start + dataSize > buf.byteLength) { warnings.push(t('bgcode.truncBlock')); break; }

    if (META_TYPES.has(type)) {
      try {
        const slice = bytes.slice(start, start + dataSize);
        if (comp === 0) merged[type] = parseIniKv(decoder.decode(slice));
        else if (comp === 1) merged[type] = parseIniKv(decoder.decode(await inflate(slice)));
        else warnings.push(t('bgcode.compress', { c: COMP_NAMES[comp] ?? comp }));
      } catch (e) {
        warnings.push(t('bgcode.unreadable', { err: e instanceof Error ? e.message : String(e) }));
      }
    }
    pos = start + dataSize + checksum;
  }
  // Priorita' ai metadati piu' specifici: print > slicer > printer.
  const kv: KV = Object.assign({}, merged[0], merged[3], merged[2], merged[4]);
  const data = extract(kv);
  if (data.grams === null && data.hours === null && !warnings.length) {
    warnings.push(t('bgcode.noData'));
  }
  const num = (v: string | undefined): number | null => { const x = parseFloat(v ?? ''); return Number.isFinite(x) ? x : null; };
  const perExtruderGrams = (kv['filament used [g]'] ?? '').split(/[,;]/).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
  const wasteGrams = num(kv['total filament used for wipe tower [g]']);
  const toolChanges = num(kv['total toolchanges']) ?? (wasteGrams !== null ? 0 : null);
  return { data, warnings, extra: { perExtruderGrams, wasteGrams, toolChanges } };
}
