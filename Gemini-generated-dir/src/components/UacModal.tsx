import React, { useState } from 'react';
import { Shield, ChevronDown, ChevronUp, Lock } from 'lucide-react';
import { UacRequest } from '../types';
import { authService } from '../services/authService';

interface UacModalProps {
  request: UacRequest | null;
  onClose: () => void;
}

export const UacModal: React.FC<UacModalProps> = ({ request, onClose }) => {
  const [showDetails, setShowDetails] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);

  if (!request) return null;

  const currentUser = authService.getCurrentUser();
  const requiresPassword = !currentUser.isAdmin || request.requiresAdminPassword;

  const handleConfirm = async () => {
    if (requiresPassword) {
      if (!adminPassword.trim()) {
        setErrorMsg('Please enter an administrator password.');
        return;
      }
      setIsVerifying(true);
      setErrorMsg('');
      const valid = await authService.verifyAdminPassword(adminPassword);
      setIsVerifying(false);
      if (!valid) {
        setErrorMsg('The password entered for the administrator account is incorrect.');
        return;
      }
    }

    request.onConfirm();
    onClose();
  };

  const handleCancel = () => {
    request.onCancel();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
      <div 
        className="w-full max-w-lg bg-[#202020] text-slate-100 rounded-xl shadow-2xl border border-neutral-700/80 overflow-hidden flex flex-col font-sans transform scale-100 transition-transform"
        role="dialog"
        aria-modal="true"
        aria-labelledby="uac-title"
      >
        {/* Header with yellow/blue shield */}
        <div className="p-6 bg-gradient-to-b from-[#2d2d2d] to-[#202020] border-b border-neutral-700/50 flex gap-4 items-start">
          <div className="relative shrink-0 w-12 h-12 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shadow-inner">
            <Shield className="w-8 h-8 text-amber-400 fill-amber-400/20" />
            <div className="absolute -bottom-1 -right-1 bg-blue-600 rounded-full p-0.5 border border-neutral-900">
              <Lock className="w-3 h-3 text-white" />
            </div>
          </div>

          <div className="flex-1">
            <h2 id="uac-title" className="text-lg font-semibold text-white leading-tight">
              User Account Control
            </h2>
            <p className="text-sm text-slate-300 mt-1">
              Do you want to allow this app from an unknown publisher to make changes to your device?
            </p>
          </div>
        </div>

        {/* App Info Box */}
        <div className="p-6 space-y-4">
          <div className="bg-[#292929] rounded-lg p-3.5 border border-neutral-700/60">
            <div className="text-base font-semibold text-white truncate">
              {request.appName}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Verified publisher: <span className="text-slate-300">ESP32-S3 Firmware Subsystem</span>
            </div>
            <div className="text-xs text-slate-400 mt-0.5 truncate">
              File origin: <span className="text-amber-300/90 font-mono text-[11px]">{request.filePath}</span>
            </div>
          </div>

          {/* Collapsible Details */}
          <div>
            <button 
              type="button"
              onClick={() => setShowDetails(!showDetails)}
              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors focus:outline-none"
            >
              <span>{showDetails ? 'Hide details' : 'Show more details'}</span>
              {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {showDetails && (
              <div className="mt-2.5 p-3 rounded bg-neutral-900/60 border border-neutral-800 text-[11px] font-mono text-slate-300 space-y-1">
                <div>Program: {request.filePath}</div>
                <div>Storage: 32GB USB-OTG Flash Drive (FAT32)</div>
                <div>Authorization: Administrator approval required</div>
              </div>
            )}
          </div>

          {/* Admin Credential Prompt if Standard User */}
          {requiresPassword && (
            <div className="pt-2 border-t border-neutral-800 space-y-2">
              <div className="text-xs text-amber-300 font-medium">
                To continue, enter an administrator password:
              </div>
              <input
                type="password"
                placeholder="Enter Administrator Password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
                autoFocus
                className="w-full px-3 py-2 text-sm bg-neutral-900 border border-neutral-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <div className="text-[11px] text-slate-400">
                Factory device admin password: <code className="text-slate-300 bg-neutral-800 px-1 py-0.5 rounded">password</code>
              </div>
              {errorMsg && (
                <div className="text-xs text-red-400 font-medium pt-1">
                  {errorMsg}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Buttons (Windows 11 Fluent style) */}
        <div className="p-4 bg-[#1c1c1c] border-t border-neutral-800 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isVerifying}
            className="px-6 py-2 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium text-sm transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50 disabled:opacity-50"
          >
            {isVerifying ? 'Verifying...' : 'Yes'}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="px-6 py-2 rounded-md bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-900 text-slate-200 font-medium text-sm border border-neutral-700 transition-colors focus:outline-none"
          >
            No
          </button>
        </div>
      </div>
    </div>
  );
};
