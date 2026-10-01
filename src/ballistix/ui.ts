import { glyphs, type Gamepads, type PadKind } from '../core/gamepad';
import { Guide } from './guide';
import { kbd, setKeycap } from './labels';
import { CRATE_INFO, SEATS, type CrateKind, type Difficulty } from './config';
import type { Sim } from './sim';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface Settings {
  humans: 1 | 2;
  difficulty: Difficulty;
  lives: number;
  /** 1 = item crates on, 0 = off. */
  crates: 0 | 1;
  music: boolean;
  sfx: boolean;
  /** Controller rumble. */
  vibration: boolean;
}

export type ToggleKind = 'music' | 'sfx' | 'vibration';
type SegKey = 'humans' | 'difficulty' | 'lives' | 'crates';

const DEFAULTS: Settings = { humans: 1, difficulty: 'normal', lives: 5, crates: 1, music: true, sfx: true, vibration: true };
const STORE_KEY = 'ballistix.settings.v1';
const TOGGLE_LABEL: Record<ToggleKind, string> = { music: '♪ Music', sfx: '🔊 Sound', vibration: '≋ Vibration' };

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable: use defaults */
  }
  return { ...DEFAULTS };
}

interface Focus {
  row: number;
  sub: number;
}

export class UI {
  settings = load();
  onStart: (s: Settings) => void = () => {};
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  onRematch: () => void = () => {};
  onOnline: () => void = () => {};
  onToggle: (kind: ToggleKind, on: boolean) => void = () => {};
  /** Called after a menu option changed (the controller panel depends on the player count). */
  onChange: () => void = () => {};

  private menu = $('menu');
  private pause = $('pause');
  private results = $('results');
  /** Kind of the controller in use, for button names. */
  private padGlyph: PadKind | null = null;
  /** The device the player is using right now: button guides show its buttons. */
  private device: 'keyboard' | 'pad' = 'keyboard';
  private padPresent = false;
  private guide = new Guide($('guide-grid'));
  /** True while a controller or the arrow keys are steering the screens (shows the focus highlight). */
  private navMode = false;
  private focus = new Map<HTMLElement, Focus>();
  /** Seat of the local player (for 'you' labels). */
  youSeat = 0;

