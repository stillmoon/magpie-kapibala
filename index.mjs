// Kapibala （卡皮巴拉API, kapibala.asia) provider plugin for magpie.
//
// The site is a New API (QuantumNous/new-api) relay. It has two credential
// kinds, and this plugin needs both:
//   - an API key (sk-...) from /keys: calls the model API at
//     https://api.kapibala.asia (OpenAI-compatible). One key belongs to one
//     group (default / vip, ...). Each key is one magpie account, so a user
//     with two keys signs in twice and the two groups never mix.
//   - a panel access token (nap_...) from /security: calls the panel API at
//     https://kapibala.asia (wallet, subscription, check-in). The token the
//     user already has is named "magpie".
//
// Models are listed as "<group>/<upstream id>" (e.g. vip/gpt-5,
// default/deepseek-chat), so two groups that share a model still show as
// two different models and a request always goes out under the key of the
// group the user picked. The group is NOT typed in by hand: at sign-in the
// plugin looks it up from the panel API (GET /api/token, matched by the
// key) and stores it. When the group cannot be looked up (no panel token
// on this account), the model is listed bare, with no prefix at all, so
// nothing claims a group it does not have. The loader's fetch strips the
// "<group>/" prefix before the request reaches the upstream. The model
// list merges what /v1/models returns with models already known for that
// group, so a subset reply never wipes a model that was added manually.
//
// Usage is a single window (the user's ask): the active subscription's
// remaining balance is the figure, with the wallet balance and the
// subscription's end date in the same entry's text. With no active
// subscription it shows the wallet balance alone.
//
// One window per kapibala account: accounts are grouped by their panel
// access token, and the same token means the same kapibala account, so
// only one of them puts the window on the board. The panel token is
// optional at sign-in: leave it empty when the account is the same
// kapibala account as one already signed in (its usage and check-in then
// come from that account); fill it in only for a different kapibala
// account, which then gets its own window.
//
// Daily check-in: the panel endpoint needs a Cloudflare Turnstile ticket,
// which a plugin cannot produce. The check-in hook first reads the status;
// if today is already claimed it says done, otherwise it tries the claim
// and, when the site demands the human check, answers "captcha" so magpie
// tells the user to check in on the website instead of failing silently.

const PANEL = "https://kapibala.asia"
const API = "https://api.kapibala.asia"
const PROVIDER = "kapibala"
const QUOTA_PER_DOLLAR = 500000

const trim = (v) => String(v ?? "").trim()
const isNum = (v) => typeof v === "number" && Number.isFinite(v)
const toDollars = (quota) => {
  const n = Number(quota)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round((n / QUOTA_PER_DOLLAR) * 100) / 100
}

// usageClaim is which account (by its API key) last put the usage window
// up for a panel token. Accounts sharing one panel token are one kapibala
// account, so only one of them shows the window on the board; the others
// stay quiet. A claim goes stale after CLAIM_TTL_MS, so removing the
// claiming account lets another take over within that time instead of
// hiding the window for good.
const usageClaim = new Map()
const CLAIM_TTL_MS = 60 * 1000

// stripGroup is the upstream model id of a listed "<group>/<id>": the
// first segment off when it is the account's group, else the id as listed.
// With no group the id is bare already, so it passes through untouched.
const stripGroup = (model, group) => {
  const m = trim(model)
  if (!m || !group) return m
  const i = m.indexOf("/")
  if (i <= 0) return m
  const head = m.slice(0, i)
  if (head === group) return m.slice(i + 1)
  return m
}

// listedId is the id a model is listed under: "<group>/<id>" when the
// group is known, the bare upstream id when it is not, so no prefix
// claims a group the key does not have.
const listedId = (model, group) => (group ? `${group}/${model}` : model)

// maskKey is new-api's MaskTokenKey: what the panel API shows for a key
// in its token list (first 4 + "**********" + last 4), so a key the user
// typed can be matched against the list without the full key ever
// coming back from the panel.
const maskKey = (key) => {
  const k = trim(key)
  if (!k) return ""
  if (k.length <= 4) return "*".repeat(k.length)
  if (k.length <= 8) return k.slice(0, 2) + "****" + k.slice(-2)
  return k.slice(0, 4) + "**********" + k.slice(-4)
}

