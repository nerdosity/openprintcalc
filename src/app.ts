import { compute, computeSla, quoteText, wasteSplit, eur, unwrap, isEstimated, wearPerHour, wearSla, pickWatt, pricePerKg, estimateWatts, amortizationInputs, applySale, bandsText } from './calc.ts';
import { bandPrices, splitHoursByBand } from './energy.ts';
import { paramLines } from './gcode.ts';
import { parsePrintFile } from './parsers/index.ts';
import type { ParsedPrint } from './parsers/index.ts';
import { importProfiles, mergeProfiles } from './profiles.ts';
import { mergeCatalogs, bestModelMatch, resinPrice, resinPriceInfo } from './catalog.ts';
import { loadState, parseState, saveState, loadProfiles, saveProfiles } from './state.ts';
import { buildClientQuote, decodeShare, encodeShare, parseClientQuote } from './share.ts';
import type { ClientQuote } from './share.ts';
import { applyI18n, fmtCur, fmtNum, getLang, resolveLang, setLang, setSymbol, t } from './i18n.ts';
import type { Key } from './i18n.ts';
import type { Catalog, ComputeExtras, CustomBand, FieldValue, FutureTab, ComputeResult, Platform, CostLine, Filament, Printer, Profiles, PsPrinter, QuoteContext, Resin, ResinPrice, SlaInput, Tech, WattEstimate } from './types.ts';

/** Elemento opzionale (null se manca). */
const q = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T | null => r.querySelector<T>(s);
/** Elemento obbligatorio: la pagina e' statica, se manca e' un errore di markup. */
function $<T extends Element = HTMLElement>(s: string, r: ParentNode = document): T {
  const found = q<T>(s, r);
  if (found === null) throw new Error(`Elemento non trovato: ${s}`);
  return found;
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

const state = loadState();
let profiles = loadProfiles();
let catalog: Catalog = { printers: [], filaments: [] };
let slaPrinters: Printer[] = [];
let resins: Resin[] = [];
let resinPrices: ResinPrice[] = [];

const isSla = (): boolean => state.tech === 'sla';
const DEFAULT_EUR_L = 30, DEFAULT_RHO = 1.1;

const PRINTER_AUTO = ['watt', 'machineCost', 'lifeH', 'wear'];
const OTHER = '__other';
const MATERIAL_ORDER = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'PA'];
const fmt = (v: unknown, d = 2): string => fmtNum(v, d, d);
const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;

const allPrinters = (): Printer[] => [...catalog.printers, ...profiles.printers];
const allFilaments = (): Filament[] => [...catalog.filaments, ...profiles.filaments];
const printerById = (id: string): Printer | null => allPrinters().find((p) => p.id === id) ?? null;
const filamentById = (id: string): Filament | null => allFilaments().find((f) => f.id === id) ?? null;
const slaPrinterById = (id: string): Printer | null => slaPrinters.find((p) => p.id === id) ?? null;
const resinById = (id: string): Resin | null => resins.find((r) => r.id === id) ?? null;
/** Stampante attiva nella tecnologia corrente. */
const activePrinter = (): Printer | null => (isSla() ? slaPrinterById(state.slaPrinterId) : printerById(state.printerId));
const printerLabel = (p: Printer): string => (p.source === 'prusaslicer' ? p.name ?? p.id : `${p.brand ?? ''} ${p.model ?? p.id}`.trim());

/* ---------- dati ---------- */

async function loadJson<T extends { id: string }>(url: string, key: string): Promise<T[]> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const j: unknown = await res.json();
    const list = Array.isArray(j) ? j : isRecord(j) ? j[key] : null;
    // forma dei file in data/ garantita dagli script di build: ci si fida dopo la guardia su `id`
    return Array.isArray(list) ? list.filter((x): x is T => isRecord(x) && Boolean(x.id)) : [];
  } catch {
    message('#file-msg', t('err.load', { url }), true);
    return [];
  }
}

async function loadPrices(): Promise<ResinPrice[]> {
  try {
    const res = await fetch('data/resin-prices.json');
    const j: unknown = res.ok ? await res.json() : [];
    return Array.isArray(j) ? j.filter((x): x is ResinPrice => isRecord(x) && typeof x.match === 'string' && typeof x.price_eur_l === 'number') : [];
  } catch { return []; }
}

/* ---------- precompilazione ---------- */

const isManual = (f: string): boolean => {
  const v = state.values[f];
  if (v === undefined || v === '') return false;
  return !(f in state.auto) || v !== state.auto[f];
};

/** Imposta il valore automatico di un campo. Senza `force` non sovrascrive un valore modificato a mano. */
function setAuto(f: string, v: number | null | undefined, est = false, force = false): void {
  const manual = isManual(f);
  if (v === null || v === undefined || !Number.isFinite(Number(v))) {
    delete state.auto[f];
    delete state.autoEst[f];
    if (state.autoSrc) delete state.autoSrc[f];
    if (force || !manual) delete state.values[f];
    return;
  }
  const val = round(Number(v));
  state.auto[f] = val;
  state.autoEst[f] = Boolean(est);
  if (force || !manual) state.values[f] = val;
}

const normText = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[-_\s]+/g, ' ').trim();

const estFlag = (p: Printer, key: string, raw: unknown): boolean => isEstimated(raw) ||
  (Array.isArray(p.estimated) && p.estimated.some((e) => e === key || e.startsWith(key + '.') || e.startsWith(key + '[')));

/**
 * Valore automatico dei campi del modello. `src` ('catalog'|'gcode') ricorda l'origine: in ricarica
 * (force=false) quelli di origine catalogo (o default) si ricalcolano, quelli da G-code restano.
 * Con v nullo (solo catalogo, solo con force): mNozzle torna a 0.4, le temperature non si toccano, gli altri si cancellano.
 */
function setModel(f: string, v: number | null | undefined, force: boolean, est = false, src: 'catalog' | 'gcode' | 'default' = 'catalog'): void {
  if (v === null || v === undefined) {
    if (!force || src !== 'catalog' || f === 'mNozzleTemp' || f === 'mBedTemp') return;
    if (f === 'mNozzle') { setAuto(f, 0.4, false, true); state.autoSrc[f] = 'default'; return; }
    setAuto(f, null, false, true);
    return;
  }
  if (!force && f in state.auto && state.autoSrc[f] !== 'catalog' && state.autoSrc[f] !== 'default') return;
  setAuto(f, v, est, force);
  if (f in state.auto) state.autoSrc[f] = src;
}

function modelFromPrinter(p: Printer | null, force: boolean): void {
  if (!p) return;
  const bed = Array.isArray(p.bed_mm) ? p.bed_mm : [];
  const e = (k: string, raw: unknown): boolean => estFlag(p, k, raw);
  setModel('mBedX', unwrap(bed[0]), force, e('bed_mm', bed[0]));
  setModel('mBedY', unwrap(bed[1]), force, e('bed_mm', bed[1]));
  setModel('mNozzle', unwrap(p.nozzle_mm), force, e('nozzle_mm', p.nozzle_mm));
  setModel('mEnclosed', typeof p.enclosed === 'boolean' ? Number(p.enclosed) : null, force, e('enclosed', null));
  setModel('mBedW', unwrap(p.bed_heater_w), force, e('bed_heater_w', p.bed_heater_w));
  setModel('mHotW', unwrap(p.hotend_heater_w), force, e('hotend_heater_w', p.hotend_heater_w));
}

function modelFromFilament(f: Filament | null, force: boolean): void {
  if (!f) return;
  setModel('mNozzleTemp', unwrap(f.nozzle_temp_c), force);
  setModel('mBedTemp', unwrap(f.bed_temp_c), force);
}

