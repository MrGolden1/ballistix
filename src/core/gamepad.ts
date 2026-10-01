/**
 * Gamepad support: layout normalisation, join-by-press seat assignment, duplicate filtering
 * (DS4Windows), menu navigation with auto-repeat, and rumble.
 *
 * The browser Gamepad API is wrapped behind a `source` function so everything here can be unit-tested
 * with fake controllers.
 */

export interface RawButton {
  pressed: boolean;
  value: number;
}

export interface RawPad {
  index: number;
  id: string;
  connected: boolean;
  mapping: string;
  axes: readonly number[];
  buttons: readonly RawButton[];
  vibrationActuator?: {
    playEffect?: (type: string, params: { startDelay: number; duration: number; weakMagnitude: number; strongMagnitude: number }) => Promise<unknown>;
  } | null;
}

export type PadKind = 'sony' | 'xbox' | 'nintendo' | 'generic';

/** Face buttons are named by position (south = Cross / A) so the code is layout-independent. */
export type PadButton = 'south' | 'east' | 'west' | 'north' | 'l1' | 'r1' | 'l2' | 'r2' | 'select' | 'start';
const BUTTONS: PadButton[] = ['south', 'east', 'west', 'north', 'l1', 'r1', 'l2', 'r2', 'select', 'start'];

export interface PadState {
  index: number;
  id: string;
  kind: PadKind;
  /** Horizontal movement in [-1, 1]: d-pad, otherwise the left stick with a dead zone. */
  move: number;
  /** Digital directions (d-pad or a firmly pushed stick), used for menu navigation. */
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  btn: Record<PadButton, boolean>;
}

export function padKind(id: string): PadKind {
  const s = id.toLowerCase();
  if (/054c|sony|dualshock|dualsense|playstation|wireless controller|ps4|ps5/.test(s)) return 'sony';
  if (/xbox|xinput|045e/.test(s)) return 'xbox';
  if (/057e|nintendo|switch|pro controller|joy-?con/.test(s)) return 'nintendo';
  return 'generic';
}

/** Short, human friendly controller name for the UI. */
export function padName(id: string): string {
  const kind = padKind(id);
  if (kind === 'sony') return 'PlayStation controller';
  if (kind === 'nintendo') return 'Nintendo controller';
  const cleaned = id.replace(/\s*\(.*\)\s*$/, '').trim();
  return cleaned || 'Controller';
}

/** Button names as printed on the controller. */
export function glyphs(kind: PadKind): { smash: string; item: string; pause: string; confirm: string; back: string } {
  if (kind === 'sony') return { smash: '✕', item: '□', pause: 'OPTIONS', confirm: '✕', back: '○' };
  // Nintendo pads put "confirm" on the bottom button, which they label B, and "back" on A.
  if (kind === 'nintendo') return { smash: 'B', item: 'Y', pause: '+', confirm: 'B', back: 'A' };
  return { smash: 'A', item: 'X', pause: 'MENU', confirm: 'A', back: 'B' };
}

interface Layout {
  idx: Record<PadButton, number>;
  up: number;
  down: number;
  left: number;
  right: number;
  /** Axis index of a d-pad "hat" (old non-standard Sony mappings), or -1. */
  hat: number;
}

const STANDARD: Layout = {
  idx: { south: 0, east: 1, west: 2, north: 3, l1: 4, r1: 5, l2: 6, r2: 7, select: 8, start: 9 },
  up: 12,
  down: 13,
  left: 14,
  right: 15,
  hat: -1,
};

/** Raw DualShock 4 layout as exposed without the "standard" mapping (e.g. older Firefox). Best effort. */
const SONY_RAW: Layout = {
  idx: { west: 0, south: 1, east: 2, north: 3, l1: 4, r1: 5, l2: 6, r2: 7, select: 8, start: 9 },
  up: -1,
  down: -1,
  left: -1,
  right: -1,
  hat: 9,
};

function layoutOf(raw: RawPad): Layout {
  return raw.mapping !== 'standard' && padKind(raw.id) === 'sony' ? SONY_RAW : STANDARD;
}

function isDown(raw: RawPad, i: number): boolean {
  if (i < 0) return false;
  const b = raw.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
}

/** Dead zone with rescaling so the output still reaches 1. */
export function deadzone(v: number, z = 0.2): number {
  const a = Math.abs(v);
  if (a < z) return 0;
  return Math.sign(v) * Math.min(1, (a - z) / (1 - z));
}

/** Decodes a d-pad hat axis (-1 up, then clockwise in steps of 2/7, ~1.29 when released). */
export function decodeHat(v: number): { up: boolean; down: boolean; left: boolean; right: boolean } {
  if (!Number.isFinite(v) || Math.abs(v) > 1.1) return { up: false, down: false, left: false, right: false };
  const step = Math.round((v + 1) / (2 / 7)); // 0 up, 1 up-right, 2 right, 3 down-right, 4 down, 5 down-left, 6 left, 7 up-left
  return {
    up: step === 0 || step === 1 || step === 7,
    right: step >= 1 && step <= 3,
    down: step >= 3 && step <= 5,
    left: step >= 5 && step <= 7,
  };
}

