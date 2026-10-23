import React, { useState, useEffect, useRef } from 'react';
import { usePlatform, AppProps, AppManifest } from '../../platform';
import { Trophy, Flame, RotateCcw, Bell, Sparkles } from 'lucide-react';

export const MyGame: React.FC<AppProps> = ({ width, height }) => {
  const platform = usePlatform();
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(() => {
    try {
      return parseInt(localStorage.getItem('mygame_highscore') || '0', 10);
    } catch {
      return 0;
    }
  });
  const [combo, setCombo] = useState(0);
  const [targetPos, setTargetPos] = useState({ x: 50, y: 50 });
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [pressureStatus, setPressureStatus] = useState<string>('Nominal');
  const comboTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Inter-app messaging listener
    const unsubMsg = platform.onMessage((msg) => {
      console.log('Received message in MyGame:', msg);
      setLastMessage(`[${msg.fromAppId}]: ${JSON.stringify(msg.payload)}`);
      platform.showToast(`Inter-app message from ${msg.fromAppId}`, 'info');
    });

    // Device memory pressure watcher
    const unsubPressure = platform.onPressureChange((snap) => {
      setPressureStatus(snap.pressureLevel);
      if (snap.pressureLevel === 'critical') {
        platform.showToast('Low ESP32 memory: reducing background load', 'warning');
      }
    });

    return () => {
      unsubMsg();
      unsubPressure();
      if (comboTimerRef.current) window.clearTimeout(comboTimerRef.current);
    };
  }, [platform]);

  const handleTargetClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextScore = score + 1 + Math.floor(combo / 5);
    const nextCombo = combo + 1;
    setScore(nextScore);
    setCombo(nextCombo);

    if (nextScore > highScore) {
      setHighScore(nextScore);
      try {
        localStorage.setItem('mygame_highscore', nextScore.toString());
      } catch {}
    }

    // Reset combo after 1.5s
    if (comboTimerRef.current) window.clearTimeout(comboTimerRef.current);
    comboTimerRef.current = window.setTimeout(() => setCombo(0), 1500);

    // Randomize target position within bounds
    const nextX = Math.floor(15 + Math.random() * 70);
    const nextY = Math.floor(20 + Math.random() * 60);
    setTargetPos({ x: nextX, y: nextY });

    if (nextScore % 10 === 0) {
      platform.showToast(`Milestone! ${nextScore} points scored! 🔥`, 'success');
    }
  };

  const resetGame = () => {
    setScore(0);
    setCombo(0);
    setTargetPos({ x: 50, y: 50 });
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 text-white select-none overflow-hidden relative font-sans">
      {/* Top HUD */}
      <div className="flex items-center justify-between px-6 py-4 bg-slate-900/80 border-b border-slate-800 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-lg shadow-inner">
            🎮
          </div>
          <div>
            <h2 className="text-sm font-bold text-white tracking-wide">My WebOS Game</h2>
            <p className="text-[11px] text-slate-400">Native React App (App Platform SDK)</p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-400/10 px-2.5 py-1 rounded-lg border border-amber-400/20">
            <Trophy className="w-3.5 h-3.5" />
            <span className="font-mono font-bold">Best: {highScore}</span>
          </div>

          <div className="flex items-center gap-1 text-xs text-slate-300">
            <span className="text-slate-400">ESP32 Heap:</span>
            <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
              pressureStatus === 'critical' || pressureStatus === 'emergency' 
                ? 'bg-red-500/20 text-red-300' 
                : 'bg-emerald-500/15 text-emerald-400'
            }`}>
              {pressureStatus.toUpperCase()}
            </span>
          </div>

          <button
            type="button"
            onClick={resetGame}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title="Reset Game"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Game Stage */}
      <div className="flex-1 relative overflow-hidden flex flex-col items-center justify-center p-6 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950">
        {/* Score & Combo Board */}
        <div className="absolute top-6 flex flex-col items-center pointer-events-none">
          <span className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Current Score</span>
          <div className="text-5xl font-mono font-black text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400 mt-1">
            {score}
          </div>
          {combo > 1 && (
            <div className="flex items-center gap-1 text-xs font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full mt-1 animate-bounce">
              <Flame className="w-3 h-3 text-amber-400" />
              <span>{combo}x COMBO!</span>
            </div>
          )}
        </div>

        {/* Interactive Target Bubble */}
        <button
          type="button"
          onClick={handleTargetClick}
          style={{
            position: 'absolute',
            left: `${targetPos.x}%`,
            top: `${targetPos.y}%`,
            transform: 'translate(-50%, -50%)',
          }}
          className="group w-24 h-24 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-600 hover:from-emerald-400 hover:to-cyan-500 p-1 shadow-xl shadow-emerald-500/25 active:scale-95 transition-all duration-150 flex flex-col items-center justify-center cursor-pointer border border-white/20 hover:ring-4 hover:ring-emerald-400/40"
        >
          <span className="text-2xl group-hover:scale-125 transition-transform">🎯</span>
          <span className="text-[11px] font-bold text-white mt-1 uppercase tracking-wider">Tap Me!</span>
        </button>

        {/* Floating Hint */}
        <div className="absolute bottom-6 flex flex-col items-center gap-2">
          <p className="text-xs text-slate-400">
            Click the target to score points. Watch out for device memory watchdog alerts!
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setScore((s) => s + 1);
                platform.showToast('Point scored via Play button!', 'success');
              }}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-xs font-semibold text-white shadow-md shadow-blue-600/30 transition-all active:scale-95"
            >
              Play (+1)
            </button>
            <button
              type="button"
              onClick={() => platform.showToast('Hello from MyGame via platform SDK!', 'info')}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-medium text-slate-200 border border-slate-700 transition-all"
            >
              <Bell className="w-3.5 h-3.5 text-amber-400" />
              <span>Test Toast</span>
            </button>
          </div>
        </div>

        {/* Message Log */}
        {lastMessage && (
          <div className="absolute bottom-20 left-6 right-6 p-2 rounded-lg bg-black/60 border border-slate-800 text-[11px] text-slate-300 font-mono truncate">
            {lastMessage}
          </div>
        )}
      </div>
    </div>
  );
};

export const MY_GAME_MANIFEST: AppManifest = {
  id: 'my-game',
  name: 'My Game',
  version: '1.0.0',
  description: 'Custom interactive WebOS game',
  icon: '🎮',
  tileColor: 'bg-emerald-500/10',
  appType: 'myGame',
  permissions: ['notifications', 'hardware', 'interAppMessage', 'openApps'],
  windowDefaults: { width: 640, height: 480 },
  component: MyGame,
};
