import Stats from 'stats.js';
import { SceneManager } from './scene/SceneManager.js';
import { Flock } from './boids/Flock.js';
import { FlockRenderer } from './boids/FlockRenderer.js';
import { GUIControls } from './controls/GUIControls.js';
import { HandFaceTracker } from './tracking/HandFaceTracker.js';
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
    
    // Initialize components
    this.initScene();
    this.initFlock();
    this.initGUI();
    this.initStats();
    this.initKeyboard();
    
    // Start animation loop
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
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




