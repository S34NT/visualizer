import Stats from 'stats.js';
import { SceneManager } from './scene/SceneManager.js';
import { Flock } from './boids/Flock.js';
import { RustFlockAdapter } from './boids/RustFlockAdapter.js';
import { FlockRenderer } from './boids/FlockRenderer.js';
import { GUIControls } from './controls/GUIControls.js';
import { AudioAnalyzer } from './audio/AudioAnalyzer.js';
import { Choreographer } from './director/Choreographer.js';
import { CameraDirector } from './director/CameraDirector.js';
import { damp } from './director/Noise.js';
import { defaults } from './config/defaults.js';
import { F, createFieldBuffer } from './fields/FieldLayout.js';

// How quickly live parameters chase the choreographer's targets (per second).
const PARAM_RATES = {
  visualRange: 1.5,
  protectedRange: 1.5,
  centeringFactor: 2.5,
  avoidFactor: 2.5,
  matchingFactor: 2.5,
  minSpeed: 4,
  maxSpeed: 8,
  turnFactor: 2,
  margin: 2,
  particleSize: 10,
  maxDistance: 1
};

class MurmurationSimulator {
  constructor() {
    this.params = { ...defaults };

    this.isPaused = false;
    this.time = 0;
    this.lastFrameAt = 0;
    this.flockBackend = 'js';
    this.backendVariant = 'js';

    this.benchmarkEnabled = false;
    this.benchmark = {
      frames: 0,
      simMs: 0,
      frameMs: 0,
      lastReportAt: performance.now()
    };

    this.audioAnalyzer = null;
    this.audioInitializing = false;
    this.audioFeatures = null;
    this.audioLoadButton = null;
    this.audioFileInput = null;
    this.audioBar = null;
    // Demo tracks, one button each. Later tracks list candidate files in order
    // of preference; the first that exists is used, and a track with none gets
    // no button (so a purchased file can be dropped into public/audio later).
    this.demoTracks = [
      { label: 'Demo', urls: ['/audio/Voodoo & Serano - Blood Is Pumping.mp3'] },
      {
        label: 'Euthanasia Daze',
        urls: [
          '/audio/Sidewalks and Skeletons - Euthanasia Daze.wav',
          '/audio/Sidewalks and Skeletons - Euthanasia Daze.flac',
          '/audio/Sidewalks and Skeletons - Euthanasia Daze.mp3'
        ]
      }
    ];
    this.demoButtons = [];
    this.activeDemo = -1;
    this.noAudioFrames = 0;
    this.lastGuiRefreshAt = 0;
    this.lastCentroidAt = 0;

    // GUI-facing show settings; mirrored into the choreographer each frame.
    this.show = {
      autopilot: true,
      scene: 'auto',
      intensity: 1,
      musicSpeed: 1, // how strongly musical energy scales flight speed (0 = scene speeds only)
      groups: 1,     // instrument-group reaction strength (0 = off)
      energy: 0,     // read-only: current musical energy driving the speed curve
      extent: 0,     // read-only: flock radius (97th percentile) used for camera framing
      trails: true,
      bloom: true,
      cameraAuto: true,
      showLabel: true,
      // Motion: a global multiplier on flight speed, plus extra sim steps per frame.
      speed: 1,
      substeps: 1,
      // Performance: the controller grows the live bird count toward Max Birds
      // (params.birdCount) while the frame budget holds, and backs off when it breaks.
      autoQuality: true,
      neighborCap: 64,
      perfHud: false,
      liveBirds: 0,
      // Cymatic layer gain and the circularity readouts.
      cymatics: 1,
      circularity: 0,
      spinBreaks: 0,
      sceneNames: [],
      evo: {
        enabled: true,
        kinship: 0.8,
        xeno: 0.05,
        mutation: 0.012,
        lineageColor: 0.85,
        species: 0,
        dominant: 0
      }
    };

    this.quality = {
      refreshMs: 1000 / 60,
      intervalEma: 0,
      cpuEma: 0,
      calib: [],
      lastAdjustAt: 0,
      lastDropAt: 0,
      ceiling: Infinity,
      ceilingUntil: 0,
      dprScale: 1,
      status: 'measuring'
    };
    // Speed-scaled copy of the director's field handed to the flock core.
    this.flockField = createFieldBuffer();
    this.appliedNeighborCap = -1;
    this.lastHudAt = 0;

    this.applyUrlParams();
    this.initScene();
  }

