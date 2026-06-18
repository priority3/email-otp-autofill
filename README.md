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

## 使用方法 (Usage)

### 1. 配置邮箱（在扩展的「设置」页）

点击扩展图标 → `设置`（Settings）。顶部确认 `Agent` 状态为 **正常 / OK**（默认地址 `http://127.0.0.1:17373`）。

- **QQ 邮箱（IMAP）**：登录 [QQ 邮箱网页版](https://mail.qq.com) → 设置 → 账号 → 开启「IMAP/SMTP 服务」→ 按提示短信验证 → 得到 **授权码**（不是登录密码）。把 QQ 邮箱和授权码填入设置页 → `保存 QQ`。
- **Outlook（OAuth，推荐）**：在 [Azure 门户 · 应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) 新建注册（账户类型选「Personal Microsoft accounts only」，无需 Redirect URI，并在 Authentication 页把「Allow public client flows」设为 Yes）→ 复制 Application (client) ID 填入 → `保存 Client ID` → `开始登录`，按设备码提示在浏览器完成授权 → `轮询` 确认连接。
- **Outlook（IMAP）**：在设置页把模式切到 IMAP，填邮箱 + 应用专用密码 → `保存 Outlook IMAP`。

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
2. Generate a master key (encrypts email credentials at rest) and an API key.
3. Put them in a local `.env` on the server (do not commit — see `.env.example`):

```bash
cp .env.example .env
# then edit .env, or generate values directly:
cat > .env <<EOF
OTP_AGENT_MASTER_KEY=$(openssl rand -base64 32)
OTP_AGENT_API_KEY=$(openssl rand -base64 24)
CF_TUNNEL_TOKEN=your_tunnel_token
EOF
```

> ⚠️ **Keep `OTP_AGENT_MASTER_KEY` safe and stable.** It is what decrypts your
> stored email credentials. If you lose it, you must re-enter every mailbox
> credential. If you change it, previously stored secrets can no longer be
> decrypted. It is never written to disk.

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

How email credentials (QQ auth code / Outlook app password) are stored at rest:

- **macOS (local dev)**: macOS Keychain (service name: `email-otp-autofill`).
- **Linux / Docker**: encrypted in `./data/secrets.json` using **AES-256-GCM**,
  with the key derived (scrypt) from `OTP_AGENT_MASTER_KEY`. The master key is
  only read from the environment and is never written to disk — a leaked
  `secrets.json` is useless without it.
- **Linux / Docker without a master key**: falls back to **plaintext** in
  `secrets.json` and prints a startup warning. Only acceptable for throwaway
  local testing — **always set `OTP_AGENT_MASTER_KEY` for networked/server use.**

Existing plaintext `secrets.json` files are automatically re-encrypted on the
next startup once a master key is set.

