/* Converter – PDF till LEDES 98BI (V2), helt i webbläsaren.
   Flöde: läs PDF-text (pdf.js) → föreslå rader → granska/komplettera → exportera .txt.
   Formatet: pipe-separerat, 52 fält per rad, radslut "[]", datum YYYYMMDD. */

(function () {
  'use strict';

  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  // ---------- LEDES 98BI V2: exakt fältordning (52 fält) ----------
  const FIELDS = [
    'INVOICE_DATE', 'INVOICE_NUMBER', 'CLIENT_ID', 'LAW_FIRM_MATTER_ID', 'INVOICE_TOTAL',
    'BILLING_START_DATE', 'BILLING_END_DATE', 'INVOICE_DESCRIPTION', 'LINE_ITEM_NUMBER',
    'EXP/FEE/INV_ADJ_TYPE', 'LINE_ITEM_NUMBER_OF_UNITS', 'LINE_ITEM_ADJUSTMENT_AMOUNT',
    'LINE_ITEM_TOTAL', 'LINE_ITEM_DATE', 'LINE_ITEM_TASK_CODE', 'LINE_ITEM_EXPENSE_CODE',
    'LINE_ITEM_ACTIVITY_CODE', 'TIMEKEEPER_ID', 'LINE_ITEM_DESCRIPTION', 'LAW_FIRM_ID',
    'LINE_ITEM_UNIT_COST', 'TIMEKEEPER_NAME', 'TIMEKEEPER_CLASSIFICATION', 'CLIENT_MATTER_ID',
    'PO_NUMBER', 'CLIENT_TAX_ID', 'MATTER_NAME', 'INVOICE_TAX_TOTAL', 'INVOICE_NET_TOTAL',
    'INVOICE_CURRENCY', 'TIMEKEEPER_LAST_NAME', 'TIMEKEEPER_FIRST_NAME', 'ACCOUNT_TYPE',
    'LAW_FIRM_NAME', 'LAW_FIRM_ADDRESS_1', 'LAW_FIRM_ADDRESS_2', 'LAW_FIRM_CITY',
    'LAW_FIRM_STATEorREGION', 'LAW_FIRM_POSTCODE', 'LAW_FIRM_COUNTRY', 'CLIENT_NAME',
    'CLIENT_ADDRESS_1', 'CLIENT_ADDRESS_2', 'CLIENT_CITY', 'CLIENT_STATEorREGION',
    'CLIENT_POSTCODE', 'CLIENT_COUNTRY', 'LINE_ITEM_TAX_RATE', 'LINE_ITEM_TAX_TOTAL',
    'LINE_ITEM_TAX_TYPE', 'INVOICE_REPORTED_TAX_TOTAL', 'INVOICE_TAX_CURRENCY'
  ];
  const FORMAT_MARKER = 'LEDES98BI V2[]';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const dropzone = $('ledes-dropzone');
  const fileInput = $('ledes-file-input');
  const loadStatus = $('ledes-load-status');
  const stepForm = $('ledes-step-form');
  const stepLines = $('ledes-step-lines');
  const stepExport = $('ledes-step-export');
  const tbody = $('lines-tbody');
  const totalsBox = $('totals');
  const issuesBox = $('ledes-issues');
  const previewBox = $('ledes-preview-box');
  const previewPre = $('ledes-preview');

  // ---------- State ----------
  let lines = []; // {date, type, task, actexp, tkId, tkFirst, tkLast, tkClass, desc, units, unitCost, adj, taxRate}

  const TK_CLASSES = ['PARTNR', 'ASSOC', 'OFCNSL', 'PRLGL', 'LGLAST', 'OTH'];

  // ---------- Verktygsväxlare ----------
  const picks = document.querySelectorAll('.tool-card');
  picks.forEach((btn) => btn.addEventListener('click', () => {
    picks.forEach((b) => b.classList.toggle('active', b === btn));
    const tool = btn.dataset.tool;
    $('tool-epub').hidden = tool !== 'epub';
    $('tool-ledes').hidden = tool !== 'ledes';
    $('footer-note').textContent = tool === 'ledes'
      ? 'Kontrollera summor och koder mot kundens e-faktureringskrav innan filen skickas in.'
      : 'Konvertera bara böcker du har rätt att kopiera.';
  }));

  // ---------- Hjälpare ----------
  function sanitize(s) {
    // LEDES tillåter inte pipe eller radslutsmarkör i fälten.
    return String(s == null ? '' : s).replace(/\|/g, '/').replace(/\[\]/g, '').replace(/[\r\n\t]+/g, ' ').trim();
  }

  function toLedesDate(isoDate) {
    return isoDate ? isoDate.replace(/-/g, '') : '';
  }

  function money(n) {
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function parseNum(v) {
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v || '').replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
  }

  function lineCalc(l) {
    const base = parseNum(l.units) * parseNum(l.unitCost) + parseNum(l.adj);
    const tax = base * (parseNum(l.taxRate) / 100);
    return { base, tax, total: base + tax };
  }

  function fmt(n) {
    return new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  }

  // ---------- Byråprofil (sparas lokalt i webbläsaren) ----------
  const PROFILE_KEYS = ['f-firm-id', 'f-firm-name', 'f-firm-addr1', 'f-firm-addr2', 'f-firm-city', 'f-firm-postcode', 'f-firm-country', 'f-tax-rate', 'f-currency'];

  $('btn-save-profile').addEventListener('click', () => {
    try {
      const data = {};
      PROFILE_KEYS.forEach((k) => { data[k] = $(k).value; });
      localStorage.setItem('ledes-profile', JSON.stringify(data));
      $('btn-save-profile').textContent = 'Sparat ✓';
      setTimeout(() => { $('btn-save-profile').textContent = 'Spara byråuppgifter'; }, 2000);
    } catch (e) { /* lagring blockerad – ignorera */ }
  });

  try {
    const saved = JSON.parse(localStorage.getItem('ledes-profile') || 'null');
    if (saved) PROFILE_KEYS.forEach((k) => { if (saved[k] != null && $(k)) $(k).value = saved[k]; });
  } catch (e) { /* ignorera */ }

  // ---------- PDF-läsning och radförslag ----------
  async function extractPdf(file) {
    loadStatus.textContent = 'Läser ' + file.name + ' …';
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    const textLines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Gruppéra textbitar per y-position så att rader återskapas
      const rows = new Map();
      for (const item of content.items) {
        const y = Math.round(item.transform[5]);
        let hit = null;
        for (const key of rows.keys()) if (Math.abs(key - y) <= 2) { hit = key; break; }
        const arr = rows.get(hit == null ? y : hit) || [];
        arr.push({ x: item.transform[4], str: item.str });
        rows.set(hit == null ? y : hit, arr);
      }
      [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => {
        const line = items.sort((a, b) => a.x - b.x).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
        if (line) textLines.push(line);
      });
    }
    return textLines;
  }

  // ---------- Datum- och taltolkning ----------
  const MONTH_NAMES = { jan: '01', feb: '02', mar: '03', apr: '04', maj: '05', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', okt: '10', oct: '10', nov: '11', dec: '12' };

  function validIso(y, m, d) {
    const yy = +y, mm = +m, dd = +d;
    if (yy < 2000 || yy > 2099 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return yy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }

  // Datumformat som förekommer på svenska fakturor, i prioritetsordning.
  const DATE_PATTERNS = [
    { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, iso: (m) => validIso(m[1], m[2], m[3]) },
    { re: /\b(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})\b/, iso: (m) => validIso(m[1], m[2], m[3]) },
    { re: /\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/, iso: (m) => validIso(m[3], m[2], m[1]) },
    { re: /\b(\d{1,2})\s+(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)[a-zåäö]*\.?\s+(\d{4})\b/i, iso: (m) => validIso(m[3], MONTH_NAMES[m[2].toLowerCase()], m[1]) },
    { re: /^(\d{4})(\d{2})(\d{2})\b/, iso: (m) => validIso(m[1], m[2], m[3]) },
    { re: /^(\d{2})(\d{2})(\d{2})\b/, iso: (m) => validIso('20' + m[1], m[2], m[3]) }
  ];

  function findLineDate(text) {
    for (const p of DATE_PATTERNS) {
      const m = text.match(p.re);
      if (m) { const iso = p.iso(m); if (iso) return { iso, text: m[0] }; }
    }
    return null;
  }

  // "1 234,56", "1.234,56", "1234.56", "4 600:-", "1 500 kr" → tal
  function parseAmountToken(str) {
    const s = String(str).replace(/[\s ]/g, '').replace(/(kr|sek)$/i, '').replace(/:-$/, '');
    const sep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    let n;
    if (sep > -1 && s.length - sep - 1 >= 1 && s.length - sep - 1 <= 2) {
      n = parseFloat(s.slice(0, sep).replace(/[^\d]/g, '') + '.' + s.slice(sep + 1));
    } else {
      n = parseFloat(s.replace(/[^\d]/g, ''));
    }
    return isNaN(n) ? NaN : n;
  }

  const NUM_TAIL = /(?<![\d.,:])((?:\d{1,3}(?:[ . ]\d{3})+|\d+)(?:[.,]\d{1,2})?)(?:\s*(?:kr|sek|:-|tim(?:mar)?|h|st))?\.?\s*$/i;

  // Plocka upp till `max` tal från radens slut; returnerar talen i radens ordning + texten före dem.
  function extractTrailingNumbers(text, max) {
    const nums = [];
    let rest = text.trim();
    while (nums.length < max) {
      const m = rest.match(NUM_TAIL);
      if (!m) break;
      const v = parseAmountToken(m[1]);
      if (isNaN(v)) break;
      nums.unshift(v);
      rest = rest.slice(0, rest.length - m[0].length).replace(/[|;,–—-]+\s*$/, '').trim();
    }
    return { nums, rest };
  }

  // Tolka [antal, à-pris, belopp] / [antal, belopp] / [belopp] ur radens avslutande tal.
  function unitsAndCost(nums) {
    if (nums.length >= 3) {
      for (let i = nums.length - 3; i >= Math.max(0, nums.length - 4); i--) {
        const h = nums[i], rate = nums[i + 1], amt = nums[i + 2];
        if (h > 0 && h <= 500 && rate > 0 && amt > 0 && Math.abs(h * rate - amt) <= Math.max(1, amt * 0.005)) {
          return { units: h, unitCost: rate };
        }
      }
    }
    if (nums.length >= 2) {
      const h = nums[nums.length - 2], amt = nums[nums.length - 1];
      if (h > 0 && h <= 100 && amt > h) return { units: h, unitCost: Math.round((amt / h) * 100) / 100 };
    }
    const amt = nums[nums.length - 1];
    if (amt > 0) return { units: 1, unitCost: amt };
    return null;
  }

  // Rader som ser ut som summor, betalningsuppgifter eller sidhuvud — aldrig fakturarader.
  const SKIP_RE = /\b(summa|del\s?summa|subtotal|totalt?|total|moms|vat|att\s+betala|öres(?:utj|avr)|avrundning|netto|brutto|f-?skatt|bankgiro|plusgiro|iban|bic|swift|org\.?\s?nr|betalningsvillkor|förfall|dröjsmål|ocr|fakturadatum|fakturan(?:r|ummer)|invoice\s*(?:no|number|date)|due\s+date|kund\s?nr|sida\s+\d)\b/i;

  function guessFromText(textLines) {
    let found = 0;
    const all = textLines.join('\n');

    const invNo = all.match(/faktura\s*(?:nummer|nr)\.?\s*:?\s*([A-Za-z0-9][A-Za-z0-9\/_-]*)/i)
      || all.match(/invoice\s*(?:no|number|#)\.?\s*:?\s*([A-Za-z0-9][A-Za-z0-9\/_-]*)/i);
    if (invNo && !$('f-invoice-number').value) { $('f-invoice-number').value = invNo[1]; found++; }

    if (!$('f-invoice-date').value) {
      for (const raw of textLines) {
        if (!/fakturadatum|invoice\s*date/i.test(raw)) continue;
        const d = findLineDate(raw);
        if (d) { $('f-invoice-date').value = d.iso; found++; break; }
      }
    }

    // Radkandidater: en rad med ett datum, en beskrivning och tal på slutet.
    const defaultRate = parseNum($('f-tax-rate').value);
    const dates = [];

    for (const raw of textLines) {
      if (SKIP_RE.test(raw)) continue;
      const d = findLineDate(raw);
      if (!d) continue;
      const at = raw.indexOf(d.text);
      const withoutDate = (raw.slice(0, at) + ' ' + raw.slice(at + d.text.length)).replace(/\s+/g, ' ').trim();
      const { nums, rest } = extractTrailingNumbers(withoutDate, 4);
      if (!nums.length) continue;
      const parsed = unitsAndCost(nums);
      if (!parsed) continue;
      const desc = rest.replace(/^[|;:.–—-]+|[|;:–—-]+$/g, '').trim();
      if (desc.length < 2) continue;
      dates.push(d.iso);
      lines.push({
        date: d.iso, type: 'F', task: '', actexp: '', tkId: '', tkFirst: '', tkLast: '', tkClass: '',
        desc, units: parsed.units, unitCost: parsed.unitCost, adj: 0, taxRate: defaultRate
      });
      found++;
    }

    // Föreslå period från raddatumen
    if (dates.length) {
      dates.sort();
      if (!$('f-billing-start').value) $('f-billing-start').value = dates[0];
      if (!$('f-billing-end').value) $('f-billing-end').value = dates[dates.length - 1];
    }
    return found;
  }

  async function handlePdf(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { loadStatus.textContent = 'Välj en .pdf-fil.'; return; }
    try {
      const textLines = await extractPdf(file);
      lines = [];
      guessFromText(textLines);
      showExtractedText(textLines);
      if (lines.length > 0) {
        loadStatus.textContent = lines.length + ' radförslag hittades — granska nedan.';
      } else if (textLines.join('').length < 40) {
        loadStatus.textContent = 'PDF:en saknar textlager (inskannad?) och kan inte läsas automatiskt — fyll i raderna för hand.';
      } else {
        loadStatus.textContent = 'Inga fakturarader kunde tolkas — se den utlästa texten nedan eller fyll i för hand.';
      }
      if (lines.length === 0) addLine();
      showSteps();
    } catch (e) {
      console.error(e);
      loadStatus.textContent = 'Kunde inte läsa PDF:en: ' + e.message;
    }
  }

  // Felsökningsvy: visar exakt vilken text som lästes ur PDF:en.
  function showExtractedText(textLines) {
    let box = $('ledes-extracted');
    if (!box) {
      box = document.createElement('details');
      box.id = 'ledes-extracted';
      const sum = document.createElement('summary');
      sum.textContent = 'Visa utläst text';
      box.appendChild(sum);
      box.appendChild(document.createElement('pre'));
      loadStatus.insertAdjacentElement('afterend', box);
    }
    box.querySelector('pre').textContent = textLines.join('\n') || '(ingen text hittades i PDF:en)';
    box.open = false;
  }

  function showSteps() {
    stepForm.hidden = false;
    stepLines.hidden = false;
    stepExport.hidden = false;
    renderLines();
    stepForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- Radtabell ----------
  function addLine() {
    lines.push({
      date: '', type: 'F', task: '', actexp: '', tkId: '', tkFirst: '', tkLast: '', tkClass: '',
      desc: '', units: 1, unitCost: 0, adj: 0, taxRate: parseNum($('f-tax-rate').value)
    });
    renderLines();
  }

  function cellInput(line, key, type, opts = {}) {
    const td = document.createElement('td');
    let el;
    if (opts.select) {
      el = document.createElement('select');
      opts.select.forEach(([v, label]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        el.appendChild(o);
      });
      el.value = line[key];
    } else {
      el = document.createElement('input');
      el.type = type;
      if (type === 'number') { el.step = opts.step || '0.01'; }
      el.value = line[key];
      if (opts.list) el.setAttribute('list', opts.list);
      if (opts.width) el.style.width = opts.width;
      if (opts.placeholder) el.placeholder = opts.placeholder;
    }
    el.addEventListener('input', () => {
      line[key] = type === 'number' ? parseNum(el.value) : el.value;
      updateTotals();
      updateRowSum(el, line);
    });
    td.appendChild(el);
    return td;
  }

  function updateRowSum(el, line) {
    const tr = el.closest('tr');
    if (tr) tr.querySelector('.rowsum').textContent = fmt(lineCalc(line).total);
  }

  function renderLines() {
    tbody.innerHTML = '';
    lines.forEach((line, idx) => {
      const tr = document.createElement('tr');
      const num = document.createElement('td');
      num.textContent = idx + 1;
      num.className = 'rownum';
      tr.appendChild(num);

      tr.appendChild(cellInput(line, 'date', 'date'));
      tr.appendChild(cellInput(line, 'type', 'text', { select: [['F', 'F – arvode'], ['E', 'E – utlägg'], ['IF', 'IF – justering arvode'], ['IE', 'IE – justering utlägg']] }));
      tr.appendChild(cellInput(line, 'task', 'text', { width: '5.5em', placeholder: 'L110' }));
      tr.appendChild(cellInput(line, 'actexp', 'text', { width: '5.5em', placeholder: 'A102/E101' }));
      tr.appendChild(cellInput(line, 'tkId', 'text', { width: '5em' }));
      tr.appendChild(cellInput(line, 'tkFirst', 'text', { width: '7em' }));
      tr.appendChild(cellInput(line, 'tkLast', 'text', { width: '7em' }));
      tr.appendChild(cellInput(line, 'tkClass', 'text', { width: '6em', list: 'tk-classes', placeholder: 'PARTNR' }));
      tr.appendChild(cellInput(line, 'desc', 'text', { width: '18em' }));
      tr.appendChild(cellInput(line, 'units', 'number', { step: '0.25' }));
      tr.appendChild(cellInput(line, 'unitCost', 'number'));
      tr.appendChild(cellInput(line, 'adj', 'number'));
      tr.appendChild(cellInput(line, 'taxRate', 'number', { step: '0.1' }));

      const sum = document.createElement('td');
      sum.className = 'rowsum';
      sum.textContent = fmt(lineCalc(line).total);
      tr.appendChild(sum);

      const del = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'row-del';
      btn.title = 'Ta bort rad';
      btn.textContent = '✕';
      btn.addEventListener('click', () => { lines.splice(idx, 1); renderLines(); });
      del.appendChild(btn);
      tr.appendChild(del);

      tbody.appendChild(tr);
    });

    if (!document.getElementById('tk-classes')) {
      const dl = document.createElement('datalist');
      dl.id = 'tk-classes';
      TK_CLASSES.forEach((c) => { const o = document.createElement('option'); o.value = c; dl.appendChild(o); });
      document.body.appendChild(dl);
    }
    updateTotals();
  }

  function invoiceTotals() {
    let net = 0, tax = 0;
    lines.forEach((l) => { const c = lineCalc(l); net += c.base; tax += c.tax; });
    return { net, tax, total: net + tax };
  }

  function updateTotals() {
    const t = invoiceTotals();
    const cur = sanitize($('f-currency').value) || 'SEK';
    totalsBox.innerHTML = 'Netto: <strong>' + fmt(t.net) + '</strong> · Moms: <strong>' + fmt(t.tax) +
      '</strong> · Att betala: <strong>' + fmt(t.total) + ' ' + cur + '</strong>';
  }

  $('f-tax-rate').addEventListener('input', updateTotals);
  $('f-currency').addEventListener('input', updateTotals);
  $('btn-add-line').addEventListener('click', addLine);

  // ---------- Validering ----------
  function validate() {
    const errors = [];
    const warnings = [];
    const req = (id, label) => { if (!sanitize($(id).value)) errors.push(label + ' saknas.'); };

    req('f-invoice-number', 'Fakturanummer');
    req('f-invoice-date', 'Fakturadatum');
    req('f-billing-start', 'Periodens startdatum');
    req('f-billing-end', 'Periodens slutdatum');
    req('f-currency', 'Valuta');
    req('f-firm-id', 'Byrå-ID');
    req('f-firm-name', 'Byråns namn');
    req('f-firm-matter', 'Byråns ärendenummer');
    req('f-client-id', 'Klient-ID');
    req('f-client-matter', 'Klientens ärendenummer');

    if ($('f-billing-start').value && $('f-billing-end').value && $('f-billing-start').value > $('f-billing-end').value) {
      errors.push('Periodens startdatum ligger efter slutdatumet.');
    }
    if (lines.length === 0) errors.push('Fakturan har inga rader.');

    lines.forEach((l, i) => {
      const n = 'Rad ' + (i + 1) + ': ';
      if (!l.date) errors.push(n + 'datum saknas.');
      if (!sanitize(l.desc)) errors.push(n + 'beskrivning saknas.');
      if (l.type === 'F') {
        if (parseNum(l.units) <= 0) errors.push(n + 'antal timmar måste vara större än 0.');
        if (!sanitize(l.tkId)) errors.push(n + 'timekeeper-ID saknas (krävs för arvodesrader).');
        if (!sanitize(l.tkLast)) errors.push(n + 'timekeeper-namn saknas.');
        if (!sanitize(l.task)) warnings.push(n + 'UTBMS task-kod saknas — många kunder kräver det (t.ex. L110).');
        if (!sanitize(l.actexp)) warnings.push(n + 'aktivitetskod saknas (t.ex. A102).');
      }
      if (l.type === 'E' && !sanitize(l.actexp)) warnings.push(n + 'utläggskod saknas (t.ex. E101).');
      if (l.date && ($('f-billing-start').value && l.date < $('f-billing-start').value || $('f-billing-end').value && l.date > $('f-billing-end').value)) {
        warnings.push(n + 'raddatumet ligger utanför faktureringsperioden.');
      }
    });

    const cur = sanitize($('f-currency').value);
    if (cur && !/^[A-Za-z]{3}$/.test(cur)) errors.push('Valutan ska vara en trebokstavskod enligt ISO 4217, t.ex. SEK.');

    return { errors, warnings };
  }

  // ---------- Export ----------
  function buildLedes() {
    const t = invoiceTotals();
    const cur = sanitize($('f-currency').value).toUpperCase();
    const shared = {
      INVOICE_DATE: toLedesDate($('f-invoice-date').value),
      INVOICE_NUMBER: sanitize($('f-invoice-number').value),
      CLIENT_ID: sanitize($('f-client-id').value),
      LAW_FIRM_MATTER_ID: sanitize($('f-firm-matter').value),
      INVOICE_TOTAL: money(t.total),
      BILLING_START_DATE: toLedesDate($('f-billing-start').value),
      BILLING_END_DATE: toLedesDate($('f-billing-end').value),
      INVOICE_DESCRIPTION: sanitize($('f-invoice-desc').value),
      LAW_FIRM_ID: sanitize($('f-firm-id').value),
      CLIENT_MATTER_ID: sanitize($('f-client-matter').value),
      PO_NUMBER: sanitize($('f-po').value),
      CLIENT_TAX_ID: sanitize($('f-client-tax').value),
      MATTER_NAME: sanitize($('f-matter-name').value),
      INVOICE_TAX_TOTAL: money(t.tax),
      INVOICE_NET_TOTAL: money(t.net),
      INVOICE_CURRENCY: cur,
      ACCOUNT_TYPE: $('f-account-type').value,
      LAW_FIRM_NAME: sanitize($('f-firm-name').value),
      LAW_FIRM_ADDRESS_1: sanitize($('f-firm-addr1').value),
      LAW_FIRM_ADDRESS_2: sanitize($('f-firm-addr2').value),
      LAW_FIRM_CITY: sanitize($('f-firm-city').value),
      LAW_FIRM_STATEorREGION: '',
      LAW_FIRM_POSTCODE: sanitize($('f-firm-postcode').value),
      LAW_FIRM_COUNTRY: sanitize($('f-firm-country').value).toUpperCase(),
      CLIENT_NAME: sanitize($('f-client-name').value),
      CLIENT_ADDRESS_1: sanitize($('f-client-addr1').value),
      CLIENT_ADDRESS_2: sanitize($('f-client-addr2').value),
      CLIENT_CITY: sanitize($('f-client-city').value),
      CLIENT_STATEorREGION: sanitize($('f-client-region').value),
      CLIENT_POSTCODE: sanitize($('f-client-postcode').value),
      CLIENT_COUNTRY: sanitize($('f-client-country').value).toUpperCase(),
      INVOICE_REPORTED_TAX_TOTAL: money(t.tax),
      INVOICE_TAX_CURRENCY: cur,
      LINE_ITEM_TAX_TYPE: sanitize($('f-tax-type').value) || 'VAT'
    };

    const rows = lines.map((l, i) => {
      const c = lineCalc(l);
      const rec = { ...shared };
      rec.LINE_ITEM_NUMBER = String(i + 1);
      rec['EXP/FEE/INV_ADJ_TYPE'] = l.type;
      rec.LINE_ITEM_NUMBER_OF_UNITS = String(parseNum(l.units));
      rec.LINE_ITEM_ADJUSTMENT_AMOUNT = money(parseNum(l.adj));
      rec.LINE_ITEM_TOTAL = money(c.total);
      rec.LINE_ITEM_DATE = toLedesDate(l.date);
      rec.LINE_ITEM_TASK_CODE = sanitize(l.task).toUpperCase();
      rec.LINE_ITEM_EXPENSE_CODE = (l.type === 'E' || l.type === 'IE') ? sanitize(l.actexp).toUpperCase() : '';
      rec.LINE_ITEM_ACTIVITY_CODE = (l.type === 'F' || l.type === 'IF') ? sanitize(l.actexp).toUpperCase() : '';
      rec.TIMEKEEPER_ID = sanitize(l.tkId);
      rec.LINE_ITEM_DESCRIPTION = sanitize(l.desc);
      rec.LINE_ITEM_UNIT_COST = money(parseNum(l.unitCost));
      rec.TIMEKEEPER_NAME = sanitize((l.tkFirst + ' ' + l.tkLast).trim());
      rec.TIMEKEEPER_CLASSIFICATION = sanitize(l.tkClass).toUpperCase();
      rec.TIMEKEEPER_LAST_NAME = sanitize(l.tkLast);
      rec.TIMEKEEPER_FIRST_NAME = sanitize(l.tkFirst);
      rec.LINE_ITEM_TAX_RATE = String(parseNum(l.taxRate) / 100);
      rec.LINE_ITEM_TAX_TOTAL = money(c.tax);
      return FIELDS.map((f) => rec[f] != null ? rec[f] : '').join('|') + '[]';
    });

    return [FORMAT_MARKER, FIELDS.join('|') + '[]', ...rows].join('\r\n') + '\r\n';
  }

  $('btn-export').addEventListener('click', () => {
    const { errors, warnings } = validate();
    issuesBox.innerHTML = '';

    const list = (items, cls, title) => {
      if (!items.length) return;
      const box = document.createElement('div');
      box.className = 'issue-box ' + cls;
      box.innerHTML = '<strong>' + title + '</strong>';
      const ul = document.createElement('ul');
      items.forEach((msg) => { const li = document.createElement('li'); li.textContent = msg; ul.appendChild(li); });
      box.appendChild(ul);
      issuesBox.appendChild(box);
    };

    list(errors, 'err', 'Rätta detta innan filen kan skapas:');
    list(warnings, 'warn', 'Kontrollera gärna (filen skapas ändå):');

    if (errors.length) { previewBox.hidden = true; return; }

    const content = buildLedes();
    previewPre.textContent = content.split('\r\n').slice(0, 6).join('\n') + (lines.length > 4 ? '\n…' : '');
    previewBox.hidden = false;

    const name = 'LEDES98BI_' + (sanitize($('f-invoice-number').value).replace(/[^A-Za-z0-9_-]+/g, '-') || 'faktura') + '.txt';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);

    const ok = document.createElement('p');
    ok.className = 'issue-ok';
    ok.textContent = name + ' har laddats ner (' + lines.length + ' rader).';
    issuesBox.appendChild(ok);
  });

  // ---------- Händelser: filinläsning ----------
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change', () => handlePdf(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => handlePdf(e.dataTransfer.files[0]));

  $('ledes-skip').addEventListener('click', () => {
    if (lines.length === 0) addLine();
    loadStatus.textContent = '';
    showSteps();
  });
})();
