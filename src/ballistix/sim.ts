import { mulberry32 } from '../core/rng';
import {
  BALLS_BASE,
  BALL_R,
  BALL_SPEED_MAX,
  BALL_SPEED_PER_HIT,
  BALL_SPEED_START,
  BIG_SCALE,
  BOOST_DECAY,
  CALM_STEP,
  COUNTDOWN_SECONDS,
  ESCALATE_AT,
  FX_BIG,
  FX_CHILL,
  FX_SHIELD,
  FX_SPLIT,
  GOAL_HALF,
  H,
  LAST_STAND_SCALE,
  LAST_STAND_SMASH_RATE,
  MAX_DEFLECT,
  OWNER_TIME,
  PADDLE_ACCEL,
  PADDLE_BRAKE,
  PADDLE_CURVE,
  PADDLE_H,
  PADDLE_INSET,
  PADDLE_R,
  PADDLE_SPEED,
  PADDLE_TURN,
  RESPAWN_DELAY,
  SERVE_GAP,
  SERVE_HOLD,
  SIDES,
  SMASH_ANGLE_MUL,
  SMASH_BOOST,
  SMASH_CD,
  SMASH_REACH,
  SMASH_WINDOW,
  SPLIT_BALL_LIFE,
  SPLIT_SPREAD,
  WALL_R,
  ballCap,
  clamp,
  humanSeats,
  type CrateKind,
  type ItemKind,
  type MatchConfig,
  type Phase,
  type TimedEffect,
} from './config';

export interface PlayerStats {
  saves: number;
  /** Goals conceded. */
  conceded: number;
  /** Goals scored on other players (credited to the last paddle that touched the ball). */
  scored: number;
  /** Items collected. */
  crates: number;
  smashes: number;
}

export interface PlayerState {
  seat: number;
  human: boolean;
  /** Online guest: the paddle position comes from the network, the sim does not move it. */
  external: boolean;
  lives: number;
  alive: boolean;
  /** Paddle position along the tangent, measured from the goal centre. */
  s: number;
  /** Paddle velocity along the tangent. */
  vs: number;
  /** Desired movement in [-1, 1]; written by input or by a bot. */
  axis: number;
  /** One-shot action requests; written by input or by a bot, consumed (cleared) by every step. */
  smashReq: boolean;
  itemReq: boolean;
  /** Current paddle half length (animates toward its target). */
  h: number;
  fx: Record<TimedEffect, number>;
  /** Item waiting to be used, if any. */
  item: ItemKind | null;
  smashCd: number;
  /** Time left of the swing: an incoming ball within reach while > 0 gets smashed. */
  smashT: number;
  stats: PlayerStats;
}

export interface Ball {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Base speed. The actual speed is speed + boost. */
  speed: number;
  /** Temporary extra speed from smashes; decays to 0. */
  boost: number;
  /** Seat that touched the ball last, or -1 (credit for goals). */
  last: number;
  /** Seat that may collect crates with this ball, or -1: cleared by touching another ball or by time. */
  owner: number;
  ownerT: number;
  /** Serve hold time left (ball sits in the centre while > 0). */
  hold: number;
  /** Extra balls come from Split Shot: they never respawn and expire after `ttl`. */
  extra: boolean;
  ttl: number;
  sinceHit: number;
  /** Number of paddle hits so far; bots use it to tell shots apart. */
  hits: number;
  dead: boolean;
}

export interface Crate {
  id: number;
  x: number;
  y: number;
  kind: CrateKind;
  age: number;
  ttl: number;
  dead: boolean;
}

export type ServeReason = 'start' | 'respawn' | 'pressure';

export type SimEvent =
  | { t: 'countdown'; n: number }
  | { t: 'go' }
  | { t: 'serve'; id: number; reason: ServeReason }
  | { t: 'paddle'; seat: number; x: number; y: number; speed: number; id: number }
  | { t: 'smash'; seat: number; x: number; y: number; id: number }
  | { t: 'swing'; seat: number }
  | { t: 'split'; seat: number; x: number; y: number }
  | { t: 'wall'; seat: number; closed: boolean; x: number; y: number; speed: number }
  | { t: 'ballHit'; x: number; y: number }
  | { t: 'goal'; seat: number; x: number; y: number; by: number; lives: number; id: number; vx: number; vy: number }
  | { t: 'lastStand'; seat: number }
  | { t: 'eliminated'; seat: number }
  | { t: 'crateSpawn'; id: number; x: number; y: number; kind: CrateKind }
  | { t: 'pickup'; id: number; x: number; y: number; kind: CrateKind; seat: number; replaced: ItemKind | null }
  | { t: 'item'; seat: number; kind: ItemKind }
  | { t: 'crateExpire'; id: number; x: number; y: number }
  | { t: 'ballFade'; id: number; x: number; y: number }
  | { t: 'win'; seat: number };

