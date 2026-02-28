import { Boid } from './Boid.js';
import { SpatialGrid } from './SpatialGrid.js';

export class Flock {
  constructor(count, bounds, params) {
    this.boids = [];
    this.bounds = bounds;
    this.params = params;

    this.spatialGrid = new SpatialGrid(params.visualRange);
    this.positions = new Float32Array(count * 3);

    this.initializeBoids(count);
  }

  initializeBoids(count) {
    this.boids = [];

    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
      const y = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
      const z = (Math.random() - 0.5) * 2 * this.bounds * 0.8;

      this.boids.push(new Boid(x, y, z, this.bounds));
    }

    if (this.positions.length !== count * 3) {
      this.positions = new Float32Array(count * 3);
    }
  }

  reset() {
    this.initializeBoids(this.boids.length);
  }

  setCount(newCount) {
    const currentCount = this.boids.length;

    if (newCount > currentCount) {
      for (let i = currentCount; i < newCount; i++) {
        const x = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
        const y = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
        const z = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
        this.boids.push(new Boid(x, y, z, this.bounds));
      }
    } else if (newCount < currentCount) {
      this.boids.length = newCount;
    }

    if (this.positions.length !== newCount * 3) {
      this.positions = new Float32Array(newCount * 3);
    }
  }

  update(params) {
    this.params = params;

    this.spatialGrid.setCellSize(params.visualRange);

    this.spatialGrid.clear();
    for (let i = 0; i < this.boids.length; i++) {
      this.spatialGrid.add(this.boids[i]);
    }

    for (let i = 0; i < this.boids.length; i++) {
      const boid = this.boids[i];
      const neighbors = this.spatialGrid.getNearby(boid);
      boid.update(neighbors, params);
    }
  }

  getPositions() {
    for (let i = 0; i < this.boids.length; i++) {
      const boid = this.boids[i];
      this.positions[i * 3] = boid.position.x;
      this.positions[i * 3 + 1] = boid.position.y;
      this.positions[i * 3 + 2] = boid.position.z;
    }
    return this.positions;
  }

  get count() {
    return this.boids.length;
  }
}
