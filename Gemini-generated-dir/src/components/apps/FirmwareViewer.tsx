import React, { useState } from 'react';
import { Download, Copy, Check, FileCode, Folder, Code, Terminal, Sparkles } from 'lucide-react';
import JSZip from 'jszip';
import { ESP_IDF_PROJECT_FILES, EspFileItem } from '../../data/espIdfCode';

export const FirmwareViewerApp: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<EspFileItem>(ESP_IDF_PROJECT_FILES[0]);
  const [copied, setCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(selectedFile.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadZip = async () => {
    setIsExporting(true);
    try {
      const zip = new JSZip();

      // Populate files into zip
      for (const file of ESP_IDF_PROJECT_FILES) {
        zip.file(file.path, file.code);
      }

      // Generate blob
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'esp32s3_win11_webos_firmware.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error generating firmware zip:', err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#181d28] text-slate-100 select-none">
      {/* Top Banner Toolbar */}
      <div className="h-11 border-b border-neutral-700/60 bg-[#1d2331] px-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code className="w-4 h-4 text-purple-400" />
          <span className="text-xs font-semibold text-white">ESP-IDF v5.1+ Firmware Source Suite</span>
          <span className="text-slate-500">·</span>
          <span className="text-xs text-purple-300 font-mono">ESP32-S3 N16R8 (16MB Flash / 8MB Octal PSRAM)</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-slate-200 text-xs border border-neutral-700 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied!' : 'Copy Code'}</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadZip}
            disabled={isExporting}
            className="flex items-center gap-1.5 px-3.5 py-1 rounded-md bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white text-xs font-medium transition-colors shadow disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExporting ? 'Generating ZIP...' : 'Download Project (.ZIP)'}</span>
          </button>
        </div>
      </div>

      {/* Main Container */}
      <div className="flex-1 flex overflow-hidden">
        {/* Project Files Sidebar */}
        <div className="w-64 border-r border-neutral-800 bg-[#141822] p-3 space-y-3 shrink-0 overflow-y-auto">
          <div>
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Project Structure
            </div>
            <div className="space-y-0.5">
              {ESP_IDF_PROJECT_FILES.map((file) => {
                const isSelected = selectedFile.path === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setSelectedFile(file)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors ${
                      isSelected
                        ? 'bg-purple-600/20 text-purple-300 border border-purple-500/40 font-medium'
                        : 'text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    <FileCode className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-purple-400' : 'text-slate-500'}`} />
                    <span className="font-mono truncate">{file.path}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quick Compilation Commands */}
          <div className="pt-3 border-t border-neutral-800 text-[11px] space-y-2">
            <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
              Compilation & Flashing
            </div>
            <div className="p-2.5 rounded bg-black/50 border border-neutral-800 font-mono text-[10px] space-y-1 text-slate-300">
              <div className="text-purple-300">idf.py set-target esp32s3</div>
              <div className="text-purple-300">idf.py build</div>
              <div className="text-purple-300">idf.py -p PORT flash monitor</div>
            </div>
          </div>
        </div>

        {/* Code Editor / Viewer */}
        <div className="flex-1 flex flex-col bg-[#11141e] overflow-hidden">
          {/* File Header Bar */}
          <div className="h-9 border-b border-neutral-800 bg-[#161a26] px-4 flex items-center justify-between text-xs text-slate-400">
            <div className="font-mono text-slate-200 flex items-center gap-2">
              <span>{selectedFile.path}</span>
              <span className="text-[10px] bg-neutral-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">
                {selectedFile.language.toUpperCase()}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 truncate max-w-md">
              {selectedFile.description}
            </div>
          </div>

          {/* Code Area with line numbers */}
          <div className="flex-1 overflow-auto p-4 font-mono text-xs text-slate-200 select-text leading-relaxed bg-[#0d1017]">
            <pre className="overflow-visible font-mono">
              <code>{selectedFile.code}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
