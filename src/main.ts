import { AudioEngine } from './core/audio';
import { Gamepads, glyphs, type PadEvent, type PadKind, type Rumble } from './core/gamepad';
import { Input } from './core/input';
import { mulberry32 } from './core/rng';
import { Bot } from './ballistix/bot';
import { CRATE_INFO, SEATS, SIDES, humanSeats, type MatchConfig } from './ballistix/config';
import { Hud } from './ballistix/hud';
import { Sim, movePaddle, type SimEvent } from './ballistix/sim';
import { UI, type Settings } from './ballistix/ui';
import { View } from './ballistix/view';
import { Lobby } from './net/lobby';
import { OnlineGuest, OnlineHost, type Session } from './net/online';
import { applySnapshot, encodeSnapshot, type GuestMsg, type HostMsg } from './net/protocol';

const STEP = 1 / 120;
const MAX_STEPS_PER_FRAME = 12;
/** Guests move balls on between snapshots for at most this long (s). */
const MAX_EXTRAPOLATE = 0.12;

type Mode = 'menu' | 'match';

interface RemoteInput {
  axis: number;
  s: number;
  vs: number;
  smash: number;
  item: number;
  seenSmash: number;
  seenItem: number;
  /** Round trip time reported by the guest (ms). */
  rtt: number;
}

class App {
  private view: View;
  private audio = new AudioEngine();
  private pads = new Gamepads();
  private input = new Input(this.pads);
  private hud = new Hud();
  private ui = new UI();
  private lobby = new Lobby();

  private mode: Mode = 'menu';
  /** The device used last: all button guides show its buttons. */
  private device: 'keyboard' | 'pad' = 'keyboard';
  private sim!: Sim;
  private bots: (Bot | null)[] = [];
  private botRng = mulberry32(1);
  private acc = 0;
  private last = performance.now();
  private paused = false;
  private timeScale = 1;
  private slowmo = 0;
  private overTimer = 0;
  private eliminated: number[] = [];
  /** Human smash/item presses collected once per frame and handed to the first sim tick. */
  private pendingActions = [0, 1, 2, 3].map(() => ({ smash: false, item: false }));
  /** Real-time seconds of frozen simulation after a smash lands (hit-stop). */
  private hitstop = 0;

  // --- online ---
  private net: Session | null = null;
  /** Host: latest input from each guest seat. */
  private remote = new Map<number, RemoteInput>();
  /** Host: events of this frame, sent to guests in one message. */
  private netEvents: SimEvent[] = [];
  /** Guest: press counters (survive lost packets) and time of the last snapshot. */
  private guestSmash = 0;
  private guestItem = 0;
  private lastSnap = 0;
  /** Guest: smoothed round trip time to the host (ms). */
  private rtt = 0;
  private pingTimer = 0;
  private hintTimer = 0;

  constructor() {
    this.view = new View(document.getElementById('gl') as HTMLCanvasElement);

    this.ui.onStart = (s) => this.startMatch(s);
    this.ui.onRematch = () => (this.net?.role === 'host' ? this.startOnlineHost(this.net) : this.startMatch(this.ui.settings));
    this.ui.onResume = () => this.requestPause(false);
    this.ui.onQuit = () => this.toMenu();
    this.ui.onOnline = () => {
      this.ui.hideMenu();
      this.lobby.show();
    };
    this.ui.onToggle = (kind, on) => {
      if (kind === 'music') this.audio.setMusic(on);
      if (kind === 'sfx') this.audio.setSfx(on);
    };
    this.ui.onChange = () => this.ui.setControllers(this.pads.describe(this.currentHumans()), this.currentHumans());
    this.lobby.onBack = () => {
      this.net = null;
      if (this.mode === 'match') this.toMenu();
      else this.ui.showMenu();
    };
    this.lobby.onHostStart = (host) => this.startOnlineHost(host);
    this.lobby.onGuestConnected = (guest) => this.attachGuest(guest);
    this.audio.musicOn = this.ui.settings.music;
    this.audio.sfxOn = this.ui.settings.sfx;

    // Browsers only allow audio after a gesture.
    const unlock = () => this.audio.unlock();
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);

