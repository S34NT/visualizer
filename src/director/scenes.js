/**
 * Scene archetypes for the choreographer.
 *
 * Every scene is built fresh from a random generator each time it is chosen,
 * so the same archetype never plays back the same way twice: axes, radii,
 * speeds, path shapes and palettes are all re-rolled.
 *
 * A scene instance exposes:
 *   name, label               - identity for the GUI / overlay
 *   energy [lo, hi]           - intensity range the scene suits best
 *   params                    - base boid parameter targets
 *   visual                    - { mode:[pos,vel,palette], trail, bloom, hueRate, sparkle }
 *   camera                    - { distance, orbit, elevation }
 *   pulseGain                 - how strongly bass hits create shockwaves
 *   update(t, a, f, p)        - write the force field `f` and tweak params `p`
 *                               for scene-time `t` (s) and audio snapshot `a`
 */
import { F, SHAPE } from '../fields/FieldLayout.js';
import { Wander, WanderDirection, fbm1, lerp, clamp } from './Noise.js';

const TAU = Math.PI * 2;

const rand = (rng, a, b) => a + (b - a) * rng();
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const sign = (rng) => (rng() < 0.5 ? -1 : 1);

function setVec(f, i, x, y, z) {
  f[i] = x;
  f[i + 1] = y;
  f[i + 2] = z;
}

function setAgent(f, slot, x, y, z, strength, radius) {
  const b = F.AGENT_BASE + slot * F.AGENT_STRIDE;
  f[b] = x;
  f[b + 1] = y;
  f[b + 2] = z;
  f[b + 3] = strength;
  f[b + 4] = radius;
  f[F.AGENT_COUNT] = Math.max(f[F.AGENT_COUNT], slot + 1);
}

/** Lissajous path through the volume with incommensurate frequencies. */
function makePath(rng, amp) {
  const fa = rand(rng, 0.7, 1.0);
  const fb = rand(rng, 1.15, 1.6);
  const fc = rand(rng, 0.45, 0.75);
  const pa = rng() * TAU;
  const pb = rng() * TAU;
  const pc = rng() * TAU;
  const ax = amp * rand(rng, 0.7, 1);
  const ay = amp * rand(rng, 0.45, 0.8);
  const az = amp * rand(rng, 0.7, 1);
  const out = [0, 0, 0];
  return (phase) => {
    out[0] = ax * Math.sin(fa * phase + pa);
    out[1] = ay * Math.sin(fb * phase + pb);
    out[2] = az * Math.sin(fc * phase + pc);
    return out;
  };
}

/** Three curl-noise wave vectors with a given wavelength range. */
function makeFlow(rng, lo, hi) {
  const ks = [];
  for (let i = 0; i < 3; i++) {
    const w = rand(rng, lo, hi);
    const k = TAU / w;
    const d = new WanderDirection(rand(rng, 0.01, 0.025), Math.floor(rng() * 1e6));
    ks.push({ k, d, phase: rng() * TAU, rate: rand(rng, 0.25, 0.7) * sign(rng) });
  }
  return (f, t, strength, phaseBoost = 0) => {
    f[F.FLOW_STRENGTH] = strength;
    for (let i = 0; i < 3; i++) {
      const { k, d, phase, rate } = ks[i];
      const dir = d.at(t);
      setVec(f, F.FLOW_K1 + i * 3, dir[0] * k, dir[1] * k, dir[2] * k);
      f[F.FLOW_PHASE + i] = phase + t * rate + phaseBoost * (i + 1) * 0.5;
    }
  };
}

function baseParams(o) {
  return {
    visualRange: 18,
    protectedRange: 5,
    centeringFactor: 0.0007,
    avoidFactor: 0.05,
    matchingFactor: 0.07,
    minSpeed: 2,
    maxSpeed: 4.5,
    turnFactor: 0.3,
    margin: 25,
    particleSize: 4.0,
    maxDistance: 220,
    ...o
  };
}

/* -------------------------------------------------------------------------- */

