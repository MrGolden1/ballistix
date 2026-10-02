import { describe, expect, it } from 'vitest';
import { Bot } from '../src/ballistix/bot';
import { BALL_R, CATCHUP_FULL, CRATE_HELP, H, PADDLE_INSET, SIDES, type CrateHelp, type MatchConfig } from '../src/ballistix/config';
import { CRATE_R, Sim } from '../src/ballistix/sim';
import { mulberry32 } from '../src/core/rng';

const DT = 1 / 120;

function makeSim(over: Partial<MatchConfig> = {}): Sim {
  return new Sim({ humans: 1, difficulty: 'normal', lives: 5, crates: true, seed: 1, ...over });
}

/** Steps until the first ball is in play and returns the sim with that ball and no crates. */
function inPlay(over: Partial<MatchConfig> = {}): Sim {
  const sim = makeSim(over);
  while (sim.phase === 'countdown') sim.step(DT);
  for (let i = 0; i < 600 && !sim.balls.some((b) => b.hold <= 0); i++) sim.step(DT);
  sim.crates = [];
  return sim;
}

/** Puts a crate at the centre and the first ball, owned by `owner`, at `dist` from it, moving away. */
function nearMiss(sim: Sim, owner: number, dist: number): void {
  sim.crates = [{ id: 999, x: 0, y: 0, kind: 'big', age: 0, ttl: 15, dead: false }];
  sim.balls = [sim.balls.find((b) => b.hold <= 0)!];
  const b = sim.balls[0];
  Object.assign(b, { x: dist, y: 0, vx: 10, vy: 0, speed: 10, boost: 0, owner, last: owner, ownerT: 5 });
}

function withHelp<T>(help: CrateHelp, f: () => T): T {
  const saved = CRATE_HELP.normal;
  CRATE_HELP.normal = help;
  try {
    return f();
  } finally {
    CRATE_HELP.normal = saved;
  }
}

/** Plays `seconds` with bots driving every seat and returns every event, as text. */
function eventLog(cfg: Partial<MatchConfig>, seconds: number): string {
  const sim = makeSim(cfg);
  const rng = mulberry32(5);
  const bots = [0, 1, 2, 3].map((s) => new Bot(s, 'normal', rng));
  const log: string[] = [];
  while (sim.time < seconds && sim.phase !== 'over') {
    for (const b of bots) sim.players[b.seat].axis = b.update(sim, DT);
    sim.step(DT);
    for (const e of sim.events) log.push(JSON.stringify(e));
  }
  return log.join('\n');
}

describe('item help for human players', () => {
  it('changes nothing when nobody plays against bots (bots only, or people only)', () => {
    const OFF = { reach: 0, target: 1, pull: 0 };
    for (const cfg of [{ humans: 0 as const }, { humans: 1 as const, seats: [0, 1, 2, 3] }]) {
      const normal = eventLog(cfg, 120);
      expect(normal).toContain('"pickup"');
      expect(withHelp(OFF, () => eventLog(cfg, 120))).toBe(normal);
    }
  });

  it('books every pickup: each player alive is owed their target share, the collector got it', () => {
    const sim = inPlay();
    nearMiss(sim, 1, 0.5);
    sim.step(DT);
    expect(sim.players[1].stats.crates).toBe(1);
    const t = CRATE_HELP.normal.target;
    expect(sim.crateDue[0]).toBeCloseTo(t / (t + 3), 6);
    expect(sim.crateDue[1]).toBeCloseTo(1 / (t + 3) - 1, 6);
    expect(sim.crateDue[2]).toBeCloseTo(1 / (t + 3), 6);
    expect(sim.crateDue.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9);
  });

  it('a human who is behind collects from a little farther away; bots and humans who are ahead do not', () => {
    const dist = BALL_R + CRATE_R + CRATE_HELP.normal.reach * 0.6; // inside the full extra reach
    const tryPickup = (owner: number, due: number) => {
      const sim = inPlay();
      sim.crateDue[owner] = due;
      nearMiss(sim, owner, dist);
      sim.step(DT);
      return sim.players[owner].stats.crates;
    };
    expect(tryPickup(0, CATCHUP_FULL)).toBe(1);
    expect(tryPickup(0, 0)).toBe(0);
    expect(tryPickup(0, -2)).toBe(0);
    expect(tryPickup(1, 5)).toBe(0);
  });

  it('new crates tend to spawn on the side of the human who is behind', () => {
    const side = SIDES[0];
    const spawnNearSeat0 = (due: number) => {
      let near = 0;
      const n = 300;
      for (let seed = 1; seed <= n; seed++) {
        const sim = makeSim({ seed });
        sim.crateDue[0] = due;
        while (!sim.crates.length && sim.time < 30) sim.step(DT);
        const c = sim.crates[0];
        const depth = (c.x - side.w.x) * side.n.x + (c.y - side.w.y) * side.n.y - PADDLE_INSET;
        if (depth < 4.6 && Math.abs(c.x) < 4) near++;
      }
      return near / n;
    };
    const pull = CRATE_HELP.normal.pull;
    expect(spawnNearSeat0(0)).toBeLessThan(0.25);
    expect(spawnNearSeat0(CATCHUP_FULL)).toBeGreaterThan(pull * 0.8);
    expect(H).toBe(10); // the depths above assume the standard arena
  });
});
