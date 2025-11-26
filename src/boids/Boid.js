import * as THREE from 'three';

export class Boid {
  constructor(x, y, z, bounds) {
    this.position = new THREE.Vector3(x, y, z);
    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2
    ).normalize().multiplyScalar(Math.random() * 3 + 2);
    
    this.bounds = bounds;
    
    // Reusable vectors to avoid allocations in hot loop
    this._tempVec = new THREE.Vector3();
  }
  
  // Update position based on velocity
  updatePosition() {
    this.position.add(this.velocity);
  }
  
  // Apply separation force - avoid crowding neighbors
  applySeparation(neighbors, protectedRange, avoidFactor) {
    let closeX = 0;
    let closeY = 0;
    let closeZ = 0;
    
    for (let i = 0; i < neighbors.length; i++) {
      const other = neighbors[i];
      if (other === this) continue;
      
      const dx = this.position.x - other.position.x;
      const dy = this.position.y - other.position.y;
      const dz = this.position.z - other.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      
      if (distSq < protectedRange * protectedRange && distSq > 0) {
        closeX += dx;
        closeY += dy;
        closeZ += dz;
      }
    }
    
    this.velocity.x += closeX * avoidFactor;
    this.velocity.y += closeY * avoidFactor;
    this.velocity.z += closeZ * avoidFactor;
  }
  
  // Apply alignment force - match velocity of neighbors
  applyAlignment(neighbors, visualRange, matchingFactor) {
    let avgVx = 0;
    let avgVy = 0;
    let avgVz = 0;
    let count = 0;
    
    for (let i = 0; i < neighbors.length; i++) {
      const other = neighbors[i];
      if (other === this) continue;
      
      const dx = this.position.x - other.position.x;
      const dy = this.position.y - other.position.y;
      const dz = this.position.z - other.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      
      if (distSq < visualRange * visualRange) {
        avgVx += other.velocity.x;
        avgVy += other.velocity.y;
        avgVz += other.velocity.z;
        count++;
      }
    }
    
    if (count > 0) {
      avgVx /= count;
      avgVy /= count;
      avgVz /= count;
      
      this.velocity.x += (avgVx - this.velocity.x) * matchingFactor;
      this.velocity.y += (avgVy - this.velocity.y) * matchingFactor;
      this.velocity.z += (avgVz - this.velocity.z) * matchingFactor;
    }
  }
  
  // Apply cohesion force - steer toward center of neighbors
  applyCohesion(neighbors, visualRange, centeringFactor) {
    let avgX = 0;
    let avgY = 0;
    let avgZ = 0;
    let count = 0;
    
    for (let i = 0; i < neighbors.length; i++) {
      const other = neighbors[i];
      if (other === this) continue;
      
      const dx = this.position.x - other.position.x;
      const dy = this.position.y - other.position.y;
      const dz = this.position.z - other.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      
      if (distSq < visualRange * visualRange) {
        avgX += other.position.x;
        avgY += other.position.y;
        avgZ += other.position.z;
        count++;
      }
    }
    
    if (count > 0) {
      avgX /= count;
      avgY /= count;
      avgZ /= count;
      
      this.velocity.x += (avgX - this.position.x) * centeringFactor;
      this.velocity.y += (avgY - this.position.y) * centeringFactor;
      this.velocity.z += (avgZ - this.position.z) * centeringFactor;
    }
  }
  
  // Limit speed to min/max range
  limitSpeed(minSpeed, maxSpeed) {
    const speed = this.velocity.length();
    
    if (speed < minSpeed && speed > 0) {
      this.velocity.multiplyScalar(minSpeed / speed);
    } else if (speed > maxSpeed) {
      this.velocity.multiplyScalar(maxSpeed / speed);
    }
  }
  
  // Soft boundary avoidance - turn away from edges
  avoidBoundaries(margin, turnFactor) {
    const bounds = this.bounds;
    
    // X axis
    if (this.position.x < -bounds + margin) {
      this.velocity.x += turnFactor;
    } else if (this.position.x > bounds - margin) {
      this.velocity.x -= turnFactor;
    }
    
    // Y axis
    if (this.position.y < -bounds + margin) {
      this.velocity.y += turnFactor;
    } else if (this.position.y > bounds - margin) {
      this.velocity.y -= turnFactor;
    }
    
    // Z axis
    if (this.position.z < -bounds + margin) {
      this.velocity.z += turnFactor;
    } else if (this.position.z > bounds - margin) {
      this.velocity.z -= turnFactor;
    }
  }
  
  // Full update cycle
  update(neighbors, params) {
    this.applySeparation(neighbors, params.protectedRange, params.avoidFactor);
    this.applyAlignment(neighbors, params.visualRange, params.matchingFactor);
    this.applyCohesion(neighbors, params.visualRange, params.centeringFactor);
    this.avoidBoundaries(params.margin, params.turnFactor);
    this.limitSpeed(params.minSpeed, params.maxSpeed);
    this.updatePosition();
  }
}

