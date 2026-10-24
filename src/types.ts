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
  /** stampanti SLA: potenza media in stampa */
  printing?: Wrapped | null;
}

export interface Consumable {
  name: string;
  cost_eur?: Wrapped | null;
  life_h?: Wrapped | null;
  /** SLA: vita in numero di stampe (es. pellicola FEP) */
  life_prints?: Wrapped | null;
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
  /** nomi alternativi (es. printer_model di Bambu/Orca) per il riconoscimento da file */
  aliases?: readonly string[];
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

/** Schede delle Impostazioni oltre a Generale: ognuna ha un interruttore `enabled` (fasi successive). */
export type SettingsTab = 'general' | 'energy' | 'amortization' | 'sale' | 'advanced';
export type FutureTab = Exclude<SettingsTab, 'general'>;

export interface Settings {
  general: {
    /** 'auto' = lingua del browser */
    lang: 'auto' | 'it' | 'en';
    /** simbolo mostrato al posto di € */
    currency: string;
    businessName: string;
    notes: string;
    /** giorni di validita' del preventivo nel link cliente */
    validityDays: number;
  };
  energy: EnergySettings;
  amortization: AmortSettings;
  sale: SaleSettings;
  advanced: AdvancedSettings;
}

/** Lavaggio IPA della modalita' resina: ml per stampa e prezzo al litro. */
export type AdvancedSettings = { enabled: boolean; ipaMl: number; ipaEurL: number };

export type DayKind = 'weekday' | 'sat' | 'sun';
export type EnergyMode = 'tri' | 'bi' | 'custom';
/** Fascia personalizzata: ore intere 0-24, da > a = a cavallo di mezzanotte; i festivi contano come domenica. */
export type CustomBand = { name: string; day: DayKind; from: number; to: number; price: number };
export type EnergySettings = {
  enabled: boolean; mode: EnergyMode; f1: number; f2: number; f3: number; f23: number; bands: CustomBand[];
};
export type AmortSettings = {
  enabled: boolean; price: number; residual: number; years: number; hoursPerYear: number; maintenance: number;
};
export type Platform = 'none' | 'etsy' | 'shopify' | 'paypal' | 'stripe' | 'custom';
export type SaleSettings = {
  enabled: boolean; vatPct: number; platform: Platform; feePct: number; feeFixed: number;
  packaging: number; shipping: number; postMin: number;
};

/** Costo macchina e vita utile ricavati dalla scheda Ammortamento (null = dati insufficienti). */
export interface AmortInputs { machineCost: number | null; lifeH: number | null }

export interface SaleResult { base: number; fees: number; shipping: number; vat: number; customer: number }

/** Dati opzionali delle schede attive passati a compute(). */
export interface ComputeExtras {
  /** ore totali della serie di pezzi per fascia (diviso i pezzi = per pezzo) */
  bandHours?: Record<string, number>;
  bandPrice?: Record<string, number>;
  /** post-produzione, minuti per pezzo (entra nella manodopera) */
  postMin?: number;
}

export type Tech = 'fdm' | 'sla';

export interface State {
  settings: Settings;
  /** tecnologia: filamento (FDM) o resina (SLA) */
  tech: Tech;
  printerId: string;
  slaPrinterId: string;
  resinId: string;
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
  /** nome del lavoro (opzionale), precompilato dal nome del file G-code */
  jobName: string;
  /** parametri di stampa dal G-code (solo informativi) */
  fileParams: PrintParams | null;
  /** filament_type dal G-code, usato se il filamento non e' in catalogo */
  fileMaterial: string;
  /** cambi filamento dal file (tooltip dello scarto), 0 se ignoti */
  fileToolChanges: number;
  /** avvio stampa (datetime-local) con la scheda Energia attiva; vuoto = adesso. Non persistito. */
  startAt: string;
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

/** Campi di compute() condivisi con il testo del preventivo (grams per FDM, ml per SLA). */
export type QuoteInput = Partial<Record<'grams' | 'ml' | 'hours' | 'failPct' | 'markupPct', FieldValue | null>>;

export type SlaKey =
  | 'pieces' | 'failPct' | 'hours' | 'watt' | 'ml' | 'eurL' | 'ipaMl' | 'ipaEurL' | 'energyRate'
  | 'machineCost' | 'lifeH' | 'wearPrint' | 'wearH' | 'laborMin' | 'laborRate' | 'markupPct';

export type SlaInput = Partial<Record<SlaKey, FieldValue | null>>;

export type ComputeKey =
  | 'pieces' | 'failPct' | 'hours' | 'watt' | 'grams' | 'eurKg' | 'energyRate'
  | 'machineCost' | 'lifeH' | 'wear' | 'laborMin' | 'laborRate' | 'markupPct' | 'wasteG';

export type ComputeInput = Partial<Record<ComputeKey, FieldValue | null>>;

export type CostLine = 'material' | 'waste' | 'energy' | 'amort' | 'wear' | 'labor' | 'wash';

export interface ComputeResult {
  pieces: number;
  factor: number;
  kwh: number;
  lines: Record<CostLine, number>;
  subtotal: number;
  margin: number;
  price: number;
  total: number;
  /** ore totali per fascia, solo con la scheda Energia attiva */
  bands?: Record<string, number>;
}

export interface QuoteContext {
  business?: string;
  notes?: string;
  printer?: string;
  filament?: string;
  params?: readonly string[];
  sale?: SaleResult;
  vatPct?: number;
  /** modalita' resina: il materiale e' in ml di resina */
  resin?: boolean;
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

export interface BgcodeExtra {
  perExtruderGrams: number[];
  wasteGrams: number | null;
  toolChanges: number | null;
}

export interface BgcodeResult {
  data: GcodeData;
  warnings: string[];
  extra: BgcodeExtra;
}

/* ---------- INI ---------- */

export type IniSections = Record<string, KV>;

/* ---------- data/resins.json ---------- */

export interface Resin {
  id: string;
  name: string;
  vendor: string;
  type: string;
  density_g_cm3: number | null;
  /** codici modello PrusaSlicer compatibili */
  printers: string[];
}

export interface ResinsFile {
  generated: string;
  sources: string[];
  resins: Resin[];
}

/** Prezzo curato a mano: `match` e' una regex applicata a "vendor name". */
export interface ResinPrice {
  match: string;
  price_eur_l: number;
  source: string;
  /** prezzo stimato da una regola, non rilevato: la UI mostra "auto ≈" */
  estimated?: boolean;
}
