// TraceDesk PDF Editor for PCs. Edits are laid on top of the original pages; nothing else in the PDF changes.
import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.mjs';
const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = window.PDFLib;

const TEXT_SIZES = [0.018, 0.025, 0.035];     // fraction of the page width
const PEN = [0.0025, 0.004, 0.007];
const STAMP = [0.025, 0.035, 0.05];
const PAD = 0.18;                              // cover a little beyond a changed line (fraction of its height)
const STRETCH = 1.10;                          // longer text may run 10% past the old line, then gets smaller

const $ = (id) => document.getElementById(id);
const S = { bytes: null, name: '', pdf: null, pages: [], tool: 'edit', color: '#000000', size: 1, zoom: 1, history: [], dirty: false, ocr: null, editing: null };

// ------------------------------------------------------------------ helpers
const hint = (t) => { $('hint').textContent = t; };
const busy = (t) => { const b = $('busy'); b.textContent = t || ''; b.style.display = t ? 'block' : 'none'; };
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const css = (c) => Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : c;
const toPdfColor = (c) => { const a = Array.isArray(c) ? c : hexToRgb(c); return rgb(a[0] / 255, a[1] / 255, a[2] / 255); };
function tailsOf(s) { if (/[gjpqyQ;()\[\]{}|\/_@$]/.test(s)) return 2; if (s.includes(',')) return 1; return 0; }
const isNumber = (s) => /^[\d.,\s%$:\/-]+$/.test(s.trim());
function fontCss(m, px) { return `${m.bold ? 'bold ' : ''}${px}px ${m.serif ? '"Times New Roman", Times, serif' : 'Helvetica, Arial, sans-serif'}`; }

const TOOL_HINTS = {
  edit: 'Edit text: click a line in a blue box and type. Enter applies, Esc cancels. The layout stays as it is.',
  add: 'Add text: click where the text should start, type, press Enter. Click your text to change it; drag it to move it.',
  pen: 'Pen / sign: write or sign with the mouse, pen or finger.',
  white: 'White-out: drag a box over what you want to cover.',
  highlight: 'Highlight: drag a box over the words.',
  tick: 'Tick: click where the tick goes.',
  cross: 'Cross: click where the cross goes.',
};

// ------------------------------------------------------------------ opening
$('btnOpen').onclick = $('btnOpen2').onclick = () => { if (confirmLeave()) $('fileInput').click(); };
$('fileInput').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) openFiles(f); };
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
window.addEventListener('dragleave', () => document.body.classList.remove('drop'));
window.addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('drop');
  const f = [...e.dataTransfer.files].filter((x) => x.type === 'application/pdf' || x.type.startsWith('image/') || /\.pdf$/i.test(x.name));
  if (f.length && confirmLeave()) openFiles(f);
});
function confirmLeave() { return !S.dirty || confirm('Your edits are not saved yet. Continue anyway?'); }
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

async function openFiles(files) {
  busy('Opening…');
  try {
    const first = files[0];
    let bytes;
    if (first.type === 'application/pdf' || /\.pdf$/i.test(first.name)) bytes = new Uint8Array(await first.arrayBuffer());
    else bytes = await imagesToPdf(files.filter((f) => f.type.startsWith('image/')));
    S.bytes = bytes;
    S.name = first.name.replace(/\.[^.]+$/, '');
    S.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    S.history = []; S.dirty = false; S.pages = [];
    $('fileName').textContent = first.name + (files.length > 1 ? ` (+${files.length - 1})` : '');
    $('empty').style.display = 'none';
    $('btnSave').disabled = false;
    const holder = $('pages'); holder.innerHTML = '';
    for (let i = 0; i < S.pdf.numPages; i++) {
      const page = await S.pdf.getPage(i + 1);
      const el = document.createElement('div'); el.className = 'page';
      const num = document.createElement('div'); num.className = 'num'; num.textContent = `Page ${i + 1} of ${S.pdf.numPages}`;
      const canvas = document.createElement('canvas'); const overlay = document.createElement('canvas');
      el.append(num, canvas, overlay); holder.append(el);
      const P = { i, page, base: page.getViewport({ scale: 1 }), el, canvas, overlay, marks: [], lines: null, hover: null, task: null };
      S.pages.push(P);
      wirePointer(P);
    }
    await layoutAll();
    setTool(S.tool);
    S.pages.forEach(findLines);
  } catch (err) {
    console.error(err);
    hint('Could not open this file: ' + (err && err.message ? err.message : err) + (String(err).includes('assword') ? ' (it is protected with a password)' : ''));
  } finally { busy(''); }
}

