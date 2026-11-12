/**
 * Small deterministic noise helpers used by the choreographer so that
 * parameters wander organically instead of oscillating on fixed sine loops.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash1(i, seed) {
  let x = (i | 0) * 374761393 + (seed | 0) * 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  x = x ^ (x >>> 16);
  return ((x >>> 0) % 100000) / 100000;
}

/**
 * 1-D value noise in [-1, 1] with quintic smoothing. Different seeds give
 * uncorrelated streams; feed a slowly increasing `t`.
 */
export function noise1(t, seed = 0) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = hash1(i, seed) * 2 - 1;
  const b = hash1(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

/**
 * Fractal noise: a few octaves at incommensurate frequency ratios so the
 * resulting signal never visibly repeats.
 */
export function fbm1(t, seed = 0, octaves = 3) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(t * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.137; // irrational-ish ratio avoids phase locking
  }
  return sum / norm;
}

/**
 * A slowly wandering scalar. `rate` is in cycles per second; the output is
 * mapped into [min, max] with a value-noise shape.
 */
export class Wander {
  constructor(min, max, rate, seed) {
    this.min = min;
    this.max = max;
    this.rate = rate;
    this.seed = seed;
    this.offset = hash1(seed, 7) * 1000;
  }

  at(time) {
    const n = fbm1(time * this.rate + this.offset, this.seed) * 0.5 + 0.5;
    return this.min + (this.max - this.min) * n;
  }
}

/** A unit vector that drifts smoothly on the sphere. */
export class WanderDirection {
  constructor(rate, seed) {
    this.rate = rate;
    this.seed = seed;
    this.offset = hash1(seed, 11) * 1000;
    this.out = [0, 1, 0];
  }

  at(time) {
    const t = time * this.rate + this.offset;
    let x = fbm1(t, this.seed + 1, 2);
    let y = fbm1(t, this.seed + 2, 2);
    let z = fbm1(t, this.seed + 3, 2);
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    this.out[0] = x / l;
    this.out[1] = y / l;
    this.out[2] = z / l;
    return this.out;
  }
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Exponential approach that is independent of frame rate. */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));