function modelDefaults(): void {
  if (!('mAmbient' in state.auto)) setAuto('mAmbient', 22);
  if (!('mNozzle' in state.auto)) setAuto('mNozzle', 0.4);
}

function modelEstimate(): WattEstimate | null {
  const v = state.values;
  const p = printerById(state.printerId);
  const has = (k: string): boolean => unwrap(v[k]) !== null;
  if (!has('mBedX') || !has('mBedY') || !has('mBedTemp') || !has('mNozzleTemp')) return null;
  const idle = unwrap(p?.power_w?.idle);
  return estimateWatts({
    bedX: unwrap(v.mBedX), bedY: unwrap(v.mBedY), bedTemp: unwrap(v.mBedTemp),
    nozzleDiam: unwrap(v.mNozzle) ?? 0.4, nozzleTemp: unwrap(v.mNozzleTemp),
    ambient: unwrap(v.mAmbient) ?? 22, enclosed: Boolean(Number(v.mEnclosed)),
    bedHeaterW: unwrap(v.mBedW), hotendHeaterW: unwrap(v.mHotW),
    idleW: idle ?? 12, densityGcm3: unwrap(v.density) ?? 1.24,
  });
}

const usesModelWatt = (): boolean => state.printerId === OTHER || Boolean(printerById(state.printerId)?.watt_from_model);

function syncOtherWatt(force: boolean): void {
  if (!usesModelWatt()) return;
  const e = modelEstimate();
  setAuto('watt', e ? Math.round(e.watts) : null, true, force);
}

function updateWatt(force: boolean): void {
  if (usesModelWatt()) { syncOtherWatt(force); return; }
  const p = printerById(state.printerId);
  if (!p) return;
  const w = pickWatt(p, filamentById(state.filamentId)?.material ?? state.fileMaterial);
  setAuto('watt', w.value, w.estimated || estFlag(p, w.key, null), force);
}

/** Scheda Ammortamento attiva: Costo macchina e Vita utile automatici vengono dalle sue impostazioni. */
function applyAmortization(force: boolean): void {
  const a = state.settings.amortization;
  if (!a.enabled) return;
  const x = amortizationInputs(a);
  const [cost, life] = isSla() ? ['sMachineCost', 'sLifeH'] : ['machineCost', 'lifeH'];
  if (x.machineCost !== null) setAuto(cost!, x.machineCost, false, force);
  if (x.lifeH !== null) setAuto(life!, x.lifeH, false, force);
}

/** Aggiornata da bindSettings: riporta i valori delle impostazioni nei campi del pannello. */
let fillSettings: () => void = () => { /* pannello non ancora pronto */ };

function applyPrinter(id: string, force = true): void {
  state.printerId = id;
  const p = printerById(id);
  if (!p) {
    for (const f of PRINTER_AUTO) setAuto(f, null, false, force);
    updateWatt(force);
    applyAmortization(force);
    return;
  }
  const am = state.settings.amortization;
  const pr = unwrap(p.price_eur);
  if (am.enabled && pr !== null && (force || am.price === 0)) { am.price = pr; fillSettings(); }
  modelFromPrinter(p, force);
  setAuto('machineCost', unwrap(p.price_eur), estFlag(p, 'price_eur', p.price_eur), force);
  setAuto('lifeH', unwrap(p.lifetime_h), estFlag(p, 'lifetime_h', p.lifetime_h), force);
  const cons = p.consumables ?? [];
  const wear = wearPerHour(cons);
  setAuto('wear', cons.length ? wear : null,
    cons.some((c, i) => !c.optional && (estFlag(p, `consumables[${i}]`, c.cost_eur) || isEstimated(c.life_h))), force);
  updateWatt(force);
  applyAmortization(force);
}

function applyFilament(id: string, force = true): void {
  state.filamentId = id;
  const f = filamentById(id);
  if (force) delete state.values.spoolPrice;
  if (!f) {
    for (const k of ['eurKg', 'density']) setAuto(k, null, false, force);
  } else {
    setAuto('eurKg', unwrap(f.cost_eur_kg), false, force);
    setAuto('density', unwrap(f.density_g_cm3), false, force);
  }
  modelFromFilament(f, force);
  setAuto('spoolG', 1000, false, force); // peso netto standard; la tara del catalogo non c'entra
  updateWatt(false);
}

const SLA_AUTO = ['sWatt', 'sMachineCost', 'sLifeH', 'sWearPrint', 'sWearH'];

/** Stampante a resina: potenza in stampa, prezzo, vita e usura (FEP €/stampa, LCD €/h) dal catalogo. */
function applySlaPrinter(id: string, force = true): void {
  state.slaPrinterId = id;
  const p = slaPrinterById(id);
  if (!p) {
    for (const f of SLA_AUTO) setAuto(f, null, false, force);
    applyAmortization(force);
    return;
  }
  const am = state.settings.amortization;
  const pr = unwrap(p.price_eur);
  if (am.enabled && pr !== null && (force || am.price === 0)) { am.price = pr; fillSettings(); }
  setAuto('sWatt', unwrap(p.power_w?.printing), estFlag(p, 'power_w.printing', p.power_w?.printing), force);
  setAuto('sMachineCost', pr, estFlag(p, 'price_eur', p.price_eur), force);
  setAuto('sLifeH', unwrap(p.lifetime_h), estFlag(p, 'lifetime_h', p.lifetime_h), force);
  const cons = p.consumables ?? [];
  const w = wearSla(cons);
  const est = cons.some((c, i) => !c.optional && (estFlag(p, `consumables[${i}]`, c.cost_eur) || isEstimated(c.life_h) || isEstimated(c.life_prints)));
  setAuto('sWearPrint', cons.length ? w.perPrint : null, est, force);
  setAuto('sWearH', cons.length ? w.perHour : null, est, force);
  applyAmortization(force);
}

/** Resina: prezzo €/L da resin-prices.json (curato) altrimenti 30 €/L stimati; densita' dal catalogo o 1,1. */
function applyResin(id: string, force = true): void {
  state.resinId = id;
  const r = resinById(id);
  const info = r ? resinPriceInfo(r, resinPrices) : null;
  setAuto('eurL', info?.price ?? DEFAULT_EUR_L, info === null || info.estimated, force);
  const rho = r ? unwrap(r.density_g_cm3) : null;
  setAuto('rho', rho ?? DEFAULT_RHO, rho === null, force);
}

function setTech(tech: Tech): void {
  if (state.tech === tech) return;
  state.tech = tech;
  const am = state.settings.amortization;
  const pr = unwrap(activePrinter()?.price_eur);
  if (am.enabled && pr !== null && am.price === 0) am.price = pr;
  // la scheda Ammortamento e' condivisa FDM/SLA: ricalcola i valori automatici della tecnologia attivata
  applyPrinter(state.printerId, false);
  applySlaPrinter(state.slaPrinterId, false);
  fillSettings();
  refresh();
}

/** Dati della modalita' resina nella forma di computeSla(). */
function slaInput(): SlaInput {
  const a = state.settings.advanced;
  const v = (k: string): FieldValue => state.values[k] ?? '';
  return {
    pieces: v('pieces'), failPct: v('failPct'), hours: v('hours'), watt: v('sWatt'), ml: v('ml'), eurL: v('eurL'),
    ipaMl: a.ipaMl, ipaEurL: a.ipaEurL, energyRate: v('energyRate'), machineCost: v('sMachineCost'), lifeH: v('sLifeH'),
    wearPrint: v('sWearPrint'), wearH: v('sWearH'), laborMin: v('laborMin'), laborRate: v('laborRate'), markupPct: v('markupPct'),
  };
}

