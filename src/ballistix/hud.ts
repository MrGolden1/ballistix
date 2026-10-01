import { CRATE_INFO, SEATS, SMASH_CD, seatName } from './config';
import { escapeHtml, initial } from '../core/names';
import { itemIconURL } from './icons';
import { kbd } from './labels';
import type { PlayerState, Sim } from './sim';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Button labels for one local player. */
export interface Keys {
  smash: string;
  item: string;
}

interface Row {
  seat: number;
  el: HTMLElement;
  num: HTMLElement;
  bar: HTMLElement;
  tags: HTMLElement;
  lives: number;
  tagKey: string;
}

interface Mine {
  seat: number;
  el: HTMLElement;
  lives: HTMLElement;
  meter: HTMLElement;
  state: HTMLElement;
  item: HTMLElement;
  itemKey: string;
  ready: boolean | null;
  livesShown: number;
  smashKey: HTMLElement;
  keySig: string;
}

/**
 * The in-match HUD:
 *  - a scoreboard: one row per player (colour, name, lives as a big number + bar, active effects),
 *    the local player first;
 *  - a "you" panel per local player with only what that player acts on: smash readiness and the
 *    held item with its button;
 *  - short labels that pop up where something happens (pickups, extra balls) instead of toasts.
 * Lives are also shown above every goal in the 3D scene (see View).
 */
export class Hud {
  private root = $('hud');
  private board = $('board');
  private me = $('me');
  private pops = $('popups');
  private toastsEl = $('toasts');
  private countEl = $('countdown');
  private rows: Row[] = [];
  private mine: Mine[] = [];
  private maxLives = 5;
  private keys: (seat: number) => Keys = () => ({ smash: '', item: '' });

