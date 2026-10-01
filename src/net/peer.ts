import { decodeSignal, encodeSignal } from './codec';

/**
 * One WebRTC connection between two browsers, with two data channels:
 *  - "fast": unordered, no retransmits. Snapshots and inputs; a lost packet is replaced by the next one.
 *  - "ctrl": reliable and ordered. Lobby messages and game events (goals, sounds, results).
 *
 * Signalling is manual: the host's offer and the guest's answer are exchanged as text codes, so no
 * signalling server is needed. Public STUN servers only help each side discover its public address;
 * game data never goes through them.
 */

export type Channel = 'fast' | 'ctrl';

/** Public STUN servers. `?ice=none` in the URL disables them (same network / tests). */
export function iceServers(): RTCIceServer[] {
  if (new URLSearchParams(location.search).get('ice') === 'none') return [];
  return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
}

const GATHER_TIMEOUT = 4000;

export class PeerLink {
  readonly pc: RTCPeerConnection;
  private fast: RTCDataChannel | null = null;
  private ctrl: RTCDataChannel | null = null;
  private opened = false;
  private closed = false;
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  onMessage: (ch: Channel, msg: unknown) => void = () => {};

  private constructor() {
    this.pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.handleClose();
    });
    this.pc.addEventListener('datachannel', (e) => this.attach(e.channel));
  }

  /** Host side: creates the channels and returns the invite code to send to a friend. */
  static async host(): Promise<{ link: PeerLink; code: string }> {
    const link = new PeerLink();
    link.attach(link.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
    link.attach(link.pc.createDataChannel('ctrl', { ordered: true }));
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await link.gathered();
    return { link, code: await encodeSignal({ type: 'offer', sdp: link.pc.localDescription!.sdp }) };
  }

  /** Guest side: takes the host's invite code and returns the reply code to send back. */
  static async join(inviteCode: string): Promise<{ link: PeerLink; code: string }> {
    const offer = await decodeSignal(inviteCode, 'offer');
    const link = new PeerLink();
    await link.pc.setRemoteDescription(offer);
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    await link.gathered();
    return { link, code: await encodeSignal({ type: 'answer', sdp: link.pc.localDescription!.sdp }) };
  }

  /** Host side: finishes the connection with the guest's reply code. */
  async accept(replyCode: string): Promise<void> {
    const answer = await decodeSignal(replyCode, 'answer');
    await this.pc.setRemoteDescription(answer);
  }

  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  send(ch: Channel, msg: unknown): void {
    const c = ch === 'fast' ? this.fast : this.ctrl;
    if (!c || c.readyState !== 'open') return;
    try {
      c.send(JSON.stringify(msg));
    } catch {
      /* buffer full or closing: drop it, the next one follows */
    }
  }

  close(): void {
    try {
      this.ctrl?.close();
      this.fast?.close();
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.handleClose();
  }

  /** Waits until all ICE candidates are in the description (no trickle: we only exchange one code each way). */
  private gathered(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') done();
      };
      this.pc.addEventListener('icegatheringstatechange', check);
      setTimeout(done, GATHER_TIMEOUT); // use whatever was found so far
    });
  }

  private attach(c: RTCDataChannel): void {
    if (c.label === 'fast') this.fast = c;
    else this.ctrl = c;
    c.addEventListener('open', () => {
      if (!this.opened && this.fast?.readyState === 'open' && this.ctrl?.readyState === 'open') {
        this.opened = true;
        this.onOpen();
      }
    });
    c.addEventListener('close', () => this.handleClose());
    c.addEventListener('message', (e) => {
      try {
        this.onMessage(c.label as Channel, JSON.parse(e.data as string));
      } catch {
        /* ignore malformed messages */
      }
    });
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}