/** Preventivo corrente nella tecnologia attiva. */
const computeNow = (): ComputeResult => (isSla() ? computeSla(slaInput(), extras()) : compute(state.values, extras()));

/** Parametri di stampa da G-code: solo in modalita' filamento. */
const currentParams = (): string[] => (isSla() ? [] : paramLines(state.fileParams));

/* ---------- selettori ---------- */

interface ElProps { value?: string; label?: string; className?: string; style?: string }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElProps = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className !== undefined) e.className = props.className;
  if (props.style !== undefined) e.setAttribute('style', props.style);
  if (props.value !== undefined && (e instanceof HTMLOptionElement || e instanceof HTMLTextAreaElement)) e.value = props.value;
  if (props.label !== undefined && e instanceof HTMLOptGroupElement) e.label = props.label;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildPrinterSelect(): void {
  const sel = $<HTMLSelectElement>('#printer');
  const terms = normText($<HTMLInputElement>('#psearch').value).split(' ').filter(Boolean);
  const match = (p: Printer): boolean => {
    const hay = normText(`${p.brand ?? ''} ${p.model ?? ''} ${p.name ?? ''}`);
    return terms.every((t) => hay.includes(t)) || p.id === state.printerId;
  };
  sel.replaceChildren(el('option', { value: '' }, t('printer.pick')),
    el('option', { value: OTHER }, t('printer.other')));
  const curated: Printer[] = [], imported: Printer[] = [], vendors = new Map<string, Printer[]>();
  for (const p of allPrinters().filter(match)) {
    if (p.user) imported.push(p);
    else if (p.source === 'prusaslicer') {
      const brand = p.brand ?? t('brand.others');
      const list = vendors.get(brand) ?? [];
      list.push(p);
      vendors.set(brand, list);
    } else curated.push(p);
  }
  const group = (label: string, list: readonly Printer[], text: (p: Printer) => string): void => {
    if (!list.length) return;
    const og = el('optgroup', { label });
    for (const p of list) og.append(el('option', { value: p.id }, text(p)));
    sel.append(og);
  };
  group(t('printer.groupCurated'), curated, printerLabel);
  group(t('printer.groupImported'), imported, (p) => p.model ?? p.id);
  const names = [...vendors.keys()].sort((a, b) => (a === 'Prusa Research' ? -1 : b === 'Prusa Research' ? 1 : a.localeCompare(b)));
  for (const v of names) group(v, (vendors.get(v) ?? []).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))), (p) => p.name ?? p.id);
  sel.value = state.printerId;
}

function buildFilamentSelect(): void {
  const sel = $<HTMLSelectElement>('#filament');
  const terms = normText($<HTMLInputElement>('#fsearch').value).split(' ').filter(Boolean);
  const match = (f: Filament): boolean => {
    const hay = normText(`${f.name ?? ''} ${f.vendor ?? ''} ${f.material ?? ''}`);
    return terms.every((t) => hay.includes(t)) || f.id === state.filamentId;
  };
  sel.replaceChildren(el('option', { value: '' }, t('fil.pick')));
  const groups = new Map<string, Filament[]>();
  for (const f of allFilaments().filter(match)) {
    const g = String(f.material || 'Altro').toUpperCase();
    const list = groups.get(g) ?? [];
    list.push(f);
    groups.set(g, list);
  }
  const rank = (g: string): number => (MATERIAL_ORDER.includes(g) ? MATERIAL_ORDER.indexOf(g) : 99);
  const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const g of keys) {
    const og = el('optgroup', { label: g === 'ALTRO' ? t('mat.other') : g });
    for (const f of (groups.get(g) ?? []).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))) {
      const price = unwrap(f.cost_eur_kg);
      og.append(el('option', { value: f.id }, `${f.name}${f.user ? t('fil.imported') : ''}${price !== null ? ` · ${fmt(price)} ${t('u.curKg')}` : ''}`));
    }
    sel.append(og);
  }
  sel.value = state.filamentId;
}

function buildSlaPrinterSelect(): void {
  const sel = $<HTMLSelectElement>('#sprinter');
  sel.replaceChildren(el('option', { value: '' }, t('printer.pickSla')));
  const brands = new Map<string, Printer[]>();
  for (const p of slaPrinters) {
    const b = p.brand ?? t('brand.others');
    brands.set(b, [...(brands.get(b) ?? []), p]);
  }
  for (const b of [...brands.keys()].sort((x, y) => x.localeCompare(y))) {
    const og = el('optgroup', { label: b });
    for (const p of brands.get(b) ?? []) og.append(el('option', { value: p.id }, p.model ?? p.id));
    sel.append(og);
  }
  sel.value = state.slaPrinterId;
}

