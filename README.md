# Murmuration Simulator

A high-performance 3D bird flocking simulation using Three.js, choreographed into an ever-evolving, music-reactive visualizer.

![Murmuration](https://via.placeholder.com/800x400/0a0a0f/ffffff?text=Murmuration+Simulator)

## Features

- **Biologically Accurate Flocking**: Implementation of Craig Reynolds' Boids algorithm (1986)
- **Choreographed Show**: A director sequences eleven scene archetypes (vortex, halo, shell, spiral, column, currents, hunt, nebula, binary, comet, murmuration), re-rolled with fresh geometry every time, and crossfades them on musical phrase boundaries
- **Force Fields**: Vortices, surface attractors, curl-noise wind, predators / leaders and bass shockwaves sculpt the flock on top of the boid rules (shared between the JS and Rust cores)
- **Rhythm Tracking**: Spectral-flux onsets, tempo estimation with a phase-locked beat clock, kick / snare / hat envelopes and drop / breakdown detection
- **Living Colour**: Position, heading and palette colour modes blended per scene, slow hue drift, beat-synced size and flash, glints, trails and bloom with filmic tone mapping
- **Evolution**: every bird carries a genome (lineage hue, speed trait, cohesion gene). Birds prefer to align with kin, keep their distance from rival lineages, gain energy in good company and lose it when isolated or crowded, and starving birds are replaced by a mutated copy of their best-fed neighbour, spawned beside it. Colour therefore records ancestry, and the flock's character genuinely evolves while music plays. Kicks raise mutation, drops trigger mass extinctions of the dominant lineage, breakdowns let diversity recover.
- **Music drives speed**: flight speed follows a musical-energy envelope built from loudness against a slow (about one minute) ceiling, so a long relaxed passage really slows the flock (about half speed) while a drop pushes it past full speed; the `Music → Speed` slider fades the coupling
- **Instrument Groups**: each lineage-colour quadrant answers one band. Bass birds swell on bass hits (the kick shockwave still moves the whole flock), low-mid birds punch bright on snares and claps, lead birds bloom on new melody notes, and treble birds glitter on hi-hats. Kin flocking keeps each group together, so an instrument lights a coherent region of the flock; the `Instrument Groups` slider sets the strength (`?groups=0` turns it off)
- **Camera Autopilot**: Sweeping orbits that follow the flock's centre of mass and lean into the beat, and never lose the flock: the camera backs out as the swarm expands and zooms in lazily as it contracts, with a capped dolly speed so it never pops; grab the camera any time and it eases back in when you let go
- **High Performance**: Spatial partitioning (JS) and a Rust/WASM core enable 5,000+ birds at 60 FPS
- **Interactive Controls**: Real-time parameter adjustment via lil-gui
- **Presets**: Multiple configurations (tight swarm, loose flock, chaotic, massive)

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## Controls

### Mouse
- **Orbit**: Click and drag
- **Zoom**: Scroll wheel
- **Pan**: Shift + drag

### Keyboard
- **Space**: Pause / Play
- **N**: Next scene
- **A**: Toggle autopilot (off = your sliders drive the flock)
- **C**: Toggle camera autopilot
- **T**: Toggle trails
- **G**: Toggle bloom
- **X**: Extinction event (drains the dominant lineage)
- **R**: Reset flock
- **F**: Toggle fullscreen
- **S**: Take screenshot
- **H**: Hide/show GUI
- **B**: Toggle benchmark logging (prints frame/simulation timing in console)
- **P**: Toggle the performance HUD (fps, sim ms, live bird count, auto-quality state)

### Show panel (GUI)
- **Autopilot**: let the director drive behaviour parameters and force fields
- **Scene**: `auto`, or pin one archetype
- **Intensity**: scales how hard the music pushes the show
- **Music → Speed**: how strongly musical energy scales flight speed (1 = full curve, 0 = fixed scene speeds); the read-only **Energy** field shows the envelope
- **Trails / Bloom / Camera Autopilot / Scene Label** toggles

### Motion & Performance panel (GUI)
- **Speed ×**: global flight-speed multiplier (0.25–4). Scales the director's speed targets and
  the force fields together, so shapes hold at any speed
- **Sim Steps / Frame**: extra simulation steps per rendered frame (1–4). Pure extra speed with
  identical dynamics; costs proportionally more CPU
- **Neighbour Cap**: neighbours sampled per bird per step (default 64). Lower = cheaper,
  higher = slightly tighter lineage sorting
- **Auto Quality**: grows the live flock toward *Max Birds* while the frame budget holds and
  backs off (resolution first when GPU-bound, then birds) when it breaks
- **Perf HUD (P)** and **Live Birds** readout

URL parameters set these up for testing: `?birds=12000&speed=2&steps=2&neighbors=64&quality=off&hud=1&musicspeed=1`.

### Evolution panel (GUI)
- **Evolution**: enable the energy economy, death and division (only acts while audio plays)
- **Kinship**: how strongly birds align and cohere with their own lineage
- **Rivalry**: repulsion between distant lineages (membranes between colour domains)
- **Mutation**: hue / trait drift per division
- **Lineage Colour**: share of the colour mix given to inherited hue
- **Lineages / Dominant %**: live readout of distinct lineages and the largest one's share

### Touch / Mobile
- **🎵 Load MP3/WAV button** (bottom-left): Opens file picker and loads local audio for reactivity
- Open the page with `?hud=1` to watch Auto Quality find the phone's bird limit; the HUD shows
  the settled count and whether the device is CPU-bound (sim) or GPU-bound (post-processing)
- **Tip**: MP3 and WAV are supported. If playback is silent, try selecting the file again after tapping the page first (mobile autoplay policies).

## Parameters

### Flocking Behavior
| Parameter | Default | Description |
|-----------|---------|-------------|
| Visual Range | 40 | Neighbor detection radius |
| Protected Range | 8 | Personal space radius |
| Cohesion | 0.0005 | Attraction to flock center |
| Separation | 0.05 | Avoidance force |
| Alignment | 0.05 | Velocity matching |

### Movement
| Parameter | Default | Description |
|-----------|---------|-------------|
| Min Speed | 3 | Minimum velocity |
| Max Speed | 6 | Maximum velocity |
| Turn Factor | 0.2 | Boundary avoidance strength |
| Margin | 50 | Boundary trigger distance |

## Architecture

```
src/
├── main.js              # Entry point, animation loop
├── config/defaults.js   # Default parameters & presets
├── audio/
│   └── AudioAnalyzer.js # Band energies, onsets, tempo / beat clock, sections
├── director/
│   ├── Choreographer.js # Scene scheduling, crossfades, beat-synced layers, visual state
│   ├── scenes.js        # Scene archetypes (randomised on every build)
│   ├── CameraDirector.js# Autopilot camera that follows the flock
│   └── Noise.js         # Value / fractal noise and wander helpers
├── fields/
│   └── FieldLayout.js   # Shared force-field buffer layout + JS evaluator
├── scene/
│   └── SceneManager.js  # Three.js setup, trails + bloom post-processing
├── boids/
│   ├── Boid.js          # Individual boid logic (+ field forces, personality)
│   ├── Flock.js         # Flock management
│   ├── FlockRenderer.js # THREE.Points rendering (position, velocity, seed attributes)
│   ├── RustFlockAdapter.js # WASM bridge (positions, velocities, field buffer)
│   └── SpatialGrid.js   # O(n) neighbor lookup
├── shaders/
│   ├── color-vertex.glsl   # Position / heading / palette colour modes
│   └── color-fragment.glsl # Particle rendering
└── controls/
    └── GUIControls.js   # lil-gui interface
rust/boids-wasm/src/lib.rs # Rust core: boids + the same force fields (`apply_field`)
```

## Silence, shapes and cymatics

- **Silence is the ground state.** With no track, or after 1.5 s of silence inside one, every
  field fades out, the minimum speed drops to near zero and a per-frame velocity damping lets
  momentum decay over a few seconds. The birds float in a soft bubble with a faint current and
  Brownian jitter, like dust suspended in still water. Sound re-enters this medium rather than
  switching between looping scenes.
- **Circularity monitor.** The simulation reports the flock's normalised angular momentum about
  its centroid (1 = a pure mill). If it stays above 0.55 for about six seconds, a shear
  counter-field tears the mill apart, the vortex is muted, rotational archetypes are
  down-weighted for the next scene choices and a milling scene is cut short. The Perf HUD
  shows circularity and the number of spin breaks.
- **Containment shapes.** Each scene instance rolls a sphere, an ellipsoid, a rounded box or a
  slab, so the arena itself no longer pushes everything into a ring.
- **Layered cymatics.** Four standing-wave fields, one per band (bass, low-mid, vocal, treble),
  act like a 3D Chladni plate: birds steer onto the nodal sheets and flow along them. The
  band's dominant pitch sets the wavelength (bass carves big lobes, treble fine ripples), the
  vocal pitch class rotates the second wave vector so a chord change reshapes the nodes, the
  tempo slides the phase, and a feedback term keeps a node through the flock's own centre so
  the pattern follows the birds. Lineages are tuned to bands by hue, so colours separate by
  instrument and selection favours whichever lineage fits the current mix. The **Cymatics**
  slider scales all layers (1 = default, 0 = off).

## How the show evolves

1. **Scenes** are archetypes, not presets. Each time one is chosen it is rebuilt from a random generator: axis tilts, radii, path shapes, spin direction, flow wavelengths and timing all differ, so no two plays of "Vortex" look alike.
2. **Force fields** are written to a flat `Float32Array` (see `src/fields/FieldLayout.js`) every frame and evaluated per bird by whichever core is running. The Rust implementation in `lib.rs` mirrors the JS one index-for-index.
3. **Transitions** crossfade the fields and parameters over a few seconds. Shapes dissolve, then re-form, instead of popping. When the beat clock is locked, scene changes wait for the next bar; detected drops and breakdowns cut early.
4. **Rhythm** drives the fine detail: kicks launch shockwaves and swell the particles, hi-hats add nervous jitter and glints, bass breathes the shape radii, and the beat phase pulses the camera distance.
   **Energy** drives the pace: the analyser reports loudness against a slow ceiling (the fast one re-normalises within ten seconds, which made relaxed passages look as busy as drops), and the choreographer turns it into a fast-attack, slow-release envelope that scales each scene's min and max speed from roughly 0.35x (quiet intro) through 0.55x (relaxed passage) to 1.3x (drop).
   **Instrument groups**: the analyser detects hits per band from spectral flux against each band's own ceiling and running mean. A kick leaks into every band, so each upper band learns its usual flux on a bass hit and, on a coincident frame, only fires when it clearly exceeds it (a backbeat clap passes, the kick's click does not). The lead band also fires when the tracked melody pitch settles on a new semitone. The shader maps each bird's lineage hue quadrant to a band (the same mapping as the cymatic band affinity) and applies that band's gesture.
   **Framing**: a few hundred sampled birds are projected in the camera's own basis every frame to find the distance at which 99% of them fit inside the frame with a 15% margin (portrait screens widen the vertical field of view instead of retreating). The scene's preferred distance is floored at that fit; expansion is anticipated and followed quickly, contraction lazily, and the dolly is capped at 15% of the distance per second out and 6% in. The Perf HUD shows `extent / fit / pref / cam`.