// detectGroup asks the panel API which group an API key belongs to. It
// lists the account's keys (GET /api/token, panel token needed) and
// matches the typed key by its masked form. Returns the group, or ""
// when the token is missing, the lookup fails, or the key is not found.
const detectGroup = async (apiKey, panelToken) => {
  const token = trim(panelToken)
  const key = trim(apiKey)
  if (!token || !key) return ""
  const masked = maskKey(key)
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await panelGet(`/api/token/?p=${page}&page_size=100`, token)
      if (!res.ok) return ""
      const data = res.json?.data ?? {}
      const items = Array.isArray(data.items) ? data.items : []
      for (const t of items) {
        if (trim(t?.key) === masked) return trim(t?.group)
      }
      if (items.length === 0 || items.length >= (data.total ?? items.length)) break
      if ((data.total ?? 0) <= page * 100) break
    }
  } catch { /* lookup failed: no group */ }
  return ""
}

async function callJSON(url, { token, method = "GET", body, timeout = 20_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON: leave null */ }
  return { status: res.status, ok: res.ok, json, text }
}

const panelGet = (path, token) => callJSON(PANEL + path, { token })

// panelAuth is the account's panel token, or "" when the account was
// signed in without one (older sign-ins, or a key-only account).
const panelAuth = (auth) => trim(auth?.metadata?.panelToken)
// groupOf is the group looked up for this account's key at sign-in, or
// "" when it could not be looked up (no panel token on the account).
// "" means "unknown": models are listed bare, with no prefix.
const groupOf = (auth) => trim(auth?.metadata?.group)

const usage = async (getAuth) => {
  const auth = await getAuth()
  const token = panelAuth(auth)
  if (!token) return { windows: [], signIn: "kept" }
  // One window per panel token: if another account with this token already
  // put the window up recently, this one stays quiet so the board does not
  // show the same kapibala account twice. The claim is taken synchronously
  // here, before any await, so two accounts refreshing at once cannot both
  // take it.
  const now = Date.now()
  const claim = usageClaim.get(token)
  if (claim && claim.key !== trim(auth?.key) && now - claim.at < CLAIM_TTL_MS) {
    return { windows: [], signIn: "kept" }
  }
  usageClaim.set(token, { key: trim(auth?.key), at: now })
  let self, subs, plans
  try {
    ;[self, subs, plans] = await Promise.all([
      panelGet("/api/user/self", token),
      panelGet("/api/subscription/self", token),
      panelGet("/api/subscription/plans", token),
    ])
  } catch (e) {
    return { windows: [], signIn: "kept", error: `kapibala usage: ${e?.message ?? e}` }
  }
  if (self.status === 401 || subs.status === 401 || plans.status === 401) {
    return { windows: [], signIn: "expired", error: "kapibala: panel token expired, sign in again" }
  }
  const wallet = toDollars(self.json?.data?.quota)
  const planById = new Map()
  for (const p of plans.json?.data?.plans ?? []) {
    const plan = p?.plan ?? p
    if (plan?.id != null) planById.set(plan.id, plan)
  }
  const active = (subs.json?.data?.subscriptions ?? [])
    .map((s) => s?.subscription ?? s)
    .filter((s) => s && s.status === "active")
  if (active.length) {
    // one window: the subscription ending latest, so a user with several
    // active plans sees the one that lasts longest. It is a quota window
    // (amount of limit), not a balance: a balance is a wallet, which
    // magpie shows as a bare figure with no meter and no total, and its
    // display text never renders for it. amount/limit is what makes the
    // card say "31.32 / 400 $ · 7.8% used" (or the remaining, if magpie
    // is set to show what is left), like other subscription cards.
    active.sort((a, b) => new Date(b.end_time ?? 0) - new Date(a.end_time ?? 0))
    const sub = active[0]
    const plan = planById.get(sub.plan_id)
    const used = toDollars(sub.amount_used ?? 0)
    const total = toDollars(sub.amount_total ?? 0)
    const usedPct = total > 0 ? (used / total) * 100 : 0
    const name = plan?.title ? `${plan.title} 订阅剩余` : "订阅剩余"
    // resetsAt + span are what let magpie show the reset time and the
    // period start (it works the start out as resetsAt less span): the
    // reset is the subscription's next reset, else its end; the span is
    // the reset-to-reset length, else end less start.
    const dateOf = (v) => {
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? null : d
    }
    const resetAt = dateOf(sub.next_reset_time) ?? dateOf(sub.end_time)
    const lastReset = dateOf(sub.last_reset_time)
    const start = dateOf(sub.start_time)
    const end = dateOf(sub.end_time)
    let span = 0
    if (resetAt && lastReset && resetAt > lastReset) span = Math.round((resetAt - lastReset) / 1000)
    else if (end && start && end > start) span = Math.round((end - start) / 1000)
    const window = { name, amount: used, limit: total, used: usedPct, unit: "$" }
    if (resetAt) window.resetsAt = resetAt.toISOString()
    if (span > 0) window.span = span
    const out = { windows: [
      window,
      { name: "钱包余额", balance: wallet, unit: "$" },
    ], signIn: "kept" }
    if (end) out.until = end.toISOString()
    return out
  }
  return { windows: [{ name: "钱包余额", balance: wallet, unit: "$" }], signIn: "kept" }
}

