import { PeerLink, type Channel, type Reach } from './peer';
import { cleanName } from '../core/names';
import type { GuestMsg, HostMsg } from './protocol';

/** Seats given to guests in join order: opposite the host first, then the sides. */
const GUEST_SEATS = [2, 1, 3];

export interface RemotePlayer {
  link: PeerLink;
  seat: number;
  name: string;
}

/** The host keeps one connection per guest and runs the real game. */
export class OnlineHost {
  readonly role = 'host' as const;
  guests: RemotePlayer[] = [];
  /** The host's own player name ('' = default). */
  name = '';
  private pending: PeerLink | null = null;
  onChange: () => void = () => {};
  onGuestLeft: (seat: number) => void = () => {};
  onGuestMsg: (seat: number, msg: GuestMsg) => void = () => {};

  get full(): boolean {
    return this.guests.length >= GUEST_SEATS.length;
  }

  /** Human seats in the room (the host is always seat 0). */
  seats(): number[] {
    return [0, ...this.guests.map((g) => g.seat).sort()];
  }

  setName(name: string): void {
    this.name = name;
    this.broadcastLobby();
    this.onChange();
  }

  /** Player names by seat ('' = the seat's default name). */
  names(): string[] {
    const out = ['', '', '', ''];
    out[0] = this.name;
    for (const g of this.guests) out[g.seat] = g.name;
    return out;
  }

  /** Creates an invite code for one more player (and says whether friends on other networks can use it). */
  async invite(): Promise<{ code: string; reach: Reach }> {
    if (this.full) throw new Error('The room is full (4 players).');
    this.pending?.close();
    const { link, code, reach } = await PeerLink.host();
    this.pending = link;
    link.onOpen = () => {
      const seat = GUEST_SEATS.find((s) => !this.guests.some((g) => g.seat === s));
      if (seat === undefined) {
        link.close();
        return;
      }
      if (this.pending === link) this.pending = null;
      const guest: RemotePlayer = { link, seat, name: '' };
      this.guests.push(guest);
      link.onClose = () => {
        this.guests = this.guests.filter((g) => g !== guest);
        this.onGuestLeft(seat);
        this.broadcastLobby();
        this.onChange();
      };
      link.onMessage = (ch: Channel, msg) => {
        void ch;
        const m = msg as GuestMsg;
        if (m.k === 'hello') {
          guest.name = cleanName(m.name);
          this.broadcastLobby();
          this.onChange();
          return;
        }
        this.onGuestMsg(seat, m);
      };
      link.send('ctrl', { k: 'welcome', seat } satisfies HostMsg);
      this.broadcastLobby();
      this.onChange();
    };
    return { code, reach };
  }

  /** Completes the pending invite with the guest's reply code. */
  async accept(reply: string): Promise<void> {
    if (!this.pending) throw new Error('Create an invite code first.');
    await this.pending.accept(reply);
  }

  sendTo(seat: number, ch: Channel, msg: HostMsg): void {
    this.guests.find((g) => g.seat === seat)?.link.send(ch, msg);
  }

  broadcast(ch: Channel, msg: HostMsg): void {
    for (const g of this.guests) g.link.send(ch, msg);
  }

  private broadcastLobby(): void {
    this.broadcast('ctrl', { k: 'lobby', seats: this.seats(), names: this.names() });
  }

  close(): void {
    this.pending?.close();
    this.pending = null;
    for (const g of this.guests) {
      g.link.onClose = () => {};
      g.link.close();
    }
    this.guests = [];
  }
}

/** A guest has one connection, to the host. */
export class OnlineGuest {
  readonly role = 'guest' as const;
  seat = -1;
  seats: number[] = [];
  names: string[] = [];
  /** This player's own name, sent to the host (again whenever it changes). */
  name = '';
  onMsg: (msg: HostMsg) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  private constructor(readonly link: PeerLink) {
    link.onMessage = (_ch, msg) => {
      const m = msg as HostMsg;
      if (m.k === 'welcome') {
        this.seat = m.seat;
        // The welcome only comes once the host is fully set up: the one moment the name is certain to arrive.
        this.sendName();
      }
      if (m.k === 'lobby') {
        this.seats = m.seats;
        this.names = (m.names ?? []).map(cleanName);
      }
      this.onMsg(m);
    };
    link.onOpen = () => this.onOpen();
    link.onClose = () => this.onClose();
  }

  /** Takes the host's invite code; returns the guest and the reply code to send back. */
  static async join(invite: string): Promise<{ guest: OnlineGuest; reply: string; reach: Reach }> {
    const { link, code, reach } = await PeerLink.join(invite);
    return { guest: new OnlineGuest(link), reply: code, reach };
  }

  send(ch: Channel, msg: GuestMsg): void {
    this.link.send(ch, msg);
  }

  sendName(): void {
    this.send('ctrl', { k: 'hello', name: this.name });
  }

  setName(name: string): void {
    this.name = name;
    if (this.link.isOpen) this.sendName();
  }

  close(): void {
    this.link.onClose = () => {};
    this.link.close();
  }
}

export type Session = OnlineHost | OnlineGuest;