export function snapshot(raw: RawPad): PadState {
  const lay = layoutOf(raw);
  const lx = raw.axes[0] ?? 0;
  const ly = raw.axes[1] ?? 0;
  const hat = lay.hat >= 0 ? decodeHat(raw.axes[lay.hat] ?? 2) : null;
  const left = isDown(raw, lay.left) || !!hat?.left || lx < -0.55;
  const right = isDown(raw, lay.right) || !!hat?.right || lx > 0.55;
  const up = isDown(raw, lay.up) || !!hat?.up || ly < -0.55;
  const down = isDown(raw, lay.down) || !!hat?.down || ly > 0.55;
  const dpadX = (isDown(raw, lay.right) || hat?.right ? 1 : 0) - (isDown(raw, lay.left) || hat?.left ? 1 : 0);
  const btn = {} as Record<PadButton, boolean>;
  for (const name of BUTTONS) btn[name] = isDown(raw, lay.idx[name]);
  return { index: raw.index, id: raw.id, kind: padKind(raw.id), move: dpadX !== 0 ? dpadX : deadzone(lx), up, down, left, right, btn };
}

/**
 * Keeps real game controllers only and drops duplicates created by DS4Windows.
 *
 * DS4Windows turns every DualShock 4 into a virtual "Xbox 360 Controller". If the physical pad is not
 * hidden, the browser sees both. When there are at least as many virtual Xbox pads as Sony pads we
 * assume the Sony ones are the originals and ignore them.
 */
export function selectPads(raws: ReadonlyArray<RawPad | null | undefined>): { pads: RawPad[]; ignored: number } {
  const real = raws.filter((p): p is RawPad => !!p && p.connected && p.buttons.length >= 6 && p.axes.length >= 2);
  const sony = real.filter((p) => padKind(p.id) === 'sony');
  const virtual = real.filter((p) => padKind(p.id) === 'xbox');
  if (sony.length > 0 && virtual.length >= sony.length) {
    return { pads: real.filter((p) => padKind(p.id) !== 'sony'), ignored: sony.length };
  }
  return { pads: real, ignored: 0 };
}

export type PadEvent =
  | { t: 'joined'; slot: number; pad: PadState }
  | { t: 'lost'; slot: number; id: string }
  | { t: 'changed' };

export type Rumble = 'tap' | 'item' | 'smash' | 'goal' | 'out' | 'boom';
const RUMBLE: Record<Rumble, { duration: number; weak: number; strong: number }> = {
  tap: { duration: 40, weak: 0.25, strong: 0 },
  item: { duration: 70, weak: 0.35, strong: 0.1 },
  smash: { duration: 140, weak: 0.5, strong: 0.7 },
  goal: { duration: 350, weak: 0.7, strong: 1 },
  out: { duration: 700, weak: 1, strong: 1 },
  boom: { duration: 300, weak: 0.6, strong: 0.9 },
};

const NAV_DELAY = 0.35;
const NAV_REPEAT = 0.12;

export class Gamepads {
  /** Pads currently usable, after duplicate filtering. */
  state: PadState[] = [];
  /** Number of controller entries hidden as DS4Windows duplicates. */
  ignored = 0;
  /** True on frames where any controller was touched (button pressed or stick pushed). */
  active = false;
  /** Pad index driving each human slot (slot 0 = P1, slot 1 = P2), or null. */
  slots: (number | null)[] = [null, null];

  private raws = new Map<number, RawPad>();
  private prev = new Map<number, PadState>();
  private cur = new Map<number, PadState>();
  private joined = new Set<number>();
  private lastRumble = new Map<number, number>();
  private nav = { dx: 0, dy: 0, held: 0, next: 0 };
  private navOut = { dx: 0, dy: 0 };
  private lastSignature = '';

