/**
 * Shared force-field layout.
 *
 * The choreographer writes a flat Float32Array using these indices every frame.
 * Both the JS flock (Boid.js) and the Rust/WASM flock (lib.rs `apply_field`)
 * read the exact same layout, so the two backends stay visually identical.
 *
 * All strengths are per-frame velocity increments in world units
 * (bird speeds are ~1-8 units/frame), so typical values are 0.001 - 0.05.
 */

export const FIELD_SIZE = 160;

export const F = {
  // Divergence-free "curl of sines" wind. Three wave vectors + phases.
  FLOW_STRENGTH: 0,
  FLOW_K1: 1,        // 1,2,3
  FLOW_K2: 4,        // 4,5,6
  FLOW_K3: 7,        // 7,8,9
  FLOW_PHASE: 10,    // 10,11,12

  // Vortex around an axis through a center.
  VORTEX_STRENGTH: 13,
  VORTEX_AXIS: 14,   // 14,15,16 (unit vector)
  VORTEX_CENTER: 17, // 17,18,19
  VORTEX_PULL: 20,   // + pulls toward axis, - pushes away
  VORTEX_LIFT: 21,   // force along axis (makes columns / helices)
  VORTEX_RADIUS: 22, // radius where tangential force peaks (0 = flat)

  // Shape attractor: pulls birds onto a surface.
  SHAPE_TYPE: 23,    // 0 none, 1 sphere, 2 torus, 3 disc, 4 cylinder, 5 ellipsoid-ish lens
  SHAPE_STRENGTH: 24,
  SHAPE_R1: 25,      // radius / major radius / disc radius
  SHAPE_R2: 26,      // tube radius / thickness / half-height
  SHAPE_AXIS: 27,    // 27,28,29 (unit vector)
  SHAPE_CENTER: 30,  // 30,31,32

  // Up to three roaming agents (predators repel, leaders attract).
  AGENT_COUNT: 33,
  AGENT_BASE: 34,    // 3 agents x 5 floats: x, y, z, strength (+repel / -attract), radius
  AGENT_STRIDE: 5,
  MAX_AGENTS: 3,

  // Expanding shockwave (bass hits).
  PULSE_STRENGTH: 49,
  PULSE_RADIUS: 50,
  PULSE_WIDTH: 51,
  PULSE_CENTER: 52,  // 52,53,54

  // Constant wind.
  WIND: 55,          // 55,56,57

  // Soft spherical containment (keeps shapes off the box corners).
  CONTAIN_STRENGTH: 58,
  CONTAIN_RADIUS: 59,

  // Random jitter per bird (nervous energy).
  JITTER: 60,

  // Field susceptibility multiplier for per-bird "personality" spread (0..1).
  TRAIT_SPREAD: 61,

  // ---- Evolution layer (lineages, energy, selection) --------------------
  EVO_ENABLED: 64,      // 0/1: energy economy, death and division active
  EVO_KINSHIP: 65,      // 0..1: how much alignment/cohesion prefer same-lineage birds
  EVO_XENO: 66,         // repulsion from birds of distant lineages
  EVO_MUTATION: 67,     // hue / trait mutation scale per division
  EVO_CHURN: 68,        // fraction of the population checked for death each frame
  EVO_GAIN: 69,         // energy gained per frame in good company
  EVO_LOSS: 70,         // baseline energy lost per frame
  EVO_EXTINCTION: 71,   // >0: drain the dominant lineage (mass-extinction pulse)
  EVO_DEATH: 72,        // energy threshold below which a bird is replaced
  EVO_CROWD: 73,        // neighbour count above which crowding drains energy
  EVO_SENESCENCE: 74,   // random death chance per check, keeps lineages dividing

  // ---- Drift / silence --------------------------------------------------
  DRIFT_DAMPING: 75,    // per-frame velocity loss (0..0.05): momentum decays, birds float

  // ---- Containment shape (sphere was the only option; spheres breed mills)
  CONTAIN_TYPE: 76,     // 0 sphere, 1 ellipsoid, 2 box (slab = flat box)
  CONTAIN_SCALE: 77,    // 77,78,79 per-axis multipliers on CONTAIN_RADIUS

  // ---- Cymatic standing-wave layers --------------------------------------
  // Each layer is f(p) = cos(k.p + phase) * cos(k2.p + phase2); birds are
  // pushed toward its nodal surfaces (mode 0, like sand on a Chladni plate)
  // or its antinodes (mode 1). One layer per frequency band; the sum is the
  // interference pattern of the whole song.
  CYM_COUNT: 80,
  CYM_BASE: 81,
  CYM_STRIDE: 12,       // strength, k(3), k2(3), phase, phase2, mode, band, spare
  MAX_CYM: 5,           // 81..140
  CYM_AFFINITY: 141,    // 0..1: lineages (hue quadrant) feel "their" band's layer more

  // ---- Shear flow (counter-field against persistent milling) -------------
  SHEAR_STRENGTH: 142,
  SHEAR_NORMAL: 143,    // 143,144,145 plane normal (unit)
  SHEAR_DIR: 146        // 146,147,148 flow direction (unit), reverses across the plane
};

