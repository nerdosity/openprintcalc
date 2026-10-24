// Stato persistente in localStorage (tutte le operazioni protette da try/catch).
import type { AdvancedSettings, AmortSettings, AutoSrc, CustomBand, DayKind, LineWidth, EnergyMode, EnergySettings, Platform, SaleSettings, FieldValue, Filament, PrintParams, Printer, Profiles, Settings, State, Tech } from './types.ts';

const KEY = 'openprintcalc.state.v1';
const PKEY = 'openprintcalc.profiles.v1';

export const defaultSettings = (): Settings => ({
  general: { lang: 'auto', currency: '€', businessName: '', notes: '', validityDays: 30 },
  energy: { enabled: false, mode: 'tri', f1: 0.3, f2: 0.28, f3: 0.24, f23: 0.26, bands: [] },
  amortization: { enabled: false, price: 0, residual: 0, years: 4, hoursPerYear: 500, maintenance: 0 },
  sale: { enabled: false, vatPct: 22, platform: 'none', feePct: 0, feeFixed: 0, packaging: 0, shipping: 0, postMin: 0 },
  advanced: { enabled: false, ipaMl: 50, ipaEurL: 4 },
});

export const defaults = (): State => ({
  settings: defaultSettings(),
  tech: 'fdm',
  printerId: '',
  slaPrinterId: '',
  resinId: '',
  filamentId: '',
  values: { energyRate: 0.25, laborRate: 15, laborMin: 0, pieces: 1, failPct: 5, markupPct: 30 },
  auto: {},      // valore precompilato per campo (serve a badge e reset)
  autoSrc: {},   // origine del valore auto dei campi modello: 'catalog' | 'gcode' | 'default'
  autoEst: {},   // campi il cui valore automatico e' una stima
  fileName: '',
  jobName: '',
  fileParams: null, // parametri di stampa dal G-code (solo informativi)
  fileMaterial: '', // filament_type dal G-code, usato se il filamento non e' in catalogo
  fileToolChanges: 0,
  startAt: '',      // avvio stampa (scheda Energia), vuoto = adesso
});

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch { return null; }
}
function write(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota o privacy: si continua */ }
}

/** Copia solo le voci che superano la guardia `ok`. */
function pick<T>(src: unknown, ok: (v: unknown) => v is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (isRecord(src)) for (const [k, v] of Object.entries(src)) if (ok(v)) out[k] = v;
  return out;
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isAmount = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1e9;
const isFieldValue = (v: unknown): v is FieldValue => v === '' || isAmount(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isAutoSrc = (v: unknown): v is AutoSrc => v === 'catalog' || v === 'gcode' || v === 'default';

/** Migrazione: uno stato salvato prima delle Impostazioni non ha `settings`; i campi invalidi tornano al default. */
export function loadSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isRecord(raw)) return d;
  const g = isRecord(raw.general) ? raw.general : {};
  const sect = (k: 'energy' | 'amortization' | 'sale' | 'advanced'): Record<string, unknown> => {
    const o = raw[k];
    return isRecord(o) ? o : {};
  };
  const on = (k: 'energy' | 'amortization' | 'sale' | 'advanced'): { enabled: boolean } => {
    const o = sect(k);
    return { enabled: typeof o.enabled === 'boolean' ? o.enabled : d[k].enabled };
  };
  const num = (v: unknown, def: number, max = 1e9): number => (isNum(v) && v >= 0 && v <= max ? v : def);
  const e = sect('energy'), a = sect('amortization'), s = sect('sale'), adv = sect('advanced');
  const modes: readonly EnergyMode[] = ['tri', 'bi', 'custom'];
  const days: readonly DayKind[] = ['weekday', 'sat', 'sun'];
  const platforms: readonly Platform[] = ['none', 'etsy', 'shopify', 'paypal', 'stripe', 'custom'];
  const bands: CustomBand[] = Array.isArray(e.bands) ? e.bands.filter(isRecord).slice(0, 12).map((b) => ({
    name: typeof b.name === 'string' ? b.name.slice(0, 20) : '',
    day: days.find((x) => x === b.day) ?? 'weekday',
    from: Math.floor(num(b.from, 0, 24)), to: Math.floor(num(b.to, 0, 24)), price: num(b.price, 0),
  })) : [];
  const energy: EnergySettings = {
    ...on('energy'), mode: modes.find((x) => x === e.mode) ?? d.energy.mode,
    f1: num(e.f1, d.energy.f1), f2: num(e.f2, d.energy.f2), f3: num(e.f3, d.energy.f3), f23: num(e.f23, d.energy.f23), bands,
  };
  const amortization: AmortSettings = {
    ...on('amortization'), price: num(a.price, d.amortization.price), residual: num(a.residual, d.amortization.residual),
    years: num(a.years, d.amortization.years), hoursPerYear: num(a.hoursPerYear, d.amortization.hoursPerYear),
    maintenance: num(a.maintenance, d.amortization.maintenance),
  };
  const sale: SaleSettings = {
    ...on('sale'), vatPct: num(s.vatPct, d.sale.vatPct, 100), platform: platforms.find((x) => x === s.platform) ?? d.sale.platform,
    feePct: num(s.feePct, d.sale.feePct, 95), feeFixed: num(s.feeFixed, d.sale.feeFixed),
    packaging: num(s.packaging, d.sale.packaging), shipping: num(s.shipping, d.sale.shipping), postMin: num(s.postMin, d.sale.postMin),
  };
  return {
    general: {
      lang: g.lang === 'it' || g.lang === 'en' || g.lang === 'auto' ? g.lang : d.general.lang,
      currency: typeof g.currency === 'string' && g.currency.trim() ? g.currency.trim().slice(0, 4) : d.general.currency,
      businessName: typeof g.businessName === 'string' ? g.businessName : d.general.businessName,
      notes: typeof g.notes === 'string' ? g.notes : d.general.notes,
      validityDays: isNum(g.validityDays) && g.validityDays >= 1 && g.validityDays <= 365 ? Math.round(g.validityDays) : d.general.validityDays,
    },
    energy, amortization, sale,
    advanced: { ...on('advanced'), ipaMl: num(adv.ipaMl, d.advanced.ipaMl), ipaEurL: num(adv.ipaEurL, d.advanced.ipaEurL) } satisfies AdvancedSettings,
  };
}

