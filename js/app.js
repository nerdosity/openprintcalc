import { compute, quoteText, eur, unwrap, isEstimated, wearPerHour, pickWatt, pricePerKg, estimateWatts } from './calc.js';
import { parseGcode, paramLines } from './gcode.js';
import { parseBgcode } from './bgcode.js';
import { importProfiles, mergeProfiles } from './profiles.js';
import { mergeCatalogs, bestModelMatch } from './catalog.js';
import { loadState, saveState, loadProfiles, saveProfiles } from './state.js';

const $ = (s, r = document) => r.querySelector(s);
const state = loadState();
let profiles = loadProfiles();
let catalog = { printers: [], filaments: [] };

const PRINTER_AUTO = ['watt', 'machineCost', 'lifeH', 'wear'];
const OTHER = '__other';
const MATERIAL_ORDER = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'PA'];
const fmt = (v, d = 2) => Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

const allPrinters = () => [...catalog.printers, ...profiles.printers];
const allFilaments = () => [...catalog.filaments, ...profiles.filaments];
const printerById = (id) => allPrinters().find((p) => p.id === id) ?? null;
const filamentById = (id) => allFilaments().find((f) => f.id === id) ?? null;
const printerLabel = (p) => (p.source === 'prusaslicer' ? p.name : `${p.brand ?? ''} ${p.model ?? p.id}`.trim());

/* ---------- dati ---------- */

async function loadJson(url, key) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const j = await res.json();
    const list = Array.isArray(j) ? j : j?.[key];
    return Array.isArray(list) ? list.filter((x) => x && typeof x === 'object' && x.id) : [];
  } catch {
    message('#file-msg', `Impossibile caricare ${url}: l'elenco resta vuoto, puoi comunque inserire i valori a mano.`, true);
    return [];
  }
}

/* ---------- precompilazione ---------- */

const isManual = (f) => {
  const v = state.values[f];
  if (v === undefined || v === '') return false;
  return !(f in state.auto) || v !== state.auto[f];
};

