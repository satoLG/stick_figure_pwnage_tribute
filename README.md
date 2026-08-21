# Stick Figure Pwnage — Tribute

A playable tribute to the early-2000s stick figure fight animations: one stick
figure, twelve weapons, and a very destructible black wall.

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
| Hold `Shift` | Sprint — a different gait, not just a bigger number |
| `Space` | Jump — press again mid-air to somersault; also wall-jumps off the wall |
| Mouse | Aim |
| Left click | Attack — keep attacking to chain a combo |
| Hold left click | The heavy chain: slower, bigger, more committed strikes |
| Attack while running / in the air | Its own chain again — four per melee weapon |
| Hold `Tab` | Weapon wheel — time slows, pick with the mouse or the number keys |
| `1`–`0`, `-`, `=` | Quick-swap without opening the wheel |
| Mouse wheel | Cycle weapons |
| `R` / `Esc` | Restart / main menu, on the win screen |

## Controls — touch

Nothing is shown until you touch it, so the picture stays clean.

| Where | Action |
| --- | --- |
| Left side | A floating analog stick appears under your thumb. Its **direction** is the whole control: sideways moves, up jumps, down crouches. Drag past the edge and the stick follows your thumb. How far you push it picks the gait — a small tilt strolls, most of the travel runs, the last quarter sprints. |
| Right side | A second floating stick, for aiming. Press to attack along the aim he already has; **drag** and the aim — and he with it — swings that way, in any direction, however far from him you happen to be holding. Tap to chain the light combo, hold for the heavy one, charge, or sustain a beam. |
| Pad at bottom centre | Hold it and the weapons fan out above; slide onto one and lift to equip. |

Aiming is the only thing that turns him: the cursor, or the right stick. The
left stick moves, jumps and crouches and never changes where he is looking, so
he can run one way while still facing and swinging the other.

The wheel is a full ring with a mouse and a **fan above the pad** on touch — a
thumb dragging up from the bottom edge cannot reach the lower half of a ring.

## The arsenal

| # | Key | Weapon | Behaviour |
| --- | --- | --- | --- |
| 1 | `1` | Bare hands | Jab, cross, hook, uppercut; a shoulder charge out of a run, a spinning backfist if you lean on it |
| 2 | `2` | Katana | A three-cut kata with a whirlwind on the end — and out of a run, the ninja slash: down onto one knee, one flat cut as he slides past, straight back up |
| 3 | `3` | Twin shortswords | A blur of alternating cuts, every fourth a cross; a full propeller in mid-air |
| 4 | `4` | Greatsword | Too heavy to carry: the tip drags along the floor throwing sparks, and a run rips it back up through everything in front |
| 5 | `5` | Warhammer | Ploughs along behind him, then craters instead of cutting; the shock runs out along the ground |
| 6 | `6` | Sidearm | Semi-auto, crisp holes with a short tunnel; you can watch each round go |
| 7 | `7` | Assault rifle | Full auto; accuracy degrades as it heats up, tracers show you where it walked |
| 8 | `8` | Shotgun | Eleven pellets in a cone, eleven tracers, heavy self-knockback, pump action |
| 9 | `9` | Rocket tube | Arcing projectile, 62px crater |
| 10 | `0` | Siege cannon | Hold to charge; the biggest crater and a shove backwards |
| 11 | `-` | Pyro stream | Hold to melt the wall away gradually |
| 12 | `=` | Pwnage beam | Gather an aura, then bore a wide channel clean through — in mid-air it holds him up while he fires |

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

**Only the wall breaks.** The floor is the stage the fight happens on: it keeps
its uneven, rolling surface, but nothing digs into it. Both passes of
`carvePolygon` are clipped to the wall's rectangle, so the mask, the picture and
the win counter cannot disagree about what is destructible. The wall itself
starts perfectly straight and vertical — every notch in its face is one the
player put there.