5. **Evolution** (inspired by artificial-life "soup" simulations): genomes are heritable, selection acts through an energy economy, and division spawns offspring beside the parent, so colour domains grow, split, invade and die out over minutes. A rarity bonus stops any one lineage from taking over, and the `Lineages` readout in the GUI shows diversity live.
6. **Nothing loops**: every slow modulation runs on multi-octave value noise with incommensurate frequencies, palettes re-roll every 25-65 s, and birds carry individual "personality" traits that vary their speed and how strongly they respond to the fields.

## Color System

Colors are computed in the vertex shader from three blended modes, weighted per scene:

- **Position**: hue from the XY angle around the origin, shifted by depth; lightness falls off with distance
- **Heading**: hue from the bird's flight direction, brightness from its speed, so turning waves ripple through the flock
- **Palette**: a slowly cycling three-colour gradient that re-rolls every so often
- **Lineage**: the bird's inherited hue, brightness from its energy (dominant when Evolution is on)

A global hue drift, beat-synced size pulses and flashes, per-bird glints, afterimage trails and bloom are layered on top.

## Performance

The simulation uses several optimization techniques:

1. **Flat spatial grid** (Rust core): counting-sort of birds into cells each step, no hashing
2. **Neighbour cap**: each bird evaluates at most *Neighbour Cap* candidates from its 3×3×3 cell
   block, stride-sampled so cost is O(birds × cap) however tightly the flock packs
