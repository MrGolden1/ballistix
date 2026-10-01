import { CRATE_INFO, type CrateKind } from './config';
import { drawBadge, itemIconURL } from './icons';

/**
 * The "Items & how to play" screen: one card per mechanic with a small looping animation that shows
 * what it does. The animations are hand-drawn top-down mini scenes (not the real game), only running
 * while the screen is open.
 */

const W = 220;
const H = 124;
const GY = 106; // goal line
const GX0 = 52; // goal posts
const GX1 = 168;
const MINE = '#ff8a1f';
const BALL = '#e8ecff';

type Demo = (g: CanvasRenderingContext2D, t: number) => void;

interface Card {
  id: string;
  title: string;
  icon?: CrateKind;
  color: string;
  text: string;
  demo: Demo;
}

const ease = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const seg = (t: number, a: number, b: number) => ease((t - a) / (b - a));

// ---- drawing helpers ----------------------------------------------------------------

function scene(g: CanvasRenderingContext2D, goalColor = MINE): void {
  g.fillStyle = '#1f2850';
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,0.035)';
  for (let i = 0; i < 11; i++) for (let j = 0; j < 7; j++) if ((i + j) % 2 === 0) g.fillRect(i * 20, j * 20, 20, 20);
  const grad = g.createLinearGradient(0, GY - 40, 0, H);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(1, goalColor + '55');
  g.fillStyle = grad;
  g.fillRect(GX0, GY - 40, GX1 - GX0, H - GY + 40);
  g.strokeStyle = '#5c6798';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, GY);
  g.lineTo(GX0, GY);
  g.moveTo(GX1, GY);
  g.lineTo(W, GY);
  g.stroke();
  g.strokeStyle = goalColor;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(GX0, GY);
  g.lineTo(GX1, GY);
  g.stroke();
  g.fillStyle = goalColor;
  for (const x of [GX0, GX1]) {
    g.beginPath();
    g.arc(x, GY, 4.5, 0, 7);
    g.fill();
  }
}

function paddle(g: CanvasRenderingContext2D, x: number, half: number, color = MINE, jab = 0, glow = 0): void {
  const y = GY - 15 - jab;
  g.save();
  if (glow > 0) {
    g.shadowColor = color;
    g.shadowBlur = 12 * glow;
  }
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x - half, y + 3);
  g.quadraticCurveTo(x, y - 8, x + half, y + 3);
  g.stroke();
  g.restore();
}

/** Soft flames licking up from the paddle while a split shot is armed (the game does the same in 3D). */
function flames(g: CanvasRenderingContext2D, x: number, half: number, t: number): void {
  const y = GY - 15;
  g.save();
  g.globalCompositeOperation = 'lighter';
  const tones = ['#ffc247', '#ff8a2a', '#ff8a2a', '#ff4a2a'];
  for (let k = 0; k < 9; k++) {
    const ph = (t * 1.8 + k * 0.37) % 1;
    const fx = x + (k / 8 - 0.5) * 2 * half + Math.sin(t * 9 + k * 2.1) * 2.5;
    const fy = y - 6 - ph * 16;
    g.globalAlpha = (1 - ph) * 0.8;
    g.fillStyle = tones[k % tones.length];
    g.beginPath();
    g.arc(fx, fy, (1 - ph) * 4.2 + 1, 0, 7);
    g.fill();
  }
  g.restore();
}

function ball(g: CanvasRenderingContext2D, x: number, y: number, color = BALL, r = 5, alpha = 1): void {
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, 7);
  g.fill();
  g.restore();
}

function heart(g: CanvasRenderingContext2D, x: number, y: number, s: number, fill: boolean, color: string): void {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.beginPath();
  g.moveTo(0, 6);
  g.bezierCurveTo(-11, -2, -6, -10, 0, -4);
  g.bezierCurveTo(6, -10, 11, -2, 0, 6);
  if (fill) {
    g.fillStyle = color;
    g.fill();
  } else {
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.lineWidth = 1.5;
    g.stroke();
  }
  g.restore();
}

function ring(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  g.save();
  g.globalAlpha = Math.max(0, alpha);
  g.strokeStyle = color;
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(x, y, r, 0, 7);
  g.stroke();
  g.restore();
}

