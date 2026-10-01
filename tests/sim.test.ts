import { describe, expect, it } from 'vitest';
import { Bot, fold } from '../src/ballistix/bot';
import {
  BALL_R,
  CALM_STEP,
  GOAL_HALF,
  H,
  LAST_STAND_SCALE,
  PADDLE_H,
  PADDLE_INSET,
  PADDLE_SPEED,
  SIDES,
  SMASH_BOOST,
  SMASH_CD,
  ballCap,
  type CrateKind,
  type Difficulty,
  type MatchConfig,
} from '../src/ballistix/config';
import { Sim, type Ball, type SimEvent } from '../src/ballistix/sim';
import { mulberry32 } from '../src/core/rng';

const DT = 1 / 120;

function makeSim(over: Partial<MatchConfig> = {}): Sim {
  return new Sim({ humans: 0, difficulty: 'normal', lives: 3, crates: false, seed: 1, ...over });
}

function skipCountdown(sim: Sim): void {
  while (sim.phase === 'countdown') sim.step(DT);
}

function makeBall(x: number, y: number, vx: number, vy: number, speed = 9): Ball {
  return { id: 9999, x, y, vx, vy, speed, boost: 0, last: -1, owner: -1, ownerT: 0, hold: 0, extra: false, ttl: Infinity, sinceHit: 0, hits: 0, dead: false };
}

/** Replaces all balls with one ball (served balls will still arrive later). */
function putBall(sim: Sim, x: number, y: number, vx: number, vy: number, speed = 9): Ball {
  const b = makeBall(x, y, vx, vy, speed);
  sim.balls = [b];
  return b;
}

function putCrate(sim: Sim, kind: CrateKind, x = 0, y = 0): void {
  sim.crates = [{ id: 77, x, y, kind, age: 0, ttl: 14, dead: false }];
}

/** Makes a seat the owner of a ball (as if its paddle had just hit it). */
function own(b: Ball, seat: number): Ball {
  b.last = seat;
  b.owner = seat;
  b.ownerT = 5;
  return b;
}

/** Steps until `pred` matches an event (or the limit is reached) and returns whether it did. */
function stepUntil(sim: Sim, pred: (e: SimEvent) => boolean, maxSteps = 600): boolean {
  for (let i = 0; i < maxSteps; i++) {
    sim.step(DT);
    if (sim.events.some(pred)) return true;
  }
  return false;
}

describe('fold', () => {
  it('mirrors coordinates between walls', () => {
    expect(fold(0, 5)).toBeCloseTo(0);
    expect(fold(6, 5)).toBeCloseTo(4);
    expect(fold(-6, 5)).toBeCloseTo(-4);
    expect(fold(11, 5)).toBeCloseTo(-1);
    expect(fold(15, 5)).toBeCloseTo(-5);
  });
});

describe('Sim basics', () => {
  it('runs a countdown then serves the first ball', () => {
    const sim = makeSim();
    const seen: number[] = [];
    while (sim.phase === 'countdown') {
      sim.step(DT);
      for (const e of sim.events) if (e.t === 'countdown') seen.push(e.n);
    }
    expect(seen).toEqual([3, 2, 1]);
    for (let i = 0; i < 5; i++) sim.step(DT);
    expect(sim.balls).toHaveLength(1);
  });

  it('keeps the paddle inside its limits', () => {
    const sim = makeSim({ humans: 1 });
    skipCountdown(sim);
    sim.players[0].axis = 1;
    for (let i = 0; i < 600; i++) sim.step(DT);
    expect(sim.players[0].s).toBeLessThanOrEqual(sim.paddleLimit(sim.players[0].h) + 1e-9);
    sim.players[0].axis = -1;
    for (let i = 0; i < 1200; i++) sim.step(DT);
    expect(sim.players[0].s).toBeGreaterThanOrEqual(-sim.paddleLimit(sim.players[0].h) - 1e-9);
  });

  it('no crates spawn when crates are disabled', () => {
    const sim = makeSim({ crates: false });
    skipCountdown(sim);
    for (let i = 0; i < 120 * 40; i++) {
      sim.balls = [];
      sim.step(DT);
      expect(sim.crates).toHaveLength(0);
    }
  });
});

