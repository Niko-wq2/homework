// Reads the tablet's ink format (see firmware ink.h) and draws it.
export const PAPER_W = 1600;          // paper units across the page
export const LINE_SPACING = 64, GRID_SPACING = 40;
export const INK_COLORS = ['#111111', '#1D4ED8', '#DC2626', '#15803D'];

export function decodeInk(buf) {
  if (!buf) return null;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 16 || String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'INK1') return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 4;
  const version = dv.getUint32(p, true); p += 4;
  p += 4;
  const count = dv.getUint32(p, true); p += 4;
  const strokes = [];
  let bottom = 0;
  for (let i = 0; i < count && p + 8 <= u8.length; i++) {
    const color = u8[p], width = u8[p + 1], flags = u8[p + 2]; p += 4;
    const n = dv.getUint32(p, true); p += 4;
    if (p + n * 4 > u8.length) break;
    const pts = new Int16Array(n * 2);
    for (let k = 0; k < n * 2; k++) { pts[k] = dv.getInt16(p, true); p += 2; }
    for (let k = 1; k < n * 2; k += 2) if (pts[k] > bottom) bottom = pts[k];
    strokes.push({ color, width, flags, pts });
  }
  return { version, strokes, bottom };
}

export function hasInk(ink) { return !!(ink && ink.strokes.some(s => s.pts.length > 0)); }

// Draw strokes onto a 2D canvas context. `scale` = pixels per paper unit,
// `y0` = paper y at the top of the canvas.
export function drawInk(ctx, ink, { scale = 0.5, x0 = 0, y0 = 0 } = {}) {
  if (!ink) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of ink.strokes) {
    const n = s.pts.length / 2;
    if (!n) continue;
    ctx.strokeStyle = ctx.fillStyle = INK_COLORS[s.color & 3];
    ctx.lineWidth = Math.max(0.8, s.width * scale);
    const X = k => (s.pts[2 * k] - x0) * scale, Y = k => (s.pts[2 * k + 1] - y0) * scale;
    if (n === 1) { ctx.beginPath(); ctx.arc(X(0), Y(0), ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    ctx.beginPath(); ctx.moveTo(X(0), Y(0));
    for (let k = 1; k < n; k++) ctx.lineTo(X(k), Y(k));
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPaper(ctx, style, { scale, widthPx, heightPx, y0 = 0 }) {
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.lineWidth = 1;
  if (style === 'lines') {
    ctx.strokeStyle = '#c9d8f0';
    for (let y = Math.ceil(y0 / LINE_SPACING) * LINE_SPACING; (y - y0) * scale < heightPx; y += LINE_SPACING) {
      if (y < LINE_SPACING * 2) continue;
      ctx.beginPath(); ctx.moveTo(0, (y - y0) * scale + 0.5); ctx.lineTo(widthPx, (y - y0) * scale + 0.5); ctx.stroke();
    }
  } else if (style === 'grid') {
    ctx.strokeStyle = '#e1e8f2';
    for (let y = Math.ceil(y0 / GRID_SPACING) * GRID_SPACING; (y - y0) * scale < heightPx; y += GRID_SPACING) {
      ctx.beginPath(); ctx.moveTo(0, (y - y0) * scale + 0.5); ctx.lineTo(widthPx, (y - y0) * scale + 0.5); ctx.stroke();
    }
    for (let x = 0; x * scale < widthPx; x += GRID_SPACING) {
      ctx.beginPath(); ctx.moveTo(x * scale + 0.5, 0); ctx.lineTo(x * scale + 0.5, heightPx); ctx.stroke();
    }
  }
  ctx.restore();
}

// Render the student's work to a canvas (for previews and for hint requests).
export function inkToCanvas(ink, style, { widthPx = 800, minHeightUnits = 200, maxHeightPx = 2400 } = {}) {
  const scale = widthPx / PAPER_W;
  const units = Math.max(minHeightUnits, (ink ? ink.bottom : 0) + 60);
  const c = document.createElement('canvas');
  c.width = widthPx; c.height = Math.min(maxHeightPx, Math.ceil(units * scale));
  const ctx = c.getContext('2d');
  drawPaper(ctx, style, { scale, widthPx: c.width, heightPx: c.height });
  drawInk(ctx, ink, { scale });
  return c;
}
