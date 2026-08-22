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
| `Space` / `S` with the mecha | With the wings out jump is a throttle, not a jump: hold it to climb, crouch to dive, let go of both to sink |
| Hold `Tab` | Weapon wheel — time slows, pick with the mouse or the number keys |
| `1`–`0`, `-`, `=` | Quick-swap without opening the wheel |
| Mouse wheel | Cycle weapons |
| `Esc` | Settings — and on the win screen, back to the main menu |
| `R` | Restart, on the win screen |

## Controls — touch

Nothing is shown until you touch it, so the picture stays clean.

| Where | Action |
| --- | --- |
| Left side | A floating analog stick appears under your thumb. Its **direction** is the whole control: sideways moves, up jumps, down crouches. Drag past the edge and the stick follows your thumb. How far you push it picks the gait — a small tilt strolls, most of the travel runs, the last quarter sprints. |
| Right side | Aim and attack. **With a gun** the aim goes exactly where you touch, and follows your thumb as it slides. **With a blade or your fists** it is a floating stick instead: press to swing along the aim you already have, drag to swing the aim itself round. |
| Pad at bottom centre | Hold it and the weapons fan out above; slide onto one and lift to equip. |

## Controls — gamepad

Any standard-mapping pad, no setup: pick it up and the game switches to it,
touch the glass or the mouse and it switches back.

| Input | Action |
| --- | --- |
| Left stick | Move — push up to jump, down to crouch. While an attack button is held it steers the swing as well, so a run turns into a lunge without moving a thumb |
| Right stick | Aim, eased (below) — and **shoving it is itself an attack**, no button. A charged weapon lets go the moment the stick comes back to centre, so a charged shot to the right is hold-right, release |
| `R1` / `R2` / `X` | Attack along the aim he already has |
| `A` | Jump · `B` Crouch |
| Hold `L1` / `L2` | Weapon fan — point the right stick at one and let go |
| D-pad ←→, `Y` | Step through the arsenal |
| `Start` | Settings |
| D-pad / left stick, `A`, `B` | Walk the menus, take a choice, back out — whatever is selected wears an impact border |

## Aiming

Aiming is the only thing that turns him: the cursor, the aiming thumb, or the
right stick. The movement stick moves, jumps and crouches and never changes
where he is looking, so he can run one way while still facing and swinging the
other.

A stick is not a crosshair, though, and one reading does not suit all three
devices. Reading a stick's angle straight off is right for a bat, where
anywhere in the right half of the world is a hit; for a rifle it is hopeless,
because near the vertical a couple of degrees of wobble crosses the axis and
spins the whole figure round, and the smallest useful push is worth ninety
degrees of aim. So each pairing gets what suits it (`src/ui/aim.ts`):

| Device and weapon | Reading |
| --- | --- |
| Touch, ranged | **Point** — the aim goes to the spot under the thumb. There is no stick to wobble, so a shot lands where you put your finger. |
| Touch, melee | **Direct** — the raw angle of the floating stick, instantly. Fastest and most forgiving, which is what a swing wants. |
| Gamepad | **Eased** — the aim *swings* towards the stick at a capped speed instead of snapping to it, rising with the square of the push, so the first degrees of travel place a shot and the rim spins him round. A real stick springs back, and needs it. |
| Mouse | The cursor is the aim. It is drawn as a difference against whatever is under it, so it inverts to white the moment it crosses the wall instead of disappearing into it. |

**Aim speed** in the settings scales the eased sweep; it is on FAST by default.

## Settings

The cog in the top right, or `Esc`, or `Start` on a pad. The world holds still
while it is open, everything takes effect the moment it is touched, and the
choices are remembered between sessions.

- **Audio** — music and effects levels, applied live.
- **Input** — what this machine can be played with, and which of them is in
  hand, plus the aim speed.

The weapon wheel is a full ring with a mouse or a pad and a **fan above the
pad** on touch — a thumb dragging up from the bottom edge cannot reach the
lower half of a ring.

## Staying in the scene

The figure cannot leave the picture. The sides, the underside of the HUD strip
and the bottom of the world are hard walls, so no amount of speed or knockback
puts him outside the scene — and if his *legs* end up inside the ground, the
floor carved out from under him or the level re-laid under his feet, he settles
up out of it by about a step's worth.