/** Imposta il valore automatico di un campo. Senza `force` non sovrascrive un valore modificato a mano. */
function setAuto(f, v, est = false, force = false) {
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

const normText = (s) => String(s ?? '').toLowerCase().replace(/[-_\s]+/g, ' ').trim();

const estFlag = (p, key, raw) => isEstimated(raw) ||
  (Array.isArray(p.estimated) && p.estimated.some((e) => e === key || e.startsWith(key + '.') || e.startsWith(key + '[')));

/**
 * Valore automatico dei campi del modello. `src` ('catalog'|'gcode') ricorda l'origine: in ricarica
 * (force=false) quelli di origine catalogo (o default) si ricalcolano, quelli da G-code restano.
 * Con v nullo (solo catalogo, solo con force): mNozzle torna a 0.4, le temperature non si toccano, gli altri si cancellano.
 */
function setModel(f, v, force, est = false, src = 'catalog') {
  state.autoSrc ??= {};
  if (v === null || v === undefined) {
    if (!force || src !== 'catalog' || f === 'mNozzleTemp' || f === 'mBedTemp') return;
    if (f === 'mNozzle') { setAuto(f, 0.4, false, true); state.autoSrc[f] = 'default'; return; }
    setAuto(f, null, false, true);
    return;
  }
  if (!force && f in state.auto && !['catalog', 'default'].includes(state.autoSrc[f])) return;
  setAuto(f, v, est, force);
  if (f in state.auto) state.autoSrc[f] = src;
}

function modelFromPrinter(p, force) {
  if (!p) return;
  const bed = Array.isArray(p.bed_mm) ? p.bed_mm : [];
  const e = (k, raw) => estFlag(p, k, raw);
  setModel('mBedX', unwrap(bed[0]), force, e('bed_mm', bed[0]));
  setModel('mBedY', unwrap(bed[1]), force, e('bed_mm', bed[1]));
  setModel('mNozzle', unwrap(p.nozzle_mm), force, e('nozzle_mm', p.nozzle_mm));
  setModel('mEnclosed', typeof p.enclosed === 'boolean' ? Number(p.enclosed) : null, force, e('enclosed', null));
  setModel('mBedW', unwrap(p.bed_heater_w), force, e('bed_heater_w', p.bed_heater_w));
  setModel('mHotW', unwrap(p.hotend_heater_w), force, e('hotend_heater_w', p.hotend_heater_w));
}

function modelFromFilament(f, force) {
  if (!f) return;
  setModel('mNozzleTemp', unwrap(f.nozzle_temp_c), force);
  setModel('mBedTemp', unwrap(f.bed_temp_c), force);
}

function modelDefaults() {
  if (!('mAmbient' in state.auto)) setAuto('mAmbient', 22);
  if (!('mNozzle' in state.auto)) setAuto('mNozzle', 0.4);
}

function modelEstimate() {
  const v = state.values;
  const p = printerById(state.printerId);
  const has = (k) => unwrap(v[k]) !== null;
  if (!has('mBedX') || !has('mBedY') || !has('mBedTemp') || !has('mNozzleTemp')) return null;
  const idle = unwrap(p?.power_w?.idle);
  return estimateWatts({
    bedX: unwrap(v.mBedX), bedY: unwrap(v.mBedY), bedTemp: unwrap(v.mBedTemp),
    nozzleDiam: unwrap(v.mNozzle) ?? 0.4, nozzleTemp: unwrap(v.mNozzleTemp),
    ambient: unwrap(v.mAmbient) ?? 22, enclosed: Boolean(Number(v.mEnclosed)),
    bedHeaterW: unwrap(v.mBedW) ?? undefined, hotendHeaterW: unwrap(v.mHotW) ?? undefined,
    idleW: idle ?? 12, densityGcm3: unwrap(v.density) ?? 1.24,
  });
}

const usesModelWatt = () => state.printerId === OTHER || Boolean(printerById(state.printerId)?.watt_from_model);

function syncOtherWatt(force) {
  if (!usesModelWatt()) return;
  const e = modelEstimate();
  setAuto('watt', e ? Math.round(e.watts) : null, true, force);
}

function updateWatt(force) {
  if (usesModelWatt()) { syncOtherWatt(force); return; }
  const p = printerById(state.printerId);
  if (!p) return;
  const w = pickWatt(p, filamentById(state.filamentId)?.material ?? state.fileMaterial);
  setAuto('watt', w.value, w.estimated || estFlag(p, w.key, null), force);
}

function applyPrinter(id, force = true) {
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
  const cons = Array.isArray(p.consumables) ? p.consumables : [];
  const wear = wearPerHour(cons);
  setAuto('wear', cons.length ? wear : null,
    cons.some((c, i) => !c?.optional && (estFlag(p, `consumables[${i}]`, c?.cost_eur) || isEstimated(c?.life_h))), force);
  updateWatt(force);
}

function applyFilament(id, force = true) {
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

function el(tag, props = {}, text) {
  const e = Object.assign(document.createElement(tag), props);
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildPrinterSelect() {
  const sel = $('#printer');
  const terms = normText($('#psearch').value).split(' ').filter(Boolean);
  const match = (p) => {
    const hay = normText(`${p.brand ?? ''} ${p.model ?? ''} ${p.name ?? ''}`);
    return terms.every((t) => hay.includes(t)) || p.id === state.printerId;
  };
  sel.replaceChildren(el('option', { value: '' }, '— scegli una stampante —'),
    el('option', { value: OTHER }, 'Altra stampante (stima dal modello)'));
  const curated = [], imported = [], vendors = new Map();
  for (const p of allPrinters().filter(match)) {
    if (p.user) imported.push(p);
    else if (p.source === 'prusaslicer') {
      if (!vendors.has(p.brand)) vendors.set(p.brand, []);
      vendors.get(p.brand).push(p);
    } else curated.push(p);
  }
  const group = (label, list, text) => {
    if (!list.length) return;
    const og = el('optgroup', { label });
    for (const p of list) og.append(el('option', { value: p.id }, text(p)));
    sel.append(og);
  };
  group('Catalogo curato (prezzi e consumi)', curated, printerLabel);
  group('Profili importati', imported, (p) => p.model);
  const names = [...vendors.keys()].sort((a, b) => (a === 'Prusa Research' ? -1 : b === 'Prusa Research' ? 1 : a.localeCompare(b)));
  for (const v of names) group(v, vendors.get(v).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))), (p) => p.name);
  sel.value = state.printerId;
}

