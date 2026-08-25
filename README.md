# Stick Figure Pwnage — Tribute

A playable tribute to the early-2000s stick figure fight animations: one stick
figure, fourteen powers, and a very destructible black wall.

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
| `1`–`0`, `-`, `=`, `[`, `]`, `;`, `'`, `\\` | Quick-swap without opening the wheel |
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

Fourteen slots in two groups. **Main** is the set the source film actually
shows him using; **extra** is everything built on top of it. The wheel leaves a
blank seat in the ring where the two meet, and the HUD says which group the
thing in his hands came out of.

### Main

| # | Key | Power | Behaviour |
| --- | --- | --- | --- |
| 1 | `1` | Brawler | Punches and only punches — jab, cross, hook, uppercut, a shoulder charge out of a run, haymakers if you lean on it — each with its own stance so the body moves under the arm. Keep leaning and it winds up into the barrage: the blows arrive sooner and sooner until the arms stop being drawn at all and a field of drags buries him, and letting go runs the same thing backwards |
| 2 | `2` | Swordsman | Too heavy to lift at all: standing or walking the point stays on the floor behind him, and a run rips it back up through everything in front. Hold it and he throws himself the width of a room forward turning over twice, lands on the wall and puts three full-weight cuts through it |
| 3 | `3` | Smasher | The source's mallet: a smooth barrel as tall as he is with a stick out of the back and no bands, cheeks or claws anywhere on it. Ploughs along behind him, then craters instead of cutting. Hold it and the ceremony goes out of it — forward, back, forward, three times as fast as a head that size has any right to move |
| 4 | `4` | Windslash | Nothing in his hands: every swing throws curved blades of air four hundred units out in front, and what they leave is separate scores with wall still standing between them. There is weather round him whether or not the trigger is down, and the air carries him half again as high as anyone else jumps. Hold it and he pulls the storm in; letting go throws a whirlwind whose base stays in his hands |
| 5 | `5` | Gunslinger | Four guns and he chooses. The three he is not holding ride on his back where you can see them; the one in his hands is whatever the range calls for — the revolver out past 250 units, the shotgun inside it. Hold the trigger and the tube comes off his back: one rocket, then three grenades thrown after it, then the rifle, which waits until a grenade is nearly on the wall before putting a round through it |
| 6 | `6` | Rocketeer | A long screened cannon over his shoulder with three ports in the mouth of it, and four fat tubes fanned out behind him with the bore showing at the end of each. Three rounds one after another out of the front, or hold it down and dump ten off the back |
| 7 | `7` | Mage | Staff planted on the floor and a pointed hat; it only comes up and points at anything while he is charging. Tap to summon four orbs, well apart, that hang for a second and then go in one at a time on thick white trails. Hold for hoops sliding up the shaft, a ball between the horns and a very wide beam that barely scratches the paint. Off the ground there is a circle turning under his boots, and he comes down at less than half everyone else's speed |
| 8 | `8` | Shinobi | Kunai thrown flat and point first, and every third throw a big shuriken that takes a proper hole out of the wall. Hold it and he sinks into a crouch making seals — an inset panel zoomed on two hands with fingers that fold — then folds forward and breathes a fireball bigger than he is. Wears the headband: a dark band with a plate, tied off in two ends behind |
| 9 | `9` | Thunderbolt | Discharges that skip off the ground and take a bite out of everything they touch on the way to the wall — each one drawing the jagged path it has actually taken behind it. Hold it and the charge crawls all over him, then earths itself in sixteen directions at once |
| 10 | `0` | Mecha | Wings out: jump climbs, crouch dives. The forearm blade comes out whenever there is masonry inside its reach, on the floor or off it; at range a stub of cannon telescopes out of his palm. Hold it and four rods unfold out of his back and burn one point |
| 11 | `-` | Split head | A press hinges his face apart on the seam across the middle and four very unfriendly rounds leave the rack. Hold it and the skull comes apart the other way — straight down the middle — and what stands in the doorway pours a cutting beam until he lets go |
| 12 | `=` | Giant robot | He climbs inside a machine several times his size and stops being drawn at all: rounded tube limbs, a ribbed chest and a visored helmet. It punches holes in the wall and cuts with its eyes; hold it and the arm folds into a launcher, puts five guided rounds downrange, catches fire, drops him out of the top, folds itself into a slab, and he throws the slab through the wall |
| 13 | `[` | Monster tamer | A cape, and a mouth that opens wider than a head should. Tap and he shouts a beam out of it; hold and something hauls itself up out of the floor beside him — a screened mass with a toothed maw and two clawed forelimbs — and answers with one four times the size. If he walks off it goes back under and comes up again behind him. Neither of them aims |

