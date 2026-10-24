// Risultato unificato dei parser di file di stampa (G-code, bgcode, 3MF).
import type { Key } from '../i18n.ts';
import type { PrintParams } from '../types.ts';

export type SlicerId = 'prusaslicer' | 'orcaslicer' | 'bambustudio' | 'cura' | 'unknown';

/** Avviso del parser: chiave i18n + parametri, tradotto solo al momento della visualizzazione. */
export interface ParseWarning {
  key: Key;
  params?: Record<string, string | number>;
}

export interface ParsedPrint {
  slicer: SlicerId;
  grams: number | null;
  /** file SLA (.sl1): resina in ml */
  ml: number | null;
  hours: number | null;
  perExtruderGrams: number[];
  /** torre di spurgo / spurgo, in grammi */
  wasteGrams: number | null;
  toolChanges: number | null;
  /** true se wasteGrams e' una stima dalla matrice di flush e non un valore dello slicer */
  wasteEstimated: boolean;
  printerModel: string | null;
  printerSettingsId: string | null;
  filamentSettingsId: string | null;
  filamentType: string | null;
  filamentCost: number | null;
  filamentDensity: number | null;
  nozzleDiameter: number | null;
  nozzleTemp: number | null;
  bedTemp: number | null;
  params: PrintParams | null;
  warnings: ParseWarning[];
}

export function emptyPrint(slicer: SlicerId = 'unknown'): ParsedPrint {
  return {
    slicer, grams: null, ml: null, hours: null, perExtruderGrams: [], wasteGrams: null, toolChanges: null,
    wasteEstimated: false, printerModel: null, printerSettingsId: null, filamentSettingsId: null,
    filamentType: null, filamentCost: null, filamentDensity: null, nozzleDiameter: null,
    nozzleTemp: null, bedTemp: null, params: null, warnings: [],
  };
}
