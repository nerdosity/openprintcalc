// Parser per i file .ini dei profili PrusaSlicer.
// Modulo ES senza dipendenze: usabile sia in Node sia nel browser.

const SECTION_RE = /^\[([^\]]+)\]$/;
const TYPE_PREFIX_RE = /^([a-z_]+:)/;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Parsa il testo di un file .ini PrusaSlicer.
 * @param {string} text
 * @returns {Record<string, Record<string, string>>} sezioni (nome -> chiavi/valori), nell'ordine del file
 */
export function parseIni(text) {
  const sections = {};
  let current = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      if (!hasOwn(sections, current)) sections[current] = {};
      continue;
    }

    if (current === null) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    sections[current][key] = value;
  }

  return sections;
}

/**
 * Risolve l'ereditarieta' (`inherits = A; B`) delle sezioni restituite da parseIni.
 * - Il genitore nominato per primo ha la precedenza sugli altri.
 * - I valori della sezione stessa hanno sempre la precedenza sui genitori.
 * - Il nome del genitore viene cercato come `<prefisso tipo><nome>` (es. `filament:Prusament PLA`)
 *   e poi come nome esatto (es. template `*PLA*`).
 * - I genitori mancanti vengono ignorati; l'ereditarieta' circolare genera un errore.
 * @param {Record<string, Record<string, string>>} sections
 * @returns {Record<string, Record<string, string>>} nuove sezioni con valori ereditati, senza la chiave `inherits`
 */
export function resolveInherits(sections) {
  const resolved = {};
  const visiting = new Set();

  function findParent(parentName, childName) {
    const prefix = TYPE_PREFIX_RE.exec(childName)?.[1] ?? '';
    for (const candidate of [prefix + parentName, parentName]) {
      if (hasOwn(sections, candidate)) return candidate;
    }
    return null;
  }

  function resolve(name) {
    if (hasOwn(resolved, name)) return resolved[name];
    if (visiting.has(name)) throw new Error(`Ereditarieta' circolare su "${name}"`);
    visiting.add(name);

    const own = sections[name];
    const parents = String(own.inherits ?? '')
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);

    const values = {};
    // Applico dal genitore meno prioritario al piu' prioritario (il primo vince).
    for (const parent of [...parents].reverse()) {
      const parentName = findParent(parent, name);
      if (parentName === null) continue;
      Object.assign(values, resolve(parentName));
    }
    Object.assign(values, own);
    delete values.inherits;

    visiting.delete(name);
    resolved[name] = values;
    return values;
  }

  for (const name of Object.keys(sections)) resolve(name);
  return resolved;
}
