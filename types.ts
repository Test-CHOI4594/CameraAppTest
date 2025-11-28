export interface MotionLog {
  id: string;
  timestamp: Date;
  imageUrl: string; // Base64 snapshot
  analysis?: string; // Gemini analysis
  isAnalyzing: boolean;
}

export interface AppConfig {
  sensitivity: number; // 0-100, lower is more sensitive
  threshold: number; // How many pixels must change to trigger
  enableAudio: boolean;
  enableAI: boolean;
  cooldown: number; // Seconds between alerts
}

export enum DetectionStatus {
  IDLE = 'IDLE',
  DETECTING = 'DETECTING',
  ALERT = 'ALERT',
}