  /** ?birds=8000&speed=2&steps=2&neighbors=32&quality=off&hud=1 */
  applyUrlParams() {
    const q = new URLSearchParams(window.location.search);
    const num = (key, lo, hi) => {
      const v = parseFloat(q.get(key));
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
    };
    const birds = num('birds', 100, 200000);
    if (birds !== null) this.params.birdCount = Math.round(birds);
    const speed = num('speed', 0.25, 6);
    if (speed !== null) this.show.speed = speed;
    const musicSpeed = num('musicspeed', 0, 1);
    if (musicSpeed !== null) this.show.musicSpeed = musicSpeed;
    const groups = num('groups', 0, 2);
    if (groups !== null) this.show.groups = groups;
    const steps = num('steps', 1, 4);
    if (steps !== null) this.show.substeps = Math.round(steps);
    const cap = num('neighbors', 4, 512);
    if (cap !== null) this.show.neighborCap = Math.round(cap);
    if (q.get('quality') === 'off') this.show.autoQuality = false;
    if (q.get('hud') === '1') this.show.perfHud = true;
  }

  async initialize() {
    await this.initFlock();
    this.initDirector();
    this.initGUI();
    this.initStats();
    this.initKeyboard();
    this.initAudioLoadButton();
    this.initSceneLabel();
    this.initPerfHud();
    this.show.liveBirds = this.flock.count;

    this.showStatus(
      this.flockBackend === 'rust'
        ? `🦀 Rust/WASM flock core active (${this.backendVariant}). Load a track or press ▶ Try Demo.`
        : '⚠️ JS flock fallback active. Build rust/boids-wasm/pkg to enable Rust core.',
      this.flockBackend !== 'rust',
      4200
    );

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  /* ------------------------------------------------------------------ */
  /* Audio                                                              */
  /* ------------------------------------------------------------------ */

  async initAudioAnalyzer(file) {
    if (this.audioLoadButton) this.audioLoadButton.disabled = false;
    this.setDemoButtonsDisabled(false);
    if (this.audioInitializing) return;
    if (!file) {
      this.showStatus('Choose an MP3 or WAV file to start audio reactivity.', true, 2800);
      return;
    }

    this.audioInitializing = true;
    this.showStatus('🎵 Loading audio file...');

    try {
      if (this.audioAnalyzer) {
        await this.audioAnalyzer.dispose();
      }

      this.audioAnalyzer = new AudioAnalyzer({ monitorGain: 1.0 });
      await this.audioAnalyzer.startFromFile(file);

      this.showStatus(`🎵 Audio visualizer active: ${file.name}`, false, 3500);
      this.noAudioFrames = 0;
      if (this.audioLoadButton) {
        this.audioLoadButton.textContent = '🎵 Audio File Loaded';
      }
      this.activeDemo = -1;
      this.refreshDemoButtons();
    } catch (error) {
      console.error('Failed to initialize audio analyzer:', error);
      this.showStatus(`Audio load failed: ${error.message}`, true);
      this.audioAnalyzer = null;
      this.noAudioFrames = 0;
      if (this.audioLoadButton) {
        this.audioLoadButton.textContent = '🎵 Load MP3/WAV';
      }
      this.activeDemo = -1;
      this.refreshDemoButtons();
    }

    this.audioInitializing = false;
  }

  async startDemoAudio(index = 0) {
    if (this.audioInitializing) return;
    const track = this.demoTracks[index];
    if (!track) return;

    this.setDemoButtonsDisabled(true);
    if (this.audioLoadButton) this.audioLoadButton.disabled = true;
    this.showStatus(`🎵 Loading ${track.label}...`);

    try {
      const url = track.url || track.urls[0];
      const response = await fetch(encodeURI(url));
      if (!response.ok) {
        throw new Error('Demo audio not found. Please add a demo file at the configured path.');
      }

      const blob = await response.blob();
      const name = url.split('/').pop();
      const ext = name.toLowerCase().split('.').pop();
      const type = blob.type || { wav: 'audio/wav', flac: 'audio/flac' }[ext] || 'audio/mpeg';
      const demoFile = new File([blob], name, { type });
      await this.initAudioAnalyzer(demoFile);
      if (this.audioLoadButton) this.audioLoadButton.disabled = true;
      this.activeDemo = index;
      this.refreshDemoButtons();
      this.showStatus(`🎵 ${track.label} playing`, false, 2500);
    } catch (error) {
      this.showStatus(`Demo audio failed: ${error.message}`, true);
      if (this.audioLoadButton) this.audioLoadButton.disabled = false;
      this.setDemoButtonsDisabled(false);
    }
  }

  setDemoButtonsDisabled(disabled) {
    for (const { button } of this.demoButtons) button.disabled = disabled;
  }

  /** Labels: the playing track reads "Playing", the others "Try". */
  refreshDemoButtons() {
    for (const { button, index } of this.demoButtons) {
      const label = this.demoTracks[index].label;
      button.textContent = index === this.activeDemo ? `🎵 ${label} Playing` : `▶ Try ${label}`;
      button.disabled = false;
    }
  }

  readAudio() {
    if (!this.audioAnalyzer || !this.audioAnalyzer.isRunning) {
      this.audioFeatures = null;
      return null;
    }

    const features = this.audioAnalyzer.getFeatures();
    this.audioFeatures = features;

    if (features.rms < 0.01) {
      this.noAudioFrames++;
      if (this.noAudioFrames === 180) {
        this.showStatus('No audio signal detected yet. Try a different file or increase playback volume.', true, 4000);
      }
    } else {
      this.noAudioFrames = 0;
    }

    return features;
  }

  initAudioLoadButton() {
    if (this.audioLoadButton) return;

    // Bottom-left bar; wraps onto a second row on narrow (phone) screens.
    const bar = document.createElement('div');
    bar.id = 'audio-bar';
    bar.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 16px;
      right: 16px;
      z-index: 1002;
      display: flex;
      flex-wrap: wrap-reverse;
      gap: 8px;
      pointer-events: none;
    `;

    const button = document.createElement('button');
    button.id = 'audio-load-button';
    button.type = 'button';
    button.textContent = '🎵 Load MP3/WAV';
    button.style.cssText = `
      transition: opacity 0.2s ease;
      pointer-events: auto;
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 10px;
      padding: 10px 14px;
      background: rgba(10, 16, 28, 0.82);
      color: #fff;
      font-size: 13px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      backdrop-filter: blur(6px);
      cursor: pointer;
      touch-action: manipulation;
      box-shadow: 0 4px 20px rgba(0,0,0,0.35);
    `;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.mp3,.wav,.flac,audio/mpeg,audio/wav,audio/flac';
    fileInput.style.display = 'none';

    fileInput.addEventListener('change', async (event) => {
      const [file] = event.target.files || [];
      await this.initAudioAnalyzer(file);
      event.target.value = '';
    });

    button.addEventListener('click', () => {
      fileInput.click();
    });

    document.body.appendChild(fileInput);
    bar.appendChild(button);
    document.body.appendChild(bar);
    this.audioFileInput = fileInput;
    this.audioLoadButton = button;
    this.audioBar = bar;

    // The first track is always offered; later ones only if their file exists.
    this.demoTracks.forEach((track, index) => {
      const demoButton = document.createElement('button');
      // The first keeps the old id (bookmarks, test scripts).
      demoButton.id = index === 0 ? 'audio-demo-button' : `audio-demo-button-${index + 1}`;
      demoButton.type = 'button';
      demoButton.textContent = `▶ Try ${track.label}`;
      demoButton.style.cssText = button.style.cssText;
      demoButton.addEventListener('click', async () => {
        await this.startDemoAudio(index);
      });
      const add = () => {
        bar.appendChild(demoButton);
        this.demoButtons.push({ button: demoButton, index });
        this.demoButtons.sort((a, b) => a.index - b.index);
        for (const { button: b } of this.demoButtons) bar.appendChild(b);
      };
      if (index === 0) {
        track.url = track.urls[0];
        add();
        return;
      }
      // Probe candidates in order; Vite's dev server answers unknown paths
      // with index.html, so require a non-HTML content type, not just 200.
      (async () => {
        for (const url of track.urls) {
          try {
            const r = await fetch(encodeURI(url), { method: 'HEAD' });
            const type = r.headers.get('content-type') || '';
            if (r.ok && !type.includes('text/html')) {
              track.url = url;
              add();
              return;
            }
          } catch {
            /* try the next candidate */
          }
        }
      })();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scene / flock / director                                           */
  /* ------------------------------------------------------------------ */

  initScene() {
    const container = document.getElementById('canvas-container');
    this.sceneManager = new SceneManager(container);
  }

  async initFlock() {
    try {
      const q = new URLSearchParams(window.location.search);
      const rustFlock = await RustFlockAdapter.create(
        this.params.birdCount,
        this.params.bounds,
        this.params,
        {
          threads: q.get('threads') !== '0',
          threadCount: Number(q.get('threads')) > 1 ? Number(q.get('threads')) : undefined
        }
      );

      this.flock = rustFlock;
      this.flockRenderer = new FlockRenderer(this.sceneManager.scene, rustFlock, this.params);
      this.flockBackend = 'rust';
      if (rustFlock.isThreaded?.()) {
        this.backendVariant = `rust-mt (${rustFlock.threads} threads)`;
      } else {
        this.backendVariant = rustFlock.isSimdEnabled?.() ? 'rust-simd' : 'rust-scalar';
      }

      if (!rustFlock.supportsField) {
        console.warn('Rust pkg is stale (no set_field). Rebuild with npm run build:wasm for force fields.');
      }
    } catch (error) {
      console.warn('Rust/WASM flock unavailable, falling back to JS Flock:', error);

      this.flock = new Flock(this.params.birdCount, this.params.bounds, this.params);
      this.flockRenderer = new FlockRenderer(this.sceneManager.scene, this.flock, this.params);
      this.flockBackend = 'js';
      this.backendVariant = 'js';
    }
  }

  initDirector() {
    this.director = new Choreographer({
      onSceneChange: (inst) => this.onSceneChange(inst)
    });
    this.show.sceneNames = this.director.sceneNames;
    this.flock.setField(this.flockField);

    this.cameraDirector = new CameraDirector(this.sceneManager);
    this.settleFlock();
  }

  /** Run the simulation briefly before the first frame so the flock starts settled, not scattered. */
  settleFlock() {
    const start = performance.now();
    let steps = 0;
    while (steps < 240 && performance.now() - start < 500) {
      this.applyDirector(1 / 60, null);
      this.flock.update(this.params);
      steps++;
    }
  }

  initGUI() {
    this.gui = new GUIControls(
      this.params,
      {
        onBirdCountChange: (count) => this.setBirdCount(count),
        onReset: () => this.reset(),
        onTogglePause: () => this.togglePause(),
        onScreenshot: () => this.takeScreenshot(),
        onFullscreen: () => this.toggleFullscreen(),
        onSceneSelect: (name) => this.director.requestScene(name),
        onNextScene: () => this.nextScene(),
        onTrails: (v) => this.sceneManager.setTrailsEnabled(v),
        onBloom: (v) => this.sceneManager.setBloomEnabled(v),
        onCameraAuto: (v) => {
          this.cameraDirector.enabled = v;
        },
        onExtinction: () => this.triggerExtinction(),
        onPerfHud: (v) => {
          this.show.perfHud = v;
          this.updatePerfHud(true);
        }
      },
      this.show
    );
  }

  initPerfHud() {
    const el = document.createElement('div');
    el.id = 'perf-hud';
    el.style.cssText = `
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 1002;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(10, 16, 28, 0.78);
      color: #cfe;
      font: 12px/1.5 'SF Mono', 'Fira Code', monospace;
      white-space: pre;
      pointer-events: none;
      display: none;
    `;
    document.body.appendChild(el);
    this.perfHudEl = el;
    this.updatePerfHud(true);
  }

  updatePerfHud(force = false) {
    const el = this.perfHudEl;
    if (!el) return;
    el.style.display = this.show.perfHud ? 'block' : 'none';
    if (!this.show.perfHud) return;
    const now = performance.now();
    if (!force && now - this.lastHudAt < 250) return;
    this.lastHudAt = now;
    const q = this.quality;
    const fps = q.intervalEma > 0 ? 1000 / q.intervalEma : 0;
    const cd = this.cameraDirector;
    el.textContent =
      `${this.backendVariant}  ${this.flock.count} birds (max ${this.params.birdCount})\n` +
      `${fps.toFixed(0)} fps  sim ${q.cpuEma.toFixed(1)} ms  budget ${q.refreshMs.toFixed(1)} ms\n` +
      `speed x${this.show.speed}  steps ${this.show.substeps}  cap ${this.show.neighborCap}  ` +
      `dpr ${this.sceneManager.pixelRatio().toFixed(2)}\n` +
      `auto quality: ${this.show.autoQuality ? q.status : 'off'}\n` +
      `scene ${this.director.current?.name}  circularity ${this.show.circularity}%  ` +
      `spin breaks ${this.show.spinBreaks}  shear ${this.director.spin.counter.toFixed(2)}\n` +
      `energy ${this.director.energy.toFixed(2)}  speed scale ${this.director.speedScale().toFixed(2)}  ` +
      `flight ${this.params.minSpeed.toFixed(1)}-${this.params.maxSpeed.toFixed(1)}\n` +
      `extent ${this.show.extent.toFixed(0)}  fit ${cd.fitDistance.toFixed(0)}  ` +
      `pref ${cd.preferred.toFixed(0)}  cam ${cd.radius.toFixed(0)}\n` +
      `groups ${this.groupShares()}  hits ${this.director.visual.bandHit.map((h) => h.toFixed(1)).join(' ')}`;
  }

  /** Share of birds in each instrument group (lineage-hue quadrant), as percentages. */
  groupShares() {
    const g = this.flockRenderer.getGenomesArray();
    if (!g) return '-';
    const n = g.length / 2;
    const c = [0, 0, 0, 0];
    const step = Math.max(1, Math.floor(n / 1000));
    let m = 0;
    for (let i = 0; i < n; i += step) {
      const h = g[i * 2] - Math.floor(g[i * 2]);
      c[Math.min(3, Math.floor(h * 4))]++;
      m++;
    }
    return c.map((v) => Math.round((100 * v) / Math.max(1, m))).join('/');
  }

  /** Push the neighbour cap into whichever core is active. */
  syncFlockSettings() {
    const cap = Math.round(this.show.neighborCap);
    if (cap !== this.appliedNeighborCap && typeof this.flock.setMaxNeighbors === 'function') {
      this.flock.setMaxNeighbors(cap);
      this.appliedNeighborCap = cap;
    }
  }

  /**
   * Adaptive quality. Calibrates the display refresh from the first frames,
   * then every 1.5 s compares the smoothed frame interval and sim CPU time to
   * the budget: over budget lowers resolution first when the sim is cheap
   * (GPU-bound) and otherwise sheds birds; comfortably under budget grows the
   * flock toward Max Birds, staying under a recent ceiling that broke the budget.
   */
  updateQuality(rawMs, cpuMs) {
    const q = this.quality;
    if (document.hidden || !(rawMs > 1) || rawMs > 250) return;

    if (q.calib.length < 90) {
      q.calib.push(rawMs);
      q.intervalEma = rawMs;
      q.cpuEma = cpuMs;
      if (q.calib.length === 90) {
        const med = [...q.calib].sort((a, b) => a - b)[45];
        const hz = med < 9.5 ? 120 : med < 13 ? 90 : 60;
        q.refreshMs = 1000 / hz;
        q.status = 'tuning';
      }
      return;
    }

    q.intervalEma += (rawMs - q.intervalEma) * 0.08;
    q.cpuEma += (cpuMs - q.cpuEma) * 0.08;
    if (!this.show.autoQuality) return;

    const now = performance.now();
    if (now - q.lastAdjustAt < 1500) return;

    const budget = q.refreshMs;
    const live = this.flock.count;
    const cap = this.params.birdCount;
    const over = q.intervalEma > budget * 1.12 || q.cpuEma > budget * 0.8;
    const under = q.intervalEma < budget * 1.04 && q.cpuEma < budget * 0.55;

    if (over) {
      q.lastAdjustAt = now;
      q.lastDropAt = now;
      const gpuBound = q.cpuEma < budget * 0.45;
      if (gpuBound && q.dprScale > 0.6) {
        q.dprScale = Math.max(0.6, q.dprScale - 0.2);
        this.sceneManager.setPixelRatioScale(q.dprScale);
        q.status = `gpu-bound, resolution ${Math.round(q.dprScale * 100)}%`;
      } else {
        const next = Math.max(300, Math.round(live * 0.85));
        q.ceiling = live;
        q.ceilingUntil = now + 40000;
        if (next < live) this.setLiveBirds(next);
        q.status = `cpu-bound, backing off to ${next}`;
      }
    } else if (under && live < cap && now - q.lastDropAt > 4000) {
      q.lastAdjustAt = now;
      let next = Math.min(cap, Math.round(live * 1.15 + 100));
      if (now < q.ceilingUntil) next = Math.min(next, Math.round(q.ceiling * 0.92));
      if (next > live) {
        this.setLiveBirds(next);
        q.status = `growing to ${next}`;
      } else {
        q.status = `settled at ${live} (ceiling ${q.ceiling})`;
      }
    } else if (under && q.dprScale < 1 && now - q.lastDropAt > 8000) {
      q.lastAdjustAt = now;
      q.dprScale = Math.min(1, q.dprScale + 0.2);
      this.sceneManager.setPixelRatioScale(q.dprScale);
      q.status = `restoring resolution ${Math.round(q.dprScale * 100)}%`;
    } else if (!/^settled|^at max/.test(q.status) && now - q.lastAdjustAt > 3000) {
      q.lastAdjustAt = now;
      q.status = live >= cap ? `at max ${live}` : `settled at ${live}`;
    }
  }

  /** Scale the director's field for the global speed multiplier (forces are per-step velocity nudges). */
  scaleFieldForSpeed() {
    const src = this.director.field;
    const f = this.flockField;
    f.set(src);
    const s = this.show.speed;
    if (s === 1) return;
    f[F.FLOW_STRENGTH] *= s;
    f[F.VORTEX_STRENGTH] *= s;
    f[F.SHAPE_STRENGTH] *= s;
    f[F.PULSE_STRENGTH] *= s;
    f[F.WIND] *= s;
    f[F.WIND + 1] *= s;
    f[F.WIND + 2] *= s;
    f[F.CONTAIN_STRENGTH] *= s;
    f[F.JITTER] *= s;
    f[F.SHEAR_STRENGTH] *= s;
    for (let i = 0; i < F.MAX_AGENTS; i++) f[F.AGENT_BASE + i * F.AGENT_STRIDE + 3] *= s;
    for (let i = 0; i < F.MAX_CYM; i++) f[F.CYM_BASE + i * F.CYM_STRIDE] *= s;
  }

  initSceneLabel() {
    const el = document.createElement('div');
    el.id = 'scene-label';
    document.body.appendChild(el);
    this.sceneLabelEl = el;
    this.onSceneChange(this.director.current);
  }

  onSceneChange(inst) {
    if (!this.sceneLabelEl || !inst) return;
    if (!this.show.showLabel) {
      this.sceneLabelEl.classList.remove('visible');
      return;
    }
    this.sceneLabelEl.textContent = inst.label;
    this.sceneLabelEl.classList.add('visible');
    clearTimeout(this.sceneLabelTimer);
    this.sceneLabelTimer = setTimeout(() => {
      this.sceneLabelEl.classList.remove('visible');
    }, 3200);
  }

  nextScene() {
    if (!this.director.live) {
      this.showStatus('Load a track first. The show starts when audio is playing.', true, 2200);
      return;
    }
    this.show.autopilot = true;
    this.director.autopilot = true;
    this.director.nextScene();
    this.gui?.refreshDisplay();
  }

  triggerExtinction() {
    if (!this.director.live) {
      this.showStatus('Load a track first. Evolution runs while audio is playing.', true, 2200);
      return;
    }
    this.director.triggerExtinction(1);
    this.showStatus('☄️ Extinction event: the dominant lineage is dying off', false, 2200);
  }

  /** Push GUI settings into the director and chase its targets. */
  applyDirector(dt, audio) {
    const d = this.director;
    d.autopilot = this.show.autopilot;
    d.intensityGain = this.show.intensity;
    if (d.manualScene !== this.show.scene) d.requestScene(this.show.scene);
    const ev = this.show.evo;
    d.evo.enabled = ev.enabled;
    d.evo.kinship = ev.kinship;
    d.evo.xeno = ev.xeno;
    d.evo.mutation = ev.mutation;
    d.evo.lineageColor = ev.lineageColor;
    d.cymGain = this.show.cymatics;
    d.musicSpeed = this.show.musicSpeed;
    d.groupGain = this.show.groups;

    d.update(dt, audio);

    if (this.show.autopilot) {
      const targets = d.params;
      const s = this.show.speed;
      for (const key in PARAM_RATES) {
        let target = targets[key];
        if (typeof target !== 'number' || Number.isNaN(target)) continue;
        if (key === 'minSpeed' || key === 'maxSpeed' || key === 'turnFactor') target *= s;
        this.params[key] = damp(this.params[key], target, PARAM_RATES[key], dt);
      }
      this.params.maxSpeed = Math.max(this.params.maxSpeed, this.params.minSpeed + 0.4);
    }
    this.scaleFieldForSpeed();
    this.syncFlockSettings();

    this.sceneManager.applyVisual(d.visual, dt);
  }

  /** Advance the show without rendering (debugging / automated screenshots). */
  stepOffline(steps = 60, dt = 1 / 60) {
    // Sample audio once: analyser envelopes are time-based and would freeze if
    // polled thousands of times within the same millisecond.
    const audio = this.readAudio();
    for (let i = 0; i < steps; i++) {
      this.applyDirector(dt, audio);
      this.flock.update(this.params);
    }
    this.flockRenderer.update(this.time, this.director.visual);
    this.updateCentroid();
  }

  updateCentroid() {
    const now = performance.now();
    if (now - this.lastCentroidAt < 120) return;
    this.lastCentroidAt = now;

    const positions = this.flockRenderer.getPositionsArray();
    const velocities = this.flockRenderer.getVelocitiesArray();
    const count = positions.length / 3;
    if (!count) return;
    const step = Math.max(1, Math.floor(count / 512));
    // Sampled positions double as the camera director's framing set.
    const samples = this.sampleScratch && this.sampleScratch.length >= 3 * Math.ceil(count / step)
      ? this.sampleScratch
      : (this.sampleScratch = new Float32Array(3 * (Math.ceil(count / step) + 8)));
    let x = 0, y = 0, z = 0, n = 0;
    for (let i = 0; i < count; i += step) {
      const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
      samples[n * 3] = px; samples[n * 3 + 1] = py; samples[n * 3 + 2] = pz;
      x += px;
      y += py;
      z += pz;
      n++;
    }
    x /= n; y /= n; z /= n;
    this.cameraDirector.setCentroid(x, y, z);
    this.cameraDirector.setFlockSamples(samples, n);

    // Flock extent (HUD): the radius holding 97% of the sampled birds.
    const radii = this.extentScratch && this.extentScratch.length >= n
      ? this.extentScratch
      : (this.extentScratch = new Float32Array(Math.max(n, 512)));
    for (let i = 0; i < n; i++) {
      const rx = samples[i * 3] - x, ry = samples[i * 3 + 1] - y, rz = samples[i * 3 + 2] - z;
      radii[i] = Math.sqrt(rx * rx + ry * ry + rz * rz);
    }
    const sorted = radii.subarray(0, n).sort();
    this.show.extent = sorted[Math.min(n - 1, Math.floor(n * 0.97))];

    if (velocities) {
      // Flock statistics for the choreographer: normalised angular momentum
      // about the centroid (1 = pure mill), polarisation and rms spread.
      let lx = 0, ly = 0, lz = 0, lnorm = 0, sx = 0, sy = 0, sz = 0, sv = 0, r2 = 0;
      for (let i = 0; i < count; i += step) {
        const rx = positions[i * 3] - x, ry = positions[i * 3 + 1] - y, rz = positions[i * 3 + 2] - z;
        const vx = velocities[i * 3], vy = velocities[i * 3 + 1], vz = velocities[i * 3 + 2];
        lx += ry * vz - rz * vy;
        ly += rz * vx - rx * vz;
        lz += rx * vy - ry * vx;
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
        const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
        lnorm += rl * vl;
        sx += vx; sy += vy; sz += vz; sv += vl;
        r2 += rl * rl;
      }
      const ll = Math.sqrt(lx * lx + ly * ly + lz * lz);
      const circularity = lnorm > 1e-6 ? ll / lnorm : 0;
      const axis = ll > 1e-6 ? [lx / ll, ly / ll, lz / ll] : [0, 1, 0];
      const polarization = sv > 1e-6 ? Math.sqrt(sx * sx + sy * sy + sz * sz) / sv : 0;
      this.director.setFlockStats({
        circularity,
        axis,
        polarization,
        spread: Math.sqrt(r2 / n),
        centroid: [x, y, z]
      });
      this.show.circularity = Math.round(this.director.flock.circularity * 100);
      this.show.spinBreaks = this.director.spin.triggers;
      this.show.energy = Math.round(this.director.energy * 100) / 100;
    }

    if (typeof this.flock.speciesCount === 'function') {
      this.show.evo.species = this.flock.speciesCount();
      this.show.evo.dominant = Math.round(this.flock.dominantShare() * 100);
    }
  }

  showStatus(message, isError = false, autoHide = 0) {
    let statusEl = document.getElementById('tracking-status');

    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = 'tracking-status';
      statusEl.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 12px 24px;
        border-radius: 8px;
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 14px;
        z-index: 1001;
        transition: opacity 0.3s ease;
      `;
      document.body.appendChild(statusEl);
    }

    statusEl.textContent = message;
    statusEl.style.background = isError ? 'rgba(255, 80, 80, 0.9)' : 'rgba(0, 200, 150, 0.9)';
    statusEl.style.color = 'white';
    statusEl.style.opacity = '1';

    if (autoHide > 0) {
      setTimeout(() => {
        statusEl.style.opacity = '0';
      }, autoHide);
    }
  }

