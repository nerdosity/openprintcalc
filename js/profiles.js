// Import dei profili utente PrusaSlicer (.ini in %APPDATA%/PrusaSlicer/filament e /printer).
import { parseIni, resolveInherits } from './ini.js';

const firstVal = (v) => String(v ?? '').split(/[;,]/)[0].trim();
const numOrNull = (v) => {
  const x = parseFloat(firstVal(v));
  return Number.isFinite(x) && x > 0 ? x : null;
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Hash corto (djb2, base36) per distinguere nomi che danno lo stesso slug. */
const shortHash = (s) => {
  let h = 5381;
  for (const ch of String(s)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36).slice(0, 6);
};
const profileId = (name) => `user-${slug(name)}-${shortHash(name)}`;

/** I file utente non hanno intestazione di sezione: la aggiungo dal nome file. */
function withSection(text, fileName) {
  if (/^\s*\[/m.test(text)) return text;
  const kind = /\bfilament_type\b|\bfilament_cost\b/.test(text) ? 'filament'
    : /\bprinter_model\b|\bbed_shape\b/.test(text) ? 'printer' : null;
  if (!kind) return text;
  const name = String(fileName).replace(/\.ini$/i, '');
  return `[${kind}:${name}]\n${text}`;
}

/**
 * @returns {{filaments: object[], printers: object[]}} profili normalizzati (campi mancanti = null)
 */
export function importProfiles(text, fileName = 'profilo') {
  const sections = resolveInherits(parseIni(withSection(text, fileName)));
  const out = { filaments: [], printers: [] };

  for (const [section, v] of Object.entries(sections)) {
    const m = /^(filament|printer):(.+)$/.exec(section);
    if (!m || m[2].startsWith('*')) continue;
    const name = m[2].trim();
    if (m[1] === 'filament') {
      out.filaments.push({
        id: profileId(name),
        name,
        vendor: v.filament_vendor && v.filament_vendor !== 'nil' ? v.filament_vendor : 'Profili utente',
        material: firstVal(v.filament_type) || 'Altro',
        cost_eur_kg: numOrNull(v.filament_cost),
        density_g_cm3: numOrNull(v.filament_density),
        spool_tare_g: numOrNull(v.filament_spool_weight),
        diameter_mm: numOrNull(v.filament_diameter),
        printers: [],
        user: true,
      });
    } else {
      out.printers.push({
        id: profileId(name),
        brand: 'Profili utente',
        model: name,
        price_eur: null,
        power_w: null,
        lifetime_h: null,
        consumables: [],
        prusaslicer_models: v.printer_model ? [v.printer_model] : [],
        estimated: [],
        notes: 'Profilo importato: inserisci potenza e costi a mano.',
        sources: [],
        user: true,
      });
    }
  }
  return out;
}

/** Unisce profili per id (i nuovi sostituiscono i vecchi). */
export function mergeProfiles(current, incoming) {
  const merge = (a, b) => [...new Map([...a, ...b].map((p) => [p.id, p])).values()];
  return {
    filaments: merge(current.filaments, incoming.filaments),
    printers: merge(current.printers, incoming.printers),
  };
}