function buildFilamentSelect() {
  const sel = $('#filament');
  const terms = normText($('#fsearch').value).split(' ').filter(Boolean);
  const match = (f) => {
    const hay = normText(`${f.name ?? ''} ${f.vendor ?? ''} ${f.material ?? ''}`);
    return terms.every((t) => hay.includes(t)) || f.id === state.filamentId;
  };
  sel.replaceChildren(el('option', { value: '' }, '— scegli un filamento —'));
  const groups = new Map();
  for (const f of allFilaments().filter(match)) {
    const g = String(f.material || 'Altro').toUpperCase();
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  const rank = (g) => (MATERIAL_ORDER.includes(g) ? MATERIAL_ORDER.indexOf(g) : 99);
  const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const g of keys) {
    const og = el('optgroup', { label: g });
    for (const f of groups.get(g).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))) {
      const price = unwrap(f.cost_eur_kg);
      og.append(el('option', { value: f.id }, `${f.name}${f.user ? ' (importato)' : ''}${price !== null ? ` · ${fmt(price)} €/kg` : ''}`));
    }
    sel.append(og);
  }
  sel.value = state.filamentId;
}

/* ---------- rendering ---------- */

function renderConsumables() {
  const p = printerById(state.printerId);
  const cons = Array.isArray(p?.consumables) ? p.consumables : [];
  const box = $('#cons');
  box.hidden = cons.length === 0;
  const body = $('#cons-body');
  body.replaceChildren();
  for (const c of cons) {
    const cost = unwrap(c?.cost_eur), life = unwrap(c?.life_h);
    const tr = el('tr');
    tr.append(
      el('td', {}, c?.name ?? 'Consumabile'),
      el('td', {}, cost !== null && life ? `${fmt(cost)} € / ${fmt(life, 0)} h${c.generic ? ' (generici, stimati)' : ''}` : 'dati incompleti'),
      el('td', {}, cost !== null && life ? `${fmt(cost / life, 3)} €/h` : '—'),
    );
    body.append(tr);
  }
}

