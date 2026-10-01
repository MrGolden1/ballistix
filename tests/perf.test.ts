import { it } from 'vitest';
import { Bot } from '../src/ballistix/bot';
import { Sim } from '../src/ballistix/sim';
import { mulberry32 } from '../src/core/rng';

// Not a pass/fail test: prints how expensive one simulation step is (the game needs 120 per second).
it('measures the cost of a simulation step', () => {
  const sim = new Sim({ humans: 0, difficulty: 'hard', lives: 99, crates: true, seed: 4 });
  const rng = mulberry32(2);
  const bots = [0, 1, 2, 3].map((s) => new Bot(s, 'hard', rng));
  const DT = 1 / 120;
  for (const p of sim.players) p.fx.shield = 1e9; // keep the arena full of balls
  const steps = 120 * 120;
  let maxBalls = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    for (const b of bots) sim.players[b.seat].axis = b.update(sim, DT);
    sim.step(DT);
    maxBalls = Math.max(maxBalls, sim.balls.length);
  }
  const ms = performance.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`PERF ${steps} steps in ${ms.toFixed(0)} ms -> ${((ms / steps) * 1000).toFixed(1)} us/step, ${((ms / steps) * 120).toFixed(2)} ms per game second, up to ${maxBalls} balls`);
});
