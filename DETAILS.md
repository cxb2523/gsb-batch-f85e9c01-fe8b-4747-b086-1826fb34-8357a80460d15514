# Abyssal Infinite: the details

How each part of the game works and where it lives in the code. For what the game is and how to play it, see the
[README](README.md).

## How it works

- The world is an endless grid of 48 m tiles. Up to 8 × 8 tiles around you are loaded (384 m across; 7 × 7 at the medium draw distance, 6 × 6 at the near one; the water hides anything further away).
- A tile's rock is sculpted on your graphics card, a few slices per frame. A background worker then turns it into the sea floor mesh and grows the kelp, plants, rocks, sponges, corals, fish schools and mantas on it. The frame loop only uploads the finished tile, so swimming stays smooth while the world is built ahead of you.
- **A place is the same every time you return.** Rock density is a pure function of position, and every random choice is seeded by where it happens (the tile, or the cell a kelp column stands in), never by the order things were built in.
- The skylight volume, the ground map and the shadow map wrap around with the period of the loaded window, so a new tile only rewrites its own patch of each.
- The hand-made home region of the original (canyon walls, arches, the ship, the whale tail, the six viewpoints) is still there, around the origin. Further out, the same noise-driven rules take over.
- **Formations far from home.** The world is cut into 160 m cells, and each cell decides from its own seed whether it holds a formation (`cellShapes` in `layout.js`): on the shelf an arch, a pillar with a window, a canyon between two walls, a spire that reaches the surface or a wall with tunnels; on the plain a field of hydrothermal chimneys. The ship and the whale tail stay at home.
- **A sea with a profile.** The sea floor follows one profile along x (`seaBase` in `math.js`), and each zone has its own relief and life:
  - **Shore** (east, about 1.5 km from home): pale rippled sand, sand bars lying along the coast, sea grass, coral reefs in the sunlit shallows, few rocks. The camera stops where the water gets too shallow.
  - **Shelf**: the home region and more terrain like it, 45 m down: kelp forests, plateaus, formations.
  - **Slope** (west, from the shelf break at 300 m): the floor steps down in terraces and is cut by canyons that run down it; rougher, ledged rock; the kelp ends where the light does.
  - **Abyssal plain** (from about 4 km west, 565 m down): flat sediment with long low hills, knolls, fields of pillow lava and of nodules, chimneys that steam. Few fish, hardly any plants.
  The 60 m band of voxels follows the floor, and the camera's exposure adapts to the glare of the shallows and the dark of the deep (where the water keeps a faint glow of its own, so you can still make out shapes).
- **A curtain of haze.** Nothing is drawn past 135 m, which is closer than the nearest tile still loading, and the window of loaded tiles runs a little ahead of a swimming camera.
- **Water.** The menu's *Water* row switches between *Lagoon* (the original's green-blue haze), *Clear* and *Crystal* (bluer, with a longer view, like an aquarium; the default on a first visit): `WATERQ` in `quality.js`.
- Everything is drawn with **WebGPU** directly. No game engine or 3D library is used.
- The ship, whale tail, mantas, fish, corals and all ten playable creatures are built from simple mathematical shapes.
- The sound, including every creature's voice, is synthesized live with the Web Audio API.
- It's built to run smoothly. With the resolution on auto it aims for 60 fps by lowering first the resolution and then how far away plants and rocks are drawn, in small steps. The scene is already running, blurred, behind the start menu, so most of that tuning is done before you dive in. When the graphics card has time to spare at full resolution, the distances at which kelp, rocks and corals get their finer shapes and relief move out, up to 2.5 times, and come back first when the frame fills up (`lk` in `source/src/main.js`; key `H` shows it as "detail").

## The deep: keys 7-0

Keys `7` to `0` jump to four more viewpoints, far apart and each deeper than the last:

- over the gorge (its rim is 55 m down);
- over the rift (rim at about 70-90 m, bed at nearly 300 m);
- a rock formation on the continental slope (about 200 m);
- a formation far out on the abyssal plain (about 555 m).

