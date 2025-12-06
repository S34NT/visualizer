import * as THREE from 'three';

/**
 * HandFaceTracker - Manages webcam access and hand/face detection using MediaPipe
 * Provides 3D coordinates for attraction points in the murmuration simulation
 */
export class HandFaceTracker {
  constructor(params) {
    this.params = params;
    this.isInitialized = false;
    this.isRunning = false;
    
    // MediaPipe modules (loaded dynamically)
    this.HandLandmarker = null;
    this.FaceLandmarker = null;
    this.handLandmarker = null;
    this.faceLandmarker = null;
    
    // Video elements
    this.video = null;
    this.videoCanvas = null;
    this.videoCtx = null;
    
    // Tracking results - attraction points in simulation space
    this.attractionPoints = [];
    this.rawResults = {
      hands: [],
      face: null
    };
    
    // Coordinate mapping settings
    this.mappingScale = params.trackingScale || 200; // Scale factor for coordinate mapping
    this.depthScale = params.depthScale || 100; // Z-axis scale
    
    // Performance settings
    this.lastFrameTime = 0;
    this.targetFPS = 30; // Process at 30fps max for performance
    this.frameInterval = 1000 / this.targetFPS;
    
    // Event callbacks
    this.onTrackingUpdate = null;
    this.onError = null;
  }
  
  /**
   * Load MediaPipe libraries dynamically from CDN
   */
  async loadMediaPipe() {
    try {
      console.log('Loading MediaPipe from CDN...');
      
      // Import MediaPipe tasks-vision from CDN
      // Using a specific version for stability
      const vision = await import(
        /* @vite-ignore */
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
      );
      
      this.FilesetResolver = vision.FilesetResolver;
      this.HandLandmarker = vision.HandLandmarker;
      this.FaceLandmarker = vision.FaceLandmarker;
      
      console.log('MediaPipe loaded successfully');
      return true;
    } catch (error) {
      console.error('Failed to load MediaPipe:', error);
      this.onError?.('Failed to load MediaPipe. Please check your internet connection.');
      return false;
    }
  }
  
  /**
   * Initialize MediaPipe models
   */
  async initializeModels() {
    try {
      console.log('Initializing MediaPipe models...');
      
      // Create vision fileset with specific version
      const vision = await this.FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      
      // Initialize Hand Landmarker
      this.handLandmarker = await this.HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      
      // Initialize Face Landmarker
      this.faceLandmarker = await this.FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false
      });
      
