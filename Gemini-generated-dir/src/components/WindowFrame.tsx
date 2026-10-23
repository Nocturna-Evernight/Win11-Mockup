import React, { useState, useRef, useEffect } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { AppWindow } from '../types';

interface WindowFrameProps {
  win: AppWindow;
  isActive: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  children: React.ReactNode;
}

export const WindowFrame: React.FC<WindowFrameProps> = ({
  win,
  isActive,
  onFocus,
  onClose,
  onMinimize,
  onToggleMaximize,
  children,
}) => {
  const [pos, setPos] = useState({ x: win.x, y: win.y });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    onFocus();
    if (win.isMaximized) return;
    setIsDragging(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: pos.x,
      posY: pos.y,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      setPos({
        x: Math.max(0, dragStartRef.current.posX + dx),
        y: Math.max(0, dragStartRef.current.posY + dy),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  if (!win.isOpen || win.isMinimized) return null;

  return (
    <div
      onClick={onFocus}
      style={{
        zIndex: win.zIndex,
        ...(win.isMaximized
          ? { left: 0, top: 0, width: '100vw', height: 'calc(100vh - 48px)' }
          : { left: `${pos.x}px`, top: `${pos.y}px`, width: `${win.width}px`, height: `${win.height}px` }),
      }}
      className={`fixed flex flex-col overflow-hidden transition-all duration-150 ${
        win.isMaximized ? 'rounded-none border-b border-neutral-700/60' : 'rounded-xl border border-neutral-700/80 shadow-2xl'
      } ${isActive ? 'ring-1 ring-blue-500/30' : 'opacity-95'} bg-[#1f2430]/95 backdrop-blur-2xl text-slate-100 select-none`}
    >
      {/* Titlebar */}
      <div
        onMouseDown={handleMouseDown}
        onDoubleClick={onToggleMaximize}
        className={`h-10 px-3.5 flex items-center justify-between border-b cursor-default ${
          isActive ? 'bg-[#252b3b]/90 border-neutral-700/60' : 'bg-[#1b202c]/90 border-neutral-800'
        }`}
      >
        {/* Left: Window Icon + Title */}
        <div className="flex items-center gap-2.5 overflow-hidden">
          <span className="text-base select-none">{win.icon}</span>
          <span className="text-xs font-medium text-slate-200 truncate tracking-wide">
            {win.title}
          </span>
          {win.requiresAdmin && (
            <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded font-mono font-medium border border-amber-500/30">
              Admin
            </span>
          )}
        </div>

        {/* Right: Window Controls */}
        <div className="flex items-center -mr-1" onMouseDown={(e) => e.stopPropagation()}>
          {/* Minimize */}
          <button
            type="button"
            onClick={onMinimize}
            aria-label="Minimize"
            className="w-10 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 rounded transition-colors"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>

          {/* Maximize / Restore */}
          <button
            type="button"
            onClick={onToggleMaximize}
            aria-label={win.isMaximized ? "Restore" : "Maximize"}
            className="w-10 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 rounded transition-colors"
          >
            {win.isMaximized ? <Copy className="w-3 h-3 rotate-180" /> : <Square className="w-3 h-3" />}
          </button>

          {/* Close */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-10 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-red-600 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Window Body */}
      <div className="flex-1 overflow-auto bg-[#171b26]/90 relative">
        {children}
      </div>
    </div>
  );
};
