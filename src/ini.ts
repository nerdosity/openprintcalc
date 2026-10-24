// Parser per i file .ini dei profili PrusaSlicer.
// Modulo ES senza dipendenze: usabile sia in Node sia nel browser.
import type { IniSections, KV } from './types.ts';

const SECTION_RE = /^\[([^\]]+)\]$/;
const TYPE_PREFIX_RE = /^([a-z_]+:)/;

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Parsa il testo di un file .ini PrusaSlicer.
 * @returns sezioni (nome -> chiavi/valori), nell'ordine del file
 */
export function parseIni(text: string): IniSections {
  const sections: IniSections = {};
  let current: KV | null = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      const name = (sectionMatch[1] ?? '').trim();
      if (!hasOwn(sections, name)) sections[name] = {};
      current = sections[name] ?? null;
      continue;
    }

    if (current === null) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
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
 * @returns nuove sezioni con valori ereditati, senza la chiave `inherits`
 */
export function resolveInherits(sections: IniSections): IniSections {
  const resolved: IniSections = {};
  const visiting = new Set<string>();

  function findParent(parentName: string, childName: string): string | null {
    const prefix = TYPE_PREFIX_RE.exec(childName)?.[1] ?? '';
    for (const candidate of [prefix + parentName, parentName]) {
      if (hasOwn(sections, candidate)) return candidate;
    }
    return null;
  }

  function resolve(name: string): KV {
    const done = resolved[name];
    if (done !== undefined) return done;
    if (visiting.has(name)) throw new Error(`Ereditarieta' circolare su "${name}"`);
    visiting.add(name);

    const own = sections[name] ?? {};
    const parents = String(own.inherits ?? '')
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);

    const values: KV = {};
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
