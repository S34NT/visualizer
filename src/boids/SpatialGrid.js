/**
 * Spatial partitioning grid for O(n) neighbor lookup
 * Divides 3D space into cells and only checks adjacent cells for neighbors
 */
export class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }
  
  /**
   * Clear all cells for a fresh frame
   */
  clear() {
    this.cells.clear();
  }
  
  /**
   * Generate a unique key for a cell based on position
   */
  getCellKey(x, y, z) {
    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    const cellZ = Math.floor(z / this.cellSize);
    return `${cellX},${cellY},${cellZ}`;
  }
  
  /**
   * Add a boid to the appropriate cell
   */
  add(boid) {
    const key = this.getCellKey(
      boid.position.x,
      boid.position.y,
      boid.position.z
    );
    
    if (!this.cells.has(key)) {
      this.cells.set(key, []);
    }
    this.cells.get(key).push(boid);
  }
  
  /**
   * Get all boids in the same cell and adjacent cells (3x3x3 cube)
   * This is the key optimization - instead of checking all N boids,
   * we only check boids in nearby cells
   */
  getNearby(boid) {
    const nearby = [];
    const cellX = Math.floor(boid.position.x / this.cellSize);
    const cellY = Math.floor(boid.position.y / this.cellSize);
    const cellZ = Math.floor(boid.position.z / this.cellSize);
    
    // Check 3x3x3 cube of cells (current + 26 neighbors)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${cellX + dx},${cellY + dy},${cellZ + dz}`;
          const cell = this.cells.get(key);
          if (cell) {
            // Push all boids from this cell
            for (let i = 0; i < cell.length; i++) {
              nearby.push(cell[i]);
            }
          }
        }
      }
    }
    
    return nearby;
  }
  
  /**
   * Update cell size (when visual range changes)
   */
  setCellSize(size) {
    this.cellSize = size;
  }
}