async function imagesToPdf(files) {
  const doc = await PDFDocument.create();
  for (const f of files) {
    const bmp = await createImageBitmap(f);
    const s = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const pw = 595, ph = pw * c.height / c.width;
    doc.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  }
  return await doc.save();
}

// ------------------------------------------------------------------ showing pages
function fitWidth() { return Math.min($('viewer').clientWidth - 48, 1000); }
async function layoutAll() {
  const fw = fitWidth();
  for (const P of S.pages) {
    P.w = Math.round(fw * S.zoom); P.h = Math.round(P.w * P.base.height / P.base.width);
    P.el.style.width = P.w + 'px'; P.el.style.height = P.h + 'px';
  }
  for (const P of S.pages) await renderPage(P);
  $('zoomVal').textContent = Math.round(S.zoom * 100) + '%';
}
async function renderPage(P) {
  const dpr = window.devicePixelRatio || 1;
  const vp = P.page.getViewport({ scale: (P.w / P.base.width) * dpr });
  for (const c of [P.canvas, P.overlay]) {
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    c.style.width = P.w + 'px'; c.style.height = P.h + 'px';
  }
  if (P.task) { try { P.task.cancel(); } catch (e) { /* ignore */ } }
  P.task = P.page.render({ canvasContext: P.canvas.getContext('2d'), viewport: vp });
  try { await P.task.promise; } catch (e) { /* cancelled by a newer render */ }
  draw(P);
}
$('btnZoomIn').onclick = () => { S.zoom = Math.min(3, +(S.zoom + 0.25).toFixed(2)); closeEditor(); layoutAll(); };
$('btnZoomOut').onclick = () => { S.zoom = Math.max(0.5, +(S.zoom - 0.25).toFixed(2)); closeEditor(); layoutAll(); };
let rT; window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => { if (S.pages.length) layoutAll(); }, 250); });

// ------------------------------------------------------------------ finding the page's own text
async function findLines(P) {
  try {
    const tc = await P.page.getTextContent();
    const W = P.base.width, H = P.base.height, items = [];
    let chars = 0;
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(P.base.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]);
      if (h < 2 || Math.abs(tx[1]) > 0.05 * h) continue;          // skip turned text
      const st = tc.styles[it.fontName] || {};
      let fo = null; try { if (P.page.commonObjs.has(it.fontName)) fo = P.page.commonObjs.get(it.fontName); } catch (e) { /* not loaded */ }
      const fname = (fo && fo.name) || '';
      const bold = !!(fo && (fo.bold || fo.black)) || /bold|black|heavy|semibold|demi/i.test(fname);
      const serif = /times|georgia|garamond|cambria|serif/i.test(fname) && !/sans/i.test(fname) || (/serif/i.test(st.fontFamily || '') && !/sans/i.test(st.fontFamily || ''));
      items.push({ x: tx[4], y: tx[5], w: it.width * P.base.scale, h, s: it.str, serif, bold });
      chars += it.str.trim().length;
    }
    if (chars >= 12) {
      items.sort((a, b) => (Math.abs(a.y - b.y) < 0.3 * Math.min(a.h, b.h) ? a.x - b.x : a.y - b.y));
      const lines = [];
      for (const it of items) {
        const L = lines[lines.length - 1];
        if (L && Math.abs(L.y - it.y) < 0.3 * Math.min(L.h, it.h) && it.x - L.x1 < 0.9 * L.h && it.x >= L.x0) {
          const gap = it.x - L.x1;
          L.text += (gap > 0.15 * L.h && !L.text.endsWith(' ') && !it.s.startsWith(' ') ? ' ' : '') + it.s;
          L.x1 = Math.max(L.x1, it.x + it.w);
        } else lines.push({ x0: it.x, x1: it.x + it.w, y: it.y, h: it.h, text: it.s, serif: it.serif, bold: it.bold });
      }
      P.lines = lines.filter((L) => L.text.trim()).map((L) => ({
        l: L.x0 / W, r: L.x1 / W, t: (L.y - 0.80 * L.h) / H, b: (L.y + 0.22 * L.h) / H,
        text: L.text.trim(), size: L.h / H, base: L.y / H, serif: L.serif, bold: L.bold, src: 'pdf',
      }));
    } else {
      P.lines = [];
      await ocrPage(P);
    }
  } catch (e) { console.warn(e); P.lines = P.lines || []; }
  draw(P);
  if (S.tool === 'edit') setTool('edit');
}

