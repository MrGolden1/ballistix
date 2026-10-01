import { SEATS } from '../ballistix/config';
import { OnlineGuest, OnlineHost } from './online';

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

  private root = $('online');

  constructor() {
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
      out.value = await this.host.invite();
      this.status('on-hoststatus', 'Copy the invite code and send it to your friend.');
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
    const rows = [0, 2, 1, 3].map((seat) => {
      const taken = seat === 0 || this.host!.guests.some((g) => g.seat === seat);
      const who = seat === 0 ? 'You (host)' : taken ? 'Friend' : 'Bot';
      return `<div class="padrow wide ${taken ? 'ok' : ''}"><b style="color:${SEATS[seat].css}">${SEATS[seat].name}</b><span>${who}</span><em>${taken ? 'connected' : 'open seat'}</em></div>`;
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
      const { guest, reply } = await OnlineGuest.join(code);
      this.guest = guest;
      ($('on-replycode') as HTMLTextAreaElement).value = reply;
      this.status('on-joinstatus', 'Copy the reply code and send it to the host. Waiting for the host to connect...');
      guest.onOpen = () => {
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
