import { CRATE_INFO, type CrateKind } from './config';

/**
 * Item icons, drawn with the canvas 2D API. One drawing is used everywhere an item shows up: on the
 * crates in the arena, on the badge floating above a player who holds it, in the scoreboard and in
 * the items guide, so a player learns each symbol once.
 */

/** The white glyph, centred on (0, 0) and about 150 units across. */
function glyph(g: CanvasRenderingContext2D, kind: CrateKind): void {
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#ffffff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (kind) {
    case 'shield':
      g.beginPath();
      g.moveTo(0, -70);
      g.lineTo(58, -46);
      g.quadraticCurveTo(58, 40, 0, 72);
      g.quadraticCurveTo(-58, 40, -58, -46);
      g.closePath();
      g.fill();
      break;
    case 'big':
      g.lineWidth = 18;
      g.beginPath();
      g.moveTo(-70, 0);
      g.lineTo(70, 0);
      g.moveTo(-44, -28);
      g.lineTo(-72, 0);
      g.lineTo(-44, 28);
      g.moveTo(44, -28);
      g.lineTo(72, 0);
      g.lineTo(44, 28);
      g.stroke();
      break;
    case 'freeze':
      g.lineWidth = 12;
      for (let i = 0; i < 6; i++) {
        g.save();
        g.rotate((i * Math.PI) / 3);
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -72);
        g.moveTo(0, -42);
        g.lineTo(-18, -58);
        g.moveTo(0, -42);
        g.lineTo(18, -58);
        g.stroke();
        g.restore();
      }
      break;
    case 'split':
      g.lineWidth = 14;
      for (const a of [-0.55, 0, 0.55]) {
        g.save();
        g.translate(0, 60);
        g.rotate(a);
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -110);
        g.moveTo(-18, -90);
        g.lineTo(0, -112);
        g.lineTo(18, -90);
        g.stroke();
        g.restore();
      }
      break;
    case 'life':
      g.beginPath();
      g.moveTo(0, 64);
      g.bezierCurveTo(-90, 0, -60, -78, 0, -34);
      g.bezierCurveTo(60, -78, 90, 0, 0, 64);
      g.fill();
      break;
  }
}

/** A rounded colour tile with the item glyph, drawn into the square (x, y, size, size). */
export function drawBadge(g: CanvasRenderingContext2D, kind: CrateKind, x: number, y: number, size: number): void {
  g.save();
  g.fillStyle = CRATE_INFO[kind].css;
  g.beginPath();
  g.roundRect(x, y, size, size, size * 0.12);
  g.fill();
  const grd = g.createLinearGradient(0, y, 0, y + size);
  grd.addColorStop(0, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = grd;
  g.fill();
  g.translate(x + size / 2, y + size / 2);
  const k = size / 216;
  g.scale(k, k);
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 8;
  glyph(g, kind);
  g.restore();
}

const urls = new Map<CrateKind, string>();

/** A small PNG data URL of the badge, for use in HTML (scoreboard, panels, guide). */
export function itemIconURL(kind: CrateKind): string {
  let u = urls.get(kind);
  if (!u) {
    const c = document.createElement('canvas');
    c.width = c.height = 72;
    drawBadge(c.getContext('2d')!, kind, 2, 2, 68);
    u = c.toDataURL();
    urls.set(kind, u);
  }
  return u;
}
