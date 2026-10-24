# Formati di output degli slicer: statistiche G-code e 3MF

Verificato sul codice sorgente, 2026-10-24. Dove un dato non è stato verificato nel sorgente, è segnalato come **non verificato**.

## Fonti

- BambuStudio: https://github.com/bambulab/BambuStudio
  - `src/libslic3r/GCode.cpp` (header/config G-code)
  - `src/libslic3r/GCode/GCodeProcessor.cpp` (righe statistiche, sostituzione dei placeholder)
  - `src/libslic3r/Format/bbs_3mf.cpp` (`slice_info.config`, zip)
- OrcaSlicer: https://github.com/SoftFever/OrcaSlicer (stessi percorsi, `main`)
- PrusaSlicer: https://github.com/prusa3d/PrusaSlicer
  - `src/libslic3r/src/libslic3r/GCode/PostProcessor.cpp` (`format_statistics`)
  - `src/libpgcode/src/Slic3r/Biz/libpgcode/ProcessorConfig.cpp` (chiavi config lette)
  - `src/slic3r-shared/src/Slic3r/Biz/Format/3mf.cpp` (zip 3MF)
- CuraEngine: https://github.com/Ultimaker/CuraEngine (`src/gcode_export/gcodeExport.cpp`, `getFileHeader`)
- Wiki Bambu: non consultata in questa verifica.

Nota di metodo: i file sorgente sono grandi (400-660 KB). Sono stati scaricati e cercati con grep, non letti per intero via WebFetch. Il percorso PrusaSlicer `src/libslic3r/GCode.cpp` non esiste più sul ramo `master`, che ora usa `src/libslic3r/src/libslic3r/`.

## 1. PrusaSlicer (G-code)

Blocco statistiche, in fondo al file (`format_statistics`). Ogni riga termina con `\n`:

```
; filament used [mm] = <valori per estrusore, separati da ", ">
; filament used [cm3] = ...
; filament used [g] = ...
; filament cost = ...
; total filament used [g] = 12.34
; total filament cost = 0.56
; total filament used for wipe tower [g] = 1.23
; total toolchanges = 5                       (solo se > 0)
; estimated printing time (normal mode) = 1h 2m 3s
; estimated printing time (silent mode) = ... (solo se presente)
; estimated first layer printing time (normal mode) = ...
; estimated first layer printing time (silent mode) = ... (solo se presente)
```

- Tempo: formato `Utils::get_time_dhms`. L'esempio `1h 2m 3s` è quello indicato, non letto nel sorgente.
- Filamento per estrusore: `; filament used [g] = ` è CSV per estrusore. Il totale è `; total filament used [g] = `.
- Multicolore: spurgo/torre = `; total filament used for wipe tower [g] = ` (verificato). Cambi = `; total toolchanges = ` (verificato).
- Costo: `; filament cost = ` (per estrusore) e `; total filament cost = ` (verificati).
- Chiavi config lette per il calcolo: `filament_cost`, `filament_density`, `filament_type`, `filament_settings_id`, `nozzle_diameter`, `printer_model` (verificate in `ProcessorConfig.cpp` e `GCode.cpp`).
- Il blocco config `; chiave = valore` in fondo al file: il writer di PrusaSlicer non è stato verificato in questi sorgenti (**non verificato**).

## 2. BambuStudio e OrcaSlicer (G-code)

Le righe di statistica sono placeholder `;<tag riservato>` scritti in testa da `GCode.cpp` (righe 2395-2404), poi sostituiti da `GCodeProcessor` a fine slicing.

Righe emesse (verificate in `GCodeProcessor.cpp`):

```
; model printing time: 1h 2m 3s; total estimated time: 1h 5m 0s    (stampanti Bambu/BBL)
; estimated printing time (normal mode) = 1h 5m 0s                  (stampanti non BBL, Orca: anche "(<mode> mode)")
; estimated first layer printing time (<mode> mode) = ...           (Orca)
; total layer number: 120
; total filament weight [g] : 12.34,0.00                            (Bambu; per estrusore, %.2f, separati da ",")
; total filament volume [cm^3] : ...                                (Bambu)
; total filament length [mm] : ...                                  (Bambu e Orca)
; filament: 1,2                                                     (id dei filamenti usati)
; filament_density: 1.24,1.24                                        (serializzazione della config)
; filament_diameter: 1.75,1.75
; max_z_height: 25.00
```