export const CONTAIN = { SPHERE: 0, ELLIPSOID: 1, BOX: 2 };

/** Frequency band a lineage is tuned to: hue quadrant -> 0 bass, 1 low-mid, 2 vocal, 3 treble. */
export function hueBand(hue) {
  return Math.floor((((hue % 1) + 1) % 1) * 4) & 3;
}

export const HUE_BINS = 16;

/** Circular hue distance in [0, 0.5]. */
export function hueDistance(a, b) {
  let d = Math.abs(a - b);
  if (d > 0.5) d = 1 - d;
  return d;
}

/** Approximate Gaussian in roughly [-1.5, 1.5]. */
export function gaussRandom(rand = Math.random) {
  return rand() + rand() + rand() - 1.5;
}

export const SHAPE = {
  NONE: 0,
  SPHERE: 1,
  TORUS: 2,
  DISC: 3,
  CYLINDER: 4,
  LENS: 5
};

export function createFieldBuffer() {
  const f = new Float32Array(FIELD_SIZE);
  f[F.VORTEX_AXIS + 1] = 1;
  f[F.SHAPE_AXIS + 1] = 1;
  f[F.CONTAIN_RADIUS] = 140;
  f[F.CONTAIN_STRENGTH] = 0.004;
  f[F.CONTAIN_SCALE] = 1;
  f[F.CONTAIN_SCALE + 1] = 1;
  f[F.CONTAIN_SCALE + 2] = 1;
  return f;
}

/**
 * JS implementation of the field force. Mirrors `apply_field` in lib.rs.
 * `out` receives the force (velocity increment) to add for a bird at (px,py,pz)
 * with personality `trait` (around 1.0). Jitter is applied by the simulation loop.
 */
