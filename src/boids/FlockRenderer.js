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

  getPositionsArray() {
    if (typeof this.flock.getPositionsView === 'function') {
      return this.flock.getPositionsView();
    }
    return this.flock.getPositions();
  }

  initialize() {
    this.geometry = new THREE.BufferGeometry();

    const positions = this.getPositionsArray();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );

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

    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);
  }

  update(time) {
    const positions = this.getPositionsArray();

    const positionAttr = this.geometry.getAttribute('position');
    const sameLength = positionAttr.array.length === positions.length;
    const sameBackingStore =
      positionAttr.array.buffer === positions.buffer &&
      positionAttr.array.byteOffset === positions.byteOffset;

    if (!sameLength || !sameBackingStore) {
      this.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(positions, 3)
      );
    } else if (positionAttr.array !== positions) {
      positionAttr.array.set(positions);
      positionAttr.needsUpdate = true;
    } else {
      positionAttr.needsUpdate = true;
    }

    this.material.uniforms.time.value = time;
    this.material.uniforms.particleSize.value = this.params.particleSize;
    this.material.uniforms.maxDistance.value = this.params.maxDistance;
  }

  resize(newCount) {
    this.flock.setCount(newCount);

    const positions = this.getPositionsArray();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}
