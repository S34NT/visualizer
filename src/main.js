import Stats from 'stats.js';
import { SceneManager } from './scene/SceneManager.js';
import { Flock } from './boids/Flock.js';
import { FlockRenderer } from './boids/FlockRenderer.js';
import { GUIControls } from './controls/GUIControls.js';
import { HandFaceTracker } from './tracking/HandFaceTracker.js';
import { AudioAnalyzer } from './audio/AudioAnalyzer.js';
import { defaults } from './config/defaults.js';

class MurmurationSimulator {
  constructor() {
    // Copy defaults to mutable params object
    this.params = { ...defaults };
    
    // State
    this.isPaused = false;
    this.time = 0;
    
    // Tracking
    this.tracker = null;
    this.attractionPoints = [];
    this.trackingInitializing = false;

    // Audio visualization
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
    
    // Initialize components
    this.initScene();
    this.initFlock();
    this.initGUI();
    this.initStats();
    this.initKeyboard();
    this.initAudioLinkButton();
    
    // Start animation loop
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  async initAudioAnalyzer() {
    if (this.audioAnalyzer || this.audioInitializing) return;

    this.audioInitializing = true;
    this.showTrackingStatus('🎵 Link a YouTube video to start audio reactivity...');

    try {
      this.audioAnalyzer = new AudioAnalyzer({ monitorGain: 1.0 });
      const youtubeUrl = window.prompt('Paste a YouTube URL for audio reactivity:');
      if (!youtubeUrl) {
        throw new Error('No YouTube URL provided.');
      }
      if (typeof this.audioAnalyzer.startFromYouTube === 'function') {
        await this.audioAnalyzer.startFromYouTube(youtubeUrl);
      } else if (typeof this.audioAnalyzer.startFromMic === 'function') {
        // Compatibility fallback for older analyzer builds.
        await this.audioAnalyzer.startFromMic(youtubeUrl);
      } else {
        throw new Error('AudioAnalyzer has no supported start method.');
      }
      this.showTrackingStatus('🎵 Audio visualizer active from shared YouTube tab.', false, 3500);
      this.noAudioFrames = 0;
      if (this.audioLinkButton) {
        this.audioLinkButton.textContent = '🎵 YouTube Audio Linked';
      }
    } catch (error) {
      console.error('Failed to initialize audio analyzer:', error);
      this.showTrackingStatus(`Audio link failed: ${error.message}`, true);
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
        this.showTrackingStatus('No tab audio detected yet. Make sure YouTube is playing and tab audio sharing is enabled.', true, 4000);
      }
    } else {
      this.noAudioFrames = 0;
    }

    // Audio-reactive mapping tuned for visibility on mobile devices.
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
      onFullscreen: () => this.toggleFullscreen(),
      onTrackingToggle: (enabled) => this.toggleTracking(enabled),
      onPreviewToggle: (visible) => this.toggleTrackingPreview(visible)
    });
  }
  
  /**
   * Initialize hand/face tracker
   */
  async initTracker() {
    if (this.tracker || this.trackingInitializing) return;
    
    this.trackingInitializing = true;
    this.showTrackingStatus('Loading AI models...');
    
    try {
      this.tracker = new HandFaceTracker(this.params);
      
      // Set up tracking update callback
      this.tracker.onTrackingUpdate = (points) => {
        this.attractionPoints = points;
      };
      
      // Set up error callback
      this.tracker.onError = (message) => {
        this.showTrackingStatus(message, true);
        this.params.trackingEnabled = false;
        this.gui.gui.controllersRecursive().forEach(c => c.updateDisplay());
        this.trackingInitializing = false;
      };
      
      // Start tracking
      const success = await this.tracker.start();
      
      if (success) {
        this.showTrackingStatus('🖐️ Tracking active! Move your hands.', false, 3000);
      } else {
        this.showTrackingStatus('Failed to start tracking', true);
        this.params.trackingEnabled = false;
        this.gui.gui.controllersRecursive().forEach(c => c.updateDisplay());
      }
    } catch (error) {
      console.error('Failed to initialize tracker:', error);
      this.showTrackingStatus('Tracking initialization failed. Check console for details.', true);
      this.params.trackingEnabled = false;
      this.gui.gui.controllersRecursive().forEach(c => c.updateDisplay());
    }
    
    this.trackingInitializing = false;
  }
  
  /**
   * Toggle hand/face tracking
   */
  async toggleTracking(enabled) {
    if (enabled) {
      await this.initTracker();
    } else {
      if (this.tracker) {
        this.tracker.stop();
        this.attractionPoints = [];
      }
      this.hideTrackingStatus();
    }
  }
  
  /**
   * Toggle tracking preview visibility
   */
  toggleTrackingPreview(visible) {
    if (this.tracker) {
      this.tracker.setPreviewVisible(visible);
    }
  }
  
  /**
   * Show tracking status message
   */
  showTrackingStatus(message, isError = false, autoHide = 0) {
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
  
  /**
   * Hide tracking status
   */
  hideTrackingStatus() {
    const statusEl = document.getElementById('tracking-status');
    if (statusEl) {
      statusEl.style.opacity = '0';
    }
  }
  
  initStats() {
    this.stats = new Stats();
    this.stats.showPanel(0); // FPS panel
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
        case 'KeyT':
          // Toggle tracking with T key
          this.params.trackingEnabled = !this.params.trackingEnabled;
          this.toggleTracking(this.params.trackingEnabled);
          this.gui.gui.controllersRecursive().forEach(c => c.updateDisplay());
          break;
        case 'KeyP':
          // Toggle preview with P key
          if (this.tracker) {
            this.params.showPreview = !this.params.showPreview;
            this.toggleTrackingPreview(this.params.showPreview);
            this.gui.gui.controllersRecursive().forEach(c => c.updateDisplay());
          }
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
    
    // Update pause indicator
    const indicator = document.getElementById('pause-indicator');
    if (indicator) {
      indicator.classList.toggle('visible', this.isPaused);
    }
  }
  
  takeScreenshot() {
    // Render one frame to ensure latest state
    this.sceneManager.render();
    
    // Get canvas data
    const canvas = this.sceneManager.getCanvas();
    const dataURL = canvas.toDataURL('image/png');
    
    // Create download link
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
    
    // Update time (in seconds)
    this.time = timestamp * 0.001;
    
    // Update simulation if not paused
    if (!this.isPaused) {
      this.applyAudioReactiveModulation();

      // Pass attraction points if tracking is enabled
      const points = this.params.trackingEnabled ? this.attractionPoints : null;
      this.flock.update(this.params, points);
      this.flockRenderer.update(this.time);
    }
    
    // Update camera controls
    this.sceneManager.update();
    
    // Render
    this.sceneManager.render();
    
    this.stats.end();
  }
  
  /**
   * Cleanup on page unload
   */
  dispose() {
    if (this.tracker) {
      this.tracker.dispose();
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

// Handle cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (window.simulator) {
    window.simulator.dispose();
  }
});

// Start the simulator when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.simulator = new MurmurationSimulator();
  });
} else {
  window.simulator = new MurmurationSimulator();
}