Their positions are found when the world loads (`DEEPS` in `main.js`).

## The gorge

The gorge is a crack in the upper slope, 720 m west of home, that runs north and south without end. It has sheer
rock walls up to 36 m high, caves in those walls, and a winding bed that widens, narrows and changes depth.

In the code: `GORX` and `gorgeX` in `math.js`, shaped in `W_DENS`. 36 m is as deep as a sheer wall can be inside one
60 m band of voxels, so the band is lowered in a strip around the gorge.

## The rift and tall tiles

The rift is a chasm 200 m deep and 16-40 m wide, 980 m west of home. It narrows toward its bed and steps out in
ledges, with caves in its walls and vents on its bed. Life thins out on the way down.

A wall that high does not fit into the voxel band, so the three columns of tiles the rift runs through are *tall*:
their voxel blocks reach 201 m further down. A tall tile goes through the same pipeline as any other tile, but with
348 layers instead of 80:

- its density is computed over 24 frames instead of 8;
- the worker's `genTile` takes the block's height;
- the collision lookup and the shadow pass use the tile's own height.

The skylight texture keeps its 40 layers, spaced further apart over the rift (`bandH`). Outside those three columns
nothing changes: a test tile's buffers have the same fingerprint before and after.

In the code: `RIFX`, `riftX` and `riftDepth` in `math.js`; `tileNY` and `tileOY` for the tall tiles.

## Creatures

Ten species swim around you as bots. The world has no global population: a couple of dozen creatures live near the
camera, the ones you leave behind are removed, and new ones arrive from beyond the haze, mostly ahead of you. Each
species keeps to its own depths, so you meet different animals as you go deeper. Hunters chase anything they can eat
(up to 60% of their own length; the whale hunts nothing), prey bolts, and bots eat what they catch. The crab walks
the floor and steps off ledges, the dolphin leaps, and the whale comes up to the surface. The schools of small fish
from the original are still there, unchanged. Where crabs live, a few are always kept within 36 m of the camera
(four, or six when you play a crab; the end of `botPopulate`): if the company is full, the farthest other bot
makes room for them.

Sizes: `real` in `CRIT` is the animal's real length, and that is the number shown to the player. The game draws
everything at `GSCALE` = 1.87 times life size, to match the original's manta (8.4 m across, where a real oceanic
manta averages 4.5 m).

Creature shadows are not part of the baked shadow map, because the creatures move. Instead, the few animals that
matter most to the current view are passed to the scene as capsules, and the terrain shader darkens the ground under
each one along the sun's direction. The higher the animal swims, the wider and fainter its shadow.

In the code: `creatures.js` holds the species' stats and procedural meshes, `bots.js` their behavior, and `W_CRIT` in
`shaders.js` the swimming motion and colors. Shadows are `critSh` in `shaders.js` and `botShadows` in `bots.js`.

## Playing a creature

The creature button in the menu shows your current creature, next to the name other players see. It opens the
**Creature** panel, where you can pick any of the ten species or the free camera. For each species the panel shows a
model you can turn around, its real size, its speed, its depth range, what it eats and what eats it.

**Moving.** The mouse turns the view around your animal, and the keys steer relative to the view, as in most
third-person games: `W` swims where you are looking, `S` swims back toward the camera. `A` and `D` go to the left and right of the view. The direction is taken from the camera all the time, so turning the camera while a key is held steers the creature with it.
The body turns toward its heading as fast as that species can, and keeps its heading when you let go of the keys.
The camera follows from behind and rises where rock is in the way. The mouse wheel moves it closer or further out;
fully zoomed in, it sits just above the animal's back.

**Speed.** Holding a key swims at the species' normal speed. Holding `Shift` is a dash that lasts almost ten seconds.
Tapping `Shift` twice is a one-second burst at two and a half times the normal speed. For the crab, the burst is a
sideways dart in the direction the view is turned.

**Obstacles.** When you run into rock, or into the ship's timbers, your creature slides along the surface instead of
stopping, and a head-on hit carries it up and over. Its nose is stopped as well as its body, so the head does not
poke through a wall or a plank. A crab slides along a wall the same way.

