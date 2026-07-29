# Email OTP Autofill

**English** | [中文](README.zh-CN.md)

Fetch email one-time passcodes (OTP) from QQ Mail / Outlook / Gmail and autofill them
into the current page with a hotkey — via a local/self-hosted **agent** plus a
Chrome (MV3) **extension**.

> wip: self-hosted, ...

## How it works

The Chrome extension polls an **agent** service. The agent connects to your
mailbox over IMAP / OAuth, extracts the latest verification code, and the
extension fills it into the focused input when you press the hotkey.

For Gmail, the agent supports **Google Cloud Pub/Sub push notifications** —
when a new email arrives, Google pushes a notification to the agent in
real-time, eliminating polling delays and reducing API quota usage.

| Popup | Settings |
| --- | --- |
| ![Extension popup showing a fetched OTP](docs/screenshots/popup.png) | ![Extension settings with agent status and mailbox accounts](docs/screenshots/settings.png) |

Two ways to connect:

- **Public instance (zero setup)** — the extension ships pointing at
  `https://otp.razet.me`. Register an account and go; no server of your own.
- **Self-host** — run your own multi-tenant agent with Docker (one Docker
  Compose command).

## Components

- `agent/`: Node/TypeScript HTTP service (default `127.0.0.1:17373`) that
  connects to mailboxes, extracts OTP codes, encrypts stored credentials, and
  persists state in SQLite.
- `chrome-extension/`: Chrome MV3 extension (hotkey fill, popup, settings/
  onboarding UI, account login, EN/中文 bilingual).

## Features

- **Mailboxes**: QQ Mail (IMAP auth code), Outlook (OAuth device-code flow), and
  Gmail (OAuth authorization-code flow). Multiple accounts run in parallel.
- **Gmail Pub/Sub push**: real-time OTP delivery via Google Cloud Pub/Sub —
  zero polling delay, lower API quota usage. Falls back to polling if Pub/Sub
  is not configured.
- **OTP extraction**: keyword + scoring match for 4–8 digit codes (中/English
  keywords), with automatic validity-window detection (10s–24h).
- **Hotkey autofill**: `⌘/Ctrl + Shift + .` finds the OTP input and fills it; a
  red toolbar badge signals a fresh code (checked ~every 30s).
- **Credential encryption**: AES-256-GCM (key derived from a master key via
  scrypt); the master key lives only in the environment and is never written to
  disk.
- **Multi-tenant**: users register and log in; all mailboxes, OTPs and secrets
  are isolated per account (30-day sessions persisted in SQLite).
- **Admin panel**: `/admin` (token-gated) — user/mailbox stats, invite-code
  management, optional "invite required" registration, enable/disable users.
- **Bilingual UI**: 中 / English, switchable at runtime.

## Status

Beyond MVP: QQ IMAP, Outlook OAuth (Graph device-code), and Gmail OAuth are
working; multi-tenant with SQLite-backed persistence and at-rest credential
encryption; one-command Docker deploy. Gmail supports **Pub/Sub push
notifications** for real-time OTP delivery.

## Load the extension

Chrome → `chrome://extensions` → enable Developer Mode → **Load unpacked** →
select the `chrome-extension/` folder.

## Usage

### 0. Log in

In the Settings page, **register or log in** at the top "account" area; once
signed in the extension attaches your session credentials when talking to the
agent. (If the instance has invite-only signup enabled, enter the invite code
issued by the admin when registering.)

### 1. Configure a mailbox (in the extension's Settings)

Click the extension icon → `Settings`. Confirm the `Agent` status at the top is
**OK**.

> As in the **Settings screenshot**: the left "mailbox accounts" column lists
> connected accounts (green dot = online); the right "Agent" panel shows the
> connection address and status, and lets you set the OTP "validity (seconds)".
> Click "Add account" to configure a new mailbox.