const CRATE_R = 0.7;
const TIMED: readonly TimedEffect[] = ['big', 'shield', 'chill', 'split'];
const PADDLE_SEGMENTS = 8;

/**
 * Point on the curved paddle centre line at `u` (-h..h) for a paddle at `s`.
 * The middle bulges PADDLE_CURVE toward the arena; the ends sit on the paddle line.
 */
export function paddlePoint(seat: number, s: number, h: number, u: number, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
  const side = SIDES[seat];
  const k = h > 0 ? u / h : 0;
  const bulge = PADDLE_INSET + PADDLE_CURVE * (1 - k * k);
  out.x = side.w.x + side.n.x * bulge + side.t.x * (s + u);
  out.y = side.w.y + side.n.y * bulge + side.t.y * (s + u);
  return out;
}

// Scratch points for the paddle collision (it runs for every ball, paddle and step).
const PA = { x: 0, y: 0 };
const PB = { x: 0, y: 0 };

/**
 * Paddle movement with momentum: accelerate toward the stick, slide ("drift") to a stop when released.
 * Shared by the simulation and by online guests, who move their own paddle locally.
 */
export function movePaddle(p: PlayerState, dt: number, limit: number): void {
  const maxV = PADDLE_SPEED * (p.fx.chill > 0 ? 0.45 : 1);
  const input = clamp(p.axis, -1, 1);
  if (Math.abs(input) > 0.05) {
    const desired = input * maxV;
    const against = p.vs !== 0 && Math.sign(desired) !== Math.sign(p.vs);
    const a = (against ? PADDLE_TURN : PADDLE_ACCEL) * dt;
    p.vs += clamp(desired - p.vs, -a, a);
  } else {
    const b = PADDLE_BRAKE * dt;
    p.vs = Math.abs(p.vs) <= b ? 0 : p.vs - Math.sign(p.vs) * b;
  }
  if (Math.abs(p.vs) > maxV) p.vs = Math.sign(p.vs) * Math.max(maxV, Math.abs(p.vs) - PADDLE_TURN * dt);
  p.s += p.vs * dt;
  if (p.s > limit) {
    p.s = limit;
    p.vs = 0;
  } else if (p.s < -limit) {
    p.s = -limit;
    p.vs = 0;
  }
}

interface PendingServe {
  t: number;
  reason: ServeReason;
}

export class Sim {
  readonly players: PlayerState[];
  balls: Ball[] = [];
  crates: Crate[] = [];
  /** Events produced by the last step(); consumers must read them before the next step. */
  readonly events: SimEvent[] = [];
  phase: Phase = 'countdown';
  phaseTime = COUNTDOWN_SECONDS;
  time = 0;
  playTime = 0;
  /** Seconds since the last goal; drives the ball director. */
  sinceGoal = 0;
  winner = -1;

  private rng: () => number;
  private pending: PendingServe[] = [];
  private crateTimer = 5;
  private nextId = 1;
  private lastCount = 99;

  constructor(readonly cfg: MatchConfig) {
    this.rng = mulberry32(cfg.seed);
    const humans = cfg.seats ?? humanSeats(cfg.humans);
    this.players = [0, 1, 2, 3].map((seat) => ({
      seat,
      human: humans.includes(seat),
      external: false,
      lives: cfg.lives,
      alive: true,
      s: 0,
      vs: 0,
      axis: 0,
      smashReq: false,
      itemReq: false,
      h: PADDLE_H,
      fx: { big: 0, shield: 0, chill: 0, split: 0 },
      item: null,
      smashCd: 0,
      smashT: 0,
      stats: { saves: 0, conceded: 0, scored: 0, crates: 0, smashes: 0 },
    }));
  }