function buildResinSelect(): void {
  const sel = $<HTMLSelectElement>('#resin');
  const terms = normText($<HTMLInputElement>('#rsearch').value).split(' ').filter(Boolean);
  const match = (r: Resin): boolean => terms.every((x) => normText(`${r.vendor} ${r.name} ${r.type}`).includes(x)) || r.id === state.resinId;
  sel.replaceChildren(el('option', { value: '' }, t('rs.pick')));
  const vendors = new Map<string, Resin[]>();
  for (const r of resins.filter(match)) vendors.set(r.vendor, [...(vendors.get(r.vendor) ?? []), r]);
  for (const v of [...vendors.keys()].sort((a, b) => a.localeCompare(b))) {
    const og = el('optgroup', { label: v });
    for (const r of (vendors.get(v) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const info = resinPriceInfo(r, resinPrices);
      og.append(el('option', { value: r.id }, `${r.name}${info ? ` · ${info.estimated ? '≈ ' : ''}${fmt(info.price)} ${t('u.curL')}` : ''}`));
    }
    sel.append(og);
  }
  sel.value = state.resinId;
}

/* ---------- rendering ---------- */

/** Consumabili generici di catalog.ts: il nome salvato e' italiano, la visualizzazione segue la lingua. */
const GENERIC_NAMES: Record<string, Key> = { 'Ugello (generico)': 'cons.nozzleGeneric', 'Piastra (generica)': 'cons.plateGeneric' };

function renderConsumables(): void {
  const p = activePrinter();
  const cons = p?.consumables ?? [];
  const box = $('#cons');
  box.hidden = cons.length === 0;
  const body = $('#cons-body');
  body.replaceChildren();
  for (const c of cons) {
    const cost = unwrap(c.cost_eur), prints = unwrap(c.life_prints), life = prints ?? unwrap(c.life_h);
    const tr = el('tr');
    const spec = prints
      ? t('cons.perPrint', { cost: fmt(cost ?? 0), n: fmt(prints, 0) })
      : `${fmt(cost ?? 0)} ${t('u.cur')} / ${fmt(life ?? 0, 0)} h${c.generic ? t('cons.generic') : ''}`;
    tr.append(
      el('td', {}, (c.generic ? t(GENERIC_NAMES[c.name] ?? 'cons.default') : '') || c.name || t('cons.default')),
      el('td', {}, cost !== null && life ? spec : t('cons.incomplete')),
      el('td', {}, cost !== null && life ? (prints ? t('cons.perPrintUnit', { v: fmt(cost / life, 3) }) : `${fmt(cost / life, 3)} ${t('u.curH')}`) : '—'),
    );
    body.append(tr);
  }
}

function renderFields(): void {
  for (const box of document.querySelectorAll<HTMLElement>('.fld')) {
    const f = box.dataset.f;
    const input = q<HTMLInputElement>('input', box);
    if (!f || !input) continue;
    if (f === 'wasteG') box.hidden = isSla() || !((state.auto.wasteG ?? 0) > 0 || Number(state.values.wasteG) > 0 || document.activeElement === input);
    const v = state.values[f];
    if (input.type === 'checkbox') input.checked = Boolean(Number(v));
    else if (document.activeElement !== input) input.value = v === undefined ? '' : String(v);
    const badge = q('.badge', box), reset = q('.reset', box);
    const hasAuto = f in state.auto;
    const same = hasAuto && v === state.auto[f];
    if (badge) {
      badge.hidden = !hasAuto;
      badge.className = `badge${same ? '' : ' manual'}`;
      badge.textContent = same ? (state.autoEst[f] ? t('badge.autoEst') : t('badge.auto')) : t('badge.manual');
      badge.title = same && state.autoEst[f] ? t('badge.estTitle') : '';
    }
    if (reset) reset.hidden = !hasAuto || same;
    box.classList.toggle('is-auto', same);
  }
  const job = $<HTMLInputElement>('#f-job');
  if (document.activeElement !== job) job.value = state.jobName;
  const est = modelEstimate();
  const use = $('#model-use');
  const e0 = (x: number): string => fmt(x, 0);
  $('#model-est').textContent = est
    ? t('model.est', { w: e0(est.watts), bed: e0(est.bed), hot: e0(est.hotend), melt: e0(est.melt), base: e0(est.base) })
    : t('model.estNone');
  use.hidden = !est;
  use.title = est ? t('model.useTitle', { w: e0(est.watts) }) : '';
  $('#markup-out').textContent = `${state.values.markupPct ?? 0}%`;
  const price = state.values.spoolPrice, g = state.values.spoolG;
  const per = pricePerKg(price, g);
  $('#spool-hint').textContent = per !== null
    ? t('spool.calc', { price: fmt(price), g: fmt(g, 0), per: fmt(per) })
    : t('spool.hint');
}

const SEGMENTS: ReadonlyArray<readonly [CostLine, Key]> = [
  ['material', 'line.material'], ['waste', 'line.waste'], ['energy', 'line.energy'], ['amort', 'line.amort'], ['wear', 'line.wear'], ['labor', 'line.labor'], ['wash', 'line.wash'],
];
const OPACITY = [1, 0.85, 0.68, 0.5, 0.34, 0.2, 0.12];

const pad2 = (v: number): string => String(v).padStart(2, '0');
const localInput = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** Avvio stampa: il valore scelto, altrimenti adesso. */
function startDate(): Date {
  const d = state.startAt ? new Date(state.startAt) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Dati delle schede attive per compute(). I pezzi si stampano in sequenza dall'avvio. */
function extras(): ComputeExtras {
  const st = state.settings, x: ComputeExtras = {};
  if (st.energy.enabled) {
    const pieces = Math.max(1, Math.round(Number(state.values.pieces)) || 1);
    x.bandHours = splitHoursByBand(startDate(), (Number(state.values.hours) || 0) * pieces, st.energy.mode, st.energy.bands);
    x.bandPrice = bandPrices(st.energy, Number(state.values.energyRate) || 0);
  }
  if (st.sale.enabled) x.postMin = st.sale.postMin;
  return x;
}

function renderResult(): ComputeResult {
  const i = state.values;
  const sla = isSla();
  const r = computeNow();
  const sl = state.settings;
  const split = wasteSplit(i.grams, i.wasteG);
  const detail: Record<CostLine, string> = {
    material: sla ? t('res.detResin', { ml: fmt(i.ml || 0, 1), p: fmt(i.eurL || 0) }) : t('res.detMaterial', { g: fmt(split.part, 1), p: fmt(i.eurKg || 0) }),
    waste: t('res.detWaste', { approx: state.autoEst.wasteG && i.wasteG === state.auto.wasteG ? '≈ ' : '', g: fmt(split.waste, 1), p: fmt(i.eurKg || 0) }),
    energy: r.bands ? bandsText(r.bands) : t('res.detKwh', { n: fmt(r.kwh, 2) }),
    wash: t('res.detWash', { ml: fmt(sl.advanced.ipaMl, 0), p: fmt(sl.advanced.ipaEurL) }),
    amort: '', wear: '',
    labor: t('res.detMin', { n: fmt((Number(i.laborMin) || 0) + (sl.sale.enabled ? sl.sale.postMin : 0), 0) }),
  };
  const lines = $('#lines'), bar = $('#bar');
  lines.replaceChildren();
  bar.replaceChildren();
  SEGMENTS.forEach(([key, label], n) => {
    if ((key === 'waste' || key === 'wash') && r.lines[key] <= 0) return;
    const dt = el('dt');
    if (key === 'waste' && state.fileToolChanges > 0) dt.title = t('res.wasteTip', { n: state.fileToolChanges });
    dt.append(el('i', { style: `opacity:${OPACITY[n] ?? 1}` }), t(sla && key === 'material' ? 'line.resin' : label));
    if (detail[key]) dt.append(el('small', {}, detail[key]));
    const row = el('div');
    row.append(dt, el('dd', {}, eur(r.lines[key])));
    lines.append(row);
    if (r.subtotal > 0) bar.append(el('i', { style: `flex:${r.lines[key] / r.subtotal} 1 0;opacity:${OPACITY[n] ?? 1}` }));
  });
  $('#r-sub').textContent = eur(r.subtotal);
  $('#r-margin-l').textContent = t('res.markupN', { n: fmt(i.markupPct || 0, 0) });
  $('#r-margin').textContent = eur(r.margin);
  $('#r-price').textContent = eur(r.price);
  $('#r-total-l').textContent = t(r.pieces === 1 ? 'res.totalOne' : 'res.totalMany', { n: r.pieces });
  $('#r-total').textContent = eur(r.total);
  const sale = sl.sale.enabled ? applySale(r.total, sl.sale) : null;
  const saleBox = $('#sale-lines');
  saleBox.hidden = sale === null;
  saleBox.replaceChildren();
  if (sale) {
    const add = (label: string, v: number): void => {
      const row = el('div');
      row.append(el('dt', {}, label), el('dd', {}, eur(v)));
      saleBox.append(row);
    };
    if (sale.fees > 0) add(t('line.fees'), sale.fees);
    if (sale.shipping > 0) add(t('line.ship'), sale.shipping);
    add(t('line.vat', { n: fmt(sl.sale.vatPct, 1).replace(/[.,]0$/, '') }), sale.vat);
    add(t('res.customer'), sale.customer);
  }
  const startFld = $('#start-fld'), startIn = $<HTMLInputElement>('#f-start');
  startFld.hidden = !sl.energy.enabled;
  // €/kWh base serve solo in tariffa personalizzata (tri/bi usano le tariffe delle Impostazioni)
  const rateFld = document.querySelector<HTMLElement>('.fld[data-f="energyRate"]');
  if (rateFld) rateFld.hidden = sl.energy.enabled && sl.energy.mode !== 'custom';
  if (sl.energy.enabled && document.activeElement !== startIn) startIn.value = state.startAt || localInput(new Date());
  $('#r-note').textContent = r.subtotal === 0
    ? t(sla ? 'res.noteEmptySla' : 'res.noteEmpty')
    : r.factor > 1.0001 ? t('res.noteFail', { n: fmt(i.failPct, 0) }) : '';
  const p = activePrinter(), f = sla ? resinById(state.resinId) : filamentById(state.filamentId);
  $('#ctx').textContent = [p ? printerLabel(p) : !sla && state.printerId === OTHER && t('printer.otherShort'), f && f.name].filter(Boolean).join(' · ') || t(sla ? 'res.ctxNoneSla' : 'res.ctxNone2');
  return r;
}

function renderParams(): void {
  const lines = currentParams();
  $('#params').hidden = lines.length === 0;
  $('#params-list').replaceChildren(...lines.map((t) => el('li', {}, t)));
}

/** Mostra solo i controlli della tecnologia attiva (interruttore Filamento | Resina). */
function renderTech(): void {
  const sla = isSla();
  for (const e of document.querySelectorAll<HTMLElement>('.fdm-only')) e.hidden = sla;
  for (const e of document.querySelectorAll<HTMLElement>('.sla-only')) e.hidden = !sla;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.tech === state.tech));
  $('#h-fil').textContent = t(sla ? 'rs.h' : 'fil.h');
  for (const k of ['ipaMl', 'ipaEurL']) $<HTMLInputElement>(`#set-advanced-${k}`).disabled = !sla;
}

