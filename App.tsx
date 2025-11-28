import React, { useState, useEffect, useRef, useCallback } from 'react';
import { analyzeSecuritySnapshot } from './services/geminiService';
import { MotionLog, AppConfig, DetectionStatus } from './types';
import { MotionLogItem } from './components/MotionLogItem';
import { 
  VideoCameraIcon, 
  Cog6ToothIcon, 
  BellAlertIcon, 
  SparklesIcon,
  NoSymbolIcon
} from '@heroicons/react/24/solid';

const DEFAULT_CONFIG: AppConfig = {
  sensitivity: 20, // Pixel difference threshold (0-255)
  threshold: 150,   // Number of changed pixels to trigger alert
  enableAudio: true,
  enableAI: true,
  cooldown: 5,     // Seconds
};

const MAX_LOGS = 20;

// --- Geometric Helper Functions for Polygon (Convex Hull) ---

interface Point {
  x: number;
  y: number;
}

// Cross product of vectors OA and OB.
// Returns a positive value, if OAB makes a counter-clockwise turn,
// negative for clockwise turn, and zero if the points are collinear.
const cross = (o: Point, a: Point, b: Point): number => {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
};

// Monotone Chain Convex Hull Algorithm
const getConvexHull = (points: Point[]): Point[] => {
  const n = points.length;
  if (n <= 2) return points;

  // Sort points by x-coordinate (in case of a tie, sort by y-coordinate).
  points.sort((a, b) => {
    return a.x === b.x ? a.y - b.y : a.x - b.x;
  });

  // Build lower hull
  const lower: Point[] = [];
  for (let i = 0; i < n; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], points[i]) <= 0) {
      lower.pop();
    }
    lower.push(points[i]);
  }

  // Build upper hull
  const upper: Point[] = [];
  for (let i = n - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points[i]) <= 0) {
      upper.pop();
    }
    upper.push(points[i]);
  }

  // Concatenation of the lower and upper hulls gives the convex hull.
  // Last point of upper list is omitted because it is repeated at the beginning of the lower list.
  upper.pop();
  lower.pop();
  return lower.concat(upper);
};

