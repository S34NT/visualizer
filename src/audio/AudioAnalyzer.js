/**
 * Audio analysis for the visualizer.
 *
 * Beyond the basic band energies this analyser now provides:
 *  - adaptive gain so quiet and loud tracks drive the visuals similarly
 *  - spectral-flux onset detection per band (kick / snare-ish / hats)
 *  - tempo estimation (autocorrelation of the onset envelope) with a
 *    phase-locked beat clock, so visuals can anticipate beats, not just react
 *  - section detection (drop / breakdown) from short vs long term energy
 */
function rms0(timeData) {
  let s = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    s += v * v;
  }
  return Math.sqrt(s / timeData.length);
}

export class AudioAnalyzer {
  constructor(options = {}) {
    this.fftSize = options.fftSize || 2048;
    // Per-band adaptive ceilings and peak-frequency trackers for the cymatic layers.
    this.bandDefs = [[30, 200], [150, 800], [500, 3000], [2500, 9000]];
    this.bandCeil = [0.05, 0.05, 0.05, 0.05];
    // Per-band onset detection for the instrument groups: positive spectral
    // flux inside each band against its own adaptive ceiling and running mean.
    this.bandFluxCeil = [0.02, 0.02, 0.02, 0.02];
    this.bandFluxMean = [0, 0, 0, 0];
    this.bandFluxPrev = [0, 0, 0, 0];
    this.bandLastHit = [0, 0, 0, 0];
    // Shortest gap between hits (ms) and envelope decay (1/s) per band:
    // bass swells, low-mid / vocal punch, treble flickers.
    this.bandCooldown = [140, 110, 120, 70];
    this.bandDecay = [5, 8, 6, 12];
    // Kick leakage: a kick's broadband transient shows up in every band. Each
    // upper band learns how much flux it usually sees on a bass hit, and on a
    // coincident frame only fires when it clearly exceeds that (a snare on the
    // same beat does; the kick's own click does not).
    this.bandExclusive = options.bandExclusive ?? true;
    this.bandLeak = [0, 0.6, 0.6, 0.6];
    this.bandNorm = [0, 0, 0, 0];
    // New-note detection on the vocal/lead band: the peak's semitone must
    // hold for a few frames and differ from the last held note.
    this.noteRaw = -1;
    this.noteHold = 0;
    this.noteStable = -1;
    this.noteLastAt = 0;
    this.leadPeakHz = 0;
    this.bandCand = [false, false, false, false];
    this.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.6;
    this.minDecibels = options.minDecibels ?? -90;
    this.maxDecibels = options.maxDecibels ?? -10;
    this.emaAlpha = options.emaAlpha ?? 0.25;
    this.monitorGain = options.monitorGain ?? 1.0;

    this.audioContext = null;
    this.sourceNode = null;
    this.analyser = null;
    this.gainNode = null;
    this.mediaStream = null;
    this.mediaElement = null;
    this.objectUrl = null;

    this.freqData = null;
    this.prevFreq = null;
    this.timeData = null;

    this.isInitialized = false;
    this.isRunning = false;

    this.features = {
      rms: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      beat: 0,        // decaying envelope from detected onsets (0..1)
      peak: 0,
      // --- new ---
      level: 0,       // auto-gained loudness 0..1 (fast ceiling: relative to the last ~10 s)
      loudness: 0,    // loudness against a slow ceiling (~1 min): low in relaxed passages
      flux: 0,        // overall spectral flux (smoothed)
      kick: 0,        // bass onset envelope
      snare: 0,       // mid onset envelope
      hat: 0,         // treble onset envelope
      onset: false,   // true on the frame an onset was detected
      onsetStrength: 0,
      bpm: 0,
      tempoConfidence: 0,
      beatPhase: 0,   // 0..1 within the predicted beat
      beatTick: false,// true on the frame the predicted beat clock wraps
      beatIndex: 0,   // running count of predicted beats
      barPhase: 0,    // 0..1 within a 4-beat bar
      energyTrend: 0, // -1..1  (short-term vs long-term energy)
      section: 'steady', // 'drop' | 'build' | 'breakdown' | 'steady'
      sectionChanged: false,
      silence: true,
      // cymatics: normalised level and dominant frequency per band (bass, low-mid, vocal, treble)
      bandLevels: [0, 0, 0, 0],
      bandHits: [0, 0, 0, 0],      // per-band onset envelopes 0..1 (instrument groups)
      bandOnsets: [false, false, false, false], // true on the frame a band hit fires
      bandHitCount: [0, 0, 0, 0],  // running count of hits per band
      pitches: [0, 0, 0, 0],
      pitchClass: 0
    };

    this.prevEnergy = 0;
    this.lastBeatTime = 0;
    this.cooldownMs = options.cooldownMs ?? 110;

    // adaptive gain
    this.levelCeiling = 0.15;
    this.loudCeiling = 0.08;
    this.fluxCeiling = 0.05;

    // onset envelope history resampled on a fixed grid for tempo estimation
    this.gridHz = 50;
    this.gridSeconds = 10;
    this.grid = new Float32Array(this.gridHz * this.gridSeconds);
    this.gridWrite = 0;
    this.gridAccum = 0;
    this.gridAccumCount = 0;
    this.gridLastSlot = -1;
    this.gridStartTime = 0;
    this.lastTempoEstimateAt = 0;

    // tempo state
    this.bpm = 0;
    this.beatPeriod = 0;
    this.beatAnchor = 0;    // ms timestamp of a beat
    this.tempoConfidence = 0;
    this.beatIndex = 0;
    this.lastBeatPhase = 0;
    this.onsetTimes = [];

    // section detection
    this.shortEnergy = 0;
    this.longEnergy = 0;
    this.section = 'steady';
    this.sectionSince = 0;
    this.lastTime = 0;
  }

