import React from 'react';
import { MotionLog } from '../types';

interface MotionLogItemProps {
  log: MotionLog;
}

export const MotionLogItem: React.FC<MotionLogItemProps> = ({ log }) => {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 mb-3 flex gap-3 animate-fade-in shadow-sm hover:border-gray-600 transition-colors">
      <div className="flex-shrink-0">
        <img 
          src={log.imageUrl} 
          alt="Motion Snapshot" 
          className="w-16 h-16 object-cover rounded bg-gray-900 border border-gray-700"
        />
      </div>
      <div className="flex-grow min-w-0">
        <div className="flex justify-between items-start mb-1">
          <span className="text-xs font-mono text-emerald-400">
            {log.timestamp.toLocaleTimeString()}
          </span>
        </div>
        <p className="text-sm text-gray-300 line-clamp-2">
          {log.isAnalyzing ? (
            <span className="flex items-center gap-2 text-indigo-400">
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
              Analyzing...
            </span>
          ) : (
            log.analysis || "Motion Detected"
          )}
        </p>
      </div>
    </div>
  );
};