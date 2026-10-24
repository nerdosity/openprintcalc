// File .sl1 / .sl1s di PrusaSlicer: zip con config.ini (usedMaterial in ml, printTime in secondi, printerModel).
import { openZip } from './zip.ts';
import { emptyPrint } from './types.ts';
import type { ParsedPrint } from './types.ts';

/** config.ini dell'SL1 e' un elenco `chiave = valore` senza sezioni. */
function keyValues(text: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq < 1 || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return kv;
}

const pos = (v: string | undefined): number | null => {
  const n = Number((v ?? '').replace(',', '.'));
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};

export async function parseSl1(buffer: ArrayBuffer): Promise<ParsedPrint> {
  const zip = openZip(buffer);
  const r = emptyPrint('prusaslicer');
  if (zip.has('config.ini')) {
    const kv = keyValues(new TextDecoder().decode(await zip.readEntry('config.ini')));
    r.ml = pos(kv.usedMaterial);
    const sec = pos(kv.printTime);
    r.hours = sec === null ? null : sec / 3600;
    r.printerModel = kv.printerModel?.trim() || null;
  }
  if (r.ml === null && r.hours === null) r.warnings.push({ key: 'warn.noData' });
  return r;
}