async function ocrPage(P) {
  busy(`Reading the text on page ${P.i + 1} (scan)…`);
  try {
    if (!S.ocr) S.ocr = await Tesseract.createWorker('eng', 1, {
      workerPath: new URL('./lib/worker.min.js', location.href).href,
      corePath: new URL('./lib/core/', location.href).href,
      langPath: new URL('./lib/lang', location.href).href,
      gzip: true,
    });
    const scale = Math.min(2.5, 2400 / P.base.width);
    const vp = P.page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await P.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const { data } = await S.ocr.recognize(c);
    const out = [];
    const push = (text, bb) => {
      text = text.trim(); if (!text) return;
      const t = bb.y0 / c.height, b = bb.y1 / c.height, hN = b - t;
      const tails = tailsOf(text);
      const sizeOfBox = tails === 0 ? 1.33 : tails === 1 ? 1.18 : 1.0;
      const up = tails === 0 ? 0 : tails === 1 ? 0.12 : 0.20;
      out.push({ l: bb.x0 / c.width, r: bb.x1 / c.width, t, b, text, size: hN * sizeOfBox, base: b - up * hN, serif: false, src: 'scan' });
    };
    for (const ln of (data.lines || [])) {
      if (!(ln.text || '').trim() || (ln.confidence !== undefined && ln.confidence < 30)) continue;
      const words = (ln.words || []).filter((w) => (w.text || '').trim());
      if (!words.length) { push(ln.text, ln.bbox); continue; }
      // a wide gap between words means a new cell (tables): each cell can be changed on its own
      const lh = ln.bbox.y1 - ln.bbox.y0;
      let seg = null;
      for (const w of words) {
        if (seg && w.bbox.x0 - seg.bb.x1 < 1.1 * lh) {
          seg.text += ' ' + w.text;
          seg.bb = { x0: seg.bb.x0, y0: Math.min(seg.bb.y0, w.bbox.y0), x1: w.bbox.x1, y1: Math.max(seg.bb.y1, w.bbox.y1) };
        } else { if (seg) push(seg.text, seg.bb); seg = { text: w.text, bb: { ...w.bbox } }; }
      }
      if (seg) push(seg.text, seg.bb);
    }
    P.lines = out;
  } catch (e) { console.warn(e); hint('Could not read the text on this scan. Use Add text and White-out instead.'); P.lines = []; }
  finally { busy(''); }
}

/** Background and text colour around a line, read from the page picture; ink = share of the line covered (bold covers more). */
function sampleColors(P, L) {
  const c = P.canvas, ctx = c.getContext('2d', { willReadFrequently: true });
  const l = Math.max(0, Math.floor(L.l * c.width)), r = Math.min(c.width, Math.ceil(L.r * c.width));
  const t = Math.max(0, Math.floor(L.t * c.height)), b = Math.min(c.height, Math.ceil(L.b * c.height));
  const pad = Math.max(2, Math.round((b - t) * 0.25));
  const X0 = Math.max(0, l - pad), Y0 = Math.max(0, t - pad), X1 = Math.min(c.width, r + pad), Y1 = Math.min(c.height, b + pad);
  if (X1 - X0 < 2 || Y1 - Y0 < 2) return { fg: [0, 0, 0], bg: [255, 255, 255], ink: 0 };
  const d = ctx.getImageData(X0, Y0, X1 - X0, Y1 - Y0).data, w = X1 - X0;
  const px = (x, y) => { const k = ((y - Y0) * w + (x - X0)) * 4; return [d[k], d[k + 1], d[k + 2]]; };
  const ring = [];
  for (let x = X0; x < X1; x += 2) { ring.push(px(x, Y0)); ring.push(px(x, Y1 - 1)); }
  for (let y = Y0; y < Y1; y += 2) { ring.push(px(X0, y)); ring.push(px(X1 - 1, y)); }
  const med = (k) => ring.map((p) => p[k]).sort((a, b2) => a - b2)[ring.length >> 1];
  const bg = [med(0), med(1), med(2)];
  const dist = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
  const inside = [];
  for (let y = t; y < b; y++) for (let x = l; x < r; x++) inside.push(px(x, y));
  if (!inside.length) return { fg: [0, 0, 0], bg, ink: 0 };
  const far = inside.slice().sort((a, b2) => dist(b2) - dist(a)).slice(0, Math.max(1, inside.length / 12 | 0));
  const fg = [0, 1, 2].map((k) => Math.round(far.reduce((s, p) => s + p[k], 0) / far.length));
  const md = Math.max(1, dist(fg));
  const ink = inside.filter((p) => dist(p) > md / 2).length / inside.length;
  return { fg, bg, ink };
}