  constructor(
    private source: () => ReadonlyArray<RawPad | null | undefined> = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? (navigator.getGamepads() as unknown as RawPad[]) : []),
    private now: () => number = () => performance.now(),
  ) {}

  /** Call once per frame. `humans` is how many human slots the current mode uses. */
  update(dt: number, humans: number): PadEvent[] {
    const events: PadEvent[] = [];
    const { pads, ignored } = selectPads(this.source());
    this.ignored = ignored;
    this.prev = this.cur;
    this.cur = new Map();
    this.raws = new Map();
    this.joined.clear();
    this.state = pads.map((p) => {
      const s = snapshot(p);
      this.cur.set(p.index, s);
      this.raws.set(p.index, p);
      return s;
    });

    // Lost pads free their slot.
    for (let slot = 0; slot < this.slots.length; slot++) {
      const idx = this.slots[slot];
      if (idx !== null && !this.cur.has(idx)) {
        events.push({ t: 'lost', slot, id: this.prev.get(idx)?.id ?? '' });
        this.slots[slot] = null;
      }
    }

    // A pad that presses any button claims the first free human slot.
    const usable = Math.max(1, Math.min(humans, this.slots.length));
    for (const s of this.state) {
      if (this.slots.includes(s.index)) continue;
      if (!BUTTONS.some((b) => this.edgeOf(s, b))) continue;
      const free = this.slots.findIndex((v, i) => i < usable && v === null);
      if (free >= 0) {
        this.slots[free] = s.index;
        this.joined.add(s.index);
        events.push({ t: 'joined', slot: free, pad: s });
      }
    }

    this.active = this.state.some((p) => Math.abs(p.move) > 0.6 || p.up || p.down || BUTTONS.some((b) => this.edgeOf(p, b)));
    this.updateNav(dt);

    const signature = `${this.state.map((s) => `${s.index}:${s.id}`).join('|')}#${this.slots.join(',')}#${ignored}`;
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      events.push({ t: 'changed' });
    }
    return events;
  }

  private edgeOf(s: PadState, b: PadButton): boolean {
    return s.btn[b] && !this.prev.get(s.index)?.btn[b];
  }

  /** True on the frame any pad presses `b`. The press that merely joined a pad is not counted. */
  anyEdge(b: PadButton): boolean {
    return this.state.some((s) => !this.joined.has(s.index) && this.edgeOf(s, b));
  }

  /** Movement for a human slot, -1..1. */
  axis(slot: number): number {
    const idx = this.slots[slot];
    return idx === null || idx === undefined ? 0 : (this.cur.get(idx)?.move ?? 0);
  }

  /** One-shot action presses for a human slot. */
  actions(slot: number): { smash: boolean; item: boolean } {
    const idx = this.slots[slot];
    const s = idx === null || idx === undefined ? undefined : this.cur.get(idx);
    if (!s || this.joined.has(s.index)) return { smash: false, item: false };
    return {
      smash: this.edgeOf(s, 'south') || this.edgeOf(s, 'r2'),
      item: this.edgeOf(s, 'west') || this.edgeOf(s, 'north') || this.edgeOf(s, 'east') || this.edgeOf(s, 'l1') || this.edgeOf(s, 'r1'),
    };
  }

  /** Menu navigation step for this frame: one step on press, then auto-repeat while held. */
  navDir(): { dx: number; dy: number } {
    return this.navOut;
  }

  private updateNav(dt: number): void {
    let dx = 0;
    let dy = 0;
    for (const s of this.state) {
      dx = (s.right ? 1 : 0) - (s.left ? 1 : 0);
      dy = (s.down ? 1 : 0) - (s.up ? 1 : 0);
      if (dx || dy) break;
    }
    const n = this.nav;
    this.navOut = { dx: 0, dy: 0 };
    if (!dx && !dy) {
      n.dx = n.dy = 0;
      n.held = 0;
      return;
    }
    if (dx !== n.dx || dy !== n.dy) {
      n.dx = dx;
      n.dy = dy;
      n.held = 0;
      n.next = NAV_DELAY;
      this.navOut = { dx, dy };
      return;
    }
    n.held += dt;
    if (n.held >= n.next) {
      n.next += NAV_REPEAT;
      this.navOut = { dx, dy };
    }
  }

  /** Vibrates the pad of a human slot. Safe to call when rumble is unsupported. */
  rumble(slot: number, kind: Rumble): void {
    const idx = this.slots[slot];
    if (idx === null || idx === undefined) return;
    const act = this.raws.get(idx)?.vibrationActuator;
    if (!act?.playEffect) return;
    const t = this.now();
    const last = this.lastRumble.get(idx) ?? -1e9;
    const p = RUMBLE[kind];
    if (t - last < 50 && p.strong < 0.6) return; // do not spam weak pulses
    this.lastRumble.set(idx, t);
    try {
      void Promise.resolve(act.playEffect('dual-rumble', { startDelay: 0, duration: p.duration, weakMagnitude: p.weak, strongMagnitude: p.strong })).catch(() => {});
    } catch {
      /* rumble is optional */
    }
  }

  /** Kind of the controller used by a slot (for button glyphs), or null. */
  kindOf(slot: number): PadKind | null {
    const idx = this.slots[slot];
    return idx === null || idx === undefined ? null : (this.cur.get(idx)?.kind ?? null);
  }

  /** Summary for the menu. */
  describe(humans: number): { slots: ({ name: string; kind: PadKind } | null)[]; spare: number; ignored: number } {
    const slots = this.slots.slice(0, Math.max(1, humans)).map((idx) => {
      const s = idx === null ? undefined : this.cur.get(idx);
      return s ? { name: padName(s.id), kind: s.kind } : null;
    });
    const spare = this.state.filter((s) => !this.slots.includes(s.index)).length;
    return { slots, spare, ignored: this.ignored };
  }
}