const murmuration = {
  name: 'murmuration',
  energy: [0.3, 0.8],
  build(rng) {
    const path = makePath(rng, rand(rng, 55, 90));
    const pathSpeed = rand(rng, 0.16, 0.26);
    const flow = makeFlow(rng, 160, 320);
    const flowAmt = rand(rng, 0.05, 0.09);
    const predator = { until: 0, from: [0, 0, 0], to: [0, 0, 0], start: 0 };
    let lastStrike = -10;
    return {
      name: 'murmuration',
      label: 'Murmuration',
      energy: [0.3, 0.8],
      params: baseParams({
        visualRange: rand(rng, 18, 26),
        protectedRange: rand(rng, 5, 7),
        centeringFactor: rand(rng, 0.0008, 0.0014),
        matchingFactor: rand(rng, 0.06, 0.1),
        minSpeed: 2.2,
        maxSpeed: 4.8
      }),
      visual: { mode: [0.55, 0.45, 0], trail: 0.45, bloom: 0.55, hueRate: 3, sparkle: 0.3 },
      camera: { distance: 400, orbit: 0.07, elevation: 0.2 },
      pulseGain: 0.6,
      update(t, a, f) {
        flow(f, t, flowAmt + 0.05 * a.level, a.barPhase * 0.4);
        const p = path(t * (pathSpeed + 0.12 * a.level));
        setAgent(f, 0, p[0], p[1], p[2], -(0.1 + 0.12 * a.level), 70);

        // snare-triggered predator strike when the music is intense
        if (a.snare > 0.8 && a.intensity > 0.55 && t - lastStrike > 6 && t > 4) {
          lastStrike = t;
          const dir = rng() * TAU;
          const el = rand(rng, -0.6, 0.6);
          const r = 150;
          predator.from = [Math.cos(dir) * r, Math.sin(el) * r, Math.sin(dir) * r];
          predator.to = [-predator.from[0] * 0.9, -predator.from[1] * 0.6, -predator.from[2] * 0.9];
          predator.start = t;
          predator.until = t + 2.2;
        }
        if (t < predator.until) {
          const u = (t - predator.start) / (predator.until - predator.start);
          const e = u * u * (3 - 2 * u);
          setAgent(
            f,
            1,
            lerp(predator.from[0], predator.to[0], e),
            lerp(predator.from[1], predator.to[1], e),
            lerp(predator.from[2], predator.to[2], e),
            3.2,
            55
          );
        }
        f[F.CONTAIN_RADIUS] = 125;
        f[F.CONTAIN_STRENGTH] = 0.004;
      }
    };
  }
};

const vortex = {
  name: 'vortex',
  energy: [0.45, 1.1],
  spin: 1,
  build(rng) {
    const axis = new WanderDirection(rand(rng, 0.018, 0.035), Math.floor(rng() * 1e6));
    const radius = new Wander(28, 80, rand(rng, 0.02, 0.05), Math.floor(rng() * 1e6));
    const liftRate = rand(rng, 0.25, 0.5);
    const spin = sign(rng);
    const pullBase = rand(rng, 0.03, 0.06);
    return {
      name: 'vortex',
      label: 'Vortex',
      energy: [0.45, 1.1],
      params: baseParams({
        visualRange: 16,
        protectedRange: 4.5,
        centeringFactor: 0.0004,
        matchingFactor: 0.07,
        minSpeed: 2.5,
        maxSpeed: 5.5
      }),
      visual: { mode: [0.35, 0.65, 0], trail: 0.6, bloom: 0.65, hueRate: 6, sparkle: 0.25 },
      camera: { distance: 360, orbit: 0.1, elevation: 0.35 },
      pulseGain: 0.4,
      update(t, a, f) {
        const ax = axis.at(t);
        setVec(f, F.VORTEX_AXIS, ax[0], ax[1], ax[2]);
        setVec(f, F.VORTEX_CENTER, 0, 0, 0);
        f[F.VORTEX_STRENGTH] = spin * (0.11 + 0.12 * a.level + 0.16 * a.kick);
        f[F.VORTEX_PULL] = pullBase + 0.035 * a.bass;
        f[F.VORTEX_LIFT] = Math.sin(t * liftRate + a.barPhase * 1.5) * (0.035 + 0.03 * a.level);
        f[F.VORTEX_RADIUS] = radius.at(t) * (1 + 0.1 * a.bass);
        f[F.CONTAIN_RADIUS] = 115;
        f[F.CONTAIN_STRENGTH] = 0.006;
      }
    };
  }
};