function timerBar(g: CanvasRenderingContext2D, x: number, y: number, w: number, k: number, color: string): void {
  g.fillStyle = 'rgba(255,255,255,0.15)';
  g.fillRect(x, y, w, 4);
  g.fillStyle = color;
  g.fillRect(x, y, w * Math.max(0, Math.min(1, k)), 4);
}

// ---- the demos (each loops every 4 seconds) -------------------------------------------

const demoGrab: Demo = (g, t) => {
  scene(g);
  const info = CRATE_INFO.shield;
  const hit = 1.1;
  // crate
  if (t < hit + 0.05) {
    g.save();
    g.translate(110, 38 + Math.sin(t * 4) * 2);
    drawBadge(g, 'shield', -13, -13, 26);
    g.restore();
    ring(g, 110, 38, 20 + Math.sin(t * 5) * 2, info.css, 0.6);
  }
  paddle(g, 110, 20, MINE, t < 0.25 ? seg(t, 0, 0.25) * 4 : 0);
  // our ball goes up and hits the crate
  const by = t < 0.3 ? GY - 26 : lerp(GY - 26, 40, seg(t, 0.3, hit));
  if (t < hit) ball(g, 110, by, MINE);
  if (t >= hit) {
    // burst + the icon flies to a badge above our character
    ring(g, 110, 38, 8 + (t - hit) * 60, info.css, 1 - (t - hit) * 2.2);
    const k = seg(t, hit, hit + 0.7);
    const fx = lerp(110, 110, k);
    const fy = lerp(38, GY - 44, k) - Math.sin(k * Math.PI) * 18;
    if (k < 1) drawBadge(g, 'shield', fx - 11, fy - 11, 22);
    else {
      drawBadge(g, 'shield', 99, GY - 56 + Math.sin(t * 3) * 1.5, 22);
    }
  }
};

const demoSmash: Demo = (g, t) => {
  scene(g);
  const zoneTop = 44;
  const swing = t > 0.95 && t < 1.2;
  // the reach zone is always faintly outlined; it lights up when the swing happens
  g.save();
  g.setLineDash([4, 4]);
  g.strokeStyle = `rgba(255,190,90,${swing ? 0.95 : 0.35})`;
  g.lineWidth = 1.5;
  g.strokeRect(80, zoneTop, 60, GY - 20 - zoneTop);
  if (swing) {
    g.fillStyle = 'rgba(255,170,60,0.16)';
    g.fillRect(80, zoneTop, 60, GY - 20 - zoneTop);
  }
  g.restore();
  paddle(g, 110, 20, MINE, swing ? 7 : 0, swing ? 0.8 : 0);
  if (t < 1.0) {
    ball(g, 110, lerp(4, zoneTop + 4, seg(t, 0, 1.0)), BALL);
  } else if (t < 2.0) {
    const y = lerp(zoneTop + 4, -14, seg(t, 1.0, 1.7));
    for (let i = 1; i <= 4; i++) ball(g, 110, y + i * 9, '#ff9a3d', 4 - i * 0.6, 0.5 - i * 0.1);
    ball(g, 110, y, '#ffb25a', 5.5);
  }
};

const demoShield: Demo = (g, t) => {
  scene(g);
  paddle(g, 70, 20, MINE);
  const on = t > 0.8 && t < 3.3;
  // the ball heads for the part of the goal the paddle cannot reach
  const k = seg(t, 0.0, 1.9);
  let bx = lerp(150, 138, k);
  let by = lerp(2, GY - 6, k);
  if (t >= 1.9) {
    const r = seg(t, 1.9, 2.8);
    bx = lerp(138, 175, r);
    by = lerp(GY - 6, 24, r);
  }
  if (on) {
    g.save();
    g.fillStyle = 'rgba(255,138,31,0.30)';
    g.fillRect(GX0, GY - 22, GX1 - GX0, 22);
    g.strokeStyle = 'rgba(255,200,140,0.7)';
    g.lineWidth = 1;
    for (let x = GX0; x < GX1; x += 9) {
      g.beginPath();
      g.moveTo(x, GY - 22);
      g.lineTo(x + 4.5, GY);
      g.stroke();
    }
    g.restore();
    // the strip along the goal burns down with the remaining time
    const left = 1 - (t - 0.8) / 2.5;
    g.fillStyle = MINE;
    g.fillRect(110 - ((GX1 - GX0) / 2) * Math.max(0.04, left), GY - 2, (GX1 - GX0) * Math.max(0.04, left), 4);
  }
  if (t > 0.3 && t < 1.0) drawBadge(g, 'shield', 98, 52 - seg(t, 0.3, 1) * 8, 24);
  ball(g, bx, by, BALL);
  if (t > 1.85 && t < 2.3) ring(g, 138, GY - 6, 6 + (t - 1.85) * 40, '#bfeaff', 1 - (t - 1.85) * 2.2);
};

