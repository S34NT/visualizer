import Stats from 'stats.js';
import { SceneManager } from './scene/SceneManager.js';
import { Flock } from './boids/Flock.js';
import { RustFlockAdapter } from './boids/RustFlockAdapter.js';
import { FlockRenderer } from './boids/FlockRenderer.js';
import { GUIControls } from './controls/GUIControls.js';
import { AudioAnalyzer } from './audio/AudioAnalyzer.js';
import { defaults } from './config/defaults.js';

class MurmurationSimulator {
  constructor() {
    this.params = { ...defaults };

    this.isPaused = false;
    this.time = 0;
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
    this.audioFeatures = {
      rms: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      beat: 0,
      peak: 0
    };
    this.audioLinkButton = null;
    this.noAudioFrames = 0;

    this.initScene();
  }

  async initialize() {
    await this.initFlock();
    this.initGUI();
    this.initStats();
    this.initKeyboard();
    this.initAudioLinkButton();

    this.showStatus(
      this.flockBackend === 'rust'
        ? '🦀 Rust/WASM flock core active. Press B for benchmark overlay logs.'
        : '⚠️ JS flock fallback active. Build rust/boids-wasm/pkg to enable Rust core.',
      this.flockBackend !== 'rust',
      4200
    );

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  async initAudioAnalyzer() {
    if (this.audioAnalyzer || this.audioInitializing) return;

    this.audioInitializing = true;
    this.showStatus('🎵 Link a YouTube video to start audio reactivity...');

    try {
      this.audioAnalyzer = new AudioAnalyzer({ monitorGain: 1.0 });
      const youtubeUrl = window.prompt('Paste a YouTube URL for audio reactivity:');
      if (!youtubeUrl) {
        throw new Error('No YouTube URL provided.');
      }

      if (typeof this.audioAnalyzer.startFromYouTube === 'function') {
        await this.audioAnalyzer.startFromYouTube(youtubeUrl);
      } else if (typeof this.audioAnalyzer.startFromMic === 'function') {
        await this.audioAnalyzer.startFromMic(youtubeUrl);
      } else {
        throw new Error('AudioAnalyzer has no supported start method.');
      }

      this.showStatus('🎵 Audio visualizer active from shared YouTube tab.', false, 3500);
      this.noAudioFrames = 0;
      if (this.audioLinkButton) {
        this.audioLinkButton.textContent = '🎵 YouTube Audio Linked';
      }
    } catch (error) {
      console.error('Failed to initialize audio analyzer:', error);
      this.showStatus(`Audio link failed: ${error.message}`, true);
      this.audioAnalyzer = null;
      this.noAudioFrames = 0;
      if (this.audioLinkButton) {
        this.audioLinkButton.textContent = '🎵 Link YouTube Audio';
      }
    }

    this.audioInitializing = false;
  }

  applyAudioReactiveModulation() {
    if (!this.audioAnalyzer || !this.audioAnalyzer.isRunning) return;

    this.audioFeatures = this.audioAnalyzer.getFeatures();
    const { rms, bass, mid, treble, beat } = this.audioFeatures;

    const sensitivity = 2.2;
    const bassEnergy = Math.min(1, bass * sensitivity);
    const midEnergy = Math.min(1, mid * sensitivity);
    const trebleEnergy = Math.min(1, treble * sensitivity);
    const loudness = Math.min(1, rms * sensitivity * 1.5);

    if (loudness < 0.01) {
      this.noAudioFrames++;
      if (this.noAudioFrames === 180) {
        this.showStatus('No tab audio detected yet. Make sure YouTube is playing and tab audio sharing is enabled.', true, 4000);
      }
    } else {
      this.noAudioFrames = 0;
    }

    this.params.maxSpeed = 5.5 + bassEnergy * 6.5;
    this.params.matchingFactor = 0.02 + midEnergy * 0.16;
    this.params.avoidFactor = 0.02 + trebleEnergy * 0.16;
    this.params.turnFactor = 0.1 + beat * 0.35;
    this.params.particleSize = 2.0 + loudness * 5.0;
    this.params.maxDistance = 150 + trebleEnergy * 260;
  }

  initAudioLinkButton() {
    if (this.audioLinkButton) return;

    const button = document.createElement('button');
    button.id = 'audio-link-button';
    button.type = 'button';
    button.textContent = '🎵 Link YouTube Audio';
    button.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 20px;
      z-index: 1002;
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

    button.addEventListener('click', () => {
      this.initAudioAnalyzer();
    });

    document.body.appendChild(button);
    this.audioLinkButton = button;
  }

  initScene() {
    const container = document.getElementById('canvas-container');
    this.sceneManager = new SceneManager(container);
  }

  async initFlock() {
    try {
      const rustFlock = await RustFlockAdapter.create(
        this.params.birdCount,
        this.params.bounds,
        this.params
      );

      const rustRenderer = new FlockRenderer(
        this.sceneManager.scene,
        rustFlock,
        this.params
      );

      this.flock = rustFlock;
      this.flockRenderer = rustRenderer;
      this.flockBackend = 'rust';
      this.backendVariant = rustFlock.isSimdEnabled?.() ? 'rust-simd' : 'rust-scalar';
    } catch (error) {
      console.warn('Rust/WASM flock unavailable, falling back to JS Flock:', error);

      this.flock = new Flock(
        this.params.birdCount,
        this.params.bounds,
        this.params
      );

      this.flockRenderer = new FlockRenderer(
        this.sceneManager.scene,
        this.flock,
        this.params
      );
      this.flockBackend = 'js';
      this.backendVariant = 'js';
    }
  }

  initGUI() {
    this.gui = new GUIControls(this.params, {
      onBirdCountChange: (count) => this.setBirdCount(count),
      onReset: () => this.reset(),
      onTogglePause: () => this.togglePause(),
      onScreenshot: () => this.takeScreenshot(),
      onFullscreen: () => this.toggleFullscreen()
    });
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
      avgSimulationMs: Number(avgSim.toFixed(3)),
      avgFrameMs: Number(avgFrame.toFixed(3)),
      approxFps: Number(fps.toFixed(1))
    });

    this.benchmark.frames = 0;
    this.benchmark.simMs = 0;
    this.benchmark.frameMs = 0;
    this.benchmark.lastReportAt = performance.now();
  }

  initKeyboard() {
    window.addEventListener('keydown', (e) => {
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
        case 'KeyM':
          this.initAudioAnalyzer();
          break;
        case 'KeyB':
          this.toggleBenchmark();
          break;
      }
    });
  }

  setBirdCount(count) {
    this.flockRenderer.resize(count);
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
    this.time = timestamp * 0.001;

    if (!this.isPaused) {
      this.applyAudioReactiveModulation();
      const simStart = performance.now();
      this.flock.update(this.params);
      this.flockRenderer.update(this.time);

      if (this.benchmarkEnabled) {
        this.benchmark.simMs += performance.now() - simStart;
      }
    }

    this.sceneManager.update();
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

    if (this.audioLinkButton) {
      this.audioLinkButton.remove();
      this.audioLinkButton = null;
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
