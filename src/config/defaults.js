// Default simulation parameters based on biological research
export const defaults = {
  // Flocking behavior
  visualRange: 40,
  protectedRange: 8,
  centeringFactor: 0.0005,
  avoidFactor: 0.05,
  matchingFactor: 0.05,

  // Movement constraints
  maxSpeed: 6,
  minSpeed: 3,
  turnFactor: 0.2,
  margin: 50,

  // Simulation size
  birdCount: 1000,
  bounds: 150,

  // Visualization
  particleSize: 3.0,
  maxDistance: 200,

  // Performance
  targetFPS: 60,
  minFPS: 30
};

export const presets = {
  default: { ...defaults },

  tightSwarm: {
    ...defaults,
    visualRange: 30,
    protectedRange: 5,
    centeringFactor: 0.001,
    avoidFactor: 0.08,
    matchingFactor: 0.08,
    birdCount: 2000
  },

  looseFlock: {
    ...defaults,
    visualRange: 60,
    protectedRange: 12,
    centeringFactor: 0.0003,
    avoidFactor: 0.03,
    matchingFactor: 0.03,
    birdCount: 500
  },

  chaotic: {
    ...defaults,
    visualRange: 25,
    protectedRange: 10,
    centeringFactor: 0.0002,
    avoidFactor: 0.1,
    matchingFactor: 0.02,
    maxSpeed: 10,
    minSpeed: 5,
    birdCount: 1500
  },

  massive: {
    ...defaults,
    visualRange: 35,
    protectedRange: 6,
    centeringFactor: 0.0004,
    avoidFactor: 0.04,
    matchingFactor: 0.04,
    birdCount: 5000
  }
};
