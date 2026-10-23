import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ToggleLeft, ToggleRight } from 'lucide-react';

interface GpioState {
  pin: number;
  configured: boolean;
  level: 0 | 1 | null;
}

export const HardwareControlsApp: React.FC = () => {
  const [pins, setPins] = useState<GpioState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshPins = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/hardware/gpios', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Device returned HTTP ${response.status}`);
      setPins(await response.json() as GpioState[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPins();
  }, [refreshPins]);

  const setPinLevel = async (pin: number, level: 0 | 1) => {
    setError(null);
    try {
      const response = await fetch('/api/hardware/gpios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, level }),
      });
      if (!response.ok) throw new Error(`GPIO update failed with HTTP ${response.status}: ${await response.text()}`);
      const updated = await response.json() as { pin: number; level: 0 | 1 };
      setPins((previous) => previous.map((item) => item.pin === updated.pin
        ? { ...item, configured: true, level: updated.level }
        : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="h-full overflow-auto bg-[#111722] p-5 text-slate-100">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">ESP32-S3 GPIO Outputs</h2>
            <p className="mt-1 text-xs text-slate-400">Only firmware-allowlisted digital outputs can be changed here.</p>
          </div>
          <button type="button" onClick={() => void refreshPins()} disabled={isLoading}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/5 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </header>
        <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-950/30 p-3 text-xs leading-5 text-amber-100">
          GPIO 4–7 only. These are 3.3V logic signals, not power outputs. Do not connect motors, relays, or other loads directly. Use a resistor for LEDs and a suitable driver for external loads. Verify the board wiring before setting a pin HIGH.
        </div>
        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-950/30 p-3 text-xs text-red-200">{error}</div>}
        <div className="grid gap-3 sm:grid-cols-2">
          {pins.map((item) => (
            <article key={item.pin} className="rounded-xl border border-white/10 bg-[#171e2b] p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">GPIO {item.pin}</h3>
                  <p className="mt-1 text-[11px] text-slate-400">{item.configured ? `Output · ${item.level === 1 ? 'HIGH' : 'LOW'}` : 'Not configured · untouched'}</p>
                </div>
                {item.level === 1 ? <ToggleRight className="h-6 w-6 text-emerald-300" /> : <ToggleLeft className="h-6 w-6 text-slate-500" />}
              </div>
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={() => void setPinLevel(item.pin, 0)}
                  className="flex-1 rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/5">Set LOW</button>
                <button type="button" onClick={() => void setPinLevel(item.pin, 1)}
                  className="flex-1 rounded-lg bg-emerald-700 px-3 py-2 text-xs hover:bg-emerald-600">Set HIGH</button>
              </div>
            </article>
          ))}
        </div>
        {!isLoading && !error && pins.length === 0 && <p className="text-xs text-slate-400">No GPIO outputs were returned by the firmware.</p>}
      </div>
    </div>
  );
};