/** On scans, measures the real height of the letters in a line, so new words get the same size and baseline. */
function refineScanLine(P, L, col) {
  if (L.refined) return; L.refined = true;
  const c = P.canvas, ctx = c.getContext('2d', { willReadFrequently: true });
  const hpx = (L.b - L.t) * c.height;
  const l = Math.max(0, Math.floor(L.l * c.width)), r = Math.min(c.width, Math.ceil(L.r * c.width));
  const t = Math.max(0, Math.floor(L.t * c.height - 0.3 * hpx)), b = Math.min(c.height, Math.ceil(L.b * c.height + 0.3 * hpx));
  if (r - l < 2 || b - t < 2) return;
  const d = ctx.getImageData(l, t, r - l, b - t).data, w = r - l;
  const bg = col.bg, md = Math.max(30, Math.abs(col.fg[0] - bg[0]) + Math.abs(col.fg[1] - bg[1]) + Math.abs(col.fg[2] - bg[2]));
  const rows = [];
  for (let y = 0; y < b - t; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) { const k = (y * w + x) * 4; if (Math.abs(d[k] - bg[0]) + Math.abs(d[k + 1] - bg[1]) + Math.abs(d[k + 2] - bg[2]) > md / 2) n++; }
    rows.push(n > 0);
  }
  // the run of inked rows around the middle of the line (stops at the gap before the next line)
  const mid = Math.round((L.t + L.b) / 2 * c.height) - t;
  let s0 = -1;
  for (let k = 0; k <= Math.round(0.3 * hpx) + 2 && s0 < 0; k++) { if (rows[mid + k]) s0 = mid + k; else if (rows[mid - k]) s0 = mid - k; }
  if (s0 < 0) return;
  let top = s0, bot = s0 + 1;
  while (top > 0 && (rows[top - 1] || (top > 1 && rows[top - 2] && hpx > 14))) top--;
  while (bot < rows.length && (rows[bot] || (bot + 1 < rows.length && rows[bot + 1] && hpx > 14))) bot++;
  const inkT = (t + top) / c.height, inkB = (t + bot) / c.height, inkH = inkB - inkT;
  const tails = tailsOf(L.text);
  if (tails === 2) { L.size = inkH / 0.93; L.base = inkB - 0.21 * L.size; }
  else if (tails === 1) { L.size = inkH / 0.82; L.base = inkB - 0.10 * L.size; }
  else { L.size = inkH / 0.72; L.base = inkB; }
  L.t = Math.min(L.t, inkT); L.b = Math.max(L.b, inkB);
}

