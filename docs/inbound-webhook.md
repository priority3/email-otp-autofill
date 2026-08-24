# Inbound webhook（Webhook 收件）

让邮件源**主动把邮件推给 agent**，而不是 agent 去轮询邮箱。适用于你自己能改的邮件源：
Cloudflare Email Worker、自建邮局（Mailcow / Poste.io / Maddy 的 pipe 或 sieve）、
或任何能发 HTTP 请求的转发器。

相比 IMAP / OAuth 轮询：**零轮询延迟、零字段映射、一个域名下的所有地址通吃**。

---

## 1. 拿到 webhook 地址

扩展 → 设置 → 左侧「Webhook 收件」→ 点 **轮换 token** → 复制 Webhook 地址。

地址形如：

```
https://your-agent.example.com/v1/inbox/hook/<INGEST_TOKEN>
```

两种传 token 的方式，任选其一：

| 方式 | 请求 | 什么时候用 |
|---|---|---|
| **请求头（推荐）** | `POST /v1/inbox/hook` + `x-otp-ingest-token: <TOKEN>` | 只要邮件源能自定义请求头就用这个 |
| 路径 | `POST /v1/inbox/hook/<TOKEN>` | 邮件源只允许填一个 URL 时的兜底 |

> ⚠️ 路径方式会把 token 写进 Cloudflare / nginx / CDN 的**访问日志**。能用请求头就用请求头。

> ⚠️ ingest token 在数据库里是**明文**存储的（与会话 token 一致）。数据库泄露时，
> 除了轮换密码，也要来这里轮换 ingest token。

---

## 2. Cloudflare Email Worker

### 2.1 部署 Worker

新建一个 Worker，代码就这么多：

```js
export default {
  async email(message, env) {
    await fetch(env.AGENT_HOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-otp-ingest-token": env.OTP_INGEST_TOKEN,
      },
      body: message.raw,
    });
  },
};
```

把两个值配成 Worker 的环境变量 / Secret：

| 变量 | 值 |
|---|---|
| `AGENT_HOOK_URL` | `https://your-agent.example.com/v1/inbox/hook` |
| `OTP_INGEST_TOKEN` | 设置页复制到的 token（建议存成 Secret） |

agent 会用 `mailparser` 解析原始邮件，收件人、主题、正文、`Date`、`Message-ID` 全部自动
取出 —— **Worker 侧不需要做任何字段映射**。

### 2.2 打开 Email Routing catch-all

Cloudflare Dashboard → 你的域名 → **Email** → **Email Routing**：

1. 按引导完成域名的 MX 记录配置。
2. **Routing rules** → **Catch-all address** → 启用，Action 选 **Send to a Worker**，
   选上面部署的 Worker。

这样 `*@yourdomain.com` 的任何地址都会触发 Worker → 推给 agent。

### 2.3 收窄允许范围（重要）

catch-all 意味着**任何人**都能往 `随便什么@yourdomain.com` 发信。两个后果：

- 垃圾邮件里的数字可能被误判成验证码，污染 popup；
- 知道你域名的人可以投递**伪造的验证码**，诱导你填错的码。

所以在设置页填上：

- **允许的收件域名**：`yourdomain.com`（多个用英文逗号分隔）
- **允许的地址前缀**：比如 `otp-`，之后只用 `otp-github@yourdomain.com`
  这类地址注册，其他地址一律丢弃

两项都留空 = 全收。至少填一项。

---

## 3. 自建邮局（pipe / sieve）

任何能执行命令的投递钩子都可以：

```bash
curl -sS -X POST "https://your-agent.example.com/v1/inbox/hook" \
  -H 'content-type: message/rfc822' \
  -H "x-otp-ingest-token: $OTP_INGEST_TOKEN" \
  --data-binary @-
```

把整封邮件从 stdin 喂进去即可（`--data-binary @-`）。

---

## 4. 请求格式