      console.log('MediaPipe models initialized');
      return true;
    } catch (error) {
      console.error('Failed to initialize MediaPipe models:', error);
      this.onError?.('Failed to initialize tracking models');
      return false;
    }
  }
  
  /**
   * Initialize webcam access
   */
  async initializeWebcam() {
    try {
      // Create video element
      this.video = document.createElement('video');
      this.video.setAttribute('playsinline', '');
      this.video.setAttribute('autoplay', '');
      this.video.style.display = 'none';
      document.body.appendChild(this.video);
      
      // Request camera access
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        },
        audio: false
      });
      
      this.video.srcObject = stream;
      
      // Wait for video to be ready
      await new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          this.video.play();
          resolve();
        };
      });
      
      console.log('Webcam initialized:', this.video.videoWidth, 'x', this.video.videoHeight);
      return true;
    } catch (error) {
      console.error('Failed to access webcam:', error);
      this.onError?.('Failed to access webcam. Please allow camera access.');
      return false;
    }
  }
  
  /**
   * Create preview canvas for debugging/display
   */
  createPreviewCanvas() {
    // Check if preview container exists
    let container = document.getElementById('tracking-preview');
    if (!container) {
      container = document.createElement('div');
      container.id = 'tracking-preview';
      container.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 200px;
        height: 150px;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        z-index: 1000;
        border: 2px solid rgba(255,255,255,0.2);
      `;
      document.body.appendChild(container);
    }
    
    // Create canvas for preview
    this.videoCanvas = document.createElement('canvas');
    this.videoCanvas.width = 200;
    this.videoCanvas.height = 150;
    this.videoCanvas.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1);
    `;
    container.innerHTML = '';
    container.appendChild(this.videoCanvas);
    
    this.videoCtx = this.videoCanvas.getContext('2d');
  }
  
  /**
   * Full initialization sequence
   */
  async initialize() {
    if (this.isInitialized) return true;
    
    console.log('Initializing HandFaceTracker...');
    
    // Load MediaPipe
    const mpLoaded = await this.loadMediaPipe();
    if (!mpLoaded) return false;
    
    // Initialize models
    const modelsReady = await this.initializeModels();
    if (!modelsReady) return false;
    
    // Initialize webcam
    const webcamReady = await this.initializeWebcam();
    if (!webcamReady) return false;
    
    // Create preview
    if (this.params.showPreview !== false) {
      this.createPreviewCanvas();
    }
    
    this.isInitialized = true;
    console.log('HandFaceTracker fully initialized');
    return true;
  }
  
  /**
   * Start tracking
   */
  async start() {
    if (!this.isInitialized) {
      const success = await this.initialize();
      if (!success) return false;
    }
    
    this.isRunning = true;
    this.trackFrame();
    console.log('Tracking started');
    return true;
  }
  
  /**
   * Stop tracking
   */
  stop() {
    this.isRunning = false;
    console.log('Tracking stopped');
  }
  
  /**
   * Main tracking loop
   */
  trackFrame() {
    if (!this.isRunning) return;
    
    const now = performance.now();
    const elapsed = now - this.lastFrameTime;
    
    // Throttle to target FPS
    if (elapsed >= this.frameInterval) {
      this.lastFrameTime = now;
      this.processFrame(now);
    }
    
    requestAnimationFrame(() => this.trackFrame());
  }
  
  /**
   * Process a single video frame
   */
  processFrame(timestamp) {
    if (!this.video || this.video.readyState < 2) return;
    
    try {
      // Detect hands
      const handResults = this.handLandmarker.detectForVideo(this.video, timestamp);
      
      // Detect face
      const faceResults = this.faceLandmarker.detectForVideo(this.video, timestamp);
      
      // Process results
      this.processResults(handResults, faceResults);
      
      // Update preview
      if (this.videoCtx) {
        this.drawPreview(handResults, faceResults);
      }
      
      // Callback
      this.onTrackingUpdate?.(this.attractionPoints);
      
    } catch (error) {
      console.error('Frame processing error:', error);
    }
  }
  
  /**
   * Process tracking results into attraction points
   */
  processResults(handResults, faceResults) {
    this.attractionPoints = [];
    this.rawResults.hands = [];
    this.rawResults.face = null;
    
    // Process hands
    if (handResults.landmarks && handResults.landmarks.length > 0) {
      for (let i = 0; i < handResults.landmarks.length; i++) {
        const landmarks = handResults.landmarks[i];
        const handedness = handResults.handednesses[i]?.[0]?.categoryName || 'Unknown';
        
        // Get palm center (landmark 0 is wrist, 9 is middle finger base)
        // Use average of wrist and middle finger MCP for palm center
        const wrist = landmarks[0];
        const middleMCP = landmarks[9];
        const palmCenter = {
          x: (wrist.x + middleMCP.x) / 2,
          y: (wrist.y + middleMCP.y) / 2,
          z: (wrist.z + middleMCP.z) / 2
        };
        
        // Map to simulation coordinates
        const simPos = this.mapToSimulationSpace(palmCenter);
        
        this.attractionPoints.push({
          type: 'hand',
          handedness: handedness,
          position: simPos,
          strength: this.params.handAttractionStrength || 1.0
        });
        
        this.rawResults.hands.push({
          landmarks: landmarks,
          handedness: handedness,
          palmCenter: palmCenter
        });
        
        // Also add fingertips as weaker attraction points
        const fingertipIndices = [4, 8, 12, 16, 20]; // Thumb, index, middle, ring, pinky tips
        for (const idx of fingertipIndices) {
          const tip = landmarks[idx];
          const tipSimPos = this.mapToSimulationSpace(tip);
          
          this.attractionPoints.push({
            type: 'fingertip',
            handedness: handedness,
            position: tipSimPos,
            strength: (this.params.handAttractionStrength || 1.0) * 0.3
          });
        }
      }
    }
    
    // Process face
    if (faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0) {
      const landmarks = faceResults.faceLandmarks[0];
      
      // Get face center (nose tip is landmark 1)
      const noseTip = landmarks[1];
      const simPos = this.mapToSimulationSpace(noseTip);
      
      this.attractionPoints.push({
        type: 'face',
        position: simPos,
        strength: this.params.faceAttractionStrength || 0.5
      });
      
      this.rawResults.face = {
        landmarks: landmarks,
        center: noseTip
      };
    }
  }
  
  /**
   * Map normalized coordinates to simulation space
   * MediaPipe: x,y in [0,1] (origin top-left), z is relative depth
   * Simulation: centered at origin, bounds defined by params
   */
  mapToSimulationSpace(point) {
    // MediaPipe x: 0 (left) to 1 (right) -> simulation: positive (right) to negative (left)
    // This mirrors the image since camera is mirrored
    const x = -(point.x - 0.5) * 2 * this.mappingScale;
    
    // MediaPipe y: 0 (top) to 1 (bottom) -> simulation: positive (top) to negative (bottom)
    const y = -(point.y - 0.5) * 2 * this.mappingScale;
    
    // MediaPipe z: negative is closer to camera
    // Map to simulation z (coming out of screen toward viewer)
    const z = -point.z * this.depthScale;
    
    return new THREE.Vector3(x, y, z);
  }
  
  /**
   * Draw preview with tracking visualization
   */
  drawPreview(handResults, faceResults) {
    const ctx = this.videoCtx;
    const canvas = this.videoCanvas;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw video frame (mirrored)
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(this.video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
    
    // Scale factors
    const scaleX = canvas.width / this.video.videoWidth;
    const scaleY = canvas.height / this.video.videoHeight;
    
    // Draw hand landmarks
    if (handResults.landmarks) {
      ctx.fillStyle = '#00ff88';
      ctx.strokeStyle = '#00ff88';
      
      for (const landmarks of handResults.landmarks) {
        // Draw palm center
        const wrist = landmarks[0];
        const middleMCP = landmarks[9];
        const palmX = canvas.width - ((wrist.x + middleMCP.x) / 2) * canvas.width;
        const palmY = ((wrist.y + middleMCP.y) / 2) * canvas.height;
        
        ctx.beginPath();
        ctx.arc(palmX, palmY, 8, 0, Math.PI * 2);
        ctx.fill();
        
        // Draw fingertips
        const fingertipIndices = [4, 8, 12, 16, 20];
        for (const idx of fingertipIndices) {
          const tip = landmarks[idx];
          const x = canvas.width - tip.x * canvas.width;
          const y = tip.y * canvas.height;
          
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    
    // Draw face center
    if (faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0) {
      ctx.fillStyle = '#ff6688';
      const landmarks = faceResults.faceLandmarks[0];
      const nose = landmarks[1];
      const x = canvas.width - nose.x * canvas.width;
      const y = nose.y * canvas.height;
      
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Draw status
    ctx.fillStyle = 'white';
    ctx.font = '10px monospace';
    ctx.fillText(`Hands: ${handResults.landmarks?.length || 0}`, 8, 14);
    ctx.fillText(`Face: ${faceResults.faceLandmarks?.length || 0}`, 8, 26);
  }
  
  /**
   * Get current attraction points
   */
  getAttractionPoints() {
    return this.attractionPoints;
  }
  
  /**
   * Show/hide preview
   */
  setPreviewVisible(visible) {
    const container = document.getElementById('tracking-preview');
    if (container) {
      container.style.display = visible ? 'block' : 'none';
    }
  }
  
  /**
   * Cleanup resources
   */
  dispose() {
    this.stop();
    
    // Stop video stream
    if (this.video && this.video.srcObject) {
      const tracks = this.video.srcObject.getTracks();
      tracks.forEach(track => track.stop());
      this.video.srcObject = null;
    }
    
    // Remove video element
    if (this.video && this.video.parentNode) {
      this.video.parentNode.removeChild(this.video);
    }
    
    // Remove preview
    const container = document.getElementById('tracking-preview');
    if (container) {
      container.parentNode.removeChild(container);
    }
    
    // Close MediaPipe
    this.handLandmarker?.close();
    this.faceLandmarker?.close();
    
    this.isInitialized = false;
    console.log('HandFaceTracker disposed');
  }
}

