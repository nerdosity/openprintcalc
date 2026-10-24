# OpenPrintCalc v2: funzionalità

## Intento

OpenPrintCalc resta un calcolatore veloce: la schermata base (G-code, stampante, filamento, lavoro, preventivo) non cambia. Tutto il nuovo vive in un pannello "Impostazioni" a schede, e ogni funzione avanzata è spenta di default; quando accesa aggiunge al massimo una riga al preventivo.

## Principi

- zero server, zero dipendenze runtime
- TypeScript strict
- stato in localStorage
- badge auto/manuale ovunque
- valori stimati marcati ≈ con fonte

## Funzioni

1. **Link condivisibile**: stato completo codificato nell'hash URL (compresso, DecompressionStream) in due varianti:
   - "link interno": tutto, riapre il calcolatore;
   - "link cliente": solo nome lavoro, pezzi, materiale/stampante, parametri di stampa, prezzo per pezzo e totale, IVA se attiva, validità. Mai costi, ricarico, tariffe.

   Il link cliente apre una vista preventivo pulita stampabile.

2. **Slicer**: G-code di PrusaSlicer, OrcaSlicer, Bambu Studio, Cura; file .gcode.3mf Bambu/Orca (zip letto con DecompressionStream deflate-raw) e .3mf progetto PrusaSlicer; rilevamento automatico dello slicer.

3. **Multicolore**: filamento per estrusore, spurgo/torre e cambi filamento contati come riga "Scarto multicolore" separata. Per Bambu Studio e OrcaSlicer lo scarto non viene stimato: il peso riportato include già lo spurgo.

4. **Ammortamento completo**: prezzo acquisto, valore residuo, anni di vita, ore stampate all'anno (utilizzo), budget manutenzione annuo, consumabili → €/h macchina. La vecchia "vita ore" resta come modalità semplice.

5. **Energia a fasce**: tariffa unica (default) oppure fasce F1/F2/F3 o bioraria con prezzi per fascia. Orario di avvio stampa (default: adesso) e durata → ripartizione ore per fascia con festivi italiani. Fasce personalizzabili.

6. **Costi di vendita**: IVA %, commissioni piattaforma (preset Etsy, Shopify, PayPal, Stripe modificabili: % + fisso), imballo €, spedizione €, post-produzione minuti × tariffa. Righe separate nel preventivo.

7. **PWA installabile offline**: manifest + service worker cache-first. Lingua IT/EN con rilevamento automatico e scelta manuale.

8. **Modalità resina (SLA)**:
   - stampante SLA (dai bundle PrusaSlicer);
   - resina (catalogo sla_material: costo/bottiglia, volume, densità);
   - ml usati, IPA per lavaggio, pellicola FEP e display LCD come consumabili, consumo W;
   - lettura file .sl1/.sl1s (zip con config.ini: usedMaterial, printTime).

## Pannelli

Pannello Impostazioni a schede. Ogni scheda ha un interruttore "attiva" e i campi sotto.

- **Generale**: lingua, valuta, nome attività per il link cliente
- **Energia**
- **Ammortamento**
- **Vendita**
- **Slicer/Avanzate**

## Fuori ambito

- integrazione Moonraker/Klipper
- database comunitario via PR
- STL/slicing

## Fasi

1. Infrastruttura pannello + i18n + PWA
2. Ammortamento + energia a fasce + vendita
3. Parser Orca/Bambu/Cura/3MF + multicolore
4. Link condivisibile e vista cliente
5. Resina
6. Revisione e verifica
