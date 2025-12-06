import * as THREE from 'three';
import vertexShader from '../shaders/color-vertex.glsl';
import fragmentShader from '../shaders/color-fragment.glsl';

export class FlockRenderer {
  constructor(scene, flock, params) {
    this.scene = scene;
    this.flock = flock;
    this.params = params;
    
    this.geometry = null;
    this.material = null;
    this.points = null;
    
    this.initialize();
  }
  
  initialize() {
    // Create buffer geometry
    this.geometry = new THREE.BufferGeometry();
    
    // Set initial positions
    const positions = this.flock.getPositions();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
    
    // Create shader material
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        origin: { value: new THREE.Vector3(0, 0, 0) },
        maxDistance: { value: this.params.maxDistance },
        time: { value: 0 },
        particleSize: { value: this.params.particleSize }
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    
    // Create points object
    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);
  }
  
  /**
   * Update positions and uniforms each frame
   */
  update(time) {
    // Get new positions from flock
    const positions = this.flock.getPositions();
    
    // Check if buffer needs resizing
    const positionAttr = this.geometry.getAttribute('position');
    if (positionAttr.array.length !== positions.length) {
      this.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(positions, 3)
      );
    } else {
      // Update existing buffer
      positionAttr.array.set(positions);
      positionAttr.needsUpdate = true;
    }
    
    // Update uniforms
    this.material.uniforms.time.value = time;
    this.material.uniforms.particleSize.value = this.params.particleSize;
    this.material.uniforms.maxDistance.value = this.params.maxDistance;
  }
  
  /**
   * Handle flock size changes
   */
  resize(newCount) {
    // Flock will update its own arrays
    this.flock.setCount(newCount);
    
    // Force buffer update on next frame
    const positions = this.flock.getPositions();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
  }
  
  /**
   * Clean up resources
   */
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}