    // Offline only: a match pauses itself when the window loses focus (online, the others keep playing).
    addEventListener('blur', () => {
      if (!this.net && this.mode === 'match' && this.sim.phase !== 'over') this.setPaused(true);
    });
    document.addEventListener('visibilitychange', () => {
      if (!this.net && document.hidden && this.mode === 'match' && this.sim.phase !== 'over') this.setPaused(true);
    });

    this.startDemo();
    this.ui.setControllers(this.pads.describe(this.ui.settings.humans), this.ui.settings.humans);
    requestAnimationFrame((t) => this.frame(t));
    (window as unknown as { __ballistix: App }).__ballistix = this; // handy for debugging and automated tests
  }

  // --- seats --------------------------------------------------------------------------

  /** Seats played on this computer. */
  private localSeats(): number[] {
    if (this.net?.role === 'host') return [0];
    if (this.net?.role === 'guest') return [this.net.seat];
    return this.sim ? humanSeats(this.sim.cfg.humans) : [];
  }

  /** The seat shown at the bottom of the screen. */
  private viewSeat(): number {
    return this.net?.role === 'guest' ? this.net.seat : 0;
  }

  /** +1 / -1: makes "right" on the stick mean "right on my screen" for this seat. */
  private axisSign(seat: number): number {
    const az = (this.viewSeat() * Math.PI) / 2;
    const t = SIDES[seat].t;
    return Math.cos(az) * t.x - Math.sin(az) * t.y < 0 ? -1 : 1;
  }

  // --- match lifecycle ---------------------------------------------------------------

  private newSim(cfg: MatchConfig): void {
    this.sim = new Sim(cfg);
    this.botRng = mulberry32(cfg.seed ^ 0x9e3779b9);
    this.bots = this.sim.players.map((p) => (p.human ? null : new Bot(p.seat, cfg.difficulty, this.botRng)));
    this.acc = 0;
    this.eliminated = [];
    for (const a of this.pendingActions) a.smash = a.item = false;
    this.hitstop = 0;
    this.overTimer = 0;
    this.timeScale = 1;
    this.slowmo = 0;
    this.netEvents = [];
    this.view.reset();
  }

  private startDemo(): void {
    this.mode = 'menu';
    this.paused = false;
    this.newSim({ humans: 0, difficulty: 'normal', lives: 5, crates: true, seed: (Math.random() * 1e9) | 0 });
    this.view.setViewSeat(0);
    this.view.setCinematic(true);
    this.hud.hide();
    this.ui.showMenu();
  }

  /** Common part of starting any match. */
  private beginMatch(cfg: MatchConfig): void {
    this.audio.unlock();
    this.mode = 'match';
    this.paused = false;
    this.newSim(cfg);
    this.view.setViewSeat(this.viewSeat());
    this.view.setCinematic(false);
    this.ui.hideMenu();
    this.ui.hideResults();
    this.ui.showPause(false);
    this.lobby.hide();
    const you = this.net ? this.localSeats()[0] : -1;
    this.ui.youSeat = you >= 0 ? you : 0;
    this.hud.setup(this.sim, (seat) => this.keysFor(seat), this.viewSeat(), this.localSeats());
    this.hud.setWide(this.view.wide);
    this.hud.show();
    this.refreshHint();
  }

  private startMatch(s: Settings): void {
    this.beginMatch({ humans: s.humans, difficulty: s.difficulty, lives: s.lives, crates: s.crates === 1, seed: (Math.random() * 1e9) | 0 });
  }

  private startOnlineHost(host: OnlineHost): void {
    this.net = host;
    const s = this.ui.settings;
    const cfg: MatchConfig = { humans: 1, difficulty: s.difficulty, lives: s.lives, crates: s.crates === 1, seed: (Math.random() * 1e9) | 0, seats: host.seats() };
    host.onGuestMsg = (seat, msg) => this.onGuestMsg(seat, msg);
    host.onGuestLeft = (seat) => this.onGuestLeft(seat);
    this.remote.clear();
    this.beginMatch(cfg);
    for (const g of host.guests) this.sim.players[g.seat].external = true;
    host.broadcast('ctrl', { k: 'start', cfg });
  }

  private attachGuest(guest: OnlineGuest): void {
    this.net = guest;
    guest.onMsg = (msg) => this.onHostMsg(msg);
    guest.onClose = () => {
      if (this.net !== guest) return;
      this.lobby.leave();
      this.ui.hideMenu();
      this.lobby.show();
      this.lobby.setGuestStatus('The host closed the room or the connection was lost.');
    };
  }

  private toMenu(): void {
    this.mode = 'menu';
    if (this.net) {
      const net = this.net;
      this.net = null;
      if (net.role === 'host') net.broadcast('ctrl', { k: 'menu' });
      this.lobby.leave();
    }
    this.paused = false;
    this.ui.showPause(false);
    this.ui.hideResults();
    this.startDemo();
  }

  /** Pausing online is shared: the host decides, guests ask. */
  private requestPause(on: boolean): void {
    if (this.net?.role === 'guest') {
      this.net.send('ctrl', { k: 'pause' });
      return;
    }
    this.setPaused(on);
  }

  private setPaused(on: boolean): void {
    if (this.mode !== 'match' || this.sim.phase === 'over') return;
    this.paused = on;
    if (on) {
      const g = this.padGlyphs();
      const who = this.net ? 'Paused for everyone. ' : '';
      this.ui.setPauseNote(`${who}${g ? `${g.confirm} select · ${g.back} or ${g.pause} resume` : ''}`);
    }
    this.ui.showPause(on);
  }

  private currentHumans(): number {
    if (this.mode === 'match') return this.net ? 1 : this.sim.cfg.humans;
    return this.ui.settings.humans;
  }

  /** The kind of controller in use (assigned seat first, then any connected one). */
  private padKind(): PadKind | null {
    return this.pads.kindOf(0) ?? this.pads.kindOf(1) ?? this.pads.state[0]?.kind ?? null;
  }

  /** Button names of the controller, but only while a controller is the device in use. */
  private padGlyphs(): ReturnType<typeof glyphs> | null {
    const kind = this.padKind();
    return this.device === 'pad' && kind ? glyphs(kind) : null;
  }

  /** Called every frame: notices when the player switches between keyboard and controller. */
  private trackDevice(): void {
    let next = this.device;
    if (this.pads.active) next = 'pad';
    else if (this.input.keyActive) next = 'keyboard';
    if (next === this.device) return;
    this.device = next;
    this.ui.setDevice(next, this.padKind());
    this.refreshHint();
    if (this.paused) this.setPaused(true); // refresh the pause screen's note
  }

  /** Button labels (smash / use item) for a local seat, as printed on its controller or keyboard. */
  private keysFor(seat: number): { smash: string; item: string } {
    const seats = this.localSeats();
    const slot = seats.indexOf(seat);
    const kind = slot >= 0 ? this.pads.kindOf(slot) : null;
    // With two local players each one sees their own device; with one player, whichever was used last.
    if (kind && (seats.length >= 2 || this.device === 'pad')) {
      const g = glyphs(kind);
      return { smash: g.smash, item: g.item };
    }
    if (seats.length >= 2) return slot === 0 ? { smash: 'W', item: 'S' } : { smash: '↑', item: '↓' };
    return { smash: 'Space', item: 'Shift' };
  }

  /** A label that rises where something happened in the arena (x, y are arena coordinates). */
  private popAt(x: number, y: number, text: string, css: string, big = false): void {
    const p = this.view.project(x, 1.2, y);
    this.hud.popup(text, css, p.x, p.y, big);
  }

  private popAtGoal(seat: number, text: string, css: string, big = false): void {
    const p = this.view.goalLabelPos(seat);
    this.hud.popup(text, css, p.x, p.y, big);
  }

  /** Online: round trip times, so players can see the connection quality. */
  private pingText(): string {
    if (this.net?.role === 'guest') return `Ping ${Math.round(this.rtt)} ms`;
    if (this.net?.role === 'host') {
      const parts = [...this.remote.entries()].map(([seat, r]) => `${SEATS[seat].name} ${r.rtt} ms`);
      return parts.length ? `Ping: ${parts.join(' · ')}` : '';
    }
    return '';
  }

  private refreshHint(): void {
    const g = this.padGlyphs();
    if (!g) {
      this.hud.setHint('P / Esc pause  ·  M music  ·  N sound');
      return;
    }
    this.hud.setHint(`${g.smash} smash  ·  ${g.item} item  ·  ${g.pause} pause`);
  }

  private handlePadEvents(events: PadEvent[]): void {
    for (const ev of events) {
      if (ev.t === 'changed') {
        const humans = this.currentHumans();
        this.ui.setControllers(this.pads.describe(humans), humans);
        this.refreshHint();
      } else if (ev.t === 'joined') {
        if (this.mode === 'match') this.hud.toast(`<b>P${ev.slot + 1}</b> controller connected`, '#7dff8a');
      } else if (ev.t === 'lost' && this.mode === 'match' && this.sim.phase !== 'over' && !this.net) {
        this.setPaused(true);
        this.ui.setPauseNote(`The controller for P${ev.slot + 1} disconnected. Reconnect it and press a button, or carry on with the keyboard.`);
      }
    }
  }

  private rumbleSeat(seat: number, kind: Rumble): void {
    if (this.mode !== 'match' || !this.ui.settings.vibration) return;
    const slot = this.localSeats().indexOf(seat);
    if (slot >= 0) this.pads.rumble(slot, kind);
  }

  // --- online messages ------------------------------------------------------------------

  private onGuestMsg(seat: number, msg: GuestMsg): void {
    if (msg.k === 'in') {
      const r = this.remote.get(seat) ?? { axis: 0, s: 0, vs: 0, smash: msg.smash, item: msg.item, seenSmash: msg.smash, seenItem: msg.item, rtt: 0 };
      r.rtt = msg.rtt;
      r.axis = msg.axis;
      r.s = msg.s;
      r.vs = msg.vs;
      r.smash = msg.smash;
      r.item = msg.item;
      this.remote.set(seat, r);
    } else if (msg.k === 'ping' && this.net?.role === 'host') {
      this.net.sendTo(seat, 'fast', { k: 'pong', t: msg.t });
    } else if (msg.k === 'pause' && this.mode === 'match') {
      this.setPaused(!this.paused);
    }
  }

  private onGuestLeft(seat: number): void {
    this.remote.delete(seat);
    if (this.mode !== 'match' || this.net?.role !== 'host') return;
    const p = this.sim.players[seat];
    p.external = false;
    p.human = false;
    this.bots[seat] = new Bot(seat, this.sim.cfg.difficulty, this.botRng);
    this.hud.toast(`<b>${SEATS[seat].name}</b> disconnected · a bot takes over`, SEATS[seat].css);
  }

  private onHostMsg(msg: HostMsg): void {
    const guest = this.net?.role === 'guest' ? this.net : null;
    if (!guest) return;
    switch (msg.k) {
      case 'welcome':
      case 'lobby':
        if (this.mode !== 'match') this.lobby.setGuestStatus(`Connected as ${SEATS[guest.seat]?.name ?? 'a player'} (${guest.seats.length || 2} players in the room). Waiting for the host to start...`);
        break;
      case 'start':
        this.guestSmash = 0;
        this.guestItem = 0;
        this.lastSnap = performance.now();
        this.beginMatch(msg.cfg);
        break;
      case 'snap':
        if (this.mode !== 'match') return;
        applySnapshot(this.sim, msg.s, guest.seat, Math.min(this.rtt / 2, 100) / 1000);
        this.lastSnap = performance.now();
        if (msg.s.paused !== this.paused) {
          this.paused = msg.s.paused;
          if (this.paused) this.setPaused(true);
          else this.ui.showPause(false);
        }
        break;
      case 'ev':
        if (this.mode !== 'match') return;
        for (const ev of msg.list) {
          if (ev.t === 'swing' && ev.seat === guest.seat) continue; // already shown when pressed
          this.onEvent(ev);
        }
        break;
      case 'pong': {
        const sample = performance.now() - msg.t;
        this.rtt = this.rtt ? this.rtt + (sample - this.rtt) * 0.2 : sample;
        break;
      }
      case 'menu':
        this.lobby.setGuestStatus('The host went back to the menu.');
        if (this.mode === 'match') {
          this.mode = 'menu';
          this.startDemo();
          this.ui.hideMenu();
          this.lobby.show();
        }
        break;
    }
  }

  // --- main loop ----------------------------------------------------------------------

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.handlePadEvents(this.pads.update(dt, this.currentHumans()));
    this.trackDevice();
    this.handleKeys();

    if (this.net?.role === 'guest' && this.mode === 'match') {
      this.guestFrame(dt, now);
    } else if (!this.paused) {
      this.collectActions();
      if (this.hitstop > 0) {
        this.hitstop -= dt; // freeze the simulation for a few frames so a smash feels heavy
      } else {
        // Smooth slow-motion after an elimination (offline only, online everyone shares one clock).
        if (this.slowmo > 0 && !this.net) {
          this.slowmo -= dt;
          this.timeScale += (0.55 - this.timeScale) * Math.min(1, dt * 12);
        } else {
          this.timeScale += (1 - this.timeScale) * Math.min(1, dt * 4);
        }
        this.acc += dt * this.timeScale;
        let steps = 0;
        while (this.acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
          this.tick(STEP);
          this.acc -= STEP;
          steps++;
        }
        if (steps === MAX_STEPS_PER_FRAME) this.acc = 0;
      }
      this.afterSim(dt);
    }

    if (this.net?.role === 'host' && this.mode === 'match') {
      this.net.broadcast('fast', { k: 'snap', s: encodeSnapshot(this.sim, this.paused) });
      if (this.netEvents.length) {
        this.net.broadcast('ctrl', { k: 'ev', list: this.netEvents });
        this.netEvents = [];
      }
    }

    this.view.update(this.sim, this.paused || this.hitstop > 0 ? 0 : dt * this.timeScale);
    if (this.mode === 'match' && this.net) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) {
        this.hintTimer = 0.5;
        this.hud.setHint(this.pingText());
      }
    }
    if (this.mode === 'match') {
      this.hud.update(this.sim);
      this.hud.setWide(this.view.wide);
    }
    this.input.endFrame();
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Online guest: move our own paddle locally, send input, and keep balls moving between snapshots. */
  private guestFrame(dt: number, now: number): void {
    const guest = this.net as OnlineGuest;
    const sim = this.sim;
    const p = sim.players[guest.seat];
    if (!p) return;
    if (this.hitstop > 0) this.hitstop -= dt;
    if (!this.paused && sim.phase !== 'over') {
      if (p.alive) {
        p.axis = this.input.axis(0, 1) * this.axisSign(p.seat);
        movePaddle(p, dt, sim.paddleLimit(p.h));
      }
      const a = this.input.actions(0, 1);
      if (a.smash) {
        this.guestSmash++;
        if (p.alive && p.smashCd <= 0 && sim.phase === 'play') {
          // Show the swing at once; the host decides what it hits.
          this.view.handleEvent({ t: 'swing', seat: p.seat });
          if (this.ui.settings.sfx) this.audio.play('swing');
        }
      }
      if (a.item) this.guestItem++;
      const age = (now - this.lastSnap) / 1000;
      if (age < MAX_EXTRAPOLATE) {
        for (const b of sim.balls) {
          if (b.hold > 0) continue;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
        }
      }
    }
    guest.send('fast', { k: 'in', axis: p.axis, s: p.s, vs: p.vs, smash: this.guestSmash, item: this.guestItem, rtt: Math.round(this.rtt) });
    this.pingTimer -= dt;
    if (this.pingTimer <= 0) {
      this.pingTimer = 0.5;
      guest.send('fast', { k: 'ping', t: performance.now() });
    }
    if (sim.phase === 'over') this.afterSim(dt);
  }

  /** Arrow keys and the controller drive every screen the same way. */
  private screenNav(): void {
    const k = this.input;
    const pad = this.pads.navDir();
    const dx = pad.dx || (k.wasPressed('ArrowRight') ? 1 : 0) - (k.wasPressed('ArrowLeft') ? 1 : 0);
    const dy = pad.dy || (k.wasPressed('ArrowDown') ? 1 : 0) - (k.wasPressed('ArrowUp') ? 1 : 0);
    if (dx || dy) this.ui.nav(dx, dy);
    if (this.pads.anyEdge('south') || k.wasPressed('Enter') || k.wasPressed('NumpadEnter') || k.wasPressed('Space')) this.ui.activate();
  }

  private handleKeys(): void {
    const k = this.input;
    if (k.wasPressed('KeyM')) this.ui.toggle('music');
    if (k.wasPressed('KeyN')) this.ui.toggle('sfx');

    const pads = this.pads;
    const padBack = pads.anyEdge('east');
    const padStart = pads.anyEdge('start');

    if (this.ui.guideOpen) {
      if (k.wasPressed('Escape') || padBack || padStart) this.ui.closeGuide();
      else this.screenNav();
      return;
    }

    if (this.mode === 'menu') {
      if (this.lobby.visible) {
        // Typing codes needs the keyboard: only the controller and Escape act here.
        if (padBack || k.wasPressed('Escape')) this.lobby.leave();
        else if (pads.navDir().dx || pads.navDir().dy || pads.anyEdge('south')) this.screenNav();
        return;
      }
      if (padStart) this.startMatch(this.ui.settings);
      else this.screenNav();
      return;
    }
    if (this.sim.phase === 'over') {
      if (this.overTimer > 1.2) {
        const canRematch = this.net?.role !== 'guest';
        if (canRematch && (padStart || k.wasPressed('KeyR'))) this.ui.onRematch();
        else if (k.wasPressed('Escape') || padBack) this.toMenu();
        else this.screenNav();
      }
      return;
    }
    const togglePause = k.wasPressed('KeyP') || padStart;
    const esc = k.wasPressed('Escape');
    if (this.paused) {
      if (k.wasPressed('KeyQ')) this.toMenu();
      else if (togglePause || esc || padBack) this.requestPause(false);
      else this.screenNav();
    } else if (togglePause || esc) {
      this.requestPause(true);
    }
  }

  /** Reads one-shot action presses once per rendered frame. */
  private collectActions(): void {
    if (this.mode !== 'match') return;
    const seats = this.localSeats();
    seats.forEach((seat, i) => {
      const a = this.input.actions(i, seats.length);
      this.pendingActions[seat].smash ||= a.smash;
      this.pendingActions[seat].item ||= a.item;
    });
  }

  private tick(dt: number): void {
    const sim = this.sim;
    const seats = this.localSeats();
    for (const p of sim.players) {
      if (!p.alive) continue;
      const bot = this.bots[p.seat];
      if (bot) {
        p.axis = bot.update(sim, dt);
      } else if (p.external) {
        // Online guest: trust its own paddle position, take its button presses.
        const r = this.remote.get(p.seat);
        if (r) {
          p.axis = r.axis;
          // The report is half a round trip old: move it on by that much (the sim clamps it to the goal).
          p.s = r.s + r.vs * (Math.min(r.rtt, 200) / 2000);
          p.vs = r.vs;
          if (r.smash > r.seenSmash) p.smashReq = true;
          if (r.item > r.seenItem) p.itemReq = true;
          r.seenSmash = r.smash;
          r.seenItem = r.item;
        }
      } else {
        const slot = seats.indexOf(p.seat);
        p.axis = this.input.axis(slot, seats.length) * this.axisSign(p.seat);
        const pending = this.pendingActions[p.seat];
        if (pending.smash) p.smashReq = true;
        if (pending.item) p.itemReq = true;
        pending.smash = false;
        pending.item = false;
      }
    }
    sim.step(dt);
    for (const ev of sim.events) {
      this.onEvent(ev);
      if (this.net?.role === 'host') this.netEvents.push(ev);
    }
  }

  private afterSim(dt: number): void {
    if (this.sim.phase !== 'over') return;
    this.overTimer += dt;
    if (this.mode === 'menu' && this.overTimer > 3) {
      // Keep the attract-mode arena alive behind the menu.
      this.newSim({ humans: 0, difficulty: 'normal', lives: 5, crates: true, seed: (Math.random() * 1e9) | 0 });
    }
  }

  // --- events -> audio / view / hud -----------------------------------------------------

  private onEvent(ev: SimEvent): void {
    this.view.handleEvent(ev);
    const live = this.mode === 'match';
    const sfx = (name: Parameters<AudioEngine['play']>[0], i?: number) => {
      if (live) this.audio.play(name, i);
    };
    switch (ev.t) {
      case 'countdown':
        if (live) {
          this.hud.countdown(String(ev.n));
          sfx('beep');
        }
        break;
      case 'go':
        if (live) {
          this.hud.countdown('GO!');
          sfx('go');
        }
        break;
      case 'serve':
        sfx('serve');
        if (live && ev.reason === 'pressure') this.popAt(0, 0, '+1 BALL', '#ffffff', true);
        break;
      case 'paddle':
        sfx('paddle', Math.min(1, (ev.speed - 9) / 13));
        this.rumbleSeat(ev.seat, 'tap');
        break;
      case 'smash':
        this.rumbleSeat(ev.seat, 'smash');
        sfx('smash');
        this.hitstop = 0.07;
        this.view.shake(0.3);
        break;
      case 'swing':
        sfx('swing');
        break;
      case 'split':
        sfx('ball');
        sfx('power');
        break;
      case 'lastStand':
        this.rumbleSeat(ev.seat, 'goal');
        sfx('laststand');
        if (live) this.popAtGoal(ev.seat, 'LAST STAND', '#ff4d6a');
        break;
      case 'wall':
        if (ev.speed > 3) sfx(ev.closed ? (this.sim.players[ev.seat].alive ? 'shield' : 'zap') : 'wall', Math.min(1, ev.speed / 20));
        break;
      case 'ballHit':
        sfx('ball');
        break;
      case 'goal': {
        if (ev.lives > 0) sfx('goal'); // an elimination plays its own sound
        if (ev.lives > 0) this.rumbleSeat(ev.seat, 'goal');
        // The lives counter above the goal jumps; a short "-1" rises from the goal.
        if (live) this.popAtGoal(ev.seat, '-1', SEATS[ev.seat].css, true);
        break;
      }
      case 'eliminated':
        this.eliminated.push(ev.seat);
        this.rumbleSeat(ev.seat, 'out');
        this.slowmo = 0.45;
        this.view.shake(0.3);
        sfx('elim');
        if (live) this.popAtGoal(ev.seat, `${SEATS[ev.seat].name.toUpperCase()} IS OUT`, SEATS[ev.seat].css, true);
        break;
      case 'crateSpawn':
        sfx('spawn');
        break;
      case 'pickup': {
        sfx('crate');
        sfx(ev.kind === 'life' ? 'life' : 'power');
        this.rumbleSeat(ev.seat, 'item');
        if (live) this.popAt(ev.x, ev.y, `+${CRATE_INFO[ev.kind].label}`, CRATE_INFO[ev.kind].css);
        break;
      }
      case 'item': {
        sfx('item');
        this.rumbleSeat(ev.seat, 'item');
        if (live) this.popAtGoal(ev.seat, CRATE_INFO[ev.kind].label, CRATE_INFO[ev.kind].css);
        break;
      }
      case 'win':
        this.view.celebrate(ev.seat);
        if (live) {
          sfx('win');
          this.hud.countdown(ev.seat >= 0 ? `${SEATS[ev.seat].name} wins!` : 'Draw');
          window.setTimeout(() => {
            if (this.mode === 'match' && this.sim.phase === 'over') {
              this.hud.hide();
              this.ui.showResults(this.sim, this.eliminated, this.net?.role === 'guest');
            }
          }, 1800);
        }
        break;
      case 'crateExpire':
      case 'ballFade':
        break;
    }
  }
}

new App();
