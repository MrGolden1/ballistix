import { SEATS, seatsInPlay } from '../ballistix/config';
import { cleanName, escapeHtml } from '../core/names';
import { OnlineGuest, OnlineHost } from './online';
import { reachableFromInternet, type Reach } from './peer';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function copyText(el: HTMLTextAreaElement): Promise<boolean> {
  if (!el.value) return false;
  try {
    await navigator.clipboard.writeText(el.value);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to the old way.
    el.select();
    return document.execCommand('copy');
  }
}

/** One sentence on whether people on other networks can reach this computer, from the addresses found. */
function reachNote(reach: Reach): string {
  return reachableFromInternet(reach)
    ? 'Your public address was found, so friends on other networks can connect.'
    : 'No public address was found (this network may block the lookup), so only players on the same network can connect. Try another network, such as a phone hotspot, for internet play.';
}

/** The "Play online" screen: host a room or join one by swapping two codes. */
export class Lobby {
  host: OnlineHost | null = null;
  guest: OnlineGuest | null = null;
  /** Host pressed "Start online match". */
  onHostStart: (host: OnlineHost) => void = () => {};
  /** A guest's connection to the host is open. */
  onGuestConnected: (guest: OnlineGuest) => void = () => {};
  /** Back to the main menu. */
  onBack: () => void = () => {};
  /** The 'players in the match' menu setting, and the player's saved name. */
  getPlayers: () => number = () => 4;
  getName: () => string = () => '';
  onName: (name: string) => void = () => {};

  private root = $('online');