const demoBig: Demo = (g, t) => {
  scene(g, '#ffd23f');
  const grow = seg(t, 0.5, 1.0) - seg(t, 3.0, 3.5);
  const half = lerp(11, 30, grow);
  paddle(g, 112, half, MINE, 0, grow);
  if (grow > 0.05) timerBar(g, GX0, H - 8, GX1 - GX0, t < 3.0 ? 1 - (t - 0.5) / 2.5 : 0, '#ffd23f');
  if (t > 0.1 && t < 0.6) drawBadge(g, 'big', 98, 56 - seg(t, 0.1, 0.6) * 10, 24);
  // a ball only the big paddle can return
  const k = seg(t, 1.2, 2.0);
  if (t >= 1.2 && t < 2.0) ball(g, 142, lerp(4, GY - 26, k), BALL);
  if (t >= 2.0 && t < 2.8) ball(g, lerp(142, 175, seg(t, 2.0, 2.8)), lerp(GY - 26, 20, seg(t, 2.0, 2.8)), BALL);
};

const demoFreeze: Demo = (g, t) => {
  scene(g);
  const frozen = t > 1.0 && t < 3.0;
  const slow = frozen ? 0.15 : 1;
  const phase = (t0: number) => Math.sin((frozen ? 1.0 + (t - 1.0) * slow : t) * 2 + t0) * 0.5 + 0.5;
  const col = frozen ? '#9bf6ff' : '#a8b0d8';
  // three opponents: top, left, right
  const top = lerp(70, 150, phase(0));
  const left = lerp(24, 80, phase(1.7));
  const right = lerp(24, 80, phase(3.1));
  g.save();
  g.strokeStyle = col;
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(top - 18, 14);
  g.quadraticCurveTo(top, 22, top + 18, 14);
  g.moveTo(14, left - 14);
  g.quadraticCurveTo(22, left, 14, left + 14);
  g.moveTo(W - 14, right - 14);
  g.quadraticCurveTo(W - 22, right, W - 14, right + 14);
  g.stroke();
  g.restore();
  // my paddle keeps moving at full speed
  paddle(g, 110 + Math.sin(t * 3) * 34, 20, MINE);
  if (frozen) {
    g.fillStyle = '#9bf6ff';
    g.font = '700 13px system-ui';
    for (const [x, y] of [[top, 28], [28, left], [W - 28, right]] as [number, number][]) g.fillText('✻', x - 5, y + 5);
    timerBar(g, GX0, H - 8, GX1 - GX0, 1 - (t - 1.0) / 2.0, '#9bf6ff');
  }
  if (t > 0.2 && t < 1.0) drawBadge(g, 'freeze', 98, 62 - seg(t, 0.2, 1) * 8, 24);
  if (t > 1.0 && t < 1.5) ring(g, 110, 62, (t - 1.0) * 220, '#9bf6ff', 1 - (t - 1.0) * 2);
};

const demoSplit: Demo = (g, t) => {
  scene(g);
  const armed = t > 0.3 && t < 1.2;
  paddle(g, 110, 20, MINE, 0, armed ? 0.3 : 0);
  if (armed) flames(g, 110, 20, t);
  if (t < 1.2) {
    ball(g, 110, lerp(2, GY - 26, seg(t, 0, 1.2)), BALL);
  } else if (t < 3.4) {
    const k = seg(t, 1.2, 2.4);
    const y0 = GY - 26;
    const fade = t > 2.9 ? 1 - (t - 2.9) / 0.5 : 1;
    ring(g, 110, y0, (t - 1.2) * 40, CRATE_INFO.split.css, 0.9 - (t - 1.2) * 1.6);
    for (const a of [-0.55, 0, 0.55]) {
      const x = 110 + Math.sin(a) * 92 * k;
      const y = y0 - Math.cos(a) * 92 * k;
      ball(g, x, y, a === 0 ? BALL : CRATE_INFO.split.css, 5, a === 0 ? 1 : fade);
    }
  }
};

