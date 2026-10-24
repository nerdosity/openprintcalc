# Formato G-code di PrusaSlicer (note per il calcolatore costi)

Fonti verificate (branch `master` / `main`, ottobre 2026):

- PrusaSlicer, statistiche: https://github.com/prusa3d/PrusaSlicer/blob/master/src/libslic3r/src/libslic3r/GCode/PostProcessor.cpp
- PrusaSlicer, formato tempo: https://github.com/prusa3d/PrusaSlicer/blob/master/src/slic3r-base/src/Slic3r/Time.cpp
- PrusaSlicer, blocco config: https://github.com/prusa3d/PrusaSlicer/blob/master/src/libslic3r/src/libslic3r/GCode.cpp
- PrusaSlicer, sample reale (2.9.0-alpha1): https://github.com/prusa3d/PrusaSlicer/blob/master/resources/test_data/test_vase.gcode
- PrusaSlicer, impostazioni bgcode: https://github.com/prusa3d/PrusaSlicer/blob/master/src/slic3r-shared/src/Slic3r/Biz/ResultExport/ResultExportDataFinalizer.cpp
- libbgcode, specifica: https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md
- libbgcode, conversione ASCII -> bgcode: https://github.com/prusa3d/libbgcode/blob/main/src/LibBGCode/convert/convert.cpp
- libbgcode, core (header blocchi): https://github.com/prusa3d/libbgcode/blob/main/src/LibBGCode/core/core.cpp
- libbgcode, binarizzazione e default: https://github.com/prusa3d/libbgcode/blob/main/src/LibBGCode/binarize/binarize.cpp e https://github.com/prusa3d/libbgcode/blob/main/src/LibBGCode/binarize/binarize.hpp

## 1. Commenti ASCII utili

Le statistiche sono in fondo al file, prima del blocco di configurazione (`format_statistics` in `PostProcessor.cpp`, inserite al posto del placeholder). Il blocco config sta dopo di esse, tra `; prusaslicer_config = begin` e `; prusaslicer_config = end`.

Per i valori multi-estrusore:
- Le statistiche per estrusore sono separate da `, ` (virgola e spazio), con 2 decimali (`{:.2f}`).
- Le impostazioni `filament_cost`, `filament_density`, `nozzle_diameter` sono separate da `,` senza spazi.
- Le impostazioni stringa (`filament_type`, `filament_settings_id`) sono separate da `;` e, per `filament_settings_id`, tra virgolette.

| Riga esatta | Dove | Formato |
|---|---|---|
| `; filament used [mm] = 676.57, 0.00, 0.00, 0.00, 0.00` | fine file, prima di config | per estrusore, `, `, 2 decimali |
| `; filament used [cm3] = 1.63, 0.00, ...` | fine file | per estrusore |
| `; filament used [g] = 1.76, 0.00, ...` | fine file | per estrusore |
| `; filament cost = 0.05, 0.00, ...` | fine file | per estrusore (costo, non grammi) |
| `; total filament used [g] = 1.76` | fine file | totale, 1 valore |
| `; total filament cost = 0.05` | fine file | totale (non richiesto, utile) |
| `; total filament used for wipe tower [g] = 0.00` | fine file | totale purge/wipe tower |
| `; estimated printing time (normal mode) = 17m 27s` | fine file | vedi formato sotto |
| `; estimated printing time (silent mode) = 17m 28s` | fine file | solo se la modalità silent è calcolata |

Formato tempo (`Utils::get_time_dhms`, `Time.cpp`): i componenti vuoti in testa vengono omessi.
- con giorni: `1d 2h 3m 4s` (il formato è sempre a quattro campi, non `1d` da solo)
- con ore: `2h 13m 5s`
- con minuti: `17m 27s`
- altrimenti: `45s`

Nota: il tempo è arrotondato al secondo, quindi per i calcoli conviene fare il parsing della stringa.

Config (`; chiave = valore`, dentro `; prusaslicer_config = begin`):

| Riga esatta (dal sample) | Multi-estrusore |
|---|---|
| `; printer_model = MK3MMU2` | valore singolo |
| `; printer_settings_id = Original Prusa i3 MK3 MMU2` | valore singolo |
| `; filament_settings_id = "Generic ABS @MMU";"Generic ABS @MMU";...` | `;`, con virgolette |
| `; filament_type = ABS;ABS;ABS;ABS;ABS` | `;` |
| `; nozzle_diameter = 0.4,0.4,0.4,0.4,0.4` | `,` |
| `; filament_density = 1.08,1.08,1.08,1.08,1.08` | `,` |
| `; filament_cost = 26.99,26.99,26.99,26.99,26.99` | `,` (non confondere con la riga stats `; filament cost`) |

