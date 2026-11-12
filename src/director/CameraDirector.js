import * as THREE from 'three';
import { fbm1, damp, clamp } from './Noise.js';

/**
 * Slow, sweeping camera work that follows the flock's centre of mass and
 * leans into the music. The user can grab the camera at any time; the
 * director waits for them to let go, then eases back in from wherever the
 * camera was left so nothing ever snaps.
 *
 * Framing rule: the whole flock stays in view. The scene supplies a preferred
 * distance, but the camera never comes closer than the distance at which the
 * sampled birds, projected in the camera's own basis, fit inside the frame
 * with a margin (portrait phones included). Expansion is anticipated and
 * followed quickly; contraction is followed lazily, and the dolly speed is
 * capped, so the camera backs out smoothly and never pumps in and out.
 */
export class CameraDirector {
  constructor(sceneManager) {
    this.sm = sceneManager;
    this.enabled = true;

    this.spherical = new THREE.Spherical();
    this.spherical.setFromVector3(
      this.sm.camera.position.clone().sub(this.sm.controls.target)
    );
    this.theta = this.spherical.theta;
    this.phi = this.spherical.phi;
    this.radius = this.spherical.radius;

    this.target = new THREE.Vector3();
    this.centroid = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.lookOffset = new THREE.Vector3();

    // Framing: sampled bird positions (xyz triples) and the distance needed
    // to fit them in the frame, smoothed asymmetrically.
    this.samples = null;
    this.sampleCount = 0;
    this.required = new Float32Array(600);
    this.fitRaw = 0;          // required distance this frame
    this.fitDistance = 0;     // smoothed (fast out, slow in, with anticipation)
    this.fitRate = 0;         // smoothed d(fitRaw)/dt
    this.margin = 1.15;       // lateral headroom: the flock fills ~87% of the frame
    this.keep = 0.99;         // fraction of samples that must be inside the frame
    this.preferred = 0;
    this.right = new THREE.Vector3();
    this.upv = new THREE.Vector3();
    this.toCam = new THREE.Vector3();

    this.userActive = false;
    this.resumeAt = 0;
    this.blendIn = 1; // 0..1, ramps up after the user releases the camera
    this.time = 0;
    this.seed = Math.floor(Math.random() * 1e6);

    const c = this.sm.controls;
    c.addEventListener('start', () => {
      this.userActive = true;
    });
    c.addEventListener('end', () => {
      this.userActive = false;
      this.resumeAt = performance.now() + 7000;
      this.blendIn = 0;
    });
  }

  setCentroid(x, y, z) {
    this.centroid.set(x, y, z);
  }

  /** A few hundred sampled bird positions (xyz), refreshed a few times a second. */
  setFlockSamples(buffer, count) {
    this.samples = buffer;
    this.sampleCount = count;
    if (this.required.length < count) this.required = new Float32Array(count + 64);
  }

  /**
   * Distance from the look target at which `keep` of the samples project
   * inside the frame for the camera orientation (theta, phi). A bird at
   * lateral offset l and depth a (toward the camera) needs d >= a + l / tan(half).
   */
  requiredDistance() {
    const n = this.sampleCount;
    if (!this.samples || n === 0) return 0;
    const camera = this.sm.camera;
    const vHalf = THREE.MathUtils.degToRad(camera.fov) * 0.5;
    const tanV = Math.tan(vHalf);
    const tanH = tanV * camera.aspect;
    // Camera basis for the director's orientation: z toward the camera,
    // x = up × z, y = z × x (what lookAt builds).
    this.spherical.set(1, this.phi, this.theta);
    this.toCam.setFromSpherical(this.spherical).normalize();
    this.right.set(0, 1, 0).cross(this.toCam).normalize();
    this.upv.copy(this.toCam).cross(this.right);
    const s = this.samples, t = this.target, m = this.margin, req = this.required;
    for (let i = 0; i < n; i++) {
      const rx = s[i * 3] - t.x, ry = s[i * 3 + 1] - t.y, rz = s[i * 3 + 2] - t.z;
      const a = rx * this.toCam.x + ry * this.toCam.y + rz * this.toCam.z;
      const lx = Math.abs(rx * this.right.x + ry * this.right.y + rz * this.right.z);
      const ly = Math.abs(rx * this.upv.x + ry * this.upv.y + rz * this.upv.z);
      req[i] = a + m * Math.max(lx / tanH, ly / tanV);
    }
    const view = req.subarray(0, n).sort();
    return view[Math.min(n - 1, Math.floor(n * this.keep))];
  }