That is the whole of it, deliberately. Walking into masonry is already handled
a column at a time by the movement itself, and a head clipping the underside of
a ledge mid-jump is two drawings overlapping for a frame — worth nothing, and
certainly not worth being shoved across the room for.

## The screen

The scene is a fixed-size thing placed on a variable-size screen, not a thing
stretched to fill it. The figure, the floor and the wall are all constants in
world units — the wall is always 564 tall and 420 thick, better than four
figures high — so a phone and an ultrawide get the same wall, the same run-up
and the same length of game. What the screen shape decides is how much room
there is *around* it: a tall screen gets more sky and a deeper floor, never a
taller wall.

Where in that leftover room the wall sits is the framing, and it is aimed
rather than left to fall out: the floor is deepened until the wall's middle
lands on the middle of the band under the HUD strip, capped so a very tall
phone gets a wall sitting a little low instead of a quarter-screen of solid
black along the bottom.

A strip along the top belongs to the HUD — the meter, the cog, and whatever
joins them later — and the scene is laid out underneath it, so nothing solid
ever climbs into the readouts. It is white paper either way, so the two still
read as one picture rather than a game with a bar bolted over it.

## Starting a run

The game gives exactly one instruction, and it gives it once. A run opens with
**DESTROY THE WALL** being written onto the paper — stroke by stroke, with a
scrub of pencil riding along at the nib — and a short arrow hooked out from
under it, a hair where it leaves the words and a wedge where it arrives, bowing
right and down into the masonry.

The letters are drawn, not typeset. Everything else on this paper is a line
somebody made and every one of them wobbles, so an alphabet of capitals written
out as polylines (`ui/handwriting.ts`) goes through the same boil as the figure
and the craters, and is inked along its own length so it can be watched being
written. Text set in a font can be jittered around — which is what `inkText`
does, and which is right for a readout — but a *caption* in Trebuchet beside a
hand-drawn stick figure reads as a caption bolted on afterwards.

The note is pinned to the wall rather than to the screen. The words sit just
off the wall's face whatever the screen shape, so the arrow is only ever a
short hook into the stone instead of a banner in the middle of an ultrawide
with a yard of arrow reaching across it.

The destruction meter is not there yet. Nobody needs a progress bar for
progress they have not started making, and a run that opens with a HUD already
in place reads as a game rather than a drawing. The first blow that actually
lands on the wall is the starting gun: the cue lifts off the paper and the
meter drops in from above to replace it.

## Installing it

The page is a small PWA. The title card carries an **install** button under
START, and only where it leads anywhere: on Chrome and the rest it holds back
`beforeinstallprompt` and fires it from that press, so the offer lives in the
game's own card rather than a browser bar over the top of it; on iOS, which has
no such event, it opens a card spelling out Share → Add to Home Screen. Once it
is running from a home screen the button stops being drawn at all.

A small service worker (`public/sw.js`) caches the shell so it starts offline
after the first run — navigations go to the network first and fall back to the
cache, so a deploy is never pinned behind a stale copy, while the fingerprinted
assets are cached on first use.

## The arsenal

| # | Key | Weapon | Behaviour |
| --- | --- | --- | --- |
| 1 | `1` | Bare hands | Jab, cross, hook, uppercut; a shoulder charge out of a run, a spinning backfist if you lean on it |
| 2 | `2` | Greatsword | Too heavy to lift at all: standing or walking the point stays on the floor behind him, and a run rips it back up through everything in front |
| 3 | `3` | Warhammer | Ploughs along behind him, then craters instead of cutting; the shock runs out along the ground |
| 4 | `4` | Claws | Three parallel gouges a pass, with masonry left standing between them; hold it down for a flurry and one opening finisher |
| 5 | `5` | Magnum | One hand, one round at a time, and a hole out of all proportion to it; the recoil throws the barrel up and shoves him back |
| 6 | `6` | Assault rifle | Full auto; accuracy degrades as it heats up, tracers show you where it walked |
| 7 | `7` | Shotgun | Eleven pellets in a cone, eleven tracers, heavy self-knockback, pump action |
| 8 | `8` | Bazooka | One warhead, one very large hole, and a backblast out of the open end |
| 9 | `9` | Missile pods | Three guided rounds that climb out of his back and turn onto the crosshair — or hold it down and put ten into the wall at once |
| 10 | `0` | Arcane staff | Tap for four bolts in a fan; hold for two rings, a ball between the horns, and a beam twice the width of the pwnage beam that barely scratches the paint |
| 11 | `-` | Mecha | Wings out: jump climbs, crouch dives. Grounded he cuts with a blade that slides out of his forearm; airborne it is quick little rounds; hold it and four rods unfold out of his back and burn one point |
| 12 | `=` | Pwnage beam | Gather an aura, then lean a pillar of light on the wall and push it in — in mid-air it holds him up while he fires |

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