function refresh(): void {
  syncOtherWatt(false);
  renderTech();
  buildPrinterSelect();
  buildFilamentSelect();
  buildSlaPrinterSelect();
  buildResinSelect();
  renderConsumables();
  renderFields();
  renderParams();
  renderResult();
  saveState(state);
}

/* ---------- messaggi ---------- */

function message(sel: string, lines: string | readonly string[], warn = false, replace = false): void {
  const ul = $(sel);
  if (replace) ul.replaceChildren();
  for (const t of typeof lines === 'string' ? [lines] : lines) ul.append(el('li', { className: warn ? 'warn' : '' }, t));
}

/* ---------- file G-code ---------- */

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

const baseName = (id: string | null): string => (id ?? '').replace(/\s*@.*$/, '').trim();

function findPrinter(data: ParsedPrint): Printer | null {
  const model = norm(data.printerModel);
  if (model) {
    const hit = allPrinters().find((p) => [...(p.prusaslicer_models ?? []), ...(p.aliases ?? [])].some((m) => norm(m) === model));
    if (hit) return hit;
  }
  const sid = norm(data.printerSettingsId);
  const byId = sid ? bestModelMatch(allPrinters(), sid) : null;
  if (byId) return byId;
  return model ? bestModelMatch(allPrinters(), model) : null;
}

/** Stampante SLA dal printerModel del file (.sl1: "SL1", "SL1S"), confrontato con prusaslicer_models e alias. */
function findSlaPrinter(model: string | null): Printer | null {
  const m = norm(model);
  return m ? slaPrinters.find((p) => [...(p.prusaslicer_models ?? []), ...(p.aliases ?? [])].some((x) => norm(x) === m)) ?? null : null;
}

function findFilament(data: ParsedPrint): Filament | null {
  const name = norm(baseName(data.filamentSettingsId));
  return name ? allFilaments().find((f) => norm(f.name) === name) ?? null : null;
}

/** Il file intero se e' ragionevole; altrimenti testa + coda (statistiche e config stanno ai bordi). */
async function readBuffer(file: File): Promise<ArrayBuffer> {
  const MAX = 64 * 1024 * 1024;
  const n = file.name.toLowerCase();
  if (/\.sl1s?$/.test(n)) return file.arrayBuffer(); // lo zip va letto per intero (la central directory e' in coda)
  if (n.endsWith('.bgcode') || n.endsWith('.bgc')) return file.slice(0, 4 * 1024 * 1024).arrayBuffer();
  if (file.size <= MAX || n.endsWith('.3mf')) return file.arrayBuffer();
  return new Blob([file.slice(0, 256 * 1024), '\n', file.slice(file.size - 600 * 1024)]).arrayBuffer();
}

async function handleFile(file: File): Promise<void> {
  const ul = '#file-msg';
  message(ul, [], false, true);
  try {
    const dens = Number(state.values.density);
    const data = await parsePrintFile(file.name, await readBuffer(file), dens > 0 ? { density: dens } : {});
    const warnings = data.warnings.map((w) => t(w.key, w.params));
    if (data.grams === null && data.hours === null && data.ml === null) {
      message(ul, [t('file.noData', { name: file.name }), ...warnings, t('file.needStats')], true);
      return;
    }
    state.fileName = file.name;
    if (!state.jobName.trim()) state.jobName = file.name.replace(/\.(gcode|gco|bgcode|bgc|3mf|sl1s?)$/i, '').slice(0, 80);
    if (data.ml !== null || /\.sl1s?$/i.test(file.name)) {
      // file a resina: passa alla modalita' resina
      state.tech = 'sla';
      state.fileParams = null; state.fileMaterial = ''; state.fileToolChanges = 0;
      if (data.ml !== null) setAuto('ml', data.ml, false, true);
      if (data.hours !== null) setAuto('hours', data.hours, false, true);
      const prn = findSlaPrinter(data.printerModel);
      if (prn) applySlaPrinter(prn.id, true);
      else applyAmortization(false);
      const got = [];
      if (data.ml !== null) got.push(`${fmt(data.ml, 1)} ml`);
      if (data.hours !== null) got.push(`${fmt(data.hours, 2)} h`);
      message(ul, t('file.got', { name: file.name, got: got.join(', ') }));
      message(ul, prn ? t('file.printerOk', { name: printerLabel(prn) })
        : data.printerModel ? t('file.printerUnknown', { name: data.printerModel }) : t('file.printerNone'), !prn);
      if (warnings.length) message(ul, warnings, true);
      fillSettings();
      refresh();
      return;
    }
    state.tech = 'fdm';
    state.fileMaterial = data.filamentType ?? '';
    state.fileParams = data.params ?? null;
    state.fileToolChanges = data.toolChanges !== null && data.toolChanges > 0 ? Math.round(data.toolChanges) : 0;
    if (data.grams !== null) setAuto('grams', data.grams, data.warnings.some((w) => w.key === 'warn.gramsFromLength'), true);
    if (data.hours !== null) setAuto('hours', data.hours, false, true);
    const waste = data.wasteGrams !== null && data.wasteGrams > 0 ? data.wasteGrams : null;
    setAuto('wasteG', waste, data.wasteEstimated, true);

    const fil = findFilament(data);
    const prn = findPrinter(data);
    if (fil) applyFilament(fil.id, true);
    else if (data.filamentSettingsId || data.filamentType) {
      applyFilament('', true);
      if (data.filamentCost !== null) setAuto('eurKg', data.filamentCost, false, true);
    }
    if (prn) applyPrinter(prn.id, true);
    else { updateWatt(true); applyAmortization(false); }
    setModel('mNozzleTemp', data.nozzleTemp, true, false, 'gcode');
    setModel('mBedTemp', data.bedTemp, true, false, 'gcode');
    setModel('mNozzle', data.nozzleDiameter, true, false, 'gcode');
    if (state.printerId === OTHER) syncOtherWatt(true);

    const got = [];
    if (data.grams !== null) got.push(`${fmt(data.grams, 1)} g`);
    if (data.hours !== null) got.push(`${fmt(data.hours, 2)} h`);
    message(ul, t('file.got', { name: file.name, got: got.join(', ') }));
    message(ul, t('file.slicer', { name: t(`slicer.${data.slicer}`) }));
    if (waste !== null) {
      message(ul, t('file.waste', { g: fmt(waste, 1), est: data.wasteEstimated ? ' ≈' : '', n: state.fileToolChanges }));
    }
    message(ul, prn ? t('file.printerOk', { name: printerLabel(prn) })
      : data.printerModel ? t('file.printerUnknown', { name: data.printerModel }) : t('file.printerNone'), !prn);
    message(ul, fil ? t('file.filOk', { name: fil.name })
      : data.filamentSettingsId ? t('file.filUnknown', { name: baseName(data.filamentSettingsId) }) : t('file.filNone'), !fil);
    if (warnings.length) message(ul, warnings, true);
  } catch (e) {
    message(ul, t('file.readFail', { name: file.name, err: errMsg(e) }), true);
  }
  refresh();
}

