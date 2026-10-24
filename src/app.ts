import { compute, quoteText, eur, unwrap, isEstimated, wearPerHour, pickWatt, pricePerKg, estimateWatts } from './calc.ts';
import { parseGcode, paramLines } from './gcode.ts';
import { parseBgcode } from './bgcode.ts';
import { importProfiles, mergeProfiles } from './profiles.ts';
import { mergeCatalogs, bestModelMatch } from './catalog.ts';
import { loadState, saveState, loadProfiles, saveProfiles } from './state.ts';
import type { Catalog, ComputeResult, CostLine, Filament, GcodeData, Printer, Profiles, PsPrinter, QuoteContext, WattEstimate } from './types.ts';

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

const PRINTER_AUTO = ['watt', 'machineCost', 'lifeH', 'wear'];
const OTHER = '__other';
const MATERIAL_ORDER = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'PA'];
const fmt = (v: unknown, d = 2): string => Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;

const allPrinters = (): Printer[] => [...catalog.printers, ...profiles.printers];
const allFilaments = (): Filament[] => [...catalog.filaments, ...profiles.filaments];
const printerById = (id: string): Printer | null => allPrinters().find((p) => p.id === id) ?? null;
const filamentById = (id: string): Filament | null => allFilaments().find((f) => f.id === id) ?? null;
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
    message('#file-msg', `Impossibile caricare ${url}: l'elenco resta vuoto, puoi comunque inserire i valori a mano.`, true);
    return [];
  }
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

function applyPrinter(id: string, force = true): void {
  state.printerId = id;
  const p = printerById(id);
  if (!p) {
    for (const f of PRINTER_AUTO) setAuto(f, null, false, force);
    updateWatt(force);
    return;
  }
  modelFromPrinter(p, force);
  setAuto('machineCost', unwrap(p.price_eur), estFlag(p, 'price_eur', p.price_eur), force);
  setAuto('lifeH', unwrap(p.lifetime_h), estFlag(p, 'lifetime_h', p.lifetime_h), force);
  const cons = p.consumables ?? [];
  const wear = wearPerHour(cons);
  setAuto('wear', cons.length ? wear : null,
    cons.some((c, i) => !c.optional && (estFlag(p, `consumables[${i}]`, c.cost_eur) || isEstimated(c.life_h))), force);
  updateWatt(force);
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
  sel.replaceChildren(el('option', { value: '' }, '— scegli una stampante —'),
    el('option', { value: OTHER }, 'Altra stampante (stima dal modello)'));
  const curated: Printer[] = [], imported: Printer[] = [], vendors = new Map<string, Printer[]>();
  for (const p of allPrinters().filter(match)) {
    if (p.user) imported.push(p);
    else if (p.source === 'prusaslicer') {
      const brand = p.brand ?? 'Altri';
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
  group('Catalogo curato (prezzi e consumi)', curated, printerLabel);
  group('Profili importati', imported, (p) => p.model ?? p.id);
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
  sel.replaceChildren(el('option', { value: '' }, '— scegli un filamento —'));
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
    const og = el('optgroup', { label: g });
    for (const f of (groups.get(g) ?? []).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))) {
      const price = unwrap(f.cost_eur_kg);
      og.append(el('option', { value: f.id }, `${f.name}${f.user ? ' (importato)' : ''}${price !== null ? ` · ${fmt(price)} €/kg` : ''}`));
    }
    sel.append(og);
  }
  sel.value = state.filamentId;
}

/* ---------- rendering ---------- */

function renderConsumables(): void {
  const p = printerById(state.printerId);
  const cons = p?.consumables ?? [];
  const box = $('#cons');
  box.hidden = cons.length === 0;
  const body = $('#cons-body');
  body.replaceChildren();
  for (const c of cons) {
    const cost = unwrap(c.cost_eur), life = unwrap(c.life_h);
    const tr = el('tr');
    tr.append(
      el('td', {}, c.name || 'Consumabile'),
      el('td', {}, cost !== null && life ? `${fmt(cost)} € / ${fmt(life, 0)} h${c.generic ? ' (generici, stimati)' : ''}` : 'dati incompleti'),
      el('td', {}, cost !== null && life ? `${fmt(cost / life, 3)} €/h` : '—'),
    );
    body.append(tr);
  }
}

