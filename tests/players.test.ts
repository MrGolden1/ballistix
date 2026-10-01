import { describe, expect, it } from 'vitest';
import { Bot } from '../src/ballistix/bot';
import { SIDES, seatName, seatsInPlay, type Difficulty, type MatchConfig } from '../src/ballistix/config';
import { Sim, type SimEvent } from '../src/ballistix/sim';
import { MAX_NAME, cleanName, escapeHtml, initial } from '../src/core/names';
import { mulberry32 } from '../src/core/rng';

const DT = 1 / 120;

function makeSim(over: Partial<MatchConfig> = {}): Sim {
  return new Sim({ humans: 0, difficulty: 'normal', lives: 3, crates: true, seed: 1, ...over });
}

/** Plays a bots-only match to the end and reports what happened on the closed sides. */
function runMatch(seed: number, players: number, difficulty: Difficulty = 'normal') {
  const sim = makeSim({ seed, players, difficulty, humans: 0 });
  const rng = mulberry32(seed * 7 + 1);
  const bots = [0, 1, 2, 3].map((s) => new Bot(s, difficulty, rng));
  const seen: SimEvent[] = [];
  let maxBalls = 0;
  while (sim.phase !== 'over' && sim.time < 900) {
    for (const bot of bots) if (sim.players[bot.seat].alive) sim.players[bot.seat].axis = bot.update(sim, DT);
    sim.step(DT);
    maxBalls = Math.max(maxBalls, sim.balls.length);
    for (const e of sim.events) seen.push(e);
    for (const b of sim.balls) {
      // nothing ever leaves the arena, whatever sides are closed
      expect(Math.abs(b.x)).toBeLessThan(11);
      expect(Math.abs(b.y)).toBeLessThan(11);
    }
  }
  return { sim, seen, maxBalls };
}

describe('seats in play', () => {
  it('fills seats with bots: opposite the first player, then the sides', () => {
    expect(seatsInPlay([0], 2)).toEqual([0, 2]);
    expect(seatsInPlay([0], 3)).toEqual([0, 1, 2]);
    expect(seatsInPlay([0], 4)).toEqual([0, 1, 2, 3]);
    expect(seatsInPlay([0, 2], 2)).toEqual([0, 2]);
    expect(seatsInPlay([0, 2], 3)).toEqual([0, 1, 2]);
  });

  it('never has fewer seats than humans, and keeps every human seat', () => {
    expect(seatsInPlay([0, 2, 3], 2)).toEqual([0, 2, 3]);
    expect(seatsInPlay([0, 3], 2)).toEqual([0, 3]);
    expect(seatsInPlay([0, 3], 3)).toEqual([0, 2, 3]);
    expect(seatsInPlay([], 2)).toEqual([0, 2]);
  });
});