/* ---------- profili utente ---------- */

async function handleProfiles(files: readonly File[]): Promise<void> {
  const ul = '#prof-msg';
  message(ul, [], false, true);
  for (const file of files) {
    try {
      const got = importProfiles(await file.text(), file.name);
      const n = got.filaments.length + got.printers.length;
      if (!n) {
        message(ul, t('prof.none', { name: file.name }), true);
        continue;
      }
      profiles = mergeProfiles(profiles, got);
      message(ul, t('prof.ok', { name: file.name, f: got.filaments.length, p: got.printers.length }));
    } catch (e) {
      message(ul, `${file.name}: ${errMsg(e)}`, true);
    }
  }
  saveProfiles(profiles);
  refresh();
}

/* ---------- eventi ---------- */

function onFieldInput(e: Event): void {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  const f = t.closest<HTMLElement>('.fld')?.dataset.f;
  if (!f) return;
  const raw = t.value;
  state.values[f] = t.type === 'checkbox' ? Number(t.checked) : raw === '' ? '' : Number(raw);
  if (f === 'spoolPrice' || f === 'spoolG') {
    const per = pricePerKg(state.values.spoolPrice, state.values.spoolG);
    if (per !== null) state.values.eurKg = round(per);
  }
  refresh();
}

async function copyQuote(): Promise<void> {
  const sla = isSla();
  const prn = activePrinter();
  const printer = prn ? printerLabel(prn) : !sla && state.printerId === OTHER ? t('printer.other') : undefined;
  const filament = (sla ? resinById(state.resinId) : filamentById(state.filamentId))?.name;
  const ctx: QuoteContext = { params: currentParams(), ...(sla ? { resin: true } : {}) };
  const { businessName, notes } = state.settings.general;
  if (businessName.trim()) ctx.business = businessName.trim();
  if (notes.trim()) ctx.notes = notes.trim();
  if (printer !== undefined) ctx.printer = printer;
  if (filament !== undefined) ctx.filament = filament;
  const r = computeNow();
  if (state.settings.sale.enabled) { ctx.sale = applySale(r.total, state.settings.sale); ctx.vatPct = state.settings.sale.vatPct; }
  const text = quoteText(sla ? slaInput() : state.values, r, ctx);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = el('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* niente */ }
    ta.remove();
  }
  $('#copied').textContent = ok ? t('copy.ok') : t('copy.fail');
}

/** Copia un testo negli appunti (con ripiego execCommand) e scrive l'esito in #copied. */
async function copyText(text: string, okMsg: string): Promise<void> {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = el('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* niente */ }
    ta.remove();
  }
  $('#copied').textContent = ok ? okMsg : t('copy.fail');
}

const shareUrl = (key: 's' | 'q', payload: string): string => `${location.origin}${location.pathname}${location.search}#${key}=${payload}`;
const todayIso = (): string => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

async function shareInternal(): Promise<void> {
  await copyText(shareUrl('s', await encodeShare({ s: state })), t('share.ok'));
}

/** Solo i dati ammessi nel link cliente (vedi share.ts): mai costi interni, ricarico, tariffe, watt, consumabili. */
async function shareClient(): Promise<void> {
  const sla = isSla();
  const r = computeNow();
  const { businessName, notes, validityDays, currency } = state.settings.general;
  const prn = activePrinter();
  const input: Parameters<typeof buildClientQuote>[0] = {
    date: todayIso(), days: validityDays, pieces: r.pieces, price: r.price, total: r.total,
    lang: getLang(), cur: currency, params: currentParams(),
  };
  if (state.jobName.trim()) input.job = state.jobName;
  if (businessName.trim()) input.business = businessName;
  if (notes.trim()) input.notes = notes;
  const printer = prn ? printerLabel(prn) : !sla && state.printerId === OTHER ? t('printer.other') : '';
  if (printer) input.printer = printer;
  const material = (sla ? resinById(state.resinId) : filamentById(state.filamentId))?.name;
  if (material) input.material = material;
  if (state.settings.sale.enabled) {
    const s = applySale(r.total, state.settings.sale);
    // tra il totale e l'IVA c'e' tutto cio' che si aggiunge: imballo, spedizione e commissioni, senza distinguerli
    input.sale = { ...s, shipping: Math.max(0, s.customer - s.vat - r.total) };
    input.vatPct = state.settings.sale.vatPct;
  }
  await copyText(shareUrl('q', await encodeShare({ ...buildClientQuote(input) })), t('share.ok'));
}

/* ---------- vista cliente ---------- */

function renderClient(c: ClientQuote): void {
  setLang(c.lang);
  setSymbol(c.cur);
  document.documentElement.lang = c.lang;
  const loc = c.lang === 'en' ? 'en-GB' : 'it-IT';
  const start = new Date(`${c.date}T00:00:00`);
  const valid = !Number.isNaN(start.getTime());
  const until = valid ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + c.days) : null;
  const day = (d: Date): string => d.toLocaleDateString(loc, { day: '2-digit', month: 'long', year: 'numeric' });
  const card = el('article', { className: 'cq' });
  card.append(el('h1', {}, c.biz ?? t('cv.title')));
  if (c.biz) card.append(el('p', { className: 'cq-meta' }, t('cv.title')));
  if (c.job) card.append(el('p', { className: 'cq-job' }, c.job));
  if (valid) card.append(el('p', { className: 'cq-meta' }, t('cv.date', { v: day(start) })));
  if (c.printer) card.append(el('p', { className: 'cq-meta' }, `${t('cv.printer')}: ${c.printer}`));
  if (c.mat) card.append(el('p', { className: 'cq-meta' }, `${t('cv.material')}: ${c.mat}`));
  const body = el('tbody');
  const row = (label: string, value: string, cls = ''): void => {
    const tr = el('tr', { className: cls });
    tr.append(el('td', {}, label), el('td', {}, value));
    body.append(tr);
  };
  row(t('cv.perPiece'), fmtCur(c.price));
  row(t('cv.pieces'), String(c.pieces));
  row(t(c.pieces === 1 ? 'res.totalOne' : 'res.totalMany', { n: c.pieces }), fmtCur(c.total), c.sale ? '' : 'grand');
  if (c.sale) {
    if (c.sale.ship > 0.004) row(t('cv.ship'), fmtCur(c.sale.ship));
    row(t('line.vat', { n: fmtNum(c.sale.vatPct, 1).replace(/[.,]0$/, '') }), fmtCur(c.sale.vat));
    row(t('res.customer'), fmtCur(c.sale.tot), 'grand');
  }
  const head = el('tr');
  head.append(el('th', {}, t('cv.item')), el('th', {}, t('cv.amount')));
  const thead = el('thead');
  thead.append(head);
  const table = el('table');
  table.append(thead, body);
  card.append(table);
  if (c.params?.length) {
    card.append(el('p', { className: 'cq-meta' }, t('cv.params')));
    const ul = el('ul');
    ul.append(...c.params.map((p) => el('li', {}, p)));
    card.append(ul);
  }
  if (c.notes) card.append(el('p', { className: 'cq-notes' }, c.notes));
  if (until) card.append(el('p', { className: 'cq-valid' }, t('cv.valid', { n: c.days, until: day(until) })));
  const actions = el('div', { className: 'actions' });
  const print = el('button', { className: 'btn primary' }, t('cv.print'));
  print.type = 'button';
  print.style.width = 'auto';
  print.addEventListener('click', () => window.print());
  const open = el('a', { className: 'btn ghost' }, t('cv.open'));
  open.href = location.pathname + location.search;
  actions.append(print, open);
  card.append(actions);
  $('#client-view').replaceChildren(card);
  document.title = `${c.biz ?? 'OpenPrintCalc'} - ${t('cv.title')}`;
}

