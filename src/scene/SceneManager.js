import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    
    this.container.appendChild(this.renderer.domElement);
  }
  
  initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.defaultCameraTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.rotateSpeed = 0.8;
    this.controls.autoRotate = true;
    this.baseAutoRotateSpeed = 0.4;
    this.controls.autoRotateSpeed = this.baseAutoRotateSpeed;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 1000;
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
    });
  }
  
  add(object) {
    this.scene.add(object);
  }
  
  remove(object) {
    this.scene.remove(object);
  }
  
  setAutoRotateSpeed(speed) {
    this.controls.autoRotateSpeed = Math.max(0.05, speed);
  }

  update() {
    this.controls.update();
  }
  
  render() {
    this.renderer.render(this.scene, this.camera);
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




