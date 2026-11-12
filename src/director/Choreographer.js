/**
 * The choreographer turns audio features + time into:
 *   - boid parameter targets
 *   - a force-field buffer (FieldLayout.js) that sculpts the flock
 *   - visual state for the renderer / post-processing / camera
 *
 * It sequences scene archetypes (scenes.js), crossfades between them on
 * musical phrase boundaries, layers beat-synced events on top, and keeps
 * everything drifting with noise so the show never settles into a loop.
 */
import { F, SHAPE, CONTAIN, FIELD_SIZE, createFieldBuffer } from '../fields/FieldLayout.js';
import { SCENES, SCENE_NAMES, buildScene } from './scenes.js';
import { mulberry32, fbm1, lerp, clamp, smoothstep, damp, Wander, WanderDirection } from './Noise.js';

const TAU = Math.PI * 2;

/**
 * Cymatic layers: one standing-wave field per frequency band. Pitch within
 * the band (in octaves between lo..hi) picks the wavelength between
 * lamMax..lamMin, so bass carves big lobes and treble adds fine ripples.
 */
const CYM_LAYERS = [
  { band: 0, lo: Math.log2(30), hi: Math.log2(200), lamMax: 170, lamMin: 95, gain: 1.0, mode: 0 },
  { band: 1, lo: Math.log2(150), hi: Math.log2(800), lamMax: 95, lamMin: 52, gain: 0.8, mode: 0 },
  { band: 2, lo: Math.log2(500), hi: Math.log2(3000), lamMax: 52, lamMin: 26, gain: 0.75, mode: 0 },
  { band: 3, lo: Math.log2(2500), hi: Math.log2(9000), lamMax: 26, lamMin: 12, gain: 0.45, mode: 1 }
];

const PARAM_KEYS = [
  'visualRange',
  'protectedRange',
  'centeringFactor',
  'avoidFactor',
  'matchingFactor',
  'minSpeed',
  'maxSpeed',
  'turnFactor',
  'margin',
  'particleSize',
  'maxDistance'
];

export class Choreographer {
  constructor(options = {}) {
    this.rng = mulberry32(options.seed ?? (Date.now() & 0xffffffff));
    this.autopilot = true;
    this.intensityGain = 1.0;
    this.manualScene = 'auto';
    this.onSceneChange = options.onSceneChange || null;

    this.time = 0;
    this.sceneTime = 0;
    this.sceneDuration = 30;
    this.history = [];

    this.current = null;
    this.next = null;
    this.blend = 0;
    this.transitionDuration = 4;
    this.pendingSwitch = null; // { name, duration, waitUntil }

    this.field = createFieldBuffer();
    this.fieldA = new Float32Array(FIELD_SIZE);
    this.fieldB = new Float32Array(FIELD_SIZE);

    this.params = {};
    this.paramsA = {};
    this.paramsB = {};

    // Evolution settings (GUI-facing). Selection pressure only acts while live.
    this.evo = {
      enabled: true,
      kinship: 0.8,
      xeno: 0.05,
      mutation: 0.012,
      lineageColor: 0.85,
      extinctionPulse: 0,
      lastExtinctionAt: 0
    };

    this.visual = {
      modePos: 1,
      modeVel: 0,
      modePal: 0,
      modeLin: 0,
      trail: 0.5,
      bloom: 0.6,
      hue: this.rng() * 360,
      hueSpread: 1,
      saturation: 0.85,
      flash: 0,
      sizePulse: 0,
      sparkle: 0.3,
      // Instrument groups: per-band hit strength for the birds of the matching
      // lineage-hue quadrant (bass, low-mid, vocal/lead, treble).
      bandHit: [0, 0, 0, 0],
      palette: [
        [0.95, 0.4, 0.2],
        [0.2, 0.5, 1.0],
        [0.9, 0.9, 0.5]
      ],
      background: [0.04, 0.04, 0.06],
      label: ''
    };
    this.paletteTarget = this.visual.palette.map((c) => c.slice());
    this.nextPaletteAt = 0;

    this.camera = { distance: 500, orbit: 0.08, elevation: 0.25, kick: 0 };

    this.intensity = 0;
    this.energy = 0;
    this.musicSpeed = 1; // 0..1 how strongly musical energy scales flight speed
    this.groupGain = 1;  // 0..2 instrument-group reaction strength (GUI)
    this.pulse = { strength: 0, radius: 0, age: 0, gain: 0.5 };
    this.lastPulseAt = -10;
    this.lastKickFlash = 0;
    this.live = false; // true while audio is playing; the show only runs when live
    this.silentFor = 0; // seconds of silence inside a running track

    // Flock statistics fed back from the simulation (main.js updateCentroid).
    this.flock = { circularity: 0, axis: [0, 1, 0], polarization: 0, spread: 60, centroid: [0, 0, 0] };

    // Circularity monitor: persistent milling triggers a shear counter-field
    // and biases scene choice away from rotational archetypes for a while.
    this.spin = {
      high: 0,
      counter: 0,
      lastTriggerAt: -99,
      avoidUntil: -1,
      triggers: 0,
      normal: [0, 1, 0],
      dir: [1, 0, 0]
    };

    // Cymatics (GUI gain) and per-layer state.
    this.cymGain = 1;
    this.cym = CYM_LAYERS.map((def, i) => ({
      ...def,
      dir: new WanderDirection(0.008 + 0.006 * i, 7000 + i * 131),
      ref: new WanderDirection(0.005, 9000 + i * 97),
      ratio: new Wander(1.05, 1.6, 0.02, 11000 + i * 53),
      phase: this.rng() * TAU,
      phase2: this.rng() * TAU,
      phaseSign: this.rng() < 0.5 ? -1 : 1,
      level: 0,
      logPitch: (def.lo + def.hi) * 0.5,
      angle: 0,
      fb: 0
    }));

    this.audio = {
      bandHits: [0, 0, 0, 0],
      level: 0.3,
      loudness: 0.3,
      energy: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      kick: 0,
      snare: 0,
      hat: 0,
      beat: 0,
      beatPhase: 0,
      barPhase: 0,
      beatTick: false,
      beatIndex: 0,
      bpm: 0,
      tempoLocked: false,
      section: 'steady',
      sectionChanged: false,
      pulse: 0,
      intensity: 0.45,
      live: false,
      silence: true,
      bands: [0, 0, 0, 0],
      pitches: [0, 0, 0, 0],
      pitchClass: 0
    };

    this.startScene('rest', 0);
    this.rollPalette(true);
  }

