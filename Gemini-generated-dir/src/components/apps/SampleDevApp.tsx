import React, { useState } from 'react';
import { usePlatform } from '../../platform';
import { Play, Sparkles, Send, Bell, Cpu, MessageSquare } from 'lucide-react';

export const SampleDevApp: React.FC = () => {
  const platform = usePlatform();
  const [messages, setMessages] = useState<string[]>([]);
  const [statusText, setStatusText] = useState<string>('Ready');

  React.useEffect(() => {
    // Inter-app messaging listener
    const unsub = platform.onMessage((msg) => {
      setMessages((prev) => [...prev, `[${msg.fromAppId}]: ${JSON.stringify(msg.payload)}`]);
    });

    // Device pressure watcher
    const unsubPressure = platform.onPressureChange((snap) => {
      if (snap.pressureLevel !== 'none') {
        setStatusText(`Pressure: ${snap.pressureLevel.toUpperCase()} (${(snap.internalFreeBytes / 1024).toFixed(1)} KB free)`);
      } else {
        setStatusText('Resources nominal');
      }
    });

    return () => {
      unsub();
      unsubPressure();
    };
  }, [platform]);

  const handleTestNotification = () => {
    platform.showToast('Platform notification triggered successfully!', 'success');
  };

  const handleQueryHardware = () => {
    const stats = platform.getHardwareStats();
    if (stats) {
      platform.showToast(`ESP32-S3 CPU: ${(stats.cpuFrequencyHz / 1e6).toFixed(0)}MHz | PSRAM: ${(stats.psramFreeBytes / 1024).toFixed(0)}KB free`, 'info');
    } else {
      platform.showToast('Hardware telemetry query unavailable right now', 'warning');
    }
  };

  const handleSimulateCrash = () => {
    throw new Error('Developer App simulated crash to test AppSandbox error boundary!');
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 p-6 overflow-y-auto space-y-6">
      <div className="flex items-center gap-3 border-b border-slate-800 pb-4">
        <div className="p-2.5 rounded-xl bg-violet-600/20 text-violet-400">
          <Sparkles className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-white">ESP32-S3 App Developer Studio</h2>
          <p className="text-xs text-slate-400">Sample application showcasing the Win11 WebOS platform layer</p>
        </div>
      </div>

      <div className="p-3 rounded-xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-between text-xs">
        <span className="text-slate-400">Watchdog Status:</span>
        <span className="font-mono text-emerald-400 font-semibold">{statusText}</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={handleTestNotification}
          className="flex items-center gap-2 p-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium transition-colors"
        >
          <Bell className="w-4 h-4 text-amber-400" />
          <span>Test System Toast</span>
        </button>

        <button
          type="button"
          onClick={handleQueryHardware}
          className="flex items-center gap-2 p-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium transition-colors"
        >
          <Cpu className="w-4 h-4 text-cyan-400" />
          <span>Read Hardware API</span>
        </button>

        <button
          type="button"
          onClick={() => platform.openApp('snake')}
          className="flex items-center gap-2 p-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium transition-colors"
        >
          <Play className="w-4 h-4 text-green-400" />
          <span>Launch Snake App</span>
        </button>

        <button
          type="button"
          onClick={handleSimulateCrash}
          className="flex items-center gap-2 p-3 rounded-xl bg-red-950/60 hover:bg-red-900/60 border border-red-800/60 text-red-300 text-xs font-medium transition-colors"
        >
          <Sparkles className="w-4 h-4 text-red-400" />
          <span>Simulate Crash (Sandbox Test)</span>
        </button>
      </div>

      {/* Dynamic WebUI App Launcher */}
      <div className="p-4 rounded-xl bg-slate-800/80 border border-slate-700 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-200">Test Custom HTML5 / JS App Code:</span>
          <button
            type="button"
            onClick={() => {
              platform.openApp('dynamicApp', {
                appName: 'Demo Canvas Counter',
                appCode: `
                  <h2 style="color:#38bdf8">Live HTML5 App Running on ESP32 WebOS</h2>
                  <p>Clicks: <span id="cnt" style="font-size:24px;font-weight:bold;color:#4ade80">0</span></p>
                  <button onclick="document.getElementById('cnt').innerText = ++window.c; window.ESP32.showToast('Clicked ' + window.c, 'info');">Increment</button>
                  <script>window.c = 0;</script>
                `
              });
            }}
            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors"
          >
            Launch Sample App
          </button>
        </div>
        <p className="text-[11px] text-slate-400">
          Tip: You can also upload any <code>.html</code> or <code>.app</code> file via <strong>File Explorer</strong> (Upload File to USB) and double-click it to run it automatically inside the sandboxed App Platform!
        </p>
      </div>

      {messages.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <MessageSquare className="w-3.5 h-3.5 text-blue-400" />
            <span>Inter-App Messages</span>
          </div>
          <div className="p-3 rounded-xl bg-neutral-950 font-mono text-[11px] text-slate-300 space-y-1 max-h-36 overflow-y-auto border border-neutral-800">
            {messages.map((m, idx) => (
              <div key={idx}>{m}</div>
            ))}
          </div>
        </div>
      )}

      <div className="p-4 rounded-xl bg-blue-950/30 border border-blue-800/40 text-xs text-blue-200/90 space-y-1.5">
        <p className="font-semibold text-blue-300">Safeguards Active:</p>
        <p>• <strong>Render-rate limiter:</strong> Auto-kills app if exceeding 500 renders in 5s (preventing infinite loops).</p>
        <p>• <strong>Execution watchdog:</strong> FreeRTOS task monitors ESP32 internal SRAM & PSRAM every 500ms.</p>
        <p>• <strong>Graduated kill:</strong> Closes low-priority processes if internal heap drops below 30KB / 15KB emergency.</p>
      </div>
    </div>
  );
};
