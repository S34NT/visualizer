import * as THREE from 'three';
import { applyField, F } from '../fields/FieldLayout.js';

const scratchForce = [0, 0, 0];

/** Initial lineages are spatial: six angular sectors around the vertical axis. */
export function spatialHue(x, y, z) {
  const sectors = 6;
  const angle = (Math.atan2(z, x) + Math.PI * 2) % (Math.PI * 2);
  const sector = Math.floor((angle / (Math.PI * 2)) * sectors);
  return (((sector + 0.5) / sectors + 1 / 32) % 1 + 1) % 1;
}

export class Boid {
  constructor(x, y, z, bounds) {
    this.position = new THREE.Vector3(x, y, z);
    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2
    ).normalize().multiplyScalar(Math.random() * 3 + 2);

    this.bounds = bounds;

    // Genome. `trait` scales speed and field response, `cohesionGene` scales
    // centering, `hue` marks the lineage. `energy` drives death and division.
    this.trait = 0.7 + Math.random() * 0.6;
    this.cohesionGene = 0.8 + Math.random() * 0.4;
    this.hue = spatialHue(x, y, z);
    this.energy = 0.35 + Math.random() * 0.3;
    this.bestParent = null;
  }

  updatePosition() {
    this.position.add(this.velocity);
  }

  /**
   * Single-pass boid rules with kin-weighted alignment / cohesion and
   * cross-lineage repulsion. Mirrors the loop in lib.rs.
   */
  flock(neighbors, params, evo) {
    const px = this.position.x, py = this.position.y, pz = this.position.z;
    const protectedSq = params.protectedRange * params.protectedRange;
    const visSq = params.visualRange * params.visualRange;
    const kinship = evo.kinship;
    const xeno = evo.xeno;

    let closeX = 0, closeY = 0, closeZ = 0;
    let avgVx = 0, avgVy = 0, avgVz = 0;
    let avgPx = 0, avgPy = 0, avgPz = 0;
    let xenoX = 0, xenoY = 0, xenoZ = 0;
    let count = 0;
    let weightSum = 0;
    let best = null;
    let bestEnergy = 0;
    const hueI = this.hue;

    // Dense neighbourhoods are stride-sampled so cost stays O(maxNeighbors)
    // per bird; summed terms are rescaled by the stride afterwards.
    const total = neighbors.length;
    const stride = Math.max(1, Math.ceil(total / Math.max(4, evo.maxNeighbors || 64)));
    const sampleScale = stride;
    for (let i = stride > 1 ? Math.floor(Math.random() * stride) : 0; i < total; i += stride) {
      const other = neighbors[i];
      if (other === this) continue;

      const dx = px - other.position.x;
      const dy = py - other.position.y;
      const dz = pz - other.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < protectedSq && distSq > 0) {
        closeX += dx;
        closeY += dy;
        closeZ += dz;
      }

      if (distSq < visSq) {
        let dh = Math.abs(hueI - other.hue);
        if (dh > 0.5) dh = 1 - dh;
        const kin = 1 - 2 * dh;
        const w = 1 - kinship + kinship * kin;

        avgVx += other.velocity.x * w;
        avgVy += other.velocity.y * w;
        avgVz += other.velocity.z * w;
        avgPx += other.position.x * w;
        avgPy += other.position.y * w;
        avgPz += other.position.z * w;
        weightSum += w;
        count++;

        if (xeno > 0 && kin < 0.5 && distSq > 0) {
          const push = ((0.5 - kin) * 2) / (Math.sqrt(distSq) + 1e-3);
          xenoX += dx * push;
          xenoY += dy * push;
          xenoZ += dz * push;
        }

        if (other.energy > bestEnergy) {
          bestEnergy = other.energy;
          best = other;
        }
      }
    }

    closeX *= sampleScale; closeY *= sampleScale; closeZ *= sampleScale;
    xenoX *= sampleScale; xenoY *= sampleScale; xenoZ *= sampleScale;
    count *= sampleScale;

    const v = this.velocity;
    v.x += closeX * params.avoidFactor + xenoX * xeno;
    v.y += closeY * params.avoidFactor + xenoY * xeno;
    v.z += closeZ * params.avoidFactor + xenoZ * xeno;

    let coherence = 0;
    if (weightSum > 1e-6) {
      const inv = 1 / weightSum;
      avgVx *= inv; avgVy *= inv; avgVz *= inv;
      avgPx *= inv; avgPy *= inv; avgPz *= inv;

      v.x += (avgVx - v.x) * params.matchingFactor;
      v.y += (avgVy - v.y) * params.matchingFactor;
      v.z += (avgVz - v.z) * params.matchingFactor;

      const cg = params.centeringFactor * this.cohesionGene;
      v.x += (avgPx - px) * cg;
      v.y += (avgPy - py) * cg;
      v.z += (avgPz - pz) * cg;

      coherence = Math.min(1, Math.sqrt(avgVx * avgVx + avgVy * avgVy + avgVz * avgVz) / evo.maxSpeed);
    }

    this.bestParent = best;

    if (evo.enabled) {
      const rarity = Math.min(1.15, Math.max(0.6, 1.15 - evo.binShare[evo.hueBin(hueI)]));
      const company = Math.min(count / 3, 1);
      const crowd = count / evo.crowdCap;
      const speed = v.length() / evo.maxSpeed;
      // Logistic gain against energy-proportional decay: energy settles at
      // gain / (gain + loss), so only isolated or incoherent birds starve.
      const e = this.energy;
      const gain = evo.gain * company * (0.4 + 0.6 * coherence) * rarity * (1 - e);
      let loss = evo.loss * (0.5 + 0.5 * speed) * e;
      if (crowd > 1) loss += evo.loss * (crowd - 1) * 1.5 * e;
      if (evo.extinction > 0 && evo.hueBin(hueI) === evo.extinctionBin) loss += evo.extinction * 0.02;
      this.energy = Math.min(1, Math.max(0, e + gain - loss));
    }
  }

  applyFieldForces(field, jitter) {
    if (field) {
      applyField(
        field,
        this.position.x, this.position.y, this.position.z,
        this.velocity.x, this.velocity.y, this.velocity.z,
        this.trait, this.hue, scratchForce
      );
      this.velocity.x += scratchForce[0];
      this.velocity.y += scratchForce[1];
      this.velocity.z += scratchForce[2];
      // Drift: momentum carries but decays, like floating in still water.
      const dmp = field[F.DRIFT_DAMPING];
      if (dmp > 0) this.velocity.multiplyScalar(1 - Math.min(0.2, dmp));
    }

    if (jitter > 0) {
      this.velocity.x += (Math.random() - 0.5) * jitter;
      this.velocity.y += (Math.random() - 0.5) * jitter;
      this.velocity.z += (Math.random() - 0.5) * jitter;
    }
  }

  limitSpeed(minSpeed, maxSpeed) {
    const speed = this.velocity.length();

    if (speed < minSpeed && speed > 0) {
      this.velocity.multiplyScalar(minSpeed / speed);
    } else if (speed > maxSpeed) {
      this.velocity.multiplyScalar(maxSpeed / speed);
    }
  }

  avoidBoundaries(margin, turnFactor) {
    const bounds = this.bounds;

    if (this.position.x < -bounds + margin) {
      this.velocity.x += turnFactor;
    } else if (this.position.x > bounds - margin) {
      this.velocity.x -= turnFactor;
    }

    if (this.position.y < -bounds + margin) {
      this.velocity.y += turnFactor;
    } else if (this.position.y > bounds - margin) {
      this.velocity.y -= turnFactor;
    }

    if (this.position.z < -bounds + margin) {
      this.velocity.z += turnFactor;
    } else if (this.position.z > bounds - margin) {
      this.velocity.z -= turnFactor;
    }
  }

  update(neighbors, params, field, jitter, evo) {
    this.flock(neighbors, params, evo);
    this.applyFieldForces(field, jitter);

    this.avoidBoundaries(params.margin, params.turnFactor);
    // Personality nudges the speed envelope so the flock is not perfectly uniform.
    const t = 0.85 + (this.trait - 1) * 0.5;
    this.limitSpeed(params.minSpeed * t, params.maxSpeed * (0.9 + (this.trait - 1) * 0.6));
    this.updatePosition();
  }
}

export { F };
