import type { CardStructure, EnergyType } from './structure';

/**
 * Base layout shared by all cards, drawn at the working resolution (63 × 88 mm at ~300 DPI).
 * Only the structure is drawn — boxes and energy symbols — never text or numbers.
 */
export const CARD_W = 744;
export const CARD_H = 1039;
export const ART_FRAME = { x: 52, y: 104, w: 640, h: 384 };

const STROKE = 4;
const ATTACKS_TOP = 548;
const ATTACKS_BOTTOM = 866;
const BOTTOM_ROW_Y = 918;

type Ctx = CanvasRenderingContext2D;

function strokeRoundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.stroke();
}

function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Polygon alternating between an outer and inner radius, starting at the top. */
function star(ctx: Ctx, points: number, outer: number, inner: number) {
  ctx.beginPath();
  for (let k = 0; k < 2 * points; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / points;
    const r = k % 2 ? inner : outer;
    ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
  }
  ctx.closePath();
  ctx.stroke();
}

/** Simple outline icons in a unit circle (coordinates -1..1). */
const ICONS: Record<EnergyType, (ctx: Ctx) => void> = {
  grass(ctx) {
    ctx.beginPath();
    ctx.moveTo(-0.6, 0.7);
    ctx.bezierCurveTo(-0.75, -0.2, 0, -0.8, 0.7, -0.7);
    ctx.bezierCurveTo(0.75, 0.1, 0.1, 0.8, -0.6, 0.7);
    ctx.closePath();
    ctx.moveTo(-0.6, 0.7);
    ctx.lineTo(0.3, -0.3);
    ctx.stroke();
  },
  fire(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, 0.85);
    ctx.bezierCurveTo(-0.7, 0.85, -0.7, 0.1, -0.3, -0.3);
    ctx.bezierCurveTo(-0.25, 0, -0.1, 0.1, 0, 0.1);
    ctx.bezierCurveTo(-0.1, -0.4, 0.1, -0.7, 0.1, -0.85);
    ctx.bezierCurveTo(0.5, -0.5, 0.75, 0, 0.55, 0.5);
    ctx.bezierCurveTo(0.45, 0.75, 0.25, 0.85, 0, 0.85);
    ctx.closePath();
    ctx.stroke();
  },
  water(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, -0.85);
    ctx.bezierCurveTo(0.35, -0.35, 0.62, 0.05, 0.62, 0.32);
    ctx.bezierCurveTo(0.62, 0.7, 0.32, 0.85, 0, 0.85);
    ctx.bezierCurveTo(-0.32, 0.85, -0.62, 0.7, -0.62, 0.32);
    ctx.bezierCurveTo(-0.62, 0.05, -0.35, -0.35, 0, -0.85);
    ctx.closePath();
    ctx.stroke();
  },
  lightning(ctx) {
    ctx.beginPath();
    for (const [x, y] of [[0.2, -0.85], [-0.45, 0.1], [-0.05, 0.1], [-0.2, 0.85], [0.45, -0.15], [0.05, -0.15], [0.3, -0.85]]) {
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  },
  psychic(ctx) {
    ctx.beginPath();
    ctx.moveTo(-0.85, 0);
    ctx.quadraticCurveTo(0, -0.8, 0.85, 0);
    ctx.quadraticCurveTo(0, 0.8, -0.85, 0);
    ctx.closePath();
    ctx.moveTo(0.28, 0);
    ctx.arc(0, 0, 0.28, 0, 2 * Math.PI);
    ctx.stroke();
  },
  fighting(ctx) {
    ctx.beginPath();
    ctx.roundRect(-0.55, -0.5, 1.1, 1, 0.25);
    for (const x of [-0.18, 0.18]) {
      ctx.moveTo(x, -0.5);
      ctx.lineTo(x, 0);
    }
    ctx.moveTo(-0.55, 0.1);
    ctx.lineTo(0.2, 0.1);
    ctx.stroke();
  },
  darkness(ctx) {
    // Crescent: outer circle the long way round, inner circle back.
    ctx.beginPath();
    ctx.arc(0, 0, 0.7, -0.3 * Math.PI, 0.3 * Math.PI, true);
    ctx.arc(0.3, 0, 0.576, 1.379, -1.379, false);
    ctx.closePath();
    ctx.stroke();
  },
  metal(ctx) {
    for (const r of [0.8, 0.35]) {
      ctx.beginPath();
      for (const a of [-90, 30, 150]) ctx.lineTo(r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180));
      ctx.closePath();
      ctx.stroke();
    }
  },
  fairy(ctx) {
    star(ctx, 4, 0.85, 0.28);
  },
  dragon(ctx) {
    ctx.beginPath();
    ctx.moveTo(-0.5, -0.65);
    ctx.quadraticCurveTo(0.55, -0.6, 0, 0);
    ctx.quadraticCurveTo(-0.55, 0.6, 0.5, 0.65);
    ctx.moveTo(-0.2, -0.85);
    ctx.lineTo(-0.5, -0.65);
    ctx.lineTo(-0.2, -0.45);
    ctx.stroke();
  },
  colorless(ctx) {
    star(ctx, 6, 0.75, 0.35);
  },
};

