#!/usr/bin/env node
// Scarica il bundle profili PrusaSlicer (PrusaResearch) alla versione piu' recente
// indicata da index.idx e genera data/filaments.json. Nessuna dipendenza esterna.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIni, resolveInherits } from '../src/ini.ts';
import type { Filament, FilamentsFile, KV } from '../src/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, 'data', 'filaments.json');
const BASE_URL = 'https://raw.githubusercontent.com/prusa3d/PrusaSlicer-settings-prusa-fff/main/PrusaResearch/';
const INDEX_URL = BASE_URL + 'index.idx';
const FILAMENT_PREFIX = 'filament:';
// Vendor con prezzi non in euro: nel bundle filament_cost e' in valuta locale
// (CZK per Print With Smile, PLN per ROSA3D), quindi cost_eur_kg risulterebbe errato.
const EXCLUDED_VENDORS = ['Print With Smile', 'ROSA3D'];
// Costo oltre questa soglia (EUR/kg) considerato fuori scala: il filamento viene scartato.
const MAX_COST_EUR_KG = 300;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
  return res.text();
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Versione piu' alta elencata in index.idx (righe tipo "2.5.13 Descrizione...").
function latestVersion(indexText: string): string {
  let best: number[] | null = null;
  for (const line of indexText.split(/\r?\n/)) {
    const m = /^(\d+(?:\.\d+)+)\s/.exec(line);
    if (!m) continue;
    const parts = (m[1] ?? '').split('.').map(Number);
    if (best === null || compareVersions(parts, best) > 0) best = parts;
  }
  if (best === null) throw new Error('Nessuna versione trovata in index.idx');
  return best.join('.');
}

// Numero dal valore INI (primo elemento se la lista e' separata da virgole).
function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number((String(value).split(',')[0] ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Rimuove i gruppi negati `!( ... )` da una condizione, cosi' non si leggono modelli esclusi.
function stripNegatedGroups(cond: string): string {
  let out = '';
  for (let i = 0; i < cond.length; i++) {
    if (cond[i] === '!' && cond[i + 1] !== '=' && cond[i + 1] !== '~') {
      let j = i + 1;
      while (cond[j] === ' ') j++;
      if (cond[j] === '(') {
        let depth = 0;
        for (; j < cond.length; j++) {
          if (cond[j] === '(') depth++;
          else if (cond[j] === ')' && --depth === 0) break;
        }
        i = j;
        continue;
      }
    }
    out += cond[i];
  }
  return out;
}

// Euristica: codici modello positivi da compatible_printers_condition.
function printersFromCondition(cond: string | undefined): string[] {
  if (!cond) return [];
  const positive = stripNegatedGroups(cond);
  const models = new Set<string>();
  for (const m of positive.matchAll(/printer_model\s*==\s*"([^"]+)"/g)) models.add(m[1] ?? '');
  for (const m of positive.matchAll(/printer_notes\s*=~\s*\/[^/]*?PRINTER_MODEL_([A-Za-z0-9]+)(?![A-Za-z0-9[(])/g)) {
    models.add(m[1] ?? '');
  }
  return [...models];
}

async function main() {
  const version = latestVersion(await fetchText(INDEX_URL));
  const source = BASE_URL + version + '.ini';
  console.log(`Versione piu' recente: ${version}`);
  console.log(`Scarico ${source}`);

  const sections = resolveInherits(parseIni(await fetchText(source)));

  // Raggruppa le varianti "Nome @MODELLO" sotto il nome base "Nome".
  // Tiene una sola voce per nome base: la sezione senza '@' se esiste, altrimenti la prima.
  // I modelli compatibili sono l'unione di tutte le varianti.
  interface Group { label: string; values: KV; isVariant: boolean; printers: Set<string> }
  const groups = new Map<string, Group>();
  let skippedNoCost = 0;
  let skippedVendor = 0;
  let skippedOutOfScale = 0;

  for (const [name, values] of Object.entries(sections)) {
    if (!name.startsWith(FILAMENT_PREFIX)) continue;
    const label = name.slice(FILAMENT_PREFIX.length).trim();
    if (label.startsWith('*')) continue; // sezione template

    const cost = toNumber(values.filament_cost);
    if (cost === null || cost <= 0) {
      skippedNoCost++;
      continue;
    }
    const vendor = (values.filament_vendor || '').trim();
    if (EXCLUDED_VENDORS.some((v) => vendor.toLowerCase().startsWith(v.toLowerCase()))) {
      skippedVendor++;
      continue;
    }
    if (cost > MAX_COST_EUR_KG) {
      skippedOutOfScale++;
      continue;
    }

    const baseName = (label.split(' @')[0] ?? '').trim();
    const isVariant = baseName !== label;
    const printers = printersFromCondition(values.compatible_printers_condition);

    let group = groups.get(baseName);
    if (!group) {
      group = { label, values, isVariant, printers: new Set() };
      groups.set(baseName, group);
    } else if (group.isVariant && !isVariant) {
      group.label = label;
      group.values = values;
      group.isVariant = false;
    }
    for (const p of printers) group.printers.add(p);
  }

  const filaments: Filament[] = [];
  const usedIds = new Set<string>();
  for (const [baseName, group] of groups) {
    const values = group.values;
    const base = slugify(baseName) || 'filament';
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);

    filaments.push({
      id,
      name: baseName,
      vendor: values.filament_vendor || '',
      material: values.filament_type || '',
      cost_eur_kg: toNumber(values.filament_cost),
      density_g_cm3: toNumber(values.filament_density),
      spool_tare_g: toNumber(values.filament_spool_weight),
      diameter_mm: toNumber(values.filament_diameter),
      nozzle_temp_c: toNumber(values.temperature),
      bed_temp_c: toNumber(values.bed_temperature),
      printers: [...group.printers],
    });
  }

  const output: FilamentsFile = { source, generated: new Date().toISOString(), filaments };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`Filamenti scritti: ${filaments.length} (scartati senza costo: ${skippedNoCost}, vendor esclusi: ${skippedVendor}, costo > ${MAX_COST_EUR_KG} EUR/kg: ${skippedOutOfScale})`);
  console.log(`Output: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
