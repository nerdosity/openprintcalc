#!/usr/bin/env node
// Scarica i bundle profili SLA (PrusaResearchSLA e AnycubicSLA) alla versione piu' recente
// indicata da index.idx e genera data/resins.json dalle sezioni [sla_material:...].
// Legge data/resin-prices.json (prezzi curati a mano) solo per riportarne la copertura.
// Nessuna dipendenza esterna.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIni, resolveInherits } from '../src/ini.ts';
import type { IniSections, KV, Resin, ResinPrice, ResinsFile } from '../src/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, 'data', 'resins.json');
const PRICES_FILE = resolve(ROOT, 'data', 'resin-prices.json');
const RAW_BASE = 'https://raw.githubusercontent.com/prusa3d/';
const BUNDLES = [
  { name: 'PrusaResearchSLA', base: RAW_BASE + 'PrusaSlicer-settings-prusa-sla/main/PrusaResearchSLA/' },
  { name: 'AnycubicSLA', base: RAW_BASE + 'PrusaSlicer-settings-non-prusa-sla/main/AnycubicSLA/' },
];
const MATERIAL_PREFIX = 'sla_material:';
const PRINTER_MODEL_PREFIX = 'printer_model:';
const PRINTER_PREFIX = 'printer:';

interface PrinterCtx { model: string; notes: string }
interface Group { label: string; values: KV; printers: Set<string> }

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

// Versione piu' alta elencata in index.idx (righe tipo "1.0.10 Descrizione...").
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

// Stampanti del bundle: [printer_model:X] (senza note) e [printer:Y] (con printer_model e printer_notes).
// Nelle note PrusaSlicer "\n" e' un a capo letterale nel file: lo decodifico per le regex.
function printerContexts(sections: IniSections): PrinterCtx[] {
  const out: PrinterCtx[] = [];
  for (const [name, values] of Object.entries(sections)) {
    if (name.startsWith(PRINTER_MODEL_PREFIX)) {
      out.push({ model: name.slice(PRINTER_MODEL_PREFIX.length).trim(), notes: '' });
    } else if (name.startsWith(PRINTER_PREFIX)) {
      out.push({
        model: (values.printer_model || '').trim(),
        notes: (values.printer_notes || '').replace(/\\n/g, '\n'),
      });
    }
  }
  return out;
}

// Condizione PrusaSlicer semplice: atomi `printer_model=="X"` e `printer_notes=~/re/`,
// legati da `and` / `or` (nessuna parentesi nei bundle SLA). Atomo non riconosciuto = falso.
function matchAtom(atom: string, ctx: PrinterCtx): boolean {
  const pm = /^printer_model\s*==\s*"([^"]*)"$/.exec(atom);
  if (pm) return ctx.model === pm[1];
  const pn = /^printer_notes\s*=~\s*\/(.*)\/$/.exec(atom);
  if (pn) return new RegExp(pn[1] ?? '').test(ctx.notes);
  return false;
}

function matchesCondition(cond: string, ctx: PrinterCtx): boolean {
  return cond
    .split(/\s+or\s+/)
    .some((orPart) => orPart.split(/\s+and\s+/).every((atom) => matchAtom(atom.trim(), ctx)));
}

// Modelli compatibili con un materiale. Senza condizione il profilo vale per tutte le stampanti del bundle.
function printersFor(cond: string | undefined, contexts: PrinterCtx[]): string[] {
  const models = new Set<string>();
  for (const ctx of contexts) {
    if (!cond || matchesCondition(cond, ctx)) models.add(ctx.model);
  }
  return [...models].filter(Boolean);
}

// Priorita' della voce da tenere per nome base: senza '@', poi layer 0.05, poi la prima incontrata.
function variantRank(label: string): number {
  if (!label.includes(' @')) return 0;
  if (label.endsWith('0.05')) return 1;
  return 2;
}

async function reportPriceCoverage(resins: Resin[]): Promise<void> {
  let prices: ResinPrice[];
  try {
    prices = JSON.parse(await readFile(PRICES_FILE, 'utf8')) as ResinPrice[];
  } catch {
    console.log(`Prezzi: ${PRICES_FILE} non leggibile, copertura non calcolata`);
    return;
  }
  const label = (r: Resin) => `${r.vendor} ${r.name}`;
  const matches = (p: ResinPrice, r: Resin) => new RegExp(p.match, 'i').test(label(r));
  const covered = resins.filter((r) => prices.some((p) => matches(p, r))).length;
  const unused = prices.filter((p) => !resins.some((r) => matches(p, r))).map((p) => p.match);
  console.log(`Prezzi: ${covered}/${resins.length} resine con prezzo; regex senza corrispondenze: ${unused.length ? unused.join(' | ') : 'nessuna'}`);
}

async function main() {
  const sources: string[] = [];
  const groups = new Map<string, Group>();
  let skippedTemplate = 0;

  for (const bundle of BUNDLES) {
    const version = latestVersion(await fetchText(bundle.base + 'index.idx'));
    const source = bundle.base + version + '.ini';
    console.log(`${bundle.name}: versione piu' recente ${version}`);
    console.log(`Scarico ${source}`);
    sources.push(source);

    const sections = resolveInherits(parseIni(await fetchText(source)));
    const contexts = printerContexts(sections);

    for (const [name, values] of Object.entries(sections)) {
      if (!name.startsWith(MATERIAL_PREFIX)) continue;
      const label = name.slice(MATERIAL_PREFIX.length).trim();
      if (label.startsWith('*')) {
        skippedTemplate++;
        continue;
      }

      // Le varianti "Nome @MODELLO 0.05" vengono raggruppate sotto il nome base "Nome".
      const baseName = (label.split(' @')[0] ?? '').trim();
      const printers = printersFor(values.compatible_printers_condition, contexts);

      let group = groups.get(baseName);
      if (!group) {
        group = { label, values, printers: new Set() };
        groups.set(baseName, group);
      } else if (variantRank(label) < variantRank(group.label)) {
        group.label = label;
        group.values = values;
      }
      for (const p of printers) group.printers.add(p);
    }
  }

  const resins: Resin[] = [];
  const usedIds = new Set<string>();
  for (const [baseName, group] of groups) {
    const values = group.values;
    const base = slugify(baseName) || 'resin';
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);

    resins.push({
      id,
      name: baseName,
      vendor: values.material_vendor || '',
      type: values.material_type || '',
      density_g_cm3: toNumber(values.material_density),
      printers: [...group.printers],
    });
  }

  const output: ResinsFile = { generated: new Date().toISOString(), sources, resins };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');
  const noPrinter = resins.filter((r) => r.printers.length === 0).length;
  console.log(`Resine scritte: ${resins.length} (template scartati: ${skippedTemplate}, senza stampante compatibile: ${noPrinter})`);
  await reportPriceCoverage(resins);
  console.log(`Output: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
