import { Boid } from './Boid.js';
import { SpatialGrid } from './SpatialGrid.js';
import { F, HUE_BINS, gaussRandom } from '../fields/FieldLayout.js';

export class Flock {
  constructor(count, bounds, params) {
    this.boids = [];
    this.bounds = bounds;
    this.params = params;
    this.field = null;

    this.spatialGrid = new SpatialGrid(params.visualRange);
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.genomes = new Float32Array(count * 2);

    // Evolution bookkeeping shared with Boid.flock (mirrors lib.rs).
    this.evo = {
      enabled: false,
      kinship: 0,
      xeno: 0,
      gain: 0,
      loss: 0,
      extinction: 0,
      crowdCap: 40,
      maxSpeed: 1,
      maxNeighbors: 64,
      binShare: new Float32Array(HUE_BINS).fill(1 / HUE_BINS),
      dominantBin: 0,
      extinctionBin: -1,
      hueBin: (h) => Math.min(HUE_BINS - 1, Math.floor((((h % 1) + 1) % 1) * HUE_BINS))
    };
    this.species = HUE_BINS;
    this.churnCursor = 0;
    this.frame = 0;
    this.births = 0;

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

    this.ensureBuffers(count);
    this.updateHueHistogram();
  }

  ensureBuffers(count) {
    if (this.positions.length !== count * 3) {
      this.positions = new Float32Array(count * 3);
    }
    if (this.velocities.length !== count * 3) {
      this.velocities = new Float32Array(count * 3);
    }
    if (this.genomes.length !== count * 2) {
      this.genomes = new Float32Array(count * 2);
    }
  }

  reset() {
    this.initializeBoids(this.boids.length);
  }

  setCount(newCount) {
    const currentCount = this.boids.length;

    if (newCount > currentCount) {
      for (let i = currentCount; i < newCount; i++) {
        if (currentCount === 0) {
          const x = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
          const y = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
          const z = (Math.random() - 0.5) * 2 * this.bounds * 0.8;
          this.boids.push(new Boid(x, y, z, this.bounds));
          continue;
        }
        // Grow from within: hatch beside an existing bird (mirrors lib.rs set_count).
        const p = this.boids[Math.floor(Math.random() * currentCount)];
        const b = new Boid(
          p.position.x + gaussRandom() * 3,
          p.position.y + gaussRandom() * 3,
          p.position.z + gaussRandom() * 3,
          this.bounds
        );
        b.velocity.set(
          p.velocity.x + gaussRandom() * 0.3,
          p.velocity.y + gaussRandom() * 0.3,
          p.velocity.z + gaussRandom() * 0.3
        );
        b.trait = p.trait;
        b.hue = p.hue;
        b.cohesionGene = p.cohesionGene;
        b.energy = 0.4;
        this.boids.push(b);
      }
    } else if (newCount < currentCount) {
      this.boids.length = newCount;
    }

    this.ensureBuffers(newCount);
  }

  /** Accepts the shared Float32Array described in FieldLayout.js. */
  setField(fieldBuffer) {
    this.field = fieldBuffer;
  }

  /** Cap on neighbours sampled per bird per step (mirrors lib.rs). */
  setMaxNeighbors(n) {
    this.evo.maxNeighbors = Math.min(512, Math.max(4, n | 0));
  }

  maxNeighbors() {
    return this.evo.maxNeighbors;
  }

  updateHueHistogram() {
    const counts = new Float32Array(HUE_BINS);
    for (let i = 0; i < this.boids.length; i++) {
      counts[this.evo.hueBin(this.boids[i].hue)] += 1;
    }
    const total = Math.max(1, this.boids.length);
    let dominant = 0;
    let species = 0;
    for (let b = 0; b < HUE_BINS; b++) {
      this.evo.binShare[b] = counts[b] / total;
      if (this.evo.binShare[b] > this.evo.binShare[dominant]) dominant = b;
      if (this.evo.binShare[b] >= 0.03) species++;
    }
    this.evo.dominantBin = dominant;
    this.species = species;
  }