  get aliveCount(): number {
    let n = 0;
    for (const p of this.players) if (p.alive) n++;
    return n;
  }

  random(): number {
    return this.rng();
  }

  /** Furthest the paddle centre may travel: the paddle can cover the whole goal but never leaves it. */
  paddleLimit(h: number): number {
    return Math.max(0, GOAL_HALF - h + 0.35);
  }

  isClosed(seat: number): boolean {
    const p = this.players[seat];
    return !p.alive || p.fx.shield > 0;
  }

  /** True while the player is on their last life (Last Stand bonuses apply). */
  isLastStand(p: PlayerState): boolean {
    return p.alive && p.lives === 1 && this.cfg.lives > 1;
  }

  /** How many balls the director wants in play right now. */
  desiredBalls(): number {
    const calm = Math.floor(this.sinceGoal / CALM_STEP);
    const late = this.playTime > ESCALATE_AT ? 1 : 0;
    return Math.min(ballCap(this.aliveCount), BALLS_BASE + calm + late);
  }

  step(dt: number): void {
    this.events.length = 0;
    this.time += dt;
    this.updatePaddles(dt);

    if (this.phase === 'countdown') {
      this.phaseTime -= dt;
      const n = Math.ceil(this.phaseTime);
      if (n > 0 && n < this.lastCount) {
        this.lastCount = n;
        this.events.push({ t: 'countdown', n });
      }
      if (this.phaseTime <= 0) {
        this.phase = 'play';
        this.events.push({ t: 'go' });
        this.pending.push({ t: 0, reason: 'start' });
      }
    } else if (this.phase === 'play') {
      this.playTime += dt;
      this.sinceGoal += dt;
      this.updatePending(dt);
      this.updateBalls(dt);
      this.updateCrates(dt);
      this.refillBalls();
      this.checkWin();
    }
  }

  // --- paddles -------------------------------------------------------------------

  private updatePaddles(dt: number): void {
    for (const p of this.players) {
      if (!p.alive) {
        p.smashReq = false;
        p.itemReq = false;
        continue;
      }
      const lastStand = this.isLastStand(p);
      for (const k of TIMED) p.fx[k] = Math.max(0, p.fx[k] - dt);
      p.smashCd = Math.max(0, p.smashCd - dt * (lastStand ? LAST_STAND_SMASH_RATE : 1));
      p.smashT = Math.max(0, p.smashT - dt);

      if (p.smashReq && p.smashCd <= 0 && this.phase === 'play') {
        p.smashT = SMASH_WINDOW;
        p.smashCd = SMASH_CD;
        this.events.push({ t: 'swing', seat: p.seat });
      }
      if (p.itemReq && p.item && this.phase === 'play') this.useItem(p);
      p.smashReq = false;
      p.itemReq = false;

      const targetH = PADDLE_H * (p.fx.big > 0 ? BIG_SCALE : 1) * (lastStand ? LAST_STAND_SCALE : 1);
      p.h += (targetH - p.h) * Math.min(1, dt * 10);

      if (p.external) {
        const lim = this.paddleLimit(p.h);
        p.s = clamp(p.s, -lim, lim);
        continue;
      }
      movePaddle(p, dt, this.paddleLimit(p.h));
    }
  }

  private useItem(p: PlayerState): void {
    const kind = p.item as ItemKind;
    p.item = null;
    switch (kind) {
      case 'shield':
        p.fx.shield = FX_SHIELD;
        break;
      case 'big':
        p.fx.big = FX_BIG;
        break;
      case 'freeze':
        for (const o of this.players) if (o.alive && o.seat !== p.seat) o.fx.chill = FX_CHILL;
        break;
      case 'split':
        p.fx.split = FX_SPLIT;
        break;
    }
    this.events.push({ t: 'item', seat: p.seat, kind });
  }

  // --- balls ---------------------------------------------------------------------

