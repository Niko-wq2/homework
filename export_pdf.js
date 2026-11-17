// Builds a printable worksheet PDF: header, then every question followed by an
// answer box containing the handwriting (as vector lines). Unanswered questions
// get empty ruled/grid space so they can be finished by hand after printing.
import { renderQuestion, renderPdfHeader, toJpeg } from './cards.js';
import { PAPER_W, LINE_SPACING, GRID_SPACING, INK_COLORS, hasInk } from './ink.js';

const PAGE_W = 612, PAGE_H = 792, MX = 36, MTOP = 40, MBOT = 46;
const CW = PAGE_W - 2 * MX;           // 540 pt = 7.5 in
const K = CW / PAPER_W;               // pt per paper unit

function hexColor(h) {
  const { rgb } = window.PDFLib;
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

async function embedCanvas(doc, canvas) {
  const blob = await toJpeg(canvas, 0.9);
  return doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * a: assignment; opts: { inks: Map(qid -> decoded ink), getPage(n), styleFor(q), includeOriginal }
 * Returns PDF bytes (Uint8Array).
 */
export async function buildPdf(a, opts) {
  const L = window.PDFLib;
  if (!L) throw new Error('PDF library failed to load');
  const { PDFDocument, StandardFonts, LineCapStyle, LineJoinStyle, pushGraphicsState, popGraphicsState,
    rectangle, clip, endPath, setLineJoin, rgb } = L;
  const doc = await PDFDocument.create();
  doc.setTitle(a.title || 'Homework');
  doc.setSubject(a.subject || '');
  doc.setCreator('Homework Tablet');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  let page, y;
  const newPage = () => { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MTOP; };
  newPage();
  const room = () => y - MBOT;
  const pageEmpty = () => y >= PAGE_H - MTOP - 1;

  // Header
  const head = await renderPdfHeader(a);
  const headImg = await embedCanvas(doc, head);
  const hh = head.height * (CW / head.width);
  page.drawImage(headImg, { x: MX, y: y - hh, width: CW, height: hh });
  y -= hh + 14;

  const guide = rgb(0.80, 0.85, 0.93), border = rgb(0.75, 0.78, 0.83), margin = rgb(0.95, 0.76, 0.76);

  const drawSlice = (style, ink, u0, u1) => {
    const top = y, hPt = (u1 - u0) * K, bottom = top - hPt;
    // ruled / grid guides
    if (style === 'lines') {
      for (let u = Math.ceil(u0 / LINE_SPACING) * LINE_SPACING; u < u1; u += LINE_SPACING) {
        if (u < LINE_SPACING) continue;
        const yy = top - (u - u0) * K;
        page.drawLine({ start: { x: MX, y: yy }, end: { x: MX + CW, y: yy }, thickness: 0.4, color: guide });
      }
      page.drawLine({ start: { x: MX + 110 * K, y: top }, end: { x: MX + 110 * K, y: bottom }, thickness: 0.4, color: margin });
    } else if (style === 'grid') {
      for (let u = Math.ceil(u0 / GRID_SPACING) * GRID_SPACING; u < u1; u += GRID_SPACING) {
        const yy = top - (u - u0) * K;
        page.drawLine({ start: { x: MX, y: yy }, end: { x: MX + CW, y: yy }, thickness: 0.3, color: guide });
      }
      for (let x = 0; x <= PAPER_W; x += GRID_SPACING) {
        page.drawLine({ start: { x: MX + x * K, y: top }, end: { x: MX + x * K, y: bottom }, thickness: 0.3, color: guide });
      }
    }
    page.drawRectangle({ x: MX, y: bottom, width: CW, height: hPt, borderColor: border, borderWidth: 0.6 });

    if (ink) {
      page.pushOperators(pushGraphicsState(), rectangle(MX, bottom, CW, hPt), clip(), endPath(), setLineJoin(LineJoinStyle.Round));
      for (const s of ink.strokes) {
        const n = s.pts.length / 2;
        if (!n) continue;
        let minY = Infinity, maxY = -Infinity;
        for (let k = 1; k < s.pts.length; k += 2) { minY = Math.min(minY, s.pts[k]); maxY = Math.max(maxY, s.pts[k]); }
        if (maxY + s.width < u0 || minY - s.width > u1) continue;
        const color = hexColor(INK_COLORS[s.color & 3]);
        const w = Math.max(0.45, s.width * K);
        if (n === 1) {
          page.drawCircle({ x: MX + s.pts[0] * K, y: top - (s.pts[1] - u0) * K, size: w / 2, color });
          continue;
        }
        let d = `M ${(s.pts[0] * K).toFixed(2)} ${((s.pts[1] - u0) * K).toFixed(2)}`;
        for (let k = 1; k < n; k++) d += ` L ${(s.pts[2 * k] * K).toFixed(2)} ${((s.pts[2 * k + 1] - u0) * K).toFixed(2)}`;
        page.drawSvgPath(d, { x: MX, y: top, borderColor: color, borderWidth: w, borderLineCap: LineCapStyle.Round });
      }
      page.pushOperators(popGraphicsState());
    }
  };

  for (const q of a.questions || []) {
    // Question card
    const card = await renderQuestion(q, {
      width: 640, scale: 2.5, fontSize: 15, showOriginal: !!opts.includeOriginal,
      getPage: opts.getPage, maxFigH: 240, maxOrigH: 300,
    });
    let cw = CW, ch = card.height * (CW / card.width);
    const full = PAGE_H - MTOP - MBOT;
    if (ch > full) { const s = full / ch; ch *= s; cw *= s; }
    if (ch + 60 > room() && !pageEmpty()) newPage();
    const img = await embedCanvas(doc, card);
    page.drawImage(img, { x: MX, y: y - ch, width: cw, height: ch });
    y -= ch + 4;

    // Answer area
    const ink = opts.inks.get(q.id);
    const answered = hasInk(ink);
    const style = opts.styleFor(q);
    const totalUnits = answered ? Math.max(ink.bottom + 70, 240) : 560;
    let u0 = 0;
    while (u0 < totalUnits) {
      let availUnits = room() / K;
      if (availUnits < 150) { newPage(); availUnits = room() / K; }
      const u1 = Math.min(totalUnits, u0 + availUnits);
      drawSlice(style, answered ? ink : null, u0, u1);
      y -= (u1 - u0) * K;
      u0 = u1;
    }
    y -= 18;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const t = `Page ${i + 1} of ${pages.length}`;
    p.drawText(t, { x: PAGE_W / 2 - font.widthOfTextAtSize(t, 8) / 2, y: 22, size: 8, font, color: rgb(0.45, 0.45, 0.5) });
  });
  return doc.save();
}