  /** Death and division over a sliding window of birds (mirrors lib.rs). */
  reproduce() {
    const f = this.field;
    const n = this.boids.length;
    if (!n) return;
    const churn = Math.min(1, Math.max(0, f[F.EVO_CHURN]));
    const mutation = Math.max(0, f[F.EVO_MUTATION]);
    const death = f[F.EVO_DEATH];
    const senescence = Math.max(0, f[F.EVO_SENESCENCE]);
    const window = Math.min(n, Math.max(1, Math.ceil(n * churn)));

    for (let k = 0; k < window; k++) {
      const j = (this.churnCursor + k) % n;
      const b = this.boids[j];
      if (b.energy >= death && Math.random() >= senescence) continue;
      const p = b.bestParent;
      const parentOk = !!p && p.energy > 0.3;
      if (!parentOk && Math.random() > 0.005) continue; // no fit neighbour yet: linger
      if (parentOk) {
        b.position.set(
          p.position.x + gaussRandom() * 2.5,
          p.position.y + gaussRandom() * 2.5,
          p.position.z + gaussRandom() * 2.5
        );
        b.velocity.set(
          p.velocity.x + gaussRandom() * 0.3,
          p.velocity.y + gaussRandom() * 0.3,
          p.velocity.z + gaussRandom() * 0.3
        );
        // Lineage hue is inherited exactly; rare speciation jumps found a new lineage.
        if (Math.random() < mutation * 0.15) {
          const jump = (0.05 + Math.random() * 0.08) * (Math.random() < 0.5 ? -1 : 1);
          b.hue = (((p.hue + jump) % 1) + 1) % 1;
        } else {
          b.hue = p.hue;
        }
        b.trait = Math.min(1.4, Math.max(0.6, p.trait + gaussRandom() * mutation * 2));
        b.cohesionGene = Math.min(1.8, Math.max(0.4, p.cohesionGene + gaussRandom() * mutation * 4));
        b.energy = 0.35;
        p.energy -= 0.1;
        this.births++;
      } else {
        b.hue = Math.random();
        b.trait = 0.7 + Math.random() * 0.6;
        b.cohesionGene = 0.8 + Math.random() * 0.4;
        b.energy = 0.3;
      }
    }
    this.churnCursor = (this.churnCursor + window) % n;
  }

  update(params) {
    this.params = params;

    this.spatialGrid.setCellSize(params.visualRange);

    this.spatialGrid.clear();
    for (let i = 0; i < this.boids.length; i++) {
      this.spatialGrid.add(this.boids[i]);
    }

    const field = this.field;
    const jitter = field ? field[F.JITTER] : 0;

    const evo = this.evo;
    evo.enabled = !!field && field[F.EVO_ENABLED] > 0.5;
    evo.kinship = field ? Math.min(1, Math.max(0, field[F.EVO_KINSHIP])) : 0;
    evo.xeno = field ? field[F.EVO_XENO] : 0;
    evo.gain = field ? field[F.EVO_GAIN] : 0;
    evo.loss = field ? field[F.EVO_LOSS] : 0;
    evo.extinction = field ? field[F.EVO_EXTINCTION] : 0;
    // An extinction pulse targets the lineage that was dominant when it began.
    if (evo.extinction > 0) {
      if (evo.extinctionBin < 0) evo.extinctionBin = evo.dominantBin;
    } else {
      evo.extinctionBin = -1;
    }
    evo.crowdCap = field ? Math.max(1, field[F.EVO_CROWD]) : 40;
    evo.maxSpeed = Math.max(0.1, params.maxSpeed);

    this.frame++;
    if (this.frame % 30 === 0) this.updateHueHistogram();

    for (let i = 0; i < this.boids.length; i++) {
      const boid = this.boids[i];
      const neighbors = this.spatialGrid.getNearby(boid);
      boid.update(neighbors, params, field, jitter, evo);
    }

    if (evo.enabled) this.reproduce();
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

  getVelocities() {
    for (let i = 0; i < this.boids.length; i++) {
      const boid = this.boids[i];
      this.velocities[i * 3] = boid.velocity.x;
      this.velocities[i * 3 + 1] = boid.velocity.y;
      this.velocities[i * 3 + 2] = boid.velocity.z;
    }
    return this.velocities;
  }

  /** Per bird: [lineage hue, energy]. */
  getGenomes() {
    for (let i = 0; i < this.boids.length; i++) {
      const boid = this.boids[i];
      this.genomes[i * 2] = boid.hue;
      this.genomes[i * 2 + 1] = boid.energy;
    }
    return this.genomes;
  }

  speciesCount() {
    return this.species;
  }

  dominantShare() {
    return this.evo.binShare[this.evo.dominantBin];
  }

  get count() {
    return this.boids.length;
  }
}
