/* =========================================================================
   GIFT CODES — zine <-> high-capacity color barcode ("gift code")
   Core bit-level logic below is identical to what was unit-tested in
   Node (crc32, bit packing, container format, block format, palettes).
   ========================================================================= */

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- bit packing (MSB first) ----------
function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (b >> (7 - j)) & 1;
  }
  return bits;
}
function bitsToBytes(bits) {
  const n = Math.floor(bits.length / 8);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}
function indexToBitsArr(idx, bitsPerCell) {
  const out = new Array(bitsPerCell);
  for (let j = 0; j < bitsPerCell; j++) out[j] = (idx >> (bitsPerCell - 1 - j)) & 1;
  return out;
}

// ---------- palettes ----------
function buildRobustPalette() {
  const p = [];
  for (let i = 0; i < 8; i++) p.push([(i & 4) ? 255 : 0, (i & 2) ? 255 : 0, (i & 1) ? 255 : 0]);
  return p; // 8 colors, 3 bits/cell
}
function buildHighcapPalette() {
  const levels = [0, 85, 170, 255];
  const p = [];
  for (let r = 0; r < 4; r++) for (let g = 0; g < 4; g++) for (let b = 0; b < 4; b++) p.push([levels[r], levels[g], levels[b]]);
  return p; // 64 colors, 6 bits/cell
}
const PALETTE_ROBUST = buildRobustPalette();
const PALETTE_HIGHCAP = buildHighcapPalette();