### Extra

| # | Key | Power | Behaviour |
| --- | --- | --- | --- |
| 14 | `]` | Sayajeans | Spiked hair and a light aura. A tap is a ball of light out of one hand and the next out of the other, with no screen shake at all — and throwing keeps him up, so he can hang there doing it. Hold it and gather everything, then lean a pillar of light on the wall and push it in |

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
gaps between the scores are the whole effect — and `impact`, which sizes the fan
of lines the blow converges on. The hammer asks for the top of that range, and
gets the sheet of speed lines the reference draws under a hit that big.

`dragAngle` solves for the angle that puts the far end of a weapon flat on the
floor behind the figure. The greatsword never comes up off it at all — standing
or walking, the point is down — and the warhammer ploughs along behind him the
moment he moves. Dragging one along the ground throws sparks and grit; the
running attack rips it straight back up out of the floor.

### Two groups, and one slot that is four weapons

`Weapon.group` is `'main'` or `'extra'`, and the wheel seats the slots with one
blank position where the two meet - no boxes, no second ring, just a gap where
a slot would otherwise be, plus the group's name set small under the highlighted
weapon. It is the cheapest divider that reads, and it costs nothing on a phone
fan or a gamepad ring either.

The gunslinger is one slot carrying four guns. The magnum, the shotgun, the
rifle and the bazooka used to be four slots doing one job at four ranges; now
*he* chooses. The three he is not holding are drawn on his back as silhouettes -
not the same drawings as the one in his hands, which at that size piled into a
single black scribble, but simplified profiles with the one feature that names
each: a cylinder, a pump, a magazine, a flared tube. Which one is in his hands
comes from a wall probe down the aim line, and holding the trigger runs the
sequence: three grenades lobbed on one line at three speeds so they string out,
then a swap to the rifle and a round through each of them in turn.

### One shape, not a bag of leaves (`Sketch.starPath`)

`tuftPath` traces one subpath per spike, which is exactly right when they are
meant to be flicks of solid ink. The moment you want the white-bellied
treatment on them it gives you a separate outline round every single spike, and
a landed punch or a discharge earthing itself comes out as a bag of little
leaves. `starPath` traces the same cluster as a *single closed zigzag* - tips
at wildly uneven lengths, valleys pulled back in near the point of contact - so
there is exactly one contour round the lot and the paper shows through it. The
barrage's landings, the electricity's feathering and the bolts' heads all go
through it.

### Headgear, and why it does not turn over (`headTilt`)

The figure somersaults, and while he is turning over `pose.bodyAngle` runs all
the way round. A hat or a headband drawn at that angle spends half of every
flip upside down on top of his head. `headTilt` takes the lean out of the body
angle and throws the rest away: headgear tips with him up to about a third of a
turn and no further, and the head can orbit the pelvis all it likes underneath.

### The stroke everything is drawn with (`src/core/sketch.ts`)

Nothing in the reference film is a solid black blob. Every effect in it — a
punch drag, a gout of flame, a blade of wind, the fan off an impact, a muzzle
flash — is a *thick* shape with a **white belly and a black rim**, and the rim
is only ever drawn part of the way round. The pen goes down, follows an edge
for a while, lifts, picks up again further along, and the eye completes the
form. That unclosed rim is the entire reason the source reads as fast and
hand-drawn rather than as shapes someone filled in.

- `inked(trace, rim, broken, seed)` — that stroke. It lays down a path, fills
  it white, then walks a broken pen round the outline, with the gaps landing
  somewhere different every drawing. `broken` is how much of the rim is
  *missing*: 0 draws the whole outline, 0.6 leaves well over half of it out.
