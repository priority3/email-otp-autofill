# Email OTP Autofill

Fetch email one-time passcodes (OTP) from QQ Mail / Outlook and autofill them
into the current page with a hotkey — via a local/self-hosted **agent** plus a
Chrome (MV3) **extension**.

## How it works

The Chrome extension polls an **agent** service. The agent connects to your
mailbox over IMAP / OAuth, extracts the latest verification code, and the
extension fills it into the focused input when you press the hotkey.

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

- **Mailboxes**: QQ Mail (IMAP auth code) and Outlook (OAuth device-code flow).
  Multiple accounts run in parallel.
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

Beyond MVP: QQ IMAP and Outlook OAuth (Graph device-code) are working;
multi-tenant with SQLite-backed persistence and at-rest credential encryption;
one-command Docker deploy.

## Load the extension

Chrome → `chrome://extensions` → enable Developer Mode → **Load unpacked** →
select the `chrome-extension/` folder.

## Use the public instance (no setup)

1. Load the extension (above).
2. Open the extension's **Settings** — the Agent is pre-set to
   `https://otp.razet.me`.
3. **Register / log in** (the public instance is multi-tenant, so login is
   required; enter an invite code if the instance has invite-only signup on).
4. Configure a mailbox and use it — see below.

## 使用方法 (Usage)

### 0. 登录

设置页顶部「账号」区**注册或登录**；成功后扩展会带上你的会话凭据访问 agent。
（若实例开启了「邀请码注册」，注册时需填管理员发放的邀请码。）

### 1. 配置邮箱（在扩展的「设置」页）

点击扩展图标 → `设置`（Settings）。顶部确认 `Agent` 状态为 **正常 / OK**。

- **QQ 邮箱（IMAP）**：登录 [QQ 邮箱网页版](https://mail.qq.com) → 设置 → 账号 → 开启「IMAP/SMTP 服务」→ 按提示短信验证 → 得到 **授权码**（不是登录密码）。把 QQ 邮箱和授权码填入设置页 → `保存 QQ`。
- **Outlook（OAuth，推荐）**：在 [Azure 门户 · 应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) 新建注册（账户类型选「Personal Microsoft accounts only」）→ Authentication → Add a platform → Mobile and desktop applications → 选择或填写 `https://login.microsoftonline.com/common/oauth2/nativeclient` → 将「Allow public client flows」设为 Yes → 复制 Application (client) ID 填入 → `保存 Client ID` → `开始登录`，按设备码提示在浏览器完成授权 → `轮询` 确认连接。

> 已保存的授权码/密码下次打开设置页会以圆点（••••）回填，点字段右侧的**小眼睛**即可查看明文。

### 2. 日常使用

1. 在网页上点「发送验证码」，邮件到达后，扩展工具栏图标会出现**红色角标**提示有新验证码（每 ~30 秒检查一次）。
2. **把光标点进网页的验证码输入框**，按快捷键填充：
   - macOS：`⌘ + Shift + .`
   - Windows/Linux：`Ctrl + Shift + .`

   （快捷键可在 `chrome://extensions/shortcuts` 修改。）
3. 或者点扩展图标，在弹窗里看到验证码后点 `填充` / `复制`。

填充后角标自动清除；验证码默认只在到达后 **120 秒**内有效（可在设置页「验证码有效期」调整为 10–600 秒）。

### 3. 界面语言

popup 和设置页右上角有**中 / English 切换**，首次跟随浏览器语言，之后记住你的选择。

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

Email credentials (QQ auth code / Outlook OAuth tokens) are stored encrypted in
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