function renderFields(): void {
  for (const box of document.querySelectorAll<HTMLElement>('.fld')) {
    const f = box.dataset.f;
    const input = q<HTMLInputElement>('input', box);
    if (!f || !input) continue;
    const v = state.values[f];
    if (input.type === 'checkbox') input.checked = Boolean(Number(v));
    else if (document.activeElement !== input) input.value = v === undefined ? '' : String(v);
    const badge = q('.badge', box), reset = q('.reset', box);
    const hasAuto = f in state.auto;
    const same = hasAuto && v === state.auto[f];
    if (badge) {
      badge.hidden = !hasAuto;
      badge.className = `badge${same ? '' : ' manual'}`;
      badge.textContent = same ? (state.autoEst[f] ? 'auto ≈' : 'auto') : 'manuale';
      badge.title = same && state.autoEst[f] ? 'Valore automatico, ma stimato: non verificato da una misura.' : '';
    }
    if (reset) reset.hidden = !hasAuto || same;
    box.classList.toggle('is-auto', same);
  }
  const est = modelEstimate();
  const use = $('#model-use');
  const e0 = (x: number): string => fmt(x, 0);
  $('#model-est').textContent = est
    ? `Stima modello fisico: ${e0(est.watts)} W (letto ${e0(est.bed)}, hotend ${e0(est.hotend)}, fusione ${e0(est.melt)}, base ${e0(est.base)})`
    : 'Stima modello fisico: compila dimensioni e temperature del letto e temperatura ugello.';
  use.hidden = !est;
  use.title = est ? `Copia ${e0(est.watts)} W in Potenza media` : '';
  $('#markup-out').textContent = `${state.values.markupPct ?? 0}%`;
  const price = state.values.spoolPrice, g = state.values.spoolG;
  const per = pricePerKg(price, g);
  $('#spool-hint').textContent = per !== null
    ? `Prezzo bobina ${fmt(price)} € ÷ peso netto ${fmt(g, 0)} g = ${fmt(per)} €/kg`
    : 'Inserisci prezzo e peso netto della bobina: il prezzo al kg si calcola da solo.';
}

const SEGMENTS: ReadonlyArray<readonly [CostLine, string]> = [
  ['material', 'Materiale'], ['energy', 'Energia'], ['amort', 'Ammortamento'], ['wear', 'Usura'], ['labor', 'Manodopera'],
];
const OPACITY = [1, 0.78, 0.58, 0.4, 0.24];

function renderResult(): ComputeResult {
  const i = state.values;
  const r = compute(i);
  const detail: Record<CostLine, string> = {
    material: `${fmt(i.grams || 0, 1)} g × ${fmt(i.eurKg || 0)} €/kg`,
    energy: `${fmt(r.kwh, 2)} kWh`,
    amort: '', wear: '', labor: `${fmt(i.laborMin || 0, 0)} min`,
  };
  const lines = $('#lines'), bar = $('#bar');
  lines.replaceChildren();
  bar.replaceChildren();
  SEGMENTS.forEach(([key, label], n) => {
    const dt = el('dt');
    dt.append(el('i', { style: `opacity:${OPACITY[n] ?? 1}` }), label);
    if (detail[key]) dt.append(el('small', {}, detail[key]));
    const row = el('div');
    row.append(dt, el('dd', {}, eur(r.lines[key])));
    lines.append(row);
    if (r.subtotal > 0) bar.append(el('i', { style: `flex:${r.lines[key] / r.subtotal} 1 0;opacity:${OPACITY[n] ?? 1}` }));
  });
  $('#r-sub').textContent = eur(r.subtotal);
  $('#r-margin-l').textContent = `Ricarico ${fmt(i.markupPct || 0, 0)}%`;
  $('#r-margin').textContent = eur(r.margin);
  $('#r-price').textContent = eur(r.price);
  $('#r-total-l').textContent = `Totale per ${r.pieces} ${r.pieces === 1 ? 'pezzo' : 'pezzi'}`;
  $('#r-total').textContent = eur(r.total);
  $('#r-note').textContent = r.subtotal === 0
    ? 'Inserisci grammi e ore, oppure carica un file G-code.'
    : r.factor > 1.0001 ? `Materiale, energia e macchina includono ${fmt(i.failPct, 0)}% di stampe fallite.` : '';
  const p = printerById(state.printerId), f = filamentById(state.filamentId);
  $('#ctx').textContent = [p ? printerLabel(p) : state.printerId === OTHER && 'Altra stampante', f && f.name].filter(Boolean).join(' · ') || 'Nessuna stampante o filamento selezionati';
  return r;
}

function renderParams(): void {
  const lines = paramLines(state.fileParams);
  $('#params').hidden = lines.length === 0;
  $('#params-list').replaceChildren(...lines.map((t) => el('li', {}, t)));
}