  initStats() {
    this.stats = new Stats();
    this.stats.showPanel(0);
    this.stats.dom.style.left = 'auto';
    this.stats.dom.style.right = '0';
    document.body.appendChild(this.stats.dom);
  }

  toggleBenchmark() {
    this.benchmarkEnabled = !this.benchmarkEnabled;
    this.benchmark.frames = 0;
    this.benchmark.simMs = 0;
    this.benchmark.frameMs = 0;
    this.benchmark.lastReportAt = performance.now();

    this.showStatus(
      this.benchmarkEnabled
        ? `📊 Benchmark ON (${this.flockBackend.toUpperCase()} core). Logging every ~120 frames.`
        : '📊 Benchmark OFF',
      false,
      2600
    );
  }

  maybeReportBenchmark() {
    if (!this.benchmarkEnabled || this.benchmark.frames < 120) return;

    const avgSim = this.benchmark.simMs / this.benchmark.frames;
    const avgFrame = this.benchmark.frameMs / this.benchmark.frames;
    const elapsed = performance.now() - this.benchmark.lastReportAt;
    const fps = elapsed > 0 ? (this.benchmark.frames * 1000) / elapsed : 0;

    console.info('[Benchmark]', {
      backend: this.flockBackend,
      variant: this.backendVariant || this.flockBackend,
      birds: this.flock.count,
      scene: this.director?.current?.name,
      lineages: this.show.evo.species,
      bpm: this.audioFeatures ? Number(this.audioFeatures.bpm.toFixed(1)) : 0,
      avgSimulationMs: Number(avgSim.toFixed(3)),
      avgFrameMs: Number(avgFrame.toFixed(3)),
      approxFps: Number(fps.toFixed(1))
    });

    this.benchmark.frames = 0;
    this.benchmark.simMs = 0;
    this.benchmark.frameMs = 0;
    this.benchmark.lastReportAt = performance.now();
  }

