// Unione del catalogo curato con le voci PrusaSlicer (logica pura, niente DOM).

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Trasforma una voce di printers-prusaslicer.json in una voce compatibile con il catalogo curato. */
export function normalizePs(e) {
  const nozzles = Array.isArray(e.nozzles_mm) ? e.nozzles_mm.filter((x) => Number.isFinite(Number(x))) : [];
  return {
    id: e.id, brand: e.vendor, model: e.model, name: e.name ?? `${e.vendor} ${e.model}`,
    source: 'prusaslicer',
    bed_mm: Array.isArray(e.bed_mm) && e.bed_mm.length >= 2 ? e.bed_mm : null,
    enclosed: false,
    nozzle_mm: nozzles.includes(0.4) ? 0.4 : nozzles[0] ?? null,
    price_eur: null,
    lifetime_h: { value: 4000, estimated: true },
    power_w: { idle: 10 },
    watt_from_model: true,
    consumables: [
      { name: 'Ugello (generico)', cost_eur: { value: 10, estimated: true }, life_h: { value: 500, estimated: true }, generic: true },
      { name: 'Piastra (generica)', cost_eur: { value: 30, estimated: true }, life_h: { value: 2000, estimated: true }, generic: true },
    ],
    prusaslicer_models: Array.isArray(e.prusaslicer_models) ? e.prusaslicer_models : [],
  };
}

/** Curate + voci PrusaSlicer il cui prusaslicer_models non coincide con quello di una curata. */
export function mergeCatalogs(curated, psEntries) {
  const known = new Set(curated.flatMap((p) => (p.prusaslicer_models ?? []).map(norm)));
  const ids = new Set(curated.map((p) => p.id));
  const extra = psEntries
    .filter((e) => !ids.has(e.id) && !(e.prusaslicer_models ?? []).some((m) => known.has(norm(m))))
    .map(normalizePs);
  return [...curated, ...extra];
}

/** Stampante il cui model/name e' la sottostringa piu lunga (>= 3 car.) contenuta in printer_settings_id. */
export function bestModelMatch(printers, settingsId) {
  const sid = norm(settingsId);
  if (!sid) return null;
  let best = null, bestLen = 0;
  for (const p of printers) {
    for (const s of [p.model, p.name]) {
      const m = norm(s);
      if (m.length >= 3 && m.length > bestLen && sid.includes(m)) { best = p; bestLen = m.length; }
    }
  }
  return best;
}