/** Link cliente: mostra il preventivo e nasconde il calcolatore. false = link illeggibile, si prosegue col calcolatore. */
async function showClient(payload: string): Promise<boolean> {
  try {
    renderClient(parseClientQuote(await decodeShare(payload)));
    return true;
  } catch { return false; }
}

/** Link interno: lo stato condiviso ha la precedenza sul localStorage. false = link illeggibile. */
async function loadShared(payload: string): Promise<boolean> {
  try {
    const dec = await decodeShare(payload);
    const next = parseState(dec.s);
    try { localStorage.setItem('openprintcalc.state.backup', JSON.stringify(state)); } catch { /* quota o privacy */ }
    if (!confirm(t('share.confirm'))) return true; // mantiene lo stato locale
    Object.assign(state, next);
    return true;
  } catch { return false; }
}

function bind(): void {
  $('#share-int').addEventListener('click', () => { void shareInternal(); });
  $('#share-cli').addEventListener('click', () => { void shareClient(); });
  $<HTMLInputElement>('#f-job').addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement) { state.jobName = e.target.value; saveState(state); }
  });
  window.addEventListener('hashchange', () => { if (/^#[sq]=/.test(location.hash)) location.reload(); });
  document.addEventListener('input', onFieldInput);
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('.reset') : null;
    if (!btn) return;
    const f = btn.closest<HTMLElement>('.fld')?.dataset.f;
    const a = f === undefined ? undefined : state.auto[f];
    if (f !== undefined && a !== undefined) state.values[f] = a;
    refresh();
  });
  const printerSel = $<HTMLSelectElement>('#printer'), filamentSel = $<HTMLSelectElement>('#filament');
  printerSel.addEventListener('change', () => { applyPrinter(printerSel.value, true); refresh(); });
  filamentSel.addEventListener('change', () => { applyFilament(filamentSel.value, true); refresh(); });
  $('#fsearch').addEventListener('input', buildFilamentSelect);
  const slaSel = $<HTMLSelectElement>('#sprinter'), resinSel = $<HTMLSelectElement>('#resin');
  slaSel.addEventListener('change', () => { applySlaPrinter(slaSel.value, true); refresh(); });
  resinSel.addEventListener('change', () => { applyResin(resinSel.value, true); refresh(); });
  $('#rsearch').addEventListener('input', buildResinSelect);
  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
    b.addEventListener('click', () => setTech(b.dataset.tech === 'sla' ? 'sla' : 'fdm'));
  }
  $('#psearch').addEventListener('input', buildPrinterSelect);
  $('#copy').addEventListener('click', copyQuote);
  $<HTMLInputElement>('#f-start').addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement) { state.startAt = e.target.value; refresh(); }
  });
  $('#model-use').addEventListener('click', () => {
    const e = modelEstimate();
    if (e) { state.values.watt = Math.round(e.watts); refresh(); }
  });
  const iniPick = $<HTMLInputElement>('#file-ini');
  iniPick.addEventListener('change', () => { void handleProfiles([...(iniPick.files ?? [])]); iniPick.value = ''; });
  $('#clear-profiles').addEventListener('click', () => {
    profiles = { filaments: [], printers: [] } satisfies Profiles;
    if (!printerById(state.printerId)) applyPrinter('', false);
    if (!filamentById(state.filamentId)) applyFilament('', false);
    saveProfiles(profiles);
    message('#prof-msg', t('prof.removed'), false, true);
    refresh();
  });

  const drop = $('#drop');
  const pick = $<HTMLInputElement>('#file-gcode');
  pick.addEventListener('change', () => { const f = pick.files?.[0]; if (f) void handleFile(f); pick.value = ''; });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) void handleFile(f); });
  // evita che il browser apra il file se viene lasciato fuori dalla zona
  for (const t of ['dragover', 'drop']) window.addEventListener(t, (e) => e.preventDefault());
}

/* ---------- lingua e impostazioni ---------- */

/** Applica lingua e simbolo valuta correnti ai testi statici; il contenuto dinamico lo rifa refresh(). */
function applyLang(): void {
  const g = state.settings.general;
  setLang(resolveLang(g.lang));
  setSymbol(g.currency);
  applyI18n();
}

const FUTURE_TABS: readonly FutureTab[] = ['energy', 'amortization', 'sale'];

