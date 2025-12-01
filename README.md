<p align="center">
  <img src="assets/icon128.png" alt="SpoofGuard logo" width="112" height="112" />
</p>

<h1 align="center">SpoofGuard — Gmail Security Shield</h1>

<p align="center">
  Real‑time email analysis Chrome extension that summarizes authentication (SPF/DKIM/DMARC), computes a security score, and classifies content with an external ML model server.
</p>

<p align="center">
  <strong>Chrome MV3</strong> · <strong>Gmail</strong> · <strong>FastAPI</strong> · <strong>TensorFlow</strong>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install-the-extension-developer-mode">Install</a> ·
  <a href="#model-server-google-cloud-vm">Model Server</a> ·
  <a href="#point-the-extension-to-your-server">Configure</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

## Features
- Security score with authentication and content breakdown
- SPF, DKIM, DMARC status and inline explanations
- AI Content Analysis with classification label and reasoning bullets
- Gmail API integration for reliable header retrieval

## Directory Overview
- `popup/` — UI for the extension popup (score, identity, auth, AI)
- `content/` — content script for Gmail page detection and header extraction
- `background/` — service worker (Gmail API, DNS, classifier calls)
- `model/` — FastAPI inference server and model assets
- `assets/` — extension icon set
- `manifest.json` — Chrome Manifest V3 configuration

---

## Requirements
- Chrome (or Edge) with Extension Developer Mode
- A reachable ML inference server (FastAPI) for `/classify`
- Gmail API OAuth credentials (client ID) for header access

## Install the Extension (Developer Mode)
1. Clone or download this repository.
2. Open Chrome → `chrome://extensions` → enable `Developer mode`.
3. Click `Load unpacked` → select the project root (`SpoofGuard`).
4. The extension appears in the toolbar with the SpoofGuard icon.

> Tip: Pin the SpoofGuard icon to your toolbar for quick access.

## Configure Gmail API OAuth
SpoofGuard uses Gmail Readonly scope to fetch reliable headers.

- Create an OAuth Client ID in Google Cloud Console (OAuth consent screen set to External or appropriate type).
- Enable Gmail API and grant scope `https://www.googleapis.com/auth/gmail.readonly`.
- Replace `oauth2.client_id` in `manifest.json` with your Client ID.
- Reload the extension after editing.

> Note: Do not commit secrets. MV3 uses client ID only (no client secret in the extension).

## Model Server (Google Cloud VM)
The ML classifier runs outside the extension. The instance previously used is paused to save resources; you must deploy your own.

### Recommended VM Setup (Google Cloud)
- Create a VM (Linux) with sufficient memory (e.g., 8–16 GB RAM if using TensorFlow CPU).
- Open firewall for TCP port `8000` (or your chosen port).
- Install Python 3.10+ and create a virtual environment.
  Run the following commands on your VM:

```bash
sudo apt update && sudo apt install -y python3-pip python3-venv
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn[standard] tensorflow numpy pydantic keras
```

### Deploy the server
Copy the `model/` folder to your VM and run uvicorn:

```bash
cd model
uvicorn inference_server:app --host 0.0.0.0 --port 8000
```

The API exposes:
- `POST /classify`
  - Request: `{ "text": "email body text" }`
  - Response: `{ "label": "Normal|Fraudulent|Harassing|Suspicious", "probabilities": { ... } }`

CORS is enabled, so the browser can call it directly.

---

## Point the Extension to Your Server
The background service worker reads `aiServerUrl` from `chrome.storage.sync`. Default points to a paused instance.

Set your own URL (one‑time) via the extension background console:
1. Open `chrome://extensions` → SpoofGuard → `Service worker` → `Inspect`.
2. Run:

```js
chrome.storage.sync.set({
  spoofGuardSettings: {
    aiServerUrl: 'http://YOUR_VM_PUBLIC_IP:8000',
    realTimeMonitoring: true,
    showNotifications: true,
    detailedLogging: false,
    cacheTimeout: 300000
  }
});
```

Reload Gmail and open an email; the popup will call your server.

---

## How It Works
- Content script extracts sender, subject, and attempts headers; Gmail API fills gaps.
- Background fetches DNS TXT records (SPF/DMARC via DoH) and calls `/classify`.
- Popup renders the score, identity, auth statuses with explanations, and AI classification.

## Troubleshooting
- Subject missing: the content script falls back to document title; ensure Gmail is open on a message view.
- “Failed to fetch” for classifier: VM paused or firewall closed; verify `curl http://IP:8000/classify` from outside.
- Gmail API auth fails: verify your OAuth client ID in `manifest.json` and consent screen configuration.

## Security Notes
- Do not log or store Gmail data beyond temporary caches.
- Never commit keys or secrets.
- Use HTTPS for the classifier in production and restrict CORS origins.
