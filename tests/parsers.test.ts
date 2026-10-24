import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGcodeText } from '../src/parsers/gcode-text.ts';
import { openZip } from '../src/parsers/zip.ts';
import { parseThreeMf } from '../src/parsers/threemf.ts';
import { parseSl1 } from '../src/parsers/sl1.ts';
import { parsePrintFile } from '../src/parsers/index.ts';

const BAMBU = `; BambuStudio 01.09.00.00
; HEADER_BLOCK_START
; model printing time: 1h 2m 3s; total estimated time: 1h 5m 0s
; total filament weight [g] : 10.00,2.50
; total filament change = 4
; HEADER_BLOCK_END
G1 X1
; printer_model = Bambu Lab X1 Carbon
; filament_type = PLA;PLA
; filament_settings_id = "Bambu PLA Basic @BBL X1C";"Bambu PLA Basic @BBL X1C"
; filament_density = 1.26,1.26
; nozzle_diameter = 0.4
; flush_volumes_matrix = 0,200,200,0
; flush_multiplier = 1
`;

test('Bambu: tempo totale, grammi, scarto stimato dal flush', () => {
  const r = parseGcodeText(BAMBU);
  assert.equal(r.slicer, 'bambustudio');
  assert.equal(r.hours, 3900 / 3600);
  assert.equal(r.grams, 12.5);
  assert.deepEqual(r.perExtruderGrams, [10, 2.5]);
  assert.equal(r.toolChanges, 4);
  assert.equal(r.wasteEstimated, false);
  assert.equal(r.wasteGrams, null);
  assert.equal(r.printerModel, 'Bambu Lab X1 Carbon');
  assert.equal(r.filamentSettingsId, 'Bambu PLA Basic @BBL X1C');
});

test('Cura: tempo e grammi da lunghezza, densita di default', () => {
  const r = parseGcodeText(';FLAVOR:Marlin\n;TIME:3600\n;Filament used: 2.42m\n;Layer height: 0.2\n');
  assert.equal(r.slicer, 'cura');
  assert.equal(r.hours, 1);
  assert.ok(Math.abs(r.grams! - 7.22) < 0.01);
  assert.equal(r.params?.layerHeight, 0.2);
});

async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const s = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function makeZip(files: Record<string, string>): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array<ArrayBuffer>[] = [], central: Uint8Array<ArrayBuffer>[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = new Uint8Array(enc.encode(text)), comp = await deflateRaw(raw), nm = new Uint8Array(enc.encode(name));
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 8, true);
    lh.setUint32(18, comp.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, nm.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 8, true);
    ch.setUint32(20, comp.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, nm.length, true);
    ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), nm, comp);
    central.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + comp.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const n = Object.keys(files).length;
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, n, true);
  e.setUint16(10, n, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)]).arrayBuffer();
}

test('zip deflate-raw: readEntry', async () => {
  const z = openZip(await makeZip({ 'a.txt': 'ciao ciao ciao' }));
  assert.equal(new TextDecoder().decode(await z.readEntry('a.txt')), 'ciao ciao ciao');
});

test('3mf Bambu: slice_info.config, poi con plate_1.gcode via parsePrintFile', async () => {
  const xml = '<config><plate><metadata key="prediction" value="3900"/><metadata key="weight" value="12.5"/>' +
    '<filament id="1" type="PLA" used_g="10.00"/><filament id="2" type="PLA" used_g="2.50"/></plate></config>';
  const r = await parseThreeMf(await makeZip({ 'Metadata/slice_info.config': xml }));
  assert.equal(r.grams, 12.5);
  assert.equal(r.hours, 3900 / 3600);
  assert.deepEqual(r.perExtruderGrams, [10, 2.5]);
  const r2 = await parsePrintFile('x.gcode.3mf', await makeZip({ 'Metadata/slice_info.config': xml, 'Metadata/plate_1.gcode': BAMBU }));
  assert.equal(r2.slicer, 'bambustudio');
  assert.equal(r2.toolChanges, 4);
});

test('Bambu senza peso: grammi dalla lunghezza, nessun conteggio da M620', () => {
  const txt = `; BambuStudio 01.08
; total filament length [mm] : 1000.00,500.00
; filament_density: 1.26,1.26
; filament_diameter = 1.75,1.75
; flush_volumes_matrix = 0,100,100,0
; flush_multiplier = 1
M620 S0A
M620 S1A
M620 S0A
`;
  const r = parseGcodeText(txt);
  const area = Math.PI * (1.75 / 2) ** 2;
  assert.ok(Math.abs(r.grams! - 1500 * area * 1.26 / 1000) < 1e-9);
  assert.equal(r.toolChanges, null);
  assert.ok(r.warnings.some((w) => w.key === 'warn.gramsFromLength'));
  assert.equal(r.wasteEstimated, false);
});

test('SL1: config.ini (senza sezioni) dentro lo zip -> ml, ore, modello; ramo da estensione', async () => {
  const zip = await makeZip({ 'config.ini': 'action = print' + String.fromCharCode(10) + 'usedMaterial = 25.4' + String.fromCharCode(10) + 'printTime = 10800' + String.fromCharCode(10) + 'printerModel = SL1S' + String.fromCharCode(10), 'layer0.png': 'x' });
  const r = await parseSl1(zip);
  assert.equal(r.ml, 25.4);
  assert.equal(r.hours, 3);
  assert.equal(r.printerModel, 'SL1S');
  assert.equal(r.grams, null);
  assert.equal((await parsePrintFile('pezzo.sl1s', zip)).ml, 25.4);
});