function nearestIndex(r, g, b, palette) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    const dr = r - c[0], dg = g - c[1], db = b - c[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------- zine container format ("ZNE1") ----------
function buildContainer(title, pages) {
  const enc = new TextEncoder();
  const titleBytes = enc.encode(title).slice(0, 255);
  const magic = enc.encode('ZNE1');
  const head = new Uint8Array(1 + 1 + titleBytes.length + 2);
  let o = 0;
  head[o++] = 1;
  head[o++] = titleBytes.length;
  head.set(titleBytes, o); o += titleBytes.length;
  head[o++] = (pages.length >> 8) & 0xFF;
  head[o++] = pages.length & 0xFF;
  const parts = [magic, head];
  for (const p of pages) {
    const lenBuf = new Uint8Array(4);
    lenBuf[0] = (p.length >>> 24) & 0xFF; lenBuf[1] = (p.length >>> 16) & 0xFF;
    lenBuf[2] = (p.length >>> 8) & 0xFF; lenBuf[3] = p.length & 0xFF;
    parts.push(lenBuf, p);
  }
  let total = 0; for (const pt of parts) total += pt.length;
  const out = new Uint8Array(total);
  let off = 0; for (const pt of parts) { out.set(pt, off); off += pt.length; }
  return out;
}
function parseContainer(bytes) {
  const dec = new TextDecoder();
  let o = 0;
  const magic = dec.decode(bytes.slice(0, 4)); o += 4;
  if (magic !== 'ZNE1') throw new Error('Not a recognized zine container (bad magic).');
  o++; // version
  const titleLen = bytes[o++];
  const title = dec.decode(bytes.slice(o, o + titleLen)); o += titleLen;
  const pageCount = (bytes[o] << 8) | bytes[o + 1]; o += 2;
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const len = (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0; o += 4;
    pages.push(bytes.slice(o, o + len)); o += len;
  }
  return { title, pages };
}

// ---------- block format ("JBX1") ----------
const BLOCK_HEADER_LEN = 4 + 1 + 1 + 2 + 2 + 4 + 4; // 18 bytes
function buildBlockBytes(mode, idx, total, payload) {
  const enc = new TextEncoder();
  const head = new Uint8Array(BLOCK_HEADER_LEN);
  let o = 0;
  head.set(enc.encode('JBX1'), o); o += 4;
  head[o++] = 1; head[o++] = mode;
  head[o++] = (idx >> 8) & 0xFF; head[o++] = idx & 0xFF;
  head[o++] = (total >> 8) & 0xFF; head[o++] = total & 0xFF;
  head[o++] = (payload.length >>> 24) & 0xFF; head[o++] = (payload.length >>> 16) & 0xFF;
  head[o++] = (payload.length >>> 8) & 0xFF; head[o++] = payload.length & 0xFF;
  const crc = crc32(payload);
  head[o++] = (crc >>> 24) & 0xFF; head[o++] = (crc >>> 16) & 0xFF;
  head[o++] = (crc >>> 8) & 0xFF; head[o++] = crc & 0xFF;
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0); out.set(payload, head.length);
  return out;
}
function parseBlockBytes(bytes) {
  const dec = new TextDecoder();
  if (bytes.length < BLOCK_HEADER_LEN) return { ok: false, error: 'too short' };
  const magic = dec.decode(bytes.slice(0, 4));
  if (magic !== 'JBX1') return { ok: false, error: 'bad magic' };
  let o = 4;
  o++; // version
  const mode = bytes[o++];
  const idx = (bytes[o] << 8) | bytes[o + 1]; o += 2;
  const total = (bytes[o] << 8) | bytes[o + 1]; o += 2;
  const len = (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0; o += 4;
  const crc = (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0; o += 4;
  if (o + len > bytes.length) return { ok: false, error: 'truncated payload' };
  const payload = bytes.slice(o, o + len);
  if (crc32(payload) !== crc) return { ok: false, error: 'checksum mismatch (bad scan)' };
  return { ok: true, mode, idx, total, payload };
}

// ---------- presets ----------
const PRESETS = {
  0: { name: 'robust', cols: 90, rows: 90, cellSize: 8, margin: 70, finderPx: 50, finderInset: 10, bitsPerCell: 3, mode: 0 },
  1: { name: 'highcap', cols: 220, rows: 220, cellSize: 4, margin: 20, finderPx: 0, finderInset: 0, bitsPerCell: 6, mode: 1 },
};
for (const k in PRESETS) {
  const p = PRESETS[k];
  p.canvasW = p.cols * p.cellSize + 2 * p.margin;
  p.canvasH = p.rows * p.cellSize + 2 * p.margin;
  p.totalBits = p.cols * p.rows * p.bitsPerCell;
  p.totalBytes = Math.floor(p.totalBits / 8);
  p.payloadCap = p.totalBytes - BLOCK_HEADER_LEN;
}
const STRIP_HEIGHT = 40, STRIP_BIT_W = 10, STRIP_BITS = 24, BLOCK_GAP = 24;

function splitIntoBlocks(compressed, preset) {
  const cap = preset.payloadCap;
  const total = Math.max(1, Math.ceil(compressed.length / cap));
  const blocks = [];
  for (let i = 0; i < total; i++) {
    const chunk = compressed.slice(i * cap, Math.min((i + 1) * cap, compressed.length));
    blocks.push(buildBlockBytes(preset.mode, i, total, chunk));
  }
  return blocks;
}

/* ---------- canvas rendering ---------- */
function renderBlockCanvas(blockBytes, preset) {
  const canvas = document.createElement('canvas');
  canvas.width = preset.canvasW; canvas.height = preset.canvasH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const palette = preset.mode === 0 ? PALETTE_ROBUST : PALETTE_HIGHCAP;
  const bitsPerCell = preset.bitsPerCell;
  const totalCells = preset.cols * preset.rows;
  const gridBits = totalCells * bitsPerCell;
  const bits = bytesToBits(blockBytes);
  const padded = new Uint8Array(gridBits);
  padded.set(bits.subarray(0, Math.min(bits.length, gridBits)));

  let bitPos = 0;
  for (let r = 0; r < preset.rows; r++) {
    for (let c = 0; c < preset.cols; c++) {
      let idx = 0;
      for (let j = 0; j < bitsPerCell; j++) idx = (idx << 1) | padded[bitPos++];
      const col = palette[idx];
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.fillRect(preset.margin + c * preset.cellSize, preset.margin + r * preset.cellSize, preset.cellSize, preset.cellSize);
    }
  }

  if (preset.finderPx > 0) {
    const fp = preset.finderPx, ins = preset.finderInset;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ins - 6, ins - 6, fp + 12, fp + 12);
    ctx.fillRect(canvas.width - ins - fp - 6, ins - 6, fp + 12, fp + 12);
    ctx.fillRect(ins - 6, canvas.height - ins - fp - 6, fp + 12, fp + 12);
    ctx.fillStyle = '#000000';
    ctx.fillRect(ins, ins, fp, fp);
    ctx.fillRect(canvas.width - ins - fp, ins, fp, fp);
    ctx.fillRect(ins, canvas.height - ins - fp, fp, fp);
  }
  return canvas;
}

function encodeStripBits(mode, totalBlocks) {
  const bits = [];
  bits.push((mode >> 1) & 1, mode & 1);
  for (let i = 15; i >= 0; i--) bits.push((totalBlocks >> i) & 1);
  for (let i = 0; i < 6; i++) bits.push(0);
  return bits;
}
function decodeStripBitsArr(bits) {
  const mode = (bits[0] << 1) | bits[1];
  let total = 0;
  for (let i = 0; i < 16; i++) total = (total << 1) | bits[2 + i];
  return { mode, total };
}

function assembleFinalCanvas(blockCanvases, preset, totalBlocks) {
  const stripWidth = STRIP_BITS * STRIP_BIT_W;
  const width = Math.max(stripWidth, preset.canvasW);
  const height = STRIP_HEIGHT + totalBlocks * (preset.canvasH + BLOCK_GAP);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const bits = encodeStripBits(preset.mode, totalBlocks);
  for (let i = 0; i < bits.length; i++) {
    ctx.fillStyle = bits[i] ? '#000000' : '#ffffff';
    ctx.fillRect(i * STRIP_BIT_W, 0, STRIP_BIT_W, STRIP_HEIGHT);
  }

  for (let i = 0; i < totalBlocks; i++) {
    const y = STRIP_HEIGHT + i * (preset.canvasH + BLOCK_GAP);
    ctx.drawImage(blockCanvases[i], 0, y);
    if (BLOCK_GAP > 14) {
      ctx.fillStyle = '#000000';
      ctx.font = '13px sans-serif';
      ctx.fillText(`block ${i + 1} / ${totalBlocks}`, 4, y + preset.canvasH + 17);
    }
  }
  return canvas;
}

/* ---------- decoding from pixel data ---------- */
function getImageDataObj(canvas) {
  const ctx = canvas.getContext('2d');
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: id.data, width: canvas.width, height: canvas.height };
}
function samplePixel(dataObj, x, y) {
  x = Math.max(0, Math.min(dataObj.width - 1, Math.round(x)));
  y = Math.max(0, Math.min(dataObj.height - 1, Math.round(y)));
  const i = (y * dataObj.width + x) * 4;
  return [dataObj.data[i], dataObj.data[i + 1], dataObj.data[i + 2]];
}
function sampleCellAvg(dataObj, cx, cy, sampleRadius) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -sampleRadius; dy <= sampleRadius; dy += sampleRadius) {
    for (let dx = -sampleRadius; dx <= sampleRadius; dx += sampleRadius) {
      const px = samplePixel(dataObj, cx + dx, cy + dy);
      r += px[0]; g += px[1]; b += px[2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

function decodeBlockAt(dataObj, xOff, yOff, preset) {
  const palette = preset.mode === 0 ? PALETTE_ROBUST : PALETTE_HIGHCAP;
  const bitsPerCell = preset.bitsPerCell;
  const totalCells = preset.cols * preset.rows;
  const bits = new Uint8Array(totalCells * bitsPerCell);
  let bitPos = 0;
  const sr = Math.max(1, Math.floor(preset.cellSize * 0.2));
  for (let r = 0; r < preset.rows; r++) {
    for (let c = 0; c < preset.cols; c++) {
      const cx = xOff + preset.margin + c * preset.cellSize + preset.cellSize / 2;
      const cy = yOff + preset.margin + r * preset.cellSize + preset.cellSize / 2;
      const avg = sampleCellAvg(dataObj, cx, cy, sr);
      const idx = nearestIndex(avg[0], avg[1], avg[2], palette);
      const cellBits = indexToBitsArr(idx, bitsPerCell);
      for (let j = 0; j < bitsPerCell; j++) bits[bitPos++] = cellBits[j];
    }
  }
  return bitsToBytes(bits);
}

function decodeStripAt(dataObj) {
  const bits = [];
  for (let i = 0; i < STRIP_BITS; i++) {
    const x = i * STRIP_BIT_W + STRIP_BIT_W / 2;
    const y = STRIP_HEIGHT / 2;
    const px = samplePixel(dataObj, x, y);
    bits.push(((px[0] + px[1] + px[2]) / 3) < 128 ? 1 : 0);
  }
  return decodeStripBitsArr(bits);
}

/* =========================================================================
   UI / APPLICATION LOGIC
   ========================================================================= */

// ---------- tiny helpers ----------
function $(id) { return document.getElementById(id); }

// Updated for new contextual BEM status rules
function setStatus(el, kind, msg) { 
  el.className = 'gc-status gc-status--' + kind + ' p-2 rounded small mt-2'; 
  el.textContent = msg; 
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
function canvasFromImageResized(img, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas;
}
function canvasToJpegBytes(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
    }, 'image/jpeg', quality);
  });
}
function triggerDownload(dataUrlOrBlobUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrlOrBlobUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- tab switching (Fixed Bootstrap & BEM Integration) ----------
$('tabCreateBtn').onclick = () => {
  $('tabCreateBtn').classList.add('gc-tabs__btn--active'); 
  $('tabScanBtn').classList.remove('gc-tabs__btn--active');
  $('tabCreate').classList.remove('d-none'); 
  $('tabScan').classList.add('d-none');
};
$('tabScanBtn').onclick = () => {
  $('tabScanBtn').classList.add('gc-tabs__btn--active'); 
  $('tabCreateBtn').classList.remove('gc-tabs__btn--active');
  $('tabScan').classList.remove('d-none'); 
  $('tabCreate').classList.add('d-none');
};

/* =========================== CREATE TAB =========================== */
let pages = []; // {file, id, thumbUrl}
let pageIdCounter = 0;
let lastBlockCanvases = null, lastPreset = null;

$('qualitySlider').oninput = () => $('qualityVal').textContent = $('qualitySlider').value + '%';
$('dimSlider').oninput = () => $('dimVal').textContent = $('dimSlider').value + 'px';

$('dropzone').addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') $('fileInput').click(); });
$('fileInput').addEventListener('change', (e) => {
  for (const file of e.target.files) {
    pages.push({ file, id: pageIdCounter++, thumbUrl: URL.createObjectURL(file) });
  }
  e.target.value = '';
  renderPageList();
});

function renderPageList() {
  const list = $('pageList');
  list.innerHTML = '';
  pages.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'gc-pageitem';
    row.innerHTML = `
      <img src="${p.thumbUrl}">
      <div class="name">${i + 1}. ${p.file.name}</div>
      <button data-act="up" title="Move up">▲</button>
      <button data-act="down" title="Move down">▼</button>
      <button data-act="del" title="Remove">✕</button>
    `;
    row.querySelector('[data-act=up]').onclick = () => { if (i > 0) { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; renderPageList(); } };
    row.querySelector('[data-act=down]').onclick = () => { if (i < pages.length - 1) { [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]]; renderPageList(); } };
    row.querySelector('[data-act=del]').onclick = () => { pages.splice(i, 1); renderPageList(); };
    list.appendChild(row);
  });
}