Both are modified through a single primitive, `carvePolygon`, and whatever it
takes out of the array it paints out of the canvas in the same pass. Because
one decision drives both, what you see is always exactly what you collide with,
and there is never a readback of pixel data in the hot path.

**The polygon is a reach, not a stamp.** What actually comes off is only the
part of it a blow could physically have got to: the carve starts from the open
air, eats into the material it is touching, and stops a set number of pixels
in. It is a breadth-first flood — every open cell in the working box is a
starting point at depth zero, the bite spreads one layer at a time into wall
the reach covers, and floor and un-reached masonry are simply never entered, so
they shield whatever stands behind them.

Two things fall out of that, and both matter more than any amount of tuning.

*Nothing can be taken out of the middle of the wall while the face in front of
it is left standing.* A swing that reaches past a slab now bites the slab; it
does not teleport through it and hollow out the inside. The order is always
front first, and it holds by construction — a hole can only ever be opened onto
air, and air is never given back, so every cavity in the wall stays connected
to the outside for as long as the run lasts.

*And a weak hit stays a shallow hit rather than becoming a narrow one.* Scaling
radii down to make the wall tough had turned every blow into a needle: a
hairline slot driven deep into the masonry, which reads as nothing and leaves
the face standing while the inside goes. A weak hit is a **wide round bite that
cannot reach far**, so radii sit near their nominal size (`BITE_WIDTH`) and the
resistance lives entirely in the depth limit. Getting into the wall is the hard
part; scuffing its face is not.

Depth is what separates the weapons, too. A swing takes about a fifth of its
own width off the face (`thick`), a bullet reaches about as far in as its hole
is wide, a charge going off against the stone digs half its blast radius, and
the beam eats forward at a rate in world units per second — measured in time,
so it is the same at fifteen frames a second as at sixty.

A barrel or a fist pressed flat against the wall ends up a few units *inside*
the drawing, and a ray started there reports its hit deep in the stone with the
face still standing in front of it — which, under the rule above, removed
nothing at all. `strikePoint` backs such a line up to where it went in, so a
point-blank shot lands on the surface the player was actually aiming at.

Everything else is built on that primitive:

- `carveBlob` — a circle whose radius wobbles, for craters and bullet holes;
  what lands is the shallow dish where it meets the surface, not a ball buried
  in the stone
- `carveCapsule` — for the energy beam, which does not reach through the wall
  in a frame: every frame it finds the face it is pressed against and pushes
  the hole a little further in, so a discharge drills a shaft and a few of them
  get through
- `carveArc` — a crescent, for sword swings

**Only the wall breaks.** The floor is the stage the fight happens on: it keeps
its uneven, rolling surface, but nothing digs into it. Both passes of
`carvePolygon` are clipped to the wall's rectangle, so the mask, the picture and
the win counter cannot disagree about what is destructible. The wall itself
starts perfectly straight and vertical — every notch in its face is one the
player put there.

A wall that comes apart in seconds makes every weapon feel the same, because
none of them has to be *used* — bare hands were levelling as much masonry per
second as a rocket. Toughness is why `BITE_DEPTH` exists, and putting it in the
depth rather than the width is what keeps a tough wall from turning every blow
into a scratch: the wall comes down the way the film does it, by being hit over
and over, faster and faster, and each blow visibly takes something off the
face.

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
- Coyote time, a jump buffer, variable jump height and an air somersault.
- **Wall jumping** — jump while pressed against masonry and he coils both legs
  onto it and springs off, with the air jumps handed back so a kick and a
  somersault stack. The push away from the wall is deliberately tiny: enough to
  leave it, small enough to steer straight back into it and take another, which
  is what turns one kick into a climb up the whole face.
