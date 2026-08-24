# Chrome Web Store — Privacy practices answers

Copy-paste source for the **Privacy practices** tab of the Developer Dashboard.
Written in English on purpose: these fields are read by Google's review team, not
by end users.

Every claim below is traceable to code in `chrome-extension/`. If the extension's
behaviour changes, update this file in the same commit — a justification that
contradicts the source is the most common cause of rejection.

---

## 1. Single purpose description

> Email OTP Autofill has one purpose: to retrieve the one-time verification code
> (OTP) that has just arrived in the user's own email inbox, and fill it into the
> verification-code field of the page the user is currently signing in to.
>
> The user connects their own mailbox (QQ Mail, Outlook, or Gmail) to a backend
> "agent", which is either the hosted instance at otp.razet.me or an instance the
> user self-hosts from our open-source repository. The agent looks only at
> messages that carry a login/verification code and exposes just that code to the
> extension. The extension shows the code in its popup and, when the user clicks
> "Fill" or presses the keyboard shortcut, types it into the OTP input of the
> active tab.
>
> The extension does nothing else. It serves no ads, collects no analytics, and
> makes no change to any page other than writing the verification code into the
> OTP field the user asked it to fill.

## 2. Remote code

**Set the radio button to "No, I am not using remote code."** The justification
box then disappears. If a reviewer asks, the supporting statement is:

> This extension does not use remote code. Every script it executes is contained
> in the uploaded package: `background.js`, `content.js`, `popup.js`,
> `options.js`, `i18n.js`. There is no `eval()`, no `new Function()`, no
> remotely-hosted `<script src>`, and no WebAssembly. `importScripts("i18n.js")`
> in the service worker loads a packaged file, not a remote one.
>
> The extension does make network requests, but they return data, never code: the
> agent's `/v1/*` endpoints reply with JSON containing the verification code,
> mailbox status, and configuration. That JSON is parsed with `JSON.parse` via
> `response.json()` and rendered as text. It is never executed.

## 3. Host permissions

> The extension has to reach the "agent" — the component that connects to the
> user's mailbox and extracts the verification code.
>
> `https://otp.razet.me/*` — the default hosted agent. All calls for OTP
> retrieval, mailbox configuration, and login go to its `/v1/*` endpoints.
>
> `http://127.0.0.1:17373/*` — the identical agent when the user runs it on their
> own machine. The project is open source and ships a Docker Compose file so that
> privacy-conscious users can keep their mail credentials entirely local; 17373 is
> the agent's default port.
>
> `https://*/*` and `http://*/*` are declared under `optional_host_permissions`
> only, and are never granted at install time. They are requested at runtime, one
> concrete origin at a time, through `chrome.permissions.request()` when a user
> types the address of their own self-hosted agent into Settings (see
> `saveConnection()` in `options.js`). Since a self-hosted agent may live on any
> domain, the optional pattern cannot be narrowed ahead of time.
>
> The content script is registered for `<all_urls>` because the verification-code
> field can appear on any website — that page is precisely where the code must be
> filled. The content script reads no page content, no form values, and no
> credentials, and it sends nothing to any server. It acts only when the user
> triggers a fill, at which point it locates the OTP input and writes the code
> into it, then shows a small toast with the result.
>
> One additional routine runs at page load: during Outlook/Gmail sign-in the
> extension stores a short-lived device code and auto-fills it on Microsoft's
> device-login page so the user does not have to retype it. It is a no-op on every
> other page, and the stored code is removed after use or on expiry.

## 4. `activeTab`

> `activeTab` is used only when the user explicitly invokes the extension: by
> clicking the toolbar icon and pressing "Fill", or by pressing the configured
> shortcut (Command+Shift+. on macOS, Ctrl+Shift+. elsewhere).
>
> At that moment, and only then, the extension acts on the current tab. It reads
> the tab's hostname so the agent can select the code belonging to the site being
> signed in to, and it passes the code to that tab's content script to be written
> into the OTP field. Tabs on which the user has not invoked the extension are
> never touched.

## 5. `tabs`

> `tabs` is used in exactly two places, both in `background.js`.
>
> First, `chrome.tabs.query({ active: true, currentWindow: true })` identifies the
> tab the user wants filled. The `tabs` permission is what makes `tab.url`
> readable; from it the extension takes **only the hostname**, which it passes to
> the agent as a `domain` hint so the right code is chosen when several are valid
> at the same time.
>
> Second, `chrome.tabs.sendMessage()` delivers the code to that tab's content
> script and displays result toasts.
>
> The extension never enumerates other tabs, never reads browsing history, and
> never transmits full URLs, query strings, or page titles.