  constructor() {
    for (const seg of document.querySelectorAll<HTMLElement>('.seg')) {
      const key = seg.dataset.key as SegKey;
      seg.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (!btn) return;
        const v = btn.dataset.value as string;
        const s = this.settings as unknown as Record<string, unknown>;
        s[key] = key === 'difficulty' ? v : Number(v);
        this.persist();
        this.refresh();
        this.onChange();
      });
    }
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-toggle]')) {
      btn.addEventListener('click', () => this.toggle(btn.dataset.toggle as ToggleKind));
    }
    $('start').addEventListener('click', () => this.onStart(this.settings));
    $('online-btn').addEventListener('click', () => this.onOnline());
    $('resume').addEventListener('click', () => this.onResume());
    $('quit').addEventListener('click', () => this.onQuit());
    $('rematch').addEventListener('click', () => this.onRematch());
    $('guide-btn').addEventListener('click', () => this.openGuide());
    $('guide-btn2').addEventListener('click', () => this.openGuide());
    $('guide-back').addEventListener('click', () => this.closeGuide());
    $('r-menu').addEventListener('click', () => this.onQuit());
    // Using the mouse hides the controller focus highlight.
    addEventListener('mousemove', () => this.setNavMode(false));

    $('powerlegend').innerHTML = (Object.keys(CRATE_INFO) as CrateKind[])
      .map((k) => `<span class="chip" style="--c:${CRATE_INFO[k].css}" title="${CRATE_INFO[k].help}"><i></i>${CRATE_INFO[k].label}</span>`)
      .join('');
    this.refresh();
    this.resetFocus(this.menu);
  }

  toggle(kind: ToggleKind): void {
    this.settings[kind] = !this.settings[kind];
    this.persist();
    this.refresh();
    this.onToggle(kind, this.settings[kind]);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  /** Syncs button highlight and help text with the current settings. */
  refresh(): void {
    for (const seg of document.querySelectorAll<HTMLElement>('.seg')) {
      const key = seg.dataset.key as SegKey;
      for (const btn of seg.querySelectorAll('button')) {
        btn.classList.toggle('on', btn.dataset.value === String(this.settings[key]));
      }
    }
    // Only the buttons of the device in use are shown.
    let help: string;
    if (this.device === 'pad') {
      help = this.padLine();
    } else {
      help =
        this.settings.humans === 2
          ? `<b>P1</b> (bottom): <kbd>A</kbd><kbd>D</kbd> move · <kbd>W</kbd> smash · <kbd>S</kbd> item<br><b>P2</b> (top): <kbd>←</kbd><kbd>→</kbd> move · <kbd>↑</kbd> smash · <kbd>↓</kbd> item`
          : `<kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd> move · <kbd>Space</kbd> smash · <kbd>Shift</kbd> item`;
      help += this.padPresent ? '<br><span class="dim">Controller found: press any button on it to use it.</span>' : '';
    }
    $('ctl-keys').innerHTML = help;
    this.applyKeycaps();
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-toggle]')) {
      const kind = btn.dataset.toggle as ToggleKind;
      btn.textContent = `${TOGGLE_LABEL[kind]}: ${this.settings[kind] ? 'on' : 'off'}`;
      btn.classList.toggle('off', !this.settings[kind]);
    }
  }

  private padLine(): string {
    const g = glyphs(this.padGlyph ?? 'sony');
    return `Stick / D-pad move · ${kbd(g.smash)} smash · ${kbd(g.item)} item · ${kbd(g.pause)} pause`;
  }

  /** Switches every button guide to the device in use (keyboard or the controller's own buttons). */
  setDevice(device: 'keyboard' | 'pad', kind: PadKind | null): void {
    if (kind) this.padGlyph = kind;
    this.device = device;
    this.refresh();
  }

  private applyKeycaps(): void {
    const pad = this.device === 'pad';
    const g = glyphs(this.padGlyph ?? 'sony');
    const set = (k: string, kb: string, pd: string) => document.querySelectorAll<HTMLElement>(`[data-k="${k}"]`).forEach((el) => setKeycap(el, pad ? pd : kb));
    set('start', 'Enter', g.confirm);
    set('resume', 'P', g.pause);
    set('quit', 'Q', '');
    set('rematch', 'Enter', g.confirm);
    set('rmenu', 'Esc', g.back);
    set('back', 'Esc', g.back);
  }

  /** Updates the controller panel and the button names. */
  setControllers(info: ReturnType<Gamepads['describe']>, humans: number): void {
    this.padGlyph = info.slots.find((s) => s)?.kind ?? this.padGlyph;
    this.padPresent = info.spare > 0 || info.slots.some((s) => s);
    const rows = info.slots.map((s, i) => {
      const label = humans >= 2 ? `P${i + 1}` : 'P1';
      return s
        ? `<div class="padrow ok"><b>${label}</b><span>${s.name}</span><em>ready</em></div>`
        : `<div class="padrow"><b>${label}</b><span>Keyboard</span><em>press a button on a controller to join</em></div>`;
    });
    const notes: string[] = [];
    if (info.ignored > 0) notes.push(`Hiding ${info.ignored} duplicate controller entr${info.ignored === 1 ? 'y' : 'ies'} (DS4Windows).`);
    if (info.spare > 0 && info.slots.every((s) => s)) notes.push(`${info.spare} more controller${info.spare === 1 ? '' : 's'} connected. Choose "2 Players" to use ${info.spare === 1 ? 'it' : 'them'}.`);
    if (info.slots.every((s) => !s) && info.spare === 0) notes.push('No controller found yet. Connect one and press any button (Chrome or Edge).');
    $('pads').innerHTML = rows.join('') + notes.map((n) => `<div class="padnote">${n}</div>`).join('');
    this.refresh();
  }

  setPauseNote(text: string): void {
    $('pause-note').textContent = text;
  }

  // --- screens -----------------------------------------------------------------------

  get guideOpen(): boolean {
    return !$('guide').classList.contains('hidden');
  }

  openGuide(): void {
    $('guide').classList.remove('hidden');
    this.guide.start();
    this.resetFocus($('guide'));
  }

  closeGuide(): void {
    $('guide').classList.add('hidden');
    this.guide.stop();
  }

  showMenu(): void {
    this.menu.classList.remove('hidden');
    this.pause.classList.add('hidden');
    this.results.classList.add('hidden');
    this.resetFocus(this.menu);
  }

  hideMenu(): void {
    this.menu.classList.add('hidden');
  }

  showPause(on: boolean): void {
    this.pause.classList.toggle('hidden', !on);
    if (on) this.resetFocus(this.pause);
  }

  hideResults(): void {
    this.results.classList.add('hidden');
  }

  showResults(sim: Sim, eliminationOrder: number[], waitForHost = false): void {
    const winner = sim.winner;
    const info = winner >= 0 ? SEATS[winner] : null;
    const youWon = winner >= 0 && sim.players[winner].human;
    const title = $('r-title');
    title.textContent = !info ? 'Draw' : youWon ? `${info.name} wins!` : `${info.name} wins`;
    title.style.color = info ? info.css : '#fff';

    const order = [winner, ...[...eliminationOrder].reverse()].filter((s, i, a) => s >= 0 && a.indexOf(s) === i);
    for (const p of sim.players) if (!order.includes(p.seat)) order.push(p.seat);
    const humans = sim.players.filter((p) => p.human).map((p) => p.seat);
    void humans;
    const rows = order
      .map((seat, i) => {
        const p = sim.players[seat];
        const who = `${SEATS[seat].name}${p.human ? (seat === this.youSeat ? ' (you)' : ' (player)') : ''}`;
        return `<tr class="${i === 0 ? 'win' : ''}" style="--c:${SEATS[seat].css}"><td><span class="dot"></span>${i + 1}. ${who}</td><td>${p.stats.saves}</td><td>${p.stats.smashes}</td><td class="hl">${p.stats.scored}</td><td>${p.stats.conceded}</td><td>${p.stats.crates}</td></tr>`;
      })
      .join('');
    $('r-table').innerHTML = `<tr><th>Player</th><th>Saves</th><th>Smashes</th><th>Goals</th><th>Against</th><th>Items</th></tr>${rows}`;
    const m = Math.floor(sim.playTime / 60);
    const s = Math.round(sim.playTime % 60);
    $('r-time').textContent = `Match length ${m}:${String(s).padStart(2, '0')}${waitForHost ? ' · waiting for the host to start a rematch' : ''}`;
    $('rematch').classList.toggle('hidden', waitForHost);
    this.results.classList.remove('hidden');
    this.resetFocus(this.results);
  }

  // --- controller / arrow-key navigation ----------------------------------------------

  /** The screen that currently takes navigation input, if any. */
  private activeScreen(): HTMLElement | null {
    for (const s of [$('guide'), this.results, this.pause, $('online'), this.menu]) if (!s.classList.contains('hidden')) return s;
    return null;
  }

  private rowsOf(screen: HTMLElement): HTMLElement[] {
    // Only rows that are actually shown (e.g. the guest's results screen has no Rematch button).
    return [...screen.querySelectorAll<HTMLElement>('[data-nav]')].filter((el) => !el.closest('.hidden') && !el.classList.contains('hidden'));
  }

  private resetFocus(screen: HTMLElement): void {
    const rows = this.rowsOf(screen);
    const row = Math.max(0, rows.findIndex((r) => r.hasAttribute('data-default')));
    this.focus.set(screen, { row, sub: 0 });
    this.paint(screen);
  }

  private setNavMode(on: boolean): void {
    if (this.navMode === on) return;
    this.navMode = on;
    document.body.classList.toggle('navmode', on);
  }

  private paint(screen: HTMLElement): void {
    const f = this.focus.get(screen) ?? { row: 0, sub: 0 };
    this.rowsOf(screen).forEach((el, i) => {
      el.classList.toggle('focus', i === f.row);
      if (el.dataset.nav === 'row') {
        el.querySelectorAll('button').forEach((b, j) => b.classList.toggle('focus', i === f.row && j === f.sub));
      }
    });
  }

  /** Up/down moves between rows; left/right changes an option or picks a button in a row. */
  nav(dx: number, dy: number): void {
    const screen = this.activeScreen();
    if (!screen) return;
    this.setNavMode(true);
    if (screen.id === 'guide') {
      // The guide only has a Back button: up/down scrolls the cards instead.
      if (dy) $('guide-grid').scrollBy({ top: dy * 170, behavior: 'smooth' });
      return;
    }
    const rows = this.rowsOf(screen);
    const f = this.focus.get(screen) ?? { row: 0, sub: 0 };
    if (dy) {
      f.row = Math.max(0, Math.min(rows.length - 1, f.row + dy));
      f.sub = 0;
    } else if (dx) {
      const el = rows[f.row];
      if (el?.dataset.nav === 'seg') this.stepOption(el, dx, false);
      else if (el?.dataset.nav === 'row') f.sub = Math.max(0, Math.min(el.querySelectorAll('button').length - 1, f.sub + dx));
    }
    this.focus.set(screen, f);
    this.paint(screen);
  }

  /** Confirm: presses the focused button, or steps the focused option. */
  activate(): void {
    const screen = this.activeScreen();
    if (!screen) return;
    this.setNavMode(true);
    const f = this.focus.get(screen) ?? { row: 0, sub: 0 };
    const el = this.rowsOf(screen)[f.row];
    if (!el) return;
    if (el.dataset.nav === 'seg') this.stepOption(el, 1, true);
    else if (el.dataset.nav === 'row') el.querySelectorAll<HTMLButtonElement>('button')[f.sub]?.click();
    else el.click();
    this.paint(screen);
  }

  private stepOption(group: HTMLElement, dir: number, wrap: boolean): void {
    const btns = [...group.querySelectorAll<HTMLButtonElement>('.seg button')];
    if (!btns.length) return;
    const cur = Math.max(0, btns.findIndex((b) => b.classList.contains('on')));
    let next = cur + dir;
    if (wrap) next = (next + btns.length) % btns.length;
    btns[Math.max(0, Math.min(btns.length - 1, next))].click();
  }
}