describe('movement with drift', () => {
  it('reaches top speed, then slides on after the stick is released', () => {
    const sim = makeSim({ humans: 1 });
    skipCountdown(sim);
    const p = sim.players[0];
    p.s = -sim.paddleLimit(p.h);
    p.axis = 1;
    for (let i = 0; i < 40; i++) sim.step(DT);
    expect(p.vs).toBeCloseTo(PADDLE_SPEED, 1);
    p.axis = 0;
    const released = p.s;
    let steps = 0;
    while (p.vs > 0 && steps < 240) {
      sim.step(DT);
      steps++;
    }
    expect(p.s - released).toBeGreaterThan(1.5); // it drifts
    expect(p.s - released).toBeLessThan(3.5); // but not forever
    expect(steps).toBeLessThan(60);
  });

  it('pushing the other way stops it much faster than letting it drift', () => {
    const run = (counter: boolean): number => {
      const sim = makeSim({ humans: 1 });
      skipCountdown(sim);
      const p = sim.players[0];
      p.s = -sim.paddleLimit(p.h);
      p.axis = 1;
      for (let i = 0; i < 40; i++) sim.step(DT);
      p.axis = counter ? -1 : 0;
      const start = p.s;
      while (p.vs > 0) sim.step(DT);
      return p.s - start;
    };
    expect(run(true)).toBeLessThan(run(false) * 0.5);
  });
});

describe('collisions', () => {
  it('bounces off a corner wall', () => {
    const sim = makeSim();
    skipCountdown(sim);
    const b = putBall(sim, H - 2, -8, 9, 0);
    for (let i = 0; i < 120; i++) sim.step(DT);
    expect(b.vx).toBeLessThan(0);
    expect(b.dead).toBe(false);
  });

  it('is deflected by the paddle instead of scoring', () => {
    const sim = makeSim();
    skipCountdown(sim);
    const b = putBall(sim, 0, H - 4, 0, 9);
    const lives = sim.players[0].lives;
    expect(stepUntil(sim, (e) => e.t === 'paddle' && e.seat === 0, 240)).toBe(true);
    expect(sim.players[0].lives).toBe(lives);
    expect(b.vy).toBeLessThan(0);
    expect(b.last).toBe(0);
  });

  it('steers the ball with the hit position', () => {
    const sim = makeSim();
    skipCountdown(sim);
    sim.players[0].s = 0;
    const b = putBall(sim, PADDLE_H * 0.9, H - PADDLE_INSET - 1.8, 0, 9);
    for (let i = 0; i < 60; i++) sim.step(DT);
    expect(b.vx).toBeGreaterThan(2);
  });

  it('the paddle is curved: the middle meets the ball earlier than the ends', () => {
    const contactY = (x: number): number => {
      const sim = makeSim();
      skipCountdown(sim);
      sim.players[0].s = 0;
      putBall(sim, x, H - 4, 0, 9);
      let y = NaN;
      stepUntil(sim, (e) => {
        if (e.t === 'paddle' && e.seat === 0) y = e.y;
        return e.t === 'paddle';
      });
      return y;
    };
    expect(contactY(0)).toBeLessThan(contactY(PADDLE_H * 0.9) - 0.08);
  });

  it('scores a goal against the defender who misses, crediting the last toucher', () => {
    const sim = makeSim();
    skipCountdown(sim);
    sim.players[0].s = sim.paddleLimit(sim.players[0].h);
    const b = putBall(sim, -3.5, H - 4, 0, 9);
    b.last = 1;
    b.owner = 1;
    b.ownerT = 5;
    expect(stepUntil(sim, (e) => e.t === 'goal' && e.seat === 0, 240)).toBe(true);
    expect(sim.players[0].lives).toBe(2);
    expect(sim.players[1].stats.scored).toBe(1);
    expect(sim.players[0].stats.conceded).toBe(1);
  });

  it('seals the goal of an eliminated player', () => {
    const sim = makeSim({ lives: 1 });
    skipCountdown(sim);
    sim.players[0].s = sim.paddleLimit(sim.players[0].h);
    putBall(sim, -3.5, H - 4, 0, 9);
    stepUntil(sim, (e) => e.t === 'eliminated', 240);
    expect(sim.players[0].alive).toBe(false);
    expect(sim.isClosed(0)).toBe(true);
    const b = putBall(sim, 0, H - 4, 0, 9);
    for (let i = 0; i < 240; i++) sim.step(DT);
    expect(b.dead).toBe(false);
    expect(b.vy).toBeLessThan(0);
  });

  it('never lets a ball tunnel through walls at top speed (with a smash boost)', () => {
    const sim = makeSim({ lives: 99 });
    skipCountdown(sim);
    const rng = mulberry32(5);
    for (let n = 0; n < 200; n++) {
      const a = rng() * Math.PI * 2;
      const b = putBall(sim, (rng() - 0.5) * 6, (rng() - 0.5) * 6, Math.cos(a) * 30, Math.sin(a) * 30, 22);
      b.boost = SMASH_BOOST;
      for (let i = 0; i < 360 && !b.dead; i++) {
        sim.step(DT);
        if (!b.dead) {
          expect(Math.abs(b.x)).toBeLessThan(H + 0.2);
          expect(Math.abs(b.y)).toBeLessThan(H + 0.2);
        }
      }
    }
  });

  it('an untouched ball slowly speeds up (anti-stall)', () => {
    const sim = makeSim();
    skipCountdown(sim);
    const b = putBall(sim, -5, -5, 7, 5, 10);
    b.sinceHit = 7;
    for (let i = 0; i < 120; i++) sim.step(DT);
    expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(11);
  });
});