const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : isNum(v) ? v : undefined);

function parseLineWidth(v: unknown): LineWidth | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'auto') return { kind: 'auto' };
  if (v.kind === 'mm' && isNum(v.mm)) return { kind: 'mm', mm: v.mm };
  if (v.kind === 'pct' && isNum(v.pct)) {
    const mm = v.mm === null ? null : isNum(v.mm) ? v.mm : undefined;
    if (mm !== undefined) return { kind: 'pct', pct: v.pct, mm };
  }
  return null;
}

/** Parametri di stampa dal G-code: ogni campo e' validato, forma non valida = null. */
function parseFileParams(p: unknown): PrintParams | null {
  if (!isRecord(p) || !isRecord(p.widths)) return null;
  const perimeters = numOrNull(p.perimeters), top = numOrNull(p.topSolidLayers), bottom = numOrNull(p.bottomSolidLayers), layer = numOrNull(p.layerHeight);
  if (perimeters === undefined || top === undefined || bottom === undefined || layer === undefined) return null;
  if (p.fillDensity !== null && typeof p.fillDensity !== 'string') return null;
  const widths: Record<string, LineWidth> = {};
  for (const [k, w] of Object.entries(p.widths)) {
    const lw = parseLineWidth(w);
    if (!lw) return null;
    widths[k] = lw;
  }
  return { perimeters, topSolidLayers: top, bottomSolidLayers: bottom, fillDensity: p.fillDensity === null ? null : p.fillDensity.slice(0, 40), layerHeight: layer, widths };
}

/** Stato da un oggetto grezzo (localStorage o link condiviso): ogni campo e' validato, i mancanti tornano al default. */
export function parseState(s: unknown): State {
  const d = defaults();
  if (!isRecord(s)) return d;
  return {
    settings: loadSettings(s.settings),
    tech: (s.tech === 'sla' ? 'sla' : 'fdm') satisfies Tech,
    printerId: typeof s.printerId === 'string' ? s.printerId : d.printerId,
    slaPrinterId: typeof s.slaPrinterId === 'string' ? s.slaPrinterId : d.slaPrinterId,
    resinId: typeof s.resinId === 'string' ? s.resinId : d.resinId,
    filamentId: typeof s.filamentId === 'string' ? s.filamentId : d.filamentId,
    values: { ...d.values, ...pick(s.values, isFieldValue) },
    auto: pick(s.auto, isAmount),
    autoEst: pick(s.autoEst, isBool),
    autoSrc: pick(s.autoSrc, isAutoSrc),
    fileName: typeof s.fileName === 'string' ? s.fileName : d.fileName,
    jobName: typeof s.jobName === 'string' ? s.jobName.slice(0, 80) : d.jobName,
    fileParams: parseFileParams(s.fileParams),
    fileMaterial: typeof s.fileMaterial === 'string' ? s.fileMaterial : d.fileMaterial,
    fileToolChanges: isNum(s.fileToolChanges) && s.fileToolChanges >= 0 ? Math.round(s.fileToolChanges) : 0,
    startAt: typeof s.startAt === 'string' ? s.startAt : d.startAt,
  };
}
export const loadState = (): State => ({ ...parseState(read(KEY)), startAt: '' }); // l'avvio stampa non e' persistito
export const saveState = (s: State): void => write(KEY, s);

const hasId = (x: unknown): x is Record<string, unknown> & { id: string } =>
  isRecord(x) && typeof x.id === 'string';

export function loadProfiles(): Profiles {
  const p = read(PKEY);
  const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter(hasId) : []);
  // i profili sono scritti solo da importProfiles: dopo la guardia su `id` ci si fida della forma
  return {
    filaments: isRecord(p) ? (list(p.filaments) as unknown as Filament[]) : [],
    printers: isRecord(p) ? (list(p.printers) as unknown as Printer[]) : [],
  };
}
export const saveProfiles = (p: Profiles): void => write(PKEY, p);