Every carve is scaled by a single `DAMAGE_SCALE` constant before it touches the
bitmap. It is the one knob for how tough the wall is: sustained fire from the
rifle takes well over a minute to clear it, and the heavy weapons still have to
be swung at the wall from arm's length to pay off.

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
holes. A full portrait/landscape flip preserves the destroyed fraction to within
a percentage point.

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
- **Three gaits out of one analog axis.** How far the stick is pushed picks the
  speed *and* the animation: a stroll keeps the figure upright with short
  strides and a small arm swing; a run lengthens the stride and leans into it;
  a sprint stretches the stride again, folds the arms into a pump, deepens the
  lean and starts leaving afterimages, speed lines and a dust trail. Everything
  between them is interpolated, so there are no gait "modes" to pop between.
  A keyboard has no in-between, so it reports the run deflection and `Shift`
  pushes it the rest of the way.
- **Counter-rotating shoulders** against the hips, without which a run reads as
  a cardboard cut-out sliding along the floor.
- **Footfall events** — each half-stride fires one, which is what kicks the dust
  and ticks the step sound at exactly the right moment.
- **Weapon-driven stances.** A weapon can ask for a whole-body pose for the
  frame — `brace` plants the feet wide and arches the torso back, `crouch` drops
  him onto one knee over the floor, `lunge` throws the front leg out ahead, and
  `hover` folds the legs up and switches gravity off. They blend in and out over
  the solved pose, so a charge-up, a heavy wind-up or a sliding slash moves the
  entire figure rather than just the hands.
- **Slides and grounded spins.** `slide()` cuts ground friction for a moment, so
  a committed step keeps travelling instead of stopping dead; `spinFlourish()`
  turns the whole figure about its own pelvis, with an optional hop under it so
  a spinning swing does not drag its own feet through the floor.
- **Afterimages** — a short ring of frozen skeletons drawn faintly behind the
  live one, on the sprint and on every big swing.
- **Terrain-adaptive feet** — each planted foot probes downward and lands on
  whatever rubble is actually there, so the figure clambers over its own mess.
- **Springs on everything** — lean, hip height, aim, recoil and landing squash
  are all exponentially damped, so states blend instead of snapping.
- Coyote time, a jump buffer, variable jump height, an air somersault and
  wall-jumping.

### Melee combos (`src/game/melee.ts`)

Every melee weapon is a table of moves, not a pile of `if`s. A `MeleeMove` says
where the weapon coils to and where the strike ends, how long each phase takes,
how big a bite it takes, and what the body does with it — a forward impulse, a
lift, a slide, whole turns of body spin, a stance to hold, a shove backwards
once the hit lands, and how much screen the impact is worth.

Each weapon carries **four chains**, and which one a swing comes from is decided
by what the player was doing at the moment they attacked — there is no separate
button:

| Chain | When |
| --- | --- |
| `ground` | Standing or walking: the light combo, cycled while you keep attacking |
| `run` | Attacking above running speed |
| `air` | Attacking off the ground |
| `hold` | The trigger held down past a third of a second: heavier, slower, more committed |

Keep the rhythm and the chain advances; lose it for two thirds of a second and
it drops back to its first strike. The chain the figure is on is printed next to
the cooldown meter.

The base class owns everything the chains share — the coil/strike/recovery
curve, the carve, the crescent, the tip ribbon, the stance blend, the hand
placement and the impact. A weapon only says how long it is, what its four
chains are, where it rests and how to draw itself, which is why the katana's
sliding one-knee slash and the hammer's meteor are the same twelve lines of
data with different numbers.

`dragAngle` solves for the angle that puts the far end of a weapon flat on the
floor behind the figure. The greatsword and the warhammer blend into it the
moment he starts walking: the tip finds the ground, throws sparks and grit along
it, and the running attack rips it straight back up out of the floor.

### Making a cut read as a cut (`src/game/weapon-base.ts`)

Every edged weapon feeds a shared `SlashFx`: the crescent it just swung through
stays hanging in the air for a fraction of a second, filled white with a heavy
ink edge, opening and thinning as it fades. It is drawn *behind* the figure, so
a swing that takes half the screen never hides the person who threw it.

The blades themselves hang off the swing rather than the aim. `gripAt` places
the hands around the *blade* angle, so the arms lead the sword around and the
whole body follows the weight; the katana blends between a guard grip at rest
and a hilt grip mid-cut. Each combo step carries its own timing — coil, an
almost instantaneous strike, then a long recovery — and retunes the next step's
animation length as it fires, which is what lets three cuts of different weights
chain out of one held button.