describe('smash', () => {
  function swing(sim: Sim, seat: number): void {
    sim.players[seat].smashReq = true;
    sim.step(DT);
    expect(sim.events.some((e) => e.t === 'swing' && e.seat === seat)).toBe(true);
  }

  it('reaches a ball that is close but not touching the paddle', () => {
    const sim = makeSim();
    skipCountdown(sim);
    const b = putBall(sim, 0, H - PADDLE_INSET - 1.3, 0, 6); // ~1.3 in front, coming in
    sim.players[0].smashReq = true;
    sim.step(DT);
    expect(sim.events.some((e) => e.t === 'smash' && e.seat === 0)).toBe(true);
    expect(b.vy).toBeLessThan(0);
    expect(b.boost).toBeGreaterThan(SMASH_BOOST - 1);
    expect(sim.players[0].stats.smashes).toBe(1);
  });

  it('does not reach balls that are far away, and the boost decays back to normal', () => {
    const sim = makeSim();
    skipCountdown(sim);
    const b = putBall(sim, 0, H - 6, 0, 9); // 5 units away, arrives after the window
    swing(sim, 0);
    expect(sim.events.some((e) => e.t === 'smash')).toBe(false);
    expect(stepUntil(sim, (e) => e.t === 'paddle' && e.seat === 0, 240)).toBe(true);
    expect(b.boost).toBe(0);

    const s2 = makeSim();
    skipCountdown(s2);
    const c = putBall(s2, 0, H - 3, 0, 9);
    swing(s2, 0);
    expect(stepUntil(s2, (e) => e.t === 'smash', 60)).toBe(true);
    for (let i = 0; i < 120 * 2; i++) s2.step(DT);
    expect(c.boost).toBe(0);
    expect(Math.hypot(c.vx, c.vy)).toBeCloseTo(c.speed, 3);
  });

  it('does not re-hit a ball that is already flying away', () => {
    const sim = makeSim();
    skipCountdown(sim);
    putBall(sim, 0, H - PADDLE_INSET - 1, 0, -9);
    swing(sim, 0);
    for (let i = 0; i < 30; i++) sim.step(DT);
    expect(sim.players[0].stats.smashes).toBe(0);
  });

  it('whiffing costs a cooldown and a second press is ignored until it is over', () => {
    const sim = makeSim();
    skipCountdown(sim);
    putBall(sim, -8, -8, 1, 0, 1);
    swing(sim, 0);
    expect(sim.players[0].smashCd).toBeGreaterThan(SMASH_CD - 0.05);
    for (let i = 0; i < 40; i++) sim.step(DT);
    sim.players[0].smashReq = true;
    sim.step(DT);
    expect(sim.events.some((e) => e.t === 'swing')).toBe(false);
  });

});