  update(dt, cam, audio) {
    const controls = this.sm.controls;
    const camera = this.sm.camera;
    this.time += dt;

    if (!this.enabled || this.userActive || performance.now() < this.resumeAt) {
      // keep director state in sync with wherever the user put the camera
      this.tmp.copy(camera.position).sub(controls.target);
      this.spherical.setFromVector3(this.tmp);
      this.theta = this.spherical.theta;
      this.phi = this.spherical.phi;
      this.radius = this.spherical.radius;
      this.target.copy(controls.target);
      controls.update();
      return;
    }

    this.blendIn = clamp(this.blendIn + dt / 3, 0, 1);
    const w = this.blendIn * this.blendIn * (3 - 2 * this.blendIn);

    // Orbit: scene speed + slow wander, direction occasionally reverses via noise.
    const dir = Math.sign(fbm1(this.time * 0.012, this.seed + 1) + 0.35) || 1;
    const orbitSpeed = cam.orbit * dir * (1 + 0.4 * fbm1(this.time * 0.07, this.seed + 2));
    this.theta += orbitSpeed * dt * w;

    // Elevation: scene bias + wander, kept off the poles.
    const phiTarget = clamp(
      Math.PI / 2 - cam.elevation * 1.4 - 0.5 * fbm1(this.time * 0.03, this.seed + 3),
      0.35,
      Math.PI - 0.5
    );
    this.phi = damp(this.phi, phiTarget, 0.35 * w, dt);

    // Look target: the centroid with a gentle drift scaled to the flock size.
    const wander = 0.03 * this.radius;
    this.lookOffset.set(
      wander * fbm1(this.time * 0.05, this.seed + 4),
      wander * 0.7 * fbm1(this.time * 0.045, this.seed + 5),
      wander * fbm1(this.time * 0.055, this.seed + 6)
    );
    this.tmp.copy(this.centroid).add(this.lookOffset);
    this.target.x = damp(this.target.x, this.tmp.x, 0.8 * w, dt);
    this.target.y = damp(this.target.y, this.tmp.y, 0.8 * w, dt);
    this.target.z = damp(this.target.z, this.tmp.z, 0.8 * w, dt);

    // Distance: the scene's preference, floored at what fits the flock.
    // Expansion is followed at once and anticipated ~0.7 s ahead; contraction
    // is followed slowly so the camera zooms in lazily.
    const fitNow = this.requiredDistance();
    if (fitNow > 0) {
      const rate = (fitNow - this.fitRaw) / Math.max(dt, 1e-3);
      this.fitRate += (rate - this.fitRate) * Math.min(1, 6 * dt);
      this.fitRaw = fitNow;
      const lead = fitNow + clamp(this.fitRate * 0.7, 0, 0.2 * fitNow);
      this.fitDistance = lead > this.fitDistance
        ? damp(this.fitDistance, lead, 3, dt)
        : damp(this.fitDistance, lead, 0.25, dt);
    }
    this.preferred = cam.distance;
    const breathe = 1 - 0.03 * audio.pulse - 0.04 * cam.kick; // stays inside the margin
    const radiusTarget = Math.max(this.preferred, this.fitDistance) * breathe;
    // Back out promptly, zoom in lazily, and never faster than a slow dolly
    // (15% of the distance per second out, 6% in): no pumping, no popping.
    const rate = radiusTarget > this.radius ? 1.4 : 0.35;
    const next = damp(this.radius, radiusTarget, rate * w, dt);
    const maxStep = this.radius * (next > this.radius ? 0.15 : 0.06) * dt * (0.2 + 0.8 * w);
    this.radius += clamp(next - this.radius, -maxStep, maxStep);
    this.radius = clamp(this.radius, controls.minDistance + 20, controls.maxDistance - 20);

    this.spherical.set(this.radius, this.phi, this.theta);
    this.tmp.setFromSpherical(this.spherical);
    controls.target.copy(this.target);
    camera.position.copy(this.target).add(this.tmp);
    controls.update();
  }
}