**Each species moves in its own way.** The crab walks sideways along the floor and drops off ledges. The dolphin and
the whale leap when they break the surface at speed.

**Staying alive.** Your creature has a health bar above its stamina bar. Health drains on its own over seven minutes,
food restores it, and each bite you take removes a chunk. At zero the creature dies and you come back as a new one
of the same species. The left mouse button uses the mouth:

- A hunter eats any creature within reach that is no longer than 60% of its own length.
- The fry and the chromis pick at plankton. The whale filters it as it swims.
- The crab strikes another crab nearby, and the other crab fights back. With no crab nearby, it picks food off the
  floor.

**Crab fights** work the same against a bot and against another player. A strike takes 14% of the other crab's
health (8.5% if the striker has lost a claw) and shoves it back a little. It lands only where the claws can touch:
the other crab has to be ahead of the striker and within 0.53 m, middle to middle (face to face, claws on claws). A crab that strikes or blocks
turns its claws to where the view looks. Holding the right mouse button raises the
claws: a crab with its claws up takes only 30% of a strike and cannot lose a claw, but cannot strike either. An
unblocked strike tears off a claw one time in ten; a crab with no claws cannot strike or block. A lost claw grows
back in 45 seconds, one at a time. A crab whose health runs out lies on its back for eight seconds. If the winner
eats it in that time, it dies and the winner is fed; if not, it gets back up with a quarter of its health and
without its claws. A crab's next life starts weak, with 30% of its health and one claw, so the loser cannot come
straight back at a wounded winner. The numbers are `STRIKE`, `BLOCK`, `CLAWP`, `CLAWT`, `DOWN`, `REACH` and `FRONT` in `bots.js`, and the same ones in both servers for fights between players.

Other creatures treat you as one of their own: hunters chase and bite you, prey flees from you. A hunter loses
track of prey it cannot see, so you can hide behind rock, and also behind things you can swim through: a loose
boulder, the ship, kelp.

**Gurgling** is how players "talk". Hold the right mouse button and your creature gurgles: its mouth moves, bubbles
rise to the surface, and you hear that species' own sound. All species are equally loud. The dolphin whistles and
clicks, and the whale sings, as the real animals do. A gurgle carries about a ship's length (34 m; a dolphin's twice and a whale's three times as far, and that much
further off their own kind answers: `gurFar` in `creatures.js`), gets quieter with
distance, and comes from the right direction. A nearby bot of the same species gurgles back, whether the gurgler is
you or another player. A crab stops, turns to face whoever it is answering, and raises its claws instead of opening
its mouth. While it does, hunters up to seven times its length (the perch, the barracuda) turn away from it.

**The ship.** Small animals can slip through a breach in the hull or a gap in the deck. Large ones cannot.

In the code: `picker.js` is the Creature panel, and the choice is stored in `localStorage.abyssalMe` (-1 is the free
camera). The player's creature is one of the bots, steered by `meStep` in `bots.js`; survival is at the end of that
file. Gurgling is `botGurgle` in `bots.js` and `gurgle` in `audio.js`. What counts as cover is each tile's `cover`
list (`gen.js`). The ship is a mesh, not rock, so it has its own collision field (`shipBuild`, `shipD` in `bots.js`):
the distance to the nearest timber, sampled on a quarter-meter grid built from the mesh at load time. An animal is
stopped wherever that distance is smaller than its own thickness.

## The sonar

While you are diving, a soft disc in the corner shows every creature within 100 m (`sonarDraw` in `bots.js`). A
distant creature is a wide blur that tightens into a sharp dot as it gets closer, and echoes fade toward the edge of
the disc. When you play a creature, the color tells you what each echo means to your species: something you can eat,
something that can eat you, or neither. With the free camera, the color runs from pale for harmless animals through
amber to red for the big hunters. Other players are labeled with their names. A green crescent at
the rim shows the way home once you are more than 50 m from it. The disc's range is 100 m; the `Z` key, or a tap on
the disc, brings it in to 50 m and to 25 m, to tell apart what is close (`sonarZoom` in `bots.js`; the range is
written at the bottom of the disc).

