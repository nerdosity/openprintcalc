// Stato persistente in localStorage (tutte le operazioni protette da try/catch).
import type { AutoSrc, FieldValue, Filament, PrintParams, Printer, Profiles, State } from './types.ts';

const KEY = 'openprintcalc.state.v1';
const PKEY = 'openprintcalc.profiles.v1';

export const defaults = (): State => ({
  printerId: '',
  filamentId: '',
  values: { energyRate: 0.25, laborRate: 15, laborMin: 0, pieces: 1, failPct: 5, markupPct: 30 },
  auto: {},      // valore precompilato per campo (serve a badge e reset)
  autoSrc: {},   // origine del valore auto dei campi modello: 'catalog' | 'gcode' | 'default'
  autoEst: {},   // campi il cui valore automatico e' una stima
  fileName: '',
  fileParams: null, // parametri di stampa dal G-code (solo informativi)
  fileMaterial: '', // filament_type dal G-code, usato se il filamento non e' in catalogo
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
const isFieldValue = (v: unknown): v is FieldValue => v === '' || (typeof v === 'number' && Number.isFinite(v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isAutoSrc = (v: unknown): v is AutoSrc => v === 'catalog' || v === 'gcode' || v === 'default';

export function loadState(): State {
  const s = read(KEY);
  const d = defaults();
  if (!isRecord(s)) return d;
  return {
    printerId: typeof s.printerId === 'string' ? s.printerId : d.printerId,
    filamentId: typeof s.filamentId === 'string' ? s.filamentId : d.filamentId,
    values: { ...d.values, ...pick(s.values, isFieldValue) },
    auto: pick(s.auto, isNum),
    autoEst: pick(s.autoEst, isBool),
    autoSrc: pick(s.autoSrc, isAutoSrc),
    fileName: typeof s.fileName === 'string' ? s.fileName : d.fileName,
    // scritto solo da questa app: dopo la guardia sulla forma ci si fida del contenuto
    fileParams: isRecord(s.fileParams) && isRecord(s.fileParams.widths) ? (s.fileParams as unknown as PrintParams) : null,
    fileMaterial: typeof s.fileMaterial === 'string' ? s.fileMaterial : d.fileMaterial,
  };
}
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