const checkin = async (getAuth) => {
  const auth = await getAuth()
  const token = panelAuth(auth)
  if (!token) return { outcome: "inactive", message: "no panel token on this account: sign in again with the nap_ token" }
  let st
  try {
    st = await panelGet("/api/user/checkin", token)
  } catch (e) {
    return { outcome: "failed", message: `kapibala check-in: ${e?.message ?? e}` }
  }
  if (st.status === 401) return { outcome: "failed", message: "kapibala: panel token expired, sign in again", signIn: "expired" }
  const stats = st.json?.data?.stats ?? {}
  if (stats.checked_in_today) return { outcome: "done" }
  let res
  try {
    res = await callJSON(PANEL + "/api/user/checkin", { token, method: "POST" })
  } catch (e) {
    return { outcome: "failed", message: `kapibala check-in: ${e?.message ?? e}` }
  }
  if (res.ok && res.json?.success !== false) {
    const credit = toDollars(res.json?.data?.quota_awarded)
    return { outcome: "claimed", ...(credit > 0 ? { credit } : {}) }
  }
  const msg = trim(res.json?.message) || trim(res.text)
  if (/already checked in/i.test(msg)) return { outcome: "done" }
  if (/turnstile|captcha|human|verification/i.test(msg) || res.status === 403) {
    return { outcome: "captcha", message: "kapibala 要人机验证，请到 kapibala.asia/profile 点每日签到" }
  }
  if (/not enabled/i.test(msg)) return { outcome: "inactive", message: "kapibala 的每日签到未开启" }
  return { outcome: "failed", message: `kapibala check-in: ${msg || `HTTP ${res.status}`}`.slice(0, 300) }
}

export const KapibalaAuthPlugin = async () => KapibalaPlugin

