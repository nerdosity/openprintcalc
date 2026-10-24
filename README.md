# OpenPrintCalc

Calcolatore di costi e preventivi per stampa 3D. Sito statico (HTML, CSS, JS ES modules): nessun build, nessuna dipendenza. Interfaccia in italiano.

- Scegli stampante e filamento: potenza, ammortamento, usura e prezzo al kg si precompilano (badge `auto`; se li cambi diventano `manuale` con reset).
- Trascina un `.gcode` o `.bgcode` di PrusaSlicer: legge grammi, ore, stampante e filamento.
- Importa i profili utente di PrusaSlicer (`%APPDATA%/PrusaSlicer/filament` e `printer`, file `.ini`).
- Il preventivo si aggiorna mentre scrivi e si copia come testo. Tutto resta nel browser (localStorage).

I `.bgcode` con metadati compressi in heatshrink non sono leggibili. Con le impostazioni predefinite di PrusaSlicer i metadati sono non compressi o deflate, quindi funzionano.

## Uso locale

```
python -m http.server
```

poi apri http://localhost:8000. I moduli ES non funzionano da `file://`.

## Test

```
node --test tests/*.test.js
```

## Dati

`data/filaments.json` e `data/printers.json`: prezzi e consumi sono indicativi, i campi marcati `estimated` sono stime. Verificali prima di usarli per decisioni di costo.

## Deploy

`.github/workflows/pages.yml` esegue i test e pubblica la radice del repository su GitHub Pages (abilita Pages con sorgente "GitHub Actions").