describe('ball director', () => {
  it('starts with two balls, adds one per quiet spell and respects the cap', () => {
    const sim = makeSim({ lives: 99 });
    skipCountdown(sim);
    for (const p of sim.players) p.fx.shield = 999; // nobody can concede: the arena keeps heating up
    let pressure = 0;
    const counts: number[] = [];
    for (let i = 0; i < 120 * 60; i++) {
      sim.step(DT);
      for (const p of sim.players) p.fx.shield = 999;
      pressure += sim.events.filter((e) => e.t === 'serve' && e.reason === 'pressure').length;
      if (i % 120 === 0) counts.push(sim.balls.length);
    }
    expect(counts[3]).toBe(2); // after 3 s
    expect(Math.max(...counts)).toBe(ballCap(4));
    expect(pressure).toBeGreaterThanOrEqual(ballCap(4) - 2);
    expect(sim.desiredBalls()).toBe(ballCap(4));
  });

  it('a goal resets the pressure (no new balls until it builds up again)', () => {
    const sim = makeSim({ lives: 99 });
    skipCountdown(sim);
    sim.sinceGoal = CALM_STEP * 2 + 0.5;
    expect(sim.desiredBalls()).toBe(4);
    sim.players[0].s = sim.paddleLimit(sim.players[0].h);
    sim.balls.push(makeBall(-3.5, H - 3, 0, 9));
    stepUntil(sim, (e) => e.t === 'goal', 240);
    expect(sim.desiredBalls()).toBe(2);
  });

  it('caps the number of balls by the players left', () => {
    expect(ballCap(4)).toBe(5);
    expect(ballCap(3)).toBe(4);
    expect(ballCap(2)).toBe(3);
  });
});

