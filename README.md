# ESP32-S3 N16R8 Windows 11 WebOS Firmware

This project turns an **ESP32-S3 N16R8** (16MB Flash, 8MB Octal PSRAM) into a **Windows 11-style WebOS Server** that mounts a USB mass-storage drive via USB-OTG Host and provides persistent user accounts, User Account Control (UAC) elevation, and browser-based desktop apps.

---

## 1. Hardware Pinout & Wiring (USB-OTG Host)

The ESP32-S3 features native USB 2.0 Full-Speed (12 Mbps) OTG pins:
| ESP32-S3 Pin | Function | Connect to USB Type-A (Female) Receptacle |
|---|---|---|
| **GPIO 19** | USB D- | Pin 2 (White, D-) |
| **GPIO 20** | USB D+ | Pin 3 (Green, D+) |
| **GND** | Ground | Pin 4 (Black, GND) |
| **5V VBUS** | 5V Power Supply | Pin 1 (Red, +5V VBUS) |

> ⚠️ **CRITICAL POWER NOTE:**
> Standard USB flash drives require **5V** to operate. The 3.3V pin on the ESP32-S3 is insufficient. Supply a clean 5V (from your 5V USB input, a boost converter, or a powered USB hub) to the Red wire of the USB connector.

---

## 2. Preparing the USB Flash Drive
1. Format the USB drive as **FAT32**. The firmware detects the device capacity and USB VID/PID from the connected drive; it does not assume a fixed 32GB size.
2. Put audio/video and subtitle files under `/media` on the drive to play them through the ESP32 web player. Media streaming supports HTTP byte ranges for browser seeking. Only this directory is exposed by the media API; normal file browsing is not enabled by this route.
3. The firmware automatically generates the required folders on first boot:
   - `/usb/Windows/System32`
   - `/usb/Program Files`
   - `/usb/Users/Administrator`
   - `/usb/system`
4. The ESP32 serial log reports the USB VID:PID, manufacturer/product strings, and SCSI sector capacity. The Settings screen reads these values from the ESP32 API and refreshes the mounted status every five seconds; it does not infer a brand from the capacity.
5. Capacity is the physical device size reported by SCSI. Used/free space is reported separately from the mounted FAT filesystem and may be unavailable if the filesystem query fails.
6. The drive can store arbitrary files, but this firmware does not execute `.exe`, `.com`, or other native binaries. Use browser-based `.html`/`.webapp` apps or supported document and media formats.

### USB filename abstraction

On first mount of each compatible FAT USB mass-storage drive, the ESP32 renames existing USB files and folders to opaque IDs and records that drive's readable-name-to-ID mapping in the ESP32's internal `storage` SPIFFS partition. Windows-managed `System Volume Information` is intentionally left unchanged. Drive maps are selected by USB serial number (or VID/PID/capacity when no serial is reported), so another drive can be mounted as the main `D:` volume and its map is kept separately; reconnect a drive to recover its original names. The Win11 File Explorer resolves those names from the active map, lists at most 128 entries per folder, previews supported text files up to 16 KiB, and displays PNG, JPEG, GIF, BMP, WebP, AVIF, SVG, and ICO images. USB browser paths and upload names are sent outside the request URL, and media playback uses opaque drive paths, so long readable names do not cause HTTP 414 URI-too-long failures. The migration renames directory entries only; it does not format the USB drive or rewrite file contents. Keep each drive connected to the same ESP32 and do not erase/replace its internal `storage` partition: without its mapping, the original names cannot be recovered from opaque USB names. A mapping error leaves the USB volume unavailable rather than automatically formatting it. If first-time setup reports a map error, stop and preserve both the USB drive and the ESP32 flash for recovery.