const sphereShell = {
  name: 'sphere',
  energy: [0.15, 0.7],
  spin: 0.4,
  build(rng) {
    const axis = new WanderDirection(rand(rng, 0.04, 0.08), Math.floor(rng() * 1e6));
    const baseR = rand(rng, 60, 90);
    const breathe = new Wander(-10, 10, rand(rng, 0.03, 0.06), Math.floor(rng() * 1e6));
    const spin = sign(rng);
    const flow = makeFlow(rng, 90, 180);
    return {
      name: 'sphere',
      label: 'Shell',
      energy: [0.15, 0.7],
      params: baseParams({
        visualRange: 14,
        protectedRange: 6.5,
        centeringFactor: 0.0001,
        matchingFactor: 0.06,
        avoidFactor: 0.07,
        minSpeed: 2,
        maxSpeed: 4.5
      }),
      visual: { mode: [0.7, 0.3, 0], trail: 0.35, bloom: 0.6, hueRate: 2.5, sparkle: 0.5 },
      camera: { distance: 330, orbit: 0.08, elevation: 0.15 },
      pulseGain: 0.9,
      update(t, a, f) {
        f[F.SHAPE_TYPE] = SHAPE.SPHERE;
        f[F.SHAPE_STRENGTH] = 0.0065;
        f[F.SHAPE_R1] = baseR + breathe.at(t) + baseR * (0.14 * a.bass + 0.06 * a.pulse);
        setVec(f, F.SHAPE_CENTER, 0, 0, 0);
        const ax = axis.at(t);
        setVec(f, F.VORTEX_AXIS, ax[0], ax[1], ax[2]);
        f[F.VORTEX_STRENGTH] = spin * (0.025 + 0.05 * a.level);
        f[F.VORTEX_PULL] = 0;
        flow(f, t, 0.07 + 0.06 * a.level, a.barPhase * 0.3);
        f[F.CONTAIN_RADIUS] = 130;
      }
    };
  }
};

const torusRing = {
  name: 'torus',
  energy: [0.4, 1.0],
  spin: 0.9,
  build(rng) {
    const axis = new WanderDirection(rand(rng, 0.012, 0.025), Math.floor(rng() * 1e6));
    const major = rand(rng, 60, 92);
    const majorW = new Wander(-8, 8, 0.04, Math.floor(rng() * 1e6));
    const spin = sign(rng);
    const twist = rand(rng, 0, 0.03) * sign(rng); // slight lift makes the ring corkscrew
    return {
      name: 'torus',
      label: 'Halo',
      energy: [0.4, 1.0],
      params: baseParams({
        visualRange: 14,
        protectedRange: 4,
        centeringFactor: 0.0003,
        matchingFactor: 0.09,
        minSpeed: 3,
        maxSpeed: 6
      }),
      visual: { mode: [0.3, 0.6, 0.1], trail: 0.7, bloom: 0.7, hueRate: 8, sparkle: 0.2 },
      camera: { distance: 370, orbit: 0.09, elevation: 0.4 },
      pulseGain: 0.25,
      update(t, a, f) {
        const ax = axis.at(t);
        setVec(f, F.SHAPE_AXIS, ax[0], ax[1], ax[2]);
        setVec(f, F.VORTEX_AXIS, ax[0], ax[1], ax[2]);
        f[F.SHAPE_TYPE] = SHAPE.TORUS;
        f[F.SHAPE_STRENGTH] = 0.007;
        f[F.SHAPE_R1] = major + majorW.at(t) + major * 0.1 * a.bass;
        f[F.SHAPE_R2] = 7 + 16 * a.level + 6 * a.kick;
        f[F.VORTEX_STRENGTH] = spin * (0.14 + 0.1 * a.level + 0.12 * a.kick);
        f[F.VORTEX_LIFT] = twist * Math.sin(t * 0.3);
        f[F.CONTAIN_RADIUS] = 135;
      }
    };
  }
};