- `rim(width, broken, seed)` — the same pen on a path that is already traced,
  for callers that fill it themselves.
- `screenTone()` — the reference's only grey, and it is not grey: it is a
  screen of dots. Handed back as a tiled pattern you set as `fillStyle`, so it
  stops exactly on an outline with no clipping involved. (`halftone` still
  shades a clipped box, which is fine for a rectangle and fragile for anything
  else.)

Where a stroke runs thin the two sides of the rim meet and it still reads
solid black; where it runs fat the paper shows straight through the middle.
That mix is what the source's frames are actually made of, and it is why the
barrage, the wind, the impact fan, the staff's charge ball and every muzzle
flash all go through `inked` rather than `fill`.

### Drawing something going off

The reference's violent frames are not neat. They are thrown down: strokes that
bow a long way off their own axis, fans of tapered slivers at wildly uneven
lengths, torn holes rather than shapes. Three helpers on `Sketch` carry that,
and everything explosive in the game is built out of them:

- `scrawl` — a stroke whose middle wanders off the straight line, so a mark
  reads as drawn at speed rather than measured out.
- `blastPath` — the explosive fan. Long tapered slivers radiating from a point,
  each bowed off its own axis and none the same length as its neighbour. It
  traces without painting, so the caller fills white and strokes black, which
  is the only treatment that reads over the paper *and* over the black wall.
- `ragPath` — a torn closed blob, for the hole an impact punches in the picture.
- `ribbonPath` — a curved tapered stroke with real width, fattest wherever you
  ask for and pointed at both ends. It is what everything fluid is drawn with:
  the curls of wind are commas made of these, not arcs at a radius.
- `sparkPath` — the same idea as `blastPath` with a bend in every stroke and the
  jitter cranked so they cluster in threes and leave paper between the clusters.
  Electricity is drawn out of these: long thin curved scratches, which is what
  the reference actually puts on the page, rather than a tidy zigzag.

`burst` is still there for small punctuation. Anything that has actually gone
off uses these instead.

### Making a cut read as a cut (`src/game/weapon-base.ts`)

Every edged weapon feeds a shared `SlashFx`: the crescent it just swung through
stays hanging in the air for a fraction of a second, filled white with a heavy
ink edge, opening and thinning as it fades. It is drawn *behind* the figure, so
a swing that takes half the screen never hides the person who threw it. The
wind feeds it three at once at three different radii and sets them to keep
opening outwards as they fade, which is what turns a crescent into a gust: it
does not sit where it was cut, it travels.

The brawler has nothing to feed it with, so the barrage draws its own. Each
blow is a torn white hole in the picture, a wild fan of slivers thrown out of it
in every direction and a handful of long loose scrawls dragging back down the
line it came in on — all of it built from `blastPath`, `ragPath` and `scrawl`,
and all of it still opening as it fades. They outlive the gap between blows
deliberately: four or five overlapping at once is what separates a flurry from
a metronome.

And while it runs, his arms are not drawn. `Stickman.armsHidden` takes them off
the figure entirely, because two limbs vibrating in place at fifteen frames a
second read as a mistake, while a body leaning into a storm of impacts with no
arms visible reads as exactly what the reference draws.

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

### Taking pieces of him off the drawing (`Stickman.armsHidden` and friends)

Three of the powers are not things he holds, they are things he becomes, and
the honest way to draw that is to stop drawing the parts they replace. A weapon
declares `hidesArms`, `hidesHead` or `hidesBody` and the figure simply leaves
them out that frame; `headScale` swells the head for a shout. So the barrage
has no arms, the split head has no head, and while the titan is standing there
is no stick figure at all — the machine is posed off the same skeleton, blown
up around the point his feet are on, so it still walks with his gait, leans
with his lean and takes his recoil.

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
    weapons.ts         the hands, the edges, the gunslinger, and the arsenal order
    weapons-video.ts   the six lifted straight out of the source animation:
                       wind, missile pods, arcane staff, shinobi,
                       thunderbolt, mecha
    weapons-forms.ts   the three that change what he is rather than what he
                       is holding: the shout, the titan, the split head
    projectiles.ts     rockets, shells, guided missiles, kunai, bouncing
                       lightning, orbs, a very large fireball, blasts
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