- **QQ Mail (IMAP)**: log in to [QQ Mail web](https://mail.qq.com) → Settings →
  Account → enable "IMAP/SMTP service" → complete the SMS verification → obtain
  an **auth code** (not your login password). Enter the QQ address and auth code
  in Settings → `Save QQ`.
- **Outlook (OAuth, recommended)**: in the
  [Azure portal · App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
  create a new registration (account type "Personal Microsoft accounts only") →
  Authentication → Add a platform → Mobile and desktop applications → select or
  enter `https://login.microsoftonline.com/common/oauth2/nativeclient` → set
  "Allow public client flows" to Yes → copy the Application (client) ID and paste
  it in → `Save Client ID` → `Start login`, follow the device-code prompt to
  authorize in your browser → `Poll` to confirm the connection.
- **Gmail (OAuth)**: in the
  [Google Cloud Console · Credentials](https://console.cloud.google.com/apis/credentials)
  create an OAuth 2.0 Client ID (type "Web application") → note the Client ID
  and Client Secret → paste them in the extension's Gmail settings → `Start
  Sign-in`, authorize in your browser → the connection is established
  automatically.

  **Optional: Pub/Sub push (recommended for production)** — for real-time OTP
  delivery without polling:
  1. In [Google Cloud Console · Pub/Sub](https://console.cloud.google.com/cloudpubsub),
     create a topic (e.g. `gmail-notifications`) and a push subscription
     pointing to `https://your.domain/v1/gmail/pubsub`.
  2. In the subscription's push settings, set the **audience** to your agent's
     pubsub endpoint URL.
  3. In the agent's admin panel (`/admin`), set the Google OAuth credentials
     and Pub/Sub audience, then configure the topic name in the user's Gmail
     settings.
  4. The agent will automatically register a Gmail watch (7-day expiration,
     auto-renewed) and process incoming push notifications.

> A saved auth code/password is masked with dots (••••) the next time you open
> Settings; click the **eye** icon at the right of the field to reveal it.

### 2. Everyday use

1. Click "Send code" on the web page. When the email arrives, the extension's
   toolbar icon shows a **red badge** indicating a fresh code (checked ~every
   30s).
2. **Click into the page's OTP input**, then press the hotkey to fill:
   - macOS: `⌘ + Shift + .`
   - Windows/Linux: `Ctrl + Shift + .`

   (The shortcut can be changed at `chrome://extensions/shortcuts`.)
3. Or click the extension icon and, once the code is shown in the popup, click
   `Fill` / `Copy`.

> As in the **Popup screenshot**: the top of the popup shows the source mailbox
> (e.g. `Outlook`) and the code; the line below gives "arrival time · sender
> address · time remaining". If multiple valid codes exist at once, page through
> them with `‹ ›` (`1 / 2`); the progress bar shows the current code's remaining
> validity. `Agent: OK` at the bottom means the connection to the agent is
> healthy.

The badge clears automatically after filling; by default a code is only valid
for **120 seconds** after arrival (adjustable to 10–600s under Settings → "OTP
validity").

### 3. Interface language

The popup and Settings page have a **中 / English toggle** at the top-right; it
follows your browser language on first run, then remembers your choice.

## Self-host the agent (Docker)

```bash
git clone https://github.com/priority3/email-otp-autofill.git
cd email-otp-autofill
cp .env.example .env
```

Set two secrets in `.env` (users register/log in with their own accounts; their
data is isolated — there is no shared API key to hand out):

```bash
OTP_AGENT_MASTER_KEY=$(openssl rand -base64 32)   # at-rest encryption (required)
OTP_ADMIN_TOKEN=$(openssl rand -base64 24)        # for the /admin panel
```

Start it:

```bash
docker compose up -d --build
```

- **Users**: register / log in from the extension's Settings, then point
  **Agent Base URL** at your address.
- **You (admin)**: open `https://your.domain.tld/admin`, sign in with the admin
  token to manage invite codes, users, and view stats. Toggle "invite required"
  there if you want closed signup.

### Exposing it publicly

The agent binds to `127.0.0.1:17373` on the server. How you expose it to the
internet is **your server's concern, not this project's** — point your existing
reverse proxy or tunnel at `127.0.0.1:17373`. Common options:

- **Cloudflare Tunnel** — run a `cloudflared` connector (separately from this
  project) with an ingress rule routing `your.domain.tld → http://127.0.0.1:17373`.
- **Reverse proxy** (nginx / Caddy) terminating TLS in front of `127.0.0.1:17373`.
- **SSH port-forward** for quick testing:

  ```bash
  ssh -N -L 17373:127.0.0.1:17373 root@YOUR_SERVER_IP
  ```

Then set the extension's **Agent Base URL** to your public address.

> ⚠️ **Keep `OTP_AGENT_MASTER_KEY` safe and stable.** It decrypts your stored
> email credentials. Lose it and every mailbox must be re-entered; change it and
> previously stored secrets can no longer be decrypted. It is never written to
> disk.

## Secrets storage

Email credentials (QQ auth code / Outlook OAuth tokens / Gmail OAuth tokens) are stored encrypted in
the SQLite DB under the `data/` volume using **AES-256-GCM**,
with the key derived (scrypt) from `OTP_AGENT_MASTER_KEY`. The master key is
only read from the environment and is never written to disk — a leaked database
is useless without it.

Without a master key the agent falls back to **plaintext** and prints a startup
warning (only acceptable for throwaway local testing). Existing plaintext
secrets are automatically re-encrypted on the next startup once a key is set.

## Admin API (multi-tenant)

Token-gated by `OTP_ADMIN_TOKEN` (send as a Bearer token). Highlights:

- `GET /v1/admin/stats` — user counts, recent activity, invite usage.
- `GET/POST /v1/admin/invites`, `POST /v1/admin/invites/revoke` — manage invite
  codes.
- `POST /v1/admin/settings` — toggle invite-required registration.
- `GET /v1/admin/users`, `POST /v1/admin/users/disable` — list / enable /
  disable users.

A browser UI for the same lives at `/admin`.

## Community
This open-source project is linked and endorsed by the [LINUX DO](https://linux.do/).