This is filename abstraction, **not encryption or confidentiality**. Another OS can still read or copy file contents by opening the opaque IDs, and may modify or delete them. The ESP32 UI can create folders, upload files, and delete mapped files/folders after an administrator password check by the firmware. File Explorer asks for that password once after the first successful write operation and keeps it only in page memory until the page is closed or reloaded; the firmware still checks it on every write request. Uploads are streamed without an application-defined size cap; actual limits depend on available USB space and the HTTP server's request-size representation. Text previews remain limited to 16 KiB, independently of upload size. The mapping stores logical paths up to 255 bytes and migration supports at most 16 nested folder levels; if a path or internal mapping capacity limit is hit, migration stops and the USB volume remains unavailable rather than formatting it. Passwords are sent over the existing plain-HTTP connection; this assumes the local network is trusted and does not protect against network sniffing or an attacker already on that network. On a different ESP32, a drive's original names will not be available unless its internal mapping database is transferred too.

---

## 3. How to Build & Flash with ESP-IDF v5.1+

```bash
# 1. Set the target chip to ESP32-S3
idf.py set-target esp32s3

# 2. Build the firmware
idf.py build

# 3. Flash to ESP32-S3 (replace /dev/ttyUSB0 with your COM port)
idf.py -p /dev/ttyUSB0 flash monitor
```

---

## 4. Build and install the web interface on the USB drive

The React/Vite app in `Gemini-generated-dir` is separate from the ESP-IDF firmware. The firmware prefers the production build at `/usb/www` and can also serve it directly from `/usb` if the `dist` contents were copied to the drive root; it does not serve the app's `src` directory directly.

1. On your PC, open a terminal in `Gemini-generated-dir` and run:
   ```bash
   npm install
   npm run build
   ```
   This creates `Gemini-generated-dir/dist`.
2. Power off or unplug the USB drive from the ESP32, then connect it to your PC.
3. Create a `www` folder at the root of the drive. Copy the **contents** of `dist` into that folder, so the drive contains `www/index.html` and `www/assets/...`.
4. Safely eject the drive and reconnect it to the ESP32. The firmware mounts it at `/usb`; do not copy the `src` folder or the `dist` folder itself.

After updating the firmware or replacing the web build, use a browser hard refresh to avoid cached assets.

System and application `ESP_LOGx` output is mirrored to `/system/logs/` on the USB drive. If the drive is absent during startup, recent lines are buffered in RAM and flushed when it mounts. Account state, per-user desktop settings, profile wallpapers, DNS settings, and DNS domain rules are also written to USB storage. The production UI is served from `/www`; keep the built `dist` contents on the drive for the interface and all of its assets to remain available.

The DNS Filtering app runs a UDP resolver on port 53, forwards permitted requests to its configured upstream IPv4 resolver, and answers blocked domains with NXDOMAIN. It starts enabled with a small starter domain set; settings and added block/allow rules persist under `/system/dns/`. Network clients must use the ESP32 as their DNS resolver to receive filtering; clients on the home Wi-Fi may need router DHCP DNS configuration, while clients on the ESP32 access point can set the device address manually. This is a lightweight local resolver, not a full Pi-hole blocklist downloader.

Custom rules can be literal domains or case-insensitive POSIX extended regular expressions (up to 32 regex rules, 253 characters per pattern). Literal domain matches take precedence; if no literal matches, the last matching regex in the saved rule order wins. The dashboard includes allowed/blocked/failed outcome totals, top queried domains and clients, recent requests, and a 60-minute chart in 5-minute buckets. These analytics use the newest 64 in-memory logged requests, require query logging to be enabled, and are cleared at reboot; they are not persistent long-term history.

The firmware and initial browser account use the factory password `password`. Change it in Settings while the USB drive is mounted; firmware administrator credential updates are committed to `/system/users.db`. Use a unique password and keep the device on a trusted network because the current web server uses plain HTTP.

## OTA updates and power preparation

OTA uploads are verified and written to the inactive partition; they do not replace the running image immediately. When **Automatically reboot after staging an OTA update** is disabled (the default), choose **Restart to apply update** on the update screen or use the Start menu's **Restart ESP32-S3** option. Restart and shutdown-preparation requests require the administrator password, drain the asynchronous log queue, flush the log file, stop DNS/web/Wi-Fi services, and close/unmount USB storage before rebooting or indicating readiness. A red LED means preparation failed; keep power connected and retry after resolving the reported issue.