The two heavy weapons are the same machinery with the numbers pushed: a coil
long enough to be read and answered, an arc big enough to take a bite out of the
wall in one hit, and a `brace` stance that sinks the figure into the swing.

### Bullet trajectories (`Particles.tracer`)

Hitscan weapons resolve their damage the instant the trigger goes, which leaves
nothing on screen between the muzzle and the hole. Every shot now spawns a
tracer: a very faint line along the path the round took, with a brighter dash
racing down it at 3600 units a second and fading only once it has arrived. It is
what makes a rifle burst read as a burst, and it turns the shotgun into eleven
separate lines fanning into the wall.

### The aura (`EnergyBeam.drawBehind`)

The charge-up is a jagged silhouette around the figure, filled white and stroked
in ink, with tongues licking up past his head and chips of the floor tearing
loose and climbing it. Filling it white is what keeps the picture readable: the
aura burns the black wall back off him instead of scribbling on top of him, and
the figure is stroked once in fat white before it is drawn in black, so it stays
clean through the whole thicket.

Charging in mid-air latches a `hover` stance: the fall stops dead, the legs fold
up, and the beam is fired from a slow climb. When the power lets go, so does the
float.

### The hand-drawn look (`src/core/sketch.ts`)

Real frame-by-frame animation wobbles because every frame is redrawn by hand.
Every stroke here is perturbed by a seeded hash noise that only advances about
eleven times a second, which reproduces that "boil" instead of the dead-still
geometry a vector renderer would give. Heads are drawn as rough ten-sided
polygons for the same reason.

### Sound — a real band, synthesised (`src/core/audio.ts`)

There are no samples anywhere, so the instruments are modelled rather than
played back:

- **Guitars and bass are plucked strings.** Karplus-Strong: a burst of noise is
  written into a ring buffer one wavelength long and averaged with its neighbour
  on every lap, losing a little amplitude each time. The high harmonics die
  first and the fundamental hangs on — which is what a real string does, and why
  it sounds like one. The buffers are built once per note and cached.
- **The guitar rig is a rig.** Three strings (root, fifth, octave) are strummed
  a few milliseconds apart into a distortion curve, then a speaker cabinet —
  lowpass, a highpass to clear the mud, and a presence peak at 2.3 kHz. The
  verse plays palm-muted sixteenth chugs (shorter decay, darker cabinet), the
  chorus lets the same chords ring.
- **The bass** is a long dark string through a sweeping lowpass and a gentle
  overdrive, with a sine sub underneath so phone speakers still feel the root.
- **The kit** is a drum machine: a pitch-swept sine with a beater click for the
  kick, noise plus two detuned tuned bodies for the snare, and the classic stack
  of six inharmonic square waves through a highpass for the metal of the hats
  and cymbals. Toms fill the last beat of every fourth bar.
- **A room.** A generated impulse response — decaying noise with a few discrete
  early reflections — feeds a `ConvolverNode` that the snare, cymbals, lead and
  the big explosions all send to.

The arrangement is a sixteen bar loop over a vi-IV-I-V vamp, four bars each of
verse, build and two choruses, with the kick, snare and hat patterns written as
sixteen-character strings. Notes are queued by a lookahead scheduler so timing
never drifts, and the whole band is trimmed to leave headroom for a shotgun and
two explosions on top of it.

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
    input.ts           keyboard + multi-pointer, with per-frame edges; also
                       cancels the browser's own zoom / select / drag gestures
                       and retires fingers whose pointerup never arrived
    audio.ts           procedural soundtrack and SFX
  game/
    game.ts            state machine, loop, screen effects, HUD
    terrain.ts         destructible bitmap terrain
    stickman.ts        procedural skeleton, gaits, stances and afterimages
    weapon-base.ts     the Weapon contract, grips, slash crescents, hitscan
    melee.ts           the melee combo framework (four chains per weapon)
    weapons.ts         the twelve weapons
    projectiles.ts     rockets, shells, blasts
    particles.ts       debris, sparks, smoke, flames, shockwaves, tracers
  ui/
    ui.ts              inked text, buttons, progress meter, weapon wheel
    touch.ts           the two floating sticks, weapon pad
```

---

## Credits

An original, from-scratch homage to the stick figure fight animation genre. No
assets, audio, code or artwork from any original video are used or reproduced
here.