$('resetCreateBtn').onclick = () => {
  pages = []; renderPageList();
  $('genStatus').innerHTML = ''; 
  $('finalPreviewWrap').classList.add('d-none');
  $('genProgressWrap').classList.add('d-none');
  lastBlockCanvases = null; lastPreset = null;
};

$('generateBtn').onclick = async () => {
  const statusEl = $('genStatus');
  if (pages.length === 0) { setStatus(statusEl, 'bad', 'Add at least one image first.'); return; }
  $('generateBtn').disabled = true;
  $('genProgressWrap').classList.remove('d-none');
  const bar = $('genProgressBar'); bar.style.width = '2%';
  setStatus(statusEl, 'info', 'Preparing pages…');

  try {
    const title = $('zineTitle').value.trim() || 'Untitled Zine';
    const quality = parseInt($('qualitySlider').value) / 100;
    const maxDim = parseInt($('dimSlider').value);
    const mode = parseInt($('modeSelect').value);
    const preset = PRESETS[mode];

    const pageBytesArr = [];
    for (let i = 0; i < pages.length; i++) {
      const img = await loadImageFromFile(pages[i].file);
      const canvas = canvasFromImageResized(img, maxDim);
      const bytes = await canvasToJpegBytes(canvas, quality);
      pageBytesArr.push(bytes);
      bar.style.width = Math.round(5 + (i + 1) / pages.length * 35) + '%';
    }

    setStatus(statusEl, 'info', 'Packing zine…');
    const container = buildContainer(title, pageBytesArr);
    const compressed = pako.deflate(container);
    bar.style.width = '45%';

    setStatus(statusEl, 'info', 'Splitting into code blocks…');
    const blocks = splitIntoBlocks(compressed, preset);
    bar.style.width = '55%';

    setStatus(statusEl, 'info', `Rendering ${blocks.length} code block(s)…`);
    const blockCanvases = [];
    for (let i = 0; i < blocks.length; i++) {
      blockCanvases.push(renderBlockCanvas(blocks[i], preset));
      bar.style.width = Math.round(55 + (i + 1) / blocks.length * 35) + '%';
      await new Promise(r => setTimeout(r, 0)); // let UI breathe
    }

    const finalCanvas = assembleFinalCanvas(blockCanvases, preset, blocks.length);
    bar.style.width = '100%';

    lastBlockCanvases = blockCanvases; lastPreset = preset;

    const dataUrl = finalCanvas.toDataURL('image/png');
    $('finalPreviewImg').src = dataUrl;
    $('downloadFinalBtn').href = dataUrl;
    $('downloadFinalBtn').download = `gift-code-${blocks.length}blocks.png`;
    $('finalPreviewWrap').classList.remove('d-none');
    $('finalMeta').textContent =
      `${preset.name === 'robust' ? 'Camera-friendly' : 'Max-capacity'} mode · ${blocks.length} block(s) · ` +
      `original ${container.length.toLocaleString()} bytes → compressed ${compressed.length.toLocaleString()} bytes · ` +
      `final image ${finalCanvas.width}×${finalCanvas.height}px`;
    setStatus(statusEl, 'good', '✅ Code generated!');
  } catch (err) {
    console.error(err);
    setStatus(statusEl, 'bad', 'Something went wrong: ' + err.message);
  } finally {
    $('generateBtn').disabled = false;
    setTimeout(() => $('genProgressWrap').classList.add('d-none'), 600);
  }
};