describe('items', () => {
  it('only a ball with an owner collects a crate', () => {
    const sim = makeSim();
    skipCountdown(sim);
    putCrate(sim, 'shield');
    putBall(sim, 0, 0.5, 0, 0.0001);
    sim.step(DT);
    expect(sim.crates).toHaveLength(1); // nobody owns that ball

    sim.balls[0].owner = 1;
    sim.balls[0].ownerT = 5;
    sim.step(DT);
    expect(sim.crates).toHaveLength(0);
    expect(sim.players[1].item).toBe('shield');
  });

  it('a ball that touched another ball loses its owner, so it cannot collect a crate', () => {
    const sim = makeSim();
    skipCountdown(sim);
    putCrate(sim, 'shield', 3, 0);
    const mine = own(makeBall(-3, 0, 6, 0), 1);
    const other = makeBall(0, 0, -6, 0);
    other.id = 4242;
    sim.balls = [mine, other];
    // The two balls meet head-on before the crate: ownership is gone, and the other ball can pass the crate.
    for (let i = 0; i < 90; i++) sim.step(DT);
    expect(mine.owner).toBe(-1);
    expect(other.x).toBeGreaterThan(3.5); // it went right through the crate position
    expect(sim.players[1].item).toBeNull();
    expect(sim.crates).toHaveLength(1);
  });

  it('ownership also runs out after a few seconds', () => {
    const sim = makeSim({ lives: 99 });
    skipCountdown(sim);
    const b = own(putBall(sim, 0, 0, 3, 2, 1), 1); // slow: it never reaches a paddle in 5 s
    for (let i = 0; i < 120 * 4.9; i++) sim.step(DT);
    expect(b.owner).toBe(1);
    for (let i = 0; i < 120 * 0.4; i++) sim.step(DT);
    expect(b.owner).toBe(-1);
    expect(b.last).toBe(1); // goal credit is a separate thing and stays
  });

  it('a direct paddle hit makes the hitter the owner', () => {
    const sim = makeSim();
    skipCountdown(sim);
    const b = putBall(sim, 0, H - 4, 0, 9);
    expect(stepUntil(sim, (e) => e.t === 'paddle' && e.seat === 0, 240)).toBe(true);
    expect(b.owner).toBe(0);
    expect(b.ownerT).toBeGreaterThan(4.5);
  });

  it('items are held until used; a new pickup replaces the old one', () => {
    const sim = makeSim();
    skipCountdown(sim);
    putCrate(sim, 'big');
    own(putBall(sim, 0, 0.5, 0, 0.0001), 1);
    sim.step(DT);
    expect(sim.players[1].item).toBe('big');
    expect(sim.players[1].fx.big).toBe(0);
    putCrate(sim, 'freeze');
    own(putBall(sim, 0, 0.5, 0, 0.0001), 1);
    sim.step(DT);
    expect(sim.players[1].item).toBe('freeze');
  });

  it('using each item does what it says', () => {
    const use = (kind: 'shield' | 'big' | 'freeze' | 'split') => {
      const sim = makeSim();
      skipCountdown(sim);
      sim.balls = [];
      sim.players[1].item = kind;
      sim.players[1].itemReq = true;
      sim.step(DT);
      expect(sim.events.some((e) => e.t === 'item' && e.kind === kind)).toBe(true);
      expect(sim.players[1].item).toBeNull();
      return sim;
    };
    expect(use('shield').isClosed(1)).toBe(true);
    const big = use('big');
    for (let i = 0; i < 120; i++) big.step(DT);
    expect(big.players[1].h).toBeGreaterThan(PADDLE_H * 1.4);
    const fr = use('freeze');
    expect(fr.players[0].fx.chill).toBeGreaterThan(0);
    expect(fr.players[1].fx.chill).toBe(0);
    expect(use('split').players[1].fx.split).toBeGreaterThan(0);
  });

  it('split shot turns your next hit into three balls', () => {
    const sim = makeSim();
    skipCountdown(sim);
    sim.players[0].fx.split = 5;
    putBall(sim, 0, H - 4, 0, 9);
    expect(stepUntil(sim, (e) => e.t === 'split' && e.seat === 0, 240)).toBe(true);
    const mine = sim.balls.filter((b) => b.last === 0);
    expect(mine).toHaveLength(3);
    expect(mine.filter((b) => b.extra)).toHaveLength(2);
    expect(sim.players[0].fx.split).toBe(0);
  });

  it('extra life is instant: +1 life, or a shield at full lives', () => {
    const sim = makeSim();
    skipCountdown(sim);
    sim.players[1].lives = 2;
    putCrate(sim, 'life');
    own(putBall(sim, 0, 0.5, 0, 0.0001), 1);
    sim.step(DT);
    expect(sim.players[1].lives).toBe(3);
    expect(sim.players[1].item).toBeNull();
    putCrate(sim, 'life');
    own(putBall(sim, 0, 0.5, 0, 0.0001), 1);
    sim.step(DT);
    expect(sim.players[1].lives).toBe(3);
    expect(sim.players[1].fx.shield).toBeGreaterThan(0);
  });

  it('crates spawn away from the serve spot and inside the arena', () => {
    const sim = makeSim({ crates: true, seed: 3 });
    skipCountdown(sim);
    for (let n = 0; n < 2000; n++) {
      sim.balls = [];
      sim.crates = [];
      (sim as unknown as { crateTimer: number }).crateTimer = 0;
      sim.step(DT);
      for (const c of sim.crates) {
        const r = Math.hypot(c.x, c.y);
        expect(r).toBeGreaterThan(2.4);
        expect(r).toBeLessThan(6.6);
      }
    }
  });
});

describe('last stand', () => {
  it('grows the paddle and announces itself when a player drops to one life', () => {
    const sim = makeSim({ lives: 2 });
    skipCountdown(sim);
    sim.players[0].s = sim.paddleLimit(sim.players[0].h);
    putBall(sim, -3.5, H - 4, 0, 9);
    expect(stepUntil(sim, (e) => e.t === 'lastStand' && e.seat === 0, 240)).toBe(true);
    for (let i = 0; i < 120; i++) sim.step(DT);
    expect(sim.isLastStand(sim.players[0])).toBe(true);
    expect(sim.players[0].h).toBeGreaterThan(PADDLE_H * LAST_STAND_SCALE - 0.02);
  });

  it('recharges smash faster', () => {
    const sim = makeSim({ humans: 1 });
    skipCountdown(sim);
    const p = sim.players[0];
    p.smashCd = 0.9;
    p.lives = 1;
    for (let i = 0; i < 48; i++) sim.step(DT); // 0.4 s
    expect(p.smashCd).toBeLessThan(0.9 - 0.4 * 1.4);
  });

  it('does not apply in a one-life match', () => {
    expect(makeSim({ lives: 1 }).isLastStand(makeSim({ lives: 1 }).players[0])).toBe(false);
  });
});

