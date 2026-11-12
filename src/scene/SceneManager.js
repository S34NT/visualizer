import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export class SceneManager {
  constructor(container) {
    this.container = container;
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    this.trailsEnabled = true;
    this.bloomEnabled = true;
    this.backgroundColor = new THREE.Color().setRGB(0.004, 0.004, 0.007);

    this.initScene();
    this.initCamera();
    this.initRenderer();
    this.initPostProcessing();
    this.initControls();
    this.initLighting();
    this.setupResize();
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = this.backgroundColor;
    this.scene.fog = new THREE.FogExp2(this.backgroundColor.getHex(), 0.0016);
  }

  initCamera() {
    const aspect = this.width / this.height;
    this.camera = new THREE.PerspectiveCamera(this.fovFor(aspect), aspect, 0.1, 3000);
    this.defaultCameraPosition = new THREE.Vector3(280, 180, 620);
    this.defaultCameraTarget = new THREE.Vector3(0, 0, 0);
    this.camera.position.copy(this.defaultCameraPosition);
    this.camera.lookAt(this.defaultCameraTarget);
  }

  initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });

    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Filmic tone mapping lets dense additive overlap roll off smoothly instead of clipping.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.container.appendChild(this.renderer.domElement);
  }

  pixelRatio() {
    // Post-processing cost scales with pixels; cap DPR so phones and 4K stay smooth.
    return Math.min(window.devicePixelRatio || 1, 1.5) * (this.pixelRatioScale || 1);
  }

  /** Scale rendered resolution (0.5..1); the quality controller lowers it when GPU-bound. */
  setPixelRatioScale(scale) {
    const s = Math.min(1, Math.max(0.4, scale));
    if (s === (this.pixelRatioScale || 1)) return;
    this.pixelRatioScale = s;
    this.applySize();
  }

  applySize() {
    const dpr = this.pixelRatio();
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(dpr);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(this.width, this.height);
    this.bloomPass.resolution.set(this.width, this.height);
  }

  initPostProcessing() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.pixelRatio());
    this.composer.setSize(this.width, this.height);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.afterimagePass = new AfterimagePass(0.85);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      0.35,  // strength
      0.4,   // radius
      0.75   // threshold: only the hottest cores bloom
    );
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.afterimagePass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
  }

  initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.defaultCameraTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.rotateSpeed = 0.8;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 0.4;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 1400;
    this.controls.enablePan = true;

    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN
    };
    this.controls.update();
    this.controls.saveState();
  }

  initLighting() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.1);
    this.scene.add(ambient);
  }

  setupResize() {
    window.addEventListener('resize', () => {
      this.width = window.innerWidth;
      this.height = window.innerHeight;

      this.camera.aspect = this.width / this.height;
      this.camera.fov = this.fovFor(this.camera.aspect);
      this.camera.updateProjectionMatrix();
      this.applySize();
    });
  }

  /**
   * Vertical field of view: 60° in landscape; portrait screens open up (to 85°)
   * so the narrow horizontal view still fits the whole flock without the
   * camera retreating to the far distance.
   */
  fovFor(aspect) {
    if (aspect >= 1) return 60;
    const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(30)) / aspect);
    return Math.min(85, Math.max(60, THREE.MathUtils.radToDeg(half) * 2));
  }

  /**
   * Apply choreographed post-processing state.
   * trail: 0..1 (0 = crisp, 1 = long persistence), bloom: 0..1.4, background: [r,g,b]
   */
  applyVisual(visual, dt = 1 / 60) {
    if (this.trailsEnabled) {
      // damp is per frame; raise it to the frame-time power so trail length is
      // measured in seconds regardless of the refresh rate.
      const perFrameAt60 = 0.55 + 0.42 * visual.trail;
      this.afterimagePass.uniforms.damp.value = Math.pow(perFrameAt60, dt * 60);
    }
    if (this.bloomEnabled) {
      this.bloomPass.strength = 0.12 + 0.45 * visual.bloom;
    }
    const bg = visual.background;
    this.backgroundColor.setRGB(bg[0], bg[1], bg[2]);
    this.scene.fog.color.copy(this.backgroundColor);
  }

  setTrailsEnabled(enabled) {
    this.trailsEnabled = enabled;
    this.afterimagePass.enabled = enabled;
  }

  setBloomEnabled(enabled) {
    this.bloomEnabled = enabled;
    this.bloomPass.enabled = enabled;
  }

  add(object) {
    this.scene.add(object);
  }

  remove(object) {
    this.scene.remove(object);
  }

  update() {
    this.controls.update();
  }

  render() {
    this.composer.render();
  }

  getCanvas() {
    return this.renderer.domElement;
  }

  resetCamera() {
    this.controls.target.copy(this.defaultCameraTarget);
    this.camera.position.copy(this.defaultCameraPosition);
    this.camera.lookAt(this.defaultCameraTarget);
    this.controls.update();
    this.controls.saveState();
  }
}
