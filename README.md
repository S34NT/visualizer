# Murmuration Simulator

A high-performance 3D bird flocking simulation using Three.js with position-based color visualization.

![Murmuration](https://via.placeholder.com/800x400/0a0a0f/ffffff?text=Murmuration+Simulator)

## Features

- **Biologically Accurate Flocking**: Implementation of Craig Reynolds' Boids algorithm (1986)
- **Position-Based Colors**: Dynamic HSL coloring based on 3D spatial position
- **High Performance**: Spatial partitioning enables 5,000+ birds at 60 FPS
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
- **R**: Reset flock
- **F**: Toggle fullscreen
- **S**: Take screenshot
- **H**: Hide/show GUI
- **M**: Link a YouTube video and start tab-audio reactivity

### Touch / Mobile
- **🎵 Link YouTube Audio button** (bottom-left): Opens URL prompt and starts YouTube tab-audio linking flow
- **Important**: On mobile browsers, tap the button first (user gesture required), then choose the YouTube tab and enable shared/tab audio if prompted

- If video links successfully but you hear silence and see no reaction:
  1. Confirm the YouTube video is actively playing (not paused).
  2. In the share picker, choose the **browser tab** and enable **Share tab audio**.
  3. Use **Chrome on Android** when possible; many iOS browsers do not fully support tab-audio capture APIs.

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
├── scene/
│   └── SceneManager.js  # Three.js setup
├── boids/
│   ├── Boid.js          # Individual boid logic
│   ├── Flock.js         # Flock management
│   ├── FlockRenderer.js # THREE.Points rendering
│   └── SpatialGrid.js   # O(n) neighbor lookup
├── shaders/
│   ├── color-vertex.glsl   # Position-to-color mapping
│   └── color-fragment.glsl # Particle rendering
└── controls/
    └── GUIControls.js   # lil-gui interface
```

## Color System

Colors are dynamically computed in the vertex shader based on each bird's position:

- **Hue**: Derived from XY angle (atan2), creating a radial color wheel
- **Lightness**: Distance from origin (bright at center, darker at edges)
- **Z Modulation**: Vertical position shifts hue for 3D depth perception

## Performance

The simulation uses several optimization techniques:

1. **Spatial Partitioning**: Grid-based neighbor lookup reduces O(n²) to O(n)
2. **GPU Rendering**: All color calculations happen in shaders
3. **Buffer Reuse**: Float32Arrays are reused to minimize allocations
4. **Additive Blending**: Beautiful glow effect with minimal overdraw cost

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




