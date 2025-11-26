import { Boid } from './Boid.js';
import { SpatialGrid } from './SpatialGrid.js';

export class Flock {
  constructor(count, bounds, params) {
    this.boids = [];
    this.bounds = bounds;
    this.params = params;
    
    // Spatial grid with cell size matching visual range
    this.spatialGrid = new SpatialGrid(params.visualRange);
    
    // Pre-allocate position array for GPU upload
    this.positions = new Float32Array(count * 3);
    
    // Initialize flock
    this.initializeBoids(count);
  }
  
  /**
   * Create boids with random positions within bounds
   */
  initializeBoids(count) {
    this.boids = [];
    
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
      const y = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
      const z = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
      
      this.boids.push(new Boid(x, y, z, this.bounds));
    }
    
    // Resize position array if needed
    if (this.positions.length !== count * 3) {
      this.positions = new Float32Array(count * 3);
    }
  }
  
  /**
   * Reset flock to random positions
   */
  reset() {
    this.initializeBoids(this.boids.length);
  }
  
  /**
   * Change the number of boids
   */
  setCount(newCount) {
    const currentCount = this.boids.length;
    
    if (newCount > currentCount) {
      // Add more boids
      for (let i = currentCount; i < newCount; i++) {
        const x = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
        const y = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
        const z = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
        this.boids.push(new Boid(x, y, z, this.bounds));
      }
    } else if (newCount < currentCount) {
      // Remove excess boids
      this.boids.length = newCount;
    }
    
    // Resize position array
    if (this.positions.length !== newCount * 3) {
      this.positions = new Float32Array(newCount * 3);
    }
  }
  
  /**
   * Update all boids for one simulation step
   */
  update(params) {
    this.params = params;
    
    // Update spatial grid cell size if visual range changed
    this.spatialGrid.setCellSize(params.visualRange);
    
    // Clear and rebuild spatial grid
    this.spatialGrid.clear();
    for (let i = 0; i < this.boids.length; i++) {
      this.spatialGrid.add(this.boids[i]);
    }
    
    // Update each boid
    for (let i = 0; i < this.boids.length; i++) {
      const boid = this.boids[i];
      const neighbors = this.spatialGrid.getNearby(boid);
      boid.update(neighbors, params);
    }
  }
  
  /**
   * Get positions as Float32Array for GPU upload
   */
  getPositions() {
    for (let i = 0; i < this.boids.length; i++) {
      const boid = this.boids[i];
      this.positions[i * 3] = boid.position.x;
      this.positions[i * 3 + 1] = boid.position.y;
      this.positions[i * 3 + 2] = boid.position.z;
    }
    return this.positions;
  }
  
  /**
   * Get current boid count
   */
  get count() {
    return this.boids.length;
  }
}

