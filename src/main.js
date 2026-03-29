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
    this.baseAudioParams = {
      maxSpeed: defaults.maxSpeed,
      matchingFactor: defaults.matchingFactor,
      avoidFactor: defaults.avoidFactor,
      turnFactor: defaults.turnFactor,
      particleSize: defaults.particleSize,
      maxDistance: defaults.maxDistance,
      centeringFactor: defaults.centeringFactor,
      visualRange: defaults.visualRange,
      protectedRange: defaults.protectedRange,
      margin: defaults.margin,
      minSpeed: defaults.minSpeed
    };
    this.beatEnvelope = 0;
    this.evolutionPhase = 0;
    this.evolutionPhaseSecondary = 0;
    this.marginTarget = defaults.margin;
    this.lastMarginMeasureIndex = -1;
    this.lastMarginPlaybackTime = 0;
    this.marginClockStarted = false;
    this.marginClockStartTime = 0;

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
      beatCount: 0,
      peak: 0
    };
    this.audioLinkButton = null;
    this.audioFileInput = null;
    this.noAudioFrames = 0;
    this.lastGuiRefreshAt = 0;
    this.intensity = 0;
    this.energyShort = 0;
    this.energyTrend = 0;
    this.lastProgressionSampleTime = 0;
    this.progressionState = 'calm';
    this.progressionProfile = { slowLaneGain: 0.75, marginPositiveBias: 0.5, cameraGain: 1.0 };
    this.lastProgressionStateChangeAt = 0;
    this.lastWallClockSampleTime = performance.now();
    this.pulseClockStarted = false;
    this.pulseClockStartTime = 0;
    this.lastPulseIndex = -1;
    this.pulseDepth = 0;
    this.pulseIntervalSec = 0.75;
    this.slowLaneSettings = {
      deadbandRel: 0.01,
      visualRange: { attackTau: 6.5, releaseTau: 8.5, maxStep: 0.18, min: 10, max: 100 },
      protectedRange: { attackTau: 6.0, releaseTau: 8.0, maxStep: 0.09, min: 2, max: 30 },
      centeringFactor: { attackTau: 8.5, releaseTau: 10.5, maxStep: 0.000012, min: 0, max: 0.002 },
      maxDistance: { attackTau: 7.5, releaseTau: 9.5, maxStep: 2.0, min: 30, max: 500 }
    };
    this.debugOptions = {
      showDebugHud: true,
      usePreprocessedTimeline: true,
      benchmarkEnabled: false
    };
    this.debugHudEl = null;
    this.lastHudUpdateAt = 0;
    this.fpsEstimate = 0;
    this.lastFrameTimestamp = performance.now();
    this.pulseSource = 'live';

    this.initScene();
  }

  async initialize() {
    await this.initFlock();
    this.initGUI();
    this.initStats();
    this.initDebugHud();
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

  async initAudioAnalyzer(file) {
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
      const preprocessMeta = this.audioAnalyzer.getPreprocessMeta?.();

      this.baseAudioParams.minSpeed = 5;
      this.baseAudioParams.protectedRange = 10;
      this.params.minSpeed = 5;
      this.params.protectedRange = 10;

      const preprocessNote =
        preprocessMeta?.status === 'ready'
          ? ` • preprocess: ${preprocessMeta.beats} beats / ${preprocessMeta.sections} sections`
          : (preprocessMeta?.status === 'disabled' ? ' • preprocess: unavailable (fallback mode)' : '');
      this.showStatus(`🎵 Audio visualizer active: ${file.name}${preprocessNote}`, false, 4500);
      this.noAudioFrames = 0;
      if (this.audioLinkButton) {
        this.audioLinkButton.textContent = '🎵 Audio File Loaded';
      }
      this.updateDebugHud(true);
    } catch (error) {
      console.error('Failed to initialize audio analyzer:', error);
      this.showStatus(`Audio load failed: ${error.message}`, true);
      this.audioAnalyzer = null;
      this.noAudioFrames = 0;
      if (this.audioLinkButton) {
        this.audioLinkButton.textContent = '🎵 Load MP3/WAV';
      }
    }

    this.audioInitializing = false;
  }

  getProgressionProfile(state) {
    switch (state) {
      case 'rising':
        return { slowLaneGain: 1.0, marginPositiveBias: 0.58, cameraGain: 1.5 };
      case 'peak':
        return { slowLaneGain: 1.25, marginPositiveBias: 0.66, cameraGain: 2.2 };
      case 'release':
        return { slowLaneGain: 0.85, marginPositiveBias: 0.43, cameraGain: 0.9 };
      case 'calm':
      default:
        return { slowLaneGain: 0.7, marginPositiveBias: 0.46, cameraGain: 0.7 };
    }
  }

  getAudioDeltaTime(playbackTime) {
    const now = performance.now();
    const wallDt = Math.max(1 / 120, (now - this.lastWallClockSampleTime) / 1000);
    this.lastWallClockSampleTime = now;

    if (!Number.isFinite(playbackTime)) return wallDt;
    if (playbackTime <= 0) return wallDt;
    if (this.lastProgressionSampleTime <= 0) {
      this.lastProgressionSampleTime = playbackTime;
      return wallDt;
    }

    const playbackDt = playbackTime - this.lastProgressionSampleTime;
    this.lastProgressionSampleTime = playbackTime;
    if (playbackDt <= 0 || playbackDt > 2) return wallDt;
    return playbackDt;
  }

  smoothingAlpha(dt, tauSeconds) {
    const tau = Math.max(0.001, tauSeconds);
    return 1 - Math.exp(-dt / tau);
  }

  updateProgressionState(loudness, bassEnergy, dt) {
    const compositeEnergy = loudness * 0.55 + bassEnergy * 0.45;

    const shortAlpha = this.smoothingAlpha(dt, 1.4);
    const trendAlpha = this.smoothingAlpha(dt, 10.5);
    this.energyShort += (compositeEnergy - this.energyShort) * shortAlpha;
    this.energyTrend += (compositeEnergy - this.energyTrend) * trendAlpha;

    const now = performance.now();
    const delta = this.energyShort - this.energyTrend;
    let nextState = this.progressionState;

    if (this.energyShort > 0.68 || delta > 0.2) {
      nextState = 'peak';
    } else if (delta > 0.07) {
      nextState = 'rising';
    } else if (delta < -0.04) {
      nextState = 'release';
    } else {
      nextState = 'calm';
    }

    if (nextState !== this.progressionState && now - this.lastProgressionStateChangeAt > 1500) {
      this.progressionState = nextState;
      this.lastProgressionStateChangeAt = now;
    }

    this.progressionProfile = this.getProgressionProfile(this.progressionState);
  }

  updatePulseClock(playbackTime) {
    if (playbackTime < this.pulseClockStartTime) {
      this.pulseClockStarted = false;
      this.pulseClockStartTime = 0;
      this.lastPulseIndex = -1;
      this.pulseDepth = 0;
    }

    if (!this.pulseClockStarted) {
      this.pulseClockStarted = true;
      this.pulseClockStartTime = playbackTime;
      this.lastPulseIndex = 0;
      return;
    }

    const elapsed = Math.max(0, playbackTime - this.pulseClockStartTime);
    const pulseIndex = Math.floor(elapsed / this.pulseIntervalSec);
    if (pulseIndex > this.lastPulseIndex) {
      this.lastPulseIndex = pulseIndex;
    }

    const pulsePhase = (elapsed % this.pulseIntervalSec) / this.pulseIntervalSec;
    this.pulseDepth = Math.sin(pulsePhase * Math.PI * 2);
  }

  updateSlowLaneParam(current, target, dt, config) {
    const magnitude = Math.max(Math.abs(current), Math.abs(target), 1e-6);
    const relativeDelta = Math.abs(target - current) / magnitude;
    if (relativeDelta < this.slowLaneSettings.deadbandRel) {
      return current;
    }

    const tau = target > current ? config.attackTau : config.releaseTau;
    const alpha = this.smoothingAlpha(dt, tau);
    const rawNext = current + (target - current) * alpha;
    const step = Math.max(-config.maxStep, Math.min(config.maxStep, rawNext - current));
    return Math.min(config.max, Math.max(config.min, current + step));
  }

  normalizeMarginStep(value) {
    const clamped = Math.min(100, Math.max(20, value));
    return 20 + Math.round((clamped - 20) / 20) * 20;
  }

  nextMarginStep(currentMargin, direction) {
    const current = this.normalizeMarginStep(currentMargin);

    if (current === 20 && direction < 0) return 60;
    if (current === 100 && direction > 0) return 40;

    const marginSteps = [20, 40, 60, 80, 100];
    const currentIndex = marginSteps.indexOf(current);
    const nextIndex = Math.min(4, Math.max(0, currentIndex + (direction > 0 ? 1 : -1)));

    return marginSteps[nextIndex];
  }

  maybeStepMarginOnMeasure(playbackTime, bassLevel, marginPositiveBias = 0.5) {
    if (playbackTime < this.lastMarginPlaybackTime) {
      this.lastMarginMeasureIndex = -1;
      this.marginClockStarted = false;
      this.marginClockStartTime = 0;
    }

    this.lastMarginPlaybackTime = playbackTime;

    if (!this.marginClockStarted) {
      if (bassLevel < 0.12) return;

      this.marginClockStarted = true;
      this.marginClockStartTime = playbackTime;
      this.lastMarginMeasureIndex = 0;
      return;
    }

    const elapsed = Math.max(0, playbackTime - this.marginClockStartTime);
    const currentMeasureIndex = Math.floor(elapsed / 4);
    if (currentMeasureIndex <= this.lastMarginMeasureIndex) return;

    for (let measureIndex = this.lastMarginMeasureIndex + 1; measureIndex <= currentMeasureIndex; measureIndex++) {
      this.marginTarget = this.normalizeMarginStep(this.marginTarget);

      if (Math.random() >= (1 / 3)) continue;

      const direction = Math.random() < marginPositiveBias ? 1 : -1;
      this.marginTarget = this.nextMarginStep(this.marginTarget, direction);
    }

    this.lastMarginMeasureIndex = currentMeasureIndex;
  }

  applyAudioReactiveModulation() {
    if (!this.audioAnalyzer || !this.audioAnalyzer.isRunning) return;

    this.audioFeatures = this.audioAnalyzer.getFeatures();
    const { rms, bass, mid, treble, beat, peak } = this.audioFeatures;

    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const shaped = (v, gamma = 1.0) => Math.pow(clamp01(v), gamma);

    const loudness = shaped(rms * 2.1, 0.85);
    const bassEnergy = shaped(bass * 2.0, 1.1);
    const midEnergy = shaped(mid * 2.0, 1.0);
    const trebleEnergy = shaped(treble * 2.2, 1.15);
    const transient = shaped(peak * 1.8, 1.0);

    const playbackTime = this.audioAnalyzer.getPlaybackTime();
    const dt = this.getAudioDeltaTime(playbackTime);
    const timelineState = this.debugOptions.usePreprocessedTimeline
      ? this.audioAnalyzer.getTimelineState?.(playbackTime)
      : null;
    const timelinePulse = this.debugOptions.usePreprocessedTimeline
      ? this.audioAnalyzer.getTimelinePulse?.(playbackTime)
      : null;

    if (timelineState) {
      this.progressionState = timelineState;
      this.progressionProfile = this.getProgressionProfile(this.progressionState);
    } else {
      this.updateProgressionState(loudness, bassEnergy, dt);
    }

    if (typeof timelinePulse === 'number' && Number.isFinite(timelinePulse)) {
      this.pulseDepth = timelinePulse;
      this.pulseSource = 'timeline';
    } else {
      this.updatePulseClock(playbackTime);
      this.pulseSource = 'live';
    }

    if (loudness < 0.01) {
      this.noAudioFrames++;
      if (this.noAudioFrames === 180) {
        this.showStatus('No audio signal detected yet. Try a different file or increase playback volume.', true, 4000);
      }
    } else {
      this.noAudioFrames = 0;
    }

    this.beatEnvelope = Math.max(beat, this.beatEnvelope * 0.88);

    const targetMaxSpeed = this.baseAudioParams.maxSpeed;
    const targetMatching = this.baseAudioParams.matchingFactor + midEnergy * 0.11 + loudness * 0.03;
    const targetAvoid = this.baseAudioParams.avoidFactor + trebleEnergy * 0.09 + transient * 0.04;
    const targetTurn = this.baseAudioParams.turnFactor - (this.beatEnvelope * 0.23 + transient * 0.1);
    const targetParticleSize = this.baseAudioParams.particleSize + loudness * 2.8 + transient * 1.2;
    const targetMaxDistance = this.baseAudioParams.maxDistance + (trebleEnergy * 170 + bassEnergy * 40) * this.progressionProfile.slowLaneGain;
    const targetCentering = this.baseAudioParams.centeringFactor + (bassEnergy * 0.00035 + loudness * 0.00015) * this.progressionProfile.slowLaneGain;
    const intensity = shaped((rms * 0.65 + bass * 0.2 + mid * 0.15) * 2.2, 0.9);
    this.intensity = intensity;
    const targetMinSpeed = this.baseAudioParams.minSpeed + intensity * 0.8;

    this.evolutionPhase += 0.0025 + loudness * 0.002;
    this.evolutionPhaseSecondary += 0.0012 + midEnergy * 0.0012;
    const topologyDrift =
      Math.sin(this.evolutionPhase) * 0.65 +
      Math.sin(this.evolutionPhaseSecondary + Math.PI * 0.25) * 0.35;

    const pulseVisualNudge = this.pulseDepth * 1.1 * this.progressionProfile.slowLaneGain;
    const targetVisualRange = this.baseAudioParams.visualRange + (topologyDrift * 7.5 + bassEnergy * 2.5) * this.progressionProfile.slowLaneGain + pulseVisualNudge;
    const targetProtectedRange = this.baseAudioParams.protectedRange + (topologyDrift * 2.4 + trebleEnergy * 0.5) * this.progressionProfile.slowLaneGain;

    const lerp = (current, target, alpha) => current + (target - current) * alpha;
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    this.maybeStepMarginOnMeasure(playbackTime, bassEnergy, this.progressionProfile.marginPositiveBias);

    this.params.maxSpeed = targetMaxSpeed;
    this.params.matchingFactor = lerp(this.params.matchingFactor, targetMatching, 0.12);
    this.params.avoidFactor = lerp(this.params.avoidFactor, targetAvoid, 0.12);
    this.params.turnFactor = clamp(lerp(this.params.turnFactor, targetTurn, 0.25), 0, 0.5);
    this.params.particleSize = lerp(this.params.particleSize, targetParticleSize, 0.18);
    this.params.maxDistance = this.updateSlowLaneParam(this.params.maxDistance, targetMaxDistance, dt, this.slowLaneSettings.maxDistance);
    this.params.centeringFactor = this.updateSlowLaneParam(this.params.centeringFactor, targetCentering, dt, this.slowLaneSettings.centeringFactor);
    this.params.minSpeed = clamp(lerp(this.params.minSpeed, targetMinSpeed, 0.18), 1, 10);
    this.params.maxSpeed = Math.max(targetMaxSpeed, this.params.minSpeed + 0.1);
    this.params.margin = this.normalizeMarginStep(this.marginTarget);
    this.params.visualRange = this.updateSlowLaneParam(this.params.visualRange, targetVisualRange, dt, this.slowLaneSettings.visualRange);
    this.params.protectedRange = this.updateSlowLaneParam(this.params.protectedRange, targetProtectedRange, dt, this.slowLaneSettings.protectedRange);
  }

  initAudioLinkButton() {
    if (this.audioLinkButton) return;

    const button = document.createElement('button');
    button.id = 'audio-link-button';
    button.type = 'button';
    button.textContent = '🎵 Load MP3/WAV';
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

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.mp3,.wav,audio/mpeg,audio/wav';
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
    document.body.appendChild(button);
    this.audioFileInput = fileInput;
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
      onFullscreen: () => this.toggleFullscreen(),
      onDebugHudChange: (enabled) => this.setDebugHudVisible(enabled),
      onTimelineToggle: (enabled) => {
        this.debugOptions.usePreprocessedTimeline = enabled;
        this.updateDebugHud(true);
      },
      onBenchmarkToggle: (enabled) => this.setBenchmarkEnabled(enabled)
    }, this.debugOptions);
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

  initDebugHud() {
    if (this.debugHudEl) return;

    this.debugHudEl = document.createElement('div');
    this.debugHudEl.id = 'debug-hud';
    this.debugHudEl.style.cssText = `
      position: fixed;
      top: 56px;
      left: 12px;
      z-index: 1003;
      min-width: 270px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(8, 14, 24, 0.82);
      border: 1px solid rgba(255,255,255,0.15);
      color: #d7f2ff;
      font: 12px/1.4 'SF Mono', 'Fira Code', monospace;
      pointer-events: none;
      backdrop-filter: blur(5px);
      white-space: pre-line;
    `;
    document.body.appendChild(this.debugHudEl);
    this.setDebugHudVisible(this.debugOptions.showDebugHud);
    this.updateDebugHud(true);
  }

  setDebugHudVisible(enabled) {
    this.debugOptions.showDebugHud = enabled;
    if (this.debugHudEl) {
      this.debugHudEl.style.display = enabled ? 'block' : 'none';
    }
  }

  updateDebugHud(force = false) {
    if (!this.debugHudEl || !this.debugOptions.showDebugHud) return;

    const now = performance.now();
    if (!force && now - this.lastHudUpdateAt < 220) return;
    this.lastHudUpdateAt = now;

    const preprocessMeta = this.audioAnalyzer?.getPreprocessMeta?.() || { status: 'idle', beats: 0, sections: 0 };
    const preprocessSummary = preprocessMeta.status === 'ready'
      ? `${preprocessMeta.status} (${preprocessMeta.beats} beats/${preprocessMeta.sections} sections)`
      : preprocessMeta.status;

    this.debugHudEl.textContent = [
      `Backend: ${this.backendVariant || this.flockBackend}`,
      `Preprocess: ${preprocessSummary}`,
      `Timeline mode: ${this.debugOptions.usePreprocessedTimeline ? 'enabled' : 'disabled'}`,
      `Section: ${this.progressionState}`,
      `Pulse source: ${this.pulseSource}`,
      `FPS(est): ${this.fpsEstimate.toFixed(1)}`,
      `Birds: ${this.flock?.count ?? this.params.birdCount}`
    ].join('\n');
  }

  setBenchmarkEnabled(enabled) {
    if (this.benchmarkEnabled === enabled) return;
    this.toggleBenchmark();
  }

  toggleBenchmark() {
    this.benchmarkEnabled = !this.benchmarkEnabled;
    this.debugOptions.benchmarkEnabled = this.benchmarkEnabled;
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
    this.updateDebugHud(true);
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

  maybeRefreshGuiDisplay() {
    if (!this.gui?.refreshDisplay) return;

    const now = performance.now();
    if (now - this.lastGuiRefreshAt < 160) return;

    this.gui.refreshDisplay();
    this.lastGuiRefreshAt = now;
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
          this.audioFileInput?.click();
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
    const frameDt = Math.max(0.001, frameStart - this.lastFrameTimestamp);
    this.lastFrameTimestamp = frameStart;
    const instantFps = 1000 / frameDt;
    this.fpsEstimate += (instantFps - this.fpsEstimate) * 0.12;
    this.stats.begin();
    this.time = timestamp * 0.001;

    if (!this.isPaused) {
      this.applyAudioReactiveModulation();
      this.sceneManager.setAutoRotateSpeed(0.12 + this.intensity * 2.0 * this.progressionProfile.cameraGain);
      this.maybeRefreshGuiDisplay();
      this.updateDebugHud();
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

    if (this.audioFileInput) {
      this.audioFileInput.remove();
      this.audioFileInput = null;
    }

    if (this.debugHudEl) {
      this.debugHudEl.remove();
      this.debugHudEl = null;
    }

    this.noAudioFrames = 0;
    this.intensity = 0;
    this.energyShort = 0;
    this.energyTrend = 0;
    this.lastProgressionSampleTime = 0;
    this.progressionState = 'calm';
    this.progressionProfile = { slowLaneGain: 0.75, marginPositiveBias: 0.5, cameraGain: 1.0 };
    this.lastProgressionStateChangeAt = 0;
    this.pulseClockStarted = false;
    this.pulseClockStartTime = 0;
    this.lastPulseIndex = -1;
    this.pulseDepth = 0;
    this.lastWallClockSampleTime = performance.now();
    this.lastMarginMeasureIndex = -1;
    this.lastMarginPlaybackTime = 0;
    this.marginClockStarted = false;
    this.marginClockStartTime = 0;
    this.marginTarget = this.baseAudioParams.margin;
    this.sceneManager?.setAutoRotateSpeed?.(0.12);
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