  /* ----------------------------------------------------------------- */
  /* Scene scheduling                                                  */
  /* ----------------------------------------------------------------- */

  pickScene(bias = null) {
    const target = clamp(bias ?? this.intensity, 0, 1.3);
    const recent = this.history.slice(-3);
    const candidates = SCENES.filter((s) => !recent.includes(s.name) && s.name !== this.current?.name);
    const pool = candidates.length ? candidates : SCENES.filter((s) => s.name !== this.current?.name);
    const avoidSpin = this.time < this.spin.avoidUntil ? 1 : 0;
    const weights = pool.map((s) => {
      const mid = (s.energy[0] + s.energy[1]) * 0.5;
      const width = (s.energy[1] - s.energy[0]) * 0.5 + 0.12;
      const d = (target - mid) / width;
      const w = Math.exp(-d * d) + 0.06;
      return w * (1 - 0.85 * avoidSpin * (s.spin || 0));
    });
    let total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i].name;
    }
    return pool[pool.length - 1].name;
  }

  startScene(name, transitionDuration = 4) {
    const inst = buildScene(name, this.rng);
    inst.startedAt = this.time;
    inst.contain = this.rollContainment(name);
    if (!this.current || transitionDuration <= 0) {
      this.current = inst;
      this.next = null;
      this.blend = 0;
      this.sceneTime = 0;
      this.announce(inst);
    } else {
      this.next = inst;
      this.blend = 0;
      this.transitionDuration = Math.max(0.5, transitionDuration);
    }
    this.history.push(name);
    if (this.history.length > 8) this.history.shift();
    this.sceneDuration = this.chooseDuration();
  }

  /** Containment shape per scene instance: spheres breed mills, so they are no longer the only option. */
  rollContainment(name) {
    const rand = (a, b) => a + (b - a) * this.rng();
    if (name === 'rest') return { type: CONTAIN.SPHERE, scale: [1, 1, 1] };
    const r = this.rng();
    if (r < 0.4) return { type: CONTAIN.SPHERE, scale: [1, 1, 1] };
    if (r < 0.68) return { type: CONTAIN.ELLIPSOID, scale: [rand(0.6, 1.3), rand(0.5, 1.2), rand(0.6, 1.3)] };
    if (r < 0.86) return { type: CONTAIN.BOX, scale: [rand(0.7, 0.95), rand(0.7, 0.95), rand(0.7, 0.95)] };
    const slab = [rand(0.85, 1), rand(0.85, 1), rand(0.85, 1)];
    slab[Math.floor(this.rng() * 3)] = rand(0.22, 0.4);
    return { type: CONTAIN.BOX, scale: slab };
  }

  chooseDuration() {
    const a = this.audio;
    if (a.tempoLocked && a.bpm > 0) {
      const bars = [8, 8, 12, 16][Math.floor(this.rng() * 4)];
      return clamp((bars * 4 * 60) / a.bpm, 16, 64);
    }
    return 22 + this.rng() * 24;
  }

  announce(inst) {
    this.visual.label = inst.label;
    if (this.onSceneChange) this.onSceneChange(inst);
  }

  requestScene(name, duration = 3) {
    if (name === 'auto') {
      this.manualScene = 'auto';
      return;
    }
    this.manualScene = name;
    if (!this.live) return; // applied once audio starts
    if (this.next) {
      // finish the running transition quickly, then switch
      this.pendingSwitch = { name, duration, waitUntil: 0 };
      return;
    }
    this.startScene(name, duration);
  }

  nextScene() {
    if (!this.live) return;
    const name = this.manualScene !== 'auto' ? this.manualScene : this.pickScene();
    if (this.next) {
      this.pendingSwitch = { name, duration: 3, waitUntil: 0 };
    } else {
      this.startScene(name, 3);
    }
  }

  maybeSchedule() {
    if (!this.autopilot || this.next || !this.live) return;
    const a = this.audio;

    if (this.pendingSwitch) {
      const ps = this.pendingSwitch;
      if (this.time >= ps.waitUntil) {
        this.pendingSwitch = null;
        this.startScene(ps.name, ps.duration);
      }
      return;
    }

    if (this.manualScene !== 'auto') return;

    // Musical section changes override the timer.
    if (a.sectionChanged && this.sceneTime > 7) {
      if (a.section === 'drop') {
        this.visual.flash = Math.max(this.visual.flash, 0.9);
        this.startScene(this.pickScene(Math.max(0.8, this.intensity + 0.3)), 1.6);
        return;
      }
      if (a.section === 'breakdown' && !a.silence) {
        this.startScene(this.pickScene(Math.min(0.3, this.intensity - 0.2)), 6);
        return;
      }
    }

    if (this.sceneTime < this.sceneDuration) return;

    // Wait (up to one bar) for a bar boundary when tempo is locked.
    if (a.tempoLocked) {
      const overdue = this.sceneTime - this.sceneDuration;
      const barSeconds = (4 * 60) / Math.max(60, a.bpm);
      const onBar = a.beatTick && a.beatIndex % 4 === 0;
      if (!onBar && overdue < barSeconds * 1.05) return;
    }

    const dur = this.intensity > 0.75 ? 2.5 : this.intensity < 0.3 ? 6.5 : 4;
    this.startScene(this.pickScene(), dur);
  }

  /* ----------------------------------------------------------------- */
  /* Audio normalisation                                               */
  /* ----------------------------------------------------------------- */

  normaliseAudio(raw, dt) {
    const a = this.audio;
    if (!raw) {
      // No audio: everything flat so the flock rests in a stable state.
      a.level = 0;
      a.loudness = 0;
      a.bass = 0;
      a.mid = 0;
      a.treble = 0;
      a.kick = 0;
      a.snare = 0;
      a.hat = 0;
      a.beat = 0;
      a.beatPhase = 0;
      a.barPhase = 0;
      a.beatTick = false;
      a.beatIndex = 0;
      a.bpm = 0;
      a.tempoLocked = false;
      a.section = 'steady';
      a.sectionChanged = false;
      a.silence = true;
      a.pulse = 0;
      a.live = false;
      for (let i = 0; i < 4; i++) a.bands[i] = 0;
      for (let i = 0; i < 4; i++) a.bandHits[i] = 0;
    } else {
      a.level = clamp(raw.level, 0, 1);
      a.loudness = clamp(raw.loudness ?? raw.level, 0, 1);
      a.bass = clamp(raw.bass * 2.0, 0, 1);
      a.mid = clamp(raw.mid * 2.0, 0, 1);
      a.treble = clamp(raw.treble * 2.4, 0, 1);
      a.kick = clamp(raw.kick, 0, 1);
      a.snare = clamp(raw.snare, 0, 1);
      a.hat = clamp(raw.hat, 0, 1);
      a.beat = clamp(raw.beat, 0, 1);
      a.tempoLocked = raw.tempoConfidence > 0.3 && raw.bpm > 0;
      a.beatPhase = a.tempoLocked ? raw.beatPhase : 0;
      a.barPhase = a.tempoLocked ? raw.barPhase : (this.time * 0.25) % 1;
      a.beatTick = raw.beatTick;
      a.beatIndex = raw.beatIndex;
      a.bpm = raw.bpm;
      a.section = raw.section;
      a.sectionChanged = raw.sectionChanged;
      a.silence = raw.silence;
      a.pulse = a.tempoLocked ? Math.pow(1 - a.beatPhase, 3) : a.beat;
      a.live = true;
      const bl = raw.bandLevels;
      if (bl) {
        for (let i = 0; i < 4; i++) a.bands[i] = clamp(bl[i], 0, 1);
      } else {
        a.bands[0] = a.bass; a.bands[1] = a.mid; a.bands[2] = a.mid; a.bands[3] = a.treble;
      }
      if (raw.pitches) for (let i = 0; i < 4; i++) a.pitches[i] = raw.pitches[i];
      if (raw.bandHits) for (let i = 0; i < 4; i++) a.bandHits[i] = clamp(raw.bandHits[i], 0, 1);
      a.pitchClass = raw.pitchClass || 0;
    }
    // Silence inside a track counts as "no music" after a moment.
    this.silentFor = a.live && a.silence ? this.silentFor + dt : 0;

    const sectionBonus =
      a.section === 'drop' ? 0.25 : a.section === 'build' ? 0.1 : a.section === 'breakdown' ? -0.2 : 0;
    const target = a.live && !a.silence
      ? clamp((0.2 + 0.65 * a.level + 0.15 * a.bass + sectionBonus) * this.intensityGain, 0, 1.3)
      : 0;
    this.intensity = damp(this.intensity, target, 0.8, dt);
    a.intensity = this.intensity;

    // Musical energy drives flight speed. Loudness against the slow ceiling
    // carries most of the weight so a long relaxed passage really slows the
    // flock; attack is quick (a drop hits), release is slower (eases down).
    const eTarget = a.live && !a.silence
      ? clamp((0.05 + 0.6 * a.loudness + 0.25 * a.level + 0.1 * a.bass + 0.5 * sectionBonus) * this.intensityGain, 0, 1.3)
      : 0;
    this.energy = damp(this.energy, eTarget, eTarget > this.energy ? 2.5 : 0.6, dt);
    a.energy = this.energy;
  }

  /**
   * Flight-speed multiplier from musical energy: about 0.35x in a quiet intro,
   * 0.55x in a relaxed passage, 1x in a loud groove and up to 1.3x in a drop.
   * `musicSpeed` (GUI) fades the coupling out; 0 restores the scene's fixed speeds.
   */
  speedScale() {
    const e = clamp(this.energy, 0, 1.3);
    const curve = Math.min(1.3, 0.3 + 0.9 * Math.pow(e, 1.3));
    return lerp(1, curve, clamp(this.musicSpeed, 0, 1));
  }

  /* ----------------------------------------------------------------- */
  /* Per-frame update                                                  */
  /* ----------------------------------------------------------------- */

  update(dt, rawAudio) {
    dt = clamp(dt, 0, 0.1);
    this.time += dt;
    this.sceneTime += dt;
    this.normaliseAudio(rawAudio, dt);
    const a = this.audio;

    this.updateLiveState();
    this.updateSpinMonitor(dt);
    this.maybeSchedule();

    // --- evaluate scenes ------------------------------------------------
    const cur = this.current;
    this.evaluate(cur, this.fieldA, this.paramsA);

    let x = 0;
    if (this.next) {
      this.blend = clamp(this.blend + dt / this.transitionDuration, 0, 1);
      x = smoothstep(0, 1, this.blend);
      this.evaluate(this.next, this.fieldB, this.paramsB);
      if (this.blend >= 1) {
        this.current = this.next;
        this.next = null;
        this.sceneTime = 0;
        this.blend = 0;
        this.announce(this.current);
        this.sceneDuration = this.chooseDuration();
      }
    }

    this.blendFields(this.fieldA, this.fieldB, x, this.field);
    for (const k of PARAM_KEYS) {
      this.params[k] = x > 0 ? lerp(this.paramsA[k], this.paramsB[k], x) : this.paramsA[k];
    }

    // --- global rhythmic layers ----------------------------------------
    this.applyGlobalLayers(dt, x);
    this.updateVisual(dt, x);
    this.updateCamera(dt, x);

    return this;
  }

  /** Enter the show when sound arrives, drift when it stops (track removed or silence). */
  updateLiveState() {
    const live = this.audio.live && this.silentFor < 1.5;
    if (live === this.live) return;
    this.live = live;
    this.pendingSwitch = null;
    if (live) {
      const name = this.manualScene !== 'auto' ? this.manualScene : this.pickScene(0.5);
      this.startScene(name, 4);
    } else {
      this.startScene('rest', this.audio.live ? 2.2 : 4);
    }
  }

  /** Called by the simulation loop with sampled flock statistics. */
  setFlockStats(st) {
    const fl = this.flock;
    fl.circularity = lerp(fl.circularity, st.circularity, 0.25);
    fl.polarization = lerp(fl.polarization, st.polarization, 0.25);
    fl.spread = lerp(fl.spread, st.spread, 0.25);
    for (let i = 0; i < 3; i++) {
      fl.axis[i] = lerp(fl.axis[i], st.axis[i], 0.25);
      fl.centroid[i] = lerp(fl.centroid[i], st.centroid[i], 0.25);
    }
  }

  /**
   * Circularity monitor. Normalised angular momentum about the centroid
   * near 1 means the flock is milling. If that persists for a few bars, a
   * shear counter-field tears the mill apart, the vortex is muted, and
   * rotational archetypes are avoided for the next scene choices.
   */
  updateSpinMonitor(dt) {
    const sp = this.spin;
    if (!this.live) {
      sp.high = 0;
      sp.counter *= Math.exp(-dt / 2);
      return;
    }
    if (this.flock.circularity > 0.55) sp.high += dt;
    else sp.high = Math.max(0, sp.high - 2 * dt);

    if (sp.high > 6 && this.time - sp.lastTriggerAt > 20) {
      sp.counter = 1;
      sp.lastTriggerAt = this.time;
      sp.high = 0;
      sp.avoidUntil = this.time + 75;
      sp.triggers++;
      // A rotational archetype that keeps milling gets cut short in auto mode.
      if (this.autopilot && this.manualScene === 'auto' && (this.current.spin || 0) >= 0.6) {
        this.sceneDuration = Math.min(this.sceneDuration, this.sceneTime + 5);
      }
      const n = this.flock.axis;
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      sp.normal = [n[0] / nl, n[1] / nl, n[2] / nl];
      const ref = Math.abs(sp.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const d = [
        ref[1] * sp.normal[2] - ref[2] * sp.normal[1],
        ref[2] * sp.normal[0] - ref[0] * sp.normal[2],
        ref[0] * sp.normal[1] - ref[1] * sp.normal[0]
      ];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      sp.dir = [d[0] / dl, d[1] / dl, d[2] / dl];
    }
    sp.counter *= Math.exp(-dt / 7);
  }

  evaluate(inst, field, params) {
    field.fill(0);
    field[F.VORTEX_AXIS + 1] = 1;
    field[F.SHAPE_AXIS + 1] = 1;
    field[F.CONTAIN_RADIUS] = 130;
    field[F.CONTAIN_STRENGTH] = 0.004;
    field[F.CONTAIN_SCALE] = 1;
    field[F.CONTAIN_SCALE + 1] = 1;
    field[F.CONTAIN_SCALE + 2] = 1;
    field[F.TRAIT_SPREAD] = 0.6;
    for (const k of PARAM_KEYS) params[k] = inst.params[k];
    const t = this.time - inst.startedAt;
    inst.update(t, this.audio, field, params);
    if (inst.contain) {
      field[F.CONTAIN_TYPE] = inst.contain.type;
      field[F.CONTAIN_SCALE] = inst.contain.scale[0];
      field[F.CONTAIN_SCALE + 1] = inst.contain.scale[1];
      field[F.CONTAIN_SCALE + 2] = inst.contain.scale[2];
    }

    // Audio modulation shared by every scene.
    const a = this.audio;
    const sp = this.speedScale();
    params.minSpeed *= sp;
    params.maxSpeed *= sp;
    params.maxSpeed += (0.6 * a.level + 1.6 * a.kick + 0.4 * a.intensity) * sp;
    params.minSpeed += 0.4 * a.level * sp;
    params.matchingFactor += 0.03 * a.mid;
    params.avoidFactor += 0.03 * a.treble;
    params.centeringFactor *= 1 + 0.5 * a.bass;
    params.particleSize += 0.8 * a.level;
    params.maxSpeed = Math.max(params.maxSpeed, params.minSpeed + 0.6);
  }

  blendFields(A, B, x, out) {
    if (x <= 0) {
      out.set(A);
      return;
    }
    for (let i = 0; i < FIELD_SIZE; i++) out[i] = lerp(A[i], B[i], x);

    // discrete containment type: switch at the midpoint (scales already lerp)
    out[F.CONTAIN_TYPE] = x < 0.5 ? A[F.CONTAIN_TYPE] : B[F.CONTAIN_TYPE];

    // discrete shape type: dissolve one, grow the other
    const ta = A[F.SHAPE_TYPE] | 0;
    const tb = B[F.SHAPE_TYPE] | 0;
    if (ta !== tb) {
      if (x < 0.5) {
        out[F.SHAPE_TYPE] = ta;
        out[F.SHAPE_STRENGTH] = A[F.SHAPE_STRENGTH] * (1 - x * 2);
        for (let i = F.SHAPE_R1; i <= F.SHAPE_CENTER + 2; i++) out[i] = A[i];
      } else {
        out[F.SHAPE_TYPE] = tb;
        out[F.SHAPE_STRENGTH] = B[F.SHAPE_STRENGTH] * (x * 2 - 1);
        for (let i = F.SHAPE_R1; i <= F.SHAPE_CENTER + 2; i++) out[i] = B[i];
      }
    }

    // agents: union of both sets with faded strengths, strongest three win
    const agents = [];
    const ca = A[F.AGENT_COUNT] | 0;
    const cb = B[F.AGENT_COUNT] | 0;
    for (let i = 0; i < ca; i++) {
      const b = F.AGENT_BASE + i * F.AGENT_STRIDE;
      agents.push([A[b], A[b + 1], A[b + 2], A[b + 3] * (1 - x), A[b + 4]]);
    }
    for (let i = 0; i < cb; i++) {
      const b = F.AGENT_BASE + i * F.AGENT_STRIDE;
      agents.push([B[b], B[b + 1], B[b + 2], B[b + 3] * x, B[b + 4]]);
    }
    agents.sort((p, q) => Math.abs(q[3]) - Math.abs(p[3]));
    const n = Math.min(F.MAX_AGENTS, agents.length);
    out[F.AGENT_COUNT] = n;
    for (let i = 0; i < n; i++) {
      const b = F.AGENT_BASE + i * F.AGENT_STRIDE;
      out[b] = agents[i][0];
      out[b + 1] = agents[i][1];
      out[b + 2] = agents[i][2];
      out[b + 3] = agents[i][3];
      out[b + 4] = agents[i][4];
    }
  }

  applyGlobalLayers(dt, x) {
    const a = this.audio;
    const f = this.field;
    const curGain = this.current.pulseGain ?? 0.5;
    const nextGain = this.next ? this.next.pulseGain ?? 0.5 : curGain;
    const gain = lerp(curGain, nextGain, x);

    // Shockwave on strong kicks (rate-limited so fast music doesn't smear).
    if (a.kick > 0.72 && this.time - this.lastPulseAt > 0.22 && gain > 0) {
      this.lastPulseAt = this.time;
      this.pulse.strength = (1.2 + 1.6 * a.kick) * gain * (0.6 + 0.6 * a.intensity);
      this.pulse.radius = 10;
      this.pulse.age = 0;
    }
    if (this.pulse.strength > 0.01) {
      this.pulse.age += dt;
      this.pulse.radius += dt * 320;
      this.pulse.strength *= Math.exp(-dt * 4.5);
      f[F.PULSE_STRENGTH] = this.pulse.strength;
      f[F.PULSE_RADIUS] = this.pulse.radius;
      f[F.PULSE_WIDTH] = 22 + this.pulse.age * 40;
      f[F.PULSE_CENTER] = 0;
      f[F.PULSE_CENTER + 1] = 0;
      f[F.PULSE_CENTER + 2] = 0;
    } else {
      f[F.PULSE_STRENGTH] = 0;
    }

    // Nervous shimmer on hi-hats and in transitions.
    f[F.JITTER] += 0.09 * a.hat * a.intensity + 0.12 * Math.sin(Math.PI * x) * (this.next ? 1 : 0);
    f[F.TRAIT_SPREAD] = 0.5 + 0.3 * a.intensity;

    this.updateCymatics(dt, x);
    this.applyShear();
    this.applyEvolution(dt);
  }

  /**
   * Layered cymatics: one standing-wave field per band, wavelength from the
   * band's pitch, orientation wandering slowly and rotated by the vocal
   * pitch class, phase sliding with the tempo, and a feedback term that
   * keeps a node near the flock's own centre so the pattern follows the birds.
   */
  updateCymatics(dt, x) {
    const a = this.audio;
    const f = this.field;
    const curG = this.current.cymGain ?? 1;
    const nxtG = this.next ? this.next.cymGain ?? 1 : curG;
    const gain = lerp(curG, nxtG, x) * this.cymGain * (this.live ? 1 : 0);
    const beatRate = a.tempoLocked && a.bpm > 0 ? (a.bpm / 60) * (TAU / 32) : 0.12;
    const c = this.flock.centroid;
    const spreadMul = clamp(this.flock.spread / 70, 0.85, 1.15);

    let n = 0;
    for (let i = 0; i < this.cym.length; i++) {
      const L = this.cym[i];
      const lvl = clamp(a.bands[i] || 0, 0, 1) * (this.live ? 1 : 0);
      L.level = damp(L.level, lvl, lvl > L.level ? 4 : 1.5, dt);
      const hz = a.pitches[i];
      if (hz > 0) L.logPitch = damp(L.logPitch, Math.log2(hz), 1.2, dt);
      const u = clamp((L.logPitch - L.lo) / (L.hi - L.lo), 0, 1);
      const lambda = lerp(L.lamMax, L.lamMin, u) * spreadMul;
      const k = TAU / lambda;

      const dir = L.dir.at(this.time);
      const ref = L.ref.at(this.time);
      let px = ref[1] * dir[2] - ref[2] * dir[1];
      let py = ref[2] * dir[0] - ref[0] * dir[2];
      let pz = ref[0] * dir[1] - ref[1] * dir[0];
      const pl = Math.hypot(px, py, pz) || 1;
      px /= pl; py /= pl; pz /= pl;
      const qx = dir[1] * pz - dir[2] * py;
      const qy = dir[2] * px - dir[0] * pz;
      const qz = dir[0] * py - dir[1] * px;
      // a chord change rotates the second wave vector around the first
      L.angle = damp(L.angle, (a.pitchClass / 12) * TAU, 0.8, dt);
      const ca = Math.cos(L.angle), sa = Math.sin(L.angle);
      const k2 = k / L.ratio.at(this.time);
      const k2x = (px * ca + qx * sa) * k2;
      const k2y = (py * ca + qy * sa) * k2;
      const k2z = (pz * ca + qz * sa) * k2;

      L.phase += dt * beatRate * (1 + 0.5 * a.intensity) * L.phaseSign;
      L.phase2 += dt * beatRate * 0.37 * L.phaseSign;
      // feedback: choose the phase offset that puts a node through the centroid
      const want = -(c[0] * dir[0] + c[1] * dir[1] + c[2] * dir[2]) * k + Math.PI / 2 - L.phase;
      L.fb = damp(L.fb, want, 0.3, dt);

      const b = F.CYM_BASE + n * F.CYM_STRIDE;
      const strength =
        gain * L.level * L.gain * (0.03 + 0.09 * a.intensity) + (i === 0 ? 0.02 * a.kick * gain : 0);
      f[b] = strength;
      f[b + 1] = dir[0] * k;
      f[b + 2] = dir[1] * k;
      f[b + 3] = dir[2] * k;
      f[b + 4] = k2x;
      f[b + 5] = k2y;
      f[b + 6] = k2z;
      f[b + 7] = L.phase + L.fb;
      f[b + 8] = L.phase2;
      f[b + 9] = L.mode;
      f[b + 10] = L.band;
      n++;
    }
    f[F.CYM_COUNT] = n;
    f[F.CYM_AFFINITY] = this.evo.enabled && gain > 0 ? 0.6 * (0.4 + 0.6 * a.intensity) : 0;
  }

  /** Shear counter-field while a spin break is active; also mutes the vortex and loosens containment. */
  applyShear() {
    const f = this.field;
    const sp = this.spin;
    const c = sp.counter;
    if (c < 0.02) {
      f[F.SHEAR_STRENGTH] = 0;
      return;
    }
    const a = this.audio;
    f[F.SHEAR_STRENGTH] = 0.035 * c * (0.6 + 0.6 * a.intensity);
    for (let i = 0; i < 3; i++) {
      f[F.SHEAR_NORMAL + i] = sp.normal[i];
      f[F.SHEAR_DIR + i] = sp.dir[i];
    }
    f[F.VORTEX_STRENGTH] *= 1 - 0.85 * c;
    f[F.CONTAIN_STRENGTH] *= 1 - 0.5 * c;
  }

  /** Music is the evolutionary pressure: kicks mutate, drops cause extinctions, breakdowns recover. */
  applyEvolution(dt) {
    const a = this.audio;
    const f = this.field;
    const e = this.evo;

    // Kinship / xeno-repulsion shape the sub-flock structure even at rest.
    f[F.EVO_KINSHIP] = e.enabled ? e.kinship : 0;
    f[F.EVO_XENO] = e.enabled ? e.xeno * (0.6 + 0.8 * a.intensity) : 0;

    const active = e.enabled && this.live && !a.silence;
    f[F.EVO_ENABLED] = active ? 1 : 0;
    if (!active) {
      f[F.EVO_EXTINCTION] = 0;
      return;
    }

    const breakdown = a.section === 'breakdown';
    f[F.EVO_MUTATION] = e.mutation * (0.6 + 1.2 * a.intensity) + 0.01 * a.kick + (breakdown ? 0.006 : 0);
    f[F.EVO_CHURN] = 0.03;
    f[F.EVO_GAIN] = 0.006 * (breakdown ? 1.4 : 1) * (0.8 + 0.4 * a.level);
    f[F.EVO_LOSS] = 0.003 * (1 + 0.2 * a.kick);
    f[F.EVO_DEATH] = 0.1;
    // Expected neighbour count grows with the cube of the visual range.
    const vrScale = Math.pow(Math.max(8, this.params.visualRange || 16) / 16, 3);
    f[F.EVO_CROWD] = (36 + 24 * (1 - a.intensity)) * vrScale;
    f[F.EVO_SENESCENCE] = 0.0008 + 0.001 * a.intensity;

    // Mass extinction of the dominant lineage on drops, or every ~90 s if none came.
    if ((a.sectionChanged && a.section === 'drop') || this.time - e.lastExtinctionAt > 90) {
      if (this.time - e.lastExtinctionAt > 12) {
        e.extinctionPulse = a.section === 'drop' ? 1 : 0.45;
        e.lastExtinctionAt = this.time;
        this.visual.flash = Math.max(this.visual.flash, 0.5 * e.extinctionPulse);
      }
    }
    e.extinctionPulse *= Math.exp(-dt / 2.5);
    f[F.EVO_EXTINCTION] = e.extinctionPulse > 0.02 ? e.extinctionPulse : 0;
  }

  triggerExtinction(strength = 1) {
    this.evo.extinctionPulse = strength;
    this.evo.lastExtinctionAt = this.time;
    this.visual.flash = Math.max(this.visual.flash, 0.5);
  }

  rollPalette(immediate = false) {
    const h = this.rng() * 360;
    const scheme = this.rng();
    const hues = scheme < 0.4
      ? [h, h + 30, h + 180]           // split complementary
      : scheme < 0.7
        ? [h, h + 120, h + 240]        // triad
        : [h, h + 40, h + 80];         // analogous
    this.paletteTarget = hues.map((hh, i) => hslToRgb(((hh % 360) + 360) % 360, 0.85, i === 2 ? 0.7 : 0.55));
    if (immediate) this.visual.palette = this.paletteTarget.map((c) => c.slice());
    this.nextPaletteAt = this.time + 25 + this.rng() * 40;
  }

  updateVisual(dt, x) {
    const a = this.audio;
    const v = this.visual;
    const cur = this.current.visual;
    const nxt = this.next ? this.next.visual : cur;

    const mode = [0, 1, 2].map((i) => lerp(cur.mode[i], nxt.mode[i], x));
    // Lineage colour takes a share of the mix so ancestry stays readable.
    const lin = this.evo.enabled ? this.evo.lineageColor : 0;
    v.modePos = damp(v.modePos, mode[0] * (1 - lin), 1.5, dt);
    v.modeVel = damp(v.modeVel, mode[1] * (1 - lin), 1.5, dt);
    v.modePal = damp(v.modePal, mode[2] * (1 - lin), 1.5, dt);
    v.modeLin = damp(v.modeLin, lin, 1.5, dt);

    const trail = lerp(cur.trail, nxt.trail, x);
    const bloom = lerp(cur.bloom, nxt.bloom, x);
    v.trail = damp(v.trail, clamp(trail + 0.15 * (1 - a.intensity) - 0.1 * a.kick, 0, 1), 2, dt);
    v.bloom = damp(v.bloom, clamp(bloom + 0.3 * a.level + 0.25 * a.kick, 0, 1.4), 6, dt);

    const hueRate = lerp(cur.hueRate, nxt.hueRate, x) + 6 * a.level + 40 * Math.sin(Math.PI * x);
    v.hue = (v.hue + hueRate * dt) % 360;
    v.hueSpread = damp(v.hueSpread, 0.6 + 0.6 * fbm1(this.time * 0.03, 31) * 0.5 + 0.5 * a.mid, 0.6, dt);
    v.saturation = damp(v.saturation, clamp(0.7 + 0.25 * a.level + 0.1 * fbm1(this.time * 0.05, 41), 0.5, 1), 1, dt);

    v.flash = Math.max(v.flash * Math.exp(-dt * 7), a.kick > 0.6 ? a.kick * 0.22 * a.intensity : 0);
    // Global swell stays on the kick and beat; the snare now belongs to its group.
    v.sizePulse = damp(v.sizePulse, 0.55 * a.kick + 0.3 * a.pulse * a.intensity + 0.2 * a.snare * (1 - clamp(this.groupGain, 0, 1)), 14, dt);
    const g = this.live ? this.groupGain * (0.75 + 0.35 * a.intensity) : 0;
    for (let i = 0; i < 4; i++) v.bandHit[i] = a.bandHits[i] * g;
    v.sparkle = lerp(cur.sparkle, nxt.sparkle, x) * (0.4 + 0.6 * a.hat + 0.3 * a.treble);

    if (this.time > this.nextPaletteAt) this.rollPalette();
    for (let i = 0; i < 3; i++) {
      for (let c = 0; c < 3; c++) {
        v.palette[i][c] = damp(v.palette[i][c], this.paletteTarget[i][c], 0.4, dt);
      }
    }

    // Background tint follows the palette's deepest colour, kept very dark.
    const bgHue = (v.hue + 200) % 360;
    const bg = hslToRgb(bgHue, 0.6, 0.004 + 0.006 * a.level); // linear-space, stays near black
    for (let c = 0; c < 3; c++) v.background[c] = damp(v.background[c], bg[c], 0.8, dt);
  }

  updateCamera(dt, x) {
    const a = this.audio;
    const cur = this.current.camera;
    const nxt = this.next ? this.next.camera : cur;
    const cam = this.camera;
    // Preferred distance only: the camera director never lets it cut into the
    // distance needed to keep the whole flock in frame.
    const dist = lerp(cur.distance, nxt.distance, x) * 1.2;
    cam.distance = damp(cam.distance, dist * (1.05 - 0.15 * a.intensity) + 40 * fbm1(this.time * 0.02, 51), 0.5, dt);
    cam.orbit = damp(cam.orbit, lerp(cur.orbit, nxt.orbit, x) * (0.7 + 0.8 * a.intensity), 0.6, dt);
    cam.elevation = damp(cam.elevation, lerp(cur.elevation, nxt.elevation, x), 0.4, dt);
    cam.kick = Math.max(cam.kick * Math.exp(-dt * 8), a.kick > 0.7 ? a.kick : 0);
  }

  get sceneNames() {
    return SCENE_NAMES;
  }

  get sceneLabel() {
    return this.visual.label;
  }
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h / 60) % 6;
  const xx = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, xx, 0];
  else if (hp < 2) [r, g, b] = [xx, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, xx];
  else if (hp < 4) [r, g, b] = [0, xx, c];
  else if (hp < 5) [r, g, b] = [xx, 0, c];
  else [r, g, b] = [c, 0, xx];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}