  maybeRefreshGuiDisplay() {
    if (!this.gui?.refreshDisplay) return;

    const now = performance.now();
    if (now - this.lastGuiRefreshAt < 160) return;

    this.gui.refreshDisplay();
    this.lastGuiRefreshAt = now;
  }

  initKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.togglePause();
          break;
        case 'KeyR':
          this.reset();
          break;
        case 'KeyF':
          this.toggleFullscreen();
          break;
        case 'KeyS':
          this.takeScreenshot();
          break;
        case 'KeyH':
          this.gui.toggle();
          break;
        case 'KeyB':
          this.toggleBenchmark();
          break;
        case 'KeyN':
          this.nextScene();
          break;
        case 'KeyA':
          this.show.autopilot = !this.show.autopilot;
          this.gui.refreshDisplay();
          this.showStatus(this.show.autopilot ? '🎬 Autopilot ON' : '🎛 Autopilot OFF (manual sliders)', false, 1800);
          break;
        case 'KeyT':
          this.show.trails = !this.show.trails;
          this.sceneManager.setTrailsEnabled(this.show.trails);
          this.gui.refreshDisplay();
          break;
        case 'KeyG':
          this.show.bloom = !this.show.bloom;
          this.sceneManager.setBloomEnabled(this.show.bloom);
          this.gui.refreshDisplay();
          break;
        case 'KeyC':
          this.show.cameraAuto = !this.show.cameraAuto;
          this.cameraDirector.enabled = this.show.cameraAuto;
          this.gui.refreshDisplay();
          break;
        case 'KeyX':
          this.triggerExtinction();
          break;
        case 'KeyP':
          this.show.perfHud = !this.show.perfHud;
          this.updatePerfHud(true);
          this.gui.refreshDisplay();
          break;
      }
    });
  }

  /** GUI / preset: Max Birds. Jumps the live count straight there; auto quality trims it if needed. */
  setBirdCount(count) {
    this.params.birdCount = count;
    this.quality.ceiling = Infinity;
    this.quality.ceilingUntil = 0;
    this.setLiveBirds(count);
  }

  setLiveBirds(count) {
    this.flockRenderer.resize(count);
    this.show.liveBirds = this.flock.count;
  }

  reset() {
    this.flock.reset();
    this.sceneManager.resetCamera();
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    this.gui.setPauseState(this.isPaused);

    const indicator = document.getElementById('pause-indicator');
    if (indicator) {
      indicator.classList.toggle('visible', this.isPaused);
    }
  }

  takeScreenshot() {
    this.sceneManager.render();

    const canvas = this.sceneManager.getCanvas();
    const dataURL = canvas.toDataURL('image/png');

    const link = document.createElement('a');
    link.download = `murmuration-${Date.now()}.png`;
    link.href = dataURL;
    link.click();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }

  animate(timestamp) {
    requestAnimationFrame(this.animate);

    const frameStart = performance.now();
    this.stats.begin();
    const rawMs = this.lastFrameAt ? timestamp - this.lastFrameAt : 1000 / 60;
    const dt = this.lastFrameAt ? Math.min(0.1, rawMs * 0.001) : 1 / 60;
    this.lastFrameAt = timestamp;
    this.time = timestamp * 0.001;

    if (!this.isPaused) {
      const audio = this.readAudio();
      this.applyDirector(dt, audio);
      this.maybeRefreshGuiDisplay();

      const simStart = performance.now();
      const steps = Math.max(1, Math.round(this.show.substeps));
      for (let k = 0; k < steps; k++) this.flock.update(this.params);
      this.flockRenderer.update(this.time, this.director.visual);
      const cpuMs = performance.now() - simStart;

      if (this.benchmarkEnabled) {
        this.benchmark.simMs += cpuMs;
      }

      this.updateQuality(rawMs, cpuMs);
      this.updatePerfHud();
      this.updateCentroid();
      this.cameraDirector.update(dt, this.director.camera, this.director.audio);
    } else {
      this.sceneManager.update();
    }

    this.sceneManager.render();
    this.stats.end();

    if (this.benchmarkEnabled) {
      this.benchmark.frames += 1;
      this.benchmark.frameMs += performance.now() - frameStart;
      this.maybeReportBenchmark();
    }
  }

  dispose() {
    if (this.audioAnalyzer) {
      this.audioAnalyzer.dispose();
      this.audioAnalyzer = null;
    }

    if (this.audioLoadButton) {
      this.audioLoadButton.remove();
      this.audioLoadButton = null;
    }

    if (this.audioBar) {
      this.audioBar.remove();
      this.audioBar = null;
      this.demoButtons = [];
    }

    if (this.audioFileInput) {
      this.audioFileInput.remove();
      this.audioFileInput = null;
    }

    this.noAudioFrames = 0;
  }
}

window.addEventListener('beforeunload', () => {
  if (window.simulator) {
    window.simulator.dispose();
  }
});

const startSimulator = async () => {
  const simulator = new MurmurationSimulator();
  await simulator.initialize();
  window.simulator = simulator;
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    startSimulator();
  });
} else {
  startSimulator();
}
