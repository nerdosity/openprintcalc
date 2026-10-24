#!/usr/bin/env node
// Genera data/printers-prusaslicer.json dai bundle profili PrusaSlicer:
// - PrusaResearch (repo prusa3d/PrusaSlicer-settings-prusa-fff), versione indicata da index.idx;
// - vendor non-Prusa (repo prusa3d/PrusaSlicer-settings-non-prusa-fff), una cartella per vendor,
//   versione piu' recente indicata dal rispettivo index.idx.
// Solo stampanti FFF: i vendor senza modelli FFF (SLA) vengono saltati. Nessuna dipendenza esterna.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIni, resolveInherits } from '../src/ini.ts';
import type { IniSections, KV, PsPrinter, PsPrintersFile } from '../src/types.ts';

// voce completa: tutti i campi valorizzati (eventualmente null)
type FullPs = Required<PsPrinter>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, 'data', 'printers-prusaslicer.json');

const RAW_BASE = 'https://raw.githubusercontent.com/prusa3d/';
const PRUSA_BASE = RAW_BASE + 'PrusaSlicer-settings-prusa-fff/main/PrusaResearch/';
const NON_PRUSA_REPO = 'prusa3d/PrusaSlicer-settings-non-prusa-fff';
const NON_PRUSA_BASE = RAW_BASE + 'PrusaSlicer-settings-non-prusa-fff/main/';
const CONTENTS_API = `https://api.github.com/repos/${NON_PRUSA_REPO}/contents/`;
// Cartelle del repo che non sono vendor.
const SKIP_DIRS = ['Templates'];

const MODEL_PREFIX = 'printer_model:';
const PRINTER_PREFIX = 'printer:';
const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

interface ModelInfo { id: string; name: string; family: string | null; variants: string }

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers });
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

const round2 = (v: number): number => Math.round(v * 100) / 100;