// ------------------------------------------------------------------ drawing the edits
function draw(P) {
  const c = P.overlay, ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  for (const m of P.marks) drawMark(ctx, m, W, H);
  if (P.current) drawMark(ctx, P.current, W, H);
  if (S.tool === 'edit' && P.lines) {
    for (const L of P.lines) {
      if (P.marks.some((m) => m.type === 'replace' && m.line === L)) continue;
      ctx.strokeStyle = L === P.hover ? 'rgba(37,99,235,0.95)' : 'rgba(37,99,235,0.35)';
      ctx.lineWidth = L === P.hover ? 2.5 : 1.5;
      ctx.strokeRect(L.l * W - 2, L.t * H - 2, (L.r - L.l) * W + 4, (L.b - L.t) * H + 4);
    }
  }
}
function drawMark(ctx, m, W, H) {
  ctx.save();
  if (m.type === 'replace') {
    const bh = (m.b - m.t) * H, pad = PAD * bh;
    ctx.fillStyle = css(m.bg);
    ctx.fillRect(m.l * W - pad, m.t * H - pad, (m.r - m.l) * W + 2 * pad, bh + 2 * pad);
    let px = m.size * H; ctx.font = fontCss(m, px);
    let tw = ctx.measureText(m.text).width; const room = (m.r - m.l) * W * STRETCH;
    if (tw > room && tw > 0) { px *= room / tw; ctx.font = fontCss(m, px); tw = room; }
    ctx.fillStyle = css(m.fg); ctx.textBaseline = 'alphabetic';
    ctx.fillText(m.text, m.alignRight ? m.r * W - tw : m.l * W, m.base * H);
  } else if (m.type === 'box') {
    const x = Math.min(m.l, m.r) * W, y = Math.min(m.t, m.b) * H, w = Math.abs(m.r - m.l) * W, h = Math.abs(m.b - m.t) * H;
    ctx.fillStyle = m.highlight ? 'rgba(255,225,0,0.38)' : '#fff';
    ctx.fillRect(x, y, w, h);
    if (!m.highlight) { ctx.setLineDash([6, 4]); ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.strokeRect(x, y, w, h); }
  } else if (m.type === 'ink') {
    ctx.strokeStyle = m.color; ctx.lineWidth = Math.max(1.5, m.width * W); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of m.strokes) {
      ctx.beginPath(); ctx.moveTo(s[0][0] * W, s[0][1] * H);
      if (s.length === 1) ctx.lineTo(s[0][0] * W + 0.5, s[0][1] * H);
      for (let k = 1; k < s.length; k++) ctx.lineTo(s[k][0] * W, s[k][1] * H);
      ctx.stroke();
    }
  } else if (m.type === 'text') {
    const px = m.size * W; ctx.font = `${px}px Helvetica, Arial, sans-serif`; ctx.fillStyle = m.color;
    m.text.split('\n').forEach((line, i) => ctx.fillText(line, m.x * W, m.y * H + (0.8 + i * 1.2) * px));
    if (m === S.dragging) { const bb = textBounds(m, W, H); ctx.setLineDash([5, 4]); ctx.strokeStyle = '#2563EB'; ctx.strokeRect(bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]); }
  }
  ctx.restore();
}
function textBounds(m, W, H) {
  const ctx = document.createElement('canvas').getContext('2d'); const px = m.size * W;
  ctx.font = `${px}px Helvetica, Arial, sans-serif`;
  const lines = m.text.split('\n'); const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  return [m.x * W - 6, m.y * H - 6, m.x * W + tw + 6, m.y * H + lines.length * 1.2 * px + 6];
}

