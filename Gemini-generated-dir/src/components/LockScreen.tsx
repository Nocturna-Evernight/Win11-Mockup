import React, { useState, useEffect } from 'react';
import { User, ArrowRight, Power, KeyRound, CheckCircle2 } from 'lucide-react';
import { UserProfile } from '../types';
import { authService } from '../services/authService';

interface LockScreenProps {
  onUnlock: () => void;
  wallpaperUrl: string;
}

export const LockScreen: React.FC<LockScreenProps> = ({ onUnlock, wallpaperUrl }) => {
  const [timeStr, setTimeStr] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [isSwipedUp, setIsSwipedUp] = useState(true);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserProfile>(authService.getCurrentUser());
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState(authService.getSyncStatus());

  useEffect(() => {
    const unsub = authService.subscribe(() => {
      setUsers(authService.getUsers());
      setSelectedUser(authService.getCurrentUser());
      setSyncStatus(authService.getSyncStatus());
    });

    setUsers(authService.getUsers());
    setSelectedUser(authService.getCurrentUser());
    setSyncStatus(authService.getSyncStatus());

    const updateClock = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setDateStr(now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, []);

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedUser) return;

    if (!selectedUser.hasPassword) {
      authService.login(selectedUser.username, '');
      onUnlock();
      return;
    }

    setIsLoading(true);
    setErrorMsg('');
    const res = await authService.login(selectedUser.username, password);
    setIsLoading(false);

    if (res.success) {
      onUnlock();
    } else {
      setErrorMsg(res.message);
    }
  };

  return (
    <div 
      className="fixed inset-0 z-[10000] overflow-hidden select-none bg-cover bg-center flex flex-col justify-between"
      style={{ backgroundImage: `url(${wallpaperUrl})` }}
      onClick={() => !isSwipedUp && setIsSwipedUp(true)}
    >
      {/* Acrylic overlay */}
      <div className={`absolute inset-0 transition-all duration-500 ${isSwipedUp ? 'bg-black/60 backdrop-blur-xl' : 'bg-black/25'}`} />

      {syncStatus.state === 'offline' && (
        <div className="absolute top-4 left-1/2 z-20 flex max-w-2xl -translate-x-1/2 items-center gap-3 rounded-xl border border-amber-400/40 bg-slate-950/90 px-4 py-3 text-xs text-amber-100 shadow-xl">
          <span>ESP32 account sync is offline. Accounts shown may be local to this browser. {syncStatus.error}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void authService.initialize();
            }}
            className="shrink-0 rounded-lg bg-amber-500/20 px-3 py-1.5 font-semibold text-amber-200 hover:bg-amber-500/30"
          >
            Retry
          </button>
        </div>
      )}

      {/* Slide 1: Lock Clock View */}
      {!isSwipedUp ? (
        <div className="relative z-10 flex-1 flex flex-col justify-between items-center py-20 text-white cursor-pointer">
          <div className="text-center pt-8">
            <h1 className="text-7xl md:text-8xl font-light tracking-tight drop-shadow-lg font-sans">
              {timeStr}
            </h1>
            <p className="text-lg md:text-xl font-normal text-slate-200 mt-2 drop-shadow">
              {dateStr}
            </p>
          </div>

          <div className="text-center pb-8 animate-bounce text-slate-300 text-xs tracking-wider">
            Click anywhere or press Enter to unlock Windows 11
          </div>
        </div>
      ) : (
        /* Slide 2: Credentials Login View */
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center p-6 text-white animate-in fade-in zoom-in-95 duration-300">
          <div className="w-full max-w-sm flex flex-col items-center">
            {/* Avatar */}
            <div className="relative mb-4">
              <div className="w-28 h-28 rounded-full ring-4 ring-white/20 shadow-2xl overflow-hidden bg-neutral-800 flex items-center justify-center">
                {selectedUser.avatar ? (
                  <img src={selectedUser.avatar} alt={selectedUser.displayName} className="w-full h-full object-cover" />
                ) : (
                  <User className="w-14 h-14 text-slate-300" />
                )}
              </div>
            </div>

            {/* Display Name & Admin badge */}
            <h2 className="text-2xl font-semibold tracking-tight text-white mb-1">
              {selectedUser.displayName}
            </h2>
            <div className="flex items-center gap-1.5 text-xs text-slate-300 mb-6">
              <span>{selectedUser.isAdmin ? 'Administrator' : 'Standard User'}</span>
              <span aria-hidden="true">·</span>
              <span>ESP32-S3 Local Account</span>
            </div>

            {/* Password Form */}
            {selectedUser.hasPassword ? (
              <form onSubmit={handleLogin} className="w-full space-y-3">
                <div className="relative flex items-center">
                  <input
                    type="password"
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setErrorMsg('');
                    }}
                    autoFocus
                    className="w-full px-4 py-2.5 bg-neutral-900/80 backdrop-blur-md border border-neutral-600/80 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-lg text-sm pr-11"
                  />
                  <button
                    type="submit"
                    disabled={isLoading}
                    aria-label="Sign in"
                    className="absolute right-1.5 p-2 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white transition-colors disabled:opacity-50"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>

                {errorMsg ? (
                  <p className="text-xs text-red-400 text-center font-medium bg-red-950/60 p-2 rounded border border-red-800/50">
                    {errorMsg}
                  </p>
                ) : (
                  <p className="text-[11px] text-slate-400 text-center">
                    Hint: Default password is <code className="text-slate-200 bg-black/40 px-1 py-0.5 rounded">{selectedUser.username === 'Administrator' ? 'admin123' : 'password'}</code>
                  </p>
                )}
              </form>
            ) : (
              <button
                type="button"
                onClick={() => handleLogin()}
                className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors shadow-lg"
              >
                Sign In
              </button>
            )}
          </div>

          {/* User selector list on bottom-left */}
          <div className="absolute bottom-8 left-8 flex flex-col gap-2">
            <div className="text-[11px] text-slate-400 font-medium uppercase tracking-wider">
              Switch User
            </div>
            <div className="flex items-center gap-2">
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    setSelectedUser(u);
                    setPassword('');
                    setErrorMsg('');
                  }}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all text-xs ${
                    selectedUser.id === u.id
                      ? 'bg-white/20 border-white/40 text-white font-medium shadow-sm'
                      : 'bg-black/30 border-white/10 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="w-5 h-5 rounded-full overflow-hidden bg-neutral-700 shrink-0">
                    {u.avatar ? <img src={u.avatar} alt="" className="w-full h-full object-cover" /> : <User className="w-3 h-3 text-slate-300 m-1" />}
                  </div>
                  <span>{u.username}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Quick Hardware Notice bottom-right */}
          <div className="absolute bottom-8 right-8 flex items-center gap-3 text-xs text-slate-400">
            <div className="text-right">
              <div className="text-slate-200 font-medium">ESP32-S3 N16R8</div>
              <div className="text-[11px]">8MB PSRAM · 32GB USB-OTG</div>
            </div>
            <div className="w-8 h-8 rounded-lg bg-white/10 border border-white/20 flex items-center justify-center">
              <Power className="w-4 h-4 text-slate-300" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