$('downloadBlocksBtn').onclick = async () => {
  if (!lastBlockCanvases) return;
  const zip = new JSZip();
  for (let i = 0; i < lastBlockCanvases.length; i++) {
    const dataUrl = lastBlockCanvases[i].toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    zip.file(`block-${String(i + 1).padStart(3, '0')}-of-${lastBlockCanvases.length}.png`, base64, { base64: true });
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(URL.createObjectURL(blob), 'gift-code-blocks.zip');
};

/* =========================== SCAN TAB =========================== */
let collected = new Map(); // idx -> Uint8Array payload
let expectedTotal = null;
let expectedMode = null;

function updateScanUI() {
  const chipWrap = $('blockList');
  chipWrap.innerHTML = '';
  if (expectedTotal === null) {
    setStatus($('scanProgressText'), 'info', 'No code scanned yet. Upload an image or use the camera below.');
    return;
  }
  for (let i = 0; i < expectedTotal; i++) {
    const chip = document.createElement('div');
    chip.className = 'blockchip' + (collected.has(i) ? ' have' : '');
    chip.textContent = i + 1;
    chipWrap.appendChild(chip);
  }
  const have = collected.size;
  if (have < expectedTotal) {
    setStatus($('scanProgressText'), 'info', `${have} / ${expectedTotal} blocks collected — keep scanning.`);
  } else {
    setStatus($('scanProgressText'), 'good', `All ${expectedTotal} blocks collected — reconstructing…`);
  }
}

function addBlockResult(parsed) {
  if (!parsed.ok) { setStatus($('scanProgressText'), 'bad', 'Scan failed: ' + parsed.error); return; }
  if (expectedTotal === null) { expectedTotal = parsed.total; expectedMode = parsed.mode; }
  else if (parsed.total !== expectedTotal) {
    setStatus($('scanProgressText'), 'bad', 'That block belongs to a different code (mismatched total block count). Tap "Start new scan" if you want to scan something else.');
    return;
  }
  collected.set(parsed.idx, parsed.payload);
  updateScanUI();
  if (collected.size === expectedTotal) reconstructZine();
}

$('resetScanBtn').onclick = () => {
  collected.clear(); expectedTotal = null; expectedMode = null;
  updateScanUI();
  $('viewerCard').classList.add('d-none');
};

function reconstructZine() {
  try {
    let totalLen = 0;
    const parts = [];
    for (let i = 0; i < expectedTotal; i++) { const p = collected.get(i); parts.push(p); totalLen += p.length; }
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
    const inflated = pako.inflate(merged);
    const zine = parseContainer(inflated);
    showViewer(zine);
    setStatus($('scanProgressText'), 'good', `🎁 Reconstructed "${zine.title}" (${zine.pages.length} page${zine.pages.length === 1 ? '' : 's'})!`);
  } catch (err) {
    console.error(err);
    setStatus($('scanProgressText'), 'bad', 'Reconstruction failed: ' + err.message);
  }
}

// ---- file upload path ----
$('scanDropzone').addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') $('scanFileInput').click(); });
$('scanFileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  for (const file of files) await handleScanFile(file);
});

