import { gaussian } from '../core/rng';
import { BALL_R, H, PADDLE_BRAKE, PADDLE_INSET, SIDES, SMASH_REACH, WALL_R, clamp, type Difficulty } from './config';
import type { PlayerState, Sim } from './sim';

interface Profile {
  /** Seconds between decisions (reaction time). */
  react: number;
  /** Fraction of the paddle's top speed the bot may use. */
  speed: number;
  /** Std-dev of the interception error in world units. */
  error: number;
  /** How far from the paddle centre the bot tries to hit, as a fraction of the paddle half length. */
  aim: number;
  /** Chance per incoming shot that the bot plans a smash. */
  smash: number;
  /** Std-dev (seconds) of the smash timing error; large values make the bot whiff more often. */
  timing: number;
  /** 0 = uses items at random moments, 1 = uses them when they help most. */
  itemSense: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  easy: { react: 0.36, speed: 0.55, error: 1.6, aim: 0.2, smash: 0.25, timing: 0.07, itemSense: 0 },
  normal: { react: 0.2, speed: 0.8, error: 0.85, aim: 0.5, smash: 0.5, timing: 0.035, itemSense: 0.6 },
  hard: { react: 0.1, speed: 0.95, error: 0.4, aim: 0.75, smash: 0.8, timing: 0.015, itemSense: 1 },
};

/** Mirror-fold a coordinate into [-lim, lim], as if bouncing between two walls. */
export function fold(x: number, lim: number): number {
  const w = 2 * lim;
  const k = (((x + lim) % (2 * w)) + 2 * w) % (2 * w);
  return (k < w ? k : 2 * w - k) - lim;
}

/** The ball that will reach a paddle first. */
interface Threat {
  /** Seconds until it reaches the paddle line. */
  t: number;
  /** Seconds until it is inside smash reach. */
  tReach: number;
  /** Predicted tangential position at the paddle line (before any error is added). */
  s: number;
  /** Identifies the shot: changes whenever the ball is hit. */
  key: number;
}

export class Bot {
  private profile: Profile;
  private timer = 0;
  private target = 0;
  /** Interception error for the current shot; rolled once per shot, not per decision. */
  private shotKey = -1;
  private shotError = 0;
  private shotAim = 0;
  private planSmash = false;
  private smashLead = 0.05;
  /** For "dumb" item use: seconds until the held item is fired anyway. */
  private itemClock = -1;
  private itemSmart = false;

  constructor(
    readonly seat: number,
    difficulty: Difficulty,
    private rng: () => number,
  ) {
    this.profile = PROFILES[difficulty];
    this.timer = this.rng() * this.profile.react;
  }

  /**
   * Returns the axis input in [-1, 1] for this tick and writes smash/item requests on the player,
   * exactly like a human's input would.
   */
  update(sim: Sim, dt: number): number {
    const p = sim.players[this.seat];
    if (!p.alive) return 0;

    const threat = this.findThreat(sim);
    if (threat && threat.key !== this.shotKey) this.newShot(threat, p);

    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.profile.react * (0.7 + this.rng() * 0.6);
      this.target = this.pickTarget(sim, p, threat);
    }

    if (threat && this.planSmash && p.smashCd <= 0 && threat.tReach < this.smashLead && Math.abs(threat.s - p.s) < p.h + 0.5) {
      p.smashReq = true;
      this.planSmash = false;
    }
    this.thinkItem(sim, p, threat, dt);

    // The paddle drifts: aim at where it will stop, not where it is.
    const stop = p.s + (p.vs * Math.abs(p.vs)) / (2 * PADDLE_BRAKE);
    const err = this.target - stop;
    return clamp(err / 0.6, -1, 1) * this.profile.speed;
  }

  private newShot(threat: Threat, p: PlayerState): void {
    this.shotKey = threat.key;
    this.shotError = gaussian(this.rng) * this.profile.error;
    this.shotAim = (this.rng() * 2 - 1) * this.profile.aim * p.h;
    this.planSmash = this.rng() < this.profile.smash;
    this.smashLead = 0.05 + gaussian(this.rng) * this.profile.timing;
  }

  private thinkItem(sim: Sim, p: PlayerState, threat: Threat | null, dt: number): void {
    if (!p.item) {
      this.itemClock = -1;
      return;
    }
    if (this.itemClock < 0) {
      // New item: decide once whether to play it smart or just fire it after a random delay.
      this.itemClock = 1 + this.rng() * 4;
      this.itemSmart = this.rng() < this.profile.itemSense;
    }
    this.itemClock -= dt;
    let use = this.itemClock <= 0;
    if (this.itemSmart) {
      switch (p.item) {
        case 'shield': // save it for a ball we cannot reach
          use = !!threat && threat.t < 0.45 && Math.abs(threat.s + this.shotError - p.s) > p.h + 0.8;
          break;
        case 'split': // arm it right before our next hit
          use = !!threat && threat.t < 0.8;
          break;
        case 'freeze': // when a ball is heading at an opponent
          use = sim.balls.some((b) => b.owner === p.seat && b.hold <= 0);
          break;
        case 'big':
          use = true;
          break;
      }
      if (this.itemClock < -6) use = true; // never sit on an item forever
    }
    if (use) {
      p.itemReq = true;
      this.itemClock = -1;
    }
  }

  private findThreat(sim: Sim): Threat | null {
    const side = SIDES[this.seat];
    const bounce = H - BALL_R - WALL_R;
    let best: Threat | null = null;
    for (const b of sim.balls) {
      if (b.hold > 0) continue;
      const along = (b.x - side.w.x) * side.n.x + (b.y - side.w.y) * side.n.y; // distance from the wall plane
      const vOut = -(b.vx * side.n.x + b.vy * side.n.y);
      if (vOut < 0.5) continue;
      const s0 = (b.x - side.w.x) * side.t.x + (b.y - side.w.y) * side.t.y;
      const vt = b.vx * side.t.x + b.vy * side.t.y;
      const t = Math.max(0, along - PADDLE_INSET) / vOut;
      const tReach = Math.max(0, along - PADDLE_INSET - SMASH_REACH * 0.8) / vOut;
      if (!best || t < best.t) best = { t, tReach, s: fold(s0 + vt * t, bounce), key: b.id * 1000 + b.hits };
    }
    return best;
  }

  private pickTarget(sim: Sim, p: PlayerState, threat: Threat | null): number {
    const lim = sim.paddleLimit(p.h);
    if (threat) return clamp(threat.s + this.shotError + this.shotAim, -lim, lim);
    // No ball is coming: drift toward the nearest ball's lane so we are ready.
    const side = SIDES[this.seat];
    let nearest: { s: number; d: number } | null = null;
    for (const b of sim.balls) {
      if (b.hold > 0) continue;
      const d = (b.x - side.w.x) * side.n.x + (b.y - side.w.y) * side.n.y;
      if (!nearest || d < nearest.d) nearest = { s: (b.x - side.w.x) * side.t.x + (b.y - side.w.y) * side.t.y, d };
    }
    return clamp((nearest ? nearest.s : 0) * 0.4, -lim, lim);
  }
}
