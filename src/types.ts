// Tipi condivisi: formato dei file in data/, stato dell'app e risultati dei calcoli/parser.

/** Numero grezzo oppure {value, estimated}: i dati curati marcano le stime in questo modo. */
export type Wrapped<T = number> = T | { value: T | null; estimated?: boolean };

/** Chiave/valore dei commenti G-code o delle sezioni INI. */
export type KV = Record<string, string>;

/* ---------- data/printers.json ---------- */

export interface PowerW {
  idle?: Wrapped | null;
  avg_pla?: Wrapped | null;
  avg_high_temp?: Wrapped | null;
  /** nome storico di avg_high_temp */
  avg_abs_enclosed_or_high_temp?: Wrapped | null;
  peak?: Wrapped | null;
}

export interface Consumable {
  name: string;
  cost_eur?: Wrapped | null;
  life_h?: Wrapped | null;
  /** escluso dal calcolo dell'usura */
  optional?: boolean;
  /** voce generica aggiunta per le stampanti PrusaSlicer */
  generic?: boolean;
}

/** Stampante del catalogo curato, normalizzata da PrusaSlicer o importata da .ini. */
export interface Printer {
  id: string;
  brand?: string;
  model?: string;
  name?: string;
  source?: 'prusaslicer';
  kit?: boolean;
  bed_mm?: readonly Wrapped[] | null;
  enclosed?: boolean;
  nozzle_mm?: Wrapped | null;
  bed_heater_w?: Wrapped | null;
  hotend_heater_w?: Wrapped | null;
  price_eur?: Wrapped | null;
  power_w?: PowerW | null;
  lifetime_h?: Wrapped | null;
  consumables?: readonly Consumable[];
  prusaslicer_models?: readonly string[];
  notes?: string;
  sources?: readonly string[];
  /** percorsi dei campi stimati, es. "power_w.idle", "consumables[0].cost_eur" */
  estimated?: readonly string[];
  /** il consumo si ricava dal modello fisico invece che da avg_pla */
  watt_from_model?: boolean;
  /** profilo importato dall'utente */
  user?: boolean;
}

export interface PrintersFile {
  generated?: string;
  disclaimer?: string;
  printers: Printer[];
}

/* ---------- data/printers-prusaslicer.json ---------- */

export interface PsPrinter {
  id: string;
  vendor: string;
  model: string;
  name?: string;
  family?: string | null;
  bed_mm?: readonly number[] | null;
  max_z_mm?: number | null;
  nozzles_mm?: readonly number[];
  prusaslicer_models?: readonly string[];
}

export interface PsPrintersFile {
  generated: string;
  sources: string[];
  printers: PsPrinter[];
}

/* ---------- data/filaments.json ---------- */

export interface Filament {
  id: string;
  name: string;
  vendor?: string;
  material?: string;
  cost_eur_kg?: Wrapped | null;
  density_g_cm3?: Wrapped | null;
  spool_tare_g?: Wrapped | null;
  diameter_mm?: Wrapped | null;
  nozzle_temp_c?: Wrapped | null;
  bed_temp_c?: Wrapped | null;
  /** codici modello PrusaSlicer compatibili */
  printers?: readonly string[];
  user?: boolean;
}

export interface FilamentsFile {
  source: string;
  generated: string;
  filaments: Filament[];
}

export interface Catalog {
  printers: Printer[];
  filaments: Filament[];
}

export interface Profiles {
  filaments: Filament[];
  printers: Printer[];
}

/* ---------- stato ---------- */

export type FieldValue = number | '';
export type AutoSrc = 'catalog' | 'gcode' | 'default';

export interface State {
  printerId: string;
  filamentId: string;
  /** valori dei campi del form, per chiave del campo */
  values: Record<string, FieldValue>;
  /** valore precompilato per campo (serve a badge e reset) */
  auto: Record<string, number>;
  /** origine del valore auto dei campi modello */
  autoSrc: Record<string, AutoSrc>;
  /** campi il cui valore automatico e' una stima */
  autoEst: Record<string, boolean>;
  fileName: string;
  /** parametri di stampa dal G-code (solo informativi) */
  fileParams: PrintParams | null;
  /** filament_type dal G-code, usato se il filamento non e' in catalogo */
  fileMaterial: string;
}

/* ---------- calcoli ---------- */

export interface WattPick {
  value: number | null;
  estimated: boolean;
  key: 'power_w.avg_high_temp' | 'power_w.avg_pla';
}

export interface WattInput {
  bedX?: number | null;
  bedY?: number | null;
  bedTemp?: number | null;
  nozzleDiam?: number | null;
  nozzleTemp?: number | null;
  ambient?: number | null;
  enclosed?: boolean;
  bedHeaterW?: number | null;
  hotendHeaterW?: number | null;
  idleW?: number | null;
  densityGcm3?: number | null;
}

export interface WattEstimate {
  watts: number;
  bed: number;
  hotend: number;
  melt: number;
  base: number;
}

export type ComputeKey =
  | 'pieces' | 'failPct' | 'hours' | 'watt' | 'grams' | 'eurKg' | 'energyRate'
  | 'machineCost' | 'lifeH' | 'wear' | 'laborMin' | 'laborRate' | 'markupPct';

export type ComputeInput = Partial<Record<ComputeKey, FieldValue | null>>;

export type CostLine = 'material' | 'energy' | 'amort' | 'wear' | 'labor';

export interface ComputeResult {
  pieces: number;
  factor: number;
  kwh: number;
  lines: Record<CostLine, number>;
  subtotal: number;
  margin: number;
  price: number;
  total: number;
}

export interface QuoteContext {
  printer?: string;
  filament?: string;
  params?: readonly string[];
}

/* ---------- G-code ---------- */

export type LineWidth =
  | { kind: 'auto' }
  | { kind: 'mm'; mm: number }
  | { kind: 'pct'; pct: number; mm: number | null };

export interface PrintParams {
  perimeters: number | null;
  topSolidLayers: number | null;
  bottomSolidLayers: number | null;
  fillDensity: string | null;
  layerHeight: number | null;
  widths: Record<string, LineWidth>;
}

/** Dati che servono al calcolatore, estratti da un G-code o dai metadati di un .bgcode. */
export interface GcodeData {
  grams: number | null;
  hours: number | null;
  printerModel: string | null;
  printerSettingsId: string | null;
  filamentName: string | null;
  filamentType: string | null;
  density: number | null;
  filamentCost: number | null;
  nozzleTemp: number | null;
  bedTemp: number | null;
  nozzleDiameter: number | null;
  params: PrintParams | null;
}

export interface BgcodeResult {
  data: GcodeData;
  warnings: string[];
}

/* ---------- INI ---------- */

export type IniSections = Record<string, KV>;
