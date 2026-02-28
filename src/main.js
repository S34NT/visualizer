import Stats from 'stats.js';
import { SceneManager } from './scene/SceneManager.js';
import { Flock } from './boids/Flock.js';
import { FlockRenderer } from './boids/FlockRenderer.js';
import { GUIControls } from './controls/GUIControls.js';
import { AudioAnalyzer } from './audio/AudioAnalyzer.js';
import { defaults } from './config/defaults.js';

class MurmurationSimulator {
  constructor() {
    this.params = { ...defaults };

    this.isPaused = false;
    this.time = 0;

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
    this.initFlock();
    this.initGUI();
    this.initStats();
    this.initKeyboard();
    this.initAudioLinkButton();

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

  initFlock() {
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
        case 'KeyM':
          this.initAudioAnalyzer();
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

    this.stats.begin();
    this.time = timestamp * 0.001;

    if (!this.isPaused) {
      this.applyAudioReactiveModulation();
      this.flock.update(this.params);
      this.flockRenderer.update(this.time);
    }

    this.sceneManager.update();
    this.sceneManager.render();
    this.stats.end();
  }

  dispose() {
    if (this.audioAnalyzer) {
      this.audioAnalyzer.dispose();
    }

    if (this.audioLinkButton) {
      this.audioLinkButton.remove();
      this.audioLinkButton = null;
    }

    if (this.audioAnalyzer) {
      this.audioAnalyzer.dispose();
    }

    if (this.audioLinkButton) {
      this.audioLinkButton.remove();
      this.audioLinkButton = null;
    this.noAudioFrames = 0;
    }
  }
}

window.addEventListener('beforeunload', () => {
  if (window.simulator) {
    window.simulator.dispose();
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.simulator = new MurmurationSimulator();
  });
} else {
  window.simulator = new MurmurationSimulator();
}
