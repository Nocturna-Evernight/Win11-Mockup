import React, { useRef, useEffect, useState, useCallback } from 'react';

const PADDLE_W = 12;
const PADDLE_H = 80;
const BALL_SIZE = 10;
const AI_SPEED = 3;
const WINNING_SCORE = 7;

interface GameState {
  playerY: number;
  aiY: number;
  ballX: number;
  ballY: number;
  ballVX: number;
  ballVY: number;
  playerScore: number;
  aiScore: number;
  phase: 'waiting' | 'playing' | 'won';
  winner: 'player' | 'ai' | null;
}

function makeInitialState(w: number, h: number): GameState {
  return {
    playerY: h / 2 - PADDLE_H / 2,
    aiY: h / 2 - PADDLE_H / 2,
    ballX: w / 2,
    ballY: h / 2,
    ballVX: 0,
    ballVY: 0,
    playerScore: 0,
    aiScore: 0,
    phase: 'waiting',
    winner: null,
  };
}

export const PongGame: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const stateRef = useRef<GameState | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const [displayScore, setDisplayScore] = useState({ player: 0, ai: 0 });
  const [phase, setPhase] = useState<'waiting' | 'playing' | 'won'>('waiting');
  const [winner, setWinner] = useState<'player' | 'ai' | null>(null);

  const launchBall = (state: GameState, w: number, h: number) => {
    state.ballX = w / 2;
    state.ballY = h / 2;
    const angle = (Math.random() * 60 - 30) * (Math.PI / 180);
    const dir = Math.random() > 0.5 ? 1 : -1;
    const speed = 5;
    state.ballVX = dir * speed * Math.cos(angle);
    state.ballVY = speed * Math.sin(angle);
  };

  const draw = useCallback((canvas: HTMLCanvasElement, state: GameState) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Paddles
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.roundRect(16, state.playerY, PADDLE_W, PADDLE_H, 4);
    ctx.fill();

    ctx.beginPath();
    ctx.roundRect(w - 16 - PADDLE_W, state.aiY, PADDLE_W, PADDLE_H, 4);
    ctx.fill();

    // Ball
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(state.ballX - BALL_SIZE / 2, state.ballY - BALL_SIZE / 2, BALL_SIZE, BALL_SIZE);
  }, []);

  const gameLoop = useCallback(() => {
    const canvas = canvasRef.current;
    const state = stateRef.current;
    if (!canvas || !state) return;
    const w = canvas.width;
    const h = canvas.height;

    if (state.phase === 'playing') {
      // Player paddle movement
      const playerSpeed = 6;
      if (keysRef.current.has('w') || keysRef.current.has('ArrowUp')) {
        state.playerY = Math.max(0, state.playerY - playerSpeed);
      }
      if (keysRef.current.has('s') || keysRef.current.has('ArrowDown')) {
        state.playerY = Math.min(h - PADDLE_H, state.playerY + playerSpeed);
      }

      // AI movement
      const aiCenter = state.aiY + PADDLE_H / 2;
      if (aiCenter < state.ballY - 3) {
        state.aiY = Math.min(h - PADDLE_H, state.aiY + AI_SPEED);
      } else if (aiCenter > state.ballY + 3) {
        state.aiY = Math.max(0, state.aiY - AI_SPEED);
      }

      // Move ball
      state.ballX += state.ballVX;
      state.ballY += state.ballVY;

      // Top/bottom wall bounce
      if (state.ballY - BALL_SIZE / 2 <= 0) {
        state.ballY = BALL_SIZE / 2;
        state.ballVY = Math.abs(state.ballVY);
      }
      if (state.ballY + BALL_SIZE / 2 >= h) {
        state.ballY = h - BALL_SIZE / 2;
        state.ballVY = -Math.abs(state.ballVY);
      }

      // Player paddle collision
      const playerPaddleRight = 16 + PADDLE_W;
      if (
        state.ballX - BALL_SIZE / 2 <= playerPaddleRight &&
        state.ballX - BALL_SIZE / 2 >= 16 &&
        state.ballY >= state.playerY &&
        state.ballY <= state.playerY + PADDLE_H
      ) {
        state.ballX = playerPaddleRight + BALL_SIZE / 2;
        const hitPos = (state.ballY - state.playerY) / PADDLE_H - 0.5;
        const angle = hitPos * 60 * (Math.PI / 180);
        const speed = Math.hypot(state.ballVX, state.ballVY) * 1.05;
        state.ballVX = Math.abs(speed * Math.cos(angle));
        state.ballVY = speed * Math.sin(angle);
      }

      // AI paddle collision
      const aiPaddleLeft = w - 16 - PADDLE_W;
      if (
        state.ballX + BALL_SIZE / 2 >= aiPaddleLeft &&
        state.ballX + BALL_SIZE / 2 <= w - 16 &&
        state.ballY >= state.aiY &&
        state.ballY <= state.aiY + PADDLE_H
      ) {
        state.ballX = aiPaddleLeft - BALL_SIZE / 2;
        const hitPos = (state.ballY - state.aiY) / PADDLE_H - 0.5;
        const angle = hitPos * 60 * (Math.PI / 180);
        const speed = Math.hypot(state.ballVX, state.ballVY) * 1.05;
        state.ballVX = -Math.abs(speed * Math.cos(angle));
        state.ballVY = speed * Math.sin(angle);
      }

      // Scoring
      if (state.ballX < 0) {
        state.aiScore++;
        setDisplayScore({ player: state.playerScore, ai: state.aiScore });
        if (state.aiScore >= WINNING_SCORE) {
          state.phase = 'won';
          state.winner = 'ai';
          setPhase('won');
          setWinner('ai');
        } else {
          launchBall(state, w, h);
        }
      }
      if (state.ballX > w) {
        state.playerScore++;
        setDisplayScore({ player: state.playerScore, ai: state.aiScore });
        if (state.playerScore >= WINNING_SCORE) {
          state.phase = 'won';
          state.winner = 'player';
          setPhase('won');
          setWinner('player');
        } else {
          launchBall(state, w, h);
        }
      }
    }

    draw(canvas, state);
    rafRef.current = requestAnimationFrame(gameLoop);
  }, [draw]);

  // Resize handler
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      if (stateRef.current) {
        // Clamp paddles on resize
        stateRef.current.playerY = Math.min(stateRef.current.playerY, canvas.height - PADDLE_H);
        stateRef.current.aiY = Math.min(stateRef.current.aiY, canvas.height - PADDLE_H);
      } else {
        stateRef.current = makeInitialState(canvas.width, canvas.height);
      }
    };
    resize();
    const obs = new ResizeObserver(resize);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Start RAF loop
  useEffect(() => {
    rafRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [gameLoop]);

  // Key listeners
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      keysRef.current.add(e.key);
      if (['ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
      if (e.key === ' ') {
        const state = stateRef.current;
        const canvas = canvasRef.current;
        if (!state || !canvas) return;
        if (state.phase === 'waiting' || state.phase === 'won') {
          const newState = makeInitialState(canvas.width, canvas.height);
          newState.phase = 'playing';
          stateRef.current = newState;
          launchBall(newState, canvas.width, canvas.height);
          setDisplayScore({ player: 0, ai: 0 });
          setPhase('playing');
          setWinner(null);
        }
      }
    };
    const onUp = (e: KeyboardEvent) => keysRef.current.delete(e.key);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  const handleStartClick = () => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return;
    const newState = makeInitialState(canvas.width, canvas.height);
    newState.phase = 'playing';
    stateRef.current = newState;
    launchBall(newState, canvas.width, canvas.height);
    setDisplayScore({ player: 0, ai: 0 });
    setPhase('playing');
    setWinner(null);
  };

  return (
    <div className="flex flex-col w-full h-full bg-black">
      {/* Score bar */}
      <div className="flex items-center justify-center gap-12 px-4 py-2 bg-neutral-900 border-b border-neutral-800 text-white font-mono text-xl shrink-0">
        <span className="text-blue-400">{displayScore.player}</span>
        <span className="text-slate-500 text-sm">Player vs AI</span>
        <span className="text-red-400">{displayScore.ai}</span>
      </div>

      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        <canvas ref={canvasRef} className="block w-full h-full" />

        {/* Overlay for waiting/won */}
        {phase !== 'playing' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-4">
            {phase === 'won' && (
              <p className="text-2xl font-bold text-white">
                {winner === 'player' ? '🏆 Player Wins!' : '🤖 AI Wins!'}
              </p>
            )}
            <p className="text-slate-400 text-sm">W/S or ↑↓ to move your paddle</p>
            <button
              type="button"
              onClick={handleStartClick}
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors"
            >
              {phase === 'won' ? 'Play Again (SPACE)' : 'Start Game (SPACE)'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