function renderFields() {
  for (const box of document.querySelectorAll('.fld')) {
    const f = box.dataset.f;
    const input = $('input', box);
    const v = state.values[f];
    if (input.type === 'checkbox') input.checked = Boolean(Number(v));
    else if (document.activeElement !== input) input.value = v === undefined ? '' : v;
    const badge = $('.badge', box), reset = $('.reset', box);
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
  const e0 = (x) => fmt(x, 0);
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

const SEGMENTS = [
  ['material', 'Materiale'], ['energy', 'Energia'], ['amort', 'Ammortamento'], ['wear', 'Usura'], ['labor', 'Manodopera'],
];
const OPACITY = [1, 0.78, 0.58, 0.4, 0.24];

function renderResult() {
  const i = state.values;
  const r = compute(i);
  const detail = {
    material: `${fmt(i.grams || 0, 1)} g × ${fmt(i.eurKg || 0)} €/kg`,
    energy: `${fmt(r.kwh, 2)} kWh`,
    amort: '', wear: '', labor: `${fmt(i.laborMin || 0, 0)} min`,
  };
  const lines = $('#lines'), bar = $('#bar');
  lines.replaceChildren();
  bar.replaceChildren();
  SEGMENTS.forEach(([key, label], n) => {
    const dt = el('dt');
    dt.append(el('i', { style: `opacity:${OPACITY[n]}` }), label);
    if (detail[key]) dt.append(el('small', {}, detail[key]));
    const row = el('div');
    row.append(dt, el('dd', {}, eur(r.lines[key])));
    lines.append(row);
    if (r.subtotal > 0) bar.append(el('i', { style: `flex:${r.lines[key] / r.subtotal} 1 0;opacity:${OPACITY[n]}` }));
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

function renderParams() {
  const lines = paramLines(state.fileParams);
  $('#params').hidden = lines.length === 0;
  $('#params-list').replaceChildren(...lines.map((t) => el('li', {}, t)));
}

function refresh() {
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

function message(sel, lines, warn = false, replace = false) {
  const ul = $(sel);
  if (replace) ul.replaceChildren();
  for (const t of [].concat(lines)) ul.append(el('li', { className: warn ? 'warn' : '' }, t));
}

/* ---------- file G-code ---------- */

const norm = (s) => String(s ?? '').trim().toLowerCase();

function findPrinter(data) {
  const model = norm(data.printerModel);
  if (model) {
    const hit = allPrinters().find((p) => (p.prusaslicer_models ?? []).some((m) => norm(m) === model));
    if (hit) return hit;
  }
  const sid = norm(data.printerSettingsId);
  if (!sid) return null;
  return bestModelMatch(allPrinters(), sid);
}

function findFilament(data) {
  const name = norm(data.filamentName);
  return name ? allFilaments().find((f) => norm(f.name) === name) ?? null : null;
}

async function handleFile(file) {
  const ul = '#file-msg';
  message(ul, [], false, true);
  try {
    const magic = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
    let data, warnings = [];
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
    message(ul, `Impossibile leggere ${file.name}: ${e.message}`, true);
  }
  refresh();
}

/* ---------- profili utente ---------- */

async function handleProfiles(files) {
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
      message(ul, `${file.name}: ${e.message}`, true);
    }
  }
  saveProfiles(profiles);
  refresh();
}

/* ---------- eventi ---------- */

function onFieldInput(e) {
  const box = e.target.closest('.fld');
  if (!box) return;
  const f = box.dataset.f;
  const raw = e.target.value;
  state.values[f] = e.target.type === 'checkbox' ? Number(e.target.checked) : raw === '' ? '' : Number(raw);
  if (f === 'spoolPrice' || f === 'spoolG') {
    const per = pricePerKg(state.values.spoolPrice, state.values.spoolG);
    if (per !== null) state.values.eurKg = round(per);
  }
  refresh();
}

async function copyQuote() {
  const text = quoteText(state.values, compute(state.values), {
    printer: printerById(state.printerId) ? printerLabel(printerById(state.printerId)) : state.printerId === OTHER ? 'Altra stampante (stima dal modello)' : undefined,
    params: paramLines(state.fileParams),
    filament: filamentById(state.filamentId)?.name,
  });
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

function bind() {
  document.addEventListener('input', onFieldInput);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.reset');
    if (!btn) return;
    const f = btn.closest('.fld').dataset.f;
    if (f in state.auto) state.values[f] = state.auto[f];
    refresh();
  });
  $('#printer').addEventListener('change', (e) => { applyPrinter(e.target.value, true); refresh(); });
  $('#filament').addEventListener('change', (e) => { applyFilament(e.target.value, true); refresh(); });
  $('#fsearch').addEventListener('input', buildFilamentSelect);
  $('#psearch').addEventListener('input', buildPrinterSelect);
  $('#copy').addEventListener('click', copyQuote);
  $('#model-use').addEventListener('click', () => {
    const e = modelEstimate();
    if (e) { state.values.watt = Math.round(e.watts); refresh(); }
  });
  $('#file-ini').addEventListener('change', (e) => { handleProfiles([...e.target.files]); e.target.value = ''; });
  $('#clear-profiles').addEventListener('click', () => {
    profiles = { filaments: [], printers: [] };
    if (!printerById(state.printerId)) applyPrinter('', false);
    if (!filamentById(state.filamentId)) applyFilament('', false);
    saveProfiles(profiles);
    message('#prof-msg', 'Profili importati rimossi.', false, true);
    refresh();
  });

  const drop = $('#drop');
  const pick = $('#file-gcode');
  pick.addEventListener('change', () => { if (pick.files[0]) handleFile(pick.files[0]); pick.value = ''; });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  // evita che il browser apra il file se viene lasciato fuori dalla zona
  for (const t of ['dragover', 'drop']) window.addEventListener(t, (e) => e.preventDefault());
}

async function init() {
  modelDefaults();
  bind();
  refresh();
  const [curated, psPrinters, filaments] = await Promise.all([
    loadJson('data/printers.json', 'printers'),
    loadJson('data/printers-prusaslicer.json', 'printers'),
    loadJson('data/filaments.json', 'filaments'),
  ]);
  catalog = { printers: mergeCatalogs(curated, psPrinters), filaments };
  // Aggiorna i valori auto dai dati appena caricati; quelli modificati a mano restano.
  if (printerById(state.printerId)) applyPrinter(state.printerId, false);
  if (filamentById(state.filamentId)) applyFilament(state.filamentId, false);
  refresh();
}

init();
