/**
 * ResourceGuard — Device-level memory pressure monitor + app killer.
 *
 * Polls /api/platform/resources (provided by the ESP32 firmware watchdog)
 * and takes graduated defensive action:
 *
 *  NONE      → Nothing.
 *  LOW       → Shows a subtle system warning badge on the taskbar.
 *  CRITICAL  → Force-kills the lowest-priority open app window (if any)
 *               and shows a "Low Memory" notification.
 *  EMERGENCY → Force-kills ALL non-essential open app windows and shows
 *               a full-screen warning banner.
 *
 * This component renders only system UI (warning banners). It does not
 * render any app content itself.
 *
 * Usage: Mount once inside App.tsx, passing the openWindows list and a
 * killWindow callback.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { ResourceSnapshot, PressureLevel } from './types';
import { AlertTriangle, Zap } from 'lucide-react';
import type { AppWindow, WindowAppType } from '../types';
import { usePlatformContext } from './PlatformContext';

// ---------------------------------------------------------------------------
// App priority list — lower index = killed first under memory pressure.
// Games and "nice-to-have" apps are killed before system utilities.
// ---------------------------------------------------------------------------

const KILL_PRIORITY: WindowAppType[] = [
  'pong',
  'snake',
  'minesweeper',
  'media',
  'remoteBrowser',
  'office',
  'calculator',
  'firmware',
  'hardware',
  'hardwareControls',
  'notepad',
  'explorer',
  'updateManager',
  // The following are NEVER auto-killed (system-critical):
  // 'terminal', 'taskmgr', 'settings'
];

const NEVER_KILL: Set<WindowAppType> = new Set(['terminal', 'taskmgr', 'settings']);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ResourceGuardProps {
  /** Current list of all app windows */
  windows: AppWindow[];
  /** Callback to close a window by its ID */
  onKillWindow: (windowId: string) => void;
  /** Optional override for resource pressure */
  resourcePressure?: ResourceSnapshot | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ResourceGuard: React.FC<ResourceGuardProps> = ({
  windows,
  onKillWindow,
  resourcePressure: propPressure,
}) => {
  const platformCtx = usePlatformContext();
  const resourcePressure = propPressure !== undefined ? propPressure : platformCtx.resourcePressure;
  const lastLevelRef = useRef<PressureLevel>('none');
  const [showEmergencyBanner, setShowEmergencyBanner] = useState(false);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);

  // Find the lowest-priority OPEN window to kill
  const findKillTarget = useCallback((
    openWindows: AppWindow[]
  ): AppWindow | null => {
    for (const appType of KILL_PRIORITY) {
      const found = openWindows.find(
        (w) => w.appType === appType && w.isOpen && !NEVER_KILL.has(w.appType)
      );
      if (found) return found;
    }
    return null;
  }, []);

  useEffect(() => {
    if (!resourcePressure) return;

    const level = resourcePressure.pressureLevel;
    const prev  = lastLevelRef.current;
    if (level === prev) return; // no change

    lastLevelRef.current = level;
    const openWindows = windows.filter((w) => w.isOpen);

    if (level === 'emergency') {
      // Kill ALL killable open apps
      const killed: string[] = [];
      for (const w of openWindows) {
        if (!NEVER_KILL.has(w.appType)) {
          onKillWindow(w.id);
          killed.push(w.appType);
        }
      }
      console.error(
        `[ResourceGuard] EMERGENCY: closed ${killed.length} apps: [${killed.join(', ')}]. ` +
        `Internal heap free = ${(resourcePressure.internalFreeBytes / 1024).toFixed(1)} KB`
      );
      setShowEmergencyBanner(true);
      setWarningMessage(null);
    } else if (level === 'critical') {
      // Kill only the lowest-priority app
      const target = findKillTarget(openWindows);
      if (target) {
        onKillWindow(target.id);
        setWarningMessage(
          `Low memory: closed "${target.appType}" to free resources. ` +
          `Internal heap: ${(resourcePressure.internalFreeBytes / 1024).toFixed(1)} KB free.`
        );
        console.warn(`[ResourceGuard] CRITICAL: killed "${target.appType}" (id=${target.id})`);
      } else {
        setWarningMessage(
          `Low memory warning: ${(resourcePressure.internalFreeBytes / 1024).toFixed(1)} KB internal heap free. ` +
          `Close unused apps.`
        );
      }
      setShowEmergencyBanner(false);
    } else if (level === 'low') {
      setWarningMessage(
        `Memory usage is elevated: ${(resourcePressure.internalFreeBytes / 1024).toFixed(1)} KB free.`
      );
      setShowEmergencyBanner(false);
    } else {
      // Recovered to 'none'
      setWarningMessage(null);
      setShowEmergencyBanner(false);
    }
  }, [resourcePressure, windows, onKillWindow, findKillTarget]);

  // Auto-dismiss warning message after 6 seconds
  useEffect(() => {
    if (!warningMessage) return;
    const id = window.setTimeout(() => setWarningMessage(null), 6000);
    return () => window.clearTimeout(id);
  }, [warningMessage]);

  return (
    <>
      {/* Warning toast banner (low / critical) */}
      {warningMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9850] flex items-center gap-3 px-4 py-3 bg-amber-950/95 border border-amber-700/60 rounded-xl shadow-2xl backdrop-blur-xl max-w-md animate-in slide-in-from-top-4 fade-in duration-200">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-100">{warningMessage}</p>
          <button
            type="button"
            onClick={() => setWarningMessage(null)}
            className="text-amber-400 hover:text-amber-200 text-xs pl-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Emergency full-screen banner */}
      {showEmergencyBanner && (
        <div className="fixed inset-x-0 bottom-14 z-[9840] flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-3 px-5 py-3.5 bg-red-950/98 border border-red-700/60 rounded-xl shadow-2xl backdrop-blur-xl max-w-lg animate-in slide-in-from-bottom-4 fade-in duration-300">
            <div className="p-2 rounded-lg bg-red-500/20 shrink-0">
              <Zap className="w-5 h-5 text-red-400" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-300">Emergency Memory Recovery</p>
              <p className="text-xs text-red-200/80 mt-0.5">
                Critical heap shortage on ESP32-S3 — all non-essential apps were closed to prevent a crash.
                Internal heap free: {resourcePressure
                  ? `${(resourcePressure.internalFreeBytes / 1024).toFixed(1)} KB`
                  : '—'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowEmergencyBanner(false)}
              className="text-red-400 hover:text-red-200 text-xs pl-2 shrink-0"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  );
};