### 4.1 原始邮件（推荐）

`content-type: message/rfc822`，body 是完整邮件。收件人依次从
`To:` → `Delivered-To:` → `X-Original-To:` → `X-Forwarded-To:` → `Envelope-To:` 中取
—— catch-all 转发器常常改写 `To:`，把真实地址留在这些头里。

### 4.2 JSON

`content-type: application/json`：

```json
{
  "to": "otp-github@yourdomain.com",
  "from": "noreply@github.com",
  "subject": "Your verification code",
  "text": "Your code is 481920, valid for 5 minutes.",
  "html": "<p>...</p>",
  "receivedAt": 1756000000000,
  "messageId": "<abc@github.com>"
}
```

全部字段可选，但**没有 `to` 就无法通过白名单判定，会被丢弃**。
`to` 支持字符串、`Name <a@b.com>` 形式、逗号分隔串、以及字符串数组。
`receivedAt` 支持 epoch 毫秒或可解析的日期串。

body 上限 **1 MB**。

---

## 5. 响应语义

只有两类状态码需要邮件源关心：

| 状态 | 含义 | 该怎么办 |
|---|---|---|
| `401` | token 缺失 / 错误 / 用户已被停用 | 配置错了，去设置页重新复制 |
| `429` | 触发限流（单 token 60 次/分，单 IP 120 次/分） | 降低推送频率 |

其他情况一律返回 **200**，附带 `skipped` 原因 —— 这是刻意的：邮件源不该因为「这封信没有
验证码」而重试。

| `skipped` | 含义 |
|---|---|
| `channel_disabled` | 通道未启用（去设置页点「轮换 token」） |
| `parse_failed` | body 既不是合法 JSON 也不是可解析的邮件 |
| `no_recipient` | 取不到收件地址 |
| `recipient_not_allowed` | 收件地址不在白名单里 |
| `too_old` | 邮件 `Date` 早于 10 分钟前 |
| `no_otp` | 正文里没识别出验证码 |

最近一次推送时间、已接收 / 已丢弃计数、最近一次丢弃原因，都显示在设置页的
「Webhook 收件」卡片上。**agent 不保存邮件内容**，只保存计数 —— catch-all 会收到陌生人
的邮件，缓存正文是隐私负担。

---

## 6. 自测

```bash
curl -sS -X POST "https://your-agent.example.com/v1/inbox/hook" \
  -H 'content-type: application/json' \
  -H "x-otp-ingest-token: $OTP_INGEST_TOKEN" \
  -d '{"to":"otp-test@yourdomain.com","from":"noreply@x.com","subject":"Your code","text":"Your verification code is 481920, valid for 5 minutes."}'
```

期望 `{"ok":true}`，然后打开扩展 popup 应该能看到 `481920`，来源标签是 **Webhook**，
元信息行里有 `→ otp-test@yourdomain.com`。

原始邮件形式的自测：

```bash
printf 'From: noreply@x.com\r\nTo: otp-test@yourdomain.com\r\nSubject: Your code\r\nDate: %s\r\nMessage-ID: <t1@x>\r\n\r\nYour verification code is 481920, valid for 5 minutes.\r\n' "$(date -R)" | curl -sS -X POST "https://your-agent.example.com/v1/inbox/hook" -H 'content-type: message/rfc822' -H "x-otp-ingest-token: $OTP_INGEST_TOKEN" --data-binary @-
```

---

## 7. 安全边界

- webhook 是**公网未鉴权入口**，防护是：256 位随机 token + 双维度限流 + 1 MB body 上限
  + 未知 token 立即 401。
- 邮件 `Date` 头是发信方可控的。agent 会把未来时间**压到服务端当前时间**，否则一个伪造
  成明年的邮件会产生永不过期的验证码。
- catch-all 域名应当视为**半公开信息**。敏感站点不要用能猜到的 local part。
- 日志中不会出现 ingest token、邮件正文或验证码。