function runBotMatch(seed: number, difficulty: Difficulty, lives = 5, maxSeconds = 900) {
  const sim = makeSim({ seed, difficulty, lives, crates: true });
  const rng = mulberry32(seed * 7 + 1);
  const bots = [0, 1, 2, 3].map((s) => new Bot(s, difficulty, rng));
  const counts = { smash: 0, swing: 0, pickups: 0, items: 0, split: 0, pressure: 0, maxBalls: 0 };
  while (sim.phase !== 'over' && sim.time < maxSeconds) {
    for (const bot of bots) sim.players[bot.seat].axis = bot.update(sim, DT);
    sim.step(DT);
    counts.maxBalls = Math.max(counts.maxBalls, sim.balls.length);
    for (const e of sim.events) {
      if (e.t === 'smash') counts.smash++;
      else if (e.t === 'swing') counts.swing++;
      else if (e.t === 'pickup') counts.pickups++;
      else if (e.t === 'item') counts.items++;
      else if (e.t === 'split') counts.split++;
      else if (e.t === 'serve' && e.reason === 'pressure') counts.pressure++;
    }
  }
  return { sim, seconds: sim.time, counts };
}

describe('bot matches', () => {
  for (const diff of ['easy', 'normal', 'hard'] as Difficulty[]) {
    it(`${diff} bots finish a match in a sensible time and use smashes and items`, () => {
      const times: number[] = [];
      const total = { smash: 0, swing: 0, pickups: 0, items: 0, split: 0, pressure: 0, maxBalls: 0 };
      for (let seed = 1; seed <= 6; seed++) {
        const { sim, seconds, counts } = runBotMatch(seed, diff);
        expect(sim.phase).toBe('over');
        expect(sim.winner).toBeGreaterThanOrEqual(0);
        times.push(seconds);
        for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] = k === 'maxBalls' ? Math.max(total[k], counts[k]) : total[k] + counts[k];
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      // eslint-disable-next-line no-console
      console.log(`${diff}: avg ${avg.toFixed(0)}s (min ${Math.min(...times).toFixed(0)}, max ${Math.max(...times).toFixed(0)}) over 6 matches; totals ${JSON.stringify(total)}`);
      expect(avg).toBeGreaterThan(30);
      expect(avg).toBeLessThan(400);
      expect(total.smash).toBeGreaterThan(0);
      expect(total.swing).toBeGreaterThanOrEqual(total.smash > 0 ? 1 : 0);
      expect(total.pickups).toBeGreaterThan(0);
      expect(total.items).toBeGreaterThan(0);
      expect(total.maxBalls).toBeLessThanOrEqual(ballCap(4) + 2); // director cap + split extras
    });
  }

  it('is deterministic for a given seed', () => {
    const a = runBotMatch(3, 'normal');
    const b = runBotMatch(3, 'normal');
    expect(a.seconds).toBeCloseTo(b.seconds, 6);
    expect(a.sim.winner).toBe(b.sim.winner);
  });
});

describe('geometry sanity', () => {
  it('the paddle can cover the whole goal opening', () => {
    const sim = makeSim();
    const lim = sim.paddleLimit(PADDLE_H);
    expect(lim + PADDLE_H).toBeGreaterThanOrEqual(GOAL_HALF);
    expect(PADDLE_INSET - 0.3 - 0.3).toBeLessThan(BALL_R * 2);
    expect(SIDES).toHaveLength(4);
  });
});