async function handleScanFile(file) {
  let img;
  try { img = await loadImageFromFile(file); } catch { setStatus($('scanProgressText'), 'bad', 'Could not open ' + file.name); return; }
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const dataObj = getImageDataObj(canvas);

  let handledAny = false;

  // try "combined" multi-block image (has header strip)
  try {
    const strip = decodeStripAt(dataObj);
    if ((strip.mode === 0 || strip.mode === 1) && strip.total >= 1 && strip.total <= 20000) {
      const preset = PRESETS[strip.mode];
      const neededH = STRIP_HEIGHT + strip.total * (preset.canvasH + BLOCK_GAP);
      if (canvas.width >= preset.canvasW && canvas.height >= neededH - BLOCK_GAP) {
        for (let i = 0; i < strip.total; i++) {
          const y = STRIP_HEIGHT + i * (preset.canvasH + BLOCK_GAP);
          const bytes = decodeBlockAt(dataObj, 0, y, preset);
          const parsed = parseBlockBytes(bytes);
          if (parsed.ok) { addBlockResult(parsed); handledAny = true; }
          else { setStatus($('scanProgressText'), 'bad', `Block ${i + 1} in ${file.name} unreadable: ${parsed.error}`); }
        }
      }
    }
  } catch (err) { /* not a combined image, fall through */ }

  // try "standalone" single-block image
  if (!handledAny) {
    for (const key of [0, 1]) {
      const preset = PRESETS[key];
      if (canvas.width === preset.canvasW && canvas.height === preset.canvasH) {
        const bytes = decodeBlockAt(dataObj, 0, 0, preset);
        const parsed = parseBlockBytes(bytes);
        if (parsed.ok) { addBlockResult(parsed); handledAny = true; }
        else { setStatus($('scanProgressText'), 'bad', `Could not read ${file.name}: ${parsed.error}`); handledAny = true; }
        break;
      }
    }
  }

  if (!handledAny) setStatus($('scanProgressText'), 'bad', `"${file.name}" doesn't look like a gift code image.`);
}