  async startFromFile(file, options = {}) {
    if (!file) {
      throw new Error('No audio file selected.');
    }

    await this.ensureAudioContext();

    this.stop();

    this.objectUrl = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.src = this.objectUrl;
    audio.crossOrigin = 'anonymous';
    const { loop = true, onEnded } = options;
    audio.loop = loop;
    audio.preload = 'auto';

    this.sourceNode = this.audioContext.createMediaElementSource(audio);
    this.mediaElement = audio;

    if (!loop && typeof onEnded === 'function') {
      audio.addEventListener('ended', () => {
        this.stop();
        onEnded();
      }, { once: true });
    }
    this.connectGraph();

    try {
      await audio.play();
    } catch (error) {
      this.stop();
      throw new Error('Audio file could not be played. On iPhone, try selecting the file again after interacting with the page.');
    }

    this.isInitialized = true;
    this.isRunning = true;
    this.resetTracking();
    return true;
  }

  async startFromYouTube(youtubeUrl) {
    if (this.isRunning) return true;

    await this.ensureAudioContext();

    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('This browser does not support tab audio capture (getDisplayMedia). Try Chrome on Android with tab audio sharing enabled.');
    }

    if (youtubeUrl) {
      window.open(youtubeUrl, '_blank', 'noopener,noreferrer');
    }