const galaxy = {
  name: 'galaxy',
  energy: [0.1, 0.6],
  spin: 0.9,
  build(rng) {
    const axis = new WanderDirection(rand(rng, 0.008, 0.018), Math.floor(rng() * 1e6));
    const spin = sign(rng);
    const coreR = rand(rng, 30, 50);
    return {
      name: 'galaxy',
      label: 'Spiral',
      energy: [0.1, 0.6],
      params: baseParams({
        visualRange: 12,
        protectedRange: 3.5,
        centeringFactor: 0.0003,
        matchingFactor: 0.05,
        avoidFactor: 0.04,
        minSpeed: 1.5,
        maxSpeed: 4
      }),
      visual: { mode: [0.5, 0.2, 0.3], trail: 0.85, bloom: 0.8, hueRate: 1.5, sparkle: 0.35 },
      camera: { distance: 340, orbit: 0.06, elevation: 0.55 },
      pulseGain: 0.5,
      update(t, a, f) {
        const ax = axis.at(t);
        setVec(f, F.SHAPE_AXIS, ax[0], ax[1], ax[2]);
        setVec(f, F.VORTEX_AXIS, ax[0], ax[1], ax[2]);
        f[F.SHAPE_TYPE] = SHAPE.DISC;
        f[F.SHAPE_STRENGTH] = 0.0045;
        f[F.SHAPE_R1] = 105 + 15 * a.level;
        f[F.VORTEX_STRENGTH] = spin * (0.09 + 0.07 * a.level);
        f[F.VORTEX_RADIUS] = coreR; // differential rotation -> spiral arms
        f[F.VORTEX_PULL] = 0.012 + 0.015 * a.bass;
        f[F.CONTAIN_RADIUS] = 130;
      }
    };
  }
};

const helix = {
  name: 'helix',
  energy: [0.35, 0.95],
  spin: 0.8,
  build(rng) {
    const axis = new WanderDirection(rand(rng, 0.01, 0.02), Math.floor(rng() * 1e6));
    const r = rand(rng, 32, 58);
    const spin = sign(rng);
    let liftSign = sign(rng);
    let lastFlip = 0;
    const flipEvery = rand(rng, 6, 11);
    return {
      name: 'helix',
      label: 'Column',
      energy: [0.35, 0.95],
      params: baseParams({
        visualRange: 14,
        protectedRange: 4,
        centeringFactor: 0.0003,
        matchingFactor: 0.08,
        minSpeed: 2.5,
        maxSpeed: 5
      }),
      visual: { mode: [0.4, 0.6, 0], trail: 0.65, bloom: 0.6, hueRate: 5, sparkle: 0.25 },
      camera: { distance: 350, orbit: 0.11, elevation: 0.05 },
      pulseGain: 0.3,
      update(t, a, f) {
        if (t - lastFlip > flipEvery || (a.beatTick && a.beatIndex % 16 === 0 && t - lastFlip > 3)) {
          liftSign = -liftSign;
          lastFlip = t;
        }
        const ax = axis.at(t);
        setVec(f, F.SHAPE_AXIS, ax[0], ax[1], ax[2]);
        setVec(f, F.VORTEX_AXIS, ax[0], ax[1], ax[2]);
        f[F.SHAPE_TYPE] = SHAPE.CYLINDER;
        f[F.SHAPE_STRENGTH] = 0.006;
        f[F.SHAPE_R1] = r * (1 + 0.15 * a.bass);
        f[F.SHAPE_R2] = 95;
        f[F.VORTEX_STRENGTH] = spin * (0.13 + 0.1 * a.level);
        f[F.VORTEX_LIFT] = liftSign * (0.04 + 0.03 * a.level + 0.03 * a.kick);
        f[F.CONTAIN_RADIUS] = 130;
      }
    };
  }
};

const ribbons = {
  name: 'ribbons',
  energy: [0.2, 0.8],
  build(rng) {
    const flow = makeFlow(rng, 110, 260);
    const wind = new WanderDirection(0.03, Math.floor(rng() * 1e6));
    const amt = rand(rng, 0.14, 0.2);
    return {
      name: 'ribbons',
      label: 'Currents',
      energy: [0.2, 0.8],
      params: baseParams({
        visualRange: 20,
        protectedRange: 5,
        centeringFactor: 0.0002,
        matchingFactor: 0.12,
        avoidFactor: 0.03,
        minSpeed: 3,
        maxSpeed: 6.5
      }),
      visual: { mode: [0.25, 0.75, 0], trail: 0.8, bloom: 0.6, hueRate: 4, sparkle: 0.2 },
      camera: { distance: 380, orbit: 0.06, elevation: 0.25 },
      pulseGain: 0.5,
      update(t, a, f) {
        flow(f, t, amt + 0.12 * a.level + 0.06 * a.kick, a.barPhase * 0.8);
        const w = wind.at(t);
        const ws = 0.01 + 0.01 * a.level;
        setVec(f, F.WIND, w[0] * ws, w[1] * ws, w[2] * ws);
        f[F.CONTAIN_RADIUS] = 125;
        f[F.CONTAIN_STRENGTH] = 0.006;
      }
    };
  }
};

