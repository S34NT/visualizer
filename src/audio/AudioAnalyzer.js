export class AudioAnalyzer {
  constructor(options = {}) {
    this.fftSize = options.fftSize || 2048;
    this.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.8;
    this.minDecibels = options.minDecibels ?? -90;
    this.maxDecibels = options.maxDecibels ?? -10;
    this.emaAlpha = options.emaAlpha ?? 0.2;

    this.audioContext = null;
    this.sourceNode = null;
    this.analyser = null;
    this.gainNode = null;
    this.mediaStream = null;

    this.freqData = null;
    this.timeData = null;

    this.isInitialized = false;
    this.isRunning = false;

    this.features = {
      rms: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      beat: 0,
      peak: 0
    };

    this.prevEnergy = 0;
    this.lastBeatTime = 0;
    this.cooldownMs = options.cooldownMs ?? 120;
  }

  async startFromMic() {
    if (this.isRunning) {
      return true;
    }

    await this.ensureAudioContext();

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.connectGraph();

    this.isInitialized = true;
    this.isRunning = true;
    return true;
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

    const binCount = this.analyser.frequencyBinCount;
    this.freqData = new Uint8Array(binCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
  }

  getFeatures() {
    if (!this.isRunning || !this.analyser) {
      return this.features;
    }

    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.timeData);

    const sampleRate = this.audioContext.sampleRate;

    const bass = this.bandEnergy(20, 140, sampleRate);
    const mid = this.bandEnergy(140, 2000, sampleRate);
    const treble = this.bandEnergy(2000, 12000, sampleRate);

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const normalized = (this.timeData[i] - 128) / 128;
      const abs = Math.abs(normalized);
      if (abs > peak) peak = abs;
      sumSquares += normalized * normalized;
    }

    const rms = Math.sqrt(sumSquares / this.timeData.length);

    const now = performance.now();
    const energy = bass * 0.6 + mid * 0.3 + treble * 0.1;
    const delta = energy - this.prevEnergy;
    const beatDetected = delta > 0.1 && rms > 0.06 && (now - this.lastBeatTime) > this.cooldownMs;
    if (beatDetected) {
      this.lastBeatTime = now;
    }

    this.prevEnergy = this.lerp(this.prevEnergy, energy, 0.4);

    this.features.rms = this.lerp(this.features.rms, rms, this.emaAlpha);
    this.features.bass = this.lerp(this.features.bass, bass, this.emaAlpha);
    this.features.mid = this.lerp(this.features.mid, mid, this.emaAlpha);
    this.features.treble = this.lerp(this.features.treble, treble, this.emaAlpha);
    this.features.peak = this.lerp(this.features.peak, peak, this.emaAlpha);
    this.features.beat = this.lerp(this.features.beat, beatDetected ? 1 : 0, 0.35);

    return this.features;
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