describe('physics invariants', () => {
  it('walls and posts reflect with angle in = angle out and keep the speed', () => {
    const sim = makeSim({ lives: 999 });
    skipCountdown(sim);
    const rng = mulberry32(9);
    let checked = 0;
    for (let n = 0; n < 200; n++) {
      const a = rng() * Math.PI * 2;
      const b = putBall(sim, (rng() - 0.5) * 8, (rng() - 0.5) * 8, Math.cos(a) * 10, Math.sin(a) * 10, 10);
      for (let i = 0; i < 240 && !b.dead; i++) {
        const vin = { x: b.vx, y: b.vy };
        sim.step(DT);
        const hit = sim.events.find((e) => e.t === 'wall');
        if (sim.events.some((e) => e.t === 'paddle' || e.t === 'ballHit')) break;
        if (!hit || hit.t !== 'wall') continue;
        // Contact normal: from the contact point to the ball centre.
        const nx0 = b.x - b.vx * 0 - hit.x;
        const ny0 = b.y - hit.y;
        const len = Math.hypot(nx0, ny0);
        const nx = nx0 / len;
        const ny = ny0 / len;
        const dot = vin.x * nx + vin.y * ny;
        const rx = vin.x - 2 * dot * nx;
        const ry = vin.y - 2 * dot * ny;
        // The ball already moved after the bounce, so compare directions, not positions.
        expect(Math.atan2(b.vy, b.vx)).toBeCloseTo(Math.atan2(ry, rx), 2);
        expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(10, 5);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('every ball always moves at exactly speed + boost, and nothing ever becomes NaN', () => {
    const sim = makeSim({ lives: 99, crates: true, seed: 11 });
    skipCountdown(sim);
    const rng = mulberry32(42);
    for (let i = 0; i < 120 * 60; i++) {
      for (const p of sim.players) {
        p.axis = Math.sin(i * 0.013 * (p.seat + 1)) * 1.2;
        if (rng() < 0.01) p.smashReq = true;
      }
      sim.step(DT);
      for (const b of sim.balls) {
        expect(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.vx) && Number.isFinite(b.vy)).toBe(true);
        if (b.hold <= 0) expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(b.speed + b.boost, 4);
      }
    }
  });

  it('paddle hits are mirror-symmetric', () => {
    const run = (x: number) => {
      const sim = makeSim();
      skipCountdown(sim);
      const b = putBall(sim, x, H - 4, 0, 9);
      stepUntil(sim, (e) => e.t === 'paddle', 240);
      return { vx: b.vx, vy: b.vy };
    };
    const l = run(-0.6);
    const r = run(0.6);
    expect(l.vx).toBeCloseTo(-r.vx, 6);
    expect(l.vy).toBeCloseTo(r.vy, 6);
  });

});

describe('straight paths', () => {
  it('balls fly in perfectly straight lines between bounces, even after a smash with the stick held', () => {
    const sim = makeSim({ humans: 1 });
    skipCountdown(sim);
    sim.players[0].s = 0;
    const b = putBall(sim, 0.4, H - PADDLE_INSET - 1.2, 0, 6);
    sim.players[0].axis = 1; // holding the stick sideways while smashing must not bend the shot
    sim.players[0].smashReq = true;
    sim.step(DT);
    sim.players[0].axis = 0;
    const dir0 = Math.atan2(b.vy, b.vx);
    for (let i = 0; i < 40 && !b.dead; i++) {
      sim.step(DT);
      if (sim.events.some((e) => e.t === 'wall' || e.t === 'paddle' || e.t === 'ballHit')) break;
      expect(Math.atan2(b.vy, b.vx)).toBeCloseTo(dir0, 9);
    }
  });
});

describe('several balls at once', () => {
  it('one swing smashes every ball that reaches it during the window, not just the first', () => {
    const sim = makeSim();
    skipCountdown(sim);
    const a = makeBall(-0.6, H - PADDLE_INSET - 1.2, 0, 6);
    const b = makeBall(0.6, H - PADDLE_INSET - 3.0, 0, 9); // arrives ~0.15 s later, still inside the window
    b.id = 10001;
    sim.balls = [a, b];
    sim.players[0].smashReq = true;
    const smashed = new Set<number>();
    for (let i = 0; i < 30; i++) {
      sim.step(DT);
      for (const e of sim.events) if (e.t === 'smash') smashed.add(e.id);
    }
    expect([...smashed].sort()).toEqual([a.id, b.id].sort());
    expect(a.vy).toBeLessThan(0);
    expect(b.vy).toBeLessThan(0);
  });

  it('a normal paddle can return two balls in the same moment', () => {
    const sim = makeSim();
    skipCountdown(sim);
    const a = makeBall(-0.5, H - 4, 0, 9);
    const b = makeBall(0.5, H - 4, 0, 9);
    b.id = 10002;
    sim.balls = [a, b];
    const hits = new Set<number>();
    for (let i = 0; i < 120; i++) {
      sim.step(DT);
      for (const e of sim.events) if (e.t === 'paddle') hits.add(e.id);
    }
    expect(hits.has(a.id) && hits.has(b.id)).toBe(true);
    expect(sim.players[0].lives).toBe(3);
  });
});
