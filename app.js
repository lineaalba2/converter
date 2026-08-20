/* Converter – EPUB till PDF, helt i webbläsaren.
   Flöde: läs EPUB (zip) → parsa OPF/spine → bygg pdfmake-dokument → ladda ner.
   Ingen fil lämnar datorn. */

(function () {
  'use strict';

  // pdfmake 0.2.x: vfs_fonts.js definierar global `vfs` – koppla in typsnitten.
  if (typeof pdfMake !== 'undefined' && typeof vfs !== 'undefined' && !pdfMake.vfs) {
    pdfMake.vfs = vfs;
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone');
  const fileInput = $('file-input');
  const loadStatus = $('load-status');
  const stepReview = $('step-review');
  const stepConvert = $('step-convert');
  const bookCover = $('book-cover');
  const bookTitle = $('book-title');
  const bookAuthor = $('book-author');
  const bookStats = $('book-stats');
  const drmStatus = $('drm-status');
  const chapterList = $('chapter-list');
  const chapterCount = $('chapter-count');
  const btnPdf = $('btn-pdf');
  const btnPrint = $('btn-print');
  const progress = $('progress');
  const progressBar = $('progress-bar');
  const progressLabel = $('progress-label');
  const convertError = $('convert-error');

  // ---------- State ----------
  let book = null; // { zip, opfDir, meta, spine, fileName, coverDataUrl }

  // ---------- Helpers ----------
  function resolvePath(baseDir, href) {
    // Löser relativa sökvägar (inkl. ../) mot en katalog i zip-arkivet.
    const clean = decodeURIComponent(String(href).split('#')[0]);
    const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
    for (const seg of clean.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }

  function dirOf(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
  }

  function zipFile(zip, path) {
    // Exakt träff först, annars skiftlägesokänslig sökning.
    if (zip.file(path)) return zip.file(path);
    const lower = path.toLowerCase();
    let found = null;
    zip.forEach((relPath, entry) => {
      if (!found && relPath.toLowerCase() === lower) found = entry;
    });
    return found;
  }

  function parseXml(text) {
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  function q(node, localName) {
    // Namespace-tolerant: hitta första elementet med angivet lokalt namn.
    if (!node) return null;
    const els = node.getElementsByTagName('*');
    for (const el of els) if (el.localName === localName) return el;
    return null;
  }

  function qa(node, localName) {
    const out = [];
    if (!node) return out;
    const els = node.getElementsByTagName('*');
    for (const el of els) if (el.localName === localName) out.push(el);
    return out;
  }

  const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', avif: 'image/avif'
  };

  function mimeOf(path) {
    const ext = path.split('.').pop().toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  }

  async function imageAsDataUrl(zip, path) {
    const entry = zipFile(zip, path);
    if (!entry) return null;
    const b64 = await entry.async('base64');
    return 'data:' + mimeOf(path) + ';base64,' + b64;
  }

  // pdfmake klarar bara PNG/JPEG – rastrera övriga format via canvas.
  function toPdfSafeImage(dataUrl) {
    return new Promise((resolve) => {
      if (/^data:image\/(png|jpeg)/.test(dataUrl)) { resolve(dataUrl); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 600;
          canvas.height = img.naturalHeight || 800;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function setProgress(fraction, label) {
    progress.hidden = false;
    progressBar.style.width = Math.round(fraction * 100) + '%';
    progressLabel.textContent = label;
  }

  function showError(msg) {
    convertError.textContent = msg;
    convertError.hidden = false;
  }

  function slugify(s) {
    return (s || 'bok').toLowerCase()
      .replace(/[åä]/g, 'a').replace(/ö/g, 'o')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'bok';
  }

  // ---------- DRM-kontroll ----------
  async function checkDrm(zip) {
    if (zipFile(zip, 'META-INF/rights.xml')) return 'Adobe DRM';
    if (zipFile(zip, 'META-INF/license.lcpl')) return 'LCP-DRM';
    const encEntry = zipFile(zip, 'META-INF/encryption.xml');
    if (!encEntry) return null;
    try {
      const doc = parseXml(await encEntry.async('text'));
      // Typsnittsobfuskering är ofarlig – DRM är det bara om annat än typsnitt krypterats.
      const refs = qa(doc, 'CipherReference');
      const nonFont = refs.some((r) => {
        const uri = (r.getAttribute('URI') || '').toLowerCase();
        return !/\.(ttf|otf|woff2?)$/.test(uri);
      });
      return nonFont ? 'DRM (krypterat innehåll)' : null;
    } catch (e) {
      return 'Okänt kopieringsskydd';
    }
  }

  // ---------- EPUB-parsning ----------
  async function openEpub(file) {
    loadStatus.textContent = 'Läser ' + file.name + ' …';
    convertError.hidden = true;

    const zip = await JSZip.loadAsync(file);

    const drm = await checkDrm(zip);

    // container.xml → OPF
    const containerEntry = zipFile(zip, 'META-INF/container.xml');
    if (!containerEntry) throw new Error('Ingen META-INF/container.xml – filen verkar inte vara en giltig EPUB.');
    const containerDoc = parseXml(await containerEntry.async('text'));
    const rootfile = q(containerDoc, 'rootfile');
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('Hittade ingen OPF-fil i EPUB:en.');

    const opfEntry = zipFile(zip, opfPath);
    if (!opfEntry) throw new Error('OPF-filen saknas i arkivet: ' + opfPath);
    const opfDoc = parseXml(await opfEntry.async('text'));
    const opfDir = dirOf(opfPath);

    // Metadata
    const meta = {
      title: (q(opfDoc, 'title') || {}).textContent || file.name.replace(/\.epub$/i, ''),
      author: qa(opfDoc, 'creator').map((c) => c.textContent.trim()).filter(Boolean).join(', '),
      language: (q(opfDoc, 'language') || {}).textContent || ''
    };

    // Manifest
    const manifest = {};
    for (const item of qa(opfDoc, 'item')) {
      manifest[item.getAttribute('id')] = {
        href: item.getAttribute('href'),
        type: item.getAttribute('media-type') || '',
        properties: item.getAttribute('properties') || ''
      };
    }

    // Omslag: properties="cover-image" eller <meta name="cover" content="id">
    let coverPath = null;
    for (const id in manifest) {
      if (manifest[id].properties.includes('cover-image')) {
        coverPath = resolvePath(opfDir, manifest[id].href);
        break;
      }
    }
    if (!coverPath) {
      for (const m of qa(opfDoc, 'meta')) {
        if ((m.getAttribute('name') || '') === 'cover') {
          const it = manifest[m.getAttribute('content')];
          if (it) coverPath = resolvePath(opfDir, it.href);
        }
      }
    }

    // Spine → läsordning
    const spine = [];
    for (const ref of qa(opfDoc, 'itemref')) {
      const it = manifest[ref.getAttribute('idref')];
      if (it && /xhtml|html/i.test(it.type)) {
        spine.push(resolvePath(opfDir, it.href));
      }
    }
    if (spine.length === 0) throw new Error('Boken saknar läsbara kapitel (tom spine).');

    let coverDataUrl = null;
    if (coverPath) {
      try { coverDataUrl = await imageAsDataUrl(zip, coverPath); } catch (e) { /* ok */ }
    }

    return { zip, opfDir, meta, spine, drm, coverDataUrl, fileName: file.name };
  }

  function parseChapterDoc(text) {
    let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      doc = new DOMParser().parseFromString(text, 'text/html');
    }
    return doc;
  }

  function firstHeadingText(doc) {
    for (const tag of ['h1', 'h2', 'h3', 'title']) {
      const el = doc.getElementsByTagName(tag)[0];
      if (el && el.textContent.trim()) return el.textContent.trim().replace(/\s+/g, ' ');
    }
    return null;
  }

  // ---------- HTML → pdfmake ----------
  const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'table', 'figure', 'figcaption', 'pre', 'hr', 'header', 'footer', 'main', 'aside', 'li', 'dl', 'dt', 'dd']);

  function inlineRuns(node, style, runs) {
    // Samlar text-runs med fet/kursiv-stil ur ett inline-träd.
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent.replace(/\s+/g, ' ');
        if (t) runs.push({ text: t, bold: style.bold, italics: style.italics, link: style.link, color: style.link ? '#2f5d50' : undefined, decoration: style.link ? 'underline' : undefined });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.localName;
        const next = { ...style };
        if (tag === 'b' || tag === 'strong') next.bold = true;
        if (tag === 'i' || tag === 'em' || tag === 'cite') next.italics = true;
        if (tag === 'a') {
          const href = child.getAttribute('href') || '';
          if (/^https?:/i.test(href)) next.link = href;
        }
        if (tag === 'br') { runs.push({ text: '\n' }); continue; }
        inlineRuns(child, next, runs);
      }
    }
    return runs;
  }

  function trimRuns(runs) {
    while (runs.length && typeof runs[0].text === 'string' && !runs[0].text.trim()) runs.shift();
    while (runs.length && typeof runs[runs.length - 1].text === 'string' && !runs[runs.length - 1].text.trim()) runs.pop();
    return runs;
  }

  async function nodeToBlocks(node, ctx) {
    // Omvandlar ett DOM-element till en lista pdfmake-block.
    const blocks = [];

    async function walk(el) {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent.trim();
          if (t) blocks.push({ text: t.replace(/\s+/g, ' '), style: 'para' });
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.localName;

        if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
          const runs = trimRuns(inlineRuns(child, {}, []));
          if (runs.length) {
            const block = { text: runs, style: 'h' + Math.min(3, Number(tag[1])) };
            if (tag === 'h1') {
              block.tocItem = true;
              if (ctx.h1Seen || ctx.chapterIndex > 0) block.pageBreak = 'before';
              ctx.h1Seen = true;
            }
            blocks.push(block);
          }
        } else if (tag === 'p') {
          const runs = trimRuns(inlineRuns(child, {}, []));
          if (runs.length) blocks.push({ text: runs, style: 'para' });
          // Bilder inuti stycken
          for (const img of child.getElementsByTagName('img')) await pushImage(img);
        } else if (tag === 'img' || tag === 'image') {
          await pushImage(child);
        } else if (tag === 'ul' || tag === 'ol') {
          const items = [];
          for (const li of child.children) {
            if (li.localName !== 'li') continue;
            const runs = trimRuns(inlineRuns(li, {}, []));
            if (runs.length) items.push({ text: runs, style: 'para' });
          }
          if (items.length) blocks.push(tag === 'ul' ? { ul: items, style: 'list' } : { ol: items, style: 'list' });
        } else if (tag === 'blockquote') {
          const runs = trimRuns(inlineRuns(child, { italics: true }, []));
          if (runs.length) blocks.push({ text: runs, style: 'quote' });
        } else if (tag === 'pre') {
          const t = child.textContent.replace(/\s+$/g, '');
          if (t.trim()) blocks.push({ text: t, style: 'pre' });
        } else if (tag === 'table') {
          try {
            const body = [];
            for (const tr of child.getElementsByTagName('tr')) {
              const row = [];
              for (const cell of tr.children) {
                if (cell.localName === 'td' || cell.localName === 'th') {
                  row.push({ text: cell.textContent.replace(/\s+/g, ' ').trim(), bold: cell.localName === 'th', fontSize: 9.5 });
                }
              }
              if (row.length) body.push(row);
            }
            const width = Math.max(...body.map((r) => r.length), 0);
            if (width > 0) {
              for (const row of body) while (row.length < width) row.push({ text: '' });
              blocks.push({ table: { body, widths: Array(width).fill('*') }, style: 'tbl', layout: 'lightHorizontalLines' });
            }
          } catch (e) { /* hoppa över trasiga tabeller */ }
        } else if (tag === 'hr') {
          blocks.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.5, lineColor: '#bbbbbb' }], margin: [0, 10, 0, 10] });
        } else if (tag === 'svg' || tag === 'script' || tag === 'style' || tag === 'nav') {
          continue; // hoppa över
        } else if (BLOCK_TAGS.has(tag) || child.children.length > 0) {
          await walk(child); // gå ner i containrar (div, section …)
        } else {
          const runs = trimRuns(inlineRuns(child, {}, []));
          if (runs.length) blocks.push({ text: runs, style: 'para' });
        }
      }
    }

    async function pushImage(imgEl) {
      const src = imgEl.getAttribute('src') || imgEl.getAttribute('href') ||
        imgEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!src || /^https?:/i.test(src)) return;
      const path = resolvePath(ctx.chapterDir, src);
      if (ctx.seenImages.has(path)) return;
      try {
        const raw = await imageAsDataUrl(ctx.zip, path);
        if (!raw) return;
        const safe = await toPdfSafeImage(raw);
        if (!safe) return;
        ctx.seenImages.add(path);
        blocks.push({ image: safe, fit: [430, 560], alignment: 'center', margin: [0, 8, 0, 8] });
      } catch (e) { /* bilden hoppas över */ }
    }

    await walk(node);
    return blocks;
  }

  // ---------- PDF-bygge ----------
  async function buildPdf() {
    const { zip, meta, spine, coverDataUrl, fileName } = book;
    const content = [];

    // Titelsida
    if (coverDataUrl) {
      const safeCover = await toPdfSafeImage(coverDataUrl);
      if (safeCover) content.push({ image: safeCover, fit: [360, 480], alignment: 'center', margin: [0, 40, 0, 30] });
    }
    content.push({ text: meta.title, fontSize: 26, bold: true, alignment: 'center', margin: [0, coverDataUrl ? 0 : 180, 0, 10] });
    if (meta.author) content.push({ text: meta.author, fontSize: 14, alignment: 'center', color: '#555555' });
    content.push({
      text: 'Konverterad från EPUB (' + fileName + ') · ' + new Date().toLocaleDateString('sv-SE'),
      fontSize: 9, alignment: 'center', color: '#999999', margin: [0, 14, 0, 0]
    });
    content.push({ toc: { title: { text: 'Innehåll', style: 'h1' } }, pageBreak: 'before' });

    // Kapitel
    const ctxShared = { zip, seenImages: new Set(), h1Seen: false };
    for (let i = 0; i < spine.length; i++) {
      setProgress(0.05 + 0.75 * (i / spine.length), 'Bearbetar kapitel ' + (i + 1) + ' av ' + spine.length + ' …');
      const entry = zipFile(zip, spine[i]);
      if (!entry) continue;
      const doc = parseChapterDoc(await entry.async('text'));
      const body = doc.body || doc.documentElement;
      if (!body) continue;
      const ctx = { ...ctxShared, chapterDir: dirOf(spine[i]), chapterIndex: i };
      const blocks = await nodeToBlocks(body, ctx);
      ctxShared.h1Seen = ctxShared.h1Seen || ctx.h1Seen;
      if (blocks.length && i > 0 && !(blocks[0] && blocks[0].pageBreak)) {
        blocks[0].pageBreak = 'before';
      }
      content.push(...blocks);
      // Ge webbläsaren luft mellan kapitlen
      await new Promise((r) => setTimeout(r, 0));
    }

    setProgress(0.85, 'Sätter samman PDF …');

    const docDefinition = {
      info: { title: meta.title, author: meta.author || undefined, creator: 'Converter (EPUB till PDF)' },
      pageSize: 'A4',
      pageMargins: [62, 66, 62, 66],
      content,
      styles: {
        h1: { fontSize: 20, bold: true, margin: [0, 0, 0, 14] },
        h2: { fontSize: 15, bold: true, margin: [0, 16, 0, 8] },
        h3: { fontSize: 12.5, bold: true, margin: [0, 12, 0, 6] },
        para: { fontSize: 10.5, lineHeight: 1.4, margin: [0, 0, 0, 7], alignment: 'justify' },
        list: { fontSize: 10.5, lineHeight: 1.35, margin: [8, 0, 0, 8] },
        quote: { fontSize: 10.5, italics: true, margin: [24, 4, 24, 10], color: '#444444' },
        pre: { fontSize: 9, margin: [12, 4, 12, 10], color: '#333333' },
        tbl: { margin: [0, 6, 0, 10] }
      },
      footer: (currentPage, pageCount) => ({
        text: currentPage + ' / ' + pageCount,
        alignment: 'center', fontSize: 8.5, color: '#999999', margin: [0, 20, 0, 0]
      })
    };

    setProgress(0.92, 'Skapar filen …');
    const outName = slugify(meta.title) + '.pdf';
    await new Promise((resolve, reject) => {
      try {
        pdfMake.createPdf(docDefinition).download(outName, resolve);
      } catch (e) { reject(e); }
    });
    setProgress(1, 'Klart! ' + outName + ' har laddats ner.');
  }

  // ---------- Utskriftsvy (högsta trohet via webbläsarens PDF-motor) ----------
  async function openPrintView() {
    const { zip, meta, spine, coverDataUrl } = book;
    setProgress(0.1, 'Bygger utskriftsvy …');

    let html = '';
    if (coverDataUrl) html += '<div class="cover"><img src="' + coverDataUrl + '" alt=""></div>';
    html += '<div class="titlepage"><h1>' + escapeHtml(meta.title) + '</h1>' +
      (meta.author ? '<p class="author">' + escapeHtml(meta.author) + '</p>' : '') + '</div>';

    for (let i = 0; i < spine.length; i++) {
      setProgress(0.1 + 0.8 * (i / spine.length), 'Bearbetar kapitel ' + (i + 1) + ' av ' + spine.length + ' …');
      const entry = zipFile(zip, spine[i]);
      if (!entry) continue;
      const doc = parseChapterDoc(await entry.async('text'));
      const body = doc.body || doc.documentElement;
      if (!body) continue;

      // Bädda in bilder som data-URL:er så vyn är självständig
      const chapterDir = dirOf(spine[i]);
      for (const img of Array.from(body.getElementsByTagName('img'))) {
        const src = img.getAttribute('src');
        if (!src || /^(https?:|data:)/i.test(src)) continue;
        const dataUrl = await imageAsDataUrl(zip, resolvePath(chapterDir, src));
        if (dataUrl) img.setAttribute('src', dataUrl); else img.remove();
      }
      for (const bad of Array.from(body.querySelectorAll('script, link'))) bad.remove();
      html += '<section class="chapter">' + body.innerHTML + '</section>';
      await new Promise((r) => setTimeout(r, 0));
    }

    const win = window.open('', '_blank');
    if (!win) { showError('Webbläsaren blockerade fönstret – tillåt popup-fönster och försök igen.'); progress.hidden = true; return; }
    win.document.write('<!DOCTYPE html><html lang="sv"><head><meta charset="utf-8"><title>' +
      escapeHtml(meta.title) + '</title><style>' +
      'body{font-family:Georgia,"Times New Roman",serif;max-width:42em;margin:2em auto;padding:0 1.5em;line-height:1.55;color:#111}' +
      'img{max-width:100%;height:auto}' +
      '.cover img{display:block;margin:0 auto;max-height:90vh}' +
      '.titlepage{text-align:center;margin:30vh 0 30vh;page-break-after:always}' +
      '.titlepage h1{font-size:2.2em;margin-bottom:.3em}' +
      '.author{color:#555;font-size:1.15em}' +
      '.chapter{page-break-before:always}' +
      '.printhint{position:fixed;top:12px;right:12px;background:#2f5d50;color:#fff;border:none;' +
      'padding:10px 18px;border-radius:8px;font-family:sans-serif;font-size:14px;cursor:pointer}' +
      '@media print{.printhint{display:none}body{margin:0;max-width:none}}' +
      '</style></head><body>' +
      '<button class="printhint" onclick="window.print()">Spara som PDF (⌘P)</button>' +
      html + '</body></html>');
    win.document.close();
    setProgress(1, 'Utskriftsvyn är öppnad i en ny flik – välj ”Spara som PDF” i utskriftsdialogen.');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------- UI-flöde ----------
  async function handleFile(file) {
    if (!file) return;
    if (!/\.epub$/i.test(file.name)) {
      loadStatus.textContent = 'Välj en .epub-fil.';
      return;
    }
    try {
      loadStatus.textContent = '';
      book = await openEpub(file);
    } catch (e) {
      console.error(e);
      loadStatus.textContent = 'Kunde inte läsa filen: ' + e.message;
      return;
    }

    // Fyll granskningskortet
    bookTitle.textContent = book.meta.title;
    bookAuthor.textContent = book.meta.author || 'Okänd författare';
    bookStats.textContent = book.spine.length + ' avsnitt · ' + Math.round(file.size / 1024 / 1024 * 10) / 10 + ' MB' +
      (book.meta.language ? ' · ' + book.meta.language : '');
    bookCover.style.backgroundImage = book.coverDataUrl ? 'url("' + book.coverDataUrl + '")' : '';

    if (book.drm) {
      drmStatus.textContent = 'Kopieringsskydd upptäckt: ' + book.drm + ' – kan inte konverteras';
      drmStatus.className = 'badge warn';
      btnPdf.disabled = true;
      btnPrint.disabled = true;
    } else {
      drmStatus.textContent = 'Ingen DRM upptäckt';
      drmStatus.className = 'badge ok';
      btnPdf.disabled = false;
      btnPrint.disabled = false;
    }

    // Kapitelrubriker
    chapterList.innerHTML = '';
    chapterCount.textContent = '(' + book.spine.length + ' avsnitt)';
    const maxList = Math.min(book.spine.length, 60);
    for (let i = 0; i < maxList; i++) {
      const entry = zipFile(book.zip, book.spine[i]);
      let label = book.spine[i].split('/').pop();
      if (entry) {
        try {
          const t = firstHeadingText(parseChapterDoc(await entry.async('text')));
          if (t) label = t;
        } catch (e) { /* behåll filnamnet */ }
      }
      const li = document.createElement('li');
      li.textContent = label;
      chapterList.appendChild(li);
    }
    if (book.spine.length > maxList) {
      const li = document.createElement('li');
      li.textContent = '… och ' + (book.spine.length - maxList) + ' till';
      chapterList.appendChild(li);
    }

    stepReview.hidden = false;
    stepConvert.hidden = false;
    progress.hidden = true;
    loadStatus.textContent = '';
    stepReview.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function convert(fn) {
    convertError.hidden = true;
    btnPdf.disabled = true;
    btnPrint.disabled = true;
    try {
      await fn();
    } catch (e) {
      console.error(e);
      showError('Något gick fel vid konverteringen: ' + e.message);
      progress.hidden = true;
    } finally {
      if (!book.drm) { btnPdf.disabled = false; btnPrint.disabled = false; }
    }
  }

  // ---------- Händelser ----------
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  btnPdf.addEventListener('click', () => convert(buildPdf));
  btnPrint.addEventListener('click', () => convert(openPrintView));
})();
