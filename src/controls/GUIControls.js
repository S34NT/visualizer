import GUI from 'lil-gui';
import { presets } from '../config/defaults.js';

export class GUIControls {
  constructor(params, callbacks, director = null) {
    this.params = params;
    this.callbacks = callbacks;
    this.director = director;
    this.gui = new GUI({ title: 'Murmuration Controls' });

    this.initControls();
  }

  initControls() {
    if (this.director) {
      const dir = this.director;
      const showFolder = this.gui.addFolder('Show');
      showFolder.add(dir, 'autopilot').name('Autopilot');
      showFolder.add(dir, 'scene', ['auto', ...dir.sceneNames]).name('Scene')
        .onChange((name) => this.callbacks.onSceneSelect?.(name));
      showFolder.add({ next: () => this.callbacks.onNextScene?.() }, 'next').name('Next Scene (N)');
      showFolder.add(dir, 'intensity', 0.3, 2, 0.05).name('Intensity');
      showFolder.add(dir, 'musicSpeed', 0, 1, 0.05).name('Music → Speed');
      showFolder.add(dir, 'energy', 0, 1.3).name('Energy').listen().disable();
      showFolder.add(dir, 'trails').name('Trails (T)')
        .onChange((v) => this.callbacks.onTrails?.(v));
      showFolder.add(dir, 'bloom').name('Bloom (G)')
        .onChange((v) => this.callbacks.onBloom?.(v));
      showFolder.add(dir, 'cameraAuto').name('Camera Autopilot')
        .onChange((v) => this.callbacks.onCameraAuto?.(v));
      showFolder.add(dir, 'cymatics', 0, 2, 0.05).name('Cymatics');
      showFolder.add(dir, 'groups', 0, 2, 0.05).name('Instrument Groups');
      showFolder.add(dir, 'showLabel').name('Scene Label');
      showFolder.open();

      const motionFolder = this.gui.addFolder('Motion & Performance');
      motionFolder.add(dir, 'speed', 0.25, 4, 0.05).name('Speed ×');
      motionFolder.add(dir, 'substeps', 1, 4, 1).name('Sim Steps / Frame');
      motionFolder.add(dir, 'neighborCap', 8, 128, 4).name('Neighbour Cap');
      motionFolder.add(dir, 'autoQuality').name('Auto Quality');
      motionFolder.add(dir, 'perfHud').name('Perf HUD (P)')
        .onChange((v) => this.callbacks.onPerfHud?.(v));
      motionFolder.add(dir, 'liveBirds').name('Live Birds').listen().disable();
      motionFolder.add(dir, 'circularity').name('Circularity %').listen().disable();
      motionFolder.add(dir, 'spinBreaks').name('Spin Breaks').listen().disable();
      motionFolder.open();

      const evo = dir.evo;
      const evoFolder = this.gui.addFolder('Evolution');
      evoFolder.add(evo, 'enabled').name('Evolution');
      evoFolder.add(evo, 'kinship', 0, 1, 0.05).name('Kinship');
      evoFolder.add(evo, 'xeno', 0, 0.12, 0.005).name('Rivalry');
      evoFolder.add(evo, 'mutation', 0, 0.05, 0.002).name('Mutation');
      evoFolder.add(evo, 'lineageColor', 0, 1, 0.05).name('Lineage Colour');
      evoFolder.add({ extinction: () => this.callbacks.onExtinction?.() }, 'extinction').name('Extinction Event (X)');
      evoFolder.add(evo, 'species').name('Lineages').listen().disable();
      evoFolder.add(evo, 'dominant').name('Dominant %').listen().disable();
    }

    const flockFolder = this.gui.addFolder('Flock');
    flockFolder.add(this.params, 'birdCount', 100, 60000, 100)
      .name('Max Birds')
      .onChange(value => this.callbacks.onBirdCountChange?.(value));

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

    const movementFolder = this.gui.addFolder('Movement');
    movementFolder.add(this.params, 'minSpeed', 1, 10, 0.5)
      .name('Min Speed');
    movementFolder.add(this.params, 'maxSpeed', 2, 15, 0.5)
      .name('Max Speed');
    movementFolder.add(this.params, 'turnFactor', 0.05, 0.5, 0.01)
      .name('Turn Factor');
    movementFolder.add(this.params, 'margin', 20, 100, 5)
      .name('Margin');

    const visualFolder = this.gui.addFolder('Visual');
    visualFolder.add(this.params, 'particleSize', 1, 10, 0.5)
      .name('Particle Size');
    visualFolder.add(this.params, 'maxDistance', 100, 400, 10)
      .name('Color Distance');

    const presetsFolder = this.gui.addFolder('Presets');
    const presetOptions = {
      preset: 'default'
    };
    presetsFolder.add(presetOptions, 'preset', Object.keys(presets))
      .name('Load Preset')
      .onChange(name => this.loadPreset(name));

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

    this.gui.close();
  }

  loadPreset(name) {
    const preset = presets[name];
    if (!preset) return;

    // Presets are hand-tuned flock settings; they only make sense with the
    // autopilot off, otherwise the director overwrites them next frame.
    if (this.director) this.director.autopilot = false;

    Object.keys(preset).forEach(key => {
      if (key in this.params) {
        this.params[key] = preset[key];
      }
    });

    this.refreshDisplay();

    if (preset.birdCount && this.callbacks.onBirdCountChange) {
      this.callbacks.onBirdCountChange(preset.birdCount);
    }
  }

  refreshDisplay() {
    this.gui.controllersRecursive().forEach(controller => {
      controller.updateDisplay();
    });
  }

  setPauseState(isPaused) {
    this.isPaused = isPaused;
  }

  toggle() {
    if (this.gui._hidden) {
      this.gui.show();
    } else {
      this.gui.hide();
    }
  }

  dispose() {
    this.gui.destroy();
  }
}
