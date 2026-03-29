import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export class SceneManager {
  constructor(container) {
    this.container = container;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    
    this.initScene();
    this.initCamera();
    this.initRenderer();
    this.initControls();
    this.initLighting();
    this.setupResize();
  }
  
  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0f);
    
    // Add subtle fog for depth
    this.scene.fog = new THREE.FogExp2(0x0a0a0f, 0.002);
  }
  
  initCamera() {
    const aspect = this.width / this.height;
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 2000);
    this.defaultCameraPosition = new THREE.Vector3(0, 0, 1400);
    this.defaultCameraTarget = new THREE.Vector3(0, 0, 0);
    this.camera.position.copy(this.defaultCameraPosition);
    this.camera.lookAt(this.defaultCameraTarget);
    this.choreographyState = {
      enabled: true,
      orbitAngle: 0,
      currentRadius: this.defaultCameraPosition.length(),
      targetRadius: this.defaultCameraPosition.length(),
      currentHeight: this.defaultCameraPosition.y
    };
    this.minChoreographyRadius = 780;
  }
  
  initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    
    this.container.appendChild(this.renderer.domElement);
    this.initPostProcessing();
  }

  initPostProcessing() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(this.width, this.height);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.45, 0.55, 0.82);
    this.composer.addPass(this.bloomPass);

    const vignetteShader = {
      uniforms: {
        tDiffuse: { value: null },
        strength: { value: 0.18 },
        softness: { value: 0.35 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float strength;
        uniform float softness;
        varying vec2 vUv;

        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          vec2 uv = vUv - 0.5;
          float dist = dot(uv, uv) * 2.8;
          float vignette = smoothstep(0.15, 1.0 - softness, dist);
          color.rgb *= (1.0 - vignette * strength);
          gl_FragColor = color;
        }
      `
    };
    this.vignettePass = new ShaderPass(vignetteShader);
    this.composer.addPass(this.vignettePass);

    const chromaShader = {
      uniforms: {
        tDiffuse: { value: null },
        amount: { value: 0.0008 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float amount;
        varying vec2 vUv;

        void main() {
          vec2 offset = (vUv - 0.5) * amount;
          vec4 r = texture2D(tDiffuse, vUv + offset);
          vec4 g = texture2D(tDiffuse, vUv);
          vec4 b = texture2D(tDiffuse, vUv - offset);
          gl_FragColor = vec4(r.r, g.g, b.b, g.a);
        }
      `
    };
    this.chromaticPass = new ShaderPass(chromaShader);
    this.composer.addPass(this.chromaticPass);
  }
  
  initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.defaultCameraTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.rotateSpeed = 0.8;
    this.controls.autoRotate = true;
    this.baseAutoRotateSpeed = 0.12;
    this.controls.autoRotateSpeed = this.baseAutoRotateSpeed;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 2000;
    this.controls.enablePan = true;
    
    // Touch support
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN
    };
    this.controls.update();
    this.controls.saveState();
  }
  
  initLighting() {
    // Minimal ambient light - particles are self-illuminated via shaders
    const ambient = new THREE.AmbientLight(0xffffff, 0.1);
    this.scene.add(ambient);
  }
  
  setupResize() {
    window.addEventListener('resize', () => {
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      
      this.renderer.setSize(this.width, this.height);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.composer?.setSize(this.width, this.height);
      this.bloomPass?.setSize(this.width, this.height);
    });
  }
  
  add(object) {
    this.scene.add(object);
  }
  
  remove(object) {
    this.scene.remove(object);
  }
  
  setAutoRotateSpeed(speed) {
    this.controls.autoRotateSpeed = Math.min(2.5, Math.max(0.08, speed));
  }

  setCameraChoreographyEnabled(enabled) {
    this.choreographyState.enabled = enabled;
  }

  updateCameraChoreography({ section = 'calm', intensity = 0, pulse = 0, deltaTime = 0.016 }) {
    if (!this.choreographyState.enabled) return;

    const profiles = {
      calm: { radius: 1360, orbitSpeed: 0.04, height: 40 },
      rising: { radius: 1180, orbitSpeed: 0.09, height: 70 },
      peak: { radius: 980, orbitSpeed: 0.14, height: 95 },
      release: { radius: 1240, orbitSpeed: 0.06, height: 55 }
    };
    const profile = profiles[section] || profiles.calm;
    const pulseDepth = Math.max(-1, Math.min(1, pulse));
    const safeTargetRadius = Math.max(
      this.minChoreographyRadius,
      profile.radius - intensity * 110 - Math.max(0, pulseDepth) * 45
    );

    const smoothing = 1 - Math.exp(-Math.max(0.001, deltaTime) / 1.5);
    this.choreographyState.targetRadius = safeTargetRadius;
    this.choreographyState.currentRadius +=
      (this.choreographyState.targetRadius - this.choreographyState.currentRadius) * smoothing;
    this.choreographyState.currentRadius = Math.max(this.minChoreographyRadius, this.choreographyState.currentRadius);

    this.choreographyState.orbitAngle += profile.orbitSpeed * Math.max(0.4, 0.5 + intensity) * deltaTime;
    this.choreographyState.currentHeight +=
      ((profile.height + pulseDepth * 26) - this.choreographyState.currentHeight) * smoothing;

    const x = Math.cos(this.choreographyState.orbitAngle) * this.choreographyState.currentRadius;
    const z = Math.sin(this.choreographyState.orbitAngle) * this.choreographyState.currentRadius;
    this.camera.position.set(x, this.choreographyState.currentHeight, z);
    this.controls.target.set(0, pulseDepth * 12, 0);
  }

  update() {
    this.controls.update();
  }
  
  render() {
    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  setPostProcessing({ bloomStrength, vignetteStrength, chromaticAberration }) {
    if (this.bloomPass && Number.isFinite(bloomStrength)) {
      this.bloomPass.strength = Math.min(1.9, Math.max(0.0, bloomStrength));
    }
    if (this.vignettePass && Number.isFinite(vignetteStrength)) {
      this.vignettePass.uniforms.strength.value = Math.min(0.45, Math.max(0.0, vignetteStrength));
    }
    if (this.chromaticPass && Number.isFinite(chromaticAberration)) {
      this.chromaticPass.uniforms.amount.value = Math.min(0.0035, Math.max(0.0, chromaticAberration));
    }
  }
  
  getCanvas() {
    return this.renderer.domElement;
  }
  
  resetCamera() {
    this.controls.target.copy(this.defaultCameraTarget);
    this.camera.position.copy(this.defaultCameraPosition);
    this.camera.lookAt(this.defaultCameraTarget);
    this.choreographyState.currentRadius = this.defaultCameraPosition.length();
    this.choreographyState.targetRadius = this.defaultCameraPosition.length();
    this.choreographyState.currentHeight = this.defaultCameraPosition.y;
    this.controls.update();
    this.controls.saveState();
  }
}


