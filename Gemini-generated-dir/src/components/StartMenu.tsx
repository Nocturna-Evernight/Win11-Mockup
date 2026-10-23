import React, { useState } from 'react';
import { 
  Search, 
  Folder, 
  Terminal, 
  Cpu, 
  Settings, 
  FileText, 
  Code2, 
  Sliders, 
  Music2,
  Calculator,
  FileSpreadsheet,
  ToggleRight,
  Globe2,
  Power, 
  Lock, 
  LogOut, 
  UserCheck, 
  ShieldCheck,
  ChevronRight,
  RefreshCw,
  Sparkles
} from 'lucide-react';
import { WindowAppType } from '../types';
import { authService } from '../services/authService';
import { appRegistry } from '../platform';

interface StartMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenApp: (type: WindowAppType, data?: any) => void;
  onLockSession: () => void;
  onRestartSystem: () => void;
  onPrepareShutdown: () => void;
}

export const StartMenu: React.FC<StartMenuProps> = ({
  isOpen,
  onClose,
  onOpenApp,
  onLockSession,
  onRestartSystem,
  onPrepareShutdown,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPowerMenu, setShowPowerMenu] = useState(false);
  const [currentUser, setCurrentUser] = useState(authService.getCurrentUser());

  const [, setRegistryVersion] = useState(0);

  React.useEffect(() => {
    const unsubAuth = authService.subscribe(() => {
      setCurrentUser(authService.getCurrentUser());
    });
    const unsubReg = appRegistry.subscribe(() => {
      setRegistryVersion((v) => v + 1);
    });
    return () => {
      unsubAuth();
      unsubReg();
    };
  }, []);

  if (!isOpen) return null;

  const pinnedApps: { type: WindowAppType; label: string; icon: React.ReactNode; color: string; desc: string }[] = [
    { type: 'explorer', label: 'File Explorer', icon: <Folder className="w-6 h-6 text-amber-400" />, color: 'bg-amber-500/10', desc: 'Browse 32GB USB & Flash' },
    { type: 'terminal', label: 'Terminal', icon: <Terminal className="w-6 h-6 text-emerald-400" />, color: 'bg-emerald-500/10', desc: 'Command Prompt & CLI' },
    { type: 'taskmgr', label: 'Task Manager', icon: <Cpu className="w-6 h-6 text-cyan-400" />, color: 'bg-cyan-500/10', desc: '8MB PSRAM & CPU monitor' },
    { type: 'notepad', label: 'Notepad', icon: <FileText className="w-6 h-6 text-sky-300" />, color: 'bg-sky-500/10', desc: 'Text & script editor' },
    { type: 'settings', label: 'Settings', icon: <Settings className="w-6 h-6 text-slate-300" />, color: 'bg-slate-500/10', desc: 'UAC & User profiles' },
    { type: 'dnsFiltering', label: 'DNS Filtering', icon: <ShieldCheck className="w-6 h-6 text-emerald-300" />, color: 'bg-emerald-500/10', desc: 'USB-backed domain blocking and resolver settings' },
    { type: 'firmware', label: 'ESP-IDF Source', icon: <Code2 className="w-6 h-6 text-purple-400" />, color: 'bg-purple-500/10', desc: 'Firmware files & exporter' },
    { type: 'hardware', label: 'Hardware Wiring', icon: <Sliders className="w-6 h-6 text-orange-400" />, color: 'bg-orange-500/10', desc: 'USB-OTG pinouts & 5V rail' },
    { type: 'media', label: 'Media Player', icon: <Music2 className="w-6 h-6 text-indigo-300" />, color: 'bg-indigo-500/10', desc: 'Play local or ESP32 USB media' },
    { type: 'calculator', label: 'Calculator', icon: <Calculator className="w-6 h-6 text-cyan-300" />, color: 'bg-cyan-500/10', desc: 'Basic arithmetic calculator' },
    { type: 'office', label: 'Productivity Suite', icon: <FileSpreadsheet className="w-6 h-6 text-emerald-300" />, color: 'bg-emerald-500/10', desc: 'Documents, spreadsheet, slides' },
    { type: 'hardwareControls', label: 'Hardware Controls', icon: <ToggleRight className="w-6 h-6 text-amber-300" />, color: 'bg-amber-500/10', desc: 'Safe GPIO outputs and board controls' },
    { type: 'remoteBrowser', label: 'LAN Browser Bridge', icon: <Globe2 className="w-6 h-6 text-cyan-300" />, color: 'bg-cyan-500/10', desc: 'View and control websites on your Windows PC' },
    { type: 'snake', label: 'Snake', icon: <span className="text-2xl">🐍</span>, color: 'bg-green-500/10', desc: 'Classic snake game' },
    { type: 'minesweeper', label: 'Minesweeper', icon: <span className="text-2xl">💣</span>, color: 'bg-red-500/10', desc: 'Classic mine sweeper' },
    { type: 'pong', label: 'Pong', icon: <span className="text-2xl">🏓</span>, color: 'bg-indigo-500/10', desc: 'Classic pong vs AI' },
    { type: 'updateManager', label: 'Windows Update', icon: <RefreshCw className="w-6 h-6 text-blue-400" />, color: 'bg-blue-500/10', desc: 'OTA firmware updater' },
    { type: 'devStudio', label: 'App Platform Studio', icon: <Sparkles className="w-6 h-6 text-violet-400" />, color: 'bg-violet-500/10', desc: 'Dev framework & watchdog safeguard' },
  ];

  const registeredApps = appRegistry.getAll()
    .filter((manifest) => manifest.id !== 'dev-studio')
    .map((manifest) => ({
      type: (manifest.appType || manifest.id) as WindowAppType,
      label: manifest.name,
      icon: typeof manifest.icon === 'string' ? <span className="text-2xl">{manifest.icon}</span> : manifest.icon,
      color: manifest.tileColor || 'bg-emerald-500/10',
      desc: manifest.description,
    }));

  const allApps = [...pinnedApps, ...registeredApps];

  const recommendedItems = [
    { name: 'ESP32S3_N16R8_Specs.txt', path: 'D:\\Users\\Administrator\\Desktop\\ESP32S3_N16R8_Specs.txt', app: 'notepad' as WindowAppType, note: 'Hardware specs' },
    { name: 'USB_OTG_Wiring.txt', path: 'D:\\Users\\Administrator\\Documents\\USB_OTG_Wiring.txt', app: 'notepad' as WindowAppType, note: 'USB host wiring' },
    { name: 'registry.json', path: 'D:\\System\\registry.json', app: 'notepad' as WindowAppType, note: 'Persistent system registry' },
  ];

  const filteredApps = allApps.filter(a => 
    a.label.toLowerCase().includes(searchQuery.toLowerCase()) || 
    a.desc.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div 
      className="fixed bottom-14 left-1/2 -translate-x-1/2 w-[540px] max-w-[95vw] h-[610px] bg-[#1a202c]/95 backdrop-blur-3xl border border-neutral-700/80 rounded-2xl shadow-2xl z-[9500] flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-3 duration-150 select-none text-slate-100"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Search Input Box */}
      <div className="p-6 pb-4">
        <div className="relative flex items-center">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5" />
          <input
            type="text"
            placeholder="Type here to search apps, settings, or files on 32GB USB..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-neutral-900/80 border border-neutral-700/80 rounded-xl text-sm text-white placeholder-slate-400 focus:outline-none focus:border-blue-500 shadow-inner"
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-6 space-y-6">
        {/* Pinned Section */}
        <div>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
            <span>Pinned</span>
            <button 
              type="button" 
              onClick={() => onOpenApp('settings')}
              className="text-blue-400 hover:text-blue-300 text-xs normal-case font-normal flex items-center gap-1"
            >
              <span>All apps</span>
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {filteredApps.map((app) => (
              <button
                key={app.type}
                type="button"
                onClick={() => {
                  onOpenApp(app.type);
                  onClose();
                }}
                className="flex flex-col items-center justify-center p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-all text-center group"
              >
                <div className={`w-11 h-11 rounded-xl ${app.color} flex items-center justify-center mb-2 group-hover:scale-105 transition-transform shadow-sm`}>
                  {app.icon}
                </div>
                <span className="text-xs font-medium text-slate-200 group-hover:text-white leading-tight">
                  {app.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Recommended Files on 32GB USB Drive */}
        <div className="pt-2 border-t border-neutral-800">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
            Recommended (from 32GB USB Storage)
          </div>

          <div className="grid grid-cols-2 gap-2">
            {recommendedItems.map((item, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  onOpenApp(item.app, { filePath: item.path });
                  onClose();
                }}
                className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/10 text-left transition-colors group"
              >
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4 text-sky-400" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-200 group-hover:text-white truncate">
                    {item.name}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">
                    {item.note}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Footer Profile & Power Bar */}
      <div className="h-16 px-6 bg-[#141824]/90 border-t border-neutral-800 flex items-center justify-between relative">
        {/* User Account Popover Trigger */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setShowUserMenu(!showUserMenu);
              setShowPowerMenu(false);
            }}
            className="flex items-center gap-2.5 p-1.5 pr-3 rounded-full hover:bg-white/10 transition-colors"
          >
            <div className="w-8 h-8 rounded-full overflow-hidden bg-neutral-700 ring-1 ring-white/20">
              <img src={currentUser.avatar} alt={currentUser.displayName} className="w-full h-full object-cover" />
            </div>
            <div className="text-left">
              <div className="text-xs font-medium text-slate-200 flex items-center gap-1">
                <span>{currentUser.displayName}</span>
                {currentUser.isAdmin && (
                  <span title="Administrator">
                    <ShieldCheck className="w-3 h-3 text-amber-400" />
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-400">
                {currentUser.isAdmin ? 'Administrator' : 'Standard User'}
              </div>
            </div>
          </button>

          {/* User Popover Menu */}
          {showUserMenu && (
            <div className="absolute bottom-12 left-0 w-48 bg-[#202738] border border-neutral-700 rounded-xl shadow-2xl p-1.5 space-y-1 text-xs z-50">
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  onOpenApp('settings');
                  onClose();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/10 text-slate-200 text-left"
              >
                <UserCheck className="w-4 h-4 text-blue-400" />
                <span>Account settings</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  onLockSession();
                  onClose();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/10 text-slate-200 text-left"
              >
                <Lock className="w-4 h-4 text-amber-400" />
                <span>Lock session</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  authService.logout();
                  onLockSession();
                  onClose();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-red-500/20 text-red-300 text-left"
              >
                <LogOut className="w-4 h-4 text-red-400" />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>

        {/* Power Menu Trigger */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setShowPowerMenu(!showPowerMenu);
              setShowUserMenu(false);
            }}
            className="w-9 h-9 rounded-lg hover:bg-white/10 flex items-center justify-center transition-colors text-slate-300 hover:text-white"
            title="Power options"
          >
            <Power className="w-4 h-4" />
          </button>

          {/* Power Popover Menu */}
          {showPowerMenu && (
            <div className="absolute bottom-12 right-0 w-44 bg-[#202738] border border-neutral-700 rounded-xl shadow-2xl p-1.5 space-y-1 text-xs z-50">
              <button
                type="button"
                onClick={() => {
                  setShowPowerMenu(false);
                  onClose();
                  onRestartSystem();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/10 text-slate-200 text-left"
              >
                <Power className="w-4 h-4 text-amber-400" />
                <span>Restart ESP32-S3</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowPowerMenu(false);
                  onClose();
                  onPrepareShutdown();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/10 text-slate-200 text-left"
              >
                <Power className="w-4 h-4 text-violet-400" />
                <span>Prepare shutdown</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowPowerMenu(false);
                  onLockSession();
                  onClose();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/10 text-slate-200 text-left"
              >
                <Lock className="w-4 h-4 text-blue-400" />
                <span>Sleep / Lock</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
