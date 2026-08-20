# Converter — EPUB till PDF

Konverterar EPUB-böcker till sökbara PDF-filer, helt i webbläsaren. Ingen fil laddas upp till någon server — all bearbetning sker lokalt, i samma anda som [Nomen Nescio](https://nomennescio.vercel.app/).

## Funktioner

- Dra och släpp en `.epub` → få en sökbar A4-PDF med titelsida, innehållsförteckning och sidnummer
- Bilder, rubriker, listor, citat och tabeller följer med
- DRM-detektering: kopieringsskyddade böcker flaggas och konverteras inte
- Alternativ utskriftsvy för högsta trohet (spara som PDF via webbläsarens utskriftsdialog)

## Teknik

Statisk sida utan byggsteg: `index.html` + `style.css` + `app.js`.
Bibliotek via CDN: [JSZip](https://stuk.github.io/jszip/) (läser EPUB-arkivet) och [pdfmake](http://pdfmake.org/) (genererar PDF:en).

Deployas som statisk sida på Vercel — inga inställningar behövs.

## Att tänka på

Konvertera bara böcker du har rätt att kopiera. Kopiering för en verksamhets behov kräver normalt stöd i licensvillkor eller tillstånd från förlaget.
