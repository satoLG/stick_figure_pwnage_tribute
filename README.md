# Stick Figure Pwnage — Tribute

A playable tribute to the early-2000s stick figure fight animations: one stick
figure, ten weapons, and a very destructible black wall.

Everything on screen is drawn from code. There are no sprites, no textures and
no audio files anywhere in this repository — the figure, the weapons, the
explosions, the wall and the soundtrack are all generated at runtime.

**Stack:** Vite + TypeScript, zero runtime dependencies. Deploys to Vercel as a
static site.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle into dist/
npm run preview    # serve the built bundle
```

## Deploying to Vercel

The repo is already configured (`vercel.json`): framework `vite`, build
`npm run build`, output `dist`. Import the repository on Vercel and it deploys
as-is, or:

```bash
npx vercel --prod
```

---

## Controls — desktop

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Run, crouch |
| `Space` | Jump — press again mid-air to somersault; also wall-jumps off the wall |
| Mouse | Aim |
| Left click | Attack (hold for automatic and continuous weapons) |
| Hold `Tab` | Weapon wheel — time slows, pick with the mouse or `1`–`0` |
| `1`–`0` | Quick-swap without opening the wheel |
| Mouse wheel | Cycle weapons |
| `R` / `Esc` | Restart / main menu, on the win screen |

## Controls — touch

Nothing is shown until you touch it, so the picture stays clean.

| Where | Action |
| --- | --- |
| Left side | A floating analog stick appears under your thumb. Its **direction** is the whole control: sideways runs (analog — a half tilt walks), up jumps, down crouches. Drag past the edge and the stick follows your thumb. |
| Right side | Touch to aim; hold to keep attacking, charge, or sustain a beam. |
| Pad at bottom centre | Hold it and the weapons fan out above; slide onto one and lift to equip. |

The wheel is a full ring with a mouse and a **fan above the pad** on touch — a
thumb dragging up from the bottom edge cannot reach the lower half of a ring.

## The arsenal

| # | Weapon | Behaviour |
| --- | --- | --- |
| 1 | Bare hands | Fast alternating punches, small dents |
| 2 | Katana | Sweeping crescent cut with a motion-trail fan |
| 3 | Twin daggers | Very fast alternating stabs, narrow punctures |
| 4 | Sidearm | Semi-auto, crisp holes with a short tunnel |
| 5 | Assault rifle | Full auto; accuracy degrades as it heats up |
| 6 | Shotgun | Eleven pellets in a cone, heavy self-knockback, pump action |
| 7 | Rocket tube | Arcing projectile, 62px crater |
| 8 | Siege cannon | Hold to charge; the biggest crater and a shove backwards |
| 9 | Pyro stream | Hold to melt the wall away gradually |
| 10 | Pwnage beam | Charge, then bore a wide channel clean through |

Win by erasing the wall. The last few scattered slivers are swept
automatically so nobody has to hunt single pixels.

---

## How it works

### Destructible terrain (`src/game/terrain.ts`)

The Worms-style destruction is the heart of the project. The scenery is one
black bitmap held in two representations that are always kept in lockstep:

- a `Uint8Array` mask (1 = solid) used for collision, foot placement and for
  counting how much wall is left;
- an offscreen canvas, which is what actually gets drawn to the screen.

Both are modified through a single primitive, `carvePolygon`, which fills the
*same* polygon into each — a scanline fill into the array, and a
`destination-out` composite into the canvas. Because one shape drives both,
what you see is always exactly what you collide with, and there is never a
readback of pixel data in the hot path.

Everything else is built on that primitive:

- `carveBlob` — a circle whose radius wobbles, for craters and bullet holes
- `carveCapsule` — for sword thrusts, bullet tunnels and the energy beam
- `carveArc` — a crescent, for sword swings

A bedrock line under the floor is never carved, so the player cannot dig
themselves out of the world.

### Filling any screen (`computeWorldSize`)

There is no fixed 1280x720 stage and no letterbox. The canvas is sized to the
viewport and the playfield is generated at the viewport's *exact* aspect ratio:
landscape fixes the height and lets the width grow, portrait fixes the width and
lets the height grow, both clamped so the fixed-size figure never gets lost in
the frame. Because the terrain is procedural, it can simply be built at whatever
size the screen turns out to be.

Rotating the device re-lays the level without losing the damage already done.
The wall's thickness and the floor's depth clamp differently at different sizes,
so damage cannot just be copied across at an offset — each axis is remapped
piecewise around a landmark both sizes share (the wall's face on x, the floor's
surface on y). Only pixels that were solid in the *old* silhouette count as
holes, otherwise the wall's ragged edge would read as damage every resize. A
full portrait/landscape flip preserves the destroyed fraction to within a
percentage point.

Notch insets are read from a zero-size probe element carrying
`env(safe-area-inset-*)` and applied to the HUD, so nothing important hides
under a cutout.

### Why not Phaser?

Phaser is a good engine, but nothing here is a sprite. The figure, its
weapons and every effect are procedural strokes recomputed each frame, and the
destruction is a bitmap-mask problem that is written the same way with or
without a framework. Bringing in an engine would have added roughly a megabyte
of sprite/scene machinery that this project never calls. The whole game ships
in about 23 KB gzipped instead.

### The stick figure (`src/game/stickman.ts`)

There is not a single keyframe. Every joint is solved each frame:

- **Two-bone IK** for arms and legs, with a fixed bend direction so limbs never
  invert.
- **A distance-driven gait** — the walk cycle advances with ground covered, not
  with time, so footfalls always match the ground speed.
- **Terrain-adaptive feet** — each planted foot probes downward and lands on
  whatever rubble is actually there, so the figure clambers over its own mess.
- **Springs on everything** — lean, hip height, aim, recoil and landing squash
  are all exponentially damped, so states blend instead of snapping.
- Coyote time, a jump buffer, variable jump height, an air somersault and
  wall-jumping.

### The hand-drawn look (`src/core/sketch.ts`)

Real frame-by-frame animation wobbles because every frame is redrawn by hand.
Every stroke here is perturbed by a seeded hash noise that only advances about
eleven times a second, which reproduces that "boil" instead of the dead-still
geometry a vector renderer would give. Heads are drawn as rough ten-sided
polygons for the same reason.

### Sound (`src/core/audio.ts`)

The soundtrack is an original upbeat pop-rock loop synthesised live with the
Web Audio API — kick/snare/hats, a distorted power-chord guitar through a
`WaveShaper`, a filtered saw bass and a delayed square lead, arranged over a
common four-chord vamp with alternating verse and chorus phrases. Notes are
queued by a lookahead scheduler so timing does not drift.

Weapon sounds are shaped noise bursts and pitch-swept oscillators from the same
graph. Nothing is sampled, so there is no third-party audio in this project and
nothing to license.

Audio can only start from a user gesture, which is what the **START PWNAGE**
button provides.

---

## Layout

```
src/
  main.ts              entry point
  core/
    math.ts            vectors, damping, two-bone IK, hash noise
    sketch.ts          hand-drawn stroke renderer (the "boil")
    input.ts           keyboard + multi-pointer, with per-frame edges
    audio.ts           procedural soundtrack and SFX
  game/
    game.ts            state machine, loop, screen effects, HUD
    terrain.ts         destructible bitmap terrain
    stickman.ts        procedural skeleton and animation
    weapons.ts         the ten weapons
    projectiles.ts     rockets, shells, blasts
    particles.ts       debris, sparks, smoke, flames, shockwaves
  ui/
    ui.ts              inked text, buttons, progress meter, weapon wheel
    touch.ts           floating stick, attack zone, weapon pad
```

---

## Credits

An original, from-scratch homage to the stick figure fight animation genre. No
assets, audio, code or artwork from any original video are used or reproduced
here.
