import { describe, expect, it, vi } from 'vitest';
import { Gamepads, decodeHat, deadzone, glyphs, padKind, selectPads, snapshot, type RawPad } from '../src/core/gamepad';

const DS4 = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
const DS4_RAW = 'Wireless Controller (Vendor: 054c Product: 09cc)';
const X360 = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';

interface PadOpts {
  mapping?: string;
  down?: number[];
  axes?: number[];
  rumble?: boolean;
}

function pad(index: number, id: string, o: PadOpts = {}): RawPad {
  const down = new Set(o.down ?? []);
  return {
    index,
    id,
    connected: true,
    mapping: o.mapping ?? 'standard',
    axes: o.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.has(i), value: down.has(i) ? 1 : 0 })),
    vibrationActuator: o.rumble === false ? null : { playEffect: vi.fn(() => Promise.resolve('complete')) },
  };
}

/** A controllable controller source. */
function rig(humans = 2) {
  let pads: RawPad[] = [];
  let t = 0;
  const gp = new Gamepads(() => pads, () => t);
  return {
    gp,
    set(p: RawPad[]) {
      pads = p;
    },
    frame(dt = 1 / 60) {
      t += dt * 1000;
      return gp.update(dt, humans);
    },
  };
}

describe('layouts', () => {
  it('maps the standard layout the DS4 reports in Chrome and Edge', () => {
    const s = snapshot(pad(0, DS4, { down: [0, 2, 9] }));
    expect(s.kind).toBe('sony');
    expect(s.btn.south).toBe(true); // Cross
    expect(s.btn.west).toBe(true); // Square
    expect(s.btn.start).toBe(true); // Options
    expect(s.btn.east).toBe(false);
  });

  it('d-pad overrides the stick and the stick has a dead zone', () => {
    expect(snapshot(pad(0, DS4, { down: [14] })).move).toBe(-1);
    expect(snapshot(pad(0, DS4, { down: [15] })).move).toBe(1);
    expect(snapshot(pad(0, DS4, { axes: [0.1, 0] })).move).toBe(0);
    expect(snapshot(pad(0, DS4, { axes: [1, 0] })).move).toBeCloseTo(1);
    expect(snapshot(pad(0, DS4, { axes: [-0.6, 0] })).move).toBeLessThan(-0.4);
    expect(deadzone(0.2)).toBe(0);
  });

  it('understands the raw DS4 layout (no standard mapping): Cross is button 1, d-pad is a hat axis', () => {
    const axes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.714]; // hat pointing left
    const s = snapshot(pad(0, DS4_RAW, { mapping: '', down: [1, 0], axes }));
    expect(s.btn.south).toBe(true);
    expect(s.btn.west).toBe(true);
    expect(s.left).toBe(true);
    expect(s.move).toBe(-1);
  });

  it('decodes the hat axis', () => {
    expect(decodeHat(-1)).toMatchObject({ up: true, left: false, right: false });
    expect(decodeHat(-0.428)).toMatchObject({ right: true, up: false, down: false });
    expect(decodeHat(0.143)).toMatchObject({ down: true });
    expect(decodeHat(0.714)).toMatchObject({ left: true });
    expect(decodeHat(1.286)).toEqual({ up: false, down: false, left: false, right: false });
  });

  it('recognises Nintendo pads and prints their own button names', () => {
    expect(padKind('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('nintendo');
    expect(glyphs('nintendo')).toMatchObject({ smash: 'B', confirm: 'B', back: 'A', pause: '+' });
  });

  it('flags controller activity so the UI can switch its button guides', () => {
    const r = rig(1);
    r.set([pad(0, DS4)]);
    r.frame();
    expect(r.gp.active).toBe(false);
    r.set([pad(0, DS4, { down: [0] })]);
    r.frame();
    expect(r.gp.active).toBe(true);
    r.set([pad(0, DS4, { axes: [1, 0] })]);
    r.frame();
    expect(r.gp.active).toBe(true);
    r.set([pad(0, DS4)]);
    r.frame();
    expect(r.gp.active).toBe(false);
  });

  it('labels buttons per controller type', () => {
    expect(padKind(DS4)).toBe('sony');
    expect(padKind(X360)).toBe('xbox');
    expect(padKind('Some Pad')).toBe('generic');
    expect(glyphs('sony').smash).toBe('✕');
    expect(glyphs('xbox').smash).toBe('A');
  });
});

describe('duplicate filtering (DS4Windows)', () => {
  it('hides the physical DS4s when virtual Xbox pads mirror them', () => {
    const r = selectPads([pad(0, DS4), pad(1, DS4), pad(2, X360), pad(3, X360)]);
    expect(r.pads.map((p) => p.index)).toEqual([2, 3]);
    expect(r.ignored).toBe(2);
  });

  it('keeps everything when there is no virtual pad', () => {
    const r = selectPads([pad(0, DS4), pad(1, DS4)]);
    expect(r.pads).toHaveLength(2);
    expect(r.ignored).toBe(0);
  });

  it('keeps a directly connected DS4 when there are fewer virtual pads than Sony pads', () => {
    const r = selectPads([pad(0, DS4), pad(1, DS4), pad(2, X360)]);
    expect(r.pads).toHaveLength(3);
    expect(r.ignored).toBe(0);
  });

  it('ignores disconnected entries and devices that are clearly not game controllers', () => {
    const dead = { ...pad(0, DS4), connected: false };
    const mouse: RawPad = { ...pad(1, 'USB Receiver'), buttons: [{ pressed: false, value: 0 }], axes: [0] };
    expect(selectPads([dead, mouse, null, undefined, pad(2, DS4)]).pads.map((p) => p.index)).toEqual([2]);
  });
});

describe('joining and seats', () => {
  it('the first pad to press a button becomes P1, the second P2', () => {
    const r = rig(2);
    r.set([pad(0, DS4), pad(1, DS4)]);
    r.frame();
    expect(r.gp.slots).toEqual([null, null]);

    r.set([pad(0, DS4), pad(1, DS4, { down: [2] })]); // the pad with index 1 presses first
    const ev1 = r.frame();
    expect(ev1.find((e) => e.t === 'joined')).toMatchObject({ slot: 0 });
    expect(r.gp.slots).toEqual([1, null]);

    r.set([pad(0, DS4, { down: [1] }), pad(1, DS4)]);
    r.frame();
    expect(r.gp.slots).toEqual([1, 0]);
  });

  it('only fills as many slots as there are human players', () => {
    const r = rig(1);
    r.set([pad(0, DS4, { down: [0] }), pad(1, DS4)]);
    r.frame();
    r.set([pad(0, DS4), pad(1, DS4, { down: [0] })]);
    r.frame();
    expect(r.gp.slots).toEqual([0, null]);
  });

  it('the press that joins a pad is not also a menu confirm or an action', () => {
    const r = rig(1);
    r.set([pad(0, DS4, { down: [0] })]);
    r.frame();
    expect(r.gp.anyEdge('south')).toBe(false);
    expect(r.gp.actions(0)).toEqual({ smash: false, item: false });
    r.set([pad(0, DS4)]);
    r.frame();
    r.set([pad(0, DS4, { down: [0] })]);
    r.frame();
    expect(r.gp.anyEdge('south')).toBe(true);
    expect(r.gp.actions(0).smash).toBe(true);
  });

  it('actions are one-shot edges: smash on Cross, item on Square, held buttons do not repeat', () => {
    const r = rig(1);
    r.set([pad(0, DS4, { down: [9] })]); // join with Options
    r.frame();
    r.set([pad(0, DS4)]);
    r.frame();
    r.set([pad(0, DS4, { down: [0] })]);
    r.frame();
    expect(r.gp.actions(0)).toEqual({ smash: true, item: false });
    r.frame();
    expect(r.gp.actions(0)).toEqual({ smash: false, item: false });
    r.set([pad(0, DS4, { down: [2] })]);
    r.frame();
    expect(r.gp.actions(0)).toEqual({ smash: false, item: true });
    r.set([pad(0, DS4, { down: [5] })]); // R1 also uses the item
    r.frame();
    expect(r.gp.actions(0).item).toBe(true);
  });

  it('two pads drive two slots independently', () => {
    const r = rig(2);
    r.set([pad(0, DS4, { down: [9] }), pad(1, DS4)]);
    r.frame();
    r.set([pad(0, DS4), pad(1, DS4, { down: [9] })]);
    r.frame();
    expect(r.gp.slots).toEqual([0, 1]);
    r.set([pad(0, DS4, { axes: [-1, 0] }), pad(1, DS4, { down: [15] })]);
    r.frame();
    expect(r.gp.axis(0)).toBeLessThan(-0.9);
    expect(r.gp.axis(1)).toBe(1);
  });

  it('reports a lost pad, frees its slot and lets it rejoin', () => {
    const r = rig(2);
    r.set([pad(0, DS4, { down: [9] })]);
    r.frame();
    expect(r.gp.slots[0]).toBe(0);
    r.set([]);
    const ev = r.frame();
    expect(ev.find((e) => e.t === 'lost')).toMatchObject({ slot: 0 });
    expect(r.gp.slots).toEqual([null, null]);
    expect(r.gp.axis(0)).toBe(0);
    r.set([pad(0, DS4, { down: [9] })]);
    r.frame();
    expect(r.gp.slots[0]).toBe(0);
  });

  it('describes the seats for the menu', () => {
    const r = rig(2);
    r.set([pad(0, DS4, { down: [9] }), pad(1, DS4)]);
    r.frame();
    const d = r.gp.describe(2);
    expect(d.slots[0]).toMatchObject({ kind: 'sony' });
    expect(d.slots[1]).toBeNull();
    expect(d.spare).toBe(1);
  });
});

describe('menu navigation', () => {
  it('steps once on press, then repeats after a delay while held', () => {
    const r = rig(1);
    r.set([pad(0, DS4, { down: [9] })]);
    r.frame();
    r.set([pad(0, DS4)]);
    r.frame();

    r.set([pad(0, DS4, { axes: [1, 0] })]);
    let steps = 0;
    const log: number[] = [];
    for (let i = 0; i < 90; i++) {
      r.frame(1 / 60);
      if (r.gp.navDir().dx === 1) {
        steps++;
        log.push(i);
      }
    }
    expect(log[0]).toBe(0); // immediate
    expect(log[1]).toBeGreaterThan(18); // about 0.35 s later
    expect(steps).toBeGreaterThan(5); // then repeating about every 0.12 s
    expect(steps).toBeLessThan(14);

    r.set([pad(0, DS4)]);
    r.frame();
    expect(r.gp.navDir()).toEqual({ dx: 0, dy: 0 });
  });

  it('vertical navigation works from the d-pad', () => {
    const r = rig(1);
    r.set([pad(0, DS4, { down: [13] })]);
    r.frame();
    expect(r.gp.navDir()).toEqual({ dx: 0, dy: 1 });
  });
});

describe('rumble', () => {
  it('sends a dual-rumble effect to the pad of a slot', () => {
    const r = rig(1);
    const p = pad(0, DS4, { down: [9] });
    r.set([p]);
    r.frame();
    r.gp.rumble(0, 'smash');
    const play = p.vibrationActuator!.playEffect as ReturnType<typeof vi.fn>;
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0][0]).toBe('dual-rumble');
    expect(play.mock.calls[0][1]).toMatchObject({ duration: 140, strongMagnitude: 0.7 });
  });

  it('throttles weak pulses but never drops strong ones, and tolerates missing support', () => {
    const r = rig(1);
    const p = pad(0, DS4, { down: [9] });
    r.set([p]);
    r.frame();
    const play = p.vibrationActuator!.playEffect as ReturnType<typeof vi.fn>;
    r.gp.rumble(0, 'tap');
    r.gp.rumble(0, 'tap'); // same instant: dropped
    expect(play).toHaveBeenCalledTimes(1);
    r.gp.rumble(0, 'goal'); // strong: always goes through
    expect(play).toHaveBeenCalledTimes(2);

    const quiet = rig(1);
    quiet.set([pad(0, DS4, { down: [9], rumble: false })]);
    quiet.frame();
    expect(() => quiet.gp.rumble(0, 'goal')).not.toThrow();
    expect(() => quiet.gp.rumble(1, 'goal')).not.toThrow(); // empty slot
  });
});
