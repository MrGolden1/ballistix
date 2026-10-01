import { BALL_R, H, type CrateKind, type ItemKind, type MatchConfig, type Phase } from '../ballistix/config';
import type { Ball, Crate, Sim, SimEvent } from '../ballistix/sim';

/**
 * Online model: host-authoritative. The host runs the real simulation; guests send their input and
 * their own paddle position, the host sends back a compact snapshot every frame plus the game events
 * (for sounds, effects and the HUD).
 */

export type HostMsg =
  | { k: 'welcome'; seat: number }
  | { k: 'lobby'; seats: number[]; names: string[] }
  | { k: 'start'; cfg: MatchConfig }
  | { k: 'ev'; list: SimEvent[] }
  | { k: 'snap'; s: Snapshot }
  | { k: 'menu' }
  | { k: 'pong'; t: number };

export type GuestMsg =
  | { k: 'hello'; name: string }
  | { k: 'in'; axis: number; s: number; vs: number; smash: number; item: number; rtt: number }
  | { k: 'pause' }
  | { k: 'ping'; t: number };

const ITEMS: ItemKind[] = ['shield', 'big', 'freeze', 'split'];
const CRATES: CrateKind[] = ['shield', 'big', 'freeze', 'split', 'life'];
const PHASES: Phase[] = ['countdown', 'play', 'over'];

export interface Snapshot {
  /** host sim time */
  t: number;
  ph: number;
  pt: number;
  pl: number;
  sg: number;
  w: number;
  paused: boolean;
  /** per player: s, vs, h, lives, alive, big, shield, chill, split, item, smashT, smashCd, axis, saves, conceded, scored, crates, smashes */
  P: number[][];
  /** per ball: id, x, y, vx, vy, speed, boost, owner, hold, extra */
  B: number[][];
  /** per crate: id, x, y, kind, age, ttl */
  C: number[][];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function encodeSnapshot(sim: Sim, paused: boolean): Snapshot {
  return {
    t: r3(sim.time),
    ph: PHASES.indexOf(sim.phase),
    pt: r3(sim.phaseTime),
    pl: r3(sim.playTime),
    sg: r3(sim.sinceGoal),
    w: sim.winner,
    paused,
    P: sim.players.map((p) => [
      r3(p.s), r3(p.vs), r3(p.h), p.lives, p.alive ? 1 : 0,
      r3(p.fx.big), r3(p.fx.shield), r3(p.fx.chill), r3(p.fx.split),
      p.item ? ITEMS.indexOf(p.item) : -1, r3(p.smashT), r3(p.smashCd), r3(p.axis),
      p.stats.saves, p.stats.conceded, p.stats.scored, p.stats.crates, p.stats.smashes,
    ]),
    B: sim.balls.map((b) => [b.id, r3(b.x), r3(b.y), r3(b.vx), r3(b.vy), r3(b.speed), r3(b.boost), b.owner, r3(b.hold), b.extra ? 1 : 0]),
    C: sim.crates.map((c) => [c.id, r3(c.x), r3(c.y), CRATES.indexOf(c.kind), r3(c.age), c.ttl]),
  };
}

/**
 * Copies a snapshot into the guest's mirror sim. The guest's own paddle position is left alone:
 * the guest moves it locally (so it reacts instantly) and tells the host where it is.
 */
export function applySnapshot(sim: Sim, snap: Snapshot, localSeat: number, lead = 0): void {
  sim.time = snap.t;
  sim.phase = PHASES[snap.ph] ?? 'play';
  sim.phaseTime = snap.pt;
  sim.playTime = snap.pl;
  sim.sinceGoal = snap.sg;
  sim.winner = snap.w;
  snap.P.forEach((v, seat) => {
    const p = sim.players[seat];
    if (!p) return;
    if (seat !== localSeat) {
      p.s = v[0];
      p.vs = v[1];
      p.axis = v[12];
    }
    p.h = v[2];
    p.lives = v[3];
    p.alive = v[4] === 1;
    p.fx.big = v[5];
    p.fx.shield = v[6];
    p.fx.chill = v[7];
    p.fx.split = v[8];
    p.item = v[9] >= 0 ? ITEMS[v[9]] : null;
    p.smashT = v[10];
    p.smashCd = v[11];
    p.stats = { saves: v[13], conceded: v[14], scored: v[15], crates: v[16], smashes: v[17] };
  });
  sim.balls = snap.B.map(
    (v): Ball => ({ id: v[0], x: v[1], y: v[2], vx: v[3], vy: v[4], speed: v[5], boost: v[6], last: v[7], owner: v[7], ownerT: 0, hold: v[8], extra: v[9] === 1, ttl: Infinity, sinceHit: 0, hits: 0, dead: false }),
  );
  // Lag compensation: the snapshot is already half a round trip old when it arrives, so move the balls
  // on by that much. The guest then sees roughly where the balls are on the host right now.
  if (lead > 0) {
    const lim = H - BALL_R;
    for (const b of sim.balls) {
      if (b.hold > 0) continue;
      b.x = Math.max(-lim, Math.min(lim, b.x + b.vx * lead));
      b.y = Math.max(-lim, Math.min(lim, b.y + b.vy * lead));
    }
  }
  sim.crates = snap.C.map((v): Crate => ({ id: v[0], x: v[1], y: v[2], kind: CRATES[v[3]] ?? 'shield', age: v[4], ttl: v[5], dead: false }));
}
