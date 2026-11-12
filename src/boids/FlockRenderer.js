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
    this.seeds = null;

    this.initialize();
  }

  getPositionsArray() {
    if (typeof this.flock.getPositionsView === 'function') {
      return this.flock.getPositionsView();
    }
    return this.flock.getPositions();
  }

  getVelocitiesArray() {
    if (typeof this.flock.getVelocitiesView === 'function') {
      const v = this.flock.getVelocitiesView();
      if (v) return v;
    }
    if (typeof this.flock.getVelocities === 'function') {
      return this.flock.getVelocities();
    }
    return null;
  }

  getGenomesArray() {
    if (typeof this.flock.getGenomesView === 'function') {
      const g = this.flock.getGenomesView();
      if (g) return g;
    }
    if (typeof this.flock.getGenomes === 'function') {
      return this.flock.getGenomes();
    }
    return null;
  }

  makeSeeds(count) {
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) seeds[i] = Math.random();
    return seeds;
  }

  initialize() {
    this.geometry = new THREE.BufferGeometry();

    const positions = this.getPositionsArray();
    const count = positions.length / 3;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const velocities = this.getVelocitiesArray() || new Float32Array(positions.length);
    this.geometry.setAttribute('velocity', new THREE.BufferAttribute(velocities, 3));

    this.seeds = this.makeSeeds(count);
    this.geometry.setAttribute('seed', new THREE.BufferAttribute(this.seeds, 1));

    const genomes = this.getGenomesArray() || new Float32Array(count * 2);
    this.geometry.setAttribute('genome', new THREE.BufferAttribute(genomes, 2));

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        origin: { value: new THREE.Vector3(0, 0, 0) },
        maxDistance: { value: this.params.maxDistance },
        time: { value: 0 },
        particleSize: { value: this.params.particleSize },
        hue: { value: 0 },
        hueSpread: { value: 1 },
        saturation: { value: 0.85 },
        modeMix: { value: new THREE.Vector4(1, 0, 0, 0) },
        palette0: { value: new THREE.Vector3(1, 0.4, 0.2) },
        palette1: { value: new THREE.Vector3(0.2, 0.5, 1) },
        palette2: { value: new THREE.Vector3(0.9, 0.9, 0.5) },
        flash: { value: 0 },
        sizePulse: { value: 0 },
        sparkle: { value: 0.3 },
        speedScale: { value: 0.2 },
        bandHit: { value: new THREE.Vector4(0, 0, 0, 0) }
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  /** Point a geometry attribute at `array`, re-binding if the backing store moved. */
  syncAttribute(name, array, itemSize) {
    const attr = this.geometry.getAttribute(name);
    if (!attr) {
      this.geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
      return;
    }
    const sameLength = attr.array.length === array.length;
    const sameBackingStore =
      attr.array.buffer === array.buffer && attr.array.byteOffset === array.byteOffset;

    if (!sameLength || !sameBackingStore) {
      this.geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
    } else if (attr.array !== array) {
      attr.array.set(array);
      attr.needsUpdate = true;
    } else {
      attr.needsUpdate = true;
    }
  }

  update(time, visual = null) {
    this.syncAttribute('position', this.getPositionsArray(), 3);
    const velocities = this.getVelocitiesArray();
    if (velocities) this.syncAttribute('velocity', velocities, 3);
    const genomes = this.getGenomesArray();
    if (genomes) this.syncAttribute('genome', genomes, 2);

    const u = this.material.uniforms;
    u.time.value = time;
    u.particleSize.value = this.params.particleSize;
    u.maxDistance.value = this.params.maxDistance;
    u.speedScale.value = 1 / Math.max(1, this.params.maxSpeed);

    if (visual) {
      u.hue.value = visual.hue;
      u.hueSpread.value = visual.hueSpread;
      u.saturation.value = visual.saturation;
      u.modeMix.value.set(visual.modePos, visual.modeVel, visual.modePal, visual.modeLin);
      u.palette0.value.fromArray(visual.palette[0]);
      u.palette1.value.fromArray(visual.palette[1]);
      u.palette2.value.fromArray(visual.palette[2]);
      u.flash.value = visual.flash;
      u.sizePulse.value = visual.sizePulse;
      u.sparkle.value = visual.sparkle;
      if (visual.bandHit) u.bandHit.value.fromArray(visual.bandHit);
    }
  }

  resize(newCount) {
    this.flock.setCount(newCount);

    const positions = this.getPositionsArray();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const velocities = this.getVelocitiesArray() || new Float32Array(positions.length);
    this.geometry.setAttribute('velocity', new THREE.BufferAttribute(velocities, 3));
    this.seeds = this.makeSeeds(newCount);
    this.geometry.setAttribute('seed', new THREE.BufferAttribute(this.seeds, 1));
    const genomes = this.getGenomesArray() || new Float32Array(newCount * 2);
    this.geometry.setAttribute('genome', new THREE.BufferAttribute(genomes, 2));
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}