  private updatePending(dt: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i].t -= dt;
      if (this.pending[i].t <= 0) {
        const { reason } = this.pending[i];
        this.pending.splice(i, 1);
        this.serve(reason);
      }
    }
  }

  /** Ball director: queues one serve at a time until the wanted number of balls is in play. */
  private refillBalls(): void {
    if (this.pending.length > 0) return;
    let live = 0;
    for (const b of this.balls) if (!b.dead) live++;
    if (live >= this.desiredBalls()) return;
    const regular = Math.min(ballCap(this.aliveCount), BALLS_BASE + (this.playTime > ESCALATE_AT ? 1 : 0));
    const reason: ServeReason = live >= regular ? 'pressure' : 'respawn';
    this.pending.push({ t: reason === 'respawn' && this.sinceGoal < RESPAWN_DELAY ? RESPAWN_DELAY : SERVE_GAP, reason });
  }

  private newBall(x: number, y: number, angle: number, speed: number, over: Partial<Ball> = {}): Ball {
    return {
      id: this.nextId++,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      speed,
      boost: 0,
      last: -1,
      owner: -1,
      ownerT: 0,
      hold: 0,
      extra: false,
      ttl: Infinity,
      sinceHit: 0,
      hits: 0,
      dead: false,
      ...over,
    };
  }

  private serve(reason: ServeReason): void {
    const alive = this.players.filter((p) => p.alive);
    if (alive.length === 0) return;
    const target = alive[Math.floor(this.rng() * alive.length)].seat;
    const out = SIDES[target].n;
    const angle = Math.atan2(-out.y, -out.x) + (this.rng() - 0.5) * 1.0;
    const ball = this.newBall(0, 0, angle, BALL_SPEED_START, { hold: SERVE_HOLD });
    this.balls.push(ball);
    this.events.push({ t: 'serve', id: ball.id, reason });
  }

  private updateBalls(dt: number): void {
    const balls = this.balls;
    for (const b of balls) {
      if (b.dead) continue;
      if (b.hold > 0) {
        b.hold -= dt;
        continue;
      }
      b.sinceHit += dt;
      if (b.ownerT > 0) {
        b.ownerT -= dt;
        if (b.ownerT <= 0) b.owner = -1;
      }
      // Anti-stall: a ball that nobody touches slowly speeds up.
      if (b.sinceHit > 6) b.speed = Math.min(BALL_SPEED_MAX, b.speed + 1.5 * dt);
      if (b.boost > 0) b.boost = Math.max(0, b.boost - BOOST_DECAY * dt);
      this.setSpeed(b);
      if (b.extra) {
        b.ttl -= dt;
        if (b.ttl <= 0) {
          b.dead = true;
          this.events.push({ t: 'ballFade', id: b.id, x: b.x, y: b.y });
          continue;
        }
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      this.collideWalls(b);
      for (const p of this.players) if (p.alive) this.collidePaddle(b, p);
      this.collideCrates(b);
      this.checkGoal(b);

      if (!b.dead && (Math.abs(b.x) > H + 4 || Math.abs(b.y) > H + 4)) {
        // Safety net: a ball that somehow left the arena is recycled without penalty.
        b.dead = true;
        this.events.push({ t: 'ballFade', id: b.id, x: b.x, y: b.y });
      }
    }

    for (const p of this.players) if (p.alive && p.smashT > 0) this.swing(p);
    this.collideBalls();
    this.balls = this.balls.filter((b) => !b.dead);
  }

  /** Keeps the velocity direction but forces its length to speed + boost. */
  private setSpeed(b: Ball): void {
    const m = Math.hypot(b.vx, b.vy);
    if (m < 1e-6) return;
    const k = (b.speed + b.boost) / m;
    b.vx *= k;
    b.vy *= k;
  }

  private collideSegment(b: Ball, ax: number, ay: number, bx: number, by: number, seat: number, closed: boolean): void {
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = abx * abx + aby * aby;
    const u = len2 > 0 ? clamp(((b.x - ax) * abx + (b.y - ay) * aby) / len2, 0, 1) : 0;
    const qx = ax + abx * u;
    const qy = ay + aby * u;
    const dx = b.x - qx;
    const dy = b.y - qy;
    const minD = BALL_R + WALL_R;
    const d2 = dx * dx + dy * dy;
    if (d2 >= minD * minD) return;
    const d = Math.sqrt(d2);
    const nx = d > 1e-6 ? dx / d : SIDES[seat].n.x;
    const ny = d > 1e-6 ? dy / d : SIDES[seat].n.y;
    b.x = qx + nx * minD;
    b.y = qy + ny * minD;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      b.vx -= 2 * vn * nx;
      b.vy -= 2 * vn * ny;
      this.events.push({ t: 'wall', seat, closed, x: qx, y: qy, speed: -vn });
    }
  }

  private collideWalls(b: Ball): void {
    for (let i = 0; i < 4; i++) {
      const s = SIDES[i];
      const closed = this.isClosed(i);
      if (closed) {
        this.collideSegment(b, s.w.x - s.t.x * H, s.w.y - s.t.y * H, s.w.x + s.t.x * H, s.w.y + s.t.y * H, i, true);
      } else {
        this.collideSegment(b, s.w.x - s.t.x * H, s.w.y - s.t.y * H, s.w.x - s.t.x * GOAL_HALF, s.w.y - s.t.y * GOAL_HALF, i, false);
        this.collideSegment(b, s.w.x + s.t.x * GOAL_HALF, s.w.y + s.t.y * GOAL_HALF, s.w.x + s.t.x * H, s.w.y + s.t.y * H, i, false);
      }
    }
  }

  /** Ball vs the curved paddle (a polyline capsule). */
  private collidePaddle(b: Ball, p: PlayerState): void {
    const side = SIDES[p.seat];
    const minD = BALL_R + PADDLE_R;
    // Cheap reject: far from the paddle.
    const fwd = (b.x - side.w.x) * side.n.x + (b.y - side.w.y) * side.n.y;
    if (fwd > PADDLE_INSET + PADDLE_CURVE + minD + 0.1 || fwd < PADDLE_INSET - minD - 0.1) return;

    let best = Infinity;
    let qx = 0;
    let qy = 0;
    let along = 0;
    let prev = paddlePoint(p.seat, p.s, p.h, -p.h, PA);
    let cur = PB;
    for (let i = 1; i <= PADDLE_SEGMENTS; i++) {
      const u1 = -p.h + (2 * p.h * i) / PADDLE_SEGMENTS;
      paddlePoint(p.seat, p.s, p.h, u1, cur);
      const ex = cur.x - prev.x;
      const ey = cur.y - prev.y;
      const len2 = ex * ex + ey * ey;
      const k = len2 > 0 ? clamp(((b.x - prev.x) * ex + (b.y - prev.y) * ey) / len2, 0, 1) : 0;
      const px = prev.x + ex * k;
      const py = prev.y + ey * k;
      const d2 = (b.x - px) ** 2 + (b.y - py) ** 2;
      if (d2 < best) {
        best = d2;
        qx = px;
        qy = py;
        along = -p.h + (2 * p.h * (i - 1 + k)) / PADDLE_SEGMENTS;
      }
      const swap = prev;
      prev = cur;
      cur = swap;
    }
    if (best >= minD * minD) return;

    const d = Math.sqrt(best);
    const nx = d > 1e-6 ? (b.x - qx) / d : side.n.x;
    const ny = d > 1e-6 ? (b.y - qy) / d : side.n.y;
    b.x = qx + nx * minD;
    b.y = qy + ny * minD;

    const pvx = side.t.x * p.vs;
    const pvy = side.t.y * p.vs;
    const rvn = (b.vx - pvx) * nx + (b.vy - pvy) * ny;
    if (rvn >= 0) return; // already separating

    if (nx * side.n.x + ny * side.n.y > 0.35) {
      // Front face: where it hits decides where it goes (the paddle's curved shape makes that easy to read).
      this.hitBall(b, p, along, p.smashT > 0, qx, qy);
    } else {
      // End cap or back: plain reflection about the contact normal.
      const vn = b.vx * nx + b.vy * ny;
      b.vx -= 2 * vn * nx;
      b.vy -= 2 * vn * ny;
      b.speed = Math.min(BALL_SPEED_MAX, b.speed + BALL_SPEED_PER_HIT);
      this.setSpeed(b);
      b.last = p.seat;
      b.owner = p.seat;
      b.ownerT = OWNER_TIME;
      b.sinceHit = 0;
      b.hits++;
      p.stats.saves++;
      this.events.push({ t: 'paddle', seat: p.seat, x: qx, y: qy, speed: b.speed + b.boost, id: b.id });
    }
  }

  /** Sends the ball back from the paddle. `along` is the hit position on the paddle (-h..h). */
  private hitBall(b: Ball, p: PlayerState, along: number, smash: boolean, x: number, y: number): void {
    const side = SIDES[p.seat];
    const off = clamp(along / (p.h + BALL_R * 0.5), -1, 1);
    let ang = off * MAX_DEFLECT + clamp(p.vs / PADDLE_SPEED, -1, 1) * 0.18;
    if (smash) ang = clamp(ang * SMASH_ANGLE_MUL, -1.2, 1.2);
    const dirX = side.n.x * Math.cos(ang) + side.t.x * Math.sin(ang);
    const dirY = side.n.y * Math.cos(ang) + side.t.y * Math.sin(ang);

    b.speed = Math.min(BALL_SPEED_MAX, b.speed + BALL_SPEED_PER_HIT);
    if (smash) {
      b.boost = SMASH_BOOST;
      p.stats.smashes++;
    }
    const total = b.speed + b.boost;
    b.vx = dirX * total;
    b.vy = dirY * total;
    b.last = p.seat;
    b.owner = p.seat;
    b.ownerT = OWNER_TIME;
    b.sinceHit = 0;
    b.hits++;
    p.stats.saves++;
    this.events.push({ t: 'paddle', seat: p.seat, x, y, speed: total, id: b.id });
    if (smash) this.events.push({ t: 'smash', seat: p.seat, x, y, id: b.id });

    if (p.fx.split > 0) {
      p.fx.split = 0;
      for (const da of [-SPLIT_SPREAD, SPLIT_SPREAD]) {
        const a = Math.atan2(dirY, dirX) + da;
        const extra = this.newBall(b.x, b.y, a, total, { speed: b.speed, boost: b.boost, last: p.seat, owner: p.seat, ownerT: OWNER_TIME, extra: true, ttl: SPLIT_BALL_LIFE, sinceHit: 0 });
        this.balls.push(extra);
      }
      this.events.push({ t: 'split', seat: p.seat, x: b.x, y: b.y });
    }
  }

  /** The smash swing reaches incoming balls in front of the paddle, so they need not touch it. */
  private swing(p: PlayerState): void {
    const side = SIDES[p.seat];
    const cx = side.w.x + side.n.x * PADDLE_INSET + side.t.x * p.s;
    const cy = side.w.y + side.n.y * PADDLE_INSET + side.t.y * p.s;
    for (const b of this.balls) {
      if (b.dead || b.hold > 0) continue;
      const rel = (b.x - cx) * side.t.x + (b.y - cy) * side.t.y;
      const fwd = (b.x - cx) * side.n.x + (b.y - cy) * side.n.y;
      if (Math.abs(rel) > p.h + 0.5 || fwd < -0.4 || fwd > SMASH_REACH) continue;
      const outward = b.vx * side.n.x + b.vy * side.n.y; // > 0 means moving away from this goal
      if (outward > 2) continue; // already leaving: nothing to hit back
      // Every ball that reaches the swing while it lasts is smashed; a ball that was just hit is flying
      // away (outward < 0) and is skipped above, so nothing is hit twice.
      this.hitBall(b, p, clamp(rel, -p.h, p.h), true, b.x, b.y);
    }
  }

  private collideBalls(): void {
    const bs = this.balls;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const c = bs[j];
        if (a.dead || c.dead || a.hold > 0 || c.hold > 0) continue;
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const d2 = dx * dx + dy * dy;
        const minD = BALL_R * 2;
        if (d2 >= minD * minD || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        const push = (minD - d) / 2;
        a.x -= nx * push;
        a.y -= ny * push;
        c.x += nx * push;
        c.y += ny * push;
        const rel = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
        if (rel >= 0) continue;
        // Touching another ball breaks ownership: neither ball can collect a crate until a paddle hits it again.
        a.owner = c.owner = -1;
        a.ownerT = c.ownerT = 0;
        // Equal masses: exchange the normal components, keep each ball's own speed.
        a.vx += rel * nx;
        a.vy += rel * ny;
        c.vx -= rel * nx;
        c.vy -= rel * ny;
        this.setSpeed(a);
        this.setSpeed(c);
        this.events.push({ t: 'ballHit', x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
      }
    }
  }

  private checkGoal(b: Ball): void {
    for (let i = 0; i < 4; i++) {
      if (this.isClosed(i)) continue;
      const s = SIDES[i];
      const d = (b.x - s.w.x) * s.n.x + (b.y - s.w.y) * s.n.y;
      if (d >= -0.1) continue;

      const p = this.players[i];
      const by = b.last === i ? -1 : b.last;
      b.dead = true;
      p.lives--;
      p.stats.conceded++;
      this.sinceGoal = 0;
      if (by >= 0) this.players[by].stats.scored++;
      this.events.push({ t: 'goal', seat: i, x: b.x, y: b.y, by, lives: p.lives, id: b.id, vx: b.vx, vy: b.vy });
      if (p.lives <= 0) {
        p.alive = false;
        p.vs = 0;
        p.axis = 0;
        p.item = null;
        this.events.push({ t: 'eliminated', seat: i });
      } else if (p.lives === 1 && this.cfg.lives > 1) {
        this.events.push({ t: 'lastStand', seat: i });
      }
      return;
    }
  }

  // --- crates --------------------------------------------------------------------

  private pickKind(): CrateKind {
    const lowLives = this.players.some((p) => p.alive && p.lives < this.cfg.lives);
    const table: [CrateKind, number][] = [
      ['shield', 3],
      ['big', 3],
      ['freeze', 2],
      ['split', 2.5],
      ['life', lowLives ? 1.6 : 0.25], // extra lives are rare unless somebody has lost one
    ];
    const total = table.reduce((a, [, w]) => a + w, 0);
    let r = this.rng() * total;
    for (const [kind, w] of table) {
      r -= w;
      if (r <= 0) return kind;
    }
    return 'shield';
  }

  private updateCrates(dt: number): void {
    for (const c of this.crates) {
      if (c.dead) continue;
      c.age += dt;
      if (c.age > c.ttl) {
        c.dead = true;
        this.events.push({ t: 'crateExpire', id: c.id, x: c.x, y: c.y });
      }
    }
    this.crates = this.crates.filter((c) => !c.dead);

    if (!this.cfg.crates) return;
    this.crateTimer -= dt;
    if (this.crateTimer > 0 || this.crates.length >= 2) return;
    this.crateTimer = 7 + this.rng() * 4;
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = this.rng() * Math.PI * 2;
      const r = 2.5 + this.rng() * 4; // out of the serve spot, still well inside the arena
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (this.balls.some((b) => Math.hypot(b.x - x, b.y - y) < 2.5)) continue;
      if (this.crates.some((c) => Math.hypot(c.x - x, c.y - y) < 3)) continue;
      const crate: Crate = { id: this.nextId++, x, y, kind: this.pickKind(), age: 0, ttl: 15, dead: false };
      this.crates.push(crate);
      this.events.push({ t: 'crateSpawn', id: crate.id, x, y, kind: crate.kind });
      return;
    }
  }

  /** Only a ball its owner hit directly (and that has not touched another ball) can collect a crate. */
  private collideCrates(b: Ball): void {
    if (b.owner < 0 || !this.players[b.owner].alive) return;
    for (const c of this.crates) {
      if (c.dead) continue;
      if (Math.hypot(b.x - c.x, b.y - c.y) >= BALL_R + CRATE_R) continue;
      c.dead = true;
      const p = this.players[b.owner];
      p.stats.crates++;
      let replaced: ItemKind | null = null;
      if (c.kind === 'life') {
        if (p.lives < this.cfg.lives) p.lives++;
        else p.fx.shield = Math.max(p.fx.shield, 4); // never wasted at full health
      } else {
        replaced = p.item;
        p.item = c.kind;
      }
      this.events.push({ t: 'pickup', id: c.id, x: c.x, y: c.y, kind: c.kind, seat: p.seat, replaced });
    }
  }

  // --- end of match --------------------------------------------------------------

  private checkWin(): void {
    if (this.aliveCount > 1) return;
    const w = this.players.find((p) => p.alive);
    this.winner = w ? w.seat : -1;
    this.phase = 'over';
    this.balls = [];
    this.crates = [];
    this.pending.length = 0;
    this.events.push({ t: 'win', seat: this.winner });
  }
}
