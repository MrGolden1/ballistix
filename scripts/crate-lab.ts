/**
 * Item-help lab: simulated matches with a "human" in seat 0 (a bot with human-like skill) against bots,
 * with item help off and on. Prints how many crates the human gets compared with a fair share.
 *
 *   npm run lab:crates                 # all difficulties, 400 matches per row (a few minutes)
 *   N=1500 D=normal npm run lab:crates # more matches, one difficulty
 *
 * FAIR = (human crates / human fair share) / (bot crates / bot fair share), where a fair share is an equal
 * split of every crate collected while that player was alive. 1.00 = same as a bot. The help targets
 * CRATE_HELP[difficulty].target. The "human" models do not aim at crates, so real players who do aim get more.
 */
import { Bot } from '../src/ballistix/bot';
import { CRATE_HELP, type CrateHelp, type Difficulty } from '../src/ballistix/config';
import { Sim } from '../src/ballistix/sim';
import { mulberry32 } from '../src/core/rng';

declare const process: { env: Record<string, string | undefined> }; // run by vite-node (no @types/node here)

/** Human-like skill levels, in the bot profile format (see PROFILES in bot.ts). */
const HUMANS = {
  beginner: { react: 0.3, speed: 0.7, error: 1.4, aim: 0.3, smash: 0.25, timing: 0.06, itemSense: 0.3 },
  average: { react: 0.22, speed: 0.8, error: 1.0, aim: 0.4, smash: 0.4, timing: 0.04, itemSense: 0.6 },
  skilled: { react: 0.15, speed: 0.9, error: 0.6, aim: 0.6, smash: 0.6, timing: 0.025, itemSense: 0.9 },
};
type Skill = keyof typeof HUMANS;
const OFF: CrateHelp = { reach: 0, target: 1, pull: 0 };
const DT = 1 / 120;

interface Totals {
  crates: number[];
  fair: number[];
  wins: number;
}

function play(diff: Difficulty, skill: Skill, seed: number, t: Totals): void {
  const sim = new Sim({ humans: 1, players: 4, difficulty: diff, lives: 5, crates: true, seed });
  const rng = mulberry32(seed * 7 + 1);
  const bots = [0, 1, 2, 3].map((s) => new Bot(s, diff, rng));
  (bots[0] as unknown as { profile: unknown }).profile = HUMANS[skill];
  while (sim.phase !== 'over' && sim.time < 900) {
    for (const b of bots) sim.players[b.seat].axis = b.update(sim, DT);
    sim.step(DT);
    for (const e of sim.events) {
      if (e.t !== 'pickup') continue;
      t.crates[e.seat]++;
      const alive = sim.players.filter((p) => p.alive);
      for (const p of alive) t.fair[p.seat] += 1 / alive.length;
    }
  }
  if (sim.winner === 0) t.wins++;
}

function run(diff: Difficulty, skill: Skill, help: CrateHelp, n: number) {
  const saved = CRATE_HELP[diff];
  CRATE_HELP[diff] = help;
  const t: Totals = { crates: [0, 0, 0, 0], fair: [0, 0, 0, 0], wins: 0 };
  for (let i = 0; i < n; i++) play(diff, skill, 90000 + i, t);
  CRATE_HELP[diff] = saved;
  const bots = (a: number[]) => a[1] + a[2] + a[3];
  return {
    fair: t.crates[0] / t.fair[0] / (bots(t.crates) / bots(t.fair)),
    human: t.crates[0] / n,
    bot: bots(t.crates) / n / 3,
    win: (100 * t.wins) / n,
  };
}

const N = Number(process.env.N ?? 400);
const diffs = (process.env.D ?? 'easy,normal,hard').split(',') as Difficulty[];
console.log(`${N} matches per row; 4 players, 1 human, 5 lives. FAIR 1.00 = a bot's share.\n`);
console.log('difficulty  human     target | FAIR off -> on | crates/match human (bot) off -> on | human wins off -> on');
for (const d of diffs) {
  for (const skill of Object.keys(HUMANS) as Skill[]) {
    const off = run(d, skill, OFF, N);
    const on = run(d, skill, CRATE_HELP[d], N);
    console.log(
      `${d.padEnd(11)} ${skill.padEnd(9)} ${CRATE_HELP[d].target.toFixed(2).padStart(6)} |` +
        ` ${off.fair.toFixed(2)} -> ${on.fair.toFixed(2)}   |` +
        ` ${off.human.toFixed(2)} (${off.bot.toFixed(2)}) -> ${on.human.toFixed(2)} (${on.bot.toFixed(2)})          |` +
        ` ${off.win.toFixed(1)}% -> ${on.win.toFixed(1)}%`,
    );
  }
}
