# ESP32-S3 Win11 WebOS: App & Game Guide (WebUI / FN/LFN Abstraction)

This guide explains how browser applications, games, and files are imported and used in the **ESP32-S3 Windows 11 WebOS** environment using the **WebUI**, **File Explorer**, and the **8.3 Short Name (FN) / Long File Name (LFN) Abstraction Layer**.

---

## 📑 Table of Contents
1. [Understanding the FN / LFN Storage Abstraction Layer](#1-understanding-the-fn--lfn-storage-abstraction-layer)
2. [Importing Apps & Games via the WebUI (Browser Client)](#2-importing-apps--games-via-the-webui-browser-client)
3. [Executable Compatibility](#3-executable-compatibility)
4. [Building Native WebOS Apps (TypeScript & React SDK)](#4-building-native-webos-apps-typescript--react-sdk)
5. [Watchdog Safeguards & Process Kill Protection](#5-watchdog-safeguards--process-kill-protection)
6. [Best Practices for WebUI File Imports](#6-best-practices-for-webui-file-imports)

---

## 1. Understanding the FN / LFN Storage Abstraction Layer

When running on an embedded FAT32 filesystem (such as standard FATFS without patent/licensing encumbrances or large LFN heap tables in ESP32 internal RAM), file names on the physical drive are stored in **8.3 format** (Short File Names / SFN).

To preserve descriptive file names (e.g., `ESP32S3_N16R8_Specs.txt`, `USB_OTG_Wiring.txt`), this project implements a **transparent bidirectional abstraction layer**:

```
+-------------------------------------------------------------+
|                     Windows 11 WebUI                        |
|       Displays Full Long File Names (LFN) & Folders         |
|         e.g., "D:\Users\Administrator\Documents\USB_OTG_Wiring.txt" |
+-------------------------------------------------------------+
                              ▲
                              │ HTTP REST API with Base64 Headers
                              │ X-Upload-Path / X-Upload-Name / X-USB-Path
                              ▼
+-------------------------------------------------------------+
|             ESP-IDF usb_storage_map (Internal Flash)        |
|    Maintains persistent mapping between Logical and 8.3:    |
|       Logical:  /Users/Administrator/Documents/USB_OTG_Wiring.txt |
|       Physical: /usb/USERS/ADMINI~1/DOCUME~1/USB_OT~1.TXT    |
+-------------------------------------------------------------+
                              ▲
                              │ POSIX open/read/write/opendir
                              ▼
+-------------------------------------------------------------+
|             Native USB-OTG MSC FAT32 Flash Drive            |
|                   Mounted at /usb (D:\)                     |
+-------------------------------------------------------------+
```

### Key Properties:
* **Zero Flash Remounting Needed:** You do **not** need to unplug the USB stick or flash code to ESP32 SPI memory to install or update files.
* **Safe Header Encoding:** File names sent via the WebUI are encoded in RFC-compliant Base64 headers (`X-Upload-Name`, `X-Upload-Path`) to handle spaces, special characters, and Unicode seamlessly across HTTP requests.
* **UAC Security Integration:** Administrative write operations (e.g. creating directories, deleting system files, or uploading files to protected directories) automatically prompt for UAC password confirmation.

---

## 2. Importing Apps & Games via the WebUI (Browser Client)

You can import browser apps, text files, media, and other data directly from your browser without flashing anything to the ESP32 board. Native executable binaries can be stored but are not run by the firmware.

### Step-by-Step Import:

1. **Launch the Web Desktop:**
  * Connect to the same local network as the ESP32-S3 and open the station IP printed in the serial log (currently `http://192.168.1.20`).
   * Unlock the Windows 11 Lock Screen.

2. **Open File Explorer:**
   * Double-click the **This PC** desktop icon or launch **File Explorer** from the Start Menu.
  * Navigate to `D:\` (the mounted USB drive) or a subfolder like `D:\Users\Administrator\Desktop`.

3. **Upload the App / Game File:**
   * In the File Explorer toolbar, click **Upload File to USB**.
  * Select your browser app (`.html`, `.app`, `.webapp`), script, document, media file, or game asset.
   * If modifying protected directories or physical USB media, enter your Administrator password when the UAC prompt appears.

4. **Automatic LFN Registration:**
  * The WebUI streams the selected file in chunks to the `/api/storage/upload` endpoint.
   * The firmware's `usb_storage_map` generates the physical 8.3 entry while preserving the original Long File Name in the index.
  * The file instantly appears in the File Explorer directory listing with its file type and size.

---

## 3. Executable Compatibility

The ESP32-S3 runs Xtensa firmware and has no Windows process runtime. Native `.exe`, `.com`, and `.bat` files can be stored on USB, but cannot be executed by this WebOS. Use HTML5 apps (`.html`, `.app`, `.webapp`) in the Dynamic App Runner or build React components with the App Platform SDK. Text and source files open in Notepad; media files open in Media Player; supported office files open in Office Suite.

---

## 4. Building Native WebOS Apps (TypeScript & React SDK)

If you are developing a rich, interactive WebOS app or canvas-based game (like the built-in Snake, Minesweeper, Pong, or Dev Studio), build it using the **App Platform SDK**:

### 1. Component Implementation (`src/components/apps/MyGame.tsx`)
```tsx
import React, { useState, useEffect } from 'react';
import { usePlatform, AppProps } from '../../platform';

export const MyGame: React.FC<AppProps> = ({ width, height }) => {
  const platform = usePlatform();
  const [score, setScore] = useState(0);

  useEffect(() => {
    // Inter-app messaging listener
    const unsubMsg = platform.onMessage((msg) => {
      console.log('Received message:', msg);
    });

    // Device memory pressure watcher
    const unsubPressure = platform.onPressureChange((snap) => {
      if (snap.pressureLevel === 'critical') {
        platform.showToast('Low ESP32 memory: reducing background load', 'warning');
      }
    });

    return () => {
      unsubMsg();
      unsubPressure();
    };
  }, [platform]);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-white p-6 items-center justify-center">
      <h2 className="text-base font-bold">My WebOS Game</h2>
      <p className="text-2xl font-mono text-emerald-400 mt-2">{score}</p>
      <button
        onClick={() => {
          setScore(s => s + 1);
          platform.showToast('Point scored!', 'success');
        }}
        className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-xs font-semibold"
      >
        Play
      </button>
    </div>
  );
};
```

### 2. Manifest Registration
Define the manifest with requested permissions:
```typescript
const MY_GAME_MANIFEST: AppManifest = {
  id: 'my-game',
  name: 'My Game',
  version: '1.0.0',
  description: 'Custom interactive WebOS game',
  icon: '🎮',
  tileColor: 'bg-emerald-500/10',
  appType: 'myGame',
  permissions: ['notifications', 'hardware', 'interAppMessage'],
  windowDefaults: { width: 640, height: 480 },
  component: MyGame,
};

appRegistry.register(MY_GAME_MANIFEST);
```

---

## 5. Watchdog Safeguards & Process Kill Protection

To prevent any app, script, or uploaded binary from exhausting the **ESP32-S3 N16R8** hardware, multi-tier watchdogs are active at all times:

### Frontend Watchdog (`AppSandbox.tsx`)
* **Infinite Loop Killer:** If an app triggers >500 renders in a 5-second window, the sandbox immediately kills and unmounts the app.
* **Long Frame Watchdog:** If a synchronous render frame exceeds 200ms (or spikes over 600ms), it is auto-terminated to prevent freezing the UI.
* **Crash Recovery:** If an uncaught exception occurs, a recovery screen appears with a **Restart App** button (up to 5 attempts before locking).

### Firmware Memory Watchdog (`app_platform.c` + `ResourceGuard.tsx`)
The FreeRTOS watchdog task queries internal SRAM and PSRAM every **500ms**:

| Pressure Level | Condition | System Action |
| :--- | :--- | :--- |
| **`none`** | Internal SRAM > 60 KB, PSRAM > 512 KB | Normal operation. |
| **`low`** | Internal SRAM < 60 KB | Displays a desktop toast alert. |
| **`critical`** | Internal SRAM < 30 KB | Automatically **kills the lowest-priority open app** (e.g. background games) to recover heap. |
| **`emergency`** | Internal SRAM < 15 KB | Automatically **kills all non-essential user apps**, triggers heap compaction, and suspends new HTTP connections to prevent microcontroller reboot. |

*System critical tools (`terminal`, `taskmgr`, `settings`) are protected and will never be auto-killed.*

---

## 6. Best Practices for WebUI File Imports

1. **Keep Web Apps Compact:**
  * The WebOS loads browser apps from USB storage; prefer small HTML/JS bundles and stream large media files.
2. **Use Subfolders on `D:\`:**
  * Store browser apps and document files in organized USB folders such as `D:\Users\Administrator\Documents`.
3. **Use PSRAM for Large Allocations:**
  * ESP-IDF routes eligible large dynamic allocations to PSRAM. Keep task stacks and buffers used while flash caches are disabled in internal RAM.
4. **Take Advantage of LFN:**
   * You can use normal, descriptive names (e.g., `Space Invaders v1.2.exe`). The `usb_storage_map` handles the underlying 8.3 conversion automatically without corrupting the file system.
5. **Clean Up Large Previews:**
   * When uploading large text or image files, previews are streamed dynamically from `/api/storage/read` and `/api/storage/image` to prevent filling the browser's JavaScript memory.
