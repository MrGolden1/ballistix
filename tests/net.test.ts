import { describe, expect, it } from 'vitest';
import { decodeSignal, encodeSignal } from '../src/net/codec';
import { reachOf, reachableFromInternet } from '../src/net/peer';
import { applySnapshot, encodeSnapshot } from '../src/net/protocol';
import { Sim } from '../src/ballistix/sim';

const SDP_LOCAL_ONLY = [
  'v=0',
  'a=candidate:1 1 udp 2113937151 3f2b1c9e-aaaa-bbbb-cccc-0123456789ab.local 54321 typ host generation 0',
  'a=candidate:2 1 udp 2113937151 192.168.1.20 54322 typ host generation 0',
  'a=end-of-candidates',
].join('\r\n');

const SDP_WITH_STUN = SDP_LOCAL_ONLY + '\r\na=candidate:3 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0';

describe('connection reach', () => {
  it('counts local, public and relay candidates', () => {
    expect(reachOf(SDP_LOCAL_ONLY)).toEqual({ local: 2, publicAddr: 0, relay: 0 });
    expect(reachOf(SDP_WITH_STUN)).toEqual({ local: 2, publicAddr: 1, relay: 0 });
    expect(reachOf(SDP_WITH_STUN + '\r\na=candidate:4 1 udp 41885439 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0')).toEqual({ local: 2, publicAddr: 1, relay: 1 });
  });

  it('only a public or relay address makes internet play possible', () => {
    expect(reachableFromInternet(reachOf(SDP_LOCAL_ONLY))).toBe(false);
    expect(reachableFromInternet(reachOf(SDP_WITH_STUN))).toBe(true);
    expect(reachableFromInternet({ local: 0, publicAddr: 0, relay: 1 })).toBe(true);
    expect(reachableFromInternet(reachOf(''))).toBe(false);
  });
});

describe('invite and reply codes', () => {
  it('round-trips a description through the text code', async () => {
    const sdp = SDP_WITH_STUN + '\r\na=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'AB\r\n';
    const code = await encodeSignal({ type: 'offer', sdp });
    expect(code.startsWith('BX1.')).toBe(true);
    expect(code).toMatch(/^BX1\.[A-Za-z0-9_-]+$/); // safe to paste into any chat app
    const back = await decodeSignal(code, 'offer');
    expect(back.type).toBe('offer');
    expect(back.sdp).toBe(sdp);
  });

  it('survives whitespace added by a chat app (line breaks, spaces)', async () => {
    const code = await encodeSignal({ type: 'answer', sdp: SDP_LOCAL_ONLY });
    const mangled = code.replace(/(.{40})/g, '$1\n  ');
    expect((await decodeSignal(mangled, 'answer')).sdp).toBe(SDP_LOCAL_ONLY);
  });

  it('refuses the wrong kind of code, random text and cut-off codes with clear messages', async () => {
    const offer = await encodeSignal({ type: 'offer', sdp: SDP_LOCAL_ONLY });
    const answer = await encodeSignal({ type: 'answer', sdp: SDP_LOCAL_ONLY });
    await expect(decodeSignal(offer, 'answer')).rejects.toThrow(/invite code/);
    await expect(decodeSignal(answer, 'offer')).rejects.toThrow(/reply code/);
    await expect(decodeSignal('hello there', 'offer')).rejects.toThrow(/not a Ballistix code/);
    await expect(decodeSignal(offer.slice(0, offer.length - 25), 'offer')).rejects.toThrow(/incomplete|damaged/);
    await expect(decodeSignal('BX1.!!!notbase64!!!', 'offer')).rejects.toThrow();
  });
});

describe('snapshots', () => {
  it('copy the world to a mirror sim, including which seats are in play and who owns a ball', () => {
    const cfg = { humans: 1 as const, difficulty: 'normal' as const, lives: 4, crates: true, seed: 3, players: 3, seats: [0, 2] };
    const host = new Sim(cfg);
    while (host.phase === 'countdown') host.step(1 / 120);
    for (let i = 0; i < 6000 && host.balls.length === 0; i++) host.step(1 / 120);
    expect(host.balls.length).toBeGreaterThan(0);
    host.balls[0].owner = 2;
    host.balls[0].last = 2;
    const mirror = new Sim(cfg);
    applySnapshot(mirror, JSON.parse(JSON.stringify(encodeSnapshot(host, false))), 0);
    expect(mirror.phase).toBe(host.phase);
    expect(mirror.balls.length).toBe(host.balls.length);
    expect(mirror.balls[0].owner).toBe(2);
    expect(mirror.players.map((p) => p.active)).toEqual([true, true, true, false]);
    expect(mirror.players.map((p) => p.lives)).toEqual(host.players.map((p) => p.lives));
    for (let i = 0; i < host.balls.length; i++) {
      expect(mirror.balls[i].x).toBeCloseTo(host.balls[i].x, 2);
      expect(mirror.balls[i].y).toBeCloseTo(host.balls[i].y, 2);
    }
  });

  it('are small enough for one network packet burst (about a kilobyte)', () => {
    const host = new Sim({ humans: 0, difficulty: 'normal', lives: 5, crates: true, seed: 5 });
    for (let i = 0; i < 120 * 60; i++) host.step(1 / 120);
    const size = JSON.stringify({ k: 'snap', s: encodeSnapshot(host, false) }).length;
    expect(size).toBeLessThan(1800);
  });
});