function bindSettings(): void {
  const dlg = $<HTMLDialogElement>('#settings');
  const g = state.settings.general;
  const lang = $<HTMLSelectElement>('#set-lang'), cur = $<HTMLInputElement>('#set-currency');
  const biz = $<HTMLInputElement>('#set-business'), notes = $<HTMLTextAreaElement>('#set-notes');
  const st = state.settings;
  const section = (tab: string): Record<string, unknown> | null =>
    tab === 'energy' ? st.energy : tab === 'amortization' ? st.amortization : tab === 'sale' ? st.sale : tab === 'advanced' ? st.advanced : null;
  const modeSel = $<HTMLSelectElement>('#set-energy-mode'), platSel = $<HTMLSelectElement>('#set-sale-platform');
  const bandsBox = $('#set-bands');

  const bandInput = (i: number, k: string, type: string, value: string, label: string): HTMLInputElement => {
    const inp = document.createElement('input');
    inp.type = type;
    inp.value = value;
    inp.dataset.i = String(i);
    inp.dataset.k = k;
    inp.setAttribute('aria-label', label);
    if (type === 'number') { inp.min = '0'; inp.step = k === 'price' ? 'any' : '1'; if (k !== 'price') inp.max = '24'; }
    if (type === 'text') { inp.maxLength = 20; inp.placeholder = label; }
    return inp;
  };
  const renderBands = (): void => {
    bandsBox.replaceChildren();
    st.energy.bands.forEach((b, i) => {
      const row = el('div', { className: 'band-row' });
      const day = document.createElement('select');
      day.dataset.i = String(i);
      day.dataset.k = 'day';
      day.setAttribute('aria-label', t('en.day.weekday'));
      for (const d of ['weekday', 'sat', 'sun'] as const) {
        const o = el('option', { value: d }, t(d === 'weekday' ? 'en.day.weekday' : d === 'sat' ? 'en.day.sat' : 'en.day.sun'));
        day.append(o);
      }
      day.value = b.day;
      const del = el('button', { className: 'btn ghost' }, t('en.del'));
      del.type = 'button';
      del.addEventListener('click', () => { st.energy.bands.splice(i, 1); renderBands(); refresh(); });
      row.append(bandInput(i, 'name', 'text', b.name, t('en.bandName')), day,
        bandInput(i, 'from', 'number', String(b.from), t('en.from')), bandInput(i, 'to', 'number', String(b.to), t('en.to')),
        bandInput(i, 'price', 'number', String(b.price), t('u.curKwh')), del);
      bandsBox.append(row);
    });
  };
  const fill = (): void => {
    $<HTMLInputElement>('#set-validity').value = String(g.validityDays);
    lang.value = g.lang; cur.value = g.currency; biz.value = g.businessName; notes.value = g.notes;
    for (const k of FUTURE_TABS) {
      $<HTMLInputElement>(`#set-${k}-enabled`).checked = st[k].enabled;
      const box = q(`#fields-${k}`);
      if (box) box.hidden = !st[k].enabled;
    }
    for (const inp of dlg.querySelectorAll<HTMLInputElement>('input[data-set]')) {
      const [tab = '', key = ''] = (inp.dataset.set ?? '').split('.');
      const v = section(tab)?.[key];
      if (typeof v === 'number' && document.activeElement !== inp) inp.value = String(round(v, 6));
    }
    modeSel.value = st.energy.mode;
    platSel.value = st.sale.platform;
    for (const row of dlg.querySelectorAll<HTMLElement>('[data-modes]')) row.hidden = !(row.dataset.modes ?? '').split(' ').includes(st.energy.mode);
    renderBands();
  };
  fillSettings = fill;
  fill();
  $('#open-settings').addEventListener('click', () => { fill(); dlg.showModal(); });
  $('#close-settings').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clic sullo sfondo

  const changed = (): void => { applyAmortization(false); refresh(); };
  for (const k of FUTURE_TABS) {
    $<HTMLInputElement>(`#set-${k}-enabled`).addEventListener('change', (e) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      st[k].enabled = e.target.checked;
      if (k === 'amortization') {
        const pr = unwrap(activePrinter()?.price_eur);
        if (st.amortization.enabled && st.amortization.price === 0 && pr !== null) st.amortization.price = pr;
        else if (!st.amortization.enabled) { if (isSla()) applySlaPrinter(state.slaPrinterId, false); else applyPrinter(state.printerId, false); }
      }
      fill();
      changed();
    });
  }
  dlg.addEventListener('input', (e) => {
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement) || inp.dataset.set === undefined) return;
    const [tab = '', key = ''] = inp.dataset.set.split('.');
    const sec = section(tab);
    const v = inp.value === '' ? 0 : Number(inp.value);
    if (!sec || !(key in sec) || !Number.isFinite(v) || v < 0) return;
    sec[key] = v;
    changed();
  });
  modeSel.addEventListener('change', () => {
    st.energy.mode = modeSel.value === 'bi' ? 'bi' : modeSel.value === 'custom' ? 'custom' : 'tri';
    fill();
    refresh();
  });
  const PRESETS: Record<Exclude<Platform, 'none' | 'custom'>, readonly [number, number]> = {
    etsy: [10.5, 0.5], shopify: [2, 0.25], paypal: [3.4, 0.35], stripe: [1.5, 0.25],
  };
  platSel.addEventListener('change', () => {
    const v = platSel.value;
    st.sale.platform = v === 'etsy' || v === 'shopify' || v === 'paypal' || v === 'stripe' || v === 'custom' ? v : 'none';
    if (st.sale.platform !== 'none' && st.sale.platform !== 'custom') [st.sale.feePct, st.sale.feeFixed] = PRESETS[st.sale.platform];
    fill();
    refresh();
  });
  $('#add-band').addEventListener('click', () => {
    if (st.energy.bands.length >= 12) return;
    st.energy.bands.push({ name: '', day: 'weekday', from: 8, to: 19, price: st.energy.f1 });
    renderBands();
    refresh();
  });
  bandsBox.addEventListener('input', (e) => {
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement || inp instanceof HTMLSelectElement)) return;
    const b: CustomBand | undefined = st.energy.bands[Number(inp.dataset.i)];
    const k = inp.dataset.k;
    if (!b) return;
    if (k === 'name') b.name = inp.value.slice(0, 20);
    else if (k === 'day') b.day = inp.value === 'sat' ? 'sat' : inp.value === 'sun' ? 'sun' : 'weekday';
    else if (k === 'from' || k === 'to') b[k] = Math.min(24, Math.max(0, Math.floor(Number(inp.value) || 0)));
    else if (k === 'price') b.price = Math.max(0, Number(inp.value) || 0);
    refresh();
  });

  const tabs = [...dlg.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement, focus = false): void => {
    for (const b of tabs) {
      const on = b === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      const pane = q(`#${b.getAttribute('aria-controls') ?? ''}`, dlg);
      if (pane) pane.hidden = !on;
    }
    if (focus) tab.focus();
  };
  for (const b of tabs) b.addEventListener('click', () => select(b));
  dlg.querySelector('[role="tablist"]')?.addEventListener('keydown', (e) => {
    if (!(e instanceof KeyboardEvent)) return;
    const i = tabs.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    const next = to === null ? undefined : tabs[(to + tabs.length) % tabs.length];
    if (next) { e.preventDefault(); select(next, true); }
  });

  lang.addEventListener('change', () => {
    g.lang = lang.value === 'it' || lang.value === 'en' ? lang.value : 'auto';
    applyLang();
    renderBands();
    $('#copied').textContent = '';
    refresh();
  });
  cur.addEventListener('input', () => {
    g.currency = cur.value.trim() || '€';
    applyLang();
    refresh();
  });
  const validity = $<HTMLInputElement>('#set-validity');
  validity.addEventListener('input', () => {
    const v = Math.round(Number(validity.value));
    if (v >= 1 && v <= 365) { g.validityDays = v; saveState(state); }
  });
  biz.addEventListener('input', () => { g.businessName = biz.value; saveState(state); });
  notes.addEventListener('input', () => { g.notes = notes.value; saveState(state); });
}

/** Service worker alla radice del sito (sw.js, copiato dal build). In locale e' spento, salvo `?sw`, per non servire file vecchi in sviluppo. */
function registerSw(): void {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local && !new URLSearchParams(location.search).has('sw')) return;
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => { /* senza SW l'app funziona uguale */ });
}

async function init(): Promise<void> {
  const hash = location.hash;
  let bad = false;
  if (hash.startsWith('#q=')) {
    if (await showClient(hash.slice(3))) return;
    bad = true;
  } else if (hash.startsWith('#s=')) bad = !(await loadShared(hash.slice(3)));
  if (/^#[sq]=/.test(hash)) history.replaceState(null, '', location.pathname + location.search);
  document.documentElement.classList.remove('client');
  applyLang();
  if (bad) message('#file-msg', t('share.bad'), true);
  bindSettings();
  modelDefaults();
  applyAmortization(false);
  bind();
  refresh();
  registerSw();
  const [curated, psPrinters, filaments, slaList, resinList, prices] = await Promise.all([
    loadJson<Printer>('data/printers.json', 'printers'),
    loadJson<PsPrinter>('data/printers-prusaslicer.json', 'printers'),
    loadJson<Filament>('data/filaments.json', 'filaments'),
    loadJson<Printer>('data/sla-printers.json', 'printers'),
    loadJson<Resin>('data/resins.json', 'resins'),
    loadPrices(),
  ]);
  catalog = { printers: mergeCatalogs(curated, psPrinters), filaments };
  slaPrinters = slaList;
  resins = resinList;
  resinPrices = prices;
  // Aggiorna i valori auto dai dati appena caricati; quelli modificati a mano restano.
  if (printerById(state.printerId)) applyPrinter(state.printerId, false);
  if (filamentById(state.filamentId)) applyFilament(state.filamentId, false);
  if (slaPrinterById(state.slaPrinterId)) applySlaPrinter(state.slaPrinterId, false);
  applyResin(state.resinId, false);
  refresh();
}

void init();