- Tempo BBL: `model printing time` = `time - prepare_time`, `total estimated time` = `time`.
- Il formato di tempo è `get_time_dhms`, come in PrusaSlicer.
- Grammi totali: in Bambu esiste `; total filament weight [g] : ...` (per estrusore). In Orca questa chiave non compare in `GCodeProcessor.cpp` (verificato: solo il placeholder della lunghezza). **Non confermato per Orca in altra forma.**
- Le righe `; filament used [g] = `, `; filament used [mm] = `, `; filament cost = ` sono **commentate nel sorgente Bambu** (`GCode.cpp` righe 2180-2183). Non vanno cercate nel G-code di Bambu.
- Chiavi `total filament change`, `total tower weight`, `; flush`: nessuna riga di commento con questi nomi trovata in Bambu/Orca. Il flush è gestito con chiavi config (`flush_length`, `flush_length_%d`, `flush_volumetric_speeds`, `first_flush_volume`, `second_flush_volume`) e non come statistica in commento.
- Numero cambi: `total_toolchanges` è in `PrintStatistics` (`number_of_toolchanges`), non verificata come riga di commento.
- Config: `GCode::append_full_config` (riga 5950) scrive `; <chiave> = <valore>` per ogni chiave non nulla e non bannata. Quindi si trovano `; printer_model = ...`, `; filament_type = ...`, `; filament_settings_id = ...`, `; nozzle_diameter = ...`, `; temperature = ...`, `; filament_density = ...`, `; filament_cost = ...` (la serializzazione è `opt_serialize`, non ispezionata nel dettaglio).

Costo (non emesso in commento). Dal sorgente Bambu `GCode.cpp` (righe 2187-2196):

```
volume_mm3 = extruded_volume
g          = volume_mm3 * filament_density * 0.001
cost       = g * filament_cost * 0.001        (filament_cost in unità/kg)
```

## 3. CuraEngine (G-code)

Da `gcodeExport.cpp`, `getFileHeader`, caso `default` (flavor Marlin/RepRap):

```
;FLAVOR:<flavor>
;TIME:3600                       (secondi, intero)
;Filament used: 2.42m, 0.10m     (metri, per estrusore, separati da ", ")
;Layer height: 0.2
;MINX:...
```

- Flavor `MARLIN_VOLUMATRIC`: `;Filament used: <n>mm3` (volume, non metri).
- Flavor `ULTIGCODE`: `;MATERIAL:<n>`, `;MATERIAL2:<n>`, `;NOZZLE_DIAMETER:<d>`. Unità non determinate nel sorgente.
- Altro ramo di header: `;PRINT.TIME:<s>`, `;PRINT.GROUPS:<n>`, `;EXTRUDER_TRAIN.<n>.MATERIAL.VOLUME_USED:<int>`.
- Grammi: non scritti da Cura. Calcolo da `;Filament used` (metri) con diametro (`material_diameter`) e densità (non nel G-code):

```
mm  = metri * 1000
mm3 = mm * π * (d/2)²          (d = material_diameter, es. 1.75)
g   = mm3 / 1000 * densità     (densità in g/cm³, es. PLA 1.24)
```

Esempio: 2.42 m, 1.75 mm, PLA 1.24 → 2420 mm × 2.4053 mm² = 5821 mm³ = 5.82 cm³ × 1.24 = **7.22 g**.

- Costo: non emesso. Calcolare da grammi e prezzo al kg.
- Diametro: `setFilamentDiameter` lo imposta in memoria, non lo scrive in header.
- Tipo filamento, nome profilo, modello stampante: **non emessi** dal ramo di header letto. I custom start G-code possono scriverli, ma non sono verificati.
- Ugello, temperature: nessuna riga di commento in header nel ramo `default`. Le temperature sono nei comandi M104/M109.
- Multicolore: `;Filament used` e `;EXTRUDER_TRAIN` riportano più valori per estrusore. Torre di spurgo e cambi: non analizzati in questa verifica (**non verificato**).

