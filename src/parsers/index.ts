// Punto d'ingresso: sceglie il parser dall'estensione del file.
import { parseBgcode } from '../bgcode.ts';
import { parseGcodeText } from './gcode-text.ts';
import type { GcodeTextOptions } from './gcode-text.ts';
import { parseThreeMf } from './threemf.ts';
import { parseSl1 } from './sl1.ts';
import { emptyPrint } from './types.ts';
import type { ParsedPrint } from './types.ts';

export type { ParsedPrint, ParseWarning, SlicerId } from './types.ts';
export { parseGcodeText, detectSlicer } from './gcode-text.ts';
export { parseThreeMf } from './threemf.ts';
export { parseSl1 } from './sl1.ts';
export { openZip } from './zip.ts';

const isMagic = (buffer: ArrayBuffer, sig: string): boolean => {
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return sig.split('').every((c, i) => b[i] === c.charCodeAt(0));
};

/** Sceglie il parser dal contenuto (firma GCDE o PK) e, in difetto, dall'estensione. */
export async function parsePrintFile(name: string, buffer: ArrayBuffer, opts: GcodeTextOptions = {}): Promise<ParsedPrint> {
  const n = name.toLowerCase();
  if (/\.sl1s?$/.test(n)) return parseSl1(buffer);
  if (isMagic(buffer, 'PK') || (n.endsWith('.3mf') && !isMagic(buffer, 'GCDE'))) return parseThreeMf(buffer);
  if (isMagic(buffer, 'GCDE') || n.endsWith('.bgcode')) {
    const { data, warnings, extra } = await parseBgcode(buffer);
    const r = emptyPrint('prusaslicer');
    r.grams = data.grams; r.hours = data.hours; r.printerModel = data.printerModel;
    r.printerSettingsId = data.printerSettingsId; r.filamentSettingsId = data.filamentName;
    r.filamentType = data.filamentType; r.filamentCost = data.filamentCost; r.filamentDensity = data.density;
    r.nozzleDiameter = data.nozzleDiameter; r.nozzleTemp = data.nozzleTemp; r.bedTemp = data.bedTemp;
    r.params = data.params;
    r.perExtruderGrams = extra.perExtruderGrams; r.wasteGrams = extra.wasteGrams; r.toolChanges = extra.toolChanges;
    r.warnings = warnings.map((msg) => ({ key: 'warn.text', params: { msg } }));
    return r;
  }
  return parseGcodeText(new TextDecoder().decode(buffer), opts);
}