## 6. `alarms`

> `chrome.alarms` drives a single recurring alarm named `otp-poll`, created in
> `ensurePollAlarm()` with a 30-second period. Each tick asks the agent whether a
> new verification code has arrived and, if so, puts an unread-count badge on the
> toolbar icon so the user notices the code before it expires.
>
> This check has to happen in the background because verification codes are valid
> for roughly one to two minutes. A Manifest V3 service worker is terminated when
> idle, so `setInterval`/`setTimeout` cannot survive to do this; `chrome.alarms` is
> the only mechanism Chrome supports for the purpose.

## 7. `storage`

> `chrome.storage.local` holds the extension's own settings and session state on
> the user's device:
>
> - `agentBaseUrl` — the address of the agent the user has chosen
> - `maxAgeSec` — how old a code may be and still be offered (10–600 s)
> - `authToken` — the session token the agent returns at login
> - `lastSeenOtpTs` — timestamp used to clear the unread badge
> - `uiLang` — the user's interface-language choice
> - `msDeviceCode` / `msDeviceCodeExp` — a short-lived device code during the
>   Outlook sign-in flow, deleted after use or on expiry
> - the id of the code currently selected in the popup
>
> Nothing is written to `chrome.storage.sync`. None of it leaves the device except
> `authToken`, which is sent back to the user's own agent as an `Authorization`
> header. No email content and no verification code is persisted.

---

## Data-usage disclosures (same tab, further down)

The form asks what you collect **now or in the future**, so planned features count.
Verified against both `chrome-extension/` and `agent/src/`.

| Category | Check? | Basis |
|---|:--:|---|
| 个人身份信息 Personally identifiable information | **YES** | Username and the user's own mailbox address are sent to and stored by the agent (`users` table; `secrets` under `*_oauth:email`). |
| 健康信息 Health information | no | Nothing health-related is touched. |
| 财务和付款信息 Financial and payment information | **no — see below** | Not collected today. Depends on how paid features are built. |
| 身份验证信息 Authentication information | **YES** | Account password (stored only as a salted scrypt hash), QQ Mail authorization code, Microsoft/Google OAuth refresh tokens — all held by the agent, encrypted with AES-256-GCM. |
| 个人通讯 Personal communications | **YES** | The agent reads the user's mailbox over IMAP / Gmail API / Microsoft Graph. Only the verification code is extracted, and sender, subject, message id and folder are held in memory to match the code to a site — but the granted scopes (`gmail.readonly`, `Mail.Read`) are mailbox-wide. Not ticking this box would misrepresent the extension's core function. |
| 位置 Location | no | No geolocation. The agent has no HTTP request logging (verified: no pino/morgan/logger in `server.ts` or `http/*.ts`). Upstream proxy/CDN connection logs are infrastructure, not extension collection. |
| 网络记录 Web history | no | No list of visited pages is ever built, sent, or stored. |
| 用户活动 User activity | no | No clicks, keystrokes, scrolling or network monitoring. |
| 网站内容 Website content | **YES** | The hostname of the active tab is sent to the agent as the `domain` query param. It is used in memory for ranking (`OtpStore.validList`) and never persisted or logged — but it does leave the device, so it must be disclosed. |

Then certify all three statements: no sale/transfer to third parties, no use for
unrelated purposes, no use to determine creditworthiness. All three are true for
the current code.

### On 财务和付款信息

Leave it unchecked **only if** payment is handled entirely by a third-party
processor on its own pages, with the extension and agent never receiving card or
bank data — storing just a plan tier, a subscription status, and the processor's
opaque customer id. Under that design the extension itself collects no financial
data, and section 10 of the privacy policy already describes it, so no policy
rewrite is needed when the feature ships.

Tick it now **if** the extension or agent will ever accept payment details
directly, or if you want to avoid a second review cycle later. Over-disclosure is
never itself a rejection reason; under-disclosure is.

Either way, revisit this form before any paid feature goes live.

## Privacy policy URL

Source: `docs/privacy.html` in this repo (bilingual EN/中文), published via GitHub
Pages at:

    https://priority3.github.io/email-otp-autofill/privacy.html

Contact channel is the public issue tracker; the policy commits to answering
data-deletion requests within 30 days. If that channel ever changes, update
section 11 of `privacy.html` — a policy without a working contact is a rejection
reason.

Pages is configured to serve branch `main`, folder `/docs`. Any edit to
`privacy.html` on `main` republishes automatically within a minute or two.
