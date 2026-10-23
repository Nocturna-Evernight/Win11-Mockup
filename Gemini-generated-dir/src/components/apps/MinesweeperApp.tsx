import React, { useState, useEffect, useCallback, useRef } from 'react';

const COLS = 9;
const ROWS = 9;
const MINES = 10;

type CellState = {
  isMine: boolean;
  isRevealed: boolean;
  isFlagged: boolean;
  adjacentMines: number;
};

type GameStatus = 'idle' | 'playing' | 'won' | 'lost';

function createEmptyGrid(): CellState[][] {
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({
      isMine: false,
      isRevealed: false,
      isFlagged: false,
      adjacentMines: 0,
    }))
  );
}

function placeMines(grid: CellState[][], safeR: number, safeC: number): CellState[][] {
  const next = grid.map((row) => row.map((cell) => ({ ...cell })));
  let placed = 0;
  while (placed < MINES) {
    const r = Math.floor(Math.random() * ROWS);
    const c = Math.floor(Math.random() * COLS);
    if (next[r][c].isMine) continue;
    if (Math.abs(r - safeR) <= 1 && Math.abs(c - safeC) <= 1) continue;
    next[r][c].isMine = true;
    placed++;
  }
  // Calculate adjacent counts
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (next[r][c].isMine) continue;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && next[nr][nc].isMine) {
            count++;
          }
        }
      }
      next[r][c].adjacentMines = count;
    }
  }
  return next;
}

// Iterative flood-fill reveal
function revealCells(grid: CellState[][], startR: number, startC: number): CellState[][] {
  const next = grid.map((row) => row.map((cell) => ({ ...cell })));
  const queue: [number, number][] = [[startR, startC]];
  while (queue.length > 0) {
    const item = queue.shift()!;
    const r = item[0];
    const c = item[1];
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
    const cell = next[r][c];
    if (cell.isRevealed || cell.isFlagged) continue;
    cell.isRevealed = true;
    if (cell.adjacentMines === 0 && !cell.isMine) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          queue.push([r + dr, c + dc]);
        }
      }
    }
  }
  return next;
}

function checkWin(grid: CellState[][]): boolean {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!grid[r][c].isMine && !grid[r][c].isRevealed) return false;
    }
  }
  return true;
}

const ADJ_COLORS = ['', 'text-blue-400', 'text-green-400', 'text-red-400', 'text-indigo-400', 'text-red-600', 'text-cyan-400', 'text-slate-300', 'text-slate-500'];

export const MinesweeperApp: React.FC = () => {
  const [grid, setGrid] = useState<CellState[][]>(createEmptyGrid);
  const [status, setStatus] = useState<GameStatus>('idle');
  const [minesLeft, setMinesLeft] = useState(MINES);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const rafRef = useRef<number>(0);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    const tick = () => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopTimer = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetGame = useCallback(() => {
    stopTimer();
    setGrid(createEmptyGrid());
    setStatus('idle');
    setMinesLeft(MINES);
    setElapsedSeconds(0);
  }, [stopTimer]);

  useEffect(() => {
    return () => stopTimer();
  }, [stopTimer]);

  const handleLeftClick = (r: number, c: number) => {
    if (status === 'won' || status === 'lost') return;
    const cell = grid[r][c];
    if (cell.isRevealed || cell.isFlagged) return;

    let workingGrid = grid;

    if (status === 'idle') {
      workingGrid = placeMines(grid, r, c);
      setStatus('playing');
      startTimer();
    }

    if (workingGrid[r][c].isMine) {
      // Reveal all mines
      const revealedGrid = workingGrid.map((row) =>
        row.map((cell) => (cell.isMine ? { ...cell, isRevealed: true } : { ...cell }))
      );
      setGrid(revealedGrid);
      setStatus('lost');
      stopTimer();
      return;
    }

    const revealed = revealCells(workingGrid, r, c);
    setGrid(revealed);

    if (checkWin(revealed)) {
      setStatus('won');
      stopTimer();
    }
  };

  const handleRightClick = (e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    if (status === 'idle' || status === 'won' || status === 'lost') return;
    const cell = grid[r][c];
    if (cell.isRevealed) return;

    const newGrid = grid.map((row, ri) =>
      row.map((cell, ci) => {
        if (ri === r && ci === c) {
          const newFlagged = !cell.isFlagged;
          setMinesLeft((prev) => prev + (newFlagged ? -1 : 1));
          return { ...cell, isFlagged: newFlagged };
        }
        return cell;
      })
    );
    setGrid(newGrid);
  };

  const getSmiley = () => {
    if (status === 'won') return '😎';
    if (status === 'lost') return '😵';
    return '🙂';
  };

  const displaySeconds = Math.min(elapsedSeconds, 999);

  return (
    <div className="flex flex-col items-center justify-start w-full h-full bg-[#1a202c] p-4 gap-4 select-none overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between w-full max-w-[340px] px-4 py-2 bg-neutral-900 border border-neutral-700 rounded-xl">
        <div className="font-mono text-red-400 text-lg font-bold w-14 text-right">
          {String(minesLeft).padStart(3, '0')}
        </div>
        <button
          type="button"
          onClick={resetGame}
          className="text-2xl hover:scale-110 transition-transform"
          title="New game"
        >
          {getSmiley()}
        </button>
        <div className="font-mono text-red-400 text-lg font-bold w-14 text-left">
          {String(displaySeconds).padStart(3, '0')}
        </div>
      </div>

      {/* Status banner */}
      {status === 'won' && (
        <div className="px-4 py-1.5 bg-green-600/20 border border-green-600/40 rounded-lg text-green-400 text-sm font-semibold">
          🎉 You win! Click 🙂 to play again.
        </div>
      )}
      {status === 'lost' && (
        <div className="px-4 py-1.5 bg-red-600/20 border border-red-600/40 rounded-lg text-red-400 text-sm font-semibold">
          💥 Boom! Click 🙂 to play again.
        </div>
      )}

      {/* Grid */}
      <div
        className="border-2 border-neutral-600 rounded-lg overflow-hidden"
        style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 36px)` }}
      >
        {grid.map((row, r) =>
          row.map((cell, c) => {
            let cellContent: React.ReactNode = null;
            let cellClass =
              'w-9 h-9 flex items-center justify-center text-sm font-bold border border-neutral-700 cursor-pointer transition-colors ';

            if (cell.isRevealed) {
              cellClass += 'bg-neutral-800 ';
              if (cell.isMine) {
                cellContent = '💣';
              } else if (cell.adjacentMines > 0) {
                cellContent = (
                  <span className={ADJ_COLORS[cell.adjacentMines]}>{cell.adjacentMines}</span>
                );
              }
            } else if (cell.isFlagged) {
              cellClass += 'bg-neutral-700 hover:bg-neutral-600 ';
              cellContent = '🚩';
            } else {
              cellClass += 'bg-neutral-700 hover:bg-neutral-600 ';
            }

            return (
              <div
                key={`${r}-${c}`}
                className={cellClass}
                onClick={() => handleLeftClick(r, c)}
                onContextMenu={(e) => handleRightClick(e, r, c)}
              >
                {cellContent}
              </div>
            );
          })
        )}
      </div>

      <p className="text-xs text-slate-500 mt-1">Left click: reveal · Right click: flag</p>
    </div>
  );
};