const hunt = {
  name: 'hunt',
  energy: [0.6, 1.3],
  build(rng) {
    const count = rng() < 0.5 ? 2 : 3;
    const paths = [];
    for (let i = 0; i < count; i++) {
      paths.push({ path: makePath(rng, rand(rng, 80, 120)), speed: rand(rng, 0.35, 0.55), phase: rng() * 50 });
    }
    return {
      name: 'hunt',
      label: 'Hunt',
      energy: [0.6, 1.3],
      params: baseParams({
        visualRange: 24,
        protectedRange: 6,
        centeringFactor: 0.0013,
        matchingFactor: 0.08,
        avoidFactor: 0.06,
        minSpeed: 2.5,
        maxSpeed: 6.5
      }),
      visual: { mode: [0.4, 0.6, 0], trail: 0.4, bloom: 0.55, hueRate: 10, sparkle: 0.4 },
      camera: { distance: 400, orbit: 0.12, elevation: 0.2 },
      pulseGain: 0.5,
      update(t, a, f) {
        for (let i = 0; i < paths.length; i++) {
          const { path, speed, phase } = paths[i];
          const p = path(phase + t * (speed + 0.3 * a.intensity));
          setAgent(f, i, p[0], p[1], p[2], 2.2 + 2.5 * a.snare + 1.2 * a.kick, 45 + 20 * a.level);
        }
        f[F.CONTAIN_RADIUS] = 105;
        f[F.CONTAIN_STRENGTH] = 0.008;
      }
    };
  }
};

const nebula = {
  name: 'nebula',
  energy: [0, 0.4],
  build(rng) {
    const axis = new WanderDirection(0.015, Math.floor(rng() * 1e6));
    const flow = makeFlow(rng, 200, 400);
    const r1 = rand(rng, 95, 125);
    const r2 = rand(rng, 45, 75);
    return {
      name: 'nebula',
      label: 'Nebula',
      energy: [0, 0.4],
      params: baseParams({
        visualRange: 28,
        protectedRange: 9,
        centeringFactor: 0.0003,
        matchingFactor: 0.04,
        avoidFactor: 0.03,
        minSpeed: 1,
        maxSpeed: 2.6,
        particleSize: 4.2
      }),
      visual: { mode: [0.5, 0.1, 0.4], trail: 0.9, bloom: 0.9, hueRate: 1.2, sparkle: 0.6 },
      camera: { distance: 370, orbit: 0.04, elevation: 0.3 },
      pulseGain: 1.2,
      update(t, a, f) {
        const ax = axis.at(t);
        setVec(f, F.SHAPE_AXIS, ax[0], ax[1], ax[2]);
        f[F.SHAPE_TYPE] = SHAPE.LENS;
        f[F.SHAPE_STRENGTH] = 0.0016;
        f[F.SHAPE_R1] = r1 * (1 + 0.08 * a.bass);
        f[F.SHAPE_R2] = r2;
        flow(f, t, 0.04 + 0.03 * a.level);
        f[F.JITTER] = 0.05;
        f[F.CONTAIN_RADIUS] = 140;
        f[F.CONTAIN_STRENGTH] = 0.003;
      }
    };
  }
};

const twinOrbits = {
  name: 'twins',
  energy: [0.35, 0.9],
  spin: 0.7,
  build(rng) {
    const axis = new WanderDirection(rand(rng, 0.015, 0.03), Math.floor(rng() * 1e6));
    const radius = rand(rng, 55, 85);
    const rate = rand(rng, 0.3, 0.55) * sign(rng);
    const up = [0, 0, 0];
    const right = [0, 0, 0];
    return {
      name: 'twins',
      label: 'Binary',
      energy: [0.35, 0.9],
      params: baseParams({
        visualRange: 16,
        protectedRange: 5,
        centeringFactor: 0.0006,
        matchingFactor: 0.08,
        minSpeed: 2.5,
        maxSpeed: 5.5
      }),
      visual: { mode: [0.5, 0.5, 0], trail: 0.55, bloom: 0.6, hueRate: 4, sparkle: 0.3 },
      camera: { distance: 370, orbit: 0.08, elevation: 0.3 },
      pulseGain: 0.5,
      update(t, a, f) {
        const ax = axis.at(t);
        // build an orthonormal frame around the axis
        const ref = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        right[0] = ref[1] * ax[2] - ref[2] * ax[1];
        right[1] = ref[2] * ax[0] - ref[0] * ax[2];
        right[2] = ref[0] * ax[1] - ref[1] * ax[0];
        const rl = Math.hypot(right[0], right[1], right[2]) || 1;
        right[0] /= rl; right[1] /= rl; right[2] /= rl;
        up[0] = ax[1] * right[2] - ax[2] * right[1];
        up[1] = ax[2] * right[0] - ax[0] * right[2];
        up[2] = ax[0] * right[1] - ax[1] * right[0];

        const ang = t * (rate * (1 + 0.5 * a.level));
        const r = radius * (1 + 0.1 * a.bass);
        const c = Math.cos(ang) * r;
        const s = Math.sin(ang) * r;
        const strength = -(0.16 + 0.1 * a.level);
        setAgent(f, 0, right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s, strength, 55);
        setAgent(f, 1, -(right[0] * c + up[0] * s), -(right[1] * c + up[1] * s), -(right[2] * c + up[2] * s), strength, 55);
        setVec(f, F.VORTEX_AXIS, ax[0], ax[1], ax[2]);
        f[F.VORTEX_STRENGTH] = Math.sign(rate) * 0.04;
        f[F.CONTAIN_RADIUS] = 130;
      }
    };
  }
};

