import React, { useState, useEffect } from 'react';
import { 
  Cpu, 
  MemoryStick, 
  HardDrive, 
  Wifi, 
  Activity, 
  Layers, 
  Users, 
  RefreshCw, 
  CheckCircle2,
  Thermometer,
  ShieldAlert,
  Gauge,
  Zap,
  AlertTriangle
} from 'lucide-react';
import { authService } from '../../services/authService';
import { virtualFs } from '../../services/virtualFs';
import { thermalService } from '../../services/thermalService';
import { FirmwareSystemSnapshot, ThermalTelemetry } from '../../types';

const formatUptime = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return `${days}d ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
};

export const TaskManagerApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'performance' | 'processes' | 'users'>('performance');
  const [perfSubTab, setPerfSubTab] = useState<'cpu' | 'memory' | 'disk' | 'thermal' | 'wifi' | 'drivers'>('cpu');

  const [systemStats, setSystemStats] = useState<FirmwareSystemSnapshot | null>(null);
  const [systemStatsError, setSystemStatsError] = useState<string | null>(null);
  const [historyPoints, setHistoryPoints] = useState<number[]>([]);

  const [usbDisk, setUsbDisk] = useState(virtualFs.getUsbDiskInfo());
  const [users, setUsers] = useState(authService.getUsers());
  const [isDetectingDisk, setIsDetectingDisk] = useState(false);
  const [diskNotice, setDiskNotice] = useState<string | null>(null);

  // Thermal state
  const [thermalData, setThermalData] = useState<ThermalTelemetry>(thermalService.getTelemetry());
  const [tempUnit, setTempUnit] = useState<'C' | 'F'>('C');
  const [loadTestError, setLoadTestError] = useState<string | null>(null);
  const cpuCoreLoads = systemStats?.coreUtilizationPercent ?? [];
  const measuredCoreLoads = cpuCoreLoads.filter((value): value is number => value !== null);
  const cpuLoad = measuredCoreLoads.length
    ? measuredCoreLoads.reduce((total, value) => total + value, 0) / measuredCoreLoads.length
    : null;
  const core0 = cpuCoreLoads[0] ?? null;
  const core1 = cpuCoreLoads[1] ?? null;
  const psramTotalKb = (systemStats?.psramTotalBytes ?? 0) / 1024;
  const psramUsedKb = systemStats
    ? (systemStats.psramTotalBytes - systemStats.psramFreeBytes) / 1024
    : 0;
  const psramUsedPercent = systemStats && systemStats.psramTotalBytes > 0
    ? Math.min(100, (psramUsedKb * 1024 / systemStats.psramTotalBytes) * 100)
    : 0;

  const refreshSystemStats = async () => {
    try {
      const response = await fetch('/api/system/stats', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Firmware returned HTTP ${response.status}`);
      const snapshot = await response.json() as FirmwareSystemSnapshot;
      setSystemStats(snapshot);
      setSystemStatsError(snapshot.taskListError ?? null);
      const validLoads = snapshot.coreUtilizationPercent.filter(
        (value): value is number => value !== null && Number.isFinite(value),
      );
      if (validLoads.length > 0) {
        setHistoryPoints((previous) => [
          ...previous.slice(-29),
          validLoads.reduce((sum, value) => sum + value, 0) / validLoads.length,
        ]);
      }
    } catch (error) {
      setSystemStatsError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleStartLoadTest = async () => {
    setLoadTestError(null);
    try {
      await thermalService.startLoadTest();
    } catch (error) {
      setLoadTestError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAutoDetect = async () => {
    setIsDetectingDisk(true);
    setDiskNotice(null);
    try {
      const res = await virtualFs.autoDetectDisk();
      setUsbDisk(res);
      setDiskNotice(res.status === 'ONLINE'
        ? `Detected: ${res.vendor} ${res.model} (${res.vendorId}:${res.productId}, ${res.capacityGb.toFixed(2)} GiB)`
        : 'USB detection failed: no mass-storage drive is currently mounted on the ESP32.');
      setTimeout(() => setDiskNotice(null), 3500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDiskNotice(`USB detection failed: ${message}`);
    } finally {
      setIsDetectingDisk(false);
    }
  };

  useEffect(() => {
    const unsubFs = virtualFs.subscribe(() => {
      setUsbDisk(virtualFs.getUsbDiskInfo());
    });
    const unsubAuth = authService.subscribe(() => {
      setUsers(authService.getUsers());
    });
    const unsubThermal = thermalService.subscribe((telemetry) => {
      setThermalData(telemetry);
    });

    void refreshSystemStats();
    const interval = window.setInterval(() => void refreshSystemStats(), 2000);

    return () => {
      clearInterval(interval);
      unsubFs();
      unsubAuth();
      unsubThermal();
    };
  }, []);

  return (
    <div className="flex flex-col h-full bg-[#181d28] text-slate-100 select-none">
      {/* Top Tab Bar */}
      <div className="h-10 border-b border-neutral-700/60 px-3 flex items-center gap-1 bg-[#1d2331]">
        <button
          type="button"
          onClick={() => setActiveTab('performance')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            activeTab === 'performance' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-white/10'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>Performance (Hardware)</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('processes')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            activeTab === 'processes' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-white/10'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Processes</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            activeTab === 'users' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-white/10'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>Users</span>
        </button>
      </div>

      {/* Main Body */}
      {activeTab === 'performance' && (
        <div className="flex-1 flex overflow-hidden">
          {/* Sub sidebar */}
          <div className="w-60 border-r border-neutral-800 bg-[#141822] p-2 space-y-1 shrink-0 overflow-y-auto">
            {/* CPU Item */}
            <button
              type="button"
              onClick={() => setPerfSubTab('cpu')}
              className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left border transition-all ${
                perfSubTab === 'cpu'
                  ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                  : 'bg-transparent border-transparent hover:bg-white/5 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Cpu className="w-5 h-5 text-blue-400" />
                <div>
                  <div className="text-xs font-semibold">CPU</div>
                  <div className="text-[11px] text-slate-400">240 MHz Xtensa</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono font-medium">{cpuLoad === null ? '—' : `${cpuLoad.toFixed(1)}%`}</div>
                <div className="text-[10px] text-slate-500">{systemStats ? `${systemStats.cpuCores} cores` : 'Waiting'}</div>
              </div>
            </button>

            {/* Memory Item (8MB Octal PSRAM) */}
            <button
              type="button"
              onClick={() => setPerfSubTab('memory')}
              className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left border transition-all ${
                perfSubTab === 'memory'
                  ? 'bg-cyan-600/20 border-cyan-500/40 text-cyan-300'
                  : 'bg-transparent border-transparent hover:bg-white/5 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <MemoryStick className="w-5 h-5 text-cyan-400" />
                <div>
                  <div className="text-xs font-semibold">Memory</div>
                  <div className="text-[11px] text-slate-400">8MB Octal PSRAM</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono font-medium">{systemStats ? `${(psramUsedKb / 1024).toFixed(1)} / ${(psramTotalKb / 1024).toFixed(1)} MB` : '—'}</div>
                <div className="text-[10px] text-slate-500">Live heap</div>
              </div>
            </button>

            {/* Disk 0 Item (32GB USB-OTG) */}
            <button
              type="button"
              onClick={() => setPerfSubTab('disk')}
              className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left border transition-all ${
                perfSubTab === 'disk'
                  ? 'bg-amber-600/20 border-amber-500/40 text-amber-300'
                  : 'bg-transparent border-transparent hover:bg-white/5 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <HardDrive className="w-5 h-5 text-amber-400" />
                <div>
                  <div className="text-xs font-semibold">Disk 0 (D:)</div>
                  <div className="text-[11px] text-slate-400">USB MSC / FAT</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono font-medium">{systemStats?.usbMounted ? 'Mounted' : 'Offline'}</div>
                <div className="text-[10px] text-slate-500">I/O rate not sampled</div>
              </div>
            </button>

            {/* Thermal / Temperature Item */}
            <button
              type="button"
              onClick={() => setPerfSubTab('thermal')}
              className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left border transition-all ${
                perfSubTab === 'thermal'
                  ? 'bg-rose-600/20 border-rose-500/40 text-rose-300'
                  : 'bg-transparent border-transparent hover:bg-white/5 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Thermometer className={`w-5 h-5 ${thermalData.isAboveWarningThreshold ? 'text-red-400 animate-pulse' : 'text-rose-400'}`} />
                <div>
                  <div className="text-xs font-semibold">Thermal / Temp</div>
                  <div className="text-[11px] text-slate-400">On-Chip Sensor</div>
                </div>
              </div>
              <div className="text-right">
                <div className={`text-xs font-mono font-medium ${thermalData.isAboveWarningThreshold ? 'text-red-400 font-bold' : 'text-rose-300'}`}>
                  {thermalData.sensorAvailable ? (tempUnit === 'C' ? `${thermalData.dieTempC.toFixed(1)}°C` : `${thermalData.dieTempF.toFixed(1)}°F`) : '—'}
                </div>
                <div className={`text-[10px] ${thermalData.isAboveWarningThreshold ? 'text-red-400 font-bold animate-pulse' : 'text-slate-500'}`}>
                  {thermalData.sensorAvailable ? (thermalData.isAboveWarningThreshold ? 'Warning' : 'Live') : 'Unavailable'}
                </div>
              </div>
            </button>

            {/* Wi-Fi Item */}
            <button
              type="button"
              onClick={() => setPerfSubTab('wifi')}
              className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left border transition-all ${
                perfSubTab === 'wifi'
                  ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300'
                  : 'bg-transparent border-transparent hover:bg-white/5 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Wifi className="w-5 h-5 text-emerald-400" />
                <div>
                  <div className="text-xs font-semibold">Wi-Fi</div>
                  <div className="text-[11px] text-slate-400">SoftAP Server</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono font-medium">{systemStats?.wifiApIp ?? '—'}</div>
                <div className="text-[10px] text-slate-500">{systemStats?.wifiMode ?? 'Waiting'}</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setPerfSubTab('drivers')}
              className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left border transition-all ${
                perfSubTab === 'drivers'
                  ? 'bg-violet-600/20 border-violet-500/40 text-violet-300'
                  : 'bg-transparent border-transparent hover:bg-white/5 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Layers className="w-5 h-5 text-violet-400" />
                <div>
                  <div className="text-xs font-semibold">Drivers / HAL</div>
                  <div className="text-[11px] text-slate-400">Firmware components</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono font-medium">{systemStats?.drivers.length ?? '—'}</div>
                <div className="text-[10px] text-slate-500">reported</div>
              </div>
            </button>
          </div>

          {systemStatsError && (
            <div role="status" className="absolute right-4 top-12 z-10 max-w-md rounded-lg border border-amber-700/60 bg-amber-950/90 px-3 py-2 text-xs text-amber-200 shadow-xl">
              Firmware telemetry issue: {systemStatsError}
            </div>
          )}

          {/* Graph & Stats Detail Pane */}
          <div className="flex-1 p-6 overflow-y-auto space-y-6">
            {perfSubTab === 'cpu' && (
              <div>
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-xl font-bold text-white">CPU: {systemStats?.chipModel ?? 'ESP32-S3'} dual-core Xtensa LX7</h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {systemStats ? `${(systemStats.cpuFrequencyHz / 1_000_000).toFixed(0)} MHz · revision ${systemStats.chipRevision} · uptime ${formatUptime(systemStats.uptimeSeconds)}` : 'Waiting for firmware telemetry'}
                    </p>
                  </div>
                  <div className="text-3xl font-light font-mono text-blue-400">{cpuLoad === null ? '—' : `${cpuLoad.toFixed(1)}%`}</div>
                </div>

                {/* Real-time Load Graph */}
                <div className="h-44 bg-neutral-950/80 rounded-xl border border-neutral-800 p-4 flex items-end gap-2 relative overflow-hidden">
                  <div className="absolute top-2 left-3 text-[10px] font-mono text-slate-500">
                    Measured CPU utilization history (2-second samples)
                  </div>
                  {historyPoints.map((val, idx) => (
                    <div key={idx} className="flex-1 flex flex-col justify-end items-center h-full">
                      <div
                        style={{ height: `${val}%` }}
                        className="w-full bg-blue-500/80 rounded-t transition-all duration-300 shadow-sm"
                      />
                    </div>
                  ))}
                  {historyPoints.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
                      Waiting for a second firmware CPU sample…
                    </div>
                  )}
                </div>

                {/* Hardware Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6 text-xs">
                  <div className="p-3 bg-[#1d2331] rounded-xl border border-neutral-700/60">
                    <div className="text-slate-400">Core 0</div>
                    <div className="text-lg font-mono font-bold text-white mt-1">{core0 === null ? '—' : `${core0.toFixed(1)}%`}</div>
                    <div className="text-[10px] text-slate-400">Non-idle time, sampled from FreeRTOS</div>
                  </div>
                  <div className="p-3 bg-[#1d2331] rounded-xl border border-neutral-700/60">
                    <div className="text-slate-400">Core 1</div>
                    <div className="text-lg font-mono font-bold text-white mt-1">{core1 === null ? '—' : `${core1.toFixed(1)}%`}</div>
                    <div className="text-[10px] text-slate-400">Non-idle time, sampled from FreeRTOS</div>
                  </div>
                  <div className="p-3 bg-[#1d2331] rounded-xl border border-neutral-700/60">
                    <div className="text-slate-400">Base Clock Speed</div>
                    <div className="text-lg font-mono font-bold text-white mt-1">{systemStats ? `${(systemStats.cpuFrequencyHz / 1_000_000).toFixed(0)} MHz` : '—'}</div>
                    <div className="text-[10px] text-slate-400">Current ESP-IDF clock report</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPerfSubTab('thermal')}
                    className="p-3 bg-[#1d2331] hover:bg-[#252c3d] rounded-xl border border-neutral-700/60 text-left transition-colors cursor-pointer group"
                    title="View Full Thermal Telemetry"
                  >
                    <div className="flex items-center justify-between text-slate-400 group-hover:text-slate-200">
                      <span>Die Temperature</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                        thermalData.isAboveWarningThreshold 
                          ? 'bg-red-500/20 text-red-300 font-bold animate-pulse' 
                          : 'bg-rose-500/20 text-rose-300'
                      }`}>
                        {thermalData.sensorAvailable ? (thermalData.isAboveWarningThreshold ? 'HIGH TEMP' : 'LIVE') : 'WAITING'}
                      </span>
                    </div>
                    <div className="text-lg font-mono font-bold text-rose-400 mt-1">
                      {thermalData.sensorAvailable ? (tempUnit === 'C' ? `${thermalData.dieTempC.toFixed(1)} °C` : `${thermalData.dieTempF.toFixed(1)} °F`) : '—'}
                    </div>
                    <div className="text-[10px] text-slate-400">On-Chip Sensor (Click to inspect)</div>
                  </button>
                </div>
              </div>
            )}

            {perfSubTab === 'memory' && (
              <div>
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-xl font-bold text-white">Memory: ESP-IDF heap regions</h2>
                    <p className="text-xs text-slate-400 mt-0.5">Allocator-reported free, low-water mark, and largest contiguous block</p>
                  </div>
                  <div className="text-3xl font-light font-mono text-cyan-400">
                    {systemStats ? `${(psramUsedKb / 1024).toFixed(1)} / ${(psramTotalKb / 1024).toFixed(1)} MB` : '—'}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="h-6 bg-neutral-900 rounded-lg overflow-hidden flex border border-neutral-800">
                    <div style={{ width: `${psramUsedPercent}%` }} className="bg-cyan-500 h-full transition-all" title="PSRAM heap allocated" />
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>PSRAM heap in use: {systemStats ? `${psramUsedKb.toFixed(0)} KB` : '—'}</span>
                    <span>Free: {systemStats ? `${(systemStats.psramFreeBytes / 1024).toFixed(0)} KB` : '—'}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6 text-xs">
                  <div className="p-3 bg-[#1d2331] rounded-xl border border-neutral-700/60">
                    <div className="text-slate-400">PSRAM heap</div>
                    <div className="text-base font-mono font-bold text-cyan-300 mt-1">
                      {systemStats ? `${(systemStats.psramFreeBytes / 1024).toFixed(0)} KB free` : 'Unavailable'}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">
                      Min free: {systemStats ? `${(systemStats.psramMinimumFreeBytes / 1024).toFixed(0)} KB` : '—'} · Largest block: {systemStats ? `${(systemStats.psramLargestBlockBytes / 1024).toFixed(0)} KB` : '—'}
                    </div>
                  </div>
                  <div className="p-3 bg-[#1d2331] rounded-xl border border-neutral-700/60">
                    <div className="text-slate-400">Internal allocatable heap</div>
                    <div className="text-base font-mono font-bold text-white mt-1">
                      {systemStats ? `${(systemStats.internalHeapFreeBytes / 1024).toFixed(0)} / ${(systemStats.internalHeapTotalBytes / 1024).toFixed(0)} KB free/total` : 'Unavailable'}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">
                      Min free: {systemStats ? `${(systemStats.internalHeapMinimumFreeBytes / 1024).toFixed(0)} KB` : '—'} · Largest block: {systemStats ? `${(systemStats.internalHeapLargestBlockBytes / 1024).toFixed(0)} KB` : '—'}
                    </div>
                  </div>
                  <div className="p-3 bg-[#1d2331] rounded-xl border border-neutral-700/60">
                    <div className="text-slate-400">On-chip flash</div>
                    <div className="text-base font-mono font-bold text-white mt-1">
                      {systemStats?.flashSizeValid && systemStats.flashSizeBytes !== null
                        ? `${(systemStats.flashSizeBytes / (1024 * 1024)).toFixed(0)} MB`
                        : 'Unavailable'}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">Detected from the SPI flash chip at runtime.</div>
                  </div>
                </div>
              </div>
            )}

            {perfSubTab === 'disk' && (
              <div className="space-y-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                      <span>Disk 0 (D:): {usbDisk.capacityGb.toFixed(2)} GiB Flash Drive</span>
                      <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-mono border border-amber-500/30">
                        {usbDisk.vendor}
                      </span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">Physical capacity from SCSI; usage from the mounted FAT filesystem</p>
                  </div>
                  <div className="text-right">
                    <div className="text-3xl font-light font-mono text-amber-400">
                      {usbDisk.usedBytes === null ? 'Unavailable' : `${(usbDisk.usedBytes / (1024 ** 3)).toFixed(2)} GiB`} / {usbDisk.filesystemTotalBytes === null ? 'Unavailable' : `${(usbDisk.filesystemTotalBytes / (1024 ** 3)).toFixed(2)} GiB`}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Filesystem free: {usbDisk.filesystemFreeBytes === null ? 'Unavailable' : `${(usbDisk.filesystemFreeBytes / (1024 ** 3)).toFixed(2)} GiB`}
                    </div>
                    <div className="text-[11px] text-slate-400">Transfer rate: not measured by this firmware</div>
                  </div>
                </div>

                {diskNotice && (
                  <div className={`p-2.5 rounded-lg text-xs flex items-center gap-2 animate-in fade-in ${
                    diskNotice.startsWith('USB detection failed:')
                      ? 'bg-red-950/60 border border-red-800 text-red-300'
                      : 'bg-emerald-950/60 border border-emerald-800 text-emerald-300'
                  }`}>
                    {diskNotice.startsWith('USB detection failed:')
                      ? <AlertTriangle className="w-4 h-4 shrink-0" />
                      : <CheckCircle2 className="w-4 h-4 shrink-0" />}
                    <span>{diskNotice}</span>
                  </div>
                )}

                {/* Auto-Detect Action Banner */}
                <div className="p-3 bg-[#1d2331] rounded-xl border border-neutral-700/60 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs">
                    <div className={`w-2.5 h-2.5 rounded-full ${isDetectingDisk ? 'bg-amber-400 animate-ping' : 'bg-emerald-400'}`} />
                    <span className="text-slate-300">SCSI LUN 0 Status:</span>
                    <span className="font-mono text-white font-semibold">{usbDisk.status}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleAutoDetect()}
                      disabled={isDetectingDisk}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors shadow disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isDetectingDisk ? 'animate-spin' : ''}`} />
                      <span>{isDetectingDisk ? 'Querying SCSI...' : 'Auto-Detect Flash Drive Size'}</span>
                    </button>
                  </div>
                </div>

                {/* SCSI Inquiry & Drive Geometry */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800">
                    <div className="text-[10px] text-slate-400 font-sans">Capacity:</div>
                    <div className="text-sm font-bold text-amber-300 mt-0.5">{usbDisk.capacityGb.toFixed(2)} GiB</div>
                    <div className="text-[10px] text-slate-500 font-sans mt-0.5">{usbDisk.capacityBytes.toLocaleString()} B</div>
                    <div className="text-[10px] text-slate-400 font-sans mt-1">
                      Used: {usbDisk.usedBytes === null ? 'Unavailable' : `${(usbDisk.usedBytes / (1024 ** 3)).toFixed(2)} GiB`}
                    </div>
                  </div>

                  <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800">
                    <div className="text-[10px] text-slate-400 font-sans">Total Sectors:</div>
                    <div className="text-sm font-bold text-white mt-0.5">{usbDisk.totalSectors.toLocaleString()}</div>
                    <div className="text-[10px] text-slate-500 font-sans mt-0.5">{usbDisk.sectorSize.toLocaleString()} Bytes / Sector</div>
                  </div>

                  <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800">
                    <div className="text-[10px] text-slate-400 font-sans">Cluster Size:</div>
                    <div className="text-sm font-bold text-cyan-300 mt-0.5">{usbDisk.clusterSizeKb ? `${usbDisk.clusterSizeKb} KB` : 'Not reported'}</div>
                    <div className="text-[10px] text-slate-500 font-sans mt-0.5">File-system allocation</div>
                  </div>

                  <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800">
                    <div className="text-[10px] text-slate-400 font-sans">SCSI Vendor/Model:</div>
                    <div className="text-xs font-bold text-slate-200 mt-0.5 truncate">{usbDisk.vendorId}:{usbDisk.productId}</div>
                    <div className="text-[10px] text-slate-500 font-sans mt-0.5 truncate">{usbDisk.vendor} {usbDisk.model}</div>
                  </div>
                </div>

                <div className="p-4 bg-neutral-950/80 rounded-xl border border-neutral-800 space-y-3">
                  <div className="text-xs text-slate-300 font-semibold">USB Controller & Hardware Pinout</div>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    <div className="bg-neutral-900 p-2 rounded text-slate-300">
                      USB D- Data Pin: <span className="text-amber-400">GPIO 19</span>
                    </div>
                    <div className="bg-neutral-900 p-2 rounded text-slate-300">
                      USB D+ Data Pin: <span className="text-amber-400">GPIO 20</span>
                    </div>
                    <div className="bg-neutral-900 p-2 rounded text-slate-300">
                      USB VBUS Power: <span className="text-red-400">5V Rail</span>
                    </div>
                    <div className="bg-neutral-900 p-2 rounded text-slate-300">
                      Transfer Mode: <span className="text-emerald-400">Full Speed (12 Mbps)</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {perfSubTab === 'thermal' && (
              <div className="space-y-6">
                {/* Thermal Header */}
                <div className="flex flex-wrap justify-between items-start gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <Thermometer className="w-5 h-5 text-rose-400" />
                        <span>Thermal & Temperature Telemetry</span>
                      </h2>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold border ${
                        thermalData.isAboveWarningThreshold
                          ? 'bg-red-500/20 text-red-300 border-red-500/40 animate-pulse'
                          : thermalData.dieTempC > 60
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                          : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      }`}>
                        {!thermalData.sensorAvailable
                          ? 'SENSOR UNAVAILABLE'
                          : thermalData.isAboveWarningThreshold
                            ? 'ABOVE WARNING THRESHOLD'
                            : 'LIVE READING'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      ESP32-S3 on-die sensor through ESP-IDF; the page polls the firmware reading also written to the IDE serial log.
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* Unit Switcher */}
                    <div className="flex bg-neutral-900 p-0.5 rounded-lg border border-neutral-800 text-xs">
                      <button
                        type="button"
                        onClick={() => setTempUnit('C')}
                        className={`px-2.5 py-1 rounded font-mono font-medium transition-colors ${
                          tempUnit === 'C' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        °C
                      </button>
                      <button
                        type="button"
                        onClick={() => setTempUnit('F')}
                        className={`px-2.5 py-1 rounded font-mono font-medium transition-colors ${
                          tempUnit === 'F' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        °F
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => void thermalService.refreshNow()}
                      className="flex items-center gap-1.5 rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-rose-300 shadow transition-all hover:bg-neutral-700"
                      title="Read the real on-die temperature sensor now"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>Refresh sensor</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleStartLoadTest()}
                      disabled={!thermalData.sensorAvailable || thermalData.isLoadTestRunning}
                      className="flex items-center gap-1.5 rounded-xl border border-amber-700/60 bg-amber-950/40 px-3 py-1.5 text-xs font-semibold text-amber-200 shadow transition-all hover:bg-amber-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                      title="Runs a bounded 10-second CPU workload and reports the real sensor reading"
                    >
                      <Zap className="h-3.5 w-3.5" />
                      <span>{thermalData.isLoadTestRunning ? '10-second load running' : 'Run 10-second load test'}</span>
                    </button>
                  </div>
                  {loadTestError && (
                    <p role="alert" className="mt-2 text-xs text-red-300">{loadTestError}</p>
                  )}
                  {thermalData.isLoadTestRunning && (
                    <p role="status" className="mt-2 text-xs text-amber-200">
                      Bounded CPU workload active. Temperature remains a live on-die sensor measurement.
                    </p>
                  )}
                </div>

                {/* Primary Temperature Highlight & 60-Second Real-Time Graph */}
                <div className="p-5 bg-neutral-950/80 rounded-2xl border border-neutral-800 space-y-4">
                  <div className="flex justify-between items-end pb-2 border-b border-neutral-800">
                    <div>
                      <div className="text-[11px] text-slate-400">ESP32-S3 on-die sensor reading:</div>
                      <div className="text-4xl font-light font-mono text-rose-400 flex items-baseline gap-2 mt-1">
                        <span>{thermalData.sensorAvailable ? (tempUnit === 'C' ? `${thermalData.dieTempC.toFixed(1)}°C` : `${thermalData.dieTempF.toFixed(1)}°F`) : '—'}</span>
                        <span className="text-sm font-sans font-normal text-slate-400">
                          {thermalData.sensorAvailable && `(${tempUnit === 'C' ? `${thermalData.dieTempF.toFixed(1)}°F` : `${thermalData.dieTempC.toFixed(1)}°C`})`}
                        </span>
                      </div>
                    </div>

                    <div className="flex gap-4 text-xs font-mono">
                      <div>
                        <span className="text-slate-500 text-[10px] font-sans">Session min:</span>
                        <div className="text-slate-200">
                          {thermalData.sensorAvailable ? (tempUnit === 'C' ? `${thermalData.minTempC.toFixed(1)}°C` : `${((thermalData.minTempC * 9)/5+32).toFixed(1)}°F`) : '—'}
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500 text-[10px] font-sans">Session max:</span>
                        <div className="text-rose-300 font-bold">
                          {thermalData.sensorAvailable ? (tempUnit === 'C' ? `${thermalData.maxTempC.toFixed(1)}°C` : `${((thermalData.maxTempC * 9)/5+32).toFixed(1)}°F`) : '—'}
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500 text-[10px] font-sans">Display warning:</span>
                        <div className="text-amber-400">
                          {tempUnit === 'C' ? '75.0°C' : '167.0°F'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Real-time 60-second Thermal History Graph */}
                  <div className="h-44 bg-[#10141f] rounded-xl border border-neutral-800/80 p-4 relative overflow-hidden flex flex-col justify-between">
                    {/* Reference threshold lines */}
                    <div className="absolute inset-x-0 top-3 px-4 flex justify-between items-center text-[10px] font-mono text-red-400/70 border-b border-red-500/20 pb-0.5 pointer-events-none">
                      <span>85°C · Critical display threshold (not a hardware cutoff)</span>
                      <span>CRITICAL</span>
                    </div>
                    <div className="absolute inset-x-0 top-14 px-4 flex justify-between items-center text-[10px] font-mono text-amber-400/60 border-b border-dashed border-amber-500/30 pb-0.5 pointer-events-none">
                      <span>75°C · UI warning threshold (no automatic throttling configured)</span>
                      <span>WARNING</span>
                    </div>

                    <div className="flex-1 flex items-end gap-2 pt-16 pb-2 z-10">
                      {thermalData.history.map((pt, idx) => {
                        const min = 30;
                        const max = 85;
                        const heightPct = Math.min(100, Math.max(10, ((pt.tempC - min) / (max - min)) * 100));
                        const isHot = pt.tempC >= 75;
                        const isWarm = pt.tempC >= 55;
                        return (
                          <div 
                            key={idx} 
                            className="flex-1 flex flex-col justify-end items-center h-full group relative"
                          >
                            <div
                              style={{ height: `${heightPct}%` }}
                              className={`w-full rounded-t transition-all duration-300 shadow-sm ${
                                isHot
                                  ? 'bg-red-500 shadow-red-500/40'
                                  : isWarm
                                  ? 'bg-amber-500 shadow-amber-500/30'
                                  : 'bg-emerald-500/90 shadow-emerald-500/20'
                              }`}
                            />
                            {/* Hover Tooltip */}
                            <div className="absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center bg-neutral-900 border border-neutral-700 text-white text-[10px] p-1.5 rounded shadow-xl whitespace-nowrap z-50 pointer-events-none font-mono">
                              <div>{tempUnit === 'C' ? `${pt.tempC.toFixed(1)}°C` : `${((pt.tempC * 9)/5+32).toFixed(1)}°F`}</div>
                              <div className="text-slate-400">{pt.time}</div>
                            </div>

                            {!thermalData.sensorAvailable && (
                              <p role="status" className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 text-center text-xs text-slate-200">
                                Sensor reading unavailable. {thermalData.sensorError}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex justify-between text-[10px] text-slate-500 font-mono pt-1 border-t border-neutral-800">
                      <span>-60 Seconds</span>
                      <span>-30 Seconds</span>
                      <span>Now ({thermalData.history[thermalData.history.length - 1]?.time || '—'})</span>
                    </div>
                  </div>
                </div>

                {/* Multi-Zone Hardware Thermal Breakdown Cards */}
                <div>
                  <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                    <Gauge className="w-4 h-4 text-cyan-400" />
                    <span>Available temperature sensor</span>
                  </h3>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    {thermalData.zones.map((zone) => {
                      const displayTemp = tempUnit === 'C' 
                        ? `${zone.tempC.toFixed(1)} °C` 
                        : `${((zone.tempC * 9)/5 + 32).toFixed(1)} °F`;
                      const pctOfCritical = Math.min(100, Math.round((zone.tempC / zone.criticalDisplayC) * 100));
                      return (
                        <div key={zone.id} className="p-3.5 bg-[#1d2331] rounded-xl border border-neutral-700/60 space-y-2.5">
                          <div className="flex justify-between items-start">
                            <div>
                              <div className="font-semibold text-white">{zone.name}</div>
                              <div className="text-[11px] text-slate-400 mt-0.5">{zone.component}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-base font-mono font-bold text-rose-300">{displayTemp}</div>
                              <span className={`text-[10px] px-1.5 py-0.2 rounded font-mono uppercase ${
                                zone.status === 'critical'
                                  ? 'bg-red-500/20 text-red-300 font-bold animate-pulse'
                                  : zone.status === 'hot'
                                  ? 'bg-amber-500/20 text-amber-300 font-semibold'
                                  : 'bg-emerald-500/20 text-emerald-300'
                              }`}>
                                {zone.status}
                              </span>
                            </div>
                          </div>

                          <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-slate-400">
                              <span>Percent of UI critical threshold</span>
                              <span className="font-mono">{pctOfCritical}%</span>
                            </div>
                            <div className="w-full h-1.5 bg-neutral-900 rounded-full overflow-hidden">
                              <div 
                                style={{ width: `${pctOfCritical}%` }}
                                className={`h-full rounded-full transition-all duration-300 ${
                                  pctOfCritical >= 85
                                    ? 'bg-red-500'
                                    : pctOfCritical >= 70
                                    ? 'bg-amber-500'
                                    : 'bg-emerald-500'
                                }`}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Technical Specifications & Throttling Policy Card */}
                <div className="p-4 bg-[#141822] rounded-xl border border-neutral-800 space-y-2.5 text-xs">
                  <div className="flex items-center gap-2 font-semibold text-white">
                    <ShieldAlert className="w-4 h-4 text-amber-400" />
                    <span>ESP-IDF temperature telemetry</span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    This is the ESP32-S3 internal sensor only. It does not measure the flash drive, PSRAM, Wi-Fi chip, or room temperature. Readings are polled from the same sensor task that logs values over ESP-IDF serial. The 75°C and 85°C values are UI reference thresholds only; this firmware does not configure dynamic frequency throttling or an emergency hardware cutoff.
                  </p>
                  <div className="p-2.5 bg-black/50 rounded-lg font-mono text-[10px] text-slate-300 space-y-1 border border-neutral-800">
                    <div className="text-slate-500">// Values originate in the firmware sensor task</div>
                    <div className="text-emerald-400">temperature_sensor_get_celsius(sensor, &amp;temperature_celsius);</div>
                  </div>
                </div>
              </div>
            )}

            {perfSubTab === 'wifi' && (
              <div>
                <h2 className="text-xl font-bold text-white mb-2">Wi-Fi: ESP-IDF driver status</h2>
                <div className="p-4 bg-[#1d2331] rounded-xl border border-neutral-700/60 space-y-2 text-xs">
                  <div>Driver: <span className="font-mono text-emerald-300">{systemStats?.wifiDriverStarted ? 'started' : 'unavailable'}</span></div>
                  <div>Mode: <span className="font-mono text-slate-200">{systemStats?.wifiMode ?? '—'}</span></div>
                  <div>Access point SSID: <span className="font-mono text-slate-200">{systemStats?.wifiApSsid ?? 'Unavailable'}</span></div>
                  <div>Access point IP: <span className="font-mono text-blue-300">{systemStats?.wifiApIp ?? 'Unavailable'}</span></div>
                  <div>Connected AP clients: <span className="font-mono text-white">{systemStats?.wifiApClientCount ?? 'Unavailable'}</span></div>
                  <div className="border-t border-neutral-700 pt-2">Station connected: <span className="font-mono text-slate-200">{systemStats?.wifiStationConnected ? 'Yes' : 'No'}</span></div>
                  <div>Station network: <span className="font-mono text-slate-200">{systemStats?.wifiStationSsid ?? 'Not connected'}</span></div>
                  <div>Station IP: <span className="font-mono text-blue-300">{systemStats?.wifiStationIp ?? 'Unavailable'}</span></div>
                  <div>Web server: <span className="font-mono text-slate-200">{systemStats?.httpServerRunning ? 'Running on port 80' : 'Stopped'}</span></div>
                </div>
                <p className="mt-2 text-[10px] text-slate-500">Wi-Fi credentials are intentionally never returned by the telemetry API.</p>
              </div>
            )}

            {perfSubTab === 'drivers' && (
              <div>
                <h2 className="text-xl font-bold text-white mb-2">Active firmware drivers and subsystems</h2>
                <p className="mb-4 text-xs text-slate-400">
                  Runtime status reported by this firmware and ESP-IDF driver APIs. Statically linked HAL code and interrupt handlers do not each appear as separate runtime processes.
                </p>
                {systemStats?.drivers.length ? (
                  <div className="space-y-2">
                    {systemStats.drivers.map((driver) => (
                      <div key={driver.name} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-700/60 bg-[#1d2331] p-3 text-xs">
                        <div>
                          <div className="font-semibold text-white">{driver.name}</div>
                          {driver.details && <div className="mt-1 text-[10px] text-slate-400">{driver.details}</div>}
                          {driver.allocatedBytes !== undefined && (
                            <div className="mt-1 text-[10px] text-slate-400">{driver.allocatedBytes.toLocaleString()} bytes</div>
                          )}
                        </div>
                        <span className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-1 font-mono text-violet-200">{driver.state}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-neutral-700/60 bg-[#1d2331] p-4 text-xs text-slate-400">
                    Waiting for firmware driver telemetry.
                  </div>
                )}
                <div className="mt-4 rounded-xl border border-neutral-700/60 bg-[#141822] p-3 text-[11px] text-slate-400">
                  Allowlisted GPIO outputs: {systemStats?.gpioOutputs.map((gpio) =>
                    `GPIO ${gpio.pin}: ${gpio.configured ? `configured, level ${gpio.level}` : 'not configured'}`,
                  ).join(' · ') ?? 'Unavailable'}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Processes Tab */}
      {activeTab === 'processes' && (
        <div className="flex-1 p-4 overflow-y-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-neutral-700/80 text-slate-400 pb-2">
                <th className="py-2 px-3 font-semibold">Name</th>
                <th className="py-2 px-3 font-semibold">Task #</th>
                <th className="py-2 px-3 font-semibold">State</th>
                <th className="py-2 px-3 font-semibold">Priority</th>
                <th className="py-2 px-3 font-semibold">Core affinity</th>
                <th className="py-2 px-3 font-semibold">Minimum free stack</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {(systemStats?.tasks ?? []).map((task) => (
                <tr key={task.taskNumber} className="hover:bg-white/5 transition-colors">
                  <td className="py-2.5 px-3 font-medium text-white font-mono">{task.name}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-400">{task.taskNumber}</td>
                  <td className="py-2.5 px-3 font-mono text-blue-300">{task.state}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-300">{task.priority}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-300">{task.coreAffinity < 0 ? 'Any' : `Core ${task.coreAffinity}`}</td>
                  <td className="py-2.5 px-3 font-mono text-cyan-300">{task.stackHighWaterBytes.toLocaleString()} B</td>
                </tr>
              ))}
              {systemStats && systemStats.tasks.length === 0 && (
                <tr><td colSpan={6} className="p-4 text-center text-slate-400">{systemStats.taskListError ?? 'No FreeRTOS tasks reported.'}</td></tr>
              )}
              {!systemStats && (
                <tr><td colSpan={6} className="p-4 text-center text-slate-400">
                  {systemStatsError ? `Firmware task telemetry unavailable: ${systemStatsError}` : 'Waiting for firmware task telemetry…'}
                </td></tr>
              )}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] text-slate-500">
            These are live FreeRTOS tasks, not Windows processes. Per-task heap and disk I/O are not tracked by this firmware; the stack column is each task’s minimum-ever remaining stack.
          </p>
        </div>
      )}

      {/* Users Tab */}
      {activeTab === 'users' && (
        <div className="flex-1 p-6 overflow-y-auto">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-4">
            Active User Profiles on 32GB USB Storage
          </h2>
          <div className="space-y-3">
            {users.map((u) => (
              <div key={u.id} className="p-4 bg-[#1d2331] rounded-xl border border-neutral-700/60 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <img src={u.avatar} alt="" className="w-10 h-10 rounded-full object-cover ring-2 ring-white/10" />
                  <div>
                    <div className="text-sm font-medium text-white">{u.displayName} ({u.username})</div>
                    <div className="text-xs text-slate-400">
                      {u.isAdmin ? 'Administrator' : 'Standard User'} · UAC Level {u.uacLevel}
                    </div>
                  </div>
                </div>
                <div className="text-xs font-mono text-emerald-400">
                  {u.username === authService.getCurrentUser().username ? 'Active Session' : 'Offline'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
