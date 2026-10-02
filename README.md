# Ballistix

A 3D four-player arena game for the browser, inspired by the *Ballistix* minigame in Crash Bash.
Each player defends one goal. Balls fly around the arena; every goal you concede costs a life,
and the last player standing wins. Built with **Three.js + TypeScript + Vite**. All art and
sound are generated in code, so there are no asset files.

> Fan project. It uses original characters, art and sound and no assets from the original game.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/ (static files, host anywhere)
npm run build:single  # one self-contained dist-single/index.html (send it to a friend, open in Chrome/Edge)
npm run preview    # serve the production build
npm test           # unit tests (rules, collisions, bots)
```

## Controls

| | Keyboard | PlayStation pad | Xbox pad |
|---|---|---|---|
| Move | `A` `D` or `←` `→` | left stick / D-pad | left stick / D-pad |
| Smash | `Space`, `W` or `↑` | ✕ or R2 | A or RT |
| Use item | `Shift`, `E`, `S` or `↓` | □, △, ○, L1 or R1 | X, Y, B, LB or RB |
| Pause / resume | `P` or `Esc` | OPTIONS | MENU |
| Menus | arrow keys + `Enter` | D-pad / stick + ✕, ○ back | D-pad / stick + A, B back |
| Music / sound | `M` / `N` (also in the menu and pause screen) | | |

Two players on one keyboard: P1 (bottom) `A` `D` move, `W` smash, `S` item; P2 (top) `←` `→` move,
`↑` smash, `↓` item.

Every screen (menu, pause, results) works with a controller or the arrow keys: up/down picks a row,
left/right changes an option, ✕ / Enter confirms. The pause screen has Music, Sound and Vibration switches.

## Controllers (PS4 / Xbox / generic)

Use **Chrome or Edge**. Connect the controller over USB or Bluetooth and press any button. No driver
or DS4Windows is needed: the browser reports a DualShock 4 in the standard layout.

- **Join by pressing a button.** The first controller to press a button becomes P1 and the next becomes P2,
  whatever order they were plugged in. Choose "2 Players" in the menu so the second controller can join.
  The menu shows which controller is on which seat.
- **Vibration:** hits, smashes, items, goals and eliminations rumble the controller of the player they happen to
  (toggle it in the menu or the pause screen).
- **Disconnects:** if a player's controller drops out mid-match the game pauses and says so.
- **DS4Windows:** it also works. DS4Windows turns every DS4 into a virtual Xbox 360 pad; if the real DS4 stays
  visible the browser would see each controller twice, so the game detects that and hides the real entries
  (the menu tells you when it does). Turning on "Hide DS4 Controller" in DS4Windows has the same effect.
  If you mix one real Xbox pad with one real DS4 the DS4 is hidden by mistake; that mix is not supported.
- **Button guides follow the device you use.** Touch the controller and every hint (menu, pause, results, your panel) shows its buttons; press a key and they switch back to the keyboard. PlayStation pads show ✕ ○ □ △ (in their colours), Xbox pads A B X Y, Nintendo pads their own labels (confirm = B).
- **Bluetooth:** works the same as USB in Chrome/Edge (pair it in Windows Bluetooth settings first:
  hold SHARE + PS until the light bar flashes). Expect slightly more input delay than a cable.

## Online play (no game server)

Ballistix connects browsers directly to each other with WebRTC. There is no game server and no
account: you swap two codes once, then the game data goes straight between your computers.

**Getting the game to your friends.** Run `npm run build:single` and send them
`dist-single/index.html` (about 0.7 MB). They open it in Chrome or Edge, straight from their
downloads folder: no install, no server. (Or put `dist/` on any free static host.)

**Connecting (up to 4 players):**
1. Host: *Play online* → *Host a room*. An invite code appears; copy it and send it (WhatsApp, Telegram...).
2. Friend: *Play online* → *Join a room* → paste the invite → *Create reply code*; send the reply back.
3. Host: paste the reply → *Connect*. Repeat for more friends (one invite per friend), then *Start online match*.

Bots fill the empty seats up to the menu's *Players in the match* (friends always get a seat), and the host's menu settings (bot skill, crates, lives) are used. **Everyone can type a name** on the *Play online* screen; it is shown on the scoreboard, in pop-ups and in the results. Names are cleaned on arrival (no markup, control or hidden characters, 14 characters at most) and are always shown as plain text. Every
player sees their own goal at the bottom of the screen, with "right" meaning right on their screen.
Pause is shared: anyone can pause and resume for everyone. If a friend leaves, a bot takes over their seat.

**How it works.** The host runs the real game. Each guest moves its own paddle locally (so it reacts
instantly) and sends its position and button presses; the host sends a compact snapshot of the
arena every frame plus the game events (sounds, effects, scores). Snapshots use an unordered,
no-retransmit channel (a lost one is simply replaced by the next); events use a reliable channel.

**Lag compensation.** Guests measure the round trip to the host (shown bottom-right as *Ping*) and draw
the balls half a round trip ahead, so they see roughly where the balls are on the host right now; the
host likewise moves each guest's paddle on by half a round trip. Between snapshots guests keep the
balls moving at their current velocity. Bandwidth is small: a snapshot is about 1 KB, ~60 per second.

| Ping (round trip) | How it plays |
|---|---|
| under 50 ms | like local play |
| 50-100 ms | good; fast smashes need a little anticipation |
| 100-150 ms | playable, you will notice it on fast balls |
| over 150 ms | hard; the ball can be ~1 unit away from where you see it |

**Limits, honestly:**
- To find each other across the internet the browsers ask a public **STUN** server (Google /
  Cloudflare) for their public address. That is a tiny lookup; no game data goes through it.
  **The lobby tells you whether it worked:** after creating an invite or reply code it says either
  "Your public address was found, so friends on other networks can connect" or "No public address was
  found (this network may block the lookup), so only players on the same network can connect".
  If you see the second message, internet play from that network will not work (see the next point).
  Some managed or corporate networks and firewalls block this lookup (UDP to ports 19302 / 3478).
- On the same Wi-Fi it always works. Across the internet it works on most home connections, but
  some networks (strict / symmetric NAT, many mobile hotspots, carrier-grade NAT) cannot be
  connected directly. Those would need a relay (TURN) server, which this game does not use. If
  "Connect" never finishes, try another network (e.g. one player on home Wi-Fi instead of mobile data).
- If you want guaranteed connections, even through strict NATs, the missing piece is a relay (TURN) server,
  for example `coturn` in Docker on a machine with a public address. The game is built so that adding one is a
  small change (a list of ICE servers in `src/net/peer.ts`).
- The guest's paddle is trusted by the host. Fine between friends, not cheat-proof.
- Latency matters like in any online game; within the same country it plays well.

## HUD

- **Lives above every goal:** a big number in the goal's colour; it jumps when that player concedes and disappears when they are eliminated (the goal is sealed by the force field).
- **Scoreboard:** one row per player (lives as a number + bar, active effects such as SHIELD, FROZEN, LAST STAND, and the item they hold). On wide screens it sits in the left gutter, otherwise in a strip at the top. You are listed first.
- **Who holds what:** a player who holds an item has its icon floating above their character, a coloured chip with the icon on the scoreboard, and (for you) the item in your panel with its button. When someone collects a crate, its icon flies to them.
- **Your panel:** smash readiness and your item with the button that uses it (one panel per local player).
- Game events (pickups, extra balls, goals) appear as short labels where they happen instead of pop-up messages; only rare system messages (controllers, connections) use a message.

## Game rules

- 2 to 4 players (menu: *Players in the match*, humans plus bots). Four seats: bottom, right, top, left. Bots fill the seats nobody plays, opposite you first. In a 2 or 3 player match the unused sides are closed with a solid wall, and only the players in the match get a scoreboard card.
- Everyone starts with 3, 5 or 10 lives. A ball that gets into your goal costs one life.
  At 0 lives you are out and an electric force field seals your goal (balls bounce off it with a zap). The last player standing wins.
- **Paddles are curved and have momentum.** Where the ball hits the paddle decides where it goes (centre
  = straight back, edges = sharp angles). Let go of the stick and the paddle drifts to a stop; push the
  other way to stop quickly.

### Physics notes

- Fixed 120 Hz steps; balls never tunnel through walls even at top speed (tested).
- Walls and posts reflect with angle in = angle out and keep the speed. Every ball always moves at
  exactly its base speed plus its smash boost (tested on long random matches).
- Paddle hits are deliberately "arcade": the hit position on the curved paddle decides the direction
  (mirror-symmetric, tested), plus a little of the paddle's own motion. That gives players control
  instead of depending on the incoming angle.
- There is no spin or curve: between bounces every ball flies in a perfectly straight line, so shots
  are predictable (tested). Only paddles and walls change a ball's direction.

### Several balls

Every ball is checked against every paddle each step, so a paddle can return two balls at once.
A smash swing lasts 0.2 s and smashes **every** ball that reaches it during that time (tested), not
just the first one.

### Smash

Press smash as a ball comes close: the swing reaches about 1.7 units in front of your paddle, so the ball
does not have to touch it. A smashed ball flies much faster and at a sharper angle, in a straight line like every other ball.
Cooldown 0.9 s.

### How many balls?

A "ball director" decides. It starts with 2 balls. Every 9 seconds without a goal it adds one more
("Too quiet... +1 BALL!"), after 75 s of play it keeps one extra in rotation, and a goal resets the pressure.
The cap depends on who is left: 5 balls with 4 players, 4 with 3, 3 with 2. Serves are spaced out so two
balls never pop out at once.

### Goals, eliminations and the winner

- An eliminated player's goal is sealed by a cold electric-blue force field (a shield uses the same field
  in the owner's colour, so a closed goal always reads as closed). Balls that hit it give a soft pulse.
- When the match ends the camera moves in front of the winner's goal, the scene dims, a spotlight lands on the
  winner (who hops) and confetti falls around them. On wide screens the results panel sits on the left so
  the winner stays clear.
- Goal lines and lives labels carry each player's colour; the floor itself is not tinted.

### Items guide

*Items & how to play* (main menu and pause screen) shows a looping animation for every item and for smash and grabbing crates.

### Item crates

Crates show what is inside. **Only a ball you hit yourself can collect one**: a ball stops being yours when
it touches another ball, or after 5 seconds. The ball's colour shows who owns it, so what you see is what
can collect. Aim your own shots at the crate you want. You hold one item at a time (a new one replaces it) and use it when you choose:

| Item | Effect |
|---|---|
| Shield | an energy field in your colour seals your goal for 6 s (save it for a ball you cannot reach). A bright strip burns down with the time left, and the field flickers in the last 1.5 s |
| Big Paddle | paddle 60% longer for 10 s |
| Freeze | everyone else moves at less than half speed for 4 s: their paddles get an ice shell with drifting frost, their characters shiver, and a freeze wave runs across the field |
| Split Shot | your next hit splits into 3 balls. While it is armed your paddle smoulders: soft flames lick up in front of it (dim on purpose, the paddle keeps its colour) |
| Extra Life | instant +1 life (or a short shield if you are at full lives) |

Extra Life crates are rare unless somebody has already lost a life.

### Comeback: Last Stand

On your last life your paddle is 20% longer and smash recharges 50% faster.

## Performance

- The whole game simulation costs about 10 microseconds per step (120 steps per second, 4 players,
  7 balls): roughly 1 ms of CPU per second of play. `npm test` prints this measurement.
- The hot collision code does not allocate memory, so there are no garbage-collection hiccups.
- Particles cost nothing when none are alive.
- **No mid-match shader compiles.** three.js compiles a shader the first time something is drawn, which
  shows up as a stutter. The game builds everything that can appear mid-match (force fields, ice shells,
  item badges, crates, balls, the winner spotlight) once at start-up, in the same render target the game
  draws into. Measured in the browser: the previous version compiled 6 shaders during a shield, freeze
  and elimination; now 0.
- Elimination effects are deliberately light (a modest particle burst, short slow motion, one sound
  instead of two stacked ones).
- **Graphics ladder.** Measured on an integrated GPU (Intel UHD, 1080p) the scene itself costs about 1 ms
  per frame; almost everything else was post-processing: 4x MSAA on a half-float target ~10 ms, full
  resolution bloom ~7 ms, the 2048 shadow map ~2 ms. So the game has quality levels that trade exactly
  those, in this order: **High** (MSAA 4x, full bloom, 2048 shadows) → **Medium** (FXAA, half-resolution
  bloom, 1024 shadows; looks the same to the eye) → **Reduced** (smaller bloom) → **Minimal** (no bloom),
  and only then does the resolution drop (down to 60%). On that Intel GPU: High 16 ms, Medium 8 ms,
  Minimal 5.5 ms per frame; on an RTX 4070 laptop GPU every level is 5-6 ms.
  *Graphics: Auto* (menu, bottom) picks the starting level from the GPU's name (integrated GPUs start on
  Medium), steps down when frames stay slower than ~52 fps for 1.5 s, steps the resolution back up when
  there is plenty of room, and remembers the result for next time. The menu shows which GPU the browser
  is really using. You can also force High, Medium or Low.
- **Fewer draw calls.** The arena's static pieces (walls, pillars, trims) and each character's parts are
  merged by material at start-up: 256 draw calls and 102 shadow casters per frame became 120 and 42, with
  identical triangles. That is what limits slower CPUs.
- **Laptops with two GPUs.** Windows often runs the browser on the weak integrated GPU. If the game
  feels slow, open *Settings → System → Display → Graphics*, add Edge or Chrome, and choose *High performance*.
- Effect rings are recycled instead of creating a material each time.
- No smash freeze: the earlier 70 ms hit-stop read as lag, so it is off (`SMASH_HITSTOP` in `config.ts`).
  Camera shake is a smooth wobble rather than a random jump every frame, which also looked like stutter.

## Architecture

```
src/
  main.ts                 app loop: fixed 120 Hz sim, input, event routing
  style.css               menu / HUD / results styling
  core/
    rng.ts                seeded PRNG
    input.ts              keyboard, merged with the gamepad manager
    gamepad.ts            layouts, join-by-press, DS4Windows de-duplication, menu nav, rumble
    audio.ts              Web Audio synth: SFX + music loop
    names.ts              player-name cleaning and HTML escaping (names arrive over the network)
  ballistix/
    config.ts             arena geometry, tuning constants, shared types, seats in play
    sim.ts                pure game rules (no DOM, no three.js)  <- unit tested
    bot.ts                bot AI (interception prediction, per-shot error, difficulty)
    view.ts               three.js scene, characters, effects, camera, bloom
    particles.ts          GPU point-sprite particles
    hud.ts, ui.ts         DOM overlays
tests/sim.test.ts         drift, curved paddle, smash reach, straight paths, ball director, items, last stand, bot matches
tests/players.test.ts     2/3 player matches (closed sides, bots, serves), seat filling, player-name cleaning
tests/net.test.ts         invite/reply codes (round trip, chat-app mangling, wrong code messages), reach, snapshots
tests/gamepad.test.ts     layouts, duplicate filtering, seats, actions, disconnects, menu repeat, rumble
```

The simulation is deterministic for a given seed and knows nothing about rendering. Inputs are just
`axis`, `smashReq` and `itemReq` on each player, so a human, a bot or (later) a network peer all drive it
the same way. It emits events (`paddle`, `smash`, `goal`, `pickup`, ...) that the view, HUD and audio
react to. That keeps the rules testable and makes adding more minigames a matter of writing another `sim` + `view` pair.

## Tuning

Game feel lives in `src/ballistix/config.ts` (goal width, paddle size, speed and drift, smash reach,
ball director, item durations)
and `PROFILES` in `src/ballistix/bot.ts` (bot reaction time, error, speed). `npm test` prints the
average length of bot-vs-bot matches per difficulty, which is a quick way to check balance after
changing numbers.
