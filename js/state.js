// Stato persistente in localStorage (tutte le operazioni protette da try/catch).
const KEY = 'openprintcalc.state.v1';
const PKEY = 'openprintcalc.profiles.v1';

export const defaults = () => ({
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

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function write(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota o privacy: si continua */ }
}

export function loadState() {
  const s = read(KEY);
  const d = defaults();
  if (!s || typeof s !== 'object') return d;
  return {
    ...d, ...s,
    values: { ...d.values, ...(s.values ?? {}) },
    auto: s.auto ?? {}, autoEst: s.autoEst ?? {}, autoSrc: s.autoSrc ?? {},
  };
}
export const saveState = (s) => write(KEY, s);

export function loadProfiles() {
  const p = read(PKEY);
  return {
    filaments: Array.isArray(p?.filaments) ? p.filaments : [],
    printers: Array.isArray(p?.printers) ? p.printers : [],
  };
}
export const saveProfiles = (p) => write(PKEY, p);
