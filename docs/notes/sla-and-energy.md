# Resina SLA, costi di stampa ed energia (Italia)

Note di ricerca. Le cifre marcate "stima" non sono verificate su fonti primarie.

## A) Resina / SLA

### Bundle PrusaSlicer (verificati)

- Bundle FFF: https://raw.githubusercontent.com/prusa3d/PrusaSlicer-settings-prusa-fff/main/PrusaResearch/2.5.13.ini. Non contiene sezioni `sla_*`. Ha solo `[printer_model:...]` FFF.
- Bundle SLA Prusa (ultima versione 1.0.10): https://raw.githubusercontent.com/prusa3d/PrusaSlicer-settings-prusa-sla/main/PrusaResearchSLA/1.0.10.ini
  - `[printer_model:SL1]`, `[printer_model:SL1S]`
  - 479 sezioni `[sla_material:...]` (solo 2 printer_model)
  - 8 sezioni `[sla_print:...]`: `*common*`, `*SL1S*`, `0.025/0.05/0.1 UltraDetail/Normal/Fast` (+ varianti `@SL1S`)
- Bundle SLA di terze parti: https://github.com/prusa3d/PrusaSlicer-settings-non-prusa-sla (cartella `AnycubicSLA`, file 1.0.0.ini): `[printer_model:PHOTON MONO]`, `PHOTON MONO X`, `PHOTON MONO X 6K`, `PHOTON MONO SE`, 6 sezioni `sla_material`. Nessun bundle Elegoo/Creality nel repo: vanno cercati nei profili vendor di PrusaSlicer (non verificato).

Chiavi reali di `[sla_material:...]`: `inherits`, `exposure_time`, `initial_exposure_time`, `material_type`, `material_vendor`, `material_colour`, `material_density` (solo 60 sezioni, es. Prusament Resin Model+ = 1.10), `delay_before_exposure`, `area_fill`, `tilt_*`, `material_print_speed`, `material_ow_support_*`.

Chiavi NON presenti: `bottle_cost`, `bottle_volume`, `bottle_weight`. Il costo per litro non e' nel bundle: va inserito a mano.

Chiavi tipiche `[sla_print:...]`: `layer_height`, `inherits`, parametri di supporto/orientamento.

Chiavi `[printer_model:SL1]`: `name`, `variants`, `technology = SLA`, `family`, `bed_model`, `bed_texture`, `default_materials`.

Esempi di tempi di esposizione reali (layer 0.05, `exposure_time` / `initial_exposure_time`, s):
- Prusament Resin Model Solid Grey @0.05: 5 / 35
- Esun Standard Resin Black @0.05: 7 / 30
- Harz Labs Model Resin Black @0.05: 13 / 20

Nessun prezzo al litro e' presente nel bundle: i tre esempi di costo/litro vanno presi dai listini dei produttori (non trovati in questa ricerca).

### File SL1 (`.sl1`, zip)

Fonte: sorgente PrusaSlicer `src/slic3r-shared/src/Slic3r/Biz/ResultExport/SLA/SL1.cpp`, funzione `fill_iniconf`, con file `config.ini` e `prusaslicer.ini`. Chiavi in `config.ini`:

- `usedMaterial`: resina in **ml** (oggetti + supporti, da mm^3/1000)
- `printTime`: tempo stimato in secondi
- `layerHeight`, `expTime`, `expTimeFirst`
- `expUserProfile` (0 fast, 1 slow, 2 normal)
- `numFast`, `numSlow`, `numFade` (conteggio layer)
- `printerModel`, `printerVariant`, `prusaSlicerVersion`, `fileCreationTimestamp`, `hollow`, `action`

`prusaslicer.ini` contiene la configurazione completa.

### Modello di costo resina (stime da fonti)

- **Resina**: `usedMaterial` (ml) x prezzo/ml. Una stampa Saturn da 40-60 ml (fonte: forum); pesata reale 185 g contro 138.7 g stimati (waste/filtro incluso). Prezzo al litro: da inserire dal listino.
- **IPA di lavaggio**: un utente ~97 EUR per 25 L in 3.5 anni, circa 3.9 EUR/L (stima). Il double-dip riduce il consumo. Il consumo per stampa non e' misurato: stimare come frazione del volume di lavaggio.
- **Pellicola FEP/nFEP**: circa 6.10 GBP per film Saturn (retailer UK, prezzo indicativo). Vita 30-100 stampe (stime); un utente ha usato ~5 fogli in 3.5 anni. Costo per stampa = prezzo / stampe di vita.
- **Display LCD (monocromatico)**: sostituzione ~90 AUD (forum). Vita tipica ~2000 h (guida). Costo orario = prezzo / 2000 h, poi x `printTime`.
- **Energia**: potenza non verificata. Il 180 W citato per il Saturn 3 Ultra e' la capacita' dell'alimentatore, non il consumo misurato. I valori "Mars 3 40-50 W, Saturn 60-80 W" richiesti non sono stati trovati in fonti verificabili. Va misurata con wattmetro. Costo = W/1000 x ore x tariffa (vedi B).
- **Tasso di fallimento**: non trovato in fonti affidabili. Usare un fattore di scarto (es. +5-10%) come parametro dell'utente.