  /** Replaces the small hint in the bottom-right corner. */
  setHint(text: string): void {
    $('hudhint').textContent = text;
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  /** Wide screens put the scoreboard in the side gutter; narrow screens use a strip at the top. */
  setWide(wide: boolean): void {
    this.root.classList.toggle('wide', wide);
  }

  /**
   * Builds the HUD for a new match. `localSeats` are the players on this computer (they get a "you"
   * panel and come first on the scoreboard); `viewSeat` is the seat at the bottom of the screen.
   */
  setup(sim: Sim, keys: (seat: number) => Keys, viewSeat: number, localSeats: number[]): void {
    this.keys = keys;
    this.maxLives = sim.cfg.lives;
    this.toastsEl.innerHTML = '';
    this.pops.innerHTML = '';
    this.countEl.className = '';
    this.countEl.textContent = '';

    // Local players first, then the others in screen order (clockwise from the bottom).
    const order = [0, 1, 2, 3]
      .map((k) => (viewSeat + k) % 4)
      .filter((seat) => sim.players[seat].active)
      .sort((a, b) => Number(localSeats.includes(b)) - Number(localSeats.includes(a)));
    const humans = sim.players.filter((p) => p.human).map((p) => p.seat);
    const tag = (seat: number) => (localSeats.length === 1 && localSeats[0] === seat ? 'YOU' : humans.includes(seat) ? `P${humans.indexOf(seat) + 1}` : '');

    this.board.innerHTML = '';
    this.rows = order.map((seat) => {
      const el = document.createElement('div');
      el.className = `row${localSeats.includes(seat) ? ' local' : ''}`;
      el.style.setProperty('--c', SEATS[seat].css);
      const t = tag(seat);
      const name = seatName(sim.cfg, seat);
      el.innerHTML = `<span class="av">${escapeHtml(initial(name))}</span><span class="nm">${escapeHtml(name)}${t ? `<em>${t}</em>` : ''}</span><span class="lv"><b>0</b><i><s></s></i></span><span class="tags"></span>`;
      this.board.appendChild(el);
      return { seat, el, num: el.querySelector('.lv b') as HTMLElement, bar: el.querySelector('.lv s') as HTMLElement, tags: el.querySelector('.tags') as HTMLElement, lives: -1, tagKey: '-' };
    });

    this.me.innerHTML = '';
    this.mine = localSeats.map((seat) => {
      const el = document.createElement('div');
      el.className = 'mine';
      el.style.setProperty('--c', SEATS[seat].css);
      const t = tag(seat);
      const k = keys(seat);
      const name = seatName(sim.cfg, seat);
      el.innerHTML = `<div class="mh"><span class="av">${escapeHtml(initial(name))}</span><b>${escapeHtml(name)}</b>${t ? `<em>${t}</em>` : ''}<span class="ml">♥ <b>0</b></span></div>
        <div class="ms"><span class="mk">${kbd(k.smash)}</span><span class="mlabel">SMASH</span><i><s></s></i><span class="mstate"></span></div>
        <div class="mi"></div>`;
      this.me.appendChild(el);
      return {
        seat,
        el,
        lives: el.querySelector('.ml b') as HTMLElement,
        meter: el.querySelector('.ms s') as HTMLElement,
        state: el.querySelector('.mstate') as HTMLElement,
        item: el.querySelector('.mi') as HTMLElement,
        itemKey: '-',
        ready: null,
        livesShown: -1,
        smashKey: el.querySelector('.mk') as HTMLElement,
        keySig: `${k.smash}|${k.item}`,
      };
    });
    this.update(sim);
  }

  update(sim: Sim): void {
    for (const r of this.rows) {
      const p = sim.players[r.seat];
      if (r.lives !== p.lives) {
        if (r.lives > p.lives && r.lives !== -1) this.bump(r.el);
        r.lives = p.lives;
        r.num.textContent = String(p.lives);
        r.bar.style.width = `${Math.min(100, (p.lives / this.maxLives) * 100)}%`;
      }
      r.el.classList.toggle('out', !p.alive);
      const tags = this.tagsFor(sim, p);
      const key = tags.map((t) => t.label + (t.icon ? '*' : '')).join(',');
      if (key !== r.tagKey) {
        r.tagKey = key;
        r.tags.innerHTML = tags.map((t) => (t.icon ? `<span class="chip item" style="--c:${t.css}"><img src="${t.icon}" alt="">${t.label}</span>` : `<span class="chip" style="--c:${t.css}"><i></i>${t.label}</span>`)).join('');
      }
    }

    for (const m of this.mine) {
      const p = sim.players[m.seat];
      if (m.livesShown !== p.lives) {
        m.livesShown = p.lives;
        m.lives.textContent = String(p.lives);
      }
      m.el.classList.toggle('out', !p.alive);
      const fill = Math.max(0, Math.min(1, 1 - p.smashCd / SMASH_CD));
      m.meter.style.width = `${(fill * 100).toFixed(0)}%`;
      const ready = fill >= 1;
      if (ready !== m.ready) {
        m.ready = ready;
        m.el.classList.toggle('ready', ready);
        m.state.textContent = ready ? 'READY' : '';
      }
      // The button guide follows the device in use (keyboard or a controller).
      const k = this.keys(m.seat);
      const sig = `${k.smash}|${k.item}`;
      if (sig !== m.keySig) {
        m.keySig = sig;
        m.smashKey.innerHTML = kbd(k.smash);
        m.itemKey = '-'; // rebuild the item line with the new button
      }
      const itemKey = p.alive ? (p.item ?? '') : 'out';
      if (itemKey !== m.itemKey) {
        m.itemKey = itemKey;
        if (!p.alive) {
          m.item.className = 'mi';
          m.item.textContent = 'You are out. Watch the others finish.';
        } else if (p.item) {
          const info = CRATE_INFO[p.item];
          m.item.className = 'mi has';
          m.item.style.setProperty('--ic', info.css);
          m.item.innerHTML = `<img class="mic" src="${itemIconURL(p.item)}" alt="">${kbd(k.item)}<b>${info.label}</b><span>${info.help}</span>`;
        } else {
          m.item.className = 'mi';
          m.item.innerHTML = `${kbd(k.item)}<span>No item: hit a crate with your ball</span>`;
        }
      }
    }
  }

  private tagsFor(sim: Sim, p: PlayerState): { label: string; css: string; icon?: string }[] {
    const t: { label: string; css: string; icon?: string }[] = [];
    if (!p.alive) return t; // the greyed-out row says it already
    if (p.item) t.push({ label: CRATE_INFO[p.item].label, css: CRATE_INFO[p.item].css, icon: itemIconURL(p.item) });
    if (sim.isLastStand(p)) t.push({ label: 'LAST STAND', css: '#ff4d6a' });
    if (p.fx.shield > 0) t.push({ label: 'SHIELD', css: CRATE_INFO.shield.css });
    if (p.fx.big > 0) t.push({ label: 'BIG', css: CRATE_INFO.big.css });
    if (p.fx.chill > 0) t.push({ label: 'FROZEN', css: CRATE_INFO.freeze.css });
    if (p.fx.split > 0) t.push({ label: 'SPLIT', css: CRATE_INFO.split.css });
    return t;
  }

  private bump(el: HTMLElement): void {
    el.classList.remove('hit');
    void el.offsetWidth;
    el.classList.add('hit');
  }

  /** A short label that rises and fades where something happened (screen coordinates). */
  popup(text: string, css: string, x: number, y: number, big = false): void {
    const el = document.createElement('div');
    el.className = `pop${big ? ' big' : ''}`;
    el.style.setProperty('--c', css);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.textContent = text;
    this.pops.appendChild(el);
    while (this.pops.children.length > 8) this.pops.firstElementChild?.remove();
    setTimeout(() => el.remove(), 1300);
  }

  /** Only for rare system messages (controllers, connections), not for game events. */
  toast(html: string, css: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.setProperty('--c', css);
    el.innerHTML = html;
    this.toastsEl.appendChild(el);
    while (this.toastsEl.children.length > 2) this.toastsEl.firstElementChild?.remove();
    setTimeout(() => el.remove(), 2600);
  }

  countdown(text: string): void {
    this.countEl.textContent = text;
    this.countEl.classList.remove('pop');
    void this.countEl.offsetWidth;
    this.countEl.classList.add('pop');
  }
}
