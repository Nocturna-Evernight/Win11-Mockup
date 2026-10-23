import React, { useState, useRef } from 'react';
import { RefreshCw, UploadCloud, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { OtaStatus } from '../../types';

interface UpdateManagerAppProps {
  onStartUpdate: () => void;
  onOtaStatus: (status: OtaStatus) => void;
}

export const UpdateManagerApp: React.FC<UpdateManagerAppProps> = ({
  onStartUpdate,
  onOtaStatus,
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<'success' | 'error' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setResult(null);
    setErrorMsg(null);
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setResult(null);
    setErrorMsg(null);
    onOtaStatus({
      state: 'reading',
      progressPercent: 0,
      bytesWritten: 0,
      totalBytes: selectedFile.size,
      errorMessage: null,
    });
    onStartUpdate();

    const tryRealUpload = () => {
      return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/system/ota/upload');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          const uploadedBytes = Math.min(event.loaded, selectedFile.size);
          onOtaStatus({
            state: 'writing',
            progressPercent: Math.min(95, Math.floor((uploadedBytes / selectedFile.size) * 95)),
            bytesWritten: uploadedBytes,
            totalBytes: selectedFile.size,
            errorMessage: null,
          });
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Server returned HTTP ${xhr.status}`));
          }
        };

        xhr.onerror = () => {
          reject(new Error('Network connection failed'));
        };

        xhr.send(selectedFile);
      });
    };

    try {
      await tryRealUpload();
      onOtaStatus({
        state: 'verifying',
        progressPercent: 99,
        bytesWritten: selectedFile.size,
        totalBytes: selectedFile.size,
        errorMessage: null,
      });
      onOtaStatus({
        state: 'done',
        progressPercent: 100,
        bytesWritten: selectedFile.size,
        totalBytes: selectedFile.size,
        errorMessage: null,
      });
      setResult('success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setErrorMsg(msg);
      setResult('error');
      onOtaStatus({
        state: 'error',
        progressPercent: 0,
        bytesWritten: 0,
        totalBytes: 0,
        errorMessage: msg,
      });
    } finally {
      setUploading(false);
    }
  };

  const formatBytes = (n: number) =>
    n >= 1024 * 1024
      ? `${(n / (1024 * 1024)).toFixed(2)} MB`
      : `${(n / 1024).toFixed(1)} KB`;

  return (
    <div className="flex flex-col h-full bg-neutral-950 text-slate-100 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-neutral-800">
        <div className="p-2 rounded-xl bg-blue-600/20">
          <RefreshCw className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <p className="font-semibold text-sm">Windows Update</p>
          <p className="text-xs text-slate-400">ESP32-S3 OTA Firmware Updater</p>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        {/* Status banner */}
        <div className={`flex items-center gap-3 p-3 rounded-xl border ${
          result === 'error'
            ? 'bg-red-500/10 border-red-700/40'
            : uploading
              ? 'bg-blue-500/10 border-blue-700/40'
              : 'bg-emerald-500/10 border-emerald-700/40'
        }`}>
          {result === 'error' ? (
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          ) : uploading ? (
            <Loader2 className="w-4 h-4 text-blue-400 shrink-0 animate-spin" />
          ) : (
            <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          <span className={`text-xs ${
            result === 'error' ? 'text-red-300' : uploading ? 'text-blue-300' : 'text-emerald-300'
          }`}>
            {result === 'error'
              ? 'Firmware update failed. See the error details below.'
              : uploading
                ? 'Firmware update in progress. Live status is shown on the update screen.'
                : result === 'success'
                  ? 'Firmware image written and verified to the inactive partition. Restart to apply it.'
                  : "You're up to date with the currently flashed firmware."}
          </span>
        </div>

        {/* Upload section */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Flash new firmware</p>

          <div
            className="border-2 border-dashed border-neutral-700 rounded-xl p-6 flex flex-col items-center gap-3 hover:border-blue-500/60 transition-colors cursor-pointer"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            <UploadCloud className="w-8 h-8 text-blue-400 opacity-70" />
            <p className="text-sm text-slate-400 text-center">
              {selectedFile
                ? `${selectedFile.name} (${formatBytes(selectedFile.size)})`
                : 'Click to select a .bin firmware file'}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".bin"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {selectedFile && !uploading && result === null && (
            <button
              type="button"
              onClick={() => void handleUpload()}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              <UploadCloud className="w-4 h-4" />
              Flash firmware
            </button>
          )}

          {uploading && (
            <div className="flex items-center justify-center gap-2 text-sm text-blue-300 py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading firmware — update screen will appear…
            </div>
          )}

          {result === 'success' && (
            <div className="flex items-center gap-2 text-emerald-400 text-sm py-2">
              <CheckCircle className="w-4 h-4" />
              Update staged. Use the update screen to restart and apply it.
            </div>
          )}

          {result === 'error' && (
            <div className="flex items-start gap-2 text-red-400 text-xs py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Info section */}
        <div className="space-y-2 text-xs text-slate-500 border-t border-neutral-800 pt-4">
          <p>• OTA updates write to the inactive partition and swap on next boot.</p>
          <p>• The image is staged first; explicitly restart the ESP32 to apply it.</p>
          <p>• Do not remove power or close the browser during the update.</p>
        </div>
      </div>
    </div>
  );
};