## Multiplayer

Everyone shares one sea. It can be served by Cloudflare Workers or by your own server (OpenResty, which is nginx with
Lua). [`server/README.md`](server/README.md) explains how to run and deploy both.

The server only relays players. Each browser runs its own bots and generates its own terrain. On the client
(`source/src/net.js`), another player is one more entry in `bots`, moved by what the server relays. You see them,
their name appears on the sonar, you hear them gurgle from where they are, and you can bite them with the left mouse
button like anything else. The server checks each bite and notifies the player who was bitten. The name field in the
menu is what other players see. A page opened from a file, or from a host without the server, plays alone.

The limits are set to match each other (`source/src/bots.js`, `server/src/sea.js`, `server/openresty/sea.lua`):

- The server tells you about at most the 40 nearest players, which is also how many the game draws.
- Your own bots make room for players: from 26 bots when nobody is near (20 on Medium, 14 on Low) down to 8 (6 and
  4), so the sea is never players only.
- A full sea (100 players on Cloudflare, 300 on your own server) turns newcomers away. They play alone with the bots
  and are let in automatically as soon as a place frees up.

## Detail levels

The **Detail** row in the menu's **Graphics** panel picks the detail level; the current one is lit. Each level is the same world, built with less in it, and with fewer creatures around you (26, 20 or 14; the **Creatures** row of the World panel halves or doubles that):

| Level | What it is | Used before any level is chosen, on |
|---|---|---|
| **High** | The full scene | - |
| **Medium** | Every graphics setting in the middle: the 105 m draw distance, half of the sparkles and pebbles and three eighths of the leaves, the medium shadow map (small rocks, sponges and corals cast no shadows), low light rays, a few creature shadows, waves, no anti-aliasing, 60 fps; three quarters of the scattered rocks | Computers |
| **Low** | Every graphics setting at its least: the 80 m draw distance, an eighth of the leaves (a quarter by the Plants setting, and half of those), the smallest shadow map, no anti-aliasing, no light rays, no creature shadows, a flat surface, 30 fps; half of the scattered rocks, coarser rocks and corals, 480p to start with | Phones, and computers with 4 GB of memory or less |

A first visit asks which level to build before anything is compiled: three buttons on the loading screen, Low lit for everyone (`#z` in `source/template.html`, asked in `source/src/quality.js`). The answer is kept at once, so the question comes only that one time; later the level is changed in the menu. If loading crashes the tab, or the graphics driver gives up, the page starts again one level lower. Your browser remembers the level, the resolution the scene settled on, and your graphics, world and sound settings for the next visit.

## Graphics settings

The **Graphics** panel in the menu overrides what the detail level chose: draw distance (80 / 105 / 135 m),
resolution (auto for 60 fps, or a fixed 50 / 75 / 100 %), frame rate (30, 60 or uncapped; Low starts at 30, Medium at 60, and with 30 the auto resolution aims for 30), plant density, shadow map size, anti-aliasing, light rays,
creature shadows and the sea surface. Choosing a detail level resets them. The settings take effect after a reload: when you leave the
panel with changes, the game asks whether to apply them and reload, discard them or keep editing. After that
reload you are where you were, not at home: the world is built around the same spot with the same view, and your
creature and its health come back when you dive. The same happens on every visit: once you have dived the browser
keeps your place (`localStorage.abyssalAt`, `keepAt` and `back` in `source/src/main.js`), and the next time the
page opens the sea is built there; key `1` takes you home. They are
stored in `localStorage.abyssalGfx` (see `source/src/quality.js`).