describe('matches with fewer than four players', () => {
  it('defaults to four players', () => {
    const sim = makeSim();
    expect(sim.players.every((p) => p.active && p.alive && p.lives === 3)).toBe(true);
  });

  it('a 2 player match uses the bottom and top seats; the others are closed walls', () => {
    const sim = makeSim({ players: 2 });
    expect(sim.players.map((p) => p.active)).toEqual([true, false, true, false]);
    expect(sim.players.map((p) => p.alive)).toEqual([true, false, true, false]);
    expect(sim.players.map((p) => p.lives)).toEqual([3, 0, 3, 0]);
    expect(sim.aliveCount).toBe(2);
    expect(sim.isClosed(1)).toBe(true);
    expect(sim.isClosed(3)).toBe(true);
    expect(sim.isClosed(0)).toBe(false);
  });

  it('human seats stay human, and a human seat is always in play', () => {
    const sim = makeSim({ players: 2, humans: 2 });
    expect(sim.players.map((p) => p.human)).toEqual([true, false, true, false]);
    const online = makeSim({ players: 2, humans: 1, seats: [0, 3] });
    expect(online.players.map((p) => p.active)).toEqual([true, false, false, true]);
    expect(online.players[3].human).toBe(true);
  });

  it('an explicit list of seats (as sent by an online host) wins over the count', () => {
    const sim = makeSim({ players: 4, active: [0, 3] });
    expect(sim.players.map((p) => p.active)).toEqual([true, false, false, true]);
  });

  it('a ball bounces off a closed side with a plain wall bounce, not a force-field one', () => {
    const sim = makeSim({ players: 2, crates: false });
    while (sim.phase === 'countdown') sim.step(DT);
    // right side (seat 1) is closed: fire a ball at it
    sim.balls = [{ id: 5, x: 8, y: 0, vx: 12, vy: 0, speed: 12, boost: 0, last: -1, owner: -1, ownerT: 0, hold: 0, extra: false, ttl: Infinity, sinceHit: 0, hits: 0, dead: false }];
    let wall: SimEvent | undefined;
    for (let i = 0; i < 240 && !wall; i++) {
      sim.step(DT);
      wall = sim.events.find((e) => e.t === 'wall' && e.seat === 1);
    }
    expect(wall).toBeDefined();
    expect(wall && wall.t === 'wall' && wall.closed).toBe(false);
    const b = sim.balls.find((x) => x.id === 5)!;
    expect(b.vx).toBeLessThan(0); // it came back
  });

  for (const players of [2, 3]) {
    it(`${players} player bot matches finish, the winner is one of the players, and nobody scores in a closed seat`, () => {
      for (let seed = 1; seed <= 5; seed++) {
        const { sim, seen, maxBalls } = runMatch(seed, players);
        expect(sim.phase).toBe('over');
        const active = sim.players.filter((p) => p.active).map((p) => p.seat);
        expect(active.length).toBe(players);
        expect(active).toContain(sim.winner);
        for (const e of seen) {
          if (e.t === 'goal' || e.t === 'eliminated') expect(active).toContain(e.seat);
          if (e.t === 'pickup') expect(active).toContain(e.seat);
        }
        // the ball director keeps to the cap for the players left
        expect(maxBalls).toBeLessThanOrEqual(5);
        // closed seats stay out for the whole match
        for (const p of sim.players) if (!p.active) expect(p.lives).toBe(0);
      }
    });
  }

  it('serves only toward seats that are in play', () => {
    const sim = makeSim({ players: 2, crates: false, seed: 4 });
    const targets = new Set<number>();
    for (let i = 0; i < 40000 && sim.phase !== 'over'; i++) {
      sim.step(DT);
      for (const e of sim.events) {
        if (e.t !== 'serve') continue;
        const b = sim.balls.find((x) => x.id === e.id);
        if (!b) continue;
        // direction of travel of a fresh ball points at the seat it is served to
        const away = SIDES.map((s) => b.vx * s.n.x + b.vy * s.n.y);
        targets.add(away.indexOf(Math.min(...away)));
      }
      for (const p of sim.players) if (p.alive) p.axis = 0.2; // jiggle: somebody eventually concedes
    }
    for (const t of targets) expect([0, 2]).toContain(t);
  });
});

describe('player names', () => {
  it('strips markup, control and bidi characters', () => {
    expect(cleanName('<img src=x onerror=alert(1)>')).toBe('img src=x oner'); // markup characters gone, cut to 14
    expect(cleanName('Al\u0000ex‮')).toBe('Alex');
    expect(cleanName('  too   many    gaps ')).toBe('too many gaps');
    expect(cleanName('a"b\'c`d\\e&f')).toBe('abcdef');
    expect(cleanName('​‏')).toBe('');
  });

  it('cuts long names by characters, not UTF-16 units', () => {
    const long = 'x'.repeat(40);
    expect(Array.from(cleanName(long)).length).toBe(MAX_NAME);
    const emoji = '😀'.repeat(30);
    expect(Array.from(cleanName(emoji)).length).toBe(MAX_NAME);
    expect(cleanName(emoji)).not.toContain('�');
  });

  it('rejects things that are not text', () => {
    expect(cleanName(undefined)).toBe('');
    expect(cleanName(42)).toBe('');
    expect(cleanName({ toString: () => 'x' })).toBe('');
  });

  it('keeps ordinary names, accents and other scripts', () => {
    expect(cleanName('Zoë')).toBe('Zoë');
    expect(cleanName('علی')).toBe('علی');
    expect(cleanName('Player 1')).toBe('Player 1');
  });

  it('escapes for HTML and takes a first letter', () => {
    expect(escapeHtml('<b>"&\'')).toBe('&lt;b&gt;&quot;&amp;&#39;');
    expect(initial('zoë')).toBe('Z');
    expect(initial('')).toBe('?');
    expect(initial('😀x')).toBe('😀');
  });

  it('a seat shows its custom name, or its own name when there is none', () => {
    const cfg: MatchConfig = { humans: 1, difficulty: 'normal', lives: 3, crates: true, seed: 1, names: ['Sam', '', 'Alex'] };
    expect(seatName(cfg, 0)).toBe('Sam');
    expect(seatName(cfg, 1)).toBe('Tide');
    expect(seatName(cfg, 2)).toBe('Alex');
    expect(seatName(cfg, 3)).toBe('Zap');
  });
});