Nel sample reale (2.9.0-alpha1) c'è solo il blocco INI `prusaslicer_config`. Il sorgente `master` scrive anche un blocco JSON `; prusaslicer_json_config = begin/end` (GCode.cpp), quindi il parser deve ignorarlo.

## 2. Formato binario .bgcode

- Magic: `GCDE` (4 byte, ASCII, primi byte del file).
- Header file (10 byte, little-endian): magic (uint32), versione (uint32, valore attuale `1`), tipo checksum (uint16, `0` = nessuno, `1` = CRC32).
- Ordine dei blocchi: File Metadata (opzionale), Printer Metadata, Thumbnail (opzionali), Print Metadata, Slicer Metadata, blocchi G-code.
- Tipi di blocco: `0` File Metadata, `1` GCode, `2` Slicer Metadata, `3` Printer Metadata, `4` Print Metadata, `5` Thumbnail.
- Header di blocco: `type` (uint16), `compression` (uint16), `uncompressed size` (uint32), `compressed size` (uint32, presente solo se compression != 0). Quindi 8 byte senza compressione, 12 byte con compressione.
- Struttura blocco: header, parametri, dati, checksum (4 byte CRC32, se attivo nell'header file).
- Parametri: metadata `Encoding` (uint16, `0` = INI). Thumbnail `Format`/`Width`/`Height`. GCode `Encoding` (uint16: `0` nessuna, `1` MeatPack, `2` MeatPack con commenti).
- Compressione: `0` nessuna, `1` Deflate (libreria zlib, con header zlib: usare `zlib.decompress`, non raw deflate), `2` Heatshrink 11-4, `3` Heatshrink 12-4.
- Default di PrusaSlicer (`ResultExportDataFinalizer.cpp`): file metadata `None`, printer metadata `None`, print metadata `Deflate`, slicer metadata `Deflate`, gcode `Heatshrink_12_4`, encoding GCode `MeatPackComments`, metadata `INI`, checksum `CRC32`.
- Quindi: printer metadata si legge senza decomprimere. Print metadata e slicer metadata sono compressi con deflate (zlib) e vanno decompressi.
- Encoding dei metadata: INI. Ogni voce è `key=value` (`binarize.cpp`: chiave, `=`, valore). Il parser divide sul primo `=`. Il separatore tra voci non è stato verificato nel dettaglio.

Caveat: ho verificato la configurazione di default nel percorso `ResultExport`. Il percorso di esportazione binaria standard della GUI (`GCode.cpp`) non l'ho letto.

## 3. Metadati nel bgcode

Sì, `convert.cpp` (`from_ascii_to_binary`) copia le stesse stringhe ASCII nei blocchi:

- **Print Metadata**: `total tool changes`, `filament used [mm]`, `filament used [cm3]`, `filament used [g]`, `filament cost`, `total filament used [g]`, `total filament cost`, `total filament used for wipe tower [g]`, `estimated printing time (normal mode)`, `estimated printing time (silent mode)`, `estimated first layer printing time (normal/silent mode)`.
- **Printer Metadata**: `printer_model`, `filament_type`, `nozzle_diameter`, più gli stessi `filament used [...]`, `filament cost`, i tempi di stampa, `total filament used for wipe tower`, `total tool changes` e `objects_info`.
- **Slicer Metadata**: tutte le chiavi del blocco `prusaslicer_config` come `key=value`. Qui stanno `filament_density`, `filament_cost`, `filament_settings_id`, `printer_settings_id`, ecc.

Quindi un calcolatore per il bgcode può leggere grammi e tempo dal Print Metadata (compresso con deflate) o dal Printer Metadata (non compresso), e densità e prezzi dallo Slicer Metadata.

## Fonti non verificate

- Il blocco `prusaslicer_json_config` non è stato verificato sul sample reale, solo nel sorgente `master`.
- Non ho controllato le versioni 2.8 precedenti alla 2.9.0-alpha1 né la build release 2.9.0 finale.
- La API di GitHub search ha raggiunto il rate limit. Per questo sono partito dai file scaricati direttamente e dal sample di test, non da una ricerca completa del repo.