**Surface** chooses what the sea looks like from below. **Flat** is a level sheet whose
ripples come from a moving water texture. **Waves** (the default on Medium and High) runs a simulated sea on the GPU every frame and draws the
surface from it: an FFT ocean (a wind sea plus swell, three cascades of 128 x 128 samples over patches of 89, 17.3
and 3.7 m; `WN`, `WC`, `WL`, `WLOOP` in `source/src/quality.js`) lifts a fan of rings around the camera and gives the
slopes that bend the light (`source/src/waves.js`, `surfW` in `source/src/shaders.js`). The simulation is taken from
[web-ocean](https://github.com/Noniv/web-ocean) by Maksymilian Dendura (MIT), cut down to what is seen from under
water. It costs about 2 ms of GPU time a frame on a desktop card; if its shaders fail on a device, the flat surface
is drawn instead. The caustics on the ground, plants and
creatures and the light rays follow the same waves: the simulation also gives the curvature of the surface, and the
light at a point is what the waves over it focus there, softer the deeper it is (`caus`, `wcur` and `W_RWV` in
`source/src/shaders.js`). With the waves the sky in the window
overhead is the sky of the hour set in the World panel: its own colours overhead and at the horizon for morning,
noon, evening and night, drifting cumulus clouds that hide the sun's disc and shade each other (the low cloud layer
of web-ocean), and stars at night (`W_SKY`, `W_SKYW` in `source/src/shaders.js`; `zen`, `hor`, `cl`, `cov` in
`DAYQ`). A device that cannot run the simulation turns the setting off by itself.

The draw distance is a single number for everything: the water's haze closes in at that distance, and every draw
limit and fade sits behind it. While tiles ahead are still being generated, the haze is pulled in to what is already
loaded, so nothing pops into view.

## World settings

The **World** panel in the menu, between Graphics and Sound, holds what the sea itself is like. Like the graphics
settings, its choices are compiled into the shaders and the world's buffers, so leaving the panel with changes asks
whether to apply them and reload (going from Graphics to World and back does not ask). They are stored in
`localStorage.abyssalWater` and `localStorage.abyssalWorld` ("creatures,time,colours,floating rocks"; see `source/src/quality.js`).