// ------------------------------------------------------------------ mouse / pen
function wirePointer(P) {
  const o = P.overlay;
  const norm = (e) => { const r = o.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  let down = null, moved = false, start = null;
  o.addEventListener('pointermove', (e) => {
    const [x, y] = norm(e);
    if (!down) {
      if (S.tool === 'edit' && P.lines) {
        const h = lineAt(P, x, y); if (h !== P.hover) { P.hover = h; o.style.cursor = h || replaceAt(P, x, y) ? 'text' : 'default'; draw(P); }
      } else o.style.cursor = S.tool === 'add' ? 'text' : 'crosshair';
      return;
    }
    if (Math.abs(e.clientX - down[0]) + Math.abs(e.clientY - down[1]) > 4) moved = true;
    const cur = P.current;
    if (S.tool === 'pen' && cur) cur.strokes[0].push([x, y]);
    else if ((S.tool === 'white' || S.tool === 'highlight') && cur) { cur.r = x; cur.b = y; }
    else if (S.tool === 'add' && S.dragging && moved) { S.dragging.x = start[0] + (x - start[2]); S.dragging.y = start[1] + (y - start[3]); }
    draw(P);
  });
  o.addEventListener('pointerdown', (e) => {
    if (!S.pages.length) return;
    if (S.editing) { applyEditor(); }
    o.setPointerCapture(e.pointerId);
    const [x, y] = norm(e); down = [e.clientX, e.clientY]; moved = false;
    if (S.tool === 'pen') P.current = { type: 'ink', strokes: [[[x, y]]], color: S.color, width: PEN[S.size] };
    else if (S.tool === 'white' || S.tool === 'highlight') P.current = { type: 'box', l: x, t: y, r: x, b: y, highlight: S.tool === 'highlight' };
    else if (S.tool === 'add') { S.dragging = textAt(P, x, y); if (S.dragging) start = [S.dragging.x, S.dragging.y, x, y]; }
  });
  o.addEventListener('pointerup', (e) => {
    if (!down) return;
    const [x, y] = norm(e); down = null;
    const W = P.overlay.width, H = P.overlay.height;
    if (S.tool === 'pen' && P.current) addMark(P, P.current);
    else if ((S.tool === 'white' || S.tool === 'highlight') && P.current) {
      const m = P.current; if (Math.abs(m.r - m.l) * W > 10 && Math.abs(m.b - m.t) * H > 6) addMark(P, m);
    } else if (S.tool === 'tick' || S.tool === 'cross') {
      const s = STAMP[S.size], ar = W / H;
      const strokes = S.tool === 'tick'
        ? [[[x - s * 0.5, y], [x - s * 0.15, y + s * 0.4 * ar], [x + s * 0.6, y - s * 0.55 * ar]]]
        : [[[x - s * 0.45, y - s * 0.45 * ar], [x + s * 0.45, y + s * 0.45 * ar]], [[x + s * 0.45, y - s * 0.45 * ar], [x - s * 0.45, y + s * 0.45 * ar]]];
      addMark(P, { type: 'ink', strokes, color: S.color, width: PEN[S.size] * 1.6 });
    } else if (S.tool === 'add') {
      const d = S.dragging; S.dragging = null;
      if (d && moved) S.dirty = true;
      else if (d) openEditor(P, { mode: 'text', mark: d });
      else if (!moved) openEditor(P, { mode: 'text', x, y });
    } else if (S.tool === 'edit' && !moved) {
      const r = replaceAt(P, x, y);
      if (r) openEditor(P, { mode: 'replace', mark: r });
      else { const L = lineAt(P, x, y); if (L) openEditor(P, { mode: 'replace', line: L }); }
    }
    P.current = null; draw(P);
  });
}
const lineAt = (P, x, y) => (P.lines || []).filter((L) => x >= L.l - 0.005 && x <= L.r + 0.005 && y >= L.t - 0.004 && y <= L.b + 0.004)
  .sort((a, b) => (a.b - a.t) - (b.b - b.t))[0] || null;
const replaceAt = (P, x, y) => [...P.marks].reverse().find((m) => m.type === 'replace' && x >= m.l - 0.005 && x <= m.r + 0.005 && y >= m.t - 0.004 && y <= m.b + 0.004) || null;
const textAt = (P, x, y) => { const W = P.overlay.width, H = P.overlay.height; return [...P.marks].reverse().find((m) => { if (m.type !== 'text') return false; const b = textBounds(m, W, H); return x * W >= b[0] && x * W <= b[2] && y * H >= b[1] && y * H <= b[3]; }) || null; };
function addMark(P, m) { P.marks.push(m); S.history.push([P, m]); S.dirty = true; draw(P); }

// ------------------------------------------------------------------ the inline editor (like typing in Word)
const ed = $('editor'), edInput = $('edInput');
function openEditor(P, o) {
  closeEditor();
  S.editing = { P, ...o };
  P.el.appendChild(ed);
  const W = P.w, H = P.h;
  let text = '', l, t, w, h, px, bold = false, serif = false;
  if (o.mode === 'replace') {
    const src = o.mark || o.line;
    text = o.mark ? o.mark.text : o.line.text;
    if (o.mark) { bold = o.mark.bold; serif = o.mark.serif; }
    else { const col = sampleColors(P, o.line); S.editing.col = col; if (o.line.src === 'scan') refineScanLine(P, o.line, col); bold = o.line.bold !== undefined ? o.line.bold : col.ink > 0.31; serif = !!o.line.serif; S.editing.bold0 = bold; }
    l = src.l * W; t = src.t * H; w = Math.max((src.r - src.l) * W * 1.25 + 30, 140); h = (src.b - src.t) * H; px = Math.max(10, src.size * H * 0.95);
    $('edOrig').hidden = !o.mark; $('edDel').hidden = true;
  } else {
    const m = o.mark;
    text = m ? m.text : '';
    px = Math.max(10, (m ? m.size : TEXT_SIZES[S.size]) * W);
    l = (m ? m.x : o.x) * W; t = (m ? m.y : o.y) * H; w = Math.max(260, m ? textBounds(m, P.overlay.width, P.overlay.height)[2] / (P.overlay.width / W) - l + 40 : 260); h = px * 1.25;
    $('edOrig').hidden = true; $('edDel').hidden = !m;
  }
  $('edBold').checked = bold; $('edSerif').checked = serif;
  $('edBold').parentElement.hidden = $('edSerif').parentElement.hidden = o.mode !== 'replace';
  ed.style.display = 'block';
  ed.style.left = Math.max(0, l - 4) + 'px'; ed.style.top = Math.max(0, t - 4) + 'px';
  edInput.style.width = Math.min(w, W - l + 4) + 'px'; edInput.style.height = Math.max(h + 8, px * 1.3) + 'px';
  edInput.style.font = `${bold ? 'bold ' : ''}${px}px ${serif ? '"Times New Roman", serif' : 'Helvetica, Arial, sans-serif'}`;
  edInput.value = text;
  setTimeout(() => { edInput.focus(); edInput.select(); }, 0);
}
function closeEditor() { ed.style.display = 'none'; S.editing = null; }
function applyEditor() {
  const E = S.editing; if (!E) return;
  const P = E.P, txt = edInput.value.replace(/\s+$/, '');
  if (E.mode === 'replace') {
    if (E.mark) {
      E.mark.text = txt; E.mark.bold = $('edBold').checked; E.mark.serif = $('edSerif').checked; S.dirty = true;
    } else if (txt !== E.line.text || $('edBold').checked !== E.bold0 || $('edSerif').checked !== !!E.line.serif) {
      const L = E.line, col = E.col;
      addMark(P, { type: 'replace', line: L, l: L.l, t: L.t, r: L.r, b: L.b, text: txt, fg: col.fg, bg: col.bg,
        bold: $('edBold').checked, serif: $('edSerif').checked, alignRight: isNumber(L.text), size: L.size, base: L.base });
    }
  } else {
    if (E.mark) { if (txt) { E.mark.text = txt; S.dirty = true; } else removeMark(P, E.mark); }
    else if (txt) addMark(P, { type: 'text', x: E.x, y: E.y, text: txt, color: S.color, size: TEXT_SIZES[S.size] });
  }
  closeEditor(); draw(P);
}
function removeMark(P, m) { P.marks = P.marks.filter((x) => x !== m); S.history = S.history.filter((h) => h[1] !== m); S.dirty = true; draw(P); }
edInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyEditor(); }
  else if (e.key === 'Escape') { e.preventDefault(); const P = S.editing && S.editing.P; closeEditor(); if (P) draw(P); }
});
$('edOk').onclick = applyEditor;
$('edCancel').onclick = () => { const P = S.editing && S.editing.P; closeEditor(); if (P) draw(P); };
$('edOrig').onclick = () => { const E = S.editing; if (E && E.mark) { removeMark(E.P, E.mark); } closeEditor(); };
$('edDel').onclick = () => { const E = S.editing; if (E && E.mark) { removeMark(E.P, E.mark); } closeEditor(); };
ed.addEventListener('pointerdown', (e) => e.stopPropagation());
for (const id of ['edBold', 'edSerif']) $(id).onchange = () => {
  const px = parseFloat(edInput.style.font) || 14;
  edInput.style.font = `${$('edBold').checked ? 'bold ' : ''}${px}px ${$('edSerif').checked ? '"Times New Roman", serif' : 'Helvetica, Arial, sans-serif'}`;
  edInput.focus();
};

