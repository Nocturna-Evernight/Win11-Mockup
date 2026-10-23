import React, { useRef, useEffect, useState, useCallback } from 'react';

const GRID_SIZE = 20;
const MOVE_INTERVAL_MS = 150;

type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
type Point = { x: number; y: number };

function randomEmptyCell(snake: Point[], cols: number, rows: number): Point {
  const occupied = new Set(snake.map((p) => `${p.x},${p.y}`));
  const candidates: Point[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!occupied.has(`${x},${y}`)) candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return { x: 0, y: 0 };
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export const SnakeGame: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const lastMoveRef = useRef<number>(0);

  // Game state stored in refs to avoid stale closures in the RAF loop
  const snakeRef = useRef<Point[]>([{ x: 10, y: 10 }]);
  const dirRef = useRef<Direction>('RIGHT');
  const nextDirRef = useRef<Direction>('RIGHT');
  const foodRef = useRef<Point>({ x: 5, y: 5 });
  const scoreRef = useRef<number>(0);
  const gameOverRef = useRef<boolean>(false);
  const colsRef = useRef<number>(GRID_SIZE);
  const rowsRef = useRef<number>(GRID_SIZE);
  const cellWRef = useRef<number>(20);
  const cellHRef = useRef<number>(20);
  const runningRef = useRef<boolean>(false);

  const [score, setScore] = useState(0);
  const [isGameOver, setIsGameOver] = useState(false);
  const [started, setStarted] = useState(false);

  const resetGame = useCallback(() => {
    const cols = colsRef.current;
    const rows = rowsRef.current;
    const initSnake: Point[] = [{ x: Math.floor(cols / 2), y: Math.floor(rows / 2) }];
    snakeRef.current = initSnake;
    dirRef.current = 'RIGHT';
    nextDirRef.current = 'RIGHT';
    foodRef.current = randomEmptyCell(initSnake, cols, rows);
    scoreRef.current = 0;
    gameOverRef.current = false;
    lastMoveRef.current = 0;
    setScore(0);
    setIsGameOver(false);
  }, []);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = cellWRef.current;
    const ch = cellHRef.current;
    const cols = colsRef.current;
    const rows = rowsRef.current;

    // Background
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid lines (subtle)
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cw, 0);
      ctx.lineTo(x * cw, rows * ch);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * ch);
      ctx.lineTo(cols * cw, y * ch);
      ctx.stroke();
    }

    // Food
    const food = foodRef.current;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(food.x * cw + cw / 2, food.y * ch + ch / 2, Math.min(cw, ch) * 0.38, 0, Math.PI * 2);
    ctx.fill();

    // Snake
    const snake = snakeRef.current;
    for (let i = 0; i < snake.length; i++) {
      const seg = snake[i];
      const isHead = i === 0;
      ctx.fillStyle = isHead ? '#4ade80' : '#16a34a';
      const pad = isHead ? 1 : 2;
      ctx.beginPath();
      ctx.roundRect(seg.x * cw + pad, seg.y * ch + pad, cw - pad * 2, ch - pad * 2, 3);
      ctx.fill();
    }
  }, []);

  const gameLoop = useCallback((timestamp: number) => {
    if (gameOverRef.current || !runningRef.current) return;

    if (timestamp - lastMoveRef.current >= MOVE_INTERVAL_MS) {
      lastMoveRef.current = timestamp;
      dirRef.current = nextDirRef.current;

      const snake = snakeRef.current;
      const head = snake[0];
      const cols = colsRef.current;
      const rows = rowsRef.current;

      let newHead: Point;
      switch (dirRef.current) {
        case 'UP':    newHead = { x: head.x, y: head.y - 1 }; break;
        case 'DOWN':  newHead = { x: head.x, y: head.y + 1 }; break;
        case 'LEFT':  newHead = { x: head.x - 1, y: head.y }; break;
        default:      newHead = { x: head.x + 1, y: head.y }; break;
      }

      // Wall collision
      if (newHead.x < 0 || newHead.x >= cols || newHead.y < 0 || newHead.y >= rows) {
        gameOverRef.current = true;
        runningRef.current = false;
        setIsGameOver(true);
        drawFrame();
        return;
      }

      // Self collision
      for (let i = 0; i < snake.length; i++) {
        if (snake[i].x === newHead.x && snake[i].y === newHead.y) {
          gameOverRef.current = true;
          runningRef.current = false;
          setIsGameOver(true);
          drawFrame();
          return;
        }
      }

      const food = foodRef.current;
      const ateFood = newHead.x === food.x && newHead.y === food.y;

      const newSnake: Point[] = [newHead, ...snake];
      if (!ateFood) {
        newSnake.pop();
      } else {
        scoreRef.current += 10;
        setScore(scoreRef.current);
        foodRef.current = randomEmptyCell(newSnake, cols, rows);
      }
      snakeRef.current = newSnake;
    }

    drawFrame();
    rafRef.current = requestAnimationFrame(gameLoop);
  }, [drawFrame]);

  // Resize canvas to container
  useEffect(() => {
    const resize = () => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const cellW = Math.floor(w / GRID_SIZE);
      const cellH = Math.floor(h / GRID_SIZE);
      const cols = Math.floor(w / cellW);
      const rows = Math.floor(h / cellH);
      canvas.width = cols * cellW;
      canvas.height = rows * cellH;
      cellWRef.current = cellW;
      cellHRef.current = cellH;
      colsRef.current = cols;
      rowsRef.current = rows;
      drawFrame();
    };
    resize();
    const obs = new ResizeObserver(resize);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [drawFrame]);

  // Key controls
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = dirRef.current;
      switch (e.key) {
        case 'ArrowUp':    if (dir !== 'DOWN')  nextDirRef.current = 'UP';    break;
        case 'ArrowDown':  if (dir !== 'UP')    nextDirRef.current = 'DOWN';  break;
        case 'ArrowLeft':  if (dir !== 'RIGHT') nextDirRef.current = 'LEFT';  break;
        case 'ArrowRight': if (dir !== 'LEFT')  nextDirRef.current = 'RIGHT'; break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startGame = useCallback(() => {
    resetGame();
    runningRef.current = true;
    setStarted(true);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(gameLoop);
  }, [resetGame, gameLoop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      runningRef.current = false;
    };
  }, []);

  return (
    <div className="flex flex-col w-full h-full bg-[#111827]">
      {/* Score bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#0f172a] border-b border-neutral-800 text-sm text-slate-300 shrink-0">
        <span className="font-semibold text-green-400">🐍 Snake</span>
        <span>Score: <span className="text-white font-bold">{score}</span></span>
      </div>

      {/* Canvas container */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        <canvas ref={canvasRef} className="block" />

        {/* Start overlay */}
        {!started && !isGameOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-4">
            <p className="text-2xl text-green-400 font-bold">🐍 Snake</p>
            <p className="text-slate-400 text-sm">Use Arrow Keys to move</p>
            <button
              type="button"
              onClick={startGame}
              className="px-6 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold transition-colors"
            >
              Play
            </button>
          </div>
        )}

        {/* Game Over overlay */}
        {isGameOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 gap-3">
            <p className="text-3xl font-bold text-red-400">GAME OVER</p>
            <p className="text-slate-300 text-lg">Score: <span className="text-white font-bold">{score}</span></p>
            <button
              type="button"
              onClick={startGame}
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors"
            >
              Play Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