The Start menu's **Prepare shutdown** option and a configurable long hold of the active-low BOOT button perform the same flush and service-stop sequence, then leave the ESP32 powered with the WS2812 LED steady purple. This is a preparation signal only: the ESP32 cannot remove its own power, so use external power-cut hardware only after the LED indicates ready. Do not hold BOOT while resetting the board; GPIO0 may select the ROM download mode.

The WS2812 indicates OTA reading (blue), writing (cyan with brightness reflecting progress), verification (amber), pending restart (blue-violet), preparation (orange), ready for external cutoff (purple), and failure (red). LED enable, GPIO, and brightness; BOOT GPIO and hold duration; power-response and log-flush timeouts; automatic OTA restart; and the OTA startup-confirmation delay are available in `idf.py menuconfig` under **Win11 WebOS hardware**. The OTA image remains rollback-eligible until the web server has started and the configured validation delay has elapsed; this startup check cannot detect every later application fault.

## 5. Connecting to the Windows 11 WebOS
1. Power on the ESP32-S3 board with the USB flash drive plugged into GPIO 19/20. Wait for the serial log to report that the drive is mounted and Wi-Fi is connected.
2. Connect your PC or phone to the same Wi-Fi network as the ESP32-S3.
3. Open any modern browser (Chrome, Edge, Safari, Firefox) and navigate to the station IP printed in the serial log (currently **`http://192.168.1.20`**).
4. If the page returns 503, the drive is not mounted. If it returns 404 at `/`, check that the USB drive has `www/index.html` at its root.

## 6. Command Prompt

The desktop Command Prompt runs a defined set of browser-side commands; it is not a Windows shell or an ESP32 operating-system shell. With a USB drive mounted, `DIR`, `CD`, and `TYPE` read real USB directories and supported text files through the firmware API. `MD`, `DEL`, and `ECHO text > file` perform real USB changes after the firmware verifies an administrator password. Text writes are limited to 16 KiB. Without a mounted drive, file commands use the browser's local virtual filesystem. `MEM`, `SYSTEMINFO`, and `IPCONFIG` query live ESP32 telemetry; `START` opens supported desktop apps. Native `.EXE` and `.COM` programs are not executable on this firmware.

`yt-dlp` and `ani-cli` do not run in this terminal: they require a general-purpose host operating system and tools unavailable in ESP-IDF firmware. `yt-dlp` is a host-side Python application; `ani-cli` is a Unix shell script with external command dependencies. Install/run those only on a suitable PC, then transfer supported media files to the USB drive for playback. The ESP32 media player streams files; it does not download or decode content itself.

## 7. LAN Browser Bridge (Windows companion)

The Browser Bridge runs a website in a hidden, offscreen Chromium instance on your Windows PC and streams its view to the ESP32 desktop. The ESP32 page sends pointer, wheel, and keyboard input to that instance; it does not open a visible browser window or run the website on the ESP32.

1. On the Windows PC, open a terminal in `Gemini-generated-dir` and run `npm install` if needed. Start it with `npm run companion:background`; the command returns while the companion keeps running independently of that terminal. Use `npm run companion` only when you want to keep the foreground process attached to the terminal.
2. Allow the companion through Windows Firewall on **Private networks only** if prompted. Do not expose port 8765 to Public networks or the Internet.
3. In the ESP32 desktop, open **LAN Browser Bridge**. Enter one of the private IPv4 addresses shown by the companion and its six-digit pairing code. The code expires after five minutes and is single-use. Both devices must be on the same reachable LAN; the bridge uses no cloud relay or STUN server.
4. The companion starts without opening a control window. Use the notification-area icon’s **Pairing code** and **Copy pairing details** items, then connect from **LAN Browser Bridge** in the ESP32 desktop. The website runs offscreen; the only normal UI is the tray icon. **Show status panel** opens the optional control panel. Use **Quit Browser Bridge** to stop the service and website instance.