    this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 10, max: 15 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      preferCurrentTab: true
    });

    const hasAudioTrack = this.mediaStream.getAudioTracks().length > 0;
    if (!hasAudioTrack) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
      throw new Error('No audio track found. Share a browser tab and enable "Share tab audio".');
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.connectGraph();

    this.isInitialized = true;
    this.isRunning = true;
    this.resetTracking();
    return true;
  }

  // Backwards-compatible alias kept so stale bundles or older call sites do not break.
  async startFromMic(youtubeUrl) {
    return this.startFromYouTube(youtubeUrl);
  }

  async ensureAudioContext() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        throw new Error('Web Audio API is not supported in this browser.');
      }

      this.audioContext = new AudioCtx();
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  connectGraph() {
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = this.smoothingTimeConstant;
    this.analyser.minDecibels = this.minDecibels;
    this.analyser.maxDecibels = this.maxDecibels;

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 1.0;

    this.sourceNode.connect(this.analyser);
    this.analyser.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);
    this.gainNode.gain.value = this.monitorGain;

    const binCount = this.analyser.frequencyBinCount;
    this.freqData = new Uint8Array(binCount);
    this.prevFreq = new Float32Array(binCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
  }

  resetTracking() {
    this.grid.fill(0);
    this.gridWrite = 0;
    this.gridAccum = 0;
    this.gridAccumCount = 0;
    this.gridLastSlot = -1;
    this.gridStartTime = performance.now();
    this.lastTempoEstimateAt = 0;
    this.bpm = 0;
    this.beatPeriod = 0;
    this.beatAnchor = 0;
    this.tempoConfidence = 0;
    this.beatIndex = 0;
    this.onsetTimes.length = 0;
    this.shortEnergy = 0;
    this.longEnergy = 0;
    this.section = 'steady';
    this.sectionSince = performance.now();
    this.levelCeiling = 0.15;
    this.loudCeiling = 0.08;
    this.fluxCeiling = 0.05;
    this.lastTime = 0;
    for (let b = 0; b < 4; b++) {
      this.bandFluxCeil[b] = 0.02;
      this.bandFluxMean[b] = 0;
      this.bandFluxPrev[b] = 0;
      this.bandLastHit[b] = 0;
      this.bandLeak[b] = b ? 0.6 : 0;
      this.features.bandHits[b] = 0;
      this.features.bandOnsets[b] = false;
    }
  }

  getFeatures() {
    const f = this.features;
    f.onset = false;
    f.beatTick = false;
    f.sectionChanged = false;

    if (!this.isRunning || !this.analyser) {
      return f;
    }

    const now = performance.now();
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;

    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.timeData);

    const sampleRate = this.audioContext.sampleRate;

    const bass = this.bandEnergy(20, 140, sampleRate);
    const mid = this.bandEnergy(140, 2000, sampleRate);
    const treble = this.bandEnergy(2000, 12000, sampleRate);
    this.updateBands(sampleRate, dt);
    this.updateBandHits(sampleRate, dt, now, rms0(this.timeData) < 0.012);

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const normalized = (this.timeData[i] - 128) / 128;
      const abs = Math.abs(normalized);
      if (abs > peak) peak = abs;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / this.timeData.length);

    // ---- spectral flux per band -------------------------------------
    const nyquist = sampleRate * 0.5;
    const bins = this.freqData.length;
    const binOf = (hz) => Math.min(bins - 1, Math.max(0, Math.round((hz / nyquist) * bins)));
    const bBass = [binOf(20), binOf(160)];
    const bMid = [binOf(160), binOf(2500)];
    const bHat = [binOf(4000), binOf(14000)];

    let fluxBass = 0;
    let fluxMid = 0;
    let fluxHat = 0;
    let fluxAll = 0;
    for (let i = 0; i < bins; i++) {
      const v = this.freqData[i] / 255;
      const d = v - this.prevFreq[i];
      this.prevFreq[i] = v;
      if (d <= 0) continue;
      fluxAll += d;
      if (i >= bBass[0] && i < bBass[1]) fluxBass += d;
      else if (i >= bMid[0] && i < bMid[1]) fluxMid += d;
      else if (i >= bHat[0] && i < bHat[1]) fluxHat += d;
    }
    fluxAll /= bins;
    fluxBass /= Math.max(1, bBass[1] - bBass[0]);
    fluxMid /= Math.max(1, bMid[1] - bMid[0]);
    fluxHat /= Math.max(1, bHat[1] - bHat[0]);

    // ---- adaptive gain ---------------------------------------------
    this.levelCeiling = Math.max(rms, this.levelCeiling * (1 - 0.08 * dt), 0.02);
    // The slow ceiling forgets a loud section over about a minute, so a long
    // relaxed passage keeps reading as quiet instead of re-normalising to 1.
    this.loudCeiling = Math.max(rms, this.loudCeiling * (1 - 0.012 * dt), 0.02);
    this.fluxCeiling = Math.max(fluxAll, this.fluxCeiling * (1 - 0.15 * dt), 0.004);
    const level = Math.min(1, rms / this.levelCeiling);
    const loudness = Math.min(1, rms / this.loudCeiling);
    const fluxNorm = Math.min(1.5, fluxAll / this.fluxCeiling);

    // ---- onset detection (legacy energy-delta OR flux spike) ---------
    const energy = bass * 0.6 + mid * 0.3 + treble * 0.1;
    const delta = energy - this.prevEnergy;
    this.prevEnergy = this.lerp(this.prevEnergy, energy, 0.4);

    const fluxThreshold = 0.55 + 0.25 * this.tempoConfidence;
    const spike = fluxNorm > fluxThreshold || delta > 0.1;
    const silence = rms < 0.012;
    const onset = !silence && spike && (now - this.lastBeatTime) > this.cooldownMs;
    if (onset) {
      this.lastBeatTime = now;
      this.onsetTimes.push(now);
      if (this.onsetTimes.length > 64) this.onsetTimes.shift();
    }

    // onset envelope onto a fixed grid for tempo estimation
    this.pushGrid(now, fluxNorm * (silence ? 0 : 1));
    if (now - this.lastTempoEstimateAt > 1500) {
      this.estimateTempo(now);
      this.lastTempoEstimateAt = now;
    }
    this.updateBeatClock(now, onset, fluxNorm);

    // ---- section detection -----------------------------------------
    const e = level * 0.7 + Math.min(1, bass * 2) * 0.3;
    this.shortEnergy = this.lerp(this.shortEnergy, e, 1 - Math.exp(-dt / 0.6));
    this.longEnergy = this.lerp(this.longEnergy, e, 1 - Math.exp(-dt / 9));
    const trend = Math.max(-1, Math.min(1, (this.shortEnergy - this.longEnergy) * 3.2));
    let section = this.section;
    const sinceSection = now - this.sectionSince;
    if (silence) {
      section = 'breakdown';
    } else if (trend > 0.42 && sinceSection > 4000) {
      section = 'drop';
    } else if (trend < -0.38 && sinceSection > 4000) {
      section = 'breakdown';
    } else if (trend > 0.18 && this.section !== 'drop') {
      section = 'build';
    } else if (Math.abs(trend) < 0.12 && sinceSection > 6000) {
      section = 'steady';
    }
    if (section !== this.section) {
      this.section = section;
      this.sectionSince = now;
      f.sectionChanged = true;
    }

    // ---- smoothed outputs ------------------------------------------
    const a = this.emaAlpha;
    f.rms = this.lerp(f.rms, rms, a);
    f.bass = this.lerp(f.bass, bass, a);
    f.mid = this.lerp(f.mid, mid, a);
    f.treble = this.lerp(f.treble, treble, a);
    f.peak = this.lerp(f.peak, peak, a);
    f.level = this.lerp(f.level, level, 0.3);
    f.loudness = this.lerp(f.loudness, loudness, 1 - Math.exp(-dt / 0.25));
    f.flux = this.lerp(f.flux, Math.min(1, fluxNorm), 0.35);

    const decay = Math.exp(-dt * 7);
    const kickHit = Math.min(1, fluxBass / (this.fluxCeiling * 1.6));
    const snareHit = Math.min(1, fluxMid / (this.fluxCeiling * 1.2));
    const hatHit = Math.min(1, fluxHat / (this.fluxCeiling * 1.0));
    f.kick = Math.max(f.kick * decay, kickHit > 0.5 ? kickHit : 0);
    f.snare = Math.max(f.snare * decay, snareHit > 0.5 ? snareHit : 0);
    f.hat = Math.max(f.hat * decay, hatHit > 0.45 ? hatHit : 0);
    f.beat = Math.max(f.beat * Math.exp(-dt * 6), onset ? Math.min(1, fluxNorm) : 0);
    f.onset = onset;
    f.onsetStrength = onset ? Math.min(1, fluxNorm) : 0;
    f.bpm = this.bpm;
    f.tempoConfidence = this.tempoConfidence;
    f.beatIndex = this.beatIndex;
    f.energyTrend = trend;
    f.section = this.section;
    f.silence = silence;

    return f;
  }

  pushGrid(now, value) {
    const slot = Math.floor(((now - this.gridStartTime) / 1000) * this.gridHz);
    if (slot === this.gridLastSlot) {
      this.gridAccum = Math.max(this.gridAccum, value);
      return;
    }
    if (this.gridLastSlot >= 0) {
      // commit previous slot, fill any skipped slots with zeros
      this.grid[this.gridWrite] = this.gridAccum;
      this.gridWrite = (this.gridWrite + 1) % this.grid.length;
      for (let s = this.gridLastSlot + 1; s < slot && s - this.gridLastSlot < this.grid.length; s++) {
        this.grid[this.gridWrite] = 0;
        this.gridWrite = (this.gridWrite + 1) % this.grid.length;
      }
    }
    this.gridLastSlot = slot;
    this.gridAccum = value;
  }

  estimateTempo(now) {
    const n = this.grid.length;
    // unwrap ring buffer into linear order and remove the mean
    const x = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const v = this.grid[(this.gridWrite + i) % n];
      x[i] = v;
      mean += v;
    }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      x[i] -= mean;
      energy += x[i] * x[i];
    }
    if (energy < 1e-4) {
      this.tempoConfidence *= 0.8;
      return;
    }

    const minLag = Math.round((60 / 185) * this.gridHz);
    const maxLag = Math.round((60 / 65) * this.gridHz);
    let bestLag = 0;
    let bestScore = -Infinity;
    const scores = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
      s /= energy;
      // reward lags whose double / half also correlate (robust to half-time)
      scores[lag] = s;
    }
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = scores[lag];
      const half = Math.round(lag / 2);
      const dbl = lag * 2;
      if (half >= minLag) s += 0.35 * scores[half];
      if (dbl <= maxLag) s += 0.35 * scores[dbl];
      // gentle preference for the 95-140 bpm range
      const bpm = (60 * this.gridHz) / lag;
      const pref = Math.exp(-Math.pow((bpm - 118) / 45, 2));
      s *= 0.75 + 0.25 * pref;
      if (s > bestScore) {
        bestScore = s;
        bestLag = lag;
      }
    }
    if (!bestLag) return;

    // parabolic refinement around the best lag
    let lag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const l = scores[bestLag - 1];
      const c = scores[bestLag];
      const r = scores[bestLag + 1];
      const denom = l - 2 * c + r;
      if (Math.abs(denom) > 1e-6) lag = bestLag + (0.5 * (l - r)) / denom;
    }
    const newBpm = (60 * this.gridHz) / lag;
    const confidence = Math.max(0, Math.min(1, scores[bestLag] * 2.2));

    if (this.bpm > 0 && confidence < 0.25) {
      this.tempoConfidence = this.lerp(this.tempoConfidence, confidence, 0.3);
      return;
    }

    const periodMs = (60000 / newBpm);
    const prevPeriod = this.beatPeriod;
    this.bpm = this.bpm > 0 ? this.lerp(this.bpm, newBpm, Math.abs(newBpm - this.bpm) < 4 ? 0.25 : 0.6) : newBpm;
    this.beatPeriod = 60000 / this.bpm;
    this.tempoConfidence = this.lerp(this.tempoConfidence, confidence, 0.4);

    if (!this.beatAnchor || !prevPeriod || Math.abs(prevPeriod - periodMs) > periodMs * 0.08) {
      this.beatAnchor = this.bestPhaseAnchor(now);
    }
  }

  /** Choose the beat anchor that best lines up recent onsets with the period. */
  bestPhaseAnchor(now) {
    const period = this.beatPeriod;
    if (!period || this.onsetTimes.length < 3) return now;
    let bestPhase = 0;
    let bestScore = -1;
    const steps = 24;
    for (let s = 0; s < steps; s++) {
      const phase = (s / steps) * period;
      let score = 0;
      for (const t of this.onsetTimes) {
        const d = ((t - phase) % period + period) % period;
        const dist = Math.min(d, period - d) / period;
        score += Math.exp(-Math.pow(dist / 0.12, 2));
      }
      if (score > bestScore) {
        bestScore = score;
        bestPhase = phase;
      }
    }
    // anchor expressed as the most recent beat time
    const k = Math.floor((now - bestPhase) / period);
    return bestPhase + k * period;
  }

  updateBeatClock(now, onset, strength) {
    const f = this.features;
    if (!this.beatPeriod || this.tempoConfidence < 0.12) {
      f.beatPhase = 0;
      f.barPhase = 0;
      return;
    }
    const period = this.beatPeriod;
    let phase = ((now - this.beatAnchor) % period) / period;
    if (phase < 0) phase += 1;

    // phase-lock: nudge the anchor toward strong onsets that land near a beat
    if (onset && strength > 0.7) {
      const err = phase < 0.5 ? phase : phase - 1; // -0.5..0.5
      if (Math.abs(err) < 0.2) {
        this.beatAnchor += err * period * 0.25;
      }
    }

    if (phase < this.lastBeatPhase - 0.5) {
      f.beatTick = true;
      this.beatIndex += 1;
    }
    this.lastBeatPhase = phase;
    f.beatPhase = phase;
    f.barPhase = ((this.beatIndex % 4) + phase) / 4;
  }

  /**
   * Per-band hits. Runs before the global flux loop, so prevFreq still holds
   * the previous frame's spectrum. A hit needs flux above both a fraction of
   * the band's recent peak and 1.6x its running mean, rising from the
   * previous frame, and outside the band's cooldown.
   */
  updateBandHits(sampleRate, dt, now, silent) {
    const f = this.features;
    const nyquist = sampleRate * 0.5;
    const bins = this.freqData.length;
    for (let b = 0; b < this.bandDefs.length; b++) {
      const [lo, hi] = this.bandDefs[b];
      const i0 = Math.max(0, Math.round((lo / nyquist) * bins));
      const i1 = Math.min(bins - 1, Math.round((hi / nyquist) * bins));
      let flux = 0;
      for (let i = i0; i < i1; i++) {
        const d = this.freqData[i] / 255 - this.prevFreq[i];
        if (d > 0) flux += d;
      }
      flux /= Math.max(1, i1 - i0);

      this.bandFluxCeil[b] = Math.max(flux, this.bandFluxCeil[b] * (1 - 0.2 * dt), 0.004);
      const mean = this.bandFluxMean[b];
      this.bandFluxMean[b] = mean + (flux - mean) * (1 - Math.exp(-dt / 0.6));
      const rising = flux > this.bandFluxPrev[b];
      this.bandFluxPrev[b] = flux;

      const norm = flux / this.bandFluxCeil[b];
      this.bandNorm[b] = norm;
      this.bandCand[b] =
        !silent &&
        rising &&
        norm > 0.45 &&
        flux > mean * 1.6 &&
        now - this.bandLastHit[b] > this.bandCooldown[b];
    }

    // Bass decides first; upper bands then discount the kick's leakage.
    const bassNow = this.bandCand[0];
    const nearKick = bassNow || now - this.bandLastHit[0] < 60;
    for (let b = 0; b < this.bandDefs.length; b++) {
      const norm = this.bandNorm[b];
      let onset = this.bandCand[b];
      if (b > 0) {
        if (bassNow) this.bandLeak[b] += (norm - this.bandLeak[b]) * 0.12;
        if (onset && nearKick && this.bandExclusive) {
          onset = norm > Math.min(0.98, this.bandLeak[b] * 1.25 + 0.08);
        }
      }
      if (b === 2 && !onset && !silent) onset = this.detectNote(now);
      f.bandOnsets[b] = onset;
      const decay = Math.exp(-dt * this.bandDecay[b]);
      if (onset) {
        this.bandLastHit[b] = now;
        f.bandHitCount[b] += 1;
        f.bandHits[b] = Math.max(f.bandHits[b] * decay, Math.min(1, 0.35 + 0.65 * norm));
      } else {
        f.bandHits[b] *= decay;
      }
    }
  }

  /** True on the frame a new lead note settles (semitone held for 3 frames). */
  detectNote(now) {
    const hz = this.leadPeakHz;
    if (!(hz > 0)) {
      this.noteRaw = -1;
      this.noteHold = 0;
      return false;
    }
    const semi = Math.round(12 * Math.log2(hz / 440));
    if (semi === this.noteRaw) this.noteHold++;
    else {
      this.noteRaw = semi;
      this.noteHold = 1;
    }
    if (this.noteHold === 3 && semi !== this.noteStable) {
      this.noteStable = semi;
      if (now - this.bandLastHit[2] > this.bandCooldown[2] && now - this.noteLastAt > 150) {
        this.noteLastAt = now;
        this.features.noteOnsets = (this.features.noteOnsets || 0) + 1;
        return true;
      }
    }
    return false;
  }

  /** Per-band normalised level + interpolated spectral peak, smoothed. */
  updateBands(sampleRate, dt) {
    const f = this.features;
    const nyquist = sampleRate * 0.5;
    const bins = this.freqData.length;
    for (let b = 0; b < this.bandDefs.length; b++) {
      const [lo, hi] = this.bandDefs[b];
      const e = this.bandEnergy(lo, hi, sampleRate);
      this.bandCeil[b] = Math.max(e, this.bandCeil[b] * (1 - 0.1 * dt), 0.02);
      const lvl = Math.min(1, e / this.bandCeil[b]);
      f.bandLevels[b] = this.lerp(f.bandLevels[b], lvl, 0.3);

      const i0 = Math.max(1, Math.round((lo / nyquist) * bins));
      const i1 = Math.min(bins - 2, Math.round((hi / nyquist) * bins));
      let best = i0;
      let bestV = -1;
      for (let i = i0; i <= i1; i++) {
        const v = this.freqData[i];
        if (v > bestV) {
          bestV = v;
          best = i;
        }
      }
      if (bestV / 255 > 0.12) {
        // parabolic interpolation between neighbouring bins
        const a = this.freqData[best - 1];
        const c = this.freqData[best + 1];
        const denom = a - 2 * bestV + c;
        const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
        const hz = ((best + Math.max(-0.5, Math.min(0.5, delta))) * nyquist) / bins;
        f.pitches[b] = f.pitches[b] > 0 ? this.lerp(f.pitches[b], hz, 0.12) : hz;
        if (b === 2) this.leadPeakHz = f.bandLevels[2] > 0.3 ? hz : 0;
      } else if (b === 2) {
        this.leadPeakHz = 0;
      }
    }
    const vocal = f.pitches[2];
    if (vocal > 0) {
      const pc = 12 * Math.log2(vocal / 440);
      f.pitchClass = ((pc % 12) + 12) % 12;
    }
  }

  bandEnergy(freqLow, freqHigh, sampleRate) {
    const nyquist = sampleRate * 0.5;
    const startIndex = Math.max(0, Math.floor((freqLow / nyquist) * this.freqData.length));
    const endIndex = Math.min(this.freqData.length - 1, Math.ceil((freqHigh / nyquist) * this.freqData.length));

    if (endIndex <= startIndex) return 0;

    let sum = 0;
    let count = 0;
    for (let i = startIndex; i <= endIndex; i++) {
      sum += this.freqData[i] / 255;
      count++;
    }

    return count > 0 ? sum / count : 0;
  }

  lerp(current, target, alpha) {
    return current + (target - current) * alpha;
  }

  stop() {
    this.isRunning = false;

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    if (this.mediaElement) {
      this.mediaElement.pause();
      this.mediaElement.removeAttribute('src');
      this.mediaElement.load();
      this.mediaElement = null;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
  }

  async dispose() {
    this.stop();

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }

    this.audioContext = null;
    this.isInitialized = false;
  }
}
