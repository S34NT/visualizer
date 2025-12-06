# Murmuration Simulator Architecture

## Overview

A real-time 3D flocking simulation implementing Craig Reynolds' Boids algorithm (1986) with GPU-accelerated position-based color visualization. Built with Three.js and Vite.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        main.js                                   │
│                   (Application Entry)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ SceneManager │  │    Flock     │  │    GUIControls       │   │
│  │              │  │              │  │                      │   │
│  │ • Renderer   │  │ • Boids[]    │  │ • Parameter sliders  │   │
│  │ • Camera     │  │ • SpatialGrid│  │ • Presets            │   │
│  │ • Controls   │  │ • Positions  │  │ • Actions            │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────┘   │
│         │                 │                                      │
│         │    ┌────────────┴────────────┐                        │
│         │    │     FlockRenderer       │                        │
│         │    │                         │                        │
│         │    │ • BufferGeometry        │                        │
│         │    │ • ShaderMaterial        │                        │
│         │    │ • THREE.Points          │                        │
│         │    └────────────┬────────────┘                        │
│         │                 │                                      │
│         └────────────────►│◄──── GLSL Shaders                   │
│                           │      • color-vertex.glsl            │
│                           │      • color-fragment.glsl          │
│                           ▼                                      │
│                    ┌──────────────┐                              │
│                    │   WebGL      │                              │
│                    │   Canvas     │                              │
│                    └──────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. SceneManager (`src/scene/SceneManager.js`)

Manages all Three.js infrastructure:

| Responsibility | Implementation |
|----------------|----------------|
| WebGL Renderer | Antialiasing, high-performance mode, sRGB color space |
| Camera | PerspectiveCamera at (0, 0, 300), 60° FOV |
| Controls | OrbitControls with damping, zoom limits, touch support |
| Resize | Window resize handler updates aspect ratio and renderer size |

### 2. Boid (`src/boids/Boid.js`)

Individual agent implementing flocking behaviors:

```
┌─────────────────────────────────────────┐
│                  Boid                    │
├─────────────────────────────────────────┤
│ position: Vector3                        │
│ velocity: Vector3                        │
│ bounds: number                           │
├─────────────────────────────────────────┤
│ applySeparation(neighbors, range, factor)│
│ applyAlignment(neighbors, range, factor) │
│ applyCohesion(neighbors, range, factor)  │
│ limitSpeed(min, max)                     │
│ avoidBoundaries(margin, turnFactor)      │
│ update(neighbors, params)                │
└─────────────────────────────────────────┘
```

**Flocking Rules:**
- **Separation**: Steer away from neighbors within `protectedRange`
- **Alignment**: Match average velocity of neighbors within `visualRange`
- **Cohesion**: Steer toward center of mass of neighbors within `visualRange`

### 3. SpatialGrid (`src/boids/SpatialGrid.js`)

Optimization structure reducing neighbor lookup from O(n²) to O(n):

```
Space divided into cells of size = visualRange

┌─────┬─────┬─────┬─────┐
│     │     │     │     │
├─────┼─────┼─────┼─────┤
│     │ ●○○ │ ○   │     │  ● = query boid
├─────┼─────┼─────┼─────┤  ○ = neighbors checked
│     │ ○○  │ ○   │     │
├─────┼─────┼─────┼─────┤
│     │     │     │     │
└─────┴─────┴─────┴─────┘

Only 3x3x3 = 27 cells checked instead of all N boids
```

**Key Methods:**
- `getCellKey(x, y, z)` → "cellX,cellY,cellZ" string
- `add(boid)` → assigns boid to appropriate cell
- `getNearby(boid)` → returns boids in adjacent 27 cells

### 4. Flock (`src/boids/Flock.js`)

Manages the collection of boids:

- Initializes N boids with random positions/velocities
- Rebuilds spatial grid each frame
- Coordinates boid updates with neighbor data
- Provides `Float32Array` of positions for GPU upload

### 5. FlockRenderer (`src/boids/FlockRenderer.js`)

Bridges simulation and rendering:

- Creates `THREE.BufferGeometry` with position attribute
- Applies custom `ShaderMaterial` for color computation
- Updates position buffer each frame (`needsUpdate = true`)
- Handles dynamic resizing when bird count changes

