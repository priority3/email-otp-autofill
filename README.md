# Email OTP Autofill (Local)

Local helper + Chrome extension to fetch email one-time codes (OTP) from QQ Mail / Outlook and fill them into the current page via a hotkey.

## Components

- `agent/`: Local HTTP service on `127.0.0.1:17373` that connects to mailboxes and extracts OTP codes.
- `chrome-extension/`: Chrome MV3 extension (hotkey fill, popup, onboarding/options UI).

## Status

MVP in-progress: QQ via IMAP first, Outlook via OAuth device-code flow (Graph) next, with plugin-guided setup.

## Run Locally (macOS)

```bash
git clone https://github.com/priority3/email-otp-autofill.git
cd email-otp-autofill/agent
npm install
npm run dev
```

Load the extension unpacked from `chrome-extension/` in Chrome (Developer Mode).

## Deploy Agent On A Server (Docker)

This repo ships with a `docker-compose.yml` that binds the agent to `127.0.0.1:17373` on the server.
Recommended access pattern is SSH port-forwarding from your laptop so the extension can keep using `http://127.0.0.1:17373`.

On the server:

```bash
git clone https://github.com/priority3/email-otp-autofill.git
cd email-otp-autofill
docker compose up -d --build
```

On your laptop (keep this running while you need OTP autofill):

```bash
ssh -N -L 17373:127.0.0.1:17373 root@YOUR_SERVER_IP
```

## Secrets Storage

- macOS: stored in Keychain (service name: `email-otp-autofill`)
- Linux/Docker: stored in `./data/secrets.json` (make sure only root can read it)
