import React from 'react';
import { Sliders, Zap, AlertTriangle, CheckCircle2, HardDrive, Cpu } from 'lucide-react';
import boardImage from '../assets/images/esp32s3_n16r8_board_1791021208517.jpg';

export const HardwareGuideApp: React.FC = () => {
  return (
    <div className="flex flex-col h-full bg-[#181d28] text-slate-100 select-none overflow-y-auto p-6 space-y-6">
      {/* Title */}
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Sliders className="w-5 h-5 text-orange-400" />
          <span>ESP32-S3 N16R8 Hardware & USB-OTG Wiring Guide</span>
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Complete schematic and power rail configuration to mount a 32GB USB flash drive as primary internal storage.
        </p>
      </div>

      {/* Top Banner with board photo & specs */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60">
        <div className="md:col-span-4 rounded-xl overflow-hidden border border-neutral-700 bg-neutral-900">
          <img
            src={boardImage}
            alt="ESP32-S3 N16R8 Development Board"
            className="w-full h-44 object-cover"
          />
          <div className="p-3 text-[11px] font-mono text-slate-400 border-t border-neutral-800">
            ESP32-S3-WROOM-1-N16R8 (16MB Flash / 8MB Octal PSRAM)
          </div>
        </div>

        <div className="md:col-span-8 flex flex-col justify-center space-y-3">
          <div className="text-sm font-semibold text-white">Why N16R8 is Crucial:</div>
          <p className="text-xs text-slate-300 leading-relaxed">
            The <strong>N16R8</strong> variant features <strong>16 MB of SPI Flash</strong> and <strong>8 MB of Octal SPI PSRAM</strong> running at 80 MHz in DTR (Double Transfer Rate) mode. PSRAM expands the dynamic heap for large application data and buffers, while cache-sensitive tasks and flash operations continue to use internal SRAM.
          </p>
          <div className="flex flex-wrap gap-2 text-[11px] font-mono">
            <span className="px-2.5 py-1 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
              8MB Octal PSRAM (0x3D000000)
            </span>
            <span className="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
              32GB USB-OTG Host (FAT32)
            </span>
            <span className="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              240MHz Dual-Core Xtensa LX7
            </span>
          </div>
        </div>
      </div>

      {/* Pinout Table */}
      <div className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-4">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-amber-400" />
          <span>USB 2.0 Type-A Female Receptacle to ESP32-S3 Pinout</span>
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-neutral-700 text-slate-400 pb-2">
                <th className="py-2 px-3 font-semibold">USB Connector Pin</th>
                <th className="py-2 px-3 font-semibold">Wire Color</th>
                <th className="py-2 px-3 font-semibold">Signal</th>
                <th className="py-2 px-3 font-semibold">ESP32-S3 Connection</th>
                <th className="py-2 px-3 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 font-mono text-[11px]">
              <tr>
                <td className="py-2.5 px-3 font-bold text-white">Pin 1</td>
                <td className="py-2.5 px-3 text-red-400">Red</td>
                <td className="py-2.5 px-3 text-red-400">+5V VBUS</td>
                <td className="py-2.5 px-3 text-red-300 font-bold">5V Power Rail (or 5V In pin)</td>
                <td className="py-2.5 px-3 text-slate-400 font-sans">Must provide 5V! 3.3V will fail to power the USB drive.</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 font-bold text-white">Pin 2</td>
                <td className="py-2.5 px-3 text-slate-200">White</td>
                <td className="py-2.5 px-3 text-amber-300">USB D-</td>
                <td className="py-2.5 px-3 text-amber-400 font-bold">GPIO 19</td>
                <td className="py-2.5 px-3 text-slate-400 font-sans">ESP32-S3 Native USB PHY D- (Full-Speed 12 Mbps)</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 font-bold text-white">Pin 3</td>
                <td className="py-2.5 px-3 text-emerald-400">Green</td>
                <td className="py-2.5 px-3 text-emerald-300">USB D+</td>
                <td className="py-2.5 px-3 text-emerald-400 font-bold">GPIO 20</td>
                <td className="py-2.5 px-3 text-slate-400 font-sans">ESP32-S3 Native USB PHY D+ (Full-Speed 12 Mbps)</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 font-bold text-white">Pin 4</td>
                <td className="py-2.5 px-3 text-slate-400">Black</td>
                <td className="py-2.5 px-3 text-slate-400">GND</td>
                <td className="py-2.5 px-3 text-slate-300 font-bold">GND Pin</td>
                <td className="py-2.5 px-3 text-slate-400 font-sans">Common system ground reference</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Warning callout */}
        <div className="p-3.5 bg-amber-950/40 border border-amber-800/60 rounded-xl flex items-start gap-3 text-xs text-amber-200">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <span className="font-semibold text-white">Crucial Power Notice for 32GB Flash Drives:</span> USB flash drives require 5V with up to 100mA–200mA current during block write operations. Connect the USB receptacle’s Red wire directly to the ESP32-S3 board’s <strong>5V / VIN</strong> pin (which is powered by the incoming USB-C cable), or use a separate 5V regulator.
          </div>
        </div>
      </div>

      {/* Formatting instructions */}
      <div className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-3 text-xs">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-emerald-400" />
          <span>Formatting the 32GB USB Flash Drive for Persistence</span>
        </h3>
        <ol className="list-decimal list-inside space-y-2 text-slate-300 leading-relaxed">
          <li>Insert your 32GB flash drive into a PC or Mac.</li>
          <li>Format the drive with <strong>FAT32</strong> file system with <strong>32 KB</strong> allocation unit size (cluster size).</li>
          <li>Ensure the partition scheme is <strong>MBR (Master Boot Record)</strong> rather than GPT.</li>
          <li>Insert the flash drive into the USB Type-A OTG connector wired to GPIO 19/20.</li>
          <li>When the ESP32-S3 boots, it automatically mounts the drive under <code className="text-amber-300 bg-black/40 px-1 py-0.5 rounded">/usb</code> and creates the Windows 11 system directory structure!</li>
        </ol>
      </div>
    </div>
  );
};
