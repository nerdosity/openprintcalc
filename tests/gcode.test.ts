import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGcode, parseTime, baseFilamentName } from '../src/gcode.ts';

// Estratto dalla coda di un G-code PrusaSlicer (docs/notes/gcode-format.md, sample test_vase.gcode).
const FIXTURE = `G1 X10 Y10 E0.5
; filament used [mm] = 676.57, 0.00, 0.00, 0.00, 0.00
; filament used [cm3] = 1.63, 0.00, 0.00, 0.00, 0.00
; filament used [g] = 1.76, 0.00, 0.00, 0.00, 0.00
; filament cost = 0.05, 0.00, 0.00, 0.00, 0.00
; total filament used [g] = 1.76
; total filament cost = 0.05
; estimated printing time (normal mode) = 2h 13m 5s
; prusaslicer_config = begin
; filament_settings_id = "Generic ABS @MMU";"Generic ABS @MMU";"Generic ABS @MMU"
; filament_type = ABS;ABS;ABS
; filament_density = 1.08,1.08,1.08
; printer_model = MK3MMU2
; printer_settings_id = Original Prusa i3 MK3 MMU2
; prusaslicer_config = end
`;

test('parseGcode: grammi, ore, stampante e filamento dal config', () => {
  const d = parseGcode(FIXTURE);
  assert.equal(d.grams, 1.76);
  assert.ok(Math.abs(d.hours! - (2 * 3600 + 13 * 60 + 5) / 3600) < 1e-9);
  assert.equal(d.printerModel, 'MK3MMU2');
  assert.equal(d.filamentName, 'Generic ABS');
  assert.equal(d.filamentType, 'ABS');
  assert.equal(d.density, 1.08);
});

test('parseTime: formati con giorni, ore, minuti e solo secondi', () => {
  assert.equal(parseTime('1d 2h 3m 4s'), 93784);
  assert.equal(parseTime('17m 27s'), 1047);
  assert.equal(parseTime('45s'), 45);
  assert.equal(parseTime('boh'), null);
});

test('grammi: somma per estrusore se manca il totale; nome base filamento', () => {
  assert.equal(parseGcode('; filament used [g] = 1.50, 2.25, 0.00').grams, 3.75);
  assert.equal(baseFilamentName('"Prusament PLA @PG";"x"'), 'Prusament PLA');
});

test('parametri di stampa: pareti, strati, riempimento, larghezze (mm, auto, %)', () => {
  const d = parseGcode(`; perimeters = 3
; top_solid_layers = 5
; bottom_solid_layers = 4
; fill_density = 15%
; layer_height = 0.2
; nozzle_diameter = 0.4,0.4
; temperature = 215,215
; bed_temperature = 60,60
; external_perimeter_extrusion_width = 0.45
; perimeter_extrusion_width = 0
; infill_extrusion_width =
; solid_infill_extrusion_width = 120%
`);
  assert.equal(d.nozzleTemp, 215);
  assert.equal(d.bedTemp, 60);
  assert.equal(d.nozzleDiameter, 0.4);
  const p = d.params!;
  assert.equal(p.perimeters, 3);
  assert.equal(p.topSolidLayers, 5);
  assert.equal(p.bottomSolidLayers, 4);
  assert.equal(p.fillDensity, '15%');
  assert.equal(p.layerHeight, 0.2);
  assert.deepEqual(p.widths['Perimetro esterno'], { kind: 'mm', mm: 0.45 });
  assert.deepEqual(p.widths['Perimetri'], { kind: 'auto' });
  assert.deepEqual(p.widths['Riempimento'], { kind: 'auto' });
  assert.equal(p.widths['Riempimento solido']!.kind, 'pct');
  assert.ok(Math.abs((p.widths['Riempimento solido'] as { mm: number }).mm - 0.48) < 1e-9);
  assert.equal(p.widths['Primo strato'], undefined);
  assert.equal(parseGcode('G1 X1').params, null);
});