/** Energy symbol: a circle with the type's icon (or empty when the type is unknown). */
export function drawEnergy(ctx: Ctx, type: EnergyType | null, cx: number, cy: number, r: number) {
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  if (type) {
    const k = r * 0.62;
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    ctx.lineWidth = Math.max(2, r * 0.1) / k;
    ICONS[type](ctx);
  }
  ctx.restore();
}

/** Draws the base layout on top of whatever is already in the art frame. */
export function drawTemplate(ctx: Ctx, s: CardStructure) {
  ctx.save();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = STROKE;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Card outline
  strokeRoundRect(ctx, 12, 12, CARD_W - 24, CARD_H - 24, 34);

  // Header: stage tag, line for the name, HP box, type symbol
  strokeRoundRect(ctx, 36, 34, 112, 36, 18);
  ctx.lineWidth = 2;
  line(ctx, 164, 80, 500, 80);
  ctx.lineWidth = STROKE;
  strokeRoundRect(ctx, 520, 32, 110, 46, 12);
  drawEnergy(ctx, s.type, 680, 55, 30);

  // Artwork frame, with the pre-evolution bubble for stage 1/2
  ctx.lineWidth = 6;
  ctx.strokeRect(ART_FRAME.x, ART_FRAME.y, ART_FRAME.w, ART_FRAME.h);
  ctx.lineWidth = STROKE;
  if (s.stage !== 'basic') {
    drawEnergy(ctx, null, 92, 140, 44);
    if (s.stage === 'stage2') drawEnergy(ctx, null, 92, 140, 34);
  }

  // Metadata strip (number, category, height, weight)
  strokeRoundRect(ctx, 96, 502, 552, 26, 13);

  // Abilities and attacks, evenly spaced
  const items = [...Array<null>(s.abilities).fill(null), ...s.attacks];
  const rowH = Math.min(150, (ATTACKS_BOTTOM - ATTACKS_TOP) / Math.max(1, items.length));
  items.forEach((attack, k) => {
    const y = ATTACKS_TOP + k * rowH;
    if (!attack) {
      strokeRoundRect(ctx, 52, y + 10, 130, 40, 12);
      ctx.lineWidth = 2;
      line(ctx, 200, y + 46, 690, y + 46);
      ctx.lineWidth = STROKE;
      return;
    }
    const r = 21;
    attack.cost.forEach((type, i) => drawEnergy(ctx, type, 52 + r + i * 46, y + 32, r));
    const nameStart = Math.max(200, 52 + attack.cost.length * 46 + 20);
    ctx.lineWidth = 2;
    line(ctx, nameStart, y + 50, attack.damage ? 580 : 690, y + 50);
    ctx.lineWidth = STROKE;
    if (attack.damage) strokeRoundRect(ctx, 600, y + 10, 92, 46, 12);
  });

  // Weakness / resistance / retreat
  ctx.lineWidth = 2;
  line(ctx, 40, 882, CARD_W - 40, 882);
  ctx.lineWidth = STROKE;
  if (s.weakness) drawEnergy(ctx, s.weakness, 100, BOTTOM_ROW_Y, 20);
  if (s.resistance) drawEnergy(ctx, s.resistance, 372, BOTTOM_ROW_Y, 20);
  const retreatX = Math.min(580, 690 - (s.retreat - 1) * 42);
  for (let i = 0; i < s.retreat; i++) drawEnergy(ctx, 'colorless', retreatX + i * 42, BOTTOM_ROW_Y, 17);

  // Footer
  ctx.lineWidth = 2;
  line(ctx, 40, 956, CARD_W - 40, 956);
  ctx.restore();
}