- **Attacking in mid-air nearly stops the fall** — while a swing (or a wind-up)
  is running off the ground, gravity drops to a trickle and the descent is
  capped at a crawl, so a combo begun off a jump gets to play out up there
  instead of being dumped on the floor halfway through. The beam's float still
  outranks it: that one climbs, this one only falls slowly.

  It is a slower fall and never a bigger jump. Both the reduced gravity and the
  reduced air speed apply on the way *down* only: the climb is the climb he
  always had, the apex lands in exactly the same place, and because the descent
  is stretched to about four times its length the air speed through it drops by
  about as much — so a jump with a swing in it clears no more ground than the
  same jump without one.

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
chains are, where it rests and how to draw itself, which is why the claws'
five-hit flurry and the hammer's meteor are the same twelve lines of data with
different numbers. A move can also set `rake`, which swaps the one solid wedge
a blade takes out for a set of thin parallel gouges — the claw marks, where the
gaps between the scores are the whole effect.

`dragAngle` solves for the angle that puts the far end of a weapon flat on the
floor behind the figure. The greatsword never comes up off it at all — standing
or walking, the point is down — and the warhammer ploughs along behind him the
moment he moves. Dragging one along the ground throws sparks and grit; the
running attack rips it straight back up out of the floor.

### Making a cut read as a cut (`src/game/weapon-base.ts`)

Every edged weapon feeds a shared `SlashFx`: the crescent it just swung through
stays hanging in the air for a fraction of a second, filled white with a heavy
ink edge, opening and thinning as it fades. It is drawn *behind* the figure, so
a swing that takes half the screen never hides the person who threw it. The
claws feed it three at once at three different radii, which is how a rake ends
up reading as a rake.

The blades themselves hang off the swing rather than the aim. `gripAt` places
the hands around the *blade* angle, so the arms lead the sword around and the
whole body follows the weight; every melee weapon blends between its resting
grip and a hilt grip mid-cut. Each combo step carries its own timing — coil, an
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

### Flight (`'fly'`, `src/game/stickman.ts`)

The mecha asks for a different stance again, and it is not a hover holding him
up while he does something else — it is actually flying. The moment his feet
leave the floor `flyT` blends in, gravity all but disappears and the jump key
stops being a jump: held it climbs, crouch dives, and letting go of both leaves
him sinking gently rather than hanging in the air. The legs trail and lead the
climb, the arms sweep back out of the way of them, and swapping to anything
else in mid-air hands him straight back to gravity.

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
    gamepad.ts         two sticks and a handful of edges, polled
    settings.ts        audio levels and aim speed, remembered
    audio.ts           procedural soundtrack and SFX
  game/
    game.ts            state machine, loop, screen effects, HUD
    terrain.ts         destructible bitmap terrain
    stickman.ts        procedural skeleton, gaits, stances and afterimages
    weapon-base.ts     the Weapon contract, grips, slash crescents, hitscan
    melee.ts           the melee combo framework (four chains per weapon)
    weapons.ts         eight of the twelve weapons, and the arsenal order
    weapons-video.ts   the four lifted straight out of the source animation:
                       claws, missile pods, arcane staff, mecha
    projectiles.ts     rockets, shells, guided missiles, bolts, blasts
    particles.ts       debris, sparks, smoke, flames, shockwaves, tracers
  ui/
    ui.ts              inked text, buttons, progress meter, weapon wheel
    cue.ts             the DESTROY THE WALL note and its arrow, written on
    handwriting.ts     capital letters as pen strokes, drawn along their length
    touch.ts           the two floating sticks, weapon pad
    aim.ts             stick movement to an aim direction, per device
    settings-menu.ts   the cog, and the card it opens
```

---

## Credits

An original, from-scratch homage to the stick figure fight animation genre. No
assets, audio, code or artwork from any original video are used or reproduced
here.
