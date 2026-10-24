# OpenPrintCalc

Calcolatore di costi e preventivi per stampa 3D. Sito statico (HTML, CSS, TypeScript compilato in JS ES modules con `tsc`, senza bundler). Interfaccia in italiano.

- Scegli stampante e filamento: potenza, ammortamento, usura e prezzo al kg si precompilano (badge `auto`; se li cambi diventano `manuale` con reset).
- Trascina un `.gcode` o `.bgcode` di PrusaSlicer: legge grammi, ore, stampante e filamento.
- Importa i profili utente di PrusaSlicer (`%APPDATA%/PrusaSlicer/filament` e `printer`, file `.ini`).
- Il preventivo si aggiorna mentre scrivi e si copia come testo. Tutto resta nel browser (localStorage).

I `.bgcode` con metadati compressi in heatshrink non sono leggibili. Con le impostazioni predefinite di PrusaSlicer i metadati sono non compressi o deflate, quindi funzionano.

## Sviluppo

Il sorgente e' in `src/*.ts` (TypeScript strict); `js/` e' generato da `tsc` e non e' versionato.

```
npm install
npm run build        # compila src/ in js/
python -m http.server
```

poi apri http://localhost:8000 (i moduli ES non funzionano da `file://`). Durante lo sviluppo `npm run dev` ricompila a ogni modifica.

## Test e controlli

```
npm test             # node --test tests/*.test.ts (type stripping nativo, Node 24+)
npm run typecheck    # tsc --noEmit su src, scripts e tests
```

## Script dati

```
node scripts/build-filaments.ts
node scripts/build-printers-prusaslicer.ts
```

rigenerano `data/filaments.json` e `data/printers-prusaslicer.json` dai profili PrusaSlicer (serve la rete).

## Dati

`data/filaments.json` e `data/printers.json`: prezzi e consumi sono indicativi, i campi marcati `estimated` sono stime. Verificali prima di usarli per decisioni di costo.

## Deploy

`.github/workflows/pages.yml` esegue `npm ci`, typecheck, test e build, poi pubblica `index.html`, `css/`, `data/` e il `js/` compilato del repository su GitHub Pages (abilita Pages con sorgente "GitHub Actions").
