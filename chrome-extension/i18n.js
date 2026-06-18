// Lightweight runtime i18n for the extension UI.
//
// Why custom (not chrome.i18n / _locales): the native API follows the browser
// UI language and cannot be switched at runtime from inside the extension.
// We need a user-facing toggle, so we keep a small dictionary here and persist
// the chosen language in chrome.storage.local.
//
// Loaded in three ways (see plan): extension pages via <script>, the service
// worker via importScripts. content.js does NOT load this — it only renders
// strings handed to it by background.js. All members are attached to globalThis
// so both `window` (pages) and `self` (worker) can reach them.

(function (g) {
  const STORAGE_KEY = "uiLang";

  // Rich-text entries (contain HTML such as <a>/<span>). These must be applied
  // via innerHTML, never textContent — so they are NOT marked with data-i18n in
  // HTML; the page scripts set them explicitly. Content is repo-owned, no
  // injection risk.
  const MESSAGES = {
    en: {
      // --- generic / agent ---
      app_title: "Email OTP Autofill",
      settings_title: "Settings",
      agent: "Agent",
      agent_status_checking: "Checking…",
      // popup short status
      agent_ok: "Agent: OK",
      agent_down: "Agent: DOWN",
      // options status: "OK · 127.0.0.1:17373"
      agent_ok_detail: "OK · {detail}",
      agent_down_detail: "DOWN · {detail}",
      need_api_key: "Need Agent API Key",
      refresh: "Refresh",
      base_url: "Agent Base URL",
      base_url_hint:
        'Run the agent locally: <span class="code">cd /path/to/email-otp-autofill/agent &amp;&amp; npm run dev</span>',
      base_url_hint2: "Default is the public instance. Self-hosters can point this at their own domain.",
      advanced: "Advanced (self-hosting)",
      api_key: "Agent API Key",
      api_key_ph: "(optional for localhost, required for public domain)",
      api_key_hint:
        "If the agent is exposed via a domain (Cloudflare Tunnel), set `OTP_AGENT_API_KEY` on the server and paste the same value here.",
      show_password: "Show password",
      hide_password: "Hide password",
      max_age: "Max OTP Age (seconds)",
      save_ext: "Save Extension Settings",
      language: "Language",

      // --- multi-account settings page ---
      accounts: "Accounts",
      agent_settings: "Agent Settings",
      add_account: "Add account",
      add_account_title: "Add a new account",
      account_type: "Account type",
      type_qq: "QQ Mail (IMAP)",
      type_outlook_imap: "Outlook (IMAP)",
      remove_account: "Remove",
      removing: "Removing…",
      no_account_selected: "No account selected",
      select_or_add: "Select an account on the left, or add a new one.",
      save_account: "Save account",
      account_email: "Email",
      empty_accounts: "No accounts yet.",

      // --- multi-tenant auth ---
      login: "Log in",
      register: "Register",
      logout: "Log out",
      username: "Username",
      password: "Password",
      logged_in_as: "Logged in as {name}",
      login_required: "This is a shared instance. Log in or create an account.",
      need_login: "Please log in",
      auth_failed: "Login failed: {err}",
      switch_to_register: "Need an account? Register",
      switch_to_login: "Have an account? Log in",
      server_settings: "Server",
      save_connection: "Save & connect",
      connected_ok: "Connected.",
      conn_locked_hint: "To change the server address, log out first.",
      invite_code: "Invite code",
      invalid_invite: "Invalid or used invite code.",
      err_username_required: "Please enter a username.",
      err_password_required: "Please enter a password.",
      err_username_short: "Username must be at least 3 characters.",
      err_password_short: "Password must be at least 8 characters.",
      err_invite_required: "Please enter an invite code.",

      // --- shared verbs / states ---
      saving: "Saving…",
      saved: "Saved.",
      failed: "Failed.",
      failed_with: "Failed: {err}",
      save_failed_with: "Failed to save: {err}",
      perm_not_granted: "Saved. Permission not granted for {origin} (agent will be unreachable).",
      clear: "Clear",
      clearing: "Clearing…",
      cleared: "Cleared.",
      configured: "Configured",
      not_configured: "Not configured",

      // --- popup ---
      waiting: "Waiting…",
      loading: "Loading…",
      no_otp_yet: "No OTP yet.",
      n_sec_ago: "{n}s ago",
      copied: "Copied.",
      agent_unreachable: "Agent not reachable.",
      need_login_hint: "Please log in — open Settings.",
      fill: "Fill",
      copy: "Copy",
      settings: "Settings",
      source: "Source",
      expires_in_sec: "valid for {n}s",
      otp_expired: "Expired",
      fill_failed_manual: "Autofill failed — please copy and paste manually.",

      // --- QQ ---
      qq_title: "QQ Mail (IMAP)",
      qq_desc: "Uses your QQ IMAP authorization code. Stored in macOS Keychain by the agent.",
      qq_email: "QQ Email",
      qq_authcode: "QQ IMAP Authorization Code",
      qq_authcode_ph: "Authorization code (not your QQ login password)",
      qq_no_echo: "The saved code is pre-filled as dots — click the eye to reveal it.",
      qq_howto:
        'How to get it: sign in to <a href="https://mail.qq.com" target="_blank" rel="noopener">QQ Mail (web)</a> → Settings → Account → find "POP3/IMAP/SMTP Service" → enable "IMAP/SMTP Service" → verify by SMS as prompted → the generated authorization code goes here.',
      save_qq: "Save QQ",

      // --- Outlook ---
      outlook_title: "Outlook",
      outlook_desc: "Choose OAuth (Graph) or IMAP mode.",
      mode: "Mode",
      mode_oauth: "OAuth (Graph) (Recommended)",
      mode_imap: "IMAP (App Password)",
      client_id: "Microsoft App Client ID",
      client_id_ph: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      client_id_hint:
        "You need a free App Registration that supports personal Microsoft accounts. The agent uses Device Code flow, so no redirect URL needed.",
      client_id_howto:
        'How to get it: open <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Azure Portal · App registrations</a> → New registration → set Supported account types to "Personal Microsoft accounts only" → no Redirect URI needed → after registering, copy the "Application (client) ID" here. Also set "Allow public client flows" to Yes on the app\'s Authentication page (required for the device code flow).',
      save_client_id: "Save Client ID",
      start_signin: "Start Sign-in",
      poll: "Poll",
      polling: "Polling…",
      starting: "Starting…",
      oauth_connected: "OAuth connected",
      oauth_not_connected: "OAuth not connected",
      connected: "Connected.",
      expired: "Expired. Start again.",
      pending: "Pending ({err})",
      device_code_msg: "Open {uri} and enter code {code} (expires in {sec}s).",
      outlook_email: "Outlook Email",
      app_password: "App Password",
      app_password_ph: "App password (recommended), or normal password if IMAP allows",
      imap_no_echo: "The saved password is pre-filled as dots — click the eye to reveal it.",
      save_outlook_imap: "Save Outlook IMAP",
      imap_configured: "IMAP configured",
      imap_not_configured: "IMAP not configured",

      // --- toast (background → content) ---
      toast_no_otp: "No recent OTP found.",
      toast_fill_failed: "Failed to fill OTP.",
      err_no_otp_field: "No OTP field found on this page.",
      err_invalid_code: "Invalid OTP code.",
    },

    zh: {
      // --- generic / agent ---
      app_title: "邮箱验证码自动填充",
      settings_title: "设置",
      agent: "Agent",
      agent_status_checking: "检查中…",
      agent_ok: "Agent: 正常",
      agent_down: "Agent: 离线",
      agent_ok_detail: "正常 · {detail}",
      agent_down_detail: "离线 · {detail}",
      need_api_key: "需要 Agent API Key",
      refresh: "刷新",
      base_url: "Agent 地址",
      base_url_hint:
        '在本地运行 agent：<span class="code">cd /path/to/email-otp-autofill/agent &amp;&amp; npm run dev</span>',
      base_url_hint2: "默认连接公共实例。自部署可改成你自己的域名。",
      advanced: "高级（自部署）",
      api_key: "Agent API Key",
      api_key_ph: "（本机可留空，公网域名必填）",
      api_key_hint:
        "如果 agent 通过域名暴露（Cloudflare Tunnel），在服务器设置 `OTP_AGENT_API_KEY`，并把相同的值粘贴到这里。",
      show_password: "显示密码",
      hide_password: "隐藏密码",
      max_age: "验证码有效期（秒）",
      save_ext: "保存扩展设置",
      language: "语言",

      // --- multi-account settings page ---
      accounts: "邮箱账号",
      agent_settings: "Agent 设置",
      add_account: "添加账号",
      add_account_title: "添加新账号",
      account_type: "账号类型",
      type_qq: "QQ 邮箱（IMAP）",
      type_outlook_imap: "Outlook（IMAP）",
      remove_account: "删除",
      removing: "删除中…",
      no_account_selected: "未选择账号",
      select_or_add: "在左侧选择一个账号，或添加新账号。",
      save_account: "保存账号",
      account_email: "邮箱",
      empty_accounts: "暂无账号。",

      // --- multi-tenant auth ---
      login: "登录",
      register: "注册",
      logout: "退出登录",
      username: "用户名",
      password: "密码",
      logged_in_as: "已登录：{name}",
      login_required: "这是一个公共实例，请登录或注册账号。",
      need_login: "请先登录",
      auth_failed: "登录失败：{err}",
      switch_to_register: "没有账号？去注册",
      switch_to_login: "已有账号？去登录",
      server_settings: "服务器",
      save_connection: "保存并连接",
      connected_ok: "已连接。",
      conn_locked_hint: "要更换服务器地址，请先退出登录。",
      invite_code: "邀请码",
      invalid_invite: "邀请码无效或已被使用。",
      err_username_required: "请输入用户名。",
      err_password_required: "请输入密码。",
      err_username_short: "用户名至少 3 个字符。",
      err_password_short: "密码至少 8 个字符。",
      err_invite_required: "请输入邀请码。",

      // --- shared verbs / states ---
      saving: "保存中…",
      saved: "已保存。",
      failed: "失败。",
      failed_with: "失败：{err}",
      save_failed_with: "保存失败：{err}",
      perm_not_granted: "已保存。未授予 {origin} 的访问权限（agent 将无法连接）。",
      clear: "清除",
      clearing: "清除中…",
      cleared: "已清除。",
      configured: "已配置",
      not_configured: "未配置",

      // --- popup ---
      waiting: "等待中…",
      loading: "加载中…",
      no_otp_yet: "暂无验证码。",
      n_sec_ago: "{n} 秒前",
      copied: "已复制。",
      agent_unreachable: "无法连接 Agent。",
      need_login_hint: "请先登录 —— 点「设置」。",
      fill: "填充",
      copy: "复制",
      settings: "设置",
      source: "来源",
      expires_in_sec: "{n} 秒后过期",
      otp_expired: "已过期",
      fill_failed_manual: "填充失败，请手动复制粘贴。",

      // --- QQ ---
      qq_title: "QQ 邮箱（IMAP）",
      qq_desc: "使用 QQ 的 IMAP 授权码。由 agent 存入 macOS Keychain。",
      qq_email: "QQ 邮箱",
      qq_authcode: "QQ IMAP 授权码",
      qq_authcode_ph: "授权码（不是 QQ 登录密码）",
      qq_no_echo: "已保存的授权码会以圆点回填，点右侧小眼睛可查看。",
      qq_howto:
        '获取途径：登录 <a href="https://mail.qq.com" target="_blank" rel="noopener">QQ 邮箱网页版</a> → 设置 → 账号 → 找到「POP3/IMAP/SMTP 服务」→ 开启「IMAP/SMTP 服务」→ 按提示用手机发送短信验证 → 生成的授权码填入此处。',
      save_qq: "保存 QQ",

      // --- Outlook ---
      outlook_title: "Outlook",
      outlook_desc: "选择 OAuth（Graph）或 IMAP 模式。",
      mode: "模式",
      mode_oauth: "OAuth（Graph）（推荐）",
      mode_imap: "IMAP（应用专用密码）",
      client_id: "Microsoft 应用 Client ID",
      client_id_ph: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      client_id_hint:
        "需要一个支持个人 Microsoft 账户的免费应用注册。agent 使用设备码（Device Code）流程，无需配置回调地址。",
      client_id_howto:
        '获取途径：打开 <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Azure 门户 · 应用注册</a> → New registration → Supported account types 选「Personal Microsoft accounts only」→ 无需填 Redirect URI → 注册后复制「Application (client) ID」填入此处。还需在该应用的 Authentication 页把「Allow public client flows」设为 Yes（设备码流程要求）。',
      save_client_id: "保存 Client ID",
      start_signin: "开始登录",
      poll: "轮询",
      polling: "轮询中…",
      starting: "启动中…",
      oauth_connected: "OAuth 已连接",
      oauth_not_connected: "OAuth 未连接",
      connected: "已连接。",
      expired: "已过期，请重新开始。",
      pending: "等待中（{err}）",
      device_code_msg: "打开 {uri} 并输入代码 {code}（{sec} 秒后过期）。",
      outlook_email: "Outlook 邮箱",
      app_password: "应用专用密码",
      app_password_ph: "应用专用密码（推荐），若 IMAP 允许也可用普通密码",
      imap_no_echo: "已保存的密码会以圆点回填，点右侧小眼睛可查看。",
      save_outlook_imap: "保存 Outlook IMAP",
      imap_configured: "IMAP 已配置",
      imap_not_configured: "IMAP 未配置",

      // --- toast (background → content) ---
      toast_no_otp: "未找到近期的验证码。",
      toast_fill_failed: "填充验证码失败。",
      err_no_otp_field: "当前页面未找到验证码输入框。",
      err_invalid_code: "验证码无效。",
    },
  };

  // Keys whose values contain HTML and must be set via innerHTML on the page.
  const RICH_KEYS = new Set(["base_url_hint", "qq_howto", "client_id_howto"]);

  function normalizeLang(lang) {
    return lang === "zh" || lang === "en" ? lang : null;
  }

  function detectDefaultLang() {
    // Reason: first run follows the browser language; afterwards the stored
    // choice wins (see getUiLang).
    const l = String((g.navigator && g.navigator.language) || "en").toLowerCase();
    return l.startsWith("zh") ? "zh" : "en";
  }

  async function getUiLang() {
    try {
      const raw = await chrome.storage.local.get([STORAGE_KEY]);
      return normalizeLang(raw[STORAGE_KEY]) || detectDefaultLang();
    } catch {
      return detectDefaultLang();
    }
  }

  async function setUiLang(lang) {
    const v = normalizeLang(lang) || detectDefaultLang();
    await chrome.storage.local.set({ [STORAGE_KEY]: v });
  }

  // Translate a key. Falls back en → key. `vars` fills {name} placeholders.
  function t(lang, key, vars) {
    const table = MESSAGES[normalizeLang(lang) || "en"] || MESSAGES.en;
    let s = table[key];
    if (s === undefined) s = MESSAGES.en[key];
    if (s === undefined) return key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        s = s.split("{" + k + "}").join(String(vars[k]));
      }
    }
    return s;
  }

  // Render all static, plain-text nodes within `root`. Rich-text keys are
  // skipped here and handled by the page scripts via innerHTML.
  function applyStaticI18n(root, lang) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (RICH_KEYS.has(key)) return;
      el.textContent = t(lang, key);
    });
    root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", t(lang, el.getAttribute("data-i18n-ph")));
    });
  }

  g.OtpI18n = {
    MESSAGES,
    RICH_KEYS,
    detectDefaultLang,
    getUiLang,
    setUiLang,
    t,
    applyStaticI18n,
  };
})(globalThis);