// ---- camera path (robust/camera-friendly preset only) ----
let camStream = null;
$('camStartBtn').onclick = async () => {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    $('camVideo').srcObject = camStream;
    $('camCaptureBtn').disabled = false; $('camStopBtn').disabled = false; $('camStartBtn').disabled = true;
    $('camHint').textContent = 'Fill the frame with the code, hold flat, then tap Capture.';
  } catch (err) {
    $('camHint').textContent = 'Camera error: ' + err.message + ' (check your browser/site permissions).';
  }
};
$('camStopBtn').onclick = () => {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  $('camVideo').srcObject = null;
  $('camCaptureBtn').disabled = true; $('camStopBtn').disabled = true; $('camStartBtn').disabled = false;
  $('camHint').textContent = '';
};
$('camCaptureBtn').onclick = () => {
  const video = $('camVideo');
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) { $('camHint').textContent = 'Camera not ready yet, try again.'; return; }
  const rect = video.getBoundingClientRect();
  const dispW = rect.width, dispH = rect.height;
  // replicate CSS object-fit:cover cropping so capture matches what's on screen
  const scale = Math.max(dispW / vw, dispH / vh);
  const sw = dispW / scale, sh = dispH / scale;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

  const preset = PRESETS[0]; // camera scanning always assumes camera-friendly preset
  const tmp = document.createElement('canvas');
  tmp.width = preset.canvasW; tmp.height = preset.canvasH;
  tmp.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, preset.canvasW, preset.canvasH);
  const dataObj = getImageDataObj(tmp);
  const bytes = decodeBlockAt(dataObj, 0, 0, preset);
  const parsed = parseBlockBytes(bytes);
  if (parsed.ok) {
    addBlockResult(parsed);
    $('camHint').textContent = `✅ Got block ${parsed.idx + 1} of ${parsed.total}!`;
  } else {
    $('camHint').textContent = `❌ Couldn't read that (${parsed.error}). Fill the frame fully, hold steady, try better lighting.`;
  }
};