export default function App() {
  // State
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<DetectionStatus>(DetectionStatus.IDLE);
  const [logs, setLogs] = useState<MotionLog[]>([]);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [debugDiff, setDebugDiff] = useState<number>(0);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastAlertTime = useRef<number>(0);
  const prevFrameData = useRef<Uint8ClampedArray | null>(null);
  const processingInterval = useRef<number | null>(null);
  const audioContext = useRef<AudioContext | null>(null);

  // Initialize Camera
  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 640, height: 480, frameRate: 15 }, 
          audio: false 
        });
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          streamRef.current = stream;
        }
        setHasPermission(true);
      } catch (err) {
        console.error("Error accessing camera:", err);
        setHasPermission(false);
      }
    };

    startCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (processingInterval.current) {
        clearInterval(processingInterval.current);
      }
      if (audioContext.current) {
        audioContext.current.close();
      }
    };
  }, []);

  // Audio Alert Logic
  const playAlertSound = useCallback(() => {
    if (!config.enableAudio) return;

    if (!audioContext.current) {
      audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    if (audioContext.current.state === 'suspended') {
      audioContext.current.resume();
    }

    const osc = audioContext.current.createOscillator();
    const gain = audioContext.current.createGain();

    osc.connect(gain);
    gain.connect(audioContext.current.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioContext.current.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioContext.current.currentTime + 0.1);
    
    gain.gain.setValueAtTime(0.5, audioContext.current.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioContext.current.currentTime + 0.1);

    osc.start();
    osc.stop(audioContext.current.currentTime + 0.1);
  }, [config.enableAudio]);

  // Motion Detection Loop
  useEffect(() => {
    if (!hasPermission) return;

    const detectMotion = () => {
      if (!videoRef.current || !canvasRef.current || !overlayRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const overlayCtx = overlay.getContext('2d');

      if (!ctx || !overlayCtx || video.readyState !== 4) return;

      // Sync overlay size and position with video element
      if (video.clientWidth && video.clientHeight) {
        if (overlay.width !== video.clientWidth || overlay.height !== video.clientHeight) {
          overlay.width = video.clientWidth;
          overlay.height = video.clientHeight;
        }
        overlay.style.width = `${video.clientWidth}px`;
        overlay.style.height = `${video.clientHeight}px`;
        overlay.style.left = `${video.offsetLeft}px`;
        overlay.style.top = `${video.offsetTop}px`;
      }

      // Draw video frame to small canvas (performance optimization)
      const width = 64; 
      const height = 48;
      
      ctx.drawImage(video, 0, 0, width, height);
      
      const frameData = ctx.getImageData(0, 0, width, height);
      const data = frameData.data;
      
      const activePixels: Point[] = [];

      if (prevFrameData.current) {
        const prev = prevFrameData.current;

        // Compare pixels (loop by 4 because RGBA)
        for (let i = 0; i < data.length; i += 4) {
          const rDiff = Math.abs(data[i] - prev[i]);
          const gDiff = Math.abs(data[i + 1] - prev[i + 1]);
          const bDiff = Math.abs(data[i + 2] - prev[i + 2]);

          if (rDiff + gDiff + bDiff > config.sensitivity) {
            // Store coordinates of changed pixel
            const pIdx = i / 4;
            const x = pIdx % width;
            const y = Math.floor(pIdx / width);
            activePixels.push({ x, y });
          }
        }
        
        setDebugDiff(activePixels.length);

        // Clear overlay
        overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

        // Check against threshold
        if (activePixels.length > config.threshold) {
          handleMotionDetected();
          
          // --- Draw Polygon (Convex Hull) ---
          
          // 1. Calculate Convex Hull from the small grid points
          const hullPoints = getConvexHull(activePixels);

          if (hullPoints.length > 0) {
            const scaleX = overlay.width / width;
            const scaleY = overlay.height / height;

            overlayCtx.beginPath();
            
            // Move to first point
            overlayCtx.moveTo(hullPoints[0].x * scaleX, hullPoints[0].y * scaleY);

            // Draw lines to subsequent points
            for (let i = 1; i < hullPoints.length; i++) {
              overlayCtx.lineTo(hullPoints[i].x * scaleX, hullPoints[i].y * scaleY);
            }

            overlayCtx.closePath();
            
            // Style
            overlayCtx.lineJoin = 'round';
            overlayCtx.lineWidth = 4;
            overlayCtx.strokeStyle = 'rgba(239, 68, 68, 0.9)'; // Red-500
            overlayCtx.stroke();
            
            overlayCtx.fillStyle = 'rgba(239, 68, 68, 0.2)';
            overlayCtx.fill();
            
            // Optional: Draw scan lines inside the polygon for extra "tech" feel
            overlayCtx.save();
            overlayCtx.clip();
            overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            for(let i = 0; i < overlay.height; i += 4) {
               overlayCtx.fillRect(0, i, overlay.width, 1);
            }
            overlayCtx.restore();
          }

        } else {
          setStatus(DetectionStatus.IDLE);
        }
      }

      // Store current frame
      prevFrameData.current = new Uint8ClampedArray(data);
    };

    processingInterval.current = window.setInterval(detectMotion, 100); // Check every 100ms

    return () => {
      if (processingInterval.current) clearInterval(processingInterval.current);
    };
  }, [hasPermission, config.sensitivity, config.threshold, config.cooldown]); 

  // Handle Motion Event
  const handleMotionDetected = async () => {
    const now = Date.now();
    if (now - lastAlertTime.current < config.cooldown * 1000) {
      // Still in cooldown, but visually show alert state
      setStatus(DetectionStatus.ALERT);
      return;
    }

    lastAlertTime.current = now;
    setStatus(DetectionStatus.ALERT);
    playAlertSound();

    // Capture high-res snapshot for the log
    let snapshotUrl = '';
    if (videoRef.current) {
      const captureCanvas = document.createElement('canvas');
      captureCanvas.width = videoRef.current.videoWidth;
      captureCanvas.height = videoRef.current.videoHeight;
      captureCanvas.getContext('2d')?.drawImage(videoRef.current, 0, 0);
      snapshotUrl = captureCanvas.toDataURL('image/jpeg', 0.6);
    }

    const newLogId = Date.now().toString();
    const newLog: MotionLog = {
      id: newLogId,
      timestamp: new Date(),
      imageUrl: snapshotUrl,
      isAnalyzing: config.enableAI,
    };

    setLogs(prev => [newLog, ...prev].slice(0, MAX_LOGS));

    // AI Analysis
    if (config.enableAI && snapshotUrl) {
      try {
        const description = await analyzeSecuritySnapshot(snapshotUrl);
        setLogs(prev => prev.map(log => 
          log.id === newLogId 
            ? { ...log, analysis: description, isAnalyzing: false } 
            : log
        ));
      } catch (e) {
        console.error("Analysis failed", e);
        setLogs(prev => prev.map(log => 
          log.id === newLogId 
            ? { ...log, isAnalyzing: false, analysis: "Analysis unavailable." } 
            : log
        ));
      }
    }
  };

  return (
    <div className="flex h-screen w-full bg-gray-950 text-white font-sans overflow-hidden">
      {/* --- Main Video Area --- */}
      <div className="flex-grow flex flex-col relative h-full">
        <header className="absolute top-0 left-0 right-0 p-4 z-10 bg-gradient-to-b from-black/80 to-transparent flex justify-between items-center pointer-events-none">
          <div className="flex items-center gap-2 pointer-events-auto">
             <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse"></div>
             <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">SENTINEL<span className="text-red-500">.AI</span></h1>
          </div>
          <div className="pointer-events-auto">
             {status === DetectionStatus.ALERT && (
               <div className="bg-red-600/90 text-white px-4 py-1 rounded-full font-bold animate-pulse text-sm uppercase tracking-wider shadow-lg shadow-red-900/50">
                 Motion Detected
               </div>
             )}
          </div>
        </header>

        <div className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
          {hasPermission === false && (
            <div className="text-center p-6 bg-gray-900 rounded-lg border border-gray-800">
              <NoSymbolIcon className="w-12 h-12 text-red-500 mx-auto mb-2" />
              <h2 className="text-xl font-semibold mb-2">Camera Access Denied</h2>
              <p className="text-gray-400">Please enable camera access to use this application.</p>
            </div>
          )}
          
          {/* Container for Video & Overlay ensures they are siblings and can be aligned */}
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline 
            muted 
            className={`max-w-full max-h-full object-contain ${status === DetectionStatus.ALERT ? 'shadow-[0_0_50px_rgba(220,38,38,0.5)]' : ''}`}
          />
          
          <canvas 
            ref={overlayRef}
            className="absolute pointer-events-none"
          />
          
          {/* Hidden canvas for processing */}
          <canvas ref={canvasRef} width="64" height="48" className="hidden" />
          
          {/* Debug Overlay */}
          <div className="absolute bottom-4 left-4 font-mono text-xs text-green-500 bg-black/70 p-2 rounded pointer-events-none z-20">
            SCORE: {debugDiff} / {config.threshold}
          </div>
        </div>
      </div>

      {/* --- Sidebar Control Panel --- */}
      <div className="w-96 bg-gray-900 border-l border-gray-800 flex flex-col h-full shadow-2xl z-20">
        
        {/* Settings Section */}
        <div className="p-6 border-b border-gray-800 bg-gray-850">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <Cog6ToothIcon className="w-4 h-4" /> Configuration
          </h2>

          <div className="space-y-6">
            {/* Sensitivity Slider */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-sm font-medium text-gray-300">Sensitivity</label>
                <span className="text-xs text-gray-500">{config.sensitivity}</span>
              </div>
              <input 
                type="range" 
                min="5" 
                max="100" 
                value={config.sensitivity} 
                onChange={(e) => setConfig({...config, sensitivity: parseInt(e.target.value)})}
                className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
              <p className="text-xs text-gray-500 mt-1">Lower value = More sensitive to color changes</p>
            </div>

            {/* Threshold Slider */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-sm font-medium text-gray-300">Trigger Threshold</label>
                <span className="text-xs text-gray-500">{config.threshold}px</span>
              </div>
              <input 
                type="range" 
                min="10" 
                max="1000" 
                value={config.threshold} 
                onChange={(e) => setConfig({...config, threshold: parseInt(e.target.value)})}
                className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
               <p className="text-xs text-gray-500 mt-1">Movement size required to trigger alert</p>
            </div>

            {/* Toggles */}
            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={() => setConfig(c => ({...c, enableAudio: !c.enableAudio}))}
                className={`flex flex-col items-center justify-center p-3 rounded-lg border transition-all ${config.enableAudio ? 'bg-indigo-900/30 border-indigo-500/50 text-indigo-300' : 'bg-gray-800 border-gray-700 text-gray-500 hover:bg-gray-750'}`}
              >
                <BellAlertIcon className="w-6 h-6 mb-2" />
                <span className="text-xs font-medium">Audio Alert</span>
              </button>

              <button 
                onClick={() => setConfig(c => ({...c, enableAI: !c.enableAI}))}
                className={`flex flex-col items-center justify-center p-3 rounded-lg border transition-all ${config.enableAI ? 'bg-emerald-900/30 border-emerald-500/50 text-emerald-300' : 'bg-gray-800 border-gray-700 text-gray-500 hover:bg-gray-750'}`}
              >
                <SparklesIcon className="w-6 h-6 mb-2" />
                <span className="text-xs font-medium">Gemini AI</span>
              </button>
            </div>
          </div>
        </div>

        {/* Logs Section */}
        <div className="flex-grow overflow-hidden flex flex-col bg-gray-900">
           <div className="p-4 bg-gray-850 border-b border-gray-800 flex justify-between items-center sticky top-0">
             <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
                <VideoCameraIcon className="w-4 h-4" /> Event Log
             </h2>
             <span className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-300">{logs.length}</span>
           </div>
           
           <div className="flex-grow overflow-y-auto p-4">
             {logs.length === 0 ? (
               <div className="flex flex-col items-center justify-center h-full text-gray-600 space-y-2">
                 <VideoCameraIcon className="w-12 h-12 opacity-20" />
                 <p className="text-sm">No motion detected yet.</p>
               </div>
             ) : (
               logs.map(log => <MotionLogItem key={log.id} log={log} />)
             )}
           </div>
        </div>
      </div>
    </div>
  );
}
