# Converter — byråns filverktyg

Två verktyg, helt i webbläsaren. Ingen fil laddas upp till någon server — all bearbetning sker lokalt, i samma anda som [Nomen Nescio](https://nomennescio.vercel.app/).

## Verktyg 1: EPUB → PDF

- Dra och släpp en `.epub` → få en sökbar A4-PDF med titelsida, innehållsförteckning och sidnummer
- Bilder, rubriker, listor, citat och tabeller följer med
- DRM-detektering: kopieringsskyddade böcker flaggas och konverteras inte
- Alternativ utskriftsvy för högsta trohet (spara som PDF via webbläsarens utskriftsdialog)

## Verktyg 2: PDF → LEDES 98BI

Skapar e-fakturafiler i LEDES 98BI-format (V2, 52 fält) som många försäkringsbolag och storkunder kräver.

- Släpp en faktura-PDF → texten läses och fakturarader föreslås automatiskt (datum, beskrivning, timmar, belopp)
- Granska och komplettera i en redigerbar tabell: UTBMS-koder, timekeepers, moms, justeringar
- Byråns uppgifter kan sparas lokalt i webbläsaren så de inte behöver fyllas i varje gång
- Validering innan export: obligatoriska fält, summakontroller, varningar för saknade koder
- Exporterar pipe-separerad `.txt` enligt specen: `LEDES98BI V2[]`-markör, 52 fält per rad, `[]`-radslut, datum som `YYYYMMDD`

## Teknik

Statisk sida utan byggsteg: `index.html` + `style.css` + `app.js` (EPUB) + `ledes.js` (LEDES).
Bibliotek, vendorerade i `vendor/`: [JSZip](https://stuk.github.io/jszip/) (läser EPUB-arkivet), [pdfmake](http://pdfmake.org/) (genererar PDF), [pdf.js](https://mozilla.github.io/pdf.js/) (läser PDF-text).

Deployas som statisk sida på Vercel — inga inställningar behövs.

## Att tänka på

Konvertera bara böcker du har rätt att kopiera. Kopiering för en verksamhets behov kräver normalt stöd i licensvillkor eller tillstånd från förlaget.
