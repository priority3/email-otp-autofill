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

This repo ships with a `docker-compose.yml` that can:

- run the agent (binds to `127.0.0.1:17373` on the server by default)
- optionally run `cloudflared` to expose the agent via Cloudflare Tunnel (no SSH port-forwarding needed)

On the server:

```bash
git clone https://github.com/priority3/email-otp-autofill.git
cd email-otp-autofill
```

### Option A: Cloudflare Tunnel (Recommended)

1. Create a Cloudflare Tunnel and configure a hostname to route to `http://agent:17373` (so it works inside Compose).
2. Create a random API key and set it on the server.
3. Put both in a local `.env` on the server (do not commit):

```bash
cat > .env <<'EOF'
OTP_AGENT_API_KEY=your_random_api_key
CF_TUNNEL_TOKEN=your_tunnel_token
EOF
```

4. Start:

```bash
docker compose --profile cloudflare up -d --build
```

In the extension settings:

- `Agent Base URL`: `https://your.domain.tld`
- `Agent API Key`: same as `OTP_AGENT_API_KEY`

### Option B: SSH Port-Forward (Fallback)

Start agent only:

```bash
docker compose up -d --build
```

Then from your laptop:

```bash
ssh -N -L 17373:127.0.0.1:17373 root@YOUR_SERVER_IP
```

## Secrets Storage

- macOS: stored in Keychain (service name: `email-otp-autofill`)
- Linux/Docker: stored in `./data/secrets.json` (make sure only root can read it)