/* =========================== VIEWER =========================== */
let currentZine = null, currentPageIdx = 0, pageUrls = [];
function showViewer(zine) {
  currentZine = zine; currentPageIdx = 0;
  pageUrls = new Array(zine.pages.length).fill(null);
  $('viewerTitle').textContent = zine.title || 'Zine';
  $('viewerCard').classList.remove('d-none');
  renderPage();
  $('viewerCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function pageBlobUrl(idx) {
  if (!pageUrls[idx]) {
    const blob = new Blob([currentZine.pages[idx]], { type: 'image/jpeg' });
    pageUrls[idx] = URL.createObjectURL(blob);
  }
  return pageUrls[idx];
}
function renderPage() {
  $('viewerImg').src = pageBlobUrl(currentPageIdx);
  $('pageCounter').textContent = `Page ${currentPageIdx + 1} of ${currentZine.pages.length}`;
}
$('prevPageBtn').onclick = () => { if (currentPageIdx > 0) { currentPageIdx--; renderPage(); } };
$('nextPageBtn').onclick = () => { if (currentPageIdx < currentZine.pages.length - 1) { currentPageIdx++; renderPage(); } };
$('downloadPageBtn').onclick = () => triggerDownload(pageBlobUrl(currentPageIdx), `page-${currentPageIdx + 1}.jpg`);
$('downloadAllPagesBtn').onclick = async () => {
  const zip = new JSZip();
  currentZine.pages.forEach((p, i) => zip.file(`page-${String(i + 1).padStart(2, '0')}.jpg`, p));
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(URL.createObjectURL(blob), `${(currentZine.title || 'zine').replace(/[^a-z0-9]+/gi, '-')}.zip`);
};

// initial UI state
renderPageList();
updateScanUI();