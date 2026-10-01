import type { Gamepads } from './gamepad';

/**
 * Keyboard input, merged with the gamepad manager. Humans are numbered 0..n-1:
 *  - one human: A/D or the arrow keys
 *  - two humans: human 0 uses A/D, human 1 uses the arrow keys
 * Each human can also use a gamepad: the first controller that presses a button becomes P1, the next P2
 * (see gamepad.ts).
 *
 * Actions: smash = Space / W / Up / pad Cross (A); use item = Shift / E / S / Down / pad Square, Triangle,
 * Circle or L1/R1. With two humans the keys are split: P1 uses W (smash) / S (item), P2 uses Up / Down.
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  /** True from a key press until the end of the frame: the keyboard was just used. */
  keyActive = false;

  constructor(readonly pads: Gamepads) {
    addEventListener('keydown', (e) => {
      // Typing into a text box (online codes) is not game input.
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
      this.keyActive = true;
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }

  /** True once per key press. */
  wasPressed(code: string): boolean {
    return this.pressed.delete(code);
  }

  /** Clears one-shot presses; call at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.keyActive = false;
  }

  private key(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  axis(human: number, humans: number): number {
    let a = 0;
    if (humans >= 2) {
      if (human === 0) a = (this.key('KeyD') ? 1 : 0) - (this.key('KeyA') ? 1 : 0);
      else a = (this.key('ArrowRight') ? 1 : 0) - (this.key('ArrowLeft') ? 1 : 0);
    } else {
      a = (this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0);
    }
    const pad = this.pads.axis(human);
    return Math.abs(pad) > Math.abs(a) ? pad : a;
  }

  /** One-shot smash/item presses for a human since the last frame; call exactly once per frame. */
  actions(human: number, humans: number): { smash: boolean; item: boolean } {
    let item: boolean;
    let smash: boolean;
    if (humans >= 2) {
      item = human === 0 ? this.wasPressed('KeyS') : this.wasPressed('ArrowDown');
      smash = human === 0 ? this.wasPressed('KeyW') : this.wasPressed('ArrowUp');
    } else {
      item = ['ShiftLeft', 'ShiftRight', 'KeyE', 'KeyS', 'ArrowDown'].map((c) => this.wasPressed(c)).some(Boolean);
      smash = ['Space', 'KeyW', 'ArrowUp'].map((c) => this.wasPressed(c)).some(Boolean);
    }
    const pad = this.pads.actions(human);
    return { smash: smash || pad.smash, item: item || pad.item };
  }
}