  constructor() {
    const nameEl = $('on-name') as HTMLInputElement;
    nameEl.addEventListener('input', () => {
      // Stored as typed-and-cleaned; the box itself is left alone so spaces can be typed.
      const name = cleanName(nameEl.value);
      this.onName(name);
      this.host?.setName(name);
      this.guest?.setName(name);
    });
    nameEl.addEventListener('blur', () => (nameEl.value = cleanName(nameEl.value)));
    $('on-host').addEventListener('click', () => this.startHosting());
    $('on-join').addEventListener('click', () => this.view('join'));
    $('on-back').addEventListener('click', () => this.leave());
    $('on-closeroom').addEventListener('click', () => this.leave());
    $('on-leave').addEventListener('click', () => this.leave());
    $('on-invite').addEventListener('click', () => void this.invite());
    $('on-connect').addEventListener('click', () => void this.connect());
    $('on-makereply').addEventListener('click', () => void this.makeReply());
    $('on-copy-offer').addEventListener('click', () => void this.copy('on-offer', 'on-hoststatus'));
    $('on-copy-reply').addEventListener('click', () => void this.copy('on-replycode', 'on-joinstatus'));
    $('on-start').addEventListener('click', () => {
      if (this.host && this.host.guests.length > 0) this.onHostStart(this.host);
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  show(): void {
    ($('on-name') as HTMLInputElement).value = this.getName();
    this.root.classList.remove('hidden');
    if (!this.host && !this.guest) this.view('choose');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  private view(which: 'choose' | 'host' | 'join'): void {
    $('on-choose').classList.toggle('hidden', which !== 'choose');
    $('on-hostbox').classList.toggle('hidden', which !== 'host');
    $('on-joinbox').classList.toggle('hidden', which !== 'join');
  }

  private status(id: string, text: string, kind: '' | 'ok' | 'err' = ''): void {
    const el = $(id);
    el.textContent = text;
    el.className = `note ${kind}`;
  }

  /** Closes any session and returns to the main menu. */
  leave(): void {
    this.host?.close();
    this.guest?.close();
    this.host = null;
    this.guest = null;
    for (const id of ['on-offer', 'on-answer', 'on-invitecode', 'on-replycode']) ($(id) as HTMLTextAreaElement).value = '';
    this.status('on-hoststatus', '');
    this.status('on-joinstatus', '');
    this.view('choose');
    this.hide();
    this.onBack();
  }

  // --- host ------------------------------------------------------------------------

  private startHosting(): void {
    this.host = new OnlineHost();
    this.host.name = this.getName();
    this.host.onChange = () => this.renderPeers();
    this.view('host');
    this.renderPeers();
    void this.invite();
  }

  private async invite(): Promise<void> {
    if (!this.host) return;
    const out = $('on-offer') as HTMLTextAreaElement;
    out.value = '';
    ($('on-answer') as HTMLTextAreaElement).value = '';
    this.status('on-hoststatus', 'Preparing an invite code...');
    try {
      const { code, reach } = await this.host.invite();
      out.value = code;
      this.status('on-hoststatus', `Copy the invite code and send it to your friend. ${reachNote(reach)}`, reachableFromInternet(reach) ? 'ok' : '');
    } catch (e) {
      this.status('on-hoststatus', (e as Error).message, 'err');
    }
  }

  private async connect(): Promise<void> {
    if (!this.host) return;
    const code = ($('on-answer') as HTMLTextAreaElement).value;
    if (!code.trim()) {
      this.status('on-hoststatus', 'Paste the reply code first.', 'err');
      return;
    }
    try {
      this.status('on-hoststatus', 'Connecting...');
      await this.host.accept(code);
      const before = this.host.guests.length;
      // The data channels open a moment later; renderPeers() reports success.
      setTimeout(() => {
        if (this.host && this.host.guests.length === before) {
          this.status('on-hoststatus', 'Still connecting... if nothing happens in ~15 s, the two networks cannot reach each other directly (see README).');
        }
      }, 6000);
    } catch (e) {
      this.status('on-hoststatus', (e as Error).message, 'err');
    }
  }

  private renderPeers(): void {
    if (!this.host) return;
    // Friends always get a seat; bots fill up to the menu's "players in the match".
    const total = Math.max(2, this.getPlayers(), this.host.seats().length);
    const inPlay = seatsInPlay(this.host.seats(), total);
    const rows = [0, 2, 1, 3]
      .filter((seat) => inPlay.includes(seat))
      .map((seat) => {
        const guest = this.host!.guests.find((g) => g.seat === seat);
        const taken = seat === 0 || !!guest;
        const name = seat === 0 ? this.host!.name : guest?.name ?? '';
        const who = seat === 0 ? `${name || 'You'} (host)` : guest ? name || 'Friend' : 'Bot';
        return `<div class="padrow wide ${taken ? 'ok' : ''}"><b style="color:${SEATS[seat].css}">${escapeHtml(SEATS[seat].name)}</b><span>${escapeHtml(who)}</span><em>${taken ? 'connected' : 'bot'}</em></div>`;
      });
    $('on-peers').innerHTML = rows.join('');
    const n = this.host.guests.length;
    ($('on-start') as HTMLButtonElement).disabled = n === 0;
    if (n > 0) {
      this.status('on-hoststatus', `${n} friend${n === 1 ? '' : 's'} connected. Start the match, or create another invite code.`, 'ok');
      ($('on-offer') as HTMLTextAreaElement).value = '';
      ($('on-answer') as HTMLTextAreaElement).value = '';
    }
  }

  // --- guest -----------------------------------------------------------------------

  private async makeReply(): Promise<void> {
    const code = ($('on-invitecode') as HTMLTextAreaElement).value;
    if (!code.trim()) {
      this.status('on-joinstatus', 'Paste the invite code first.', 'err');
      return;
    }
    try {
      this.guest?.close();
      this.status('on-joinstatus', 'Preparing your reply code...');
      const { guest, reply, reach } = await OnlineGuest.join(code);
      this.guest = guest;
      guest.name = cleanName(($('on-name') as HTMLInputElement).value);
      ($('on-replycode') as HTMLTextAreaElement).value = reply;
      this.status('on-joinstatus', `Copy the reply code and send it to the host. Waiting for the host to connect... ${reachNote(reach)}`, reachableFromInternet(reach) ? 'ok' : '');
      guest.onOpen = () => {
        guest.sendName();
        this.status('on-joinstatus', 'Connected! Waiting for the host to start the match.', 'ok');
        this.onGuestConnected(guest);
      };
      guest.onClose = () => {
        this.status('on-joinstatus', 'The connection to the host was closed.', 'err');
      };
    } catch (e) {
      this.status('on-joinstatus', (e as Error).message, 'err');
    }
  }

  setGuestStatus(text: string): void {
    this.status('on-joinstatus', text, 'ok');
  }

  private async copy(src: string, statusId: string): Promise<void> {
    const ok = await copyText($(src) as HTMLTextAreaElement);
    if (ok) this.status(statusId, 'Copied! Paste it into your chat app.', 'ok');
  }
}