Formula di esempio: `costo = (usedMaterial_ml x prezzo_resina_ml) + (IPA_ml x prezzo_IPA_ml) + (FEP / stampe_vita) + (LCD / 2000 x printTime_h) + (W/1000 x printTime_h x tariffa) ` poi `x (1 + scarto)`.

## B) Fasce orarie energia Italia

### Definizioni (fonti secondarie, da verificare sul testo ARERA)

Il testo ufficiale e' nella delibera ARERA 181/06 (TIT). Il glossario ARERA non e' stato raggiunto.

- **F1 (punta)**: lunedi-venerdi 8:00-19:00, esclusi festivi.
- **F2 (intermedia)**: lunedi-venerdi 7:00-8:00 e 19:00-23:00; sabato 7:00-23:00.
- **F3 (notte/fuori punta)**: lunedi-sabato 23:00-7:00; domenica e festivi tutto il giorno.
- **Bioraria**: due prezzi. F1 e F23 (F23 = F2 + F3, cioe' tutte le ore non di punta).

Discrepanze tra fonti: la sabato F2 e F3 varia. Usare il testo ARERA prima di implementare.

### Festivita' nazionali 2026

- 1 gennaio (Capodanno), 6 gennaio (Epifania)
- Pasqua domenica 5 aprile; Pasquetta lunedi 6 aprile (variabile)
- 25 aprile, 1 maggio, 2 giugno, 15 agosto, 1 novembre, 8 dicembre, 25 dicembre, 26 dicembre (Santo Stefano)

Festivita' locali (es. Sant'Ambrogio, Milano, 7 dicembre) non incluse.

### Prezzi indicativi 2026 (fonte: offerte Axpo, non ARERA)

- Offerta fissa 12 mesi (agosto 2026): F1 0.175, F2 0.192, F3 0.165 EUR/kWh (esclusi IVA e imposte, con fisso 144 EUR/POD/anno).
- Offerta fissa 36 mesi (giugno 2026): circa F1 0.136, F2 0.148, F3 0.127 EUR/kWh.
- Tutela (clienti vulnerabili): fonti discordanti (~0.158 EUR/kWh piatto a luglio 2026 per Segugio; valori mensili diversi per QuiFinanza). Verificare su ARERA.
- PUN 28/07/2026: 0.176 EUR/kWh (QuiFinanza).

## Sintesi (8 righe)

1. Bundle SLA Prusa: `prusa3d/PrusaSlicer-settings-prusa-sla` 1.0.10.ini, 479 `sla_material`, `printer_model` SL1/SL1S.
2. Nessuna chiave `bottle_cost`/`bottle_volume`: costo resina inserito a mano.
3. File SL1 `config.ini`: `usedMaterial` (ml), `printTime` (s), `layerHeight`, `expTime`, `numFade/Fast/Slow`.
4. Costi di consumo: IPA ~3.9 EUR/L, FEP 6.10 GBP per 30-100 stampe, LCD ~90 AUD ogni ~2000 h (stime).
5. Potenza: non verificata (180 W = PSU); misurare con wattmetro.
6. Tariffe Italia: F1 8-19 lun-ven; F2 7-8 e 19-23 lun-ven, 7-23 sab; F3 23-7 e festivi; bioraria F1/F23.
7. Festivita' 2026 incluse, Pasquetta 6 aprile.
8. Prezzi 2026 (Axpo): F1 ~0.14-0.18, F2 ~0.15-0.19, F3 ~0.13-0.17 EUR/kWh (esclusi IVA/imposte).

## Fonti

- Bundle SLA Prusa: https://raw.githubusercontent.com/prusa3d/PrusaSlicer-settings-prusa-sla/main/PrusaResearchSLA/1.0.10.ini
- Bundle terze parti: https://github.com/prusa3d/PrusaSlicer-settings-non-prusa-sla
- Sorgente SL1 config: https://raw.githubusercontent.com/prusa3d/PrusaSlicer/master/src/slic3r-shared/src/Slic3r/Biz/ResultExport/SLA/SL1.cpp
- Fasce orarie (comparasemplice): https://www.comparasemplice.it/energia-luce-gas/fasce-orarie-energia
- Fasce orarie (segugio): https://tariffe.segugio.it/guide-e-strumenti/glossario-adsl-energia-gas/fasce-orarie.aspx
- Festivita' 2026 (dilei): https://dilei.it/lifestyle/ponti-e-feste-2026/2022948/
- Prezzi Axpo: https://www.axpo.com/content/dam/axpo19/italy/cte-offerte-business/Scegli%20Sereno%202.0_2608.pdf
- PUN (QuiFinanza): https://quifinanza.it/osservatorio-prezzi/prezzo-energia-elettrica-oggi-2/920965/
- Costi stampa resina (forum/guide): https://www.westernthunder.co.uk/threads/3d-printing-whether-to-buy-what-to-buy-and-how-to-use-it.10192/latest
- Calcolatore costi resina: https://printpal.io/tools/resin-print-cost-calculator
