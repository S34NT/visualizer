import GUI from 'lil-gui';
import { presets } from '../config/defaults.js';

export class GUIControls {
  constructor(params, callbacks) {
    this.params = params;
    this.callbacks = callbacks;
    this.gui = new GUI({ title: 'Murmuration Controls' });
    
    this.initControls();
  }
  
  initControls() {
    // Flock folder
    const flockFolder = this.gui.addFolder('Flock');
    flockFolder.add(this.params, 'birdCount', 100, 10000, 100)
      .name('Bird Count')
      .onChange(value => this.callbacks.onBirdCountChange?.(value));
    
    // Behavior folder
    const behaviorFolder = this.gui.addFolder('Behavior');
    behaviorFolder.add(this.params, 'visualRange', 10, 100, 1)
      .name('Visual Range');
    behaviorFolder.add(this.params, 'protectedRange', 2, 30, 1)
      .name('Protected Range');
    behaviorFolder.add(this.params, 'centeringFactor', 0.0001, 0.002, 0.0001)
      .name('Cohesion');
    behaviorFolder.add(this.params, 'avoidFactor', 0.01, 0.2, 0.01)
      .name('Separation');
    behaviorFolder.add(this.params, 'matchingFactor', 0.01, 0.2, 0.01)
      .name('Alignment');
    
    // Movement folder
    const movementFolder = this.gui.addFolder('Movement');
    movementFolder.add(this.params, 'minSpeed', 1, 10, 0.5)
      .name('Min Speed');
    movementFolder.add(this.params, 'maxSpeed', 2, 15, 0.5)
      .name('Max Speed');
    movementFolder.add(this.params, 'turnFactor', 0.05, 0.5, 0.01)
      .name('Turn Factor');
    movementFolder.add(this.params, 'margin', 20, 100, 5)
      .name('Margin');
    
    // Visual folder
    const visualFolder = this.gui.addFolder('Visual');
    visualFolder.add(this.params, 'particleSize', 1, 10, 0.5)
      .name('Particle Size');
    visualFolder.add(this.params, 'maxDistance', 100, 400, 10)
      .name('Color Distance');
    
    // Presets folder
    const presetsFolder = this.gui.addFolder('Presets');
    const presetOptions = {
      preset: 'default'
    };
    presetsFolder.add(presetOptions, 'preset', Object.keys(presets))
      .name('Load Preset')
      .onChange(name => this.loadPreset(name));
    
    // Actions folder
    const actionsFolder = this.gui.addFolder('Actions');
    actionsFolder.add({
      reset: () => this.callbacks.onReset?.()
    }, 'reset').name('Reset Flock');
    actionsFolder.add({
      pause: () => this.callbacks.onTogglePause?.()
    }, 'pause').name('Pause / Play');
    actionsFolder.add({
      screenshot: () => this.callbacks.onScreenshot?.()
    }, 'screenshot').name('Screenshot');
    actionsFolder.add({
      fullscreen: () => this.callbacks.onFullscreen?.()
    }, 'fullscreen').name('Fullscreen');
    
    // Open important folders by default
    flockFolder.open();
    behaviorFolder.open();
  }
  
  /**
   * Load a preset configuration
   */
  loadPreset(name) {
    const preset = presets[name];
    if (!preset) return;
    
    // Update params object
    Object.keys(preset).forEach(key => {
      if (key in this.params) {
        this.params[key] = preset[key];
      }
    });
    
    // Update GUI controllers
    this.gui.controllersRecursive().forEach(controller => {
      controller.updateDisplay();
    });
    
    // Trigger bird count change if needed
    if (preset.birdCount && this.callbacks.onBirdCountChange) {
      this.callbacks.onBirdCountChange(preset.birdCount);
    }
  }
  
  /**
   * Update pause button text
   */
  setPauseState(isPaused) {
    // The GUI doesn't have direct access to change button text
    // but we can track state for other purposes
    this.isPaused = isPaused;
  }
  
  /**
   * Show or hide the GUI
   */
  toggle() {
    if (this.gui._hidden) {
      this.gui.show();
    } else {
      this.gui.hide();
    }
  }
  
  /**
   * Clean up
   */
  dispose() {
    this.gui.destroy();
  }
}