export function applyField(f, px, py, pz, vx, vy, vz, trait, hue, out) {
  let ax = 0;
  let ay = 0;
  let az = 0;

  // ---- Curl noise wind -------------------------------------------------
  const fs = f[F.FLOW_STRENGTH];
  if (fs !== 0) {
    const k1x = f[1], k1y = f[2], k1z = f[3];
    const k2x = f[4], k2y = f[5], k2z = f[6];
    const k3x = f[7], k3y = f[8], k3z = f[9];
    const c1 = Math.cos(k1x * px + k1y * py + k1z * pz + f[10]);
    const c2 = Math.cos(k2x * px + k2y * py + k2z * pz + f[11]);
    const c3 = Math.cos(k3x * px + k3y * py + k3z * pz + f[12]);
    // curl of A = (sin(k1.p), sin(k2.p), sin(k3.p))
    const cx = k3y * c3 - k2z * c2;
    const cy = k1z * c1 - k3x * c3;
    const cz = k2x * c2 - k1y * c1;
    // normalise by typical |k| so strength is independent of frequency
    const kn = Math.sqrt(k1x * k1x + k1y * k1y + k1z * k1z) + 1e-6;
    const s = fs / kn;
    ax += cx * s;
    ay += cy * s;
    az += cz * s;
  }

  // ---- Vortex ------------------------------------------------------------
  const vs = f[F.VORTEX_STRENGTH];
  const vp = f[F.VORTEX_PULL];
  const vl = f[F.VORTEX_LIFT];
  if (vs !== 0 || vp !== 0 || vl !== 0) {
    const axx = f[14], axy = f[15], axz = f[16];
    const qx = px - f[17], qy = py - f[18], qz = pz - f[19];
    const along = qx * axx + qy * axy + qz * axz;
    const rx = qx - axx * along, ry = qy - axy * along, rz = qz - axz * along;
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) + 1e-4;
    // tangential = axis x r
    const tx = axy * rz - axz * ry;
    const ty = axz * rx - axx * rz;
    const tz = axx * ry - axy * rx;
    const vr = f[F.VORTEX_RADIUS];
    let fall = 1;
    if (vr > 0) {
      const u = rl / vr;
      fall = u * Math.exp(1 - u); // peaks at rl == vr
    }
    const tangent = (vs * fall) / rl;
    ax += tx * tangent - (rx / rl) * vp;
    ay += ty * tangent - (ry / rl) * vp;
    az += tz * tangent - (rz / rl) * vp;
    ax += axx * vl;
    ay += axy * vl;
    az += axz * vl;
  }

  // ---- Shape attractor ---------------------------------------------------
  const st = f[F.SHAPE_TYPE] | 0;
  const ss = f[F.SHAPE_STRENGTH];
  if (st !== 0 && ss !== 0) {
    const r1 = f[F.SHAPE_R1];
    const r2 = f[F.SHAPE_R2];
    const axx = f[27], axy = f[28], axz = f[29];
    const qx = px - f[30], qy = py - f[31], qz = pz - f[32];

    if (st === SHAPE.SPHERE) {
      const d = Math.sqrt(qx * qx + qy * qy + qz * qz) + 1e-4;
      const k = (ss * (r1 - d)) / d;
      ax += qx * k;
      ay += qy * k;
      az += qz * k;
    } else {
      const along = qx * axx + qy * axy + qz * axz;
      const rx = qx - axx * along, ry = qy - axy * along, rz = qz - axz * along;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) + 1e-4;

      if (st === SHAPE.TORUS) {
        // nearest point on the ring of radius r1, then spring to tube radius r2
        const ringScale = r1 / rl;
        const dx = qx - rx * ringScale;
        const dy = qy - ry * ringScale;
        const dz = qz - rz * ringScale;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
        const k = (ss * (r2 - d)) / d;
        ax += dx * k;
        ay += dy * k;
        az += dz * k;
      } else if (st === SHAPE.DISC) {
        // flatten onto plane, keep inside radius r1
        const kPlane = -ss * along;
        ax += axx * kPlane;
        ay += axy * kPlane;
        az += axz * kPlane;
        if (rl > r1) {
          const k = (ss * 0.6 * (r1 - rl)) / rl;
          ax += rx * k;
          ay += ry * k;
          az += rz * k;
        }
      } else if (st === SHAPE.CYLINDER) {
        const k = (ss * (r1 - rl)) / rl;
        ax += rx * k;
        ay += ry * k;
        az += rz * k;
        if (along > r2) {
          const kk = -ss * 0.8 * (along - r2);
          ax += axx * kk;
          ay += axy * kk;
          az += axz * kk;
        } else if (along < -r2) {
          const kk = -ss * 0.8 * (along + r2);
          ax += axx * kk;
          ay += axy * kk;
          az += axz * kk;
        }
      } else if (st === SHAPE.LENS) {
        // squashed sphere: radius r1 in-plane, r2 along axis
        const sx = rx / r1, sy = ry / r1, sz = rz / r1;
        const sa = along / Math.max(r2, 1e-3);
        const e = Math.sqrt(sx * sx + sy * sy + sz * sz + sa * sa) + 1e-4;
        const k = ss * (1 - e) * r1;
        const inv = 1 / e;
        ax += (rx * inv / r1 + axx * sa * inv) * k;
        ay += (ry * inv / r1 + axy * sa * inv) * k;
        az += (rz * inv / r1 + axz * sa * inv) * k;
      }
    }
  }

  // ---- Agents ------------------------------------------------------------
  const agentCount = f[F.AGENT_COUNT] | 0;
  for (let i = 0; i < agentCount && i < F.MAX_AGENTS; i++) {
    const b = F.AGENT_BASE + i * F.AGENT_STRIDE;
    const dx = px - f[b], dy = py - f[b + 1], dz = pz - f[b + 2];
    const strength = f[b + 3];
    const radius = f[b + 4];
    if (strength === 0 || radius <= 0) continue;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
    if (strength > 0) {
      // predator: repel strongly inside radius
      if (d < radius) {
        const u = 1 - d / radius;
        const k = (strength * u * u) / d;
        ax += dx * k;
        ay += dy * k;
        az += dz * k;
      }
    } else {
      // leader: attract with soft falloff beyond radius, no singularity near it
      const u = d / radius;
      const w = u < 1 ? u : 1 / (u * u);
      const k = (strength * w) / d; // strength negative -> toward agent
      ax += dx * k;
      ay += dy * k;
      az += dz * k;
    }
  }

  // ---- Pulse ---------------------------------------------------------------
  const ps = f[F.PULSE_STRENGTH];
  if (ps !== 0) {
    const dx = px - f[52], dy = py - f[53], dz = pz - f[54];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
    const w = Math.max(f[F.PULSE_WIDTH], 1);
    const g = (d - f[F.PULSE_RADIUS]) / w;
    const band = Math.exp(-g * g);
    const k = (ps * band) / d;
    ax += dx * k;
    ay += dy * k;
    az += dz * k;
  }

  // ---- Wind ------------------------------------------------------------------
  ax += f[55];
  ay += f[56];
  az += f[57];

  // ---- Cymatic layers -------------------------------------------------------
  const cn = f[F.CYM_COUNT] | 0;
  if (cn > 0) {
    const aff = f[F.CYM_AFFINITY];
    const band = hueBand(hue);
    for (let i = 0; i < cn && i < F.MAX_CYM; i++) {
      const b = F.CYM_BASE + i * F.CYM_STRIDE;
      let s = f[b];
      if (s === 0) continue;
      if (aff > 0) s *= band === (f[b + 10] | 0) ? 1 + aff : 1 - 0.7 * aff;
      const kx = f[b + 1], ky = f[b + 2], kz = f[b + 3];
      const k2x = f[b + 4], k2y = f[b + 5], k2z = f[b + 6];
      const u = kx * px + ky * py + kz * pz + f[b + 7];
      const v = k2x * px + k2y * py + k2z * pz + f[b + 8];
      const c1 = Math.cos(u), s1 = Math.sin(u);
      const c2 = Math.cos(v), s2 = Math.sin(v);
      const val = c1 * c2;
      const gx = -s1 * c2 * kx - c1 * s2 * k2x;
      const gy = -s1 * c2 * ky - c1 * s2 * k2y;
      const gz = -s1 * c2 * kz - c1 * s2 * k2z;
      const kn = Math.sqrt(kx * kx + ky * ky + kz * kz) + 1e-6;
      // nodal (mode 0): descend val^2 toward the zero surfaces; antinodal: ascend
      const g = ((f[b + 9] > 0.5 ? s : -s) * val) / kn;
      ax += gx * g;
      ay += gy * g;
      az += gz * g;
      // Steer: rotate the velocity component across the sheet into the
      // along-sheet direction (speed is preserved), strongest near the sheet,
      // so birds land on nodes and flow along them instead of oscillating through.
      const gl2 = gx * gx + gy * gy + gz * gz;
      if (gl2 > 1e-10) {
        const vn = (vx * gx + vy * gy + vz * gz) / gl2; // normal component / |g|
        const cd = Math.min(0.3, 2 * Math.abs(s)) * (1 - val * val);
        const rx = vn * gx, ry = vn * gy, rz = vn * gz; // normal velocity vector
        const tx = vx - rx, ty = vy - ry, tz = vz - rz; // tangential velocity
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
        ax -= rx * cd;
        ay -= ry * cd;
        az -= rz * cd;
        if (tl > 1e-4) {
          const add = (rl * cd) / tl;
          ax += tx * add;
          ay += ty * add;
          az += tz * add;
        }
      }
    }
  }

  // ---- Shear ------------------------------------------------------------------
  const shs = f[F.SHEAR_STRENGTH];
  if (shs !== 0) {
    const d = px * f[143] + py * f[144] + pz * f[145];
    const k = (shs * Math.max(-1.5, Math.min(1.5, d / 60)));
    ax += f[146] * k;
    ay += f[147] * k;
    az += f[148] * k;
  }

  // ---- Containment --------------------------------------------------------
  const cs = f[F.CONTAIN_STRENGTH];
  if (cs !== 0) {
    const cr = f[F.CONTAIN_RADIUS];
    const ct = f[F.CONTAIN_TYPE] | 0;
    if (ct === CONTAIN.ELLIPSOID) {
      const rx = cr * f[77], ry = cr * f[78], rz = cr * f[79];
      const ex = px / rx, ey = py / ry, ez = pz / rz;
      const e = Math.sqrt(ex * ex + ey * ey + ez * ez) + 1e-4;
      if (e > 1) {
        const k = (-cs * (e - 1)) / e;
        const cr2 = cr * cr;
        ax += px * (cr2 / (rx * rx)) * k;
        ay += py * (cr2 / (ry * ry)) * k;
        az += pz * (cr2 / (rz * rz)) * k;
      }
    } else if (ct === CONTAIN.BOX) {
      // rounded box: shrink the half extents by a corner radius and push along
      // the excess vector, so edges and corners are soft instead of a hard cube
      const r = 0.35 * Math.min(cr * f[77], cr * f[78], cr * f[79]);
      const hx = cr * f[77] - r, hy = cr * f[78] - r, hz = cr * f[79] - r;
      const ex = px > hx ? px - hx : px < -hx ? px + hx : 0;
      const ey = py > hy ? py - hy : py < -hy ? py + hy : 0;
      const ez = pz > hz ? pz - hz : pz < -hz ? pz + hz : 0;
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (el > r) {
        const k = (-cs * (el - r)) / el;
        ax += ex * k;
        ay += ey * k;
        az += ez * k;
      }
    } else {
      const d = Math.sqrt(px * px + py * py + pz * pz) + 1e-4;
      if (d > cr) {
        const k = (-cs * (d - cr)) / d;
        ax += px * k;
        ay += py * k;
        az += pz * k;
      }
    }
  }

  // ---- Personality ---------------------------------------------------------
  const spread = f[F.TRAIT_SPREAD];
  const m = 1 + (trait - 1) * spread;
  out[0] = ax * m;
  out[1] = ay * m;
  out[2] = az * m;
}