const KapibalaPlugin = {
  auth: {
    provider: PROVIDER,
    maxConcurrency: 3,
    maxAccounts: 10,
    async loader(getAuth) {
      const auth = await getAuth()
      const key = trim(auth?.key)
      const group = groupOf(auth)
      return {
        baseURL: API + "/v1",
        apiKey: key,
        async fetch(input, init = {}) {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          const headers = new Headers(input instanceof Request ? input.headers : undefined)
          new Headers(init.headers ?? {}).forEach((v, k) => headers.set(k, v))
          if (key) headers.set("Authorization", `Bearer ${key}`)
          let body = init.body
          let sent = ""
          const raw = typeof body === "string" ? body : ""
          if (raw) {
            try {
              const json = JSON.parse(raw)
              if (typeof json.model === "string" && json.model) {
                sent = stripGroup(json.model, group)
                json.model = sent
                body = JSON.stringify(json)
              }
            } catch { /* not JSON: send as-is */ }
          }
          const res = await fetch(url, { ...init, headers, body })
          if (!sent) return res
          // tell the gateway the model id actually sent, for its ledger
          const out = new Headers(res.headers)
          out.set("X-Magpie-Sent-Model", sent)
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
        },
      }
    },
    methods: [
      {
        type: "api",
        label: "用 API key 登录",
        prompts: [
          {
            type: "password",
            key: "apiKey",
            message: "你的 kapibala API key（sk-...），在 kapibala.asia/keys 里拿。一把 key 属于一个分组。",
            placeholder: "sk-...",
            validate: (v) => (trim(v).startsWith("sk-") ? undefined : "API key 必须以 sk- 开头"),
          },
          {
            type: "password",
            key: "panelToken",
            message: "你的 kapibala 面板访问令牌（nap_...），在 kapibala.asia/security 里拿。它用来查钱包、订阅和签到状态。第一个账号必须填，不填就不显示额度。同一个 kapibala 账号的第二把 key 可以留空，用量和签到会走已经登好的那个账号。",
            placeholder: "nap_...（第一个账号必填）",
            validate: (v) => {
              const t = trim(v)
              if (!t) return undefined
              return t.startsWith("nap_") ? undefined : "面板访问令牌必须以 nap_ 开头"
            },
          },
        ],
        authorize: async (inputs) => {
          const apiKey = trim(inputs?.apiKey)
          const panelToken = trim(inputs?.panelToken)
          if (!apiKey) throw new Error("请输入 API key")
          // The group is looked up from the panel API, never typed in:
          // the key's group decides the "<group>/<model>" prefix, and a
          // wrong prefix would claim a group the key does not have. With
          // no panel token the lookup cannot run, so the group stays ""
          // and models are listed bare, with no prefix at all.
          // panelToken may be empty: the account then shares the panel
          // token of another Kapibala account (same kapibala account), and
          // its usage and check-in come from that account. But an account
          // with no token shows no balance at all, so the first account
          // must fill it in.
          const group = await detectGroup(apiKey, panelToken)
          return { type: "success", key: apiKey, metadata: { panelToken, group } }
        },
      },
    ],
    usage,
    checkin,
  },
  async config(config) {
    config.provider ??= {}
    const was = config.provider[PROVIDER] ?? {}
    config.provider[PROVIDER] = {
      name: "Kapibala",
      npm: "@ai-sdk/openai-compatible",
      api: API + "/v1",
      ...was,
      models: { ...(was.models ?? {}) },
    }
  },
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api" || !trim(auth?.key)) return provider.models
      const group = groupOf(auth)
      // Keep models already known for THIS group (e.g. added manually in
      // Magpie): a /v1/models reply that returns only a subset — a key whose
      // allowed models are restricted on kapibala.asia/keys, for example —
      // must never wipe them. Other groups' "<group>/<id>" entries are left
      // out so the two keys' lists never mix. With no group known, the
      // kept entries are the bare ids (no "/"), which belong to no group.
      const kept = {}
      for (const [id, row] of Object.entries(provider.models ?? {})) {
        if (group ? id.startsWith(`${group}/`) : !id.includes("/")) kept[id] = row
      }
      const fallback = Object.keys(kept).length ? kept : provider.models
      let res
      try {
        res = await callJSON(API + "/v1/models", { token: auth.key })
      } catch {
        return fallback
      }
      if (!res.ok || !Array.isArray(res.json?.data)) return fallback
      const out = { ...kept }
      for (const m of res.json.data) {
        const id = trim(m?.id)
        if (!id) continue
        const listed = listedId(id, group)
        out[listed] = { id: listed, providerID: PROVIDER, name: listed }
      }
      return Object.keys(out).length ? out : fallback
    },
  },
}