// ------------------------------------------------------------------ toolbar
function setTool(t) {
  S.tool = t; closeEditor();
  document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  if (!S.pages.length) { hint('Open a PDF or a photo to start. You can also drag a file onto this window.'); return; }
  let msg = TOOL_HINTS[t];
  if (t === 'edit') {
    const waiting = S.pages.some((P) => P.lines === null);
    const none = S.pages.every((P) => P.lines && P.lines.length === 0);
    if (waiting) msg = 'Edit text: finding the text on the pages…';
    else if (none) msg = 'Edit text: no text found. Use Add text and White-out instead.';
  }
  hint(msg);
  S.pages.forEach(draw);
}
document.querySelectorAll('.tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
document.querySelectorAll('.swatch').forEach((b) => (b.onclick = () => {
  S.color = b.dataset.color; document.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
document.querySelectorAll('.size').forEach((b) => (b.onclick = () => {
  S.size = +b.dataset.size; document.querySelectorAll('.size').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
function undo() {
  const last = S.history.pop(); if (!last) { hint('Nothing to undo.'); return; }
  const [P, m] = last; P.marks = P.marks.filter((x) => x !== m); draw(P);
  S.dirty = S.pages.some((p) => p.marks.length);
}
$('btnUndo').onclick = undo;
window.addEventListener('keydown', (e) => {
  if (S.editing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});

// ------------------------------------------------------------------ saving
$('btnSave').onclick = () => save();
function printable(s, font) {
  let out = '';
  for (let ch of s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\t/g, ' ')) {
    try { font.encodeText(ch); out += ch; } catch (e) { out += '?'; }
  }
  return out;
}
async function save() {
  if (!S.bytes) return;
  if (S.editing) applyEditor();
  if (!S.pages.some((P) => P.marks.length)) { hint('No edits yet.'); return; }
  busy('Saving…');
  try {
    const doc = await PDFDocument.load(S.bytes, { ignoreEncryption: true });
    const F = {
      sans: await doc.embedFont(StandardFonts.Helvetica), sansB: await doc.embedFont(StandardFonts.HelveticaBold),
      serif: await doc.embedFont(StandardFonts.TimesRoman), serifB: await doc.embedFont(StandardFonts.TimesRomanBold),
    };
    for (const P of S.pages) if (P.marks.length) writeMarks(doc.getPage(P.i), P.marks, F);
    const out = await doc.save();
    const name = `${S.name}_edited.pdf`;
    const blob = new Blob([out], { type: 'application/pdf' });
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
        const w = await h.createWritable(); await w.write(blob); await w.close();
        S.dirty = false; hint(`Saved as ${h.name}. The original file is unchanged.`); return;
      } catch (e) { if (e.name === 'AbortError') { hint('Not saved.'); return; } }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    S.dirty = false; hint(`Saved as ${name} in your Downloads folder. The original file is unchanged.`);
  } catch (e) { console.error(e); hint('Could not save: ' + (e.message || e)); }
  finally { busy(''); }
}

/** Writes the edits on one page in the page's own coordinates (handles turned pages). */
function writeMarks(page, marks, F) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const cb = page.getCropBox();
  const dispW = rot % 180 === 0 ? cb.width : cb.height, dispH = rot % 180 === 0 ? cb.height : cb.width;
  const pt = (nx, ny) => {
    const u = nx * dispW, v = ny * dispH, x0 = cb.x, y0 = cb.y;
    if (rot === 90) return [x0 + v, y0 + u];
    if (rot === 180) return [x0 + cb.width - u, y0 + v];
    if (rot === 270) return [x0 + cb.width - v, y0 + cb.height - u];
    return [x0 + u, y0 + cb.height - v];
  };
  const rect = (l, t, r, b, opts) => {
    const a = pt(l, t), c = pt(r, b);
    page.drawRectangle({ x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), width: Math.abs(a[0] - c[0]), height: Math.abs(a[1] - c[1]), borderWidth: 0, ...opts });
  };
  for (const m of marks) {
    if (m.type === 'replace') {
      const hN = m.b - m.t, padY = PAD * hN, padX = PAD * hN * dispH / dispW;
      rect(m.l - padX, m.t - padY, m.r + padX, m.b + padY, { color: toPdfColor(m.bg) });
      const font = m.serif ? (m.bold ? F.serifB : F.serif) : (m.bold ? F.sansB : F.sans);
      const safe = printable(m.text, font);
      if (safe) {
        let size = m.size * dispH, tw = font.widthOfTextAtSize(safe, size);
        const room = (m.r - m.l) * dispW * STRETCH;
        if (tw > room && tw > 0) { size *= room / tw; tw = room; }
        const p = pt(m.alignRight ? m.r - tw / dispW : m.l, m.base);
        page.drawText(safe, { x: p[0], y: p[1], size, font, color: toPdfColor(m.fg), rotate: degrees(rot) });
      }
    } else if (m.type === 'box') {
      rect(m.l, m.t, m.r, m.b, m.highlight ? { color: rgb(1, 0.88, 0), opacity: 0.35 } : { color: rgb(1, 1, 1) });
    } else if (m.type === 'ink') {
      const thickness = Math.max(0.4, m.width * dispW);
      for (const s of m.strokes) {
        const pts = s.length === 1 ? [s[0], [s[0][0] + 0.0002, s[0][1]]] : s;
        for (let k = 1; k < pts.length; k++) {
          const a = pt(pts[k - 1][0], pts[k - 1][1]), b = pt(pts[k][0], pts[k][1]);
          page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness, color: toPdfColor(m.color), lineCap: LineCapStyle.Round });
        }
      }
    } else if (m.type === 'text') {
      const size = m.size * dispW;
      m.text.split('\n').forEach((line, i) => {
        const safe = printable(line, F.sans); if (!safe) return;
        const p = pt(m.x, m.y + (0.8 + i * 1.2) * m.size * dispW / dispH);
        page.drawText(safe, { x: p[0], y: p[1], size, font: F.sans, color: toPdfColor(m.color), rotate: degrees(rot) });
      });
    }
  }
}

// ------------------------------------------------------------------ install on this PC
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('btnInstall').hidden = false; });
$('btnInstall').onclick = async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; $('btnInstall').hidden = true; };
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Open files passed by the system ("Open with" when installed)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    openFiles(files);
  });
}
setTool('edit');
