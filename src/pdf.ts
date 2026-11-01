export type Paper = 'a4' | 'letter';

export const PAPER_MM: Record<Paper, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 },
};

/** Standard TCG card size. */
export const CARD_MM = { w: 63, h: 88 };

/** Most printers can't print closer to the edge than this. */
const MIN_MARGIN_MM = 5;

export interface Grid {
  cols: number;
  rows: number;
  marginX: number;
  marginY: number;
  /** Top-left corner of each card slot, row-major. */
  slots: { x: number; y: number }[];
}

export function computeGrid(paper: Paper, gap: number): Grid {
  const { w: pw, h: ph } = PAPER_MM[paper];
  const fit = (page: number, card: number) =>
    Math.max(1, Math.floor((page - 2 * MIN_MARGIN_MM + gap) / (card + gap)));
  const cols = fit(pw, CARD_MM.w);
  const rows = fit(ph, CARD_MM.h);
  const marginX = (pw - (cols * CARD_MM.w + (cols - 1) * gap)) / 2;
  const marginY = (ph - (rows * CARD_MM.h + (rows - 1) * gap)) / 2;
  const slots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({ x: marginX + c * (CARD_MM.w + gap), y: marginY + r * (CARD_MM.h + gap) });
    }
  }
  return { cols, rows, marginX, marginY, slots };
}

export interface PdfOptions {
  paper: Paper;
  gap: number;
  cutLines: boolean;
}

export interface PdfImage {
  /** Identical keys are embedded only once. */
  key: string;
  dataUrl: string;
}

export async function buildPdf(images: PdfImage[], opts: PdfOptions): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: opts.paper, orientation: 'portrait', compress: true });
  const grid = computeGrid(opts.paper, opts.gap);
  const pageHeight = PAPER_MM[opts.paper].h;

  images.forEach((img, i) => {
    const slot = i % grid.slots.length;
    if (i > 0 && slot === 0) doc.addPage();
    if (i === 0) drawCalibration(doc, grid, pageHeight);
    const { x, y } = grid.slots[slot];
    doc.addImage(img.dataUrl, 'PNG', x, y, CARD_MM.w, CARD_MM.h, img.key, 'FAST');
    if (opts.cutLines) {
      doc.setDrawColor(170);
      doc.setLineWidth(0.2);
      doc.rect(x, y, CARD_MM.w, CARD_MM.h);
    }
  });
  return doc.output('blob');
}

/** A 50 mm reference line in the bottom margin to check the printer didn't scale the page. */
function drawCalibration(doc: import('jspdf').jsPDF, grid: Grid, pageHeight: number) {
  if (grid.marginY < 8) return;
  const x = grid.marginX;
  const y = pageHeight - grid.marginY / 2;
  doc.setDrawColor(0);
  doc.setLineWidth(0.3);
  doc.line(x, y, x + 50, y);
  doc.line(x, y - 1.5, x, y + 1.5);
  doc.line(x + 50, y - 1.5, x + 50, y + 1.5);
  doc.setFontSize(7);
  doc.setTextColor(90);
  doc.text('This line should be exactly 50 mm. If not, print at "Actual size" / 100%.', x + 53, y + 1);
}