const comet = {
  name: 'comet',
  energy: [0.5, 1.2],
  build(rng) {
    const path = makePath(rng, rand(rng, 90, 115));
    const speed = rand(rng, 0.28, 0.42);
    const flow = makeFlow(rng, 180, 300);
    return {
      name: 'comet',
      label: 'Comet',
      energy: [0.5, 1.2],
      params: baseParams({
        visualRange: 18,
        protectedRange: 5,
        centeringFactor: 0.0009,
        matchingFactor: 0.1,
        minSpeed: 3.5,
        maxSpeed: 7.5
      }),
      visual: { mode: [0.2, 0.8, 0], trail: 0.75, bloom: 0.7, hueRate: 7, sparkle: 0.3 },
      camera: { distance: 420, orbit: 0.1, elevation: 0.25 },
      pulseGain: 0.4,
      update(t, a, f) {
        const p = path(t * (speed + 0.2 * a.level));
        setAgent(f, 0, p[0], p[1], p[2], -(0.3 + 0.2 * a.level), 45);
        flow(f, t, 0.04);
        f[F.CONTAIN_RADIUS] = 140;
        f[F.CONTAIN_STRENGTH] = 0.003;
      }
    };
  }
};

/**
 * Drift state used whenever there is no music (no track, or silence inside
 * one): every field fades out, momentum carries but decays, and the birds
 * float in a soft bubble like dust in still water. No vortex, no leader, no
 * rhythm. The show only begins once sound arrives.
 */
export const REST_SCENE = {
  name: 'rest',
  energy: [0, 0.2],
  spin: 0,
  build(rng) {
    const flow = makeFlow(rng, 260, 420);
    return {
      name: 'rest',
      label: 'Drifting',
      energy: [0, 0.2],
      cymGain: 0,
      params: baseParams({
        visualRange: 20,
        protectedRange: 7,
        centeringFactor: 0.00015,
        matchingFactor: 0.03,
        avoidFactor: 0.035,
        minSpeed: 0.12,
        maxSpeed: 6,
        turnFactor: 0.12
      }),
      visual: { mode: [0.8, 0.2, 0], trail: 0.6, bloom: 0.45, hueRate: 1, sparkle: 0.1 },
      camera: { distance: 380, orbit: 0.03, elevation: 0.2 },
      pulseGain: 0,
      update(t, a, f) {
        // A barely-there current so the suspension slowly turns over.
        flow(f, t, 0.004);
        f[F.DRIFT_DAMPING] = 0.022;
        f[F.JITTER] = 0.015;
        f[F.CONTAIN_RADIUS] = 120;
        f[F.CONTAIN_STRENGTH] = 0.0025;
      }
    };
  }
};

export const SCENES = [
  murmuration,
  vortex,
  sphereShell,
  torusRing,
  galaxy,
  helix,
  ribbons,
  hunt,
  nebula,
  twinOrbits,
  comet
];

export const SCENE_NAMES = SCENES.map((s) => s.name);

export function buildScene(name, rng) {
  const def = name === 'rest' ? REST_SCENE : SCENES.find((s) => s.name === name) || pick(rng, SCENES);
  const inst = def.build(rng);
  inst.energy = def.energy;
  inst.spin = def.spin || 0; // how strongly the archetype tends to mill (for the circularity monitor)
  return inst;
}

export { clamp, fbm1 };