## 4. 3MF `.gcode.3mf` (Bambu/Orca)

Verificato in `bbs_3mf.cpp`:

- `Metadata/plate_N.gcode` (N = indice piatto + 1). Il G-code è nello zip.
- `Metadata/plate_N.png`, `Metadata/plate_no_light_N.png`, `Metadata/plate_1.png`, `Metadata/bbl_thumbnail.png`.
- `Metadata/plate_N.gcode.md5`.
- `Metadata/slice_info.config` (XML):
  - `<config>` → `<header>` con `X-BBL-Client-Type` e `X-BBL-Client-Version`.
  - Per piatto, `<plate>` con `<metadata key=... value=.../>`:
    - `index`
    - `printer_model_id`
    - `nozzle_diameters`
    - `prediction` (tempo di stampa)
    - `weight` (grammi totali)
    - `filament_map`
    - `first_layer_time`, `pause_printing` count, ecc.
  - Per filamento, `<filament id=... tray_info_idx=... type=... color=... used_m=... used_g=... nozzle_diameter=... used_for_object=... used_for_support=... total_load_time=... total_unload_time=.../>`.
    - `id` = indice estrusore + 1
    - `used_m`, `used_g` (costanti `used_m`/`used_g` verificate)
    - `type` e `nozzle_diameter` (nomi di tag non letti direttamente)
- Unità di `prediction`: **non verificata** (ipotesi: secondi).
- `Metadata/plate_1.json`: **non trovato nel sorgente letto** (non verificato).
- Compressione: `_add_gcode_file_to_archive` usa `MZ_DEFAULT_LEVEL` (deflate, metodo 8). Con `nocomp` usa `MZ_NO_COMPRESSION` (store, metodo 0). Quindi deflate-raw o store, compatibile con `DecompressionStream('deflate-raw')`.

## 5. 3MF progetto PrusaSlicer

Nessun G-code nello zip. Entry verificate in `slic3r-shared/.../3mf.cpp`:

- `Metadata/thumbnail.png`
- `3D/3dmodel.model` (standard 3MF) e `3D/Metadata/BuildTicket.mbt` (NX)
- `Metadata/Slic3r_facets_annotation.json` (citato in `Model3mf.cpp`)
- `Metadata/Slic3r_PE.config` (configurazione): **non confermato nei sorgenti letti**.
- Compressione: `MZ_DEFAULT_COMPRESSION` / `MZ_DEFAULT_LEVEL` (deflate, metodo 8).

## 6. Lettura zip nel browser

Verificato: entry con metodo 8 (deflate) o 0 (store). Usare il central directory per dimensioni e offset, non le local header: con il bit 3 (data descriptor) le dimensioni nella local header possono essere 0.

- EOCD: firma `0x06054b50`, cerca dalla fine del file.
- Central directory entry: firma `0x02014b50`. Metodo a offset 10, dimensione compressa a 20, non compressa a 24, nome a 46.
- Local header: firma `0x04034b50`. Dati a offset 30 + lunghezza nome + lunghezza extra.
- Estrazione: metodo 8 → `new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw')))`; metodo 0 → bytes grezzi.

## Sintesi

1. PrusaSlicer: `; total filament used [g] = `, `; total filament used for wipe tower [g] = `, `; total toolchanges = `, `; estimated printing time (normal mode) = ` (verificati).
2. Bambu/Orca: `; model printing time: X; total estimated time: Y` e `; total filament weight [g] : ...` (solo Bambu); le righe `; filament used [g]` sono commentate.
3. Cura: `;TIME:<s>` e `;Filament used: <m>m`; grammi da diametro e densità.
4. Costo: nessuno slicer lo emette come riga in Cura; in Prusa sì (`; total filament cost = `); in Bambu è calcolato in memoria.
5. Bambu/Orca `.gcode.3mf`: `Metadata/plate_N.gcode` e `Metadata/slice_info.config` con `<filament used_g used_m>` e `<metadata key="prediction"/"weight">`.
6. Prusa `.3mf`: nessun G-code; configurazione in `Metadata/Slic3r_PE.config` non verificata.
7. Zip: deflate (metodo 8) o store (0), leggibile con `DecompressionStream('deflate-raw')`.