function refresh(): void {
  syncOtherWatt(false);
  buildPrinterSelect();
  buildFilamentSelect();
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

function findPrinter(data: GcodeData): Printer | null {
  const model = norm(data.printerModel);
  if (model) {
    const hit = allPrinters().find((p) => (p.prusaslicer_models ?? []).some((m) => norm(m) === model));
    if (hit) return hit;
  }
  const sid = norm(data.printerSettingsId);
  if (!sid) return null;
  return bestModelMatch(allPrinters(), sid);
}

function findFilament(data: GcodeData): Filament | null {
  const name = norm(data.filamentName);
  return name ? allFilaments().find((f) => norm(f.name) === name) ?? null : null;
}

async function handleFile(file: File): Promise<void> {
  const ul = '#file-msg';
  message(ul, [], false, true);
  try {
    const magic = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
    let data: GcodeData, warnings: string[] = [];
    if (magic === 'GCDE') {
      ({ data, warnings } = await parseBgcode(await file.slice(0, 4 * 1024 * 1024).arrayBuffer()));
    } else {
      data = parseGcode(await file.slice(Math.max(0, file.size - 600 * 1024)).text());
    }
    if (data.grams === null && data.hours === null) {
      message(ul, [`Nessun dato di stampa in ${file.name}.`, ...warnings,
        'Servono i commenti di statistica di PrusaSlicer ("filament used" e "estimated printing time").'], true);
      return;
    }
    state.fileName = file.name;
    state.fileMaterial = data.filamentType ?? '';
    state.fileParams = data.params ?? null;
    if (data.grams !== null) setAuto('grams', data.grams, false, true);
    if (data.hours !== null) setAuto('hours', data.hours, false, true);

    const fil = findFilament(data);
    const prn = findPrinter(data);
    if (fil) applyFilament(fil.id, true);
    else if (data.filamentName || data.filamentType) {
      applyFilament('', true);
      if (data.filamentCost !== null) setAuto('eurKg', data.filamentCost, false, true);
    }
    if (prn) applyPrinter(prn.id, true);
    else updateWatt(true);
    setModel('mNozzleTemp', data.nozzleTemp, true, false, 'gcode');
    setModel('mBedTemp', data.bedTemp, true, false, 'gcode');
    setModel('mNozzle', data.nozzleDiameter, true, false, 'gcode');
    if (state.printerId === OTHER) syncOtherWatt(true);

    const got = [];
    if (data.grams !== null) got.push(`${fmt(data.grams, 1)} g`);
    if (data.hours !== null) got.push(`${fmt(data.hours, 2)} h`);
    message(ul, `${file.name}: ${got.join(', ')}`);
    message(ul, prn ? `Stampante riconosciuta: ${printerLabel(prn)}`
      : data.printerModel ? `Stampante "${data.printerModel}" non presente nell'elenco: sceglila a mano.` : 'Il file non indica la stampante.', !prn);
    message(ul, fil ? `Filamento riconosciuto: ${fil.name}`
      : data.filamentName ? `Filamento "${data.filamentName}" non presente nel catalogo: sceglilo a mano o importa il profilo .ini.` : 'Il file non indica il filamento.', !fil);
    if (warnings.length) message(ul, warnings, true);
  } catch (e) {
    message(ul, `Impossibile leggere ${file.name}: ${errMsg(e)}`, true);
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
        message(ul, `${file.name}: nessun profilo di filamento o stampante riconosciuto.`, true);
        continue;
      }
      profiles = mergeProfiles(profiles, got);
      message(ul, `${file.name}: ${got.filaments.length} filamenti, ${got.printers.length} stampanti.`);
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
  const prn = printerById(state.printerId);
  const printer = prn ? printerLabel(prn) : state.printerId === OTHER ? 'Altra stampante (stima dal modello)' : undefined;
  const filament = filamentById(state.filamentId)?.name;
  const ctx: QuoteContext = { params: paramLines(state.fileParams) };
  if (printer !== undefined) ctx.printer = printer;
  if (filament !== undefined) ctx.filament = filament;
  const text = quoteText(state.values, compute(state.values), ctx);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = el('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* niente */ }
    ta.remove();
  }
  $('#copied').textContent = ok ? 'Preventivo copiato negli appunti.' : 'Copia non riuscita: il browser ha bloccato gli appunti.';
}

function bind(): void {
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
  $('#psearch').addEventListener('input', buildPrinterSelect);
  $('#copy').addEventListener('click', copyQuote);
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
    message('#prof-msg', 'Profili importati rimossi.', false, true);
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

async function init(): Promise<void> {
  modelDefaults();
  bind();
  refresh();
  const [curated, psPrinters, filaments] = await Promise.all([
    loadJson<Printer>('data/printers.json', 'printers'),
    loadJson<PsPrinter>('data/printers-prusaslicer.json', 'printers'),
    loadJson<Filament>('data/filaments.json', 'filaments'),
  ]);
  catalog = { printers: mergeCatalogs(curated, psPrinters), filaments };
  // Aggiorna i valori auto dai dati appena caricati; quelli modificati a mano restano.
  if (printerById(state.printerId)) applyPrinter(state.printerId, false);
  if (filamentById(state.filamentId)) applyFilament(state.filamentId, false);
  refresh();
}

void init();
