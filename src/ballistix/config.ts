/**
 * Shared constants and types for Ballistix.
 *
 * Sim coordinates: x grows to the right, y grows toward the BOTTOM of the screen
 * (it maps to three.js +z). The arena is the square [-H, H] x [-H, H].
 */

export const H = 10;
export const GOAL_HALF = 5.0; // half width of each goal opening
export const BALL_R = 0.42;
export const WALL_R = 0.3; // wall half thickness (collision capsule radius)
export const PADDLE_R = 0.3; // paddle capsule radius
export const PADDLE_H = 1.0; // paddle half length
export const PADDLE_INSET = 1.0; // distance of the paddle line from the wall plane
/** How far the middle of the curved paddle bulges toward the arena. */
export const PADDLE_CURVE = 0.28;

/** Paddle movement with momentum: it accelerates, and slides ("drifts") to a stop when released. */
export const PADDLE_SPEED = 15;
export const PADDLE_ACCEL = 75; // pushing in the direction you already move
export const PADDLE_TURN = 130; // pushing against your current motion
export const PADDLE_BRAKE = 48; // no input: friction while drifting (full speed slides ~2.3 units)
export const BIG_SCALE = 1.6;

export const BALL_SPEED_START = 10;
export const BALL_SPEED_MAX = 22;
export const BALL_SPEED_PER_HIT = 0.6;
export const MAX_DEFLECT = 0.95; // radians, deflection at the very edge of a paddle

export const COUNTDOWN_SECONDS = 3;
export const SERVE_HOLD = 1.0;
export const RESPAWN_DELAY = 1.5;

/**
 * Ball director: how many balls should be in play.
 * Starts at BALLS_BASE, adds one for every CALM_STEP seconds without a goal (quiet phases heat up),
 * adds one more after ESCALATE_AT seconds of play, and never exceeds the cap for the players alive.
 */
export const BALLS_BASE = 2;
export const CALM_STEP = 9;
export const ESCALATE_AT = 75;
export const SERVE_GAP = 1.1;
export function ballCap(alive: number): number {
  return alive >= 4 ? 5 : alive === 3 ? 4 : 3;
}

/**
 * A ball only counts as "yours" (it can collect crates) while you were the last to touch it AND it has not
 * touched another ball since, for at most OWNER_TIME seconds. So crates are won with direct, aimed shots.
 */
export const OWNER_TIME = 5;

/**
 * Real-time seconds the whole game freezes when a smash lands (hit-stop). Off: players read the
 * freeze as lag. The sound, rumble, sparks and a short camera shake carry the weight instead.
 */
export const SMASH_HITSTOP = 0;

/** Smash: a swing that hits any incoming ball within reach in front of the paddle. */
export const SMASH_WINDOW = 0.2;
export const SMASH_CD = 0.9;
export const SMASH_REACH = 1.7; // how far in front of the paddle line the swing reaches
export const SMASH_BOOST = 8; // extra ball speed, decays back to normal
export const SMASH_ANGLE_MUL = 1.25;
export const BOOST_DECAY = 5; // speed units per second

/** Comeback mechanic: at one life the paddle grows and smash recharges faster. */
export const LAST_STAND_SCALE = 1.2;
export const LAST_STAND_SMASH_RATE = 1.5;

/** Item durations (seconds). */
export const FX_BIG = 10;
export const FX_SHIELD = 6;
export const FX_CHILL = 4;
export const FX_SPLIT = 8; // how long Split Shot stays armed waiting for your next hit
export const SPLIT_BALL_LIFE = 10;
export const SPLIT_SPREAD = 0.38; // radians between the split balls

export type Difficulty = 'easy' | 'normal' | 'hard';
/** Items are held and used with the item button. */
export type ItemKind = 'shield' | 'big' | 'freeze' | 'split';
/** What a crate can contain. Extra Life applies instantly. */
export type CrateKind = ItemKind | 'life';
/** Effects that run on a timer and are stored on the player. */
export type TimedEffect = 'big' | 'shield' | 'chill' | 'split';
export type Phase = 'countdown' | 'play' | 'over';