const demoLife: Demo = (g, t) => {
  scene(g, '#7dff8a');
  paddle(g, 110, 20, MINE);
  const color = '#ff6b6b';
  const k = seg(t, 0.6, 1.3);
  for (let i = 0; i < 5; i++) {
    const filled = i < 3 || (i === 3 && t > 1.3);
    const pop = i === 3 && t > 1.3 ? 1 + Math.sin(Math.min(1, (t - 1.3) * 3) * Math.PI) * 0.5 : 1;
    heart(g, 62 + i * 24, 26, pop, filled, color);
  }
  if (t > 0.2 && t < 1.3) {
    // the crate's heart flies into the row
    const x = lerp(110, 62 + 3 * 24, k);
    const y = lerp(76, 26, k) - Math.sin(k * Math.PI) * 14;
    heart(g, x, y, 1.4, true, '#7dff8a');
  }
  if (t > 1.3 && t < 2.6) {
    g.fillStyle = '#7dff8a';
    g.font = '900 16px system-ui';
    g.fillText('+1', 62 + 3 * 24 - 9, 14 - (t - 1.3) * 12);
  }
};

const CARDS: Card[] = [
  { id: 'grab', title: 'GRAB ITEMS', color: '#ffd23f', demo: demoGrab, text: 'Hit a crate with a ball you just hit yourself. A ball stops being yours when it touches another ball (or after 5 seconds), so aim your own shots. The item appears above your character and in your panel; use it with the item button.' },
  { id: 'smash', title: 'SMASH', color: MINE, demo: demoSmash, text: 'Press smash as a ball gets close: the swing reaches in front of your paddle, so the ball does not have to touch it. A smashed ball flies much faster, in a straight line.' },
  { id: 'shield', title: CRATE_INFO.shield.label, icon: 'shield', color: CRATE_INFO.shield.css, demo: demoShield, text: 'Seals your goal with an energy field in your colour for 6 seconds. The strip along the goal shows the time left, and the field flickers just before it ends. Keep it for a ball you cannot reach.' },
  { id: 'big', title: CRATE_INFO.big.label, icon: 'big', color: CRATE_INFO.big.css, demo: demoBig, text: 'A longer paddle for 10 seconds, so it covers more of your goal.' },
  { id: 'freeze', title: CRATE_INFO.freeze.label, icon: 'freeze', color: CRATE_INFO.freeze.css, demo: demoFreeze, text: 'Everyone else moves slowly for 4 seconds. You do not.' },
  { id: 'split', title: CRATE_INFO.split.label, icon: 'split', color: CRATE_INFO.split.css, demo: demoSplit, text: 'Your paddle smoulders until your next hit, which splits into 3 balls. The two extra balls vanish after 10 seconds.' },
  { id: 'life', title: CRATE_INFO.life.label, icon: 'life', color: CRATE_INFO.life.css, demo: demoLife, text: '+1 life, instantly. If you are already at full lives you get a short shield instead.' },
];

export class Guide {
  private canvases: { g: CanvasRenderingContext2D; demo: Demo }[] = [];
  private raf = 0;
  private t0 = 0;

  constructor(grid: HTMLElement) {
    grid.innerHTML = '';
    for (const c of CARDS) {
      const el = document.createElement('div');
      el.className = 'gcard';
      el.style.setProperty('--c', c.color);
      const icon = c.icon ? `<img src="${itemIconURL(c.icon)}" alt="">` : '';
      el.innerHTML = `<canvas width="${W}" height="${H}"></canvas><h3>${icon}${c.title}</h3><p>${c.text}</p>`;
      grid.appendChild(el);
      const canvas = el.querySelector('canvas') as HTMLCanvasElement;
      this.canvases.push({ g: canvas.getContext('2d')!, demo: c.demo });
    }
  }

  /** Starts the animations (call when the screen opens). */
  start(): void {
    cancelAnimationFrame(this.raf);
    this.t0 = performance.now();
    const loop = (now: number) => {
      const t = ((now - this.t0) / 1000) % 4;
      for (const c of this.canvases) c.demo(c.g, t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}
