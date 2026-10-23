import React, { useState } from 'react';
import defaultWallpaper from './assets/images/win11_bloom_wallpaper_1791021193516.jpg';
import { 
  Folder, 
  Terminal as TerminalIcon, 
  Cpu, 
  Settings as SettingsIcon, 
  FileText, 
  Code2, 
  Sliders, 
  Trash2, 
  HardDrive, 
  Music2,
  Calculator,
  FileSpreadsheet,
  ToggleRight,
  Globe2,
  ShieldAlert,
  Info,
  Sparkles
} from 'lucide-react';

import { AppWindow, FirmwareSystemSnapshot, WindowAppType, UacRequest, ThermalTelemetry, OtaStatus } from './types';
import { authService } from './services/authService';
import { virtualFs, UsbDiskInfo } from './services/virtualFs';
import { thermalService } from './services/thermalService';
import { storageService } from './services/storageService';

import { LockScreen } from './components/LockScreen';
import { Taskbar } from './components/Taskbar';
import { StartMenu } from './components/StartMenu';
import { WindowFrame } from './components/WindowFrame';
import { UacModal } from './components/UacModal';

import { FileExplorer } from './components/apps/FileExplorer';
import { TaskManagerApp } from './components/apps/Taskmgr';
import { TerminalApp } from './components/apps/Terminal';
import { NotepadApp } from './components/apps/Notepad';
import { SettingsApp } from './components/apps/SettingsApp';
import { FirmwareViewerApp } from './components/apps/FirmwareViewer';
import { HardwareGuideApp } from './components/HardwareGuide';
import { MediaPlayerApp } from './components/apps/MediaPlayer';
import { CalculatorApp } from './components/apps/CalculatorApp';
import { OfficeSuiteApp } from './components/apps/OfficeSuiteApp';
import { HardwareControlsApp } from './components/apps/HardwareControlsApp';
import { RemoteBrowserApp } from './components/apps/RemoteBrowser';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { SnakeGame } from './components/apps/SnakeGame';
import { MinesweeperApp } from './components/apps/MinesweeperApp';
import { PongGame } from './components/apps/PongGame';
import { WindowsUpdateScreen } from './components/apps/WindowsUpdateScreen';
import { UpdateManagerApp } from './components/apps/UpdateManagerApp';
import { DnsFilteringApp } from './components/apps/DnsFilteringApp';
import { PlatformProvider, ResourceGuard, AppSandbox, AppManifest, appRegistry, DynamicAppRunner } from './platform';
import { SampleDevApp } from './components/apps/SampleDevApp';
import { MyGame, MY_GAME_MANIFEST } from './components/apps/MyGame';

