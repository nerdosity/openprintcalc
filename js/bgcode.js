// Lettore minimale di .bgcode (libbgcode): legge solo i blocchi di metadati.
import { extract } from './gcode.js';

const META_TYPES = new Set([0, 2, 3, 4]); // file, slicer, printer, print
const COMP_NAMES = { 2: 'heatshrink 11-4', 3: 'heatshrink 12-4' };

function parseIniKv(text) {
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return kv;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer} buf  inizio del file (bastano pochi MB: i metadati precedono il G-code)
 * @returns {Promise<{data: object, warnings: string[]}>}
 */
export async function parseBgcode(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (buf.byteLength < 10 || String.fromCharCode(...bytes.slice(0, 4)) !== 'GCDE') {
    throw new Error('File .bgcode non valido: manca la firma GCDE.');
  }
  const checksum = view.getUint16(8, true) === 1 ? 4 : 0;
  const decoder = new TextDecoder();
  const warnings = [];
  const merged = { 0: {}, 2: {}, 3: {}, 4: {} };
  let pos = 10;

  while (pos + 8 <= buf.byteLength) {
    const type = view.getUint16(pos, true);
    const truncMsg = 'File troncato: intestazione di un blocco oltre i dati letti, metadati possibilmente incompleti.';
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
    if (start + dataSize > buf.byteLength) { warnings.push('File troncato: un blocco di metadati supera i dati letti, metadati possibilmente incompleti.'); break; }

    if (META_TYPES.has(type)) {
      try {
        const slice = bytes.subarray(start, start + dataSize);
        if (comp === 0) merged[type] = parseIniKv(decoder.decode(slice));
        else if (comp === 1) merged[type] = parseIniKv(decoder.decode(await inflate(slice)));
        else warnings.push(`Compressione ${COMP_NAMES[comp] ?? comp} non supportata: blocco di metadati saltato.`);
      } catch (e) {
        warnings.push(`Blocco di metadati illeggibile (${e.message}).`);
      }
    }
    pos = start + dataSize + checksum;
  }
  // Priorita' ai metadati piu' specifici: print > slicer > printer.
  const kv = Object.assign({}, merged[0], merged[3], merged[2], merged[4]);
  const data = extract(kv);
  if (data.grams === null && data.hours === null && !warnings.length) {
    warnings.push('Nessun dato di stampa trovato nei metadati.');
  }
  return { data, warnings };
}