3. **Cache-ordered memory**: birds are reordered by cell every 8 frames so neighbour reads stream
4. **WASM SIMD** (`+simd128`, opt-level 3) via `rust/boids-wasm/.cargo/config.toml`
7. **Multi-threaded core** (`pkg-mt`): the same Rust source built with the `parallel` feature
   runs the bird loop on a rayon pool of Web Workers (`hardwareConcurrency - 1`, max 8). It
   needs a cross-origin isolated page, which means the host must send
   `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
   (set in `vite.config.js` for dev/preview and in `vercel.json`). If the headers are missing,
   the browser lacks SharedArrayBuffer, or the pool fails to start within 6 s, the app uses
   the single-threaded `pkg` core unchanged. `?threads=0` forces that; `?threads=N` picks a pool size.
5. **GPU Rendering**: all colour calculations happen in shaders; additive blending + bloom
6. **Adaptive quality**: live bird count and render resolution track the frame budget

Measured sim cost (headless Chromium, one Haswell core ≈ a mid-range phone): about 1.4 µs per
bird per step, linear in bird count — roughly 8,000 birds in 12 ms. Before this pass the
same core spent 9 ms on 2,000 birds and grew super-linearly. With the threaded core on 8
workers the same box does 32,000 birds in 10 ms and 64,000 in 20 ms. Flagship phones are
~2× faster single-threaded and desktops ~3×; Auto Quality finds the actual number on each device.

## Hosting requirements for the threaded core

Any static host works for the single-threaded core. For threads the page must be
cross-origin isolated: serve every response with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
`require-corp` also means every cross-origin asset the page loads needs CORS/CORP headers;
this app only loads same-origin files. Check the status banner or the Perf HUD: it reads
`rust-mt (N threads)` when the threaded core is active and `rust-simd` otherwise.

## Vercel + Rust/WASM build

This project is configured so `npm run build` now does both:

1. Builds `rust/boids-wasm/pkg` with `wasm-pack`
2. Copies generated artifacts to `public/rust/boids-wasm/pkg`
3. Runs `vite build`

On Vercel, `vercel.json` sets `buildCommand` to `npm run vercel-build`, which runs the same flow.

If you need a temporary local skip (for network-restricted environments), run:

```bash
SKIP_WASM_BUILD=1 npm run build
```

## Deployment Notes

- The Vite `base` path defaults to `/` (works for Vercel-style root deployments).
- If you deploy under a subpath (for example GitHub Pages), set `VITE_BASE_PATH` at build time.
  - Example: `VITE_BASE_PATH=/murmurations/ npm run build`
- The build log warning about chunks larger than 500 kB is only a performance hint and **not** a deployment failure by itself.

## Browser Requirements

- WebGL 2.0 support
- Chrome 90+, Firefox 88+, Safari 14+, Edge 90+

## Credits

Based on Craig Reynolds' Boids algorithm (1986) - "Flocks, Herds, and Schools: A Distributed Behavioral Model"

## License

MIT




