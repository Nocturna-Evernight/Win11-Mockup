import React, { useState } from 'react';
import { OtaStatus } from '../../types';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

interface WindowsUpdateScreenProps {
  isVisible: boolean;
  status: OtaStatus | null;
  onDismissError: () => void;
  onRestartToApply: () => Promise<void>;
}

const STATE_MESSAGES: Record<OtaStatus['state'], { title: string; subtitle: string }> = {
  idle: {
    title: 'Preparing update',
    subtitle: 'Please keep your computer on and plugged in.',
  },
  reading: {
    title: 'Reading firmware image',
    subtitle: 'Checking image headers and partition compatibility…',
  },
  writing: {
    title: 'Working on updates',
    subtitle: 'Writing firmware to flash partition. Don\'t turn off your device. This might take a few minutes.',
  },
  verifying: {
    title: 'Verifying partition integrity',
    subtitle: 'Validating SHA-256 firmware checksum and partition table…',
  },
  done: {
    title: 'Update complete',
    subtitle: 'The image is staged in the inactive partition. Restart to apply it.',
  },
  error: {
    title: 'Update failed',
    subtitle: 'Something didn\'t go as planned. No changes were made to your system partition.',
  },
};

export const WindowsUpdateScreen: React.FC<WindowsUpdateScreenProps> = ({
  isVisible,
  status,
  onDismissError,
  onRestartToApply,
}) => {
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState('');

  if (!isVisible) return null;

  const currentState = status?.state || 'idle';
  const isDone = currentState === 'done';
  const isError = currentState === 'error';
  const pct = Math.min(100, Math.max(0, status?.progressPercent ?? 0));
  const messages = STATE_MESSAGES[currentState] || STATE_MESSAGES.idle;

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-gradient-to-b from-[#0060ad] via-[#0078D4] to-[#005194] text-white select-none overflow-hidden font-sans">
      {/* Subtle Windows 11 Vignette Overlay */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_30%,rgba(0,0,0,0.35)_100%)] pointer-events-none" />

      {/* Windows 11 4-tile logo */}
      <div className="mb-12 relative flex items-center justify-center">
        <div className="grid grid-cols-2 gap-1.5 w-16 h-16 drop-shadow-lg opacity-95">
          <div className="bg-white rounded-[2px]" />
          <div className="bg-white rounded-[2px]" />
          <div className="bg-white rounded-[2px]" />
          <div className="bg-white rounded-[2px]" />
        </div>
      </div>

      {isError ? (
        <div className="flex flex-col items-center text-center max-w-md px-6 z-10 animate-in fade-in zoom-in-95 duration-200">
          <div className="w-14 h-14 rounded-2xl bg-red-500/20 border border-red-400/30 flex items-center justify-center text-red-200 mb-5">
            <AlertTriangle className="w-7 h-7 text-red-300" />
          </div>
          <h1 className="text-2xl font-light text-white mb-2">{messages.title}</h1>
          <p className="text-sm text-blue-100/90 leading-relaxed mb-6">
            {status?.errorMessage || messages.subtitle}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onDismissError}
              className="px-6 py-2.5 bg-white text-[#0078D4] font-semibold rounded-xl hover:bg-blue-50 transition-all text-sm shadow-lg active:scale-95"
            >
              Back to Desktop
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center text-center max-w-lg px-6 z-10 animate-in fade-in duration-300">
          {/* Windows 11 Spinning Ring of Dots */}
          <div className="relative w-12 h-12 mb-8">
            {isDone ? (
              <CheckCircle2 className="w-12 h-12 text-emerald-300 animate-in zoom-in-75 duration-300" />
            ) : (
              <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
            )}
          </div>

          <h1 className="text-3xl font-light tracking-wide text-white mb-3">
            {isDone ? 'Update complete' : `${messages.title}`}
          </h1>

          <p className="text-sm text-blue-100/90 font-light min-h-[40px] max-w-md leading-relaxed mb-6">
            {messages.subtitle}
          </p>
          {isDone && (
            <div className="mb-7 flex flex-col items-center gap-2">
              <button
                type="button"
                disabled={restarting}
                onClick={() => {
                  setRestarting(true);
                  setRestartError('');
                  void onRestartToApply().catch((err: unknown) => {
                    setRestarting(false);
                    setRestartError(err instanceof Error ? err.message : 'Restart request failed');
                  });
                }}
                className="rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-[#0078D4] shadow-lg transition hover:bg-blue-50 disabled:opacity-60"
              >
                {restarting ? 'Preparing restart…' : 'Restart to apply update'}
              </button>
              {restartError && <p className="text-xs text-red-200">{restartError}</p>}
            </div>
          )}

          {/* Progress Bar & Percentage */}
          <div className="w-72 max-w-[85vw] space-y-3">
            <div className="w-full h-1.5 bg-white/25 rounded-full overflow-hidden shadow-inner">
              <div
                role="progressbar"
                aria-label="Firmware update progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="h-full bg-white rounded-full transition-all duration-300 ease-out shadow-[0_0_12px_rgba(255,255,255,0.7)]"
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs font-mono text-blue-100">
              <span className="text-lg font-semibold tabular-nums text-white">
                {pct.toFixed(0)}%
              </span>
              {status && status.totalBytes > 0 && (
                <span className="text-[11px] text-blue-200 font-sans">
                  {formatSize(status.bytesWritten)} / {formatSize(status.totalBytes)}
                </span>
              )}
            </div>
          </div>

          {/* Bottom Security Note */}
          <div className="absolute bottom-10 flex flex-col items-center gap-1 text-center">
            <p className="text-xs text-blue-200/90 font-light">
              The update is staged; the ESP32 restarts only when you request it.
            </p>
            <p className="text-[11px] text-blue-300/70">
              Dual partition A/B rollback guard active · Flash partition: OTA_0 / OTA_1
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