The WebRTC media and control channel are encrypted by WebRTC/DTLS after negotiation. Pointer, wheel, and keyboard events are dispatched to the offscreen page through Chromium DevTools input events, allowing remote input without bringing a PC window to the foreground. Links that normally open a new tab/window are navigated in the same remote browser view. Pairing/signaling itself uses plain WebSocket on the trusted LAN, so this is not a mutually authenticated end-to-end tunnel and must not be exposed to an untrusted network. The six-digit code is rate-limited, but is not a substitute for trusted-network access. The companion only forwards browser-window pixels and input; it does not expose the PC filesystem or other applications. Some sites may not work with remote control, and video is a limited-frame-rate desktop capture rather than native browser video.

## 8. Media Player

The Media Player can play files selected from the browser device or files served from the ESP32-attached USB drive. For USB playback, put media under `/media`, open **Browse ESP32 USB**, and select a file; use **Add USB subtitles** for `.srt`/`.vtt` files from the same drive. Local files can still be opened with **Open media files** and **Add subtitles**. SRT is converted to WebVTT in the browser. Common formats include MP3, WAV, OGG, AAC, FLAC, MP4, WebM, MOV, and MKV; actual codec support depends on the browser/device. The ESP32 streams the bytes but does not decode or render the media.

## 9. Hardware controls and temperature monitoring

The Hardware Controls app only exposes GPIO 4-7 as digital low/high outputs. These pins boot untouched and are configured as outputs at logic-low only when first selected. Never connect motors, relays, LEDs without resistors, or other loads directly; use suitable external driver circuitry and verify your board wiring before enabling a pin. GPIO 19/20 are reserved for USB D-/D+ and are not exposed.

The temperature panel reads the ESP32-S3's on-die sensor via ESP-IDF and refreshes from the same sensor used for serial logging. It is not a temperature sensor for the USB drive, PSRAM, or room. **Run 10-second load test** starts a bounded, low-priority CPU workload on the ESP32; the panel continues displaying measured sensor readings and does not simulate temperature, claim CPU throttling, or apply a thermal cutoff. Do not run it if the board is already unusually hot or unstable.

Task Manager telemetry is read from `/api/system/stats`: FreeRTOS task names/states/priorities/core affinity and stack high-water marks, CPU idle-time utilization, detected flash/PSRAM and live internal/PSRAM heap figures, Wi-Fi AP/station status and client count, USB mount state, GPIO outputs, temperature sensor, and project subsystem/driver status. CPU utilization requires a second sample to calculate. This is firmware/FreeRTOS telemetry, not Windows process reporting; the firmware does not currently attribute heap or USB I/O to individual tasks, measure USB transfer rate, or expose every statically linked HAL function as a separate driver.

Firmware runtime guards reject malformed/oversized API payloads and byte ranges, validate USB capacity/account database bounds, stop guest-emulator reads at RAM boundaries, check task/semaphore/allocation failures, and defer USB disconnect teardown out of the MSC callback into its monitor task. These reduce known overflow and callback re-entrancy risks; they cannot guarantee that hardware faults, driver bugs, or every external I/O stall will never hang the device.

The web desktop opens on the local account sign-in screen. Account profiles, the selected account, wallpaper, and desktop window layout are saved on the ESP32 internal `storage` partition and shared by browsers connecting to the same ESP32. Account state is stored in two alternating files so an interrupted update leaves the previous saved copy available; each JSON document is limited to 2 MiB. This sign-in remains frontend-enforced and is not a network-authentication boundary for the firmware HTTP APIs; use only on a trusted local network.

The Calculator and Office Suite are lightweight browser apps (plain-text document editor, editable spreadsheet with basic formulas, and slide builder), not Microsoft Office and not native Windows applications. Office documents, spreadsheets, and slides are saved with the signed-in account on the ESP32, with browser storage retained as a local fallback. The Calculator does not save a history.