const INITIAL_WINDOWS: AppWindow[] = [
  {
    id: 'win_explorer',
    appType: 'explorer',
    title: 'File Explorer - USB Drive (D:)',
    icon: '📁',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 10,
    x: 80,
    y: 60,
    width: 820,
    height: 520,
  },
  {
    id: 'win_taskmgr',
    appType: 'taskmgr',
    title: 'Task Manager (ESP32-S3 N16R8 Hardware Monitor)',
    icon: '⚡',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 12,
    x: 180,
    y: 110,
    width: 800,
    height: 520,
  },
  {
    id: 'win_terminal',
    appType: 'terminal',
    title: 'Command Prompt - Administrator',
    icon: '💻',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 13,
    x: 220,
    y: 130,
    width: 740,
    height: 480,
    requiresAdmin: true,
  },
  {
    id: 'win_notepad',
    appType: 'notepad',
    title: 'Notepad',
    icon: '📝',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 14,
    x: 260,
    y: 150,
    width: 680,
    height: 460,
  },
  {
    id: 'win_settings',
    appType: 'settings',
    title: 'Settings - Accounts & UAC Security',
    icon: '⚙️',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 15,
    x: 120,
    y: 70,
    width: 780,
    height: 530,
  },
  {
    id: 'win_firmware',
    appType: 'firmware',
    title: 'ESP-IDF v5 Source Code Suite & Exporter',
    icon: '📦',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 16,
    x: 100,
    y: 50,
    width: 880,
    height: 560,
  },
  {
    id: 'win_hardware',
    appType: 'hardware',
    title: 'Hardware & USB-OTG Wiring Schematic',
    icon: '🔌',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 17,
    x: 160,
    y: 80,
    width: 840,
    height: 540,
  },
  {
    id: 'win_media',
    appType: 'media',
    title: 'Media Player',
    icon: '🎵',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 18,
    x: 190,
    y: 80,
    width: 900,
    height: 600,
  },
  {
    id: 'win_calculator',
    appType: 'calculator',
    title: 'Calculator',
    icon: '🧮',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 19,
    x: 260,
    y: 120,
    width: 420,
    height: 600,
  },
  {
    id: 'win_office',
    appType: 'office',
    title: 'Productivity Suite',
    icon: '📊',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 20,
    x: 100,
    y: 55,
    width: 960,
    height: 660,
  },
  {
    id: 'win_hardware_controls',
    appType: 'hardwareControls',
    title: 'Hardware Controls',
    icon: '🔌',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 21,
    x: 180,
    y: 90,
    width: 720,
    height: 520,
  },
  {
    id: 'win_remote_browser',
    appType: 'remoteBrowser',
    title: 'LAN Browser Bridge',
    icon: '🌐',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 22,
    x: 80,
    y: 45,
    width: 960,
    height: 680,
  },
  {
    id: 'win_snake',
    appType: 'snake',
    title: 'Snake',
    icon: '🐍',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 23,
    x: 120,
    y: 60,
    width: 480,
    height: 520,
  },
  {
    id: 'win_minesweeper',
    appType: 'minesweeper',
    title: 'Minesweeper',
    icon: '💣',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 24,
    x: 150,
    y: 70,
    width: 500,
    height: 560,
  },
  {
    id: 'win_pong',
    appType: 'pong',
    title: 'Pong',
    icon: '🏓',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 25,
    x: 160,
    y: 80,
    width: 620,
    height: 480,
  },
  {
    id: 'win_update_manager',
    appType: 'updateManager',
    title: 'Windows Update',
    icon: '🔄',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 26,
    x: 180,
    y: 90,
    width: 680,
    height: 500,
  },
  {
    id: 'win_dev_studio',
    appType: 'devStudio',
    title: 'App Platform Studio (Safeguard Sandbox)',
    icon: '✨',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 27,
    x: 140,
    y: 70,
    width: 760,
    height: 540,
  },
  {
    id: 'win_dynamic_app',
    appType: 'dynamicApp',
    title: 'Custom Web App (Imported)',
    icon: '🚀',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 28,
    x: 160,
    y: 80,
    width: 780,
    height: 560,
  },
  {
    id: 'win_dns_filtering',
    appType: 'dnsFiltering',
    title: 'DNS Filtering',
    icon: '🛡️',
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 29,
    x: 180,
    y: 80,
    width: 680,
    height: 600,
  },
];

const DEV_STUDIO_MANIFEST: AppManifest = {
  id: 'dev-studio',
  name: 'App Platform Studio',
  version: '1.0.0',
  description: 'ESP32-S3 app developer studio and watchdog monitor',
  icon: '✨',
  tileColor: 'bg-violet-500/10',
  appType: 'devStudio',
  permissions: ['network', 'notifications', 'hardware', 'openApps', 'interAppMessage'],
  resourceLimits: {
    maxRenderCount: 500,
    maxRenderMs: 250,
  },
  windowDefaults: {
    width: 760,
    height: 540,
  },
  component: SampleDevApp,
};

if (!appRegistry.get('dev-studio')) {
  appRegistry.register(DEV_STUDIO_MANIFEST);
}
if (!appRegistry.get('my-game')) {
  appRegistry.register(MY_GAME_MANIFEST);
}

