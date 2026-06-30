# 邮箱验证码自动填充

[English](README.md) | **中文**

从 QQ 邮箱 / Outlook 抓取邮箱一次性验证码（OTP），用快捷键自动填充到当前页面——
通过一个本地 / 自部署的 **agent** 加一个 Chrome（MV3）**扩展** 实现。

> wip: Google、self-hosted……

## 工作原理

Chrome 扩展轮询一个 **agent** 服务。agent 通过 IMAP / OAuth 连接你的邮箱，提取最新
验证码；当你按下快捷键时，扩展把它填进当前聚焦的输入框。

| 验证码弹窗（Popup） | 设置（Settings） |
| --- | --- |
| ![扩展弹窗显示抓取到的验证码](docs/screenshots/popup.png) | ![扩展设置页：agent 状态与邮箱账号](docs/screenshots/settings.png) |

两种连接方式：

- **公共实例（零配置）**——扩展默认指向 `https://otp.razet.me`。注册账号即可使用，
  无需自建服务器。
- **自部署**——用 Docker 跑你自己的多租户 agent（一条 Docker Compose 命令）。

## 组成部分

- `agent/`：Node/TypeScript HTTP 服务（默认 `127.0.0.1:17373`），负责连接邮箱、提取
  验证码、加密存储凭据，并用 SQLite 持久化状态。
- `chrome-extension/`：Chrome MV3 扩展（快捷键填充、弹窗、设置 / 引导 UI、账号登录、
  中 / EN 双语）。

## 功能特性

- **邮箱**：QQ 邮箱（IMAP 授权码）与 Outlook（OAuth 设备码流程），多账号并行运行。
- **验证码提取**：关键词 + 打分匹配 4–8 位验证码（中 / 英文关键词），自动识别有效期
  窗口（10 秒–24 小时）。
- **快捷键填充**：`⌘/Ctrl + Shift + .` 定位验证码输入框并填充；工具栏红色角标提示有
  新验证码（约每 30 秒检查一次）。
- **凭据加密**：AES-256-GCM（密钥由主密钥经 scrypt 派生）；主密钥仅存在于环境变量
  中，永不落盘。
- **多租户**：用户注册并登录；每个账号的邮箱、验证码和密钥彼此隔离（30 天会话，
  SQLite 持久化）。
- **管理后台**：`/admin`（token 鉴权）——用户 / 邮箱统计、邀请码管理、可选「需邀请码
  注册」、启用 / 停用用户。
- **双语 UI**：中 / English，运行时可切换。

## 当前状态

已超出 MVP：QQ IMAP 与 Outlook OAuth（Graph 设备码）均可用；多租户 + SQLite 持久化 +
凭据静态加密；一条命令 Docker 部署。

## 加载扩展

Chrome → `chrome://extensions` → 开启开发者模式 → **加载已解压的扩展程序** → 选择
`chrome-extension/` 文件夹。

## 使用方法

### 0. 登录

设置页顶部「账号」区**注册或登录**；成功后扩展会带上你的会话凭据访问 agent。
（若实例开启了「邀请码注册」，注册时需填管理员发放的邀请码。）

### 1. 配置邮箱（在扩展的「设置」页）

点击扩展图标 → `设置`（Settings）。顶部确认 `Agent` 状态为 **正常 / OK**。

> 如上方 **Settings 截图**：左侧「邮箱账号」列出已连接的账号（绿点 = 在线），右侧
> 「Agent」区显示连接地址与状态，并可设置「验证码有效期（秒）」。点「添加账号」配置
> 新邮箱。

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

> 如上方 **Popup 截图**：弹窗顶部显示来源邮箱（如 `Outlook`）与验证码；下方一行给出
> 「到达时间 · 发件地址 · 剩余有效时间」。若同一时段有多个有效验证码，用左右
> `‹ ›` 翻页（`1 / 2`），进度条表示当前码的剩余有效期。底部 `Agent: 正常` 表示
> 与 agent 连接正常。

填充后角标自动清除；验证码默认只在到达后 **120 秒**内有效（可在设置页「验证码有效期」调整为 10–600 秒）。

### 3. 界面语言

popup 和设置页右上角有**中 / English 切换**，首次跟随浏览器语言，之后记住你的选择。

## 自部署 agent（Docker）

```bash
git clone https://github.com/priority3/email-otp-autofill.git
cd email-otp-autofill
cp .env.example .env
```

在 `.env` 里设置两个密钥（用户各自用自己的账号注册 / 登录，数据彼此隔离——没有需要
分发的共享 API key）：

```bash
OTP_AGENT_MASTER_KEY=$(openssl rand -base64 32)   # 静态加密密钥（必填）
OTP_ADMIN_TOKEN=$(openssl rand -base64 24)        # /admin 管理后台用
```

启动：

```bash
docker compose up -d --build
```

- **用户**：从扩展「设置」页注册 / 登录，然后把 **Agent Base URL** 指向你的地址。
- **管理员（你）**：打开 `https://your.domain.tld/admin`，用管理 token 登录，管理邀请
  码、用户并查看统计。需要封闭注册就在那里打开「需邀请码」。

### 对外暴露

agent 在服务器上绑定 `127.0.0.1:17373`。如何把它暴露到公网是**你服务器自己的事，与本
项目无关**——把你现有的反向代理或隧道指向 `127.0.0.1:17373` 即可。常见做法：

- **Cloudflare Tunnel**——单独跑一个 `cloudflared` 连接器（与本项目分离），用 ingress
  规则把 `your.domain.tld → http://127.0.0.1:17373`。
- **反向代理**（nginx / Caddy）在 `127.0.0.1:17373` 前面做 TLS 终止。
- **SSH 端口转发**（快速测试用）：

  ```bash
  ssh -N -L 17373:127.0.0.1:17373 root@YOUR_SERVER_IP
  ```

然后把扩展的 **Agent Base URL** 设为你的公网地址。

> ⚠️ **请妥善且稳定地保管 `OTP_AGENT_MASTER_KEY`。** 它用于解密你存储的邮箱凭据。丢
> 失则每个邮箱都得重新录入；更改则之前存储的密钥再也无法解密。它永不落盘。

## 密钥存储

邮箱凭据（QQ 授权码 / Outlook OAuth token）以 **AES-256-GCM** 加密后存于 `data/` 卷下
的 SQLite 数据库中，密钥由 `OTP_AGENT_MASTER_KEY` 经 scrypt 派生。主密钥仅从环境变量
读取、永不落盘——数据库被泄露但没有主密钥也无用。

未设置主密钥时，agent 会回退到**明文**存储并在启动时打印警告（仅适合一次性的本地测
试）。一旦设置了密钥，已有的明文密钥会在下次启动时自动重新加密。

## 管理 API（多租户）

由 `OTP_ADMIN_TOKEN` 做 token 鉴权（以 Bearer token 发送）。要点：

- `GET /v1/admin/stats`——用户数、近期活动、邀请码使用情况。
- `GET/POST /v1/admin/invites`、`POST /v1/admin/invites/revoke`——管理邀请码。
- `POST /v1/admin/settings`——切换「需邀请码注册」。
- `GET /v1/admin/users`、`POST /v1/admin/users/disable`——列出 / 启用 / 停用用户。

对应的浏览器后台在 `/admin`。