export interface Vec {
  x: number;
  y: number;
}

export interface SideDef {
  /** Unit normal pointing into the arena. */
  n: Vec;
  /** Unit tangent: the direction in which the paddle coordinate s grows. */
  t: Vec;
  /** Centre of the wall plane. */
  w: Vec;
}

/** Seat 0 bottom, 1 right, 2 top, 3 left. */
export const SIDES: readonly SideDef[] = [
  { n: { x: 0, y: -1 }, t: { x: 1, y: 0 }, w: { x: 0, y: H } },
  { n: { x: -1, y: 0 }, t: { x: 0, y: 1 }, w: { x: H, y: 0 } },
  { n: { x: 0, y: 1 }, t: { x: 1, y: 0 }, w: { x: 0, y: -H } },
  { n: { x: 1, y: 0 }, t: { x: 0, y: 1 }, w: { x: -H, y: 0 } },
];

export interface SeatInfo {
  name: string;
  color: number;
  css: string;
}

export const SEATS: readonly SeatInfo[] = [
  { name: 'Ember', color: 0xff8a1f, css: '#ff8a1f' },
  { name: 'Tide', color: 0x22d3c5, css: '#22d3c5' },
  { name: 'Blaze', color: 0xff3b57, css: '#ff3b57' },
  { name: 'Zap', color: 0xa855f7, css: '#a855f7' },
];

export interface CrateInfo {
  label: string;
  css: string;
  color: number;
  /** One-line explanation for the menu and toasts. */
  help: string;
}

export const CRATE_INFO: Record<CrateKind, CrateInfo> = {
  shield: { label: 'SHIELD', css: '#4cc9f0', color: 0x4cc9f0, help: 'seals your goal for 6 s' },
  big: { label: 'BIG PADDLE', css: '#ffd23f', color: 0xffd23f, help: 'longer paddle for 10 s' },
  freeze: { label: 'FREEZE', css: '#9bf6ff', color: 0x9bf6ff, help: 'everyone else moves slowly for 4 s' },
  split: { label: 'SPLIT SHOT', css: '#ff6b9d', color: 0xff6b9d, help: 'your next hit splits into 3 balls' },
  life: { label: 'EXTRA LIFE', css: '#7dff8a', color: 0x7dff8a, help: '+1 life, instantly' },
};

export interface MatchConfig {
  /** 0 = bots only (menu demo), 1 = one human (bottom), 2 = two humans (bottom + top). */
  humans: 0 | 1 | 2;
  /** Total players, humans plus bots (2 to 4). Seats nobody plays are closed with a solid wall. Default 4. */
  players?: number;
  /** The seats in play. Derived from `players` when absent; an online host sends it so everyone agrees. */
  active?: number[];
  /** Display names per seat; an empty or missing entry means the seat's own name. */
  names?: string[];
  difficulty: Difficulty;
  lives: number;
  /** Whether item crates spawn. */
  crates: boolean;
  seed: number;
  /** Online: which seats are humans (overrides humanSeats(humans)). */
  seats?: number[];
}

/** Seats controlled by humans for a given human count. */
export function humanSeats(humans: number): number[] {
  if (humans >= 2) return [0, 2];
  if (humans === 1) return [0];
  return [];
}

/** Bots fill free seats in this order: opposite the first player, then the sides. */
const FILL_ORDER = [0, 2, 1, 3];

/** The seats in play: every human's seat, plus bots up to `total` players (never fewer than the humans). */
export function seatsInPlay(humanSeatList: number[], total: number): number[] {
  const out = [...humanSeatList];
  for (const seat of FILL_ORDER) {
    if (out.length >= total) break;
    if (!out.includes(seat)) out.push(seat);
  }
  return out.sort((a, b) => a - b);
}

/** A seat's display name in this match. */
export function seatName(cfg: MatchConfig, seat: number): string {
  return cfg.names?.[seat] || SEATS[seat].name;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