export default function App() {
  const [isLocked, setIsLocked] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [wallpaper, setWallpaper] = useState<string>(() => {
    return localStorage.getItem('esp32s3_win11_custom_wallpaper') || defaultWallpaper;
  });
  const [usbDisk, setUsbDisk] = useState<UsbDiskInfo>(virtualFs.getUsbDiskInfo());
  const [windows, setWindows] = useState<AppWindow[]>(INITIAL_WINDOWS);
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null);
  const [maxZIndex, setMaxZIndex] = useState(20);
  const [isStartOpen, setIsStartOpen] = useState(false);
  const [uacRequest, setUacRequest] = useState<UacRequest | null>(null);
  const [notepadData, setNotepadData] = useState<{ filePath?: string; initialContent?: string }>({});
  const [dynamicAppData, setDynamicAppData] = useState<{ appCode: string; appName: string }>({
    appCode: '<h1>Custom App</h1><p>Upload an HTML/JS file to run it here.</p>',
    appName: 'Custom App',
  });
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [usbToast, setUsbToast] = useState(false);
  const [thermalData, setThermalData] = useState<ThermalTelemetry>(thermalService.getTelemetry());
  const [hardwareStats, setHardwareStats] = useState<FirmwareSystemSnapshot | null>(null);
  const [showUpdateScreen, setShowUpdateScreen] = useState(false);
  const [otaStatus, setOtaStatus] = useState<OtaStatus | null>(null);

  const restoreDesktopState = (userId: string) => {
    const saved = authService.getDesktopState(userId);
    if (!saved) return;
    if (saved.wallpaper?.startsWith('data:image/')) {
      const user = authService.getUsers().find((item) => item.id === userId);
      const profileName = user?.username.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 31) || 'User';
      const usbWallpaperUrl = `/api/profiles/current/wallpaper?profile=${encodeURIComponent(profileName)}`;
      setWallpaper(usbWallpaperUrl);
      void fetch(usbWallpaperUrl, { cache: 'no-store' }).then(async (response) => {
        if (!response.ok) {
          setWallpaper(saved.wallpaper!);
          return;
        }
        await authService.updateDesktopState(userId, { wallpaper: usbWallpaperUrl });
      }).catch(() => setWallpaper(saved.wallpaper!));
    } else if (saved.wallpaper) {
      setWallpaper(saved.wallpaper);
    }
    if (saved.windows) {
      setWindows(INITIAL_WINDOWS.map((initial) => {
        const persisted = saved.windows?.find((item) => item.appType === initial.appType);
        return persisted ? { ...initial, ...persisted } : initial;
      }));
    }
    const activeType = saved.activeAppType;
    const active = activeType
      ? INITIAL_WINDOWS.find((item) => item.appType === activeType)
      : undefined;
    setActiveWindowId(active?.id ?? null);
  };

  const saveDesktopState = React.useCallback(async () => {
    const activeAppType = windows.find((item) => item.id === activeWindowId)?.appType ?? null;
    return authService.updateDesktopState(authService.getCurrentUser().id, {
      wallpaper,
      activeAppType,
      windows: windows.map((item) => ({
        appType: item.appType,
        isOpen: item.isOpen,
        isMinimized: item.isMinimized,
        isMaximized: item.isMaximized,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      })),
    });
  }, [activeWindowId, wallpaper, windows]);

  const requestSystemPower = async (
    endpoint: '/api/system/reboot' | '/api/system/shutdown',
    action: 'restart' | 'shutdown preparation',
  ): Promise<boolean> => {
    const password = window.prompt(`Enter the administrator password to request ${action}:`);
    if (password === null) return false;
    try {
      if (!await saveDesktopState()) throw new Error('Could not save desktop state before the power operation.');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        let message = `Power request failed (HTTP ${response.status}).`;
        try {
          const body = await response.json() as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // Keep the HTTP status message when the server returns a plain-text error.
        }
        throw new Error(message);
      }
      if (endpoint === '/api/system/shutdown') {
        window.alert('Shutdown preparation started. Wait for the purple WS2812 LED, then cut power using your external hardware.');
      } else {
        window.alert('Restart requested. The ESP32 will restart after logs and USB storage are flushed.');
      }
      return true;
    } catch (error) {
      console.error(`System ${action} request failed`, error);
      window.alert(error instanceof Error ? error.message : `System ${action} request failed.`);
      return false;
    }
  };

  React.useEffect(() => {
    void authService.initialize().finally(() => {
      restoreDesktopState(authService.getCurrentUser().id);
      setAuthReady(true);
    });
  }, []);

  React.useEffect(() => {
    if (!authReady || isLocked) return;
    const saveTimeout = window.setTimeout(saveDesktopState, 500);
    return () => window.clearTimeout(saveTimeout);
  }, [authReady, isLocked, saveDesktopState]);

  // Subscribe to device telemetry and virtual filesystem updates
  React.useEffect(() => {
    let lastUsbInfo = virtualFs.getUsbDiskInfo();
    let toastTimeout: number | undefined;
    const unsubThermal = thermalService.subscribe((t) => setThermalData(t));
    const unsubFs = virtualFs.subscribe(() => {
      const current = virtualFs.getUsbDiskInfo();
      setUsbDisk(current);
      const changed = current.status !== lastUsbInfo.status ||
        current.capacityBytes !== lastUsbInfo.capacityBytes ||
        current.vendorId !== lastUsbInfo.vendorId ||
        current.productId !== lastUsbInfo.productId;
      if (changed && (current.status === 'ONLINE' || lastUsbInfo.status === 'ONLINE')) {
        setUsbToast(true);
        window.clearTimeout(toastTimeout);
        toastTimeout = window.setTimeout(() => setUsbToast(false), 5000);
      }
      lastUsbInfo = current;
    });
    const refreshUsbDisk = () => {
      void virtualFs.autoDetectDisk(false).catch((error: unknown) => {
        console.warn('Live USB device detection failed:', error);
      });
    };
    const refreshHardwareStats = async () => {
      try {
        const response = await fetch('/api/system/stats', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Hardware telemetry query failed with HTTP ${response.status}.`);
        }
        setHardwareStats(await response.json() as FirmwareSystemSnapshot);
      } catch (error) {
        setHardwareStats(null);
        console.warn('Live ESP32 telemetry is unavailable:', error);
      }
    };
    refreshUsbDisk();
    void refreshHardwareStats();
    // Initialize storage service with current origin
    storageService.setBaseUrl(window.location.origin);
    const usbPollInterval = window.setInterval(refreshUsbDisk, 5000);
    const statsPollInterval = window.setInterval(() => void refreshHardwareStats(), 5000);
    return () => {
      window.clearInterval(usbPollInterval);
      window.clearInterval(statsPollInterval);
      window.clearTimeout(toastTimeout);
      unsubThermal();
      unsubFs();
    };
  }, []);

  // OTA status polling — runs only while the update screen is active
  React.useEffect(() => {
    if (!showUpdateScreen) return;
    let isActive = true;
    let timeoutId: number | undefined;
    const stateOrder: Record<OtaStatus['state'], number> = {
      idle: 0,
      reading: 1,
      writing: 2,
      verifying: 3,
      done: 4,
      error: 4,
    };
    const poll = async () => {
      try {
        const res = await fetch('/api/system/ota/status', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`OTA status query failed with HTTP ${res.status}.`);
        }
        const status = await res.json() as OtaStatus;
        if (isActive) {
          setOtaStatus((current) => {
            if (!current) return status;
            if (current.state === 'reading' && status.state === 'done') return current;
            if (stateOrder[status.state] < stateOrder[current.state]) return current;
            if (
              current.state === status.state &&
              status.progressPercent < current.progressPercent
            ) return current;
            return status;
          });
        }
      } catch (error) {
        if (isActive) console.warn('Live OTA status is temporarily unavailable:', error);
      } finally {
        if (isActive) timeoutId = window.setTimeout(() => void poll(), 500);
      }
    };
    timeoutId = window.setTimeout(() => void poll(), 500);
    return () => {
      isActive = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [showUpdateScreen]);

  // Re-render when new apps are registered in appRegistry
  const [, setRegistryVersion] = useState(0);
  React.useEffect(() => {
    return appRegistry.subscribe(() => {
      setRegistryVersion((v) => v + 1);
    });
  }, []);

  // Handle programmatic app open events dispatched from platform SDK
  React.useEffect(() => {
    const handlePlatformOpen = (e: Event) => {
      const customEvent = e as CustomEvent<{ appId: string; data?: any }>;
      const targetId = customEvent.detail?.appId;
      if (!targetId) return;

      const registered = appRegistry.get(targetId);
      const appType = (registered?.appType || (targetId === 'dev-studio' ? 'devStudio' : targetId)) as WindowAppType;
      openWindow(appType, customEvent.detail?.data);
    };

    window.addEventListener('platform:openApp', handlePlatformOpen);
    return () => window.removeEventListener('platform:openApp', handlePlatformOpen);
  }, [windows, maxZIndex]);

  const handleSetWallpaper = (newUrl: string) => {
    setWallpaper(newUrl);
    try {
      localStorage.setItem('esp32s3_win11_custom_wallpaper', newUrl);
    } catch (e) {
      console.warn('Could not save wallpaper to localStorage', e);
    }
  };

  // Focus a window
  const focusWindow = (id: string) => {
    const nextZ = maxZIndex + 1;
    setMaxZIndex(nextZ);
    setActiveWindowId(id);
    setWindows(prev => prev.map(w => w.id === id ? { ...w, zIndex: nextZ, isMinimized: false } : w));
  };

  // Open or toggle an application window
  const openWindow = (type: WindowAppType, data?: any) => {
    setIsStartOpen(false);
    if (type === 'notepad' && data) {
      setNotepadData(data);
    }
    if (type === 'dynamicApp' && data) {
      setDynamicAppData({
        appCode: data.appCode || '',
        appName: data.appName || 'Custom Web App',
      });
    }

    const nextZ = maxZIndex + 1;
    setMaxZIndex(nextZ);

    const targetRegistered = appRegistry.get(type) || appRegistry.getAll().find(a => a.id === type || a.appType === type);

    // Look for existing window by appType, id, or registered id
    const foundWindow = windows.find(
      w => w.appType === type || 
           w.id === type || 
           w.id === `win_${type}` ||
           (targetRegistered && (w.appType === targetRegistered.appType || w.id === `win_${targetRegistered.id}`))
    );

    if (foundWindow) {
      setWindows(prev => prev.map(w => {
        if (w.id === foundWindow.id) {
          return {
            ...w,
            isOpen: true,
            isMinimized: false,
            zIndex: nextZ,
            data: data || w.data,
            title: (type === 'dynamicApp' && data?.appName) ? data.appName : w.title,
          };
        }
        return w;
      }));
      setActiveWindowId(foundWindow.id);
      return;
    }

    // If window not found, check if it's in the Platform App Registry
    if (targetRegistered) {
      const winId = `win_${targetRegistered.id}`;
      const newWin: AppWindow = {
        id: winId,
        appType: (targetRegistered.appType || targetRegistered.id) as WindowAppType,
        title: targetRegistered.name,
        icon: typeof targetRegistered.icon === 'string' ? targetRegistered.icon : '🎮',
        isOpen: true,
        isMinimized: false,
        isMaximized: false,
        zIndex: nextZ,
        x: Math.max(40, 100 + ((windows.length * 28) % 240)),
        y: Math.max(30, 60 + ((windows.length * 28) % 180)),
        width: targetRegistered.windowDefaults?.width || 640,
        height: targetRegistered.windowDefaults?.height || 480,
        data,
      };
      setWindows(prev => [...prev, newWin]);
      setActiveWindowId(winId);
      return;
    }

    // Fallback: create dynamic window for custom app type
    const winId = `win_${type}`;
    const dynamicWin: AppWindow = {
      id: winId,
      appType: type,
      title: data?.appName || (typeof type === 'string' ? type : 'Application'),
      icon: '🚀',
      isOpen: true,
      isMinimized: false,
      isMaximized: false,
      zIndex: nextZ,
      x: 140,
      y: 80,
      width: 680,
      height: 520,
      data,
    };
    setWindows(prev => [...prev, dynamicWin]);
    setActiveWindowId(winId);
  };

  const closeWindow = (id: string) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, isOpen: false } : w));
    if (activeWindowId === id) {
      setActiveWindowId(null);
    }
  };

  const minimizeWindow = (id: string) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, isMinimized: true } : w));
    if (activeWindowId === id) {
      setActiveWindowId(null);
    }
  };

  const toggleMaximizeWindow = (id: string) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, isMaximized: !w.isMaximized } : w));
  };

  // Request UAC Elevation Dialog
  const triggerUac = (appName: string, filePath: string, onConfirm: () => void) => {
    const currentUser = authService.getCurrentUser();
    if (currentUser.uacLevel === 0) {
      // Never notify
      onConfirm();
      return;
    }

    setUacRequest({
      id: 'uac_' + Date.now(),
      appName,
      publisher: 'ESP32-S3 Firmware Host',
      filePath,
      onConfirm,
      onCancel: () => {},
    });
  };

  const desktopIcons = [
    { type: 'explorer' as WindowAppType, label: 'This PC', icon: <HardDrive className="w-9 h-9 text-amber-400" /> },
    { type: 'taskmgr' as WindowAppType, label: 'Task Manager', icon: <Cpu className="w-9 h-9 text-cyan-400" /> },
    { type: 'terminal' as WindowAppType, label: 'Command Prompt', icon: <TerminalIcon className="w-9 h-9 text-emerald-400" /> },
    { type: 'firmware' as WindowAppType, label: 'ESP-IDF Source', icon: <Code2 className="w-9 h-9 text-purple-400" /> },
    { type: 'hardware' as WindowAppType, label: 'USB-OTG Wiring', icon: <Sliders className="w-9 h-9 text-orange-400" /> },
    { type: 'media' as WindowAppType, label: 'Media Player', icon: <Music2 className="w-9 h-9 text-indigo-300" /> },
    { type: 'calculator' as WindowAppType, label: 'Calculator', icon: <Calculator className="w-9 h-9 text-cyan-300" /> },
    { type: 'office' as WindowAppType, label: 'Productivity Suite', icon: <FileSpreadsheet className="w-9 h-9 text-emerald-300" /> },
    { type: 'dnsFiltering' as WindowAppType, label: 'DNS Filtering', icon: <ShieldAlert className="w-9 h-9 text-emerald-300" /> },
    { type: 'hardwareControls' as WindowAppType, label: 'Hardware Controls', icon: <ToggleRight className="w-9 h-9 text-amber-300" /> },
    { type: 'remoteBrowser' as WindowAppType, label: 'LAN Browser Bridge', icon: <Globe2 className="w-9 h-9 text-cyan-300" /> },
    { type: 'settings' as WindowAppType, label: 'Settings', icon: <SettingsIcon className="w-9 h-9 text-slate-300" /> },
    { type: 'devStudio' as WindowAppType, label: 'App Studio', icon: <Sparkles className="w-9 h-9 text-violet-400" /> },
  ];

  return (
    <PlatformProvider hardwareStats={hardwareStats}>
      <div className="relative w-screen h-screen overflow-hidden select-none bg-black text-slate-100 flex flex-col font-sans">
        {/* Device Memory Pressure Watchdog & Emergency Process Killer */}
        <ResourceGuard
          windows={windows}
          onKillWindow={closeWindow}
        />

        {/* Desktop Workspace Canvas */}
      <main
        className="flex-1 relative overflow-hidden bg-cover bg-center"
        style={{ backgroundImage: `url(${wallpaper})` }}
        onClick={() => setIsStartOpen(false)}
      >
        {/* Desktop Icons Grid */}
        <div className="absolute top-4 left-4 flex flex-col gap-2 z-0">
          {desktopIcons.map((icon) => (
            <button
              key={icon.type}
              type="button"
              onDoubleClick={() => openWindow(icon.type)}
              onClick={(e) => e.stopPropagation()}
              className="w-20 p-2 rounded-xl flex flex-col items-center justify-center text-center hover:bg-white/15 focus:bg-white/20 active:bg-white/25 transition-all group"
            >
              <div className="mb-1 group-hover:scale-105 transition-transform drop-shadow-md">
                {icon.icon}
              </div>
              <span className="text-[11px] font-medium text-white drop-shadow leading-tight line-clamp-2">
                {icon.label}
              </span>
            </button>
          ))}
        </div>

        {/* 3. Window Instances */}
        {windows.map((win) => {
          if (!win.isOpen) return null;
          const isActive = activeWindowId === win.id;

          return (
            <WindowFrame
              key={win.id}
              win={win}
              isActive={isActive}
              onFocus={() => focusWindow(win.id)}
              onClose={() => closeWindow(win.id)}
              onMinimize={() => minimizeWindow(win.id)}
              onToggleMaximize={() => toggleMaximizeWindow(win.id)}
            >
              {win.appType === 'explorer' && (
                <FileExplorer
                  initialPath="D:"
                  onOpenFile={openWindow}
                  onRequestUac={triggerUac}
                />
              )}

              {win.appType === 'taskmgr' && <TaskManagerApp />}

              {win.appType === 'terminal' && (
                <TerminalApp
                  onOpenFile={openWindow}
                  onRequestUac={triggerUac}
                />
              )}

              {win.appType === 'notepad' && (
                <NotepadApp
                  filePath={notepadData.filePath}
                  initialContent={notepadData.initialContent}
                />
              )}

              {win.appType === 'settings' && (
                <SettingsApp
                  currentWallpaper={wallpaper}
                  onSelectWallpaper={handleSetWallpaper}
                  onRequestUac={triggerUac}
                />
              )}

              {win.appType === 'dnsFiltering' && <DnsFilteringApp />}

              {win.appType === 'firmware' && <FirmwareViewerApp />}

              {win.appType === 'hardware' && <HardwareGuideApp />}

              {win.appType === 'media' && <MediaPlayerApp />}

              {win.appType === 'calculator' && <CalculatorApp />}

              {win.appType === 'office' && (
                <OfficeSuiteApp
                  key={authService.getCurrentUser().id}
                  userId={authService.getCurrentUser().id}
                />
              )}

              {win.appType === 'hardwareControls' && <HardwareControlsApp />}

              {win.appType === 'remoteBrowser' && <RemoteBrowserApp />}

              {win.appType === 'snake' && (
                <AppErrorBoundary appName="Snake">
                  <SnakeGame />
                </AppErrorBoundary>
              )}

              {win.appType === 'minesweeper' && (
                <AppErrorBoundary appName="Minesweeper">
                  <MinesweeperApp />
                </AppErrorBoundary>
              )}

              {win.appType === 'pong' && (
                <AppErrorBoundary appName="Pong">
                  <PongGame />
                </AppErrorBoundary>
              )}

              {win.appType === 'updateManager' && (
                <AppErrorBoundary appName="Windows Update">
                  <UpdateManagerApp
                    onStartUpdate={() => setShowUpdateScreen(true)}
                    onOtaStatus={setOtaStatus}
                  />
                </AppErrorBoundary>
              )}

              {win.appType === 'devStudio' && (
                <AppSandbox manifest={DEV_STUDIO_MANIFEST}>
                  <SampleDevApp />
                </AppSandbox>
              )}

              {win.appType === 'dynamicApp' && (
                <AppSandbox
                  manifest={{
                    id: 'custom-web-app',
                    name: dynamicAppData.appName,
                    version: '1.0.0',
                    description: 'User-imported HTML5/JS application',
                    icon: '🚀',
                    tileColor: 'bg-cyan-500/10',
                    appType: 'dynamicApp',
                    permissions: ['notifications', 'openApps'],
                    windowDefaults: { width: 780, height: 560 },
                    component: () => <DynamicAppRunner appCode={dynamicAppData.appCode} appName={dynamicAppData.appName} />,
                  }}
                >
                  <DynamicAppRunner appCode={dynamicAppData.appCode} appName={dynamicAppData.appName} />
                </AppSandbox>
              )}

              {/* Dynamic Platform Apps registered via AppRegistry (e.g. MyGame and imported apps) */}
              {(() => {
                const regManifest = appRegistry.get(win.appType) || 
                                    appRegistry.get(win.id.replace(/^win_/, '')) ||
                                    appRegistry.getAll().find(a => a.appType === win.appType || a.id === win.appType || `win_${a.id}` === win.id);
                if (regManifest && win.appType !== 'devStudio' && win.appType !== 'dynamicApp') {
                  const RegisteredComponent = regManifest.component;
                  return (
                    <AppSandbox manifest={regManifest} instanceId={win.id} width={win.width} height={win.height}>
                      <RegisteredComponent width={win.width} height={win.height} instanceId={win.id} />
                    </AppSandbox>
                  );
                }
                return null;
              })()}
            </WindowFrame>
          );
        })}

        {/* 4. Windows 11 Start Menu */}
        <StartMenu
          isOpen={isStartOpen}
          onClose={() => setIsStartOpen(false)}
          onOpenApp={openWindow}
          onLockSession={() => {
            void saveDesktopState();
            setIsLocked(true);
          }}
          onRestartSystem={() => {
            void requestSystemPower('/api/system/reboot', 'restart');
          }}
          onPrepareShutdown={() => {
            void requestSystemPower('/api/system/shutdown', 'shutdown preparation');
          }}
        />

        {/* 5. UAC Elevation Modal */}
        <UacModal
          request={uacRequest}
          onClose={() => setUacRequest(null)}
        />

        {/* 6. Hardware Stats & Home Network Quick Popover */}
        {showStatsModal && (
          <div 
            className="fixed bottom-14 right-4 w-88 bg-[#1a202c]/95 backdrop-blur-2xl border border-neutral-700/80 rounded-2xl shadow-2xl p-4 text-xs z-[9200] animate-in fade-in slide-in-from-bottom-2 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
              <span className="font-semibold text-white">ESP32-S3 Network & Hardware Status</span>
              <button 
                type="button" 
                onClick={() => setShowStatsModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="space-y-2 mt-3 font-mono text-[11px]">
              <div className="p-2 rounded-lg bg-neutral-900 border border-neutral-800 space-y-1">
                <div className="text-[10px] font-sans font-semibold text-cyan-300 uppercase tracking-wider">
                  Wi-Fi mode: {hardwareStats?.wifiMode ?? 'Unavailable'}
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400 font-sans">Home SSID:</span>
                    <span className="text-white font-medium">{hardwareStats?.wifiStationSsid ?? 'Not connected'}</span>
                </div>
                  {hardwareStats?.wifiStationConnected && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-slate-400 font-sans">Home LAN IP:</span>
                        <span className="text-emerald-300 font-bold">{hardwareStats.wifiStationIp ?? 'Unavailable'}</span>
                    </div>
                    </>
                  )}
                  <div className="flex justify-between">
                    <span className="text-slate-400 font-sans">Access point:</span>
                    <span className="text-amber-300">{hardwareStats?.wifiApSsid ?? 'Unavailable'}</span>
                  </div>
                <div className="flex justify-between">
                    <span className="text-slate-400 font-sans">Access point IP:</span>
                    <span className="text-amber-300">{hardwareStats?.wifiApIp ?? 'Unavailable'}</span>
                </div>
              </div>

              <div className="flex justify-between pt-1">
                <span className="text-slate-400 font-sans">Microcontroller:</span>
                  <span className="text-white font-medium">{hardwareStats?.chipModel ?? 'Unavailable'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-sans">Firmware version:</span>
                <span className="text-emerald-300 font-mono">{hardwareStats?.firmwareVersion ?? 'Unavailable'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-sans">ESP-IDF version:</span>
                <span className="text-slate-300 font-mono">{hardwareStats?.idfVersion ?? 'Unavailable'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-sans">CPU Frequency:</span>
                  <span className="text-blue-300">
                    {hardwareStats ? `${(hardwareStats.cpuFrequencyHz / 1_000_000).toFixed(0)} MHz` : 'Unavailable'}
                  </span>
              </div>
              <div className="flex justify-between">
                  <span className="text-slate-400 font-sans">PSRAM:</span>
                  <span className="text-cyan-300">
                    {hardwareStats ? `${(hardwareStats.psramTotalBytes / 1024).toLocaleString()} KB` : 'Unavailable'}
                  </span>
              </div>
              <div className="flex justify-between">
                  <span className="text-slate-400 font-sans">Internal SPI Flash:</span>
                  <span className="text-purple-300">
                    {hardwareStats?.flashSizeBytes
                      ? `${(hardwareStats.flashSizeBytes / (1024 * 1024)).toFixed(0)} MB`
                      : 'Unavailable'}
                  </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-sans">Primary USB Storage:</span>
                <span className="text-amber-300">
                  {hardwareStats?.usbMounted
                    ? `${hardwareStats.usbTotalGb.toFixed(2)} GiB (${hardwareStats.usbManufacturer} ${hardwareStats.usbProduct})`
                    : hardwareStats ? 'Not mounted' : 'Unavailable'}
                </span>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* USB Auto-Detection Toast Notification */}
      {usbToast && (
        <div className="fixed bottom-14 right-4 z-[9000] p-4 bg-[#1b2230]/95 backdrop-blur-xl border border-neutral-700/80 rounded-2xl shadow-2xl flex items-start gap-3 max-w-sm animate-in slide-in-from-bottom-5 duration-300">
          <div className="p-2 rounded-xl bg-amber-500/20 text-amber-300 shrink-0">
            <HardDrive className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-white flex items-center justify-between">
              <span>{usbDisk.status === 'ONLINE' ? 'USB Storage Detected' : 'USB Storage Removed'}</span>
              <span className={`text-[10px] font-mono ${usbDisk.status === 'ONLINE' ? 'text-emerald-400' : 'text-amber-300'}`}>
                {usbDisk.status === 'ONLINE' ? 'SCSI LUN 0' : 'Not mounted'}
              </span>
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5">
              {usbDisk.status === 'ONLINE'
                ? `${usbDisk.vendor} ${usbDisk.model} (${usbDisk.capacityGb.toFixed(2)} GiB) mounted at D:\\`
                : 'No USB storage drive is currently mounted on the ESP32.'}
            </p>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => {
                  setUsbToast(false);
                  openWindow('explorer');
                }}
                className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-medium transition-colors"
              >
                Open in Explorer
              </button>
              <button
                type="button"
                onClick={() => setUsbToast(false)}
                className="px-2 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-slate-300 text-[10px] transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Centered Windows 11 Taskbar */}
      <Taskbar
        windows={windows}
        hardwareStats={hardwareStats}
        activeWindowId={activeWindowId}
        onToggleWindow={openWindow}
        isStartOpen={isStartOpen}
        onToggleStart={() => setIsStartOpen(!isStartOpen)}
        onOpenStatsPopover={() => setShowStatsModal(!showStatsModal)}
      />

      {/* OTA Firmware Update Screen — sits above everything except auth overlay */}
      <WindowsUpdateScreen
        isVisible={showUpdateScreen}
        status={otaStatus}
        onDismissError={() => { setShowUpdateScreen(false); setOtaStatus(null); }}
        onRestartToApply={async () => {
          const requested = await requestSystemPower('/api/system/reboot', 'restart');
          if (!requested) throw new Error('Restart request was cancelled or failed.');
        }}
      />

      {/* 8. Windows 11 Lock & Authentication Screen */}
      {isLocked && (
        <LockScreen
          onUnlock={() => {
            restoreDesktopState(authService.getCurrentUser().id);
            setIsLocked(false);
          }}
          wallpaperUrl={wallpaper}
        />
      )}
      {!authReady && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950 text-sm text-slate-300">
          Loading saved accounts…
        </div>
      )}
    </div>
    </PlatformProvider>
  );
}
