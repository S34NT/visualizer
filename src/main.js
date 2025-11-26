import Stats from 'stats.js';
import { SceneManager } from './scene/SceneManager.js';
import { Flock } from './boids/Flock.js';
import { FlockRenderer } from './boids/FlockRenderer.js';
import { GUIControls } from './controls/GUIControls.js';
import { defaults } from './config/defaults.js';

class MurmurationSimulator {
  constructor() {
    // Copy defaults to mutable params object
    this.params = { ...defaults };
    
    // State
    this.isPaused = false;
    this.time = 0;
    
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
      onFullscreen: () => this.toggleFullscreen()
    });
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
      this.flock.update(this.params);
      this.flockRenderer.update(this.time);
    }
    
    // Update camera controls
    this.sceneManager.update();
    
    // Render
    this.sceneManager.render();
    
    this.stats.end();
  }
}

// Start the simulator when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new MurmurationSimulator());
} else {
  new MurmurationSimulator();
}

