<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/f4db6059-a56e-422d-8250-06f45a0fc81a

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

The app uses the ESP32 as the shared account/profile and desktop-state backend.
Vite proxies `/api` requests to `http://192.168.1.20` by default; set
`ESP32_API_TARGET` in `.env.local` to the board's reachable address if needed.
Open the same Vite host from each device so all clients use that backend.
To identify the running firmware, check **System Stats** in the desktop; bump
`PROJECT_VER` in the root `CMakeLists.txt` for each firmware release.

DNS ad-blocker settings, custom rules, and per-query history are stored on the
ESP32's internal LittleFS (`/storage/dns`) and survive reboots. Completed daily
history is copied to `/usb/system/dns` when the USB drive is available; the
internal copy is kept unless the archive succeeds. The DNS app's hourly chart
uses the persistent UTC+8 daily history, and its light/dark appearance toggle
is remembered in that browser.