// Primo numero di un valore INI (es. "0.4,0.4" -> 0.4). null se assente o non numerico.
function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number((String(value).split(',')[0] ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

// Valori distinti numerici di una lista INI separata da virgole (es. "0.4,0.4,0.6" -> [0.4, 0.6]).
function toNumberList(value: string | undefined): number[] {
  const out = new Set<number>();
  for (const part of String(value ?? '').split(',')) {
    const n = Number(part.trim());
    if (Number.isFinite(n) && n > 0) out.add(round2(n));
  }
  return [...out].sort((a, b) => a - b);
}

// bed_shape "0x0,250x0,250x210,0x210" -> bounding box [250, 210].
function parseBedMm(shape: string | undefined): [number, number] | null {
  if (!shape) return null;
  const points = String(shape)
    .split(',')
    .map((p): [number, number] => {
      const [x, y] = p.trim().split('x').map(Number);
      return [x ?? NaN, y ?? NaN];
    });
  if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  if (!(w > 0 && h > 0)) return null;
  return [round2(w), round2(h)];
}

function slugify(text: unknown): string {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Nomi dei template (`*X*`) ereditati da una sezione, risalendo la catena `inherits` nel file grezzo.
function templateNames(raw: IniSections, sectionName: string, seen = new Set<string>()): string[] {
  if (seen.has(sectionName) || !hasOwn(raw, sectionName)) return [];
  seen.add(sectionName);
  const out: string[] = [];
  const parents = String(raw[sectionName]?.inherits ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const parent of parents) {
    const tpl = /^\*(.+)\*$/.exec(parent);
    if (tpl) {
      out.push(tpl[1] ?? '');
      continue;
    }
    const target = [PRINTER_PREFIX + parent, parent].find((c) => hasOwn(raw, c));
    if (target) out.push(...templateNames(raw, target, seen));
  }
  return out;
}

// Modelli (ID) a cui appartiene una sezione [printer:...].
// 1) chiave printer_model; 2) template ereditati con lo stesso nome del modello (es. *ENDER3*);
// 3) token PRINTER_MODEL_<ID> in printer_notes. Se restano piu' modelli, vince il nome modello
//    piu' lungo che e' prefisso del nome sezione (es. "Original Prusa MK4S MMU3" vs "...MK4S").
function modelsForPrinter(sectionName: string, values: KV, raw: IniSections, models: Map<string, ModelInfo>): string[] {
  if (values.printer_model && models.has(values.printer_model)) return [values.printer_model];

  const fromTemplates = templateNames(raw, sectionName).filter((t) => models.has(t));
  const fromNotes = [...String(values.printer_notes ?? '').matchAll(/PRINTER_MODEL_([A-Za-z0-9]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((id) => models.has(id));
  const candidates = [...new Set(fromTemplates.length ? fromTemplates : fromNotes)];
  if (candidates.length <= 1) return candidates;

  const label = sectionName
    .slice(PRINTER_PREFIX.length)
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s+[\d.]+\s*nozzle\s*$/i, '')
    .trim();
  let best: string | null = null;
  let bestLen = -1;
  for (const id of candidates) {
    const name = models.get(id)?.name ?? '';
    if (label.startsWith(name) && name.length > bestLen) { best = id; bestLen = name.length; }
  }
  return best === null ? candidates : [best];
}

// Estrae i modelli FFF e i dati delle stampanti da un bundle .ini.
function parseBundle(text: string, fallbackVendor: string): { vendor: string; printers: FullPs[]; slaModels: number } {
  const raw = parseIni(text);
  const resolved = resolveInherits(raw);
  const vendor = String(raw.vendor?.name ?? fallbackVendor).trim();

  const models = new Map<string, ModelInfo>();
  let slaModels = 0;
  for (const name of Object.keys(raw)) {
    if (!name.startsWith(MODEL_PREFIX)) continue;
    const id = name.slice(MODEL_PREFIX.length).trim();
    const v = resolved[name] ?? {};
    if (v.technology !== 'FFF') {
      slaModels++;
      continue;
    }
    models.set(id, {
      id,
      name: v.name || id,
      family: v.family || null,
      variants: String(v.variants ?? ''),
    });
  }

  const agg = new Map<string, { bed: [number, number] | null; maxZ: number | null; nozzles: Set<number> }>();
  for (const name of Object.keys(raw)) {
    if (!name.startsWith(PRINTER_PREFIX)) continue;
    if (name.slice(PRINTER_PREFIX.length).trim().startsWith('*')) continue; // template
    const values = resolved[name] ?? {};
    for (const id of modelsForPrinter(name, values, raw, models)) {
      const a = agg.get(id) ?? { bed: null, maxZ: null, nozzles: new Set<number>() };
      a.bed ??= parseBedMm(values.bed_shape);
      a.maxZ ??= toNumber(values.max_print_height);
      for (const n of toNumberList(values.nozzle_diameter)) a.nozzles.add(n);
      agg.set(id, a);
    }
  }

  const printers: FullPs[] = [];
  for (const m of models.values()) {
    const a = agg.get(m.id);
    let nozzles = a ? [...a.nozzles].sort((x, y) => x - y) : [];
    // Fallback: opzioni numeriche di `variants` se il bundle non indica nozzle_diameter.
    if (nozzles.length === 0) {
      nozzles = toNumberList(m.variants.split(';').filter((v) => /^\s*\d/.test(v)).join(','));
    }
    printers.push({
      id: '', // assegnato in main() quando tutti i vendor sono noti
      vendor,
      model: m.id,
      name: m.name,
      family: m.family,
      bed_mm: a?.bed ?? null,
      max_z_mm: a?.maxZ ?? null,
      nozzles_mm: nozzles,
      prusaslicer_models: [m.id],
    });
  }
  return { vendor, printers, slaModels };
}

async function loadNonPrusaVendor(folder: string): Promise<{ folder: string; url: string; text: string }> {
  const base = NON_PRUSA_BASE + encodeURIComponent(folder) + '/';
  const version = latestVersion(await fetchText(base + 'index.idx'));
  const url = base + version + '.ini';
  return { folder, url, text: await fetchText(url) };
}

async function main() {
  const sources = [];
  const warnings: string[] = [];
  const bundles = [];

  // PrusaResearch: ultima versione indicata da index.idx.
  const prusaVersion = latestVersion(await fetchText(PRUSA_BASE + 'index.idx'));
  const prusaUrl = PRUSA_BASE + prusaVersion + '.ini';
  console.log(`PrusaResearch: versione ${prusaVersion}`);
  sources.push(prusaUrl);
  bundles.push(parseBundle(await fetchText(prusaUrl), 'PrusaResearch'));

  // Vendor non-Prusa: una cartella per vendor, elencate via API GitHub.
  const headers: Record<string, string> = { 'User-Agent': 'openprintcalc-build', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const listing: unknown = JSON.parse(await fetchText(CONTENTS_API, headers));
  const folders = (Array.isArray(listing) ? listing : [])
    .filter((e): e is { type: 'dir'; name: string } =>
      isRecord(e) && e.type === 'dir' && typeof e.name === 'string' && !SKIP_DIRS.includes(e.name))
    .map((e) => e.name);

  const settled = await Promise.allSettled(folders.map(loadNonPrusaVendor));
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      warnings.push(`${folders[i]}: ${errMsg(r.reason)}`);
      return;
    }
    sources.push(r.value.url);
    bundles.push(parseBundle(r.value.text, r.value.folder));
  });

  const skippedVendors: string[] = [];
  const printers: FullPs[] = [];
  for (const b of bundles) {
    if (b.printers.length === 0) {
      skippedVendors.push(b.vendor);
      continue;
    }
    printers.push(...b.printers);
  }

  // Id univoco: ps-<vendor>-<model>.
  const usedIds = new Set<string>();
  for (const p of printers) {
    const base = `ps-${slugify(p.vendor) || 'vendor'}-${slugify(p.model) || 'model'}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    p.id = id;
  }

  const ordered = printers
    .sort((a, b) => a.vendor.localeCompare(b.vendor, 'en') || a.name.localeCompare(b.name, 'en'))
    .map(({ id, vendor, model, name, family, bed_mm, max_z_mm, nozzles_mm, prusaslicer_models }) => ({
      id,
      vendor,
      model,
      name,
      family,
      bed_mm,
      max_z_mm,
      nozzles_mm,
      prusaslicer_models,
    }));

  const output: PsPrintersFile = {
    generated: new Date().toISOString(),
    sources,
    printers: ordered,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  const vendorCount = new Set(ordered.map((p) => p.vendor)).size;
  const noBed = ordered.filter((p) => p.bed_mm === null).length;
  console.log(`Vendor con stampanti FFF: ${vendorCount} (saltati, solo SLA o senza modelli FFF: ${skippedVendors.length})`);
  console.log(`Stampanti scritte: ${ordered.length} (senza bed_mm: ${noBed})`);
  for (const w of warnings) console.warn(`Attenzione, bundle saltato: ${w}`);
  console.log(`Output: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
