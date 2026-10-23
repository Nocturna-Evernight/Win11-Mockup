import React, { useState, useEffect } from 'react';
import { 
  Folder, 
  Terminal as TerminalIcon, 
  Cpu, 
  Settings as SettingsIcon, 
  FileText, 
  Code2, 
  Wifi, 
  HardDrive, 
  Sliders,
  Thermometer,
  Music2,
  Calculator,
  FileSpreadsheet,
  ToggleRight
} from 'lucide-react';
import { AppWindow, FirmwareSystemSnapshot, ThermalTelemetry, WindowAppType } from '../types';
import { thermalService } from '../services/thermalService';

interface TaskbarProps {
  windows: AppWindow[];
  hardwareStats: FirmwareSystemSnapshot | null;
  activeWindowId: string | null;
  onToggleWindow: (type: WindowAppType) => void;
  isStartOpen: boolean;
  onToggleStart: () => void;
  onOpenStatsPopover: () => void;
}

export const Taskbar: React.FC<TaskbarProps> = ({
  windows,
  hardwareStats,
  activeWindowId,
  onToggleWindow,
  isStartOpen,
  onToggleStart,
  onOpenStatsPopover,
}) => {
  const [timeStr, setTimeStr] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [thermalData, setThermalData] = useState<ThermalTelemetry>(thermalService.getTelemetry());
  const usbMounted = hardwareStats?.usbMounted === true;
  const activeSsid = hardwareStats?.wifiStationConnected
    ? hardwareStats.wifiStationSsid
    : hardwareStats?.wifiApSsid;

  useEffect(() => {
    const unsubThermal = thermalService.subscribe(t => setThermalData(t));
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setDateStr(now.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' }));
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => {
      clearInterval(interval);
      unsubThermal();
    };
  }, []);

  const getAppState = (type: WindowAppType) => {
    const win = windows.find((w) => w.appType === type);
    if (!win || !win.isOpen) return 'closed';
    if (win.id === activeWindowId && !win.isMinimized) return 'active';
    return 'open';
  };

  const apps: { type: WindowAppType; label: string; icon: React.ReactNode; color: string }[] = [
    { type: 'explorer', label: 'File Explorer', icon: <Folder className="w-5 h-5 text-amber-400" />, color: 'hover:bg-amber-500/10' },
    { type: 'terminal', label: 'Terminal', icon: <TerminalIcon className="w-5 h-5 text-emerald-400" />, color: 'hover:bg-emerald-500/10' },
    { type: 'taskmgr', label: 'Task Manager', icon: <Cpu className="w-5 h-5 text-cyan-400" />, color: 'hover:bg-cyan-500/10' },
    { type: 'notepad', label: 'Notepad', icon: <FileText className="w-5 h-5 text-sky-300" />, color: 'hover:bg-sky-500/10' },
    { type: 'settings', label: 'Settings', icon: <SettingsIcon className="w-5 h-5 text-slate-300" />, color: 'hover:bg-slate-500/10' },
    { type: 'firmware', label: 'ESP-IDF Source Code', icon: <Code2 className="w-5 h-5 text-purple-400" />, color: 'hover:bg-purple-500/10' },
    { type: 'hardware', label: 'USB-OTG Hardware Guide', icon: <Sliders className="w-5 h-5 text-orange-400" />, color: 'hover:bg-orange-500/10' },
    { type: 'media', label: 'Media Player', icon: <Music2 className="w-5 h-5 text-indigo-300" />, color: 'hover:bg-indigo-500/10' },
    { type: 'calculator', label: 'Calculator', icon: <Calculator className="w-5 h-5 text-cyan-300" />, color: 'hover:bg-cyan-500/10' },
    { type: 'office', label: 'Productivity Suite', icon: <FileSpreadsheet className="w-5 h-5 text-emerald-300" />, color: 'hover:bg-emerald-500/10' },
    { type: 'hardwareControls', label: 'Hardware Controls', icon: <ToggleRight className="w-5 h-5 text-amber-300" />, color: 'hover:bg-amber-500/10' },
  ];

  return (
    <footer 
      role="toolbar"
      aria-label="Windows Taskbar"
      className="fixed bottom-0 left-0 right-0 h-12 bg-[#141824]/90 backdrop-blur-2xl border-t border-neutral-700/60 z-[9000] flex items-center justify-between px-3 select-none"
    >
      {/* Left zone: ESP32-S3 Hardware Status Indicator */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenStatsPopover}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 transition-colors text-xs text-slate-300"
          title={hardwareStats ? `${hardwareStats.chipModel} live hardware telemetry` : 'ESP32 hardware telemetry unavailable'}
        >
          <div className={`w-2 h-2 rounded-full ${hardwareStats ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
          <span className="font-mono font-medium text-[11px] text-emerald-300">
            {hardwareStats?.chipModel ?? 'ESP32'}
          </span>
          <span className="text-slate-500 hidden sm:inline">|</span>
          <span className="text-[11px] text-slate-300 hidden sm:inline">
            {hardwareStats ? `${(hardwareStats.psramTotalBytes / 1024).toLocaleString()} KB PSRAM` : 'Telemetry unavailable'}
          </span>
        </button>
      </div>

      {/* Center Zone: Centered Windows 11 App Icons */}
      <div className="flex items-center gap-1 absolute left-1/2 -translate-x-1/2">
        {/* Win11 Start Button */}
        <button
          type="button"
          onClick={onToggleStart}
          aria-label="Start"
          aria-expanded={isStartOpen}
          className={`w-10 h-10 rounded-md flex items-center justify-center transition-all ${
            isStartOpen
              ? 'bg-blue-600/30 text-blue-400 ring-1 ring-blue-500/50'
              : 'hover:bg-white/10 text-blue-400'
          }`}
        >
          {/* Windows 11 4-square logo */}
          <div className="grid grid-cols-2 gap-0.5 w-4 h-4">
            <div className="bg-blue-500 rounded-sm" />
            <div className="bg-blue-400 rounded-sm" />
            <div className="bg-blue-400 rounded-sm" />
            <div className="bg-blue-500 rounded-sm" />
          </div>
        </button>

        {/* Taskbar Apps */}
        {apps.map((app) => {
          const state = getAppState(app.type);
          return (
            <button
              key={app.type}
              type="button"
              onClick={() => onToggleWindow(app.type)}
              title={app.label}
              className={`relative w-10 h-10 rounded-md flex items-center justify-center transition-all ${
                state === 'active'
                  ? 'bg-white/15 shadow-inner'
                  : state === 'open'
                  ? 'bg-white/10 hover:bg-white/15'
                  : 'hover:bg-white/10'
              }`}
            >
              {app.icon}
              {/* Active Indicator dot */}
              {state !== 'closed' && (
                <div
                  className={`absolute bottom-1 rounded-full transition-all ${
                    state === 'active' ? 'w-4 h-1 bg-blue-400' : 'w-1.5 h-1 bg-slate-400'
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Right Zone: System Tray */}
      <div className="flex items-center gap-1.5 text-xs text-slate-300">
        <button
          type="button"
          onClick={onOpenStatsPopover}
          className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-white/10 transition-colors"
          title={hardwareStats
            ? hardwareStats.wifiStationConnected
              ? `Station: ${hardwareStats.wifiStationSsid ?? 'connected'} (${hardwareStats.wifiStationIp ?? 'IP unavailable'})`
              : `Access point: ${hardwareStats.wifiApSsid ?? 'unavailable'} (${hardwareStats.wifiApIp ?? 'IP unavailable'})`
            : 'Live network telemetry unavailable'}
        >
          <div className="flex items-center gap-1.5 text-slate-400">
            <span title={usbMounted
              ? `${hardwareStats.usbManufacturer} ${hardwareStats.usbProduct} (${hardwareStats.usbTotalGb.toFixed(2)} GiB), mounted`
              : hardwareStats ? 'No USB storage mounted' : 'USB status unavailable'}>
              <HardDrive className={`w-4 h-4 ${usbMounted ? 'text-amber-400' : 'text-slate-500'}`} />
            </span>
            <span title={hardwareStats
              ? hardwareStats.wifiStationConnected
                ? `Connected to ${hardwareStats.wifiStationSsid ?? 'Wi-Fi'}`
                : `Access point ${hardwareStats.wifiApSsid ?? 'unavailable'}`
              : 'Wi-Fi status unavailable'}>
              <Wifi className={`w-4 h-4 ${
                hardwareStats?.wifiStationConnected ? 'text-cyan-400'
                  : hardwareStats?.wifiApSsid ? 'text-emerald-400' : 'text-slate-500'
              }`} />
            </span>
            {activeSsid && (
              <span className="text-[10px] font-mono text-cyan-300 hidden md:inline truncate max-w-[90px]">
                {activeSsid}
              </span>
            )}

            {/* Live Thermal Chip */}
            <span 
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                thermalData.isAboveWarningThreshold
                  ? 'bg-red-500/20 text-red-300 font-bold animate-pulse' 
                  : 'text-rose-300'
              }`}
              title={thermalData.sensorAvailable
                ? `ESP32-S3 on-die sensor: ${thermalData.dieTempC.toFixed(1)}°C / ${thermalData.dieTempF.toFixed(1)}°F`
                : `ESP32-S3 temperature unavailable: ${thermalData.sensorError ?? 'waiting for sensor'}`}
            >
              <Thermometer className={`w-3.5 h-3.5 ${thermalData.isAboveWarningThreshold ? 'text-red-400 animate-pulse' : 'text-rose-400'}`} />
              <span className="tabular-nums">{thermalData.sensorAvailable ? `${thermalData.dieTempC.toFixed(0)}°C` : '—°C'}</span>
            </span>

          </div>
        </button>

        {/* Clock & Date */}
        <button
          type="button"
          onClick={onOpenStatsPopover}
          className="flex flex-col items-end px-2 py-0.5 rounded-md hover:bg-white/10 transition-colors text-right"
        >
          <span className="text-[11px] font-medium text-slate-200 leading-tight tabular-nums">
            {timeStr}
          </span>
          <span className="text-[10px] text-slate-400 leading-tight tabular-nums">
            {dateStr}
          </span>
        </button>

        {/* Show Desktop sliver */}
        <div 
          className="w-1.5 h-8 border-l border-neutral-700/80 hover:bg-white/20 transition-colors cursor-pointer ml-1"
          title="Show Desktop"
          onClick={() => {
            // Can minimize all windows
          }}
        />
      </div>
    </footer>
  );
};