| Row | Choices | What it does |
|---|---|---|
| **Water** | Lagoon, Clear, Crystal | The haze: how green or blue the water is and how far you see (`WATERQ`) |
| **Creatures** | Few, Medium, Many | Half as many, the usual number, or twice as many creatures around you (`POPK` scales `BOTN`, `BOTMIN` and each species' `near` in `bots.js`). With Few there is less to eat, so health drains half as fast: over fourteen minutes instead of seven |
| **Time** | Morning, Noon, Evening, Night | Tints the sunlight, the water's own light and the sky seen through the surface (`DAYQ`: `sun`, `sky`, `win`). The sun does not move: the baked shadows and skylight stay as they are, only colour and brightness change. Night is deep blue with a moon where the sun was; the glowing plants and sparkles stand out |
| **HUD** | Off, On | Hides or shows the sonar and the lines at the bottom left (the creature's name, its health and stamina bars, messages). It takes effect at once, with no reload (`HUD` in `quality.js`, `localStorage.abyssalHud`) |
| **Colours** | Vivid, Natural | Vivid is the original palette with magenta carpets, violet sponges and turquoise leaves. Natural (`NAT`) swaps them for the greens, olives, rusts and ochres of a real sea, thins the algae on the rock and lays grainy sand with small stones on the level ground, with more pebbles in their own colours, meadows of sea grass and tufts of tall green ribbons (leaf type 8, `meadow` in `gen.js`). It also gives the light on things back some of the red the water took (`LITK`, from `DAYQ.nat` for each time of day, and `LITA`), so that sand looks like sand and rock is grey and brown rather than turquoise |
| **Floating rocks** | Off, On | The clusters of boulders that hang in the water over the sea floor (`FLOAT`; placed in `genTile`, `BOULD` at home). Off unless you turn them on |

## Sound settings

The **Sound** panel in the menu has five levels, each off / low / medium / high. Changes are heard right
away. Until you set them, the volume and the water are low, the music and the sea life medium, the gurgling high:

- the overall volume;
- the water (rumble, surface wash, rush);
- the music (drone and chimes);
- the sea life (bubbles, distant whale calls);
- the gurgling of players' creatures.

They are stored in `localStorage.abyssalSnd` (see `source/src/audio.js`).

## When the screen stays black

Add `?debug` to the address. The page then shows, over the game, what the browser reports about its GPU, the first
WebGPU and script errors, the pipeline an error belongs to (its entry points and the start of its vertex shader)
and the state of the sound - what a phone has no console for (`DBG` and `dbg` in `source/src/gpu.js`).

Pipelines are built with `createRenderPipelineAsync` / `createComputePipelineAsync` (`RP`, `CP` in
`source/src/gpu.js`), all of the main ones at once. The plain calls compile on the main thread of the browser's GPU
process: with a damaged shader cache of the graphics driver that took so long in Edge that every tab froze and the
browser's watchdog killed the process, again and again.

Two things Safari needed, kept in mind when changing the code: a pipeline must not be given an override constant
that its vertex stage does not use (Safari fails to build it, and one failed pipeline leaves every frame black), and
after the screen was locked the sound has to be restarted from a tap (`sound` in `source/src/audio.js`). With the
phone in silent mode the sound plays in Chrome but not in Safari.

## Controls

| | Keyboard & mouse |
|---|---|
| Look around | Move the mouse |
| Swim | `W` `A` `S` `D` |
| Up / down (free camera) | `E` / `Q` |
| Swim faster | Hold `Shift` |
| Burst of speed (playing a creature) | `Shift` twice |
| Bite, strike with the claws, feed (playing a creature) | Left mouse button |
| Gurgle (playing a creature) | Hold the right mouse button |
| Camera nearer, further (playing a creature) | Mouse wheel |
| Jump to a viewpoint | `1` to `6` in the home region, `7` to `0` in the deep |
| Menu | `Esc` releases the mouse and opens the menu: on the left **Resume** (with a Home button before it), the creature button and your name when there is a multiplayer server; on the right the **Controls**, **Graphics**, **World** and **Sound** tabs; what does not fit under them scrolls |
| Sound on / off | `M` (sound starts when you dive in) |
| Sonar range | `Z` |
| Performance stats | `H` |

**On a phone** one finger does the swimming: hold it down to swim forward, slide it to steer, add a second finger to
go faster. While you play a creature, three round buttons sit beside the sonar: the mouth (**Bite**, or **Strike**
for the crab), **Gurgle** (held; **Block** for the crab) and **Burst**. The **Scheme** row of the menu's Controls tab switches to
a **Joystick** instead: the left thumb is a stick to swim by - forward, back and sideways, and faster when pushed far
out - and the right thumb turns the view. The **−** and **+** buttons beside the menu button move the camera further and
nearer, and a short tap on the sonar changes its range. The menu's dive button has a square Home button before it (a phone has no key `1`; on a computer it appears once a dive has begun): it puts you at the first viewpoint and resumes. The choice is kept in `localStorage.abyssalTouch`; the code is `touch` in
`source/src/main.js`. On a first visit a phone is proposed the Low detail level.
| Detail level, graphics | **Graphics** in the menu (applying them reloads the page) |
| Water, number of creatures, time of day, colours | **World** in the menu (applying them reloads the page) |
| Volume of water, music, sea life, gurgling | **Sound** in the menu |

The seabed, cliffs and arches are solid: you glide along the rock instead of swimming into it, and you still fit through every tunnel and arch. You can swim through kelp, plants, corals, sponges, loose rocks, the floating boulders and the whale tail. The ship stops creatures at its timbers, but the free camera passes through it.

**On a touchscreen:** hold one finger down to swim forward and slide it to steer. Put a second finger down to go faster. The menu button in the corner opens the menu. Phones always show the scene in landscape and start on Low detail. (Touch support is experimental.)

## Make it your own

The readable source code is in the [`source`](source) folder. To change something and rebuild `index.html` you need [Node.js](https://nodejs.org) 18 or newer:

```bash
cd source
npm install
npm run build
```

This writes a new `index.html` next to this README, and a copy for the multiplayer server in `server/public`. `npm run build:readable` writes an unminified version instead, which is easier to debug in the browser's developer tools.

`npm run build:dev` writes a separate `dev.html` with extra tools that are not part of `index.html`: `F` flies the camera along a one-minute path through the home region, and `B` runs that flight as a benchmark and reports frame and GPU times.

| File | What's inside |
|---|---|
| [`source/src/layout.js`](source/src/layout.js) | The hand-made home region: rock walls, arches, tunnels, the purple zone and the magenta patches |
| [`source/src/gen.js`](source/src/gen.js) | The tile generator (runs in web workers): terrain mesh, kelp forests, plants, rocks, sponge gardens, fish schools, mantas, skylight, collision. **A good place to start.** |
| [`source/src/stream.js`](source/src/stream.js) | The endless world: which tiles are loaded, the density computation on the GPU, uploads, wrapped shadow map, culling and drawing of tiles, collision lookup |
| [`source/src/meshes.js`](source/src/meshes.js) | The ship, whale tail, manta, fish, boulders, sponges and corals, built from simple shapes |
| [`source/src/creatures.js`](source/src/creatures.js) | The ten species: their sizes, speeds, depths and procedural bodies |
| [`source/src/bots.js`](source/src/bots.js) | How the creatures behave around the camera, the creature you play, survival, gurgling, the sonar, and how many creatures there are |
| [`source/src/picker.js`](source/src/picker.js) | The menu's creature panel |
| [`source/src/net.js`](source/src/net.js) | Multiplayer, client side: the connection, and other players among the creatures |
| [`server`](server) | Multiplayer, server side: for Cloudflare Workers and for OpenResty, with its own README |
| [`source/src/gpu.js`](source/src/gpu.js) | The renderer's setup: device, textures, samplers and pipelines |
| [`source/src/waves.js`](source/src/waves.js) | The simulated sea behind the Surface: Waves setting (FFT ocean from web-ocean) and its surface mesh |
| [`source/src/shaders.js`](source/src/shaders.js) | The look: water and fog colors, lighting, kelp, rocks, the water surface and light rays (WGSL shader code) |
| [`source/src/main.js`](source/src/main.js) | Loading, the frame loop, the camera, the controls, the six viewpoints and the camera path the home region is laid out around |
| [`source/src/audio.js`](source/src/audio.js) | The soundscape |
| [`source/src/quality.js`](source/src/quality.js) | The detail levels and the graphics, water and sound settings: what a device starts on, and what is remembered between visits |
| [`source/src/math.js`](source/src/math.js) | Noise, random numbers and mesh-building helpers |
| [`source/src/fit.js`](source/src/fit.js) | The menu's size on the screen (the page's rem fitted to the screen), and the scroll rail under the tabs (a small script run before the game's own) |
| [`source/src/dev.js`](source/src/dev.js) | Development tools (fly-through, benchmark, hooks for automated tests), only in `dev.html` |
| [`source/template.html`](source/template.html) | The page around the scene: loading bar, menu and its panels, links and their styles |

Some easy first tweaks:

- **Water color:** the three water presets in `WATERQ` in `quality.js` (`col` is the color), and `PCOL` (purple grotto) near the top of the shared scene code in `shaders.js`
- **Sunlight color:** `SUNC` right next to `PCOL`
- **Brightness and light rays:** `EXPO` and `RAYS` in `main.js`
- **Swimming speed:** for the free camera, search for `26 : 7` in `main.js` (fast speed : normal speed); for a creature, `spd` in `CRIT` in `creatures.js`
- **How much world is loaded:** `LW` in `stream.js` (tiles across the loaded window, by the draw distance, at most `WIN`), `WIN` (the most, a power of two) and `TILE` in `math.js`
- **What grows far from home:** the noise-driven rules in `gen.js` (`kelpDens`, `hot`, `zw`, the fish and manta dice)
- **How many creatures there are:** `BOTN` in `bots.js` (and `POPK` in `quality.js` for the menu's three steps)

`dev.html#offscreen` renders into a texture instead of the canvas and exposes `window.abyssal` (see `dev.js`) for automated tests.