---

## Shader Pipeline

### Vertex Shader (`src/shaders/color-vertex.glsl`)

Computes per-particle color from 3D position:

```glsl
Position → HSL Color Mapping:

1. Hue = atan2(y, x)           // Radial color wheel from XY angle
2. Hue += z * influence        // Z position shifts hue for depth
3. Lightness = f(distance)     // Bright at origin, darker at edges
4. Saturation = 0.9            // Fixed high saturation

HSL → RGB conversion in shader
```

**Uniforms:**
- `origin`: Center point for color mapping (0,0,0)
- `maxDistance`: Distance at which colors reach minimum lightness
- `time`: For subtle shimmer animation
- `particleSize`: Base point size

### Fragment Shader (`src/shaders/color-fragment.glsl`)

Renders circular particles with soft edges:

```glsl
1. Calculate distance from point center
2. Discard if outside radius (circular shape)
3. Apply smoothstep for antialiased edges
4. Add subtle glow effect
5. Output with premultiplied alpha
```

---

## Data Flow

```
┌──────────────┐
│ Animation    │
│ Frame        │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│ Flock.update │────►│ SpatialGrid  │
│              │     │ rebuild      │
└──────┬───────┘     └──────────────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│ For each     │────►│ Boid.update  │
│ boid         │     │ (3 rules)    │
└──────┬───────┘     └──────────────┘
       │
       ▼
┌──────────────┐
│ getPositions │ → Float32Array
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ FlockRenderer│
│ .update()    │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ GPU Upload   │ → BufferAttribute.needsUpdate = true
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Vertex       │ → Position-based color calculation
│ Shader       │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Fragment     │ → Circular particle with glow
│ Shader       │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ WebGL Canvas │
└──────────────┘
```

---

## Configuration

### Default Parameters (`src/config/defaults.js`)

```javascript
{
  visualRange: 40,        // Neighbor detection radius
  protectedRange: 8,      // Personal space radius
  centeringFactor: 0.0005,// Cohesion strength
  avoidFactor: 0.05,      // Separation strength
  matchingFactor: 0.05,   // Alignment strength
  maxSpeed: 6,
  minSpeed: 3,
  turnFactor: 0.2,
  margin: 50,
  birdCount: 1000,
  bounds: 150,
  particleSize: 3.0,
  maxDistance: 200
}
```

### Presets

| Preset | Birds | Visual Range | Behavior |
|--------|-------|--------------|----------|
| default | 1000 | 40 | Balanced flocking |
| tightSwarm | 2000 | 30 | Dense, cohesive |
| looseFlock | 500 | 60 | Sparse, spread out |
| chaotic | 1500 | 25 | High separation, erratic |
| massive | 5000 | 35 | Large-scale demo |

---

## Performance Optimizations

1. **Spatial Partitioning**: O(n) neighbor lookup via grid cells
2. **Buffer Reuse**: Pre-allocated `Float32Array` avoids GC
3. **GPU Color Computation**: All HSL→RGB in vertex shader
4. **Single Draw Call**: `THREE.Points` renders all particles at once
5. **Additive Blending**: Beautiful glow with minimal overdraw cost
6. **Size Attenuation**: Particles scale with camera distance

---

## File Structure

```
src/
├── main.js                    # Entry point, animation loop, keyboard
├── config/
│   └── defaults.js            # Parameters, presets
├── scene/
│   └── SceneManager.js        # Three.js setup
├── boids/
│   ├── Boid.js                # Individual agent logic
│   ├── Flock.js               # Collection management
│   ├── FlockRenderer.js       # GPU rendering bridge
│   └── SpatialGrid.js         # O(n) optimization
├── shaders/
│   ├── color-vertex.glsl      # Position → color
│   └── color-fragment.glsl    # Particle appearance
└── controls/
    └── GUIControls.js         # lil-gui interface
```

---

## Deployment

- **Build**: `npm run build` → `dist/`
- **GitHub Pages**: Automated via `.github/workflows/deploy.yml`
- **Base Path**: `/murmurations/` configured in `vite.config.js`
- **Live URL**: https://omniharmonic.github.io/murmurations/




