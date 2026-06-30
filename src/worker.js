// llm-relay — AI Gateway 多路由代理 Worker
// 对外两个入口:
//   POST /v1/chat/completions  → OpenAI 格式
//   POST /v1/messages          → Anthropic 格式
// 每个入口再按 model 前缀分流:无前缀=BYOK / @cf/=Workers AI / @/=统一计费
//
// 环境变量说明:
//   MY_API_KEY    对外的 master/兜底 key,始终有效、不依赖 DO;客户端用 `Authorization: Bearer`
//                 或 `x-api-key` 携带(OpenAI SDK 用前者,Anthropic SDK / Claude Code 用后者)。
//   RELAY_DO      (Durable Object 绑定,SQLite)公用存储,单实例 idFromName("relay")。一个 DO
//                 里建多张表:动态对外 key(api_keys)、登录防爆破(login_guard)、预留用量计数
//                 (usage_counters,将来配额用)。key 校验先查 isolate 内存缓存,未命中再问 DO。
//                 不绑定 RELAY_DO 时:仅 MY_API_KEY 可用、面板 Key 管理不可用、登录防爆破跳过。
//   CF_API_TOKEN  唯一的 Cloudflare API token,同时用于:
//                   - cf-aig-authorization(BYOK 路由,gateway.ai.cloudflare.com)→ 需 AI Gateway Run
//                   - Authorization Bearer(REST 路由,api.cloudflare.com/.../ai/*:@cf/ 和 @/)→ 需 Workers AI Read
//                 ⚠ 必须手动建一个权限给全的 token:AI Gateway Run + Workers AI Read(+ 可选 Read/Edit)。
//                   仅给 Read/Edit 而漏 Run,会导致 BYOK 路由认证失败。
//   ACCOUNT_ID    Cloudflare 账号 ID
//   GATEWAY       AI Gateway 网关名称
//   ANTHROPIC_API_KEY  (可选)仅当 §1.4 验证出 Anthropic BYOK 不可用、需 Worker 补 x-api-key 时才配
//   ADMIN_PASSWORD (可选)登录管理面板 /admin 的密码,与 MY_API_KEY 完全分开。配了它才启用面板。
//                 HMAC 会话签名也用它(改密码即令旧会话失效)。启用面板还需:
//                 ① 给 CF_API_TOKEN 补【Account Analytics Read】只读权限(查 GraphQL 统计);
//                 ② 登录防爆破与动态 key 都走 RELAY_DO(同一个 DO)。
//   WORKER_NAME   (面板用)本 Worker 脚本名,查 Worker 用量用;与 wrangler.toml 的 name 一致(llm-relay)

import { isAnthropicNative, anthropicToOpenAI, openAIToAnthropic, streamOpenAIToAnthropic } from "./translate.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta",
  "Access-Control-Max-Age": "86400",
};

// 从上游透传回客户端的响应头白名单
const PASSTHROUGH_HEADERS = [
  "content-type",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "cf-aig-cache-status",
  "cf-aig-log-id",
];

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

// 管理面板:登录防爆破 + 会话
const ADMIN_MAX_FAILS = 5; // 窗口内最大失败次数(需配 RELAY_DO 才生效)
const ADMIN_WINDOW_MS = 10 * 60 * 1000; // 失败计数窗口:10 分钟
const ADMIN_LOCK_MS = 15 * 60 * 1000; // 触发后锁定时长:15 分钟
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 登录会话有效期:12 小时
const SESSION_COOKIE = "ar_sess";

export default {
  async fetch(req, env) {
    // CORS 预检
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 管理面板(放在 MY_API_KEY 校验之前;仅在配置了 ADMIN_PASSWORD 时启用)
    if (env.ADMIN_PASSWORD) {
      const p = new URL(req.url).pathname;
      if (p === "/admin" || p === "/admin/") {
        return new Response(ADMIN_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (p === "/admin/login") return handleAdminLogin(req, env);
      if (p === "/admin/logout") return handleAdminLogout();
      if (p === "/admin/api/stats") return handleAdminStats(req, env);
      if (p === "/admin/api/keys") return handleAdminKeys(req, env); // GET=列出 POST=新建
      if (p === "/admin/api/keys/update") return handleAdminKeyUpdate(req, env);
      if (p === "/admin/api/keys/delete") return handleAdminKeyDelete(req, env);
      if (p === "/admin/api/examples") return handleAdminExamples(req, env); // 面板示例(master key 填充)
    }

    // 用户示例页:GET /user/key/<key> —— 展示该 key 的接入示例,key 自证、无需登录
    {
      const up = new URL(req.url).pathname;
      if (req.method === "GET" && up.startsWith("/user/key/")) return handleUserKeyPage(req, env);
    }

    // GET /v1/models 获取模型列表
    if (req.method === "GET" && new URL(req.url).pathname === "/v1/models") {
      return handleModelsList(req, env);
    }

    if (req.method !== "POST") {
      return json({ error: { message: "Method not allowed", type: "invalid_request_error" } }, 405);
    }

    // 对外 key 鉴权
    // 同时接受 Authorization: Bearer <key>(OpenAI SDK)和 x-api-key: <key>(Anthropic SDK / Claude Code)
    const token =
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      req.headers.get("x-api-key") ||
      "";
    if (!(await authClient(token, env))) {
      return json({ error: { message: "Unauthorized", type: "authentication_error" } }, 401);
    }

    // 第一层:按入口路径选格式族
    const path = new URL(req.url).pathname;
    let family;
    if (path.endsWith("/v1/chat/completions")) family = "openai";
    else if (path.endsWith("/v1/messages")) family = "anthropic";
    else return json({ error: { message: "Not found", type: "invalid_request_error" } }, 404);

    // 解析 body
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
    }
    const model = body.model;
    if (!model || typeof model !== "string") {
      return json({ error: { message: "Missing 'model'", type: "invalid_request_error" } }, 400);
    }

    // 模型白名单校验
    if (env.SUPPORT_LLMS) {
      try {
        const supported = JSON.parse(env.SUPPORT_LLMS);
        if (Array.isArray(supported) && supported.length > 0 && !supported.includes(model)) {
          return json({ error: { message: `Model '${model}' is not supported. Supported models are: ${supported.join(", ")}`, type: "invalid_request_error" } }, 400);
        }
      } catch (e) {
        // 解析失败忽略
      }
    }

    // Anthropic 入口收到非 Claude 模型 → 翻译成 OpenAI 调上游再转回(类 OpenRouter)
    if (family === "anthropic" && !isAnthropicNative(model)) {
      return handleAnthropicViaOpenAI(body, env);
    }

    // 第二层:按 model 前缀选计费路由
    const route =
      family === "openai"
        ? resolveOpenAI(model, body, env)
        : resolveAnthropic(model, body, env);
    if (route.error) {
      return json({ error: { message: route.error, type: "invalid_request_error" } }, route.status || 400);
    }

    // 组装转发头
    const fwdHeaders = { "Content-Type": "application/json", ...route.headers };
    if (family === "anthropic") {
      // Anthropic 必须带 version;透传客户端的,缺省给默认值
      fwdHeaders["anthropic-version"] =
        req.headers.get("anthropic-version") || DEFAULT_ANTHROPIC_VERSION;
      const beta = req.headers.get("anthropic-beta");
      if (beta) fwdHeaders["anthropic-beta"] = beta;

      // 可选:若 Anthropic BYOK 验证不通过,取消下一行注释,让 Worker 补 x-api-key
      // if (route.byok && env.ANTHROPIC_API_KEY) fwdHeaders["x-api-key"] = env.ANTHROPIC_API_KEY;
    }
    // 注意:绝不把客户端传来的 x-api-key(那是 MY_API_KEY)转发给上游 —— fwdHeaders 完全重建,不复制它。

    // 转发(支持流式)
    let upstream;
    try {
      upstream = await fetch(route.url, {
        method: "POST",
        headers: fwdHeaders,
        body: JSON.stringify(body),
      });
    } catch (e) {
      return json({ error: { message: `Upstream fetch failed: ${e.message}`, type: "upstream_error" } }, 502);
    }

    // 透传响应(含 SSE 流)
    const respHeaders = new Headers(CORS_HEADERS);
    for (const h of PASSTHROUGH_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }
    if (!respHeaders.has("content-type")) respHeaders.set("content-type", "application/json");

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};

// ---- OpenAI 入口(/v1/chat/completions)----
function resolveOpenAI(model, body, env) {
  const restApi = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/v1/chat/completions`;

  if (model.startsWith("@cf/")) {
    return { url: restApi, headers: cfRestHeaders(env) }; // Workers AI,model 原样
  }
  if (model.startsWith("@/")) {
    body.model = model.slice(2); // 统一计费,剥前缀 → provider/model
    return { url: restApi, headers: cfRestHeaders(env) };
  }
  // 无前缀 → BYOK(compat),model 原样 provider/model
  return {
    url: `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY}/compat/chat/completions`,
    headers: { "cf-aig-authorization": `Bearer ${env.CF_API_TOKEN}` },
    byok: true,
  };
}

// ---- Anthropic 入口(/v1/messages)----
// 只处理 Claude 原生模型(claude-* / @/anthropic/*);非 Claude 模型已在 fetch 里被
// isAnthropicNative() 拦走、转入 handleAnthropicViaOpenAI 做协议转换,不会到这里。
function resolveAnthropic(model, body, env) {
  if (model.startsWith("@/")) {
    body.model = model.slice(2); // 统一计费,剥前缀 → anthropic/claude-...
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/v1/messages`,
      headers: cfRestHeaders(env),
    };
  }
  // 无前缀 → BYOK,provider-native Anthropic 端点;model 为裸 claude-...
  return {
    url: `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY}/anthropic/v1/messages`,
    headers: { "cf-aig-authorization": `Bearer ${env.CF_API_TOKEN}` },
    byok: true,
  };
}

function cfRestHeaders(env) {
  return {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "cf-aig-gateway-id": env.GATEWAY,
  };
}

// ---- Anthropic 入口收到非 Claude 模型:翻译成 OpenAI 调上游,再转回 Anthropic ----
async function handleAnthropicViaOpenAI(body, env) {
  const stream = !!body.stream;
  const clientModel = body.model; // 回给客户端时保留其请求的 model 名
  const oai = anthropicToOpenAI(body);

  // 复用 OpenAI 的前缀分流:无前缀=BYOK / @cf/=Workers AI / @/=统一计费
  const route = resolveOpenAI(oai.model, oai, env);
  if (route.error) {
    return json({ type: "error", error: { type: "invalid_request_error", message: route.error } }, route.status || 400);
  }
  const fwdHeaders = { "Content-Type": "application/json", ...route.headers };

  let upstream;
  try {
    upstream = await fetch(route.url, { method: "POST", headers: fwdHeaders, body: JSON.stringify(oai) });
  } catch (e) {
    return json({ type: "error", error: { type: "api_error", message: `Upstream fetch failed: ${e.message}` } }, 502);
  }

  // 上游错误:转成 Anthropic 风格错误体返回(不污染流)
  if (!upstream.ok) {
    const t = await upstream.text();
    return json({ type: "error", error: { type: "api_error", message: `Upstream ${upstream.status}: ${t.slice(0, 800)}` } }, upstream.status);
  }

  if (stream) {
    const out = streamOpenAIToAnthropic(upstream.body, clientModel);
    const headers = new Headers(CORS_HEADERS);
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    headers.set("Cache-Control", "no-cache");
    const logId = upstream.headers.get("cf-aig-log-id");
    if (logId) headers.set("cf-aig-log-id", logId);
    return new Response(out, { status: 200, headers });
  }

  let o;
  try {
    o = await upstream.json();
  } catch (e) {
    return json({ type: "error", error: { type: "api_error", message: `Bad upstream JSON: ${e.message}` } }, 502);
  }
  return json(openAIToAnthropic(o, clientModel), 200);
}

// 取公用 DO 的固定单实例(所有 key/登录/计数都在这一个里)
function relayStub(env) {
  return env.RELAY_DO.get(env.RELAY_DO.idFromName("relay"));
}

// isolate 级缓存:已校验通过的 token → 该缓存项的过期时间戳(ms)。
// 只缓存"通过"的结果(新建 key 即时可用);吊销/过期最多滞后 KEY_CACHE_TTL_MS 生效。
const keyCache = new Map();
const KEY_CACHE_TTL_MS = 60 * 1000;

// 对外 key 校验:master 恒定时间比对 → isolate 缓存 → 问 DO
async function authClient(token, env) {
  if (!token) return false;
  if (env.MY_API_KEY && safeEqual(token, env.MY_API_KEY)) return true;
  if (!env.RELAY_DO) return false;

  const now = Date.now();
  const hit = keyCache.get(token);
  if (hit && hit > now) return true;

  try {
    const r = await relayStub(env).fetch("https://do/keys/validate", {
      method: "POST",
      body: JSON.stringify({ key: token }),
    });
    const d = await r.json();
    if (d.valid) {
      // 缓存到 min(TTL, key 自身到期),避免缓存把已过期的 key 续命
      let exp = now + KEY_CACHE_TTL_MS;
      if (d.rec && d.rec.expiresAt) exp = Math.min(exp, d.rec.expiresAt);
      keyCache.set(token, exp);
      return true;
    }
  } catch {
    // DO 故障:master 仍可用,动态 key 此刻不放行(fail-closed)
  }
  keyCache.delete(token);
  return false;
}

// 恒定时间字符串比较,降低 API key 定时攻击风险
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// GET /v1/models 获取模型列表
async function handleModelsList(req, env) {
  const token =
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    req.headers.get("x-api-key") ||
    "";
  if (!(await authClient(token, env))) {
    return json({ error: { message: "Unauthorized", type: "authentication_error" } }, 401);
  }

  let supportedModels = [];
  if (env.SUPPORT_LLMS) {
    try {
      supportedModels = JSON.parse(env.SUPPORT_LLMS);
    } catch (e) {}
  }
  if (!Array.isArray(supportedModels)) supportedModels = [];

  const now = Math.floor(Date.now() / 1000);
  return json({
    object: "list",
    data: supportedModels.map(m => ({
      id: m,
      object: "model",
      created: now,
      owned_by: "system"
    }))
  });
}

// ============================================================
// 管理面板:登录(ADMIN_PASSWORD)→ HMAC 会话 cookie → 统计
// 数据流:浏览器 → 本 Worker → 用 CF_API_TOKEN 查 GraphQL Analytics
// CF_API_TOKEN 需额外含【Account Analytics Read】只读权限
// ============================================================

const enc = (s) => new TextEncoder().encode(s);

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc(msg));
  return b64url(new Uint8Array(sig));
}

// 校验会话 cookie:token 形如 `<exp>.<hmac(exp)>`,密钥为 ADMIN_PASSWORD
async function verifySession(req, env) {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)ar_sess=([^;]+)/);
  if (!m) return false;
  const tok = m[1];
  const dot = tok.lastIndexOf(".");
  if (dot < 0) return false;
  const exp = tok.slice(0, dot);
  const sig = tok.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expect = await hmacSign(env.ADMIN_PASSWORD, exp);
  return safeEqual(sig, expect);
}

// POST /admin/login  { password }  → 校验 + 防爆破 + 下发会话 cookie
async function handleAdminLogin(req, env) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const pw = typeof body.password === "string" ? body.password : "";
  const ok = safeEqual(pw, env.ADMIN_PASSWORD);

  // 登录防爆破:按 IP,走公用 RELAY_DO 的 login_guard 表
  if (env.RELAY_DO) {
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    let verdict;
    try {
      const gr = await relayStub(env).fetch("https://do/login/record", { method: "POST", body: JSON.stringify({ ip, ok }) });
      verdict = await gr.json();
    } catch {
      verdict = { locked: false }; // 守卫故障不连带锁死;要 fail-closed 可改 locked:true
    }
    if (verdict.locked) {
      return new Response(JSON.stringify({ error: "尝试过多,已锁定", retryAfter: verdict.retryAfter }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(verdict.retryAfter || 60), ...CORS_HEADERS },
      });
    }
  }
  if (!ok) return json({ error: "密码错误" }, 401);

  const exp = Date.now() + SESSION_TTL_MS;
  const sig = await hmacSign(env.ADMIN_PASSWORD, String(exp));
  const tok = String(exp) + "." + sig;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...CORS_HEADERS,
    },
  });
}

function handleAdminLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`,
      ...CORS_HEADERS,
    },
  });
}

// GET /admin/api/stats?hours=24  → Worker 用量 + AI Gateway 用量(需有效会话)
async function handleAdminStats(req, env) {
  if (!(await verifySession(req, env))) return json({ error: "Unauthorized" }, 401);

  // 支持小数小时(0.5 = 30 分钟);下限 1 分钟,上限 30 天
  const raw = parseFloat(new URL(req.url).searchParams.get("hours") || "24");
  const hours = Math.min(Math.max(Number.isFinite(raw) ? raw : 24, 1 / 60), 720);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  const script = env.WORKER_NAME || "llm-relay";

  // 一条 GraphQL 同时取两块:
  //   worker:  workersInvocationsAdaptive (sum requests/errors/subrequests)
  //   gateway: aiGatewayRequestsAdaptiveGroups (count by model/provider)
  const query = `query Stats($tag: string!, $start: Time!, $end: Time!, $script: string!, $limit: uint64!) {
    viewer {
      accounts(filter: { accountTag: $tag }) {
        worker: workersInvocationsAdaptive(
          limit: 1000
          filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }
        ) {
          sum { requests errors subrequests }
          dimensions { status }
        }
        gateway: aiGatewayRequestsAdaptiveGroups(
          limit: $limit
          filter: { datetimeMinute_geq: $start, datetimeMinute_leq: $end }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { model provider gateway }
        }
      }
    }
  }`;

  let gql;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { tag: env.ACCOUNT_ID, start: start.toISOString(), end: end.toISOString(), script, limit: 200 },
      }),
    });
    gql = await r.json();
  } catch (e) {
    return json({ error: `GraphQL fetch failed: ${e.message}` }, 502);
  }
  if (gql.errors && gql.errors.length) {
    // 最常见:CF_API_TOKEN 缺 Account Analytics Read
    return json({ error: "GraphQL error", detail: gql.errors }, 502);
  }

  const acct = gql?.data?.viewer?.accounts?.[0] || {};
  const wrows = acct.worker || [];
  const worker = wrows.reduce(
    (a, r) => ({
      requests: a.requests + (r.sum?.requests || 0),
      errors: a.errors + (r.sum?.errors || 0),
      subrequests: a.subrequests + (r.sum?.subrequests || 0),
    }),
    { requests: 0, errors: 0, subrequests: 0 }
  );

  const grows = (acct.gateway || [])
    .filter((g) => !env.GATEWAY || g.dimensions.gateway === env.GATEWAY)
    .map((g) => ({ model: g.dimensions.model || "(unknown)", provider: g.dimensions.provider || "(unknown)", count: g.count }));
  const gatewayTotal = grows.reduce((s, r) => s + r.count, 0);

  return json({
    hours,
    start: start.toISOString(),
    end: end.toISOString(),
    worker,
    gateway: { total: gatewayTotal, rows: grows },
  });
}

// ============================================================
// 动态对外 API key 管理:Worker 只做鉴权 + 转调公用 RELAY_DO(SQLite)。需有效会话。
// ============================================================

// GET /admin/api/keys → 列出;POST /admin/api/keys → 新建
async function handleAdminKeys(req, env) {
  if (!(await verifySession(req, env))) return json({ error: "Unauthorized" }, 401);
  if (req.method === "POST") return handleAdminKeyCreate(req, env);
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!env.RELAY_DO) return json({ error: "DO 未绑定(RELAY_DO),见 wrangler.toml" }, 501);
  const r = await relayStub(env).fetch("https://do/keys/list", { method: "POST", body: "{}" });
  return json(await r.json());
}

async function handleAdminKeyCreate(req, env) {
  if (!env.RELAY_DO) return json({ error: "DO 未绑定(RELAY_DO),见 wrangler.toml" }, 501);
  let b;
  try { b = await req.json(); } catch { b = {}; }
  const r = await relayStub(env).fetch("https://do/keys/create", { method: "POST", body: JSON.stringify(b) });
  const d = await r.json();
  return json(d, d.error ? 409 : 200);
}

// POST /admin/api/keys/update  { key, name?, disabled?, ttlDays? }
async function handleAdminKeyUpdate(req, env) {
  if (!(await verifySession(req, env))) return json({ error: "Unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.RELAY_DO) return json({ error: "DO 未绑定(RELAY_DO)" }, 501);
  let b;
  try { b = await req.json(); } catch { b = {}; }
  const r = await relayStub(env).fetch("https://do/keys/update", { method: "POST", body: JSON.stringify(b) });
  const d = await r.json();
  if (b.key) keyCache.delete(b.key); // 同 isolate 即时失效(其它 isolate 至多 TTL 后)
  return json(d, d.error ? 400 : 200);
}

// POST /admin/api/keys/delete  { key }
async function handleAdminKeyDelete(req, env) {
  if (!(await verifySession(req, env))) return json({ error: "Unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.RELAY_DO) return json({ error: "DO 未绑定(RELAY_DO)" }, 501);
  let b;
  try { b = await req.json(); } catch { b = {}; }
  const r = await relayStub(env).fetch("https://do/keys/delete", { method: "POST", body: JSON.stringify(b) });
  const d = await r.json();
  if (b.key) keyCache.delete(b.key);
  return json(d);
}

// ============================================================
// 公用「示例」:管理面板(master key 填充)与 /user/key/<key> 页(该 key 填充)共用。
// ============================================================
const BUILD_EXAMPLES_JS = `function buildExamples(origin, key, m) {
  var b = origin;
  var selM = m || "@cf/meta/llama-3.2-3b-instruct";
  var curlParts = [];

  if (selM.indexOf("@cf/") === 0) {
    curlParts = [
      "# Workers AI(@cf/,免费额度)",
      "curl " + b + "/v1/chat/completions -H 'Authorization: Bearer " + key + "' \\\\",
      "  -d '{\\"model\\":\\"" + selM + "\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}'"
    ];
  } else if (selM.indexOf("@/") === 0) {
    curlParts = [
      "# 统一计费(@/,扣 credits)",
      "curl " + b + "/v1/chat/completions -H 'Authorization: Bearer " + key + "' \\\\",
      "  -d '{\\"model\\":\\"" + selM + "\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}'"
    ];
  } else if (selM.indexOf("claude-") === 0) {
    curlParts = [
      "# Anthropic BYOK(/v1/messages,用 x-api-key)",
      "curl " + b + "/v1/messages -H 'x-api-key: " + key + "' -H 'anthropic-version: 2023-06-01' \\\\",
      "  -d '{\\"model\\":\\"" + selM + "\\",\\"max_tokens\\":64,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}'"
    ];
  } else {
    curlParts = [
      "# BYOK(无前缀,用你自己的 provider key)",
      "curl " + b + "/v1/chat/completions -H 'Authorization: Bearer " + key + "' \\\\",
      "  -d '{\\"model\\":\\"" + selM + "\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}'"
    ];
  }

  return curlParts.concat([
    "",
    "# ===== Cursor(Settings → Models → OpenAI API Key)=====",
    "#   API Key:           " + key,
    "#   Override Base URL: " + b + "/v1",
    "#   Add model:         " + selM + "  /  @/openai/gpt-4o  /  @cf/meta/llama-3.3-70b-instruct",
    "#   只支持 OpenAI 格式;开启 Override 后与内置 Pro 模型二选一。",
    "",
    "# ===== Claude Code(环境变量)=====",
    "export ANTHROPIC_BASE_URL=\\"" + b + "\\"            # 不带 /v1",
    "export ANTHROPIC_API_KEY=\\"" + key + "\\"",
    "export ANTHROPIC_MODEL=\\"" + selM + "\\"            # 主模型(非 Claude 也行,如 deepseek/deepseek-chat)",
    "export ANTHROPIC_SMALL_FAST_MODEL=\\"claude-haiku-4-5\\"  # 后台小任务模型,必须也可调通",
    "",
    "# ===== OpenCode(opencode.json)=====",
    "{",
    "  \\"provider\\": {",
    "    \\"llmrelay\\": {",
    "      \\"npm\\": \\"@ai-sdk/openai-compatible\\",",
    "      \\"name\\": \\"LLM Relay\\",",
    "      \\"options\\": { \\"baseURL\\": \\"" + b + "/v1\\", \\"apiKey\\": \\"" + key + "\\" },",
    "      \\"models\\": {",
    "        \\"" + selM + "\\": {},",
    "        \\"@/openai/gpt-4o\\": {},",
    "        \\"@cf/meta/llama-3.3-70b-instruct\\": {}",
    "      }",
    "    }",
    "  }",
    "}"
  ]).join("\\n");
}`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// GET /admin/api/examples → 面板示例,用占位符 <MY_API_KEY>(不暴露真实 master key)。需有效会话。
async function handleAdminExamples(req, env) {
  if (!(await verifySession(req, env))) return json({ error: "Unauthorized" }, 401);
  const origin = new URL(req.url).origin;
  let supportedModels = [];
  if (env.SUPPORT_LLMS) {
    try { supportedModels = JSON.parse(env.SUPPORT_LLMS); } catch(e) {}
  }
  return json({ origin, key: "<MY_API_KEY>", models: supportedModels });
}

// GET /user/key/<key> → 校验 key(存在/未禁用/未过期)后,展示用该 key 填充的示例;无效则报错。
async function handleUserKeyPage(req, env) {
  const url = new URL(req.url);
  let key = url.pathname.slice("/user/key/".length);
  try { key = decodeURIComponent(key); } catch {}
  if (!key || !(await authClient(key, env))) {
    return new Response(USER_ERROR_HTML, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const html = userKeyPageHtml(url.origin, key, env);
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const USER_ERROR_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>无效的 Key</title>
<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;color:#1a1a1a;text-align:center}
h1{font-size:18px} .m{color:#666}</style></head><body>
<h1>Key 无效或已失效</h1>
<p class="m">该 API Key 不存在、已被禁用或已过期。请联系管理员重新获取。</p>
</body></html>`;

function userKeyPageHtml(origin, key, env) {
  let supportedModels = [];
  if (env.SUPPORT_LLMS) {
    try { supportedModels = JSON.parse(env.SUPPORT_LLMS); } catch(e) {}
  }
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>llm-relay 接入示例</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:820px;margin:0 auto;padding:24px 16px;color:#1a1a1a}
  h1{font-size:18px;margin:0 0 16px} h2{font-size:14px;margin:20px 0 8px;color:#666}
  button{cursor:pointer;font:inherit;padding:6px 12px;border:none;border-radius:8px;background:#f4511e;color:#fff}
  select{font:inherit;padding:6px 12px;border:1px solid #ccc;border-radius:8px;}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  code.kk{font-size:13px;background:#f3f3f3;padding:4px 8px;border-radius:6px;word-break:break-all}
  pre{background:#f7f7f7;border:1px solid #e8e8e8;border-radius:8px;padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all}
  .meta{color:#666;margin:6px 0}
</style></head><body>
<h1>llm-relay 接入示例</h1>
<div class="meta">你的 API Key</div>
<div class="row"><code class="kk" id="k">${escapeHtml(key)}</code><button onclick="cp(K)">复制 Key</button></div>
<div class="row" style="margin-top:20px;">
  <h2>示例</h2>
  <div style="flex:1"></div>
  <select id="modelSel">
  </select>
</div>
<pre id="ex"></pre>
<div class="row"><button onclick="cp(document.getElementById('ex').textContent)">复制全部示例</button></div>
<script>
  ${BUILD_EXAMPLES_JS}
  var K=${JSON.stringify(key)};
  var O=${JSON.stringify(origin)};
  var M=${JSON.stringify(supportedModels)};
  function cp(s){if(navigator.clipboard)navigator.clipboard.writeText(s);}
  
  var sel=document.getElementById('modelSel');
  if(M && M.length>0){
    for(var i=0;i<M.length;i++){
      var opt=document.createElement('option');
      opt.value=M[i]; opt.textContent=M[i];
      sel.appendChild(opt);
    }
  } else {
    sel.style.display='none';
  }
  
  function render(){
    document.getElementById('ex').textContent=buildExamples(O, K, sel.value);
  }
  sel.onchange=render;
  render();
</script>
</body></html>`;
}

const ADMIN_HTML = `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>llm-relay 面板</title>
<style>
  :root{--fg:#1a1a1a;--mut:#666;--line:#e8e8e8;--accent:#f4511e}
  *{box-sizing:border-box} body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:820px;margin:0 auto;padding:24px 16px;color:var(--fg)}
  h1{font-size:18px;margin:0 0 16px} h2{font-size:14px;margin:20px 0 8px;color:var(--mut)}
  input,select,button{font:inherit;padding:8px 12px;border:1px solid #ccc;border-radius:8px}
  button{cursor:pointer;background:var(--accent);color:#fff;border:none} button.ghost{background:#f3f3f3;color:#333}
  button:disabled{opacity:.5} .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0}
  .card{flex:1;min-width:120px;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .card .v{font-size:22px;font-weight:600} .card .l{color:var(--mut);font-size:12px}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
  td.n,th.n{text-align:right} .meta{color:var(--mut);margin:6px 0} .err{color:#c00;white-space:pre-wrap;word-break:break-all;margin:8px 0}
  pre{background:#f7f7f7;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all}
  .hide{display:none} #login{max-width:320px;margin:60px auto;text-align:center}
  #login input{width:100%;margin:8px 0}
  button.mini{padding:3px 8px;font-size:12px;border-radius:6px}
  code.kk{font-size:12px;background:#f3f3f3;padding:2px 5px;border-radius:5px;word-break:break-all}
  .pill{font-size:12px;padding:1px 7px;border-radius:999px}
  .pill.on{background:#e6f4ea;color:#137333} .pill.off{background:#fce8e6;color:#c5221f}
</style></head><body>

<div id="login" class="hide">
  <h1>llm-relay 面板</h1>
  <input id="pw" type="password" placeholder="管理密码" autocomplete="current-password">
  <button id="loginBtn" style="width:100%">登录</button>
  <div class="err" id="loginErr"></div>
</div>

<div id="dash" class="hide">
  <div class="row" style="justify-content:space-between">
    <h1 style="margin:0">llm-relay 面板</h1>
    <div class="row">
      <select id="hours"><option value="0.5">近 30 分钟</option><option value="2">近 2 小时</option><option value="6">近 6 小时</option><option value="24" selected>近 24 小时</option><option value="168">近 7 天</option><option value="720">近 30 天</option></select>
      <button id="refresh" class="ghost">刷新</button>
      <button id="logout" class="ghost">退出</button>
    </div>
  </div>
  <div class="meta" id="meta"></div>
  <div class="err" id="err"></div>

  <h2>Worker 用量</h2>
  <div class="cards" id="wcards"></div>
  <div class="meta">免费档约 10 万次请求/天;此处为所选窗口内总数。详细趋势仍看 CF 后台。</div>

  <h2>AI Gateway 用量(按模型)</h2>
  <table id="gtbl"><thead><tr><th>Model</th><th>Provider</th><th class="n">请求数</th></tr></thead><tbody></tbody></table>
  <div class="meta" id="gmeta"></div>

  <h2>API Key 管理</h2>
  <div class="row">
    <input id="kname" placeholder="名称(可选,如 我的笔记本)" style="flex:1;min-width:160px">
    <select id="kttl">
      <option value="0">永不过期</option>
      <option value="7">7 天</option>
      <option value="30">30 天</option>
      <option value="90">90 天</option>
      <option value="365">365 天</option>
      <option value="custom">自定义…</option>
    </select>
    <input id="kdate" type="datetime-local" class="hide">
    <button id="kcreate">新建 Key</button>
  </div>
  <div class="err" id="kerr"></div>
  <table id="ktbl"><thead><tr><th>名称</th><th>Key</th><th>创建</th><th>到期</th><th>状态</th><th>操作</th></tr></thead><tbody></tbody></table>
  <div class="meta" id="kmeta"></div>
  <div class="meta">动态 key 存在公用 DO(SQLite),另有一个 <code class="kk">MY_API_KEY</code>(master)始终有效、不在此列。吊销/改有效期最多约 1 分钟后全网生效(isolate 缓存)。配额/次数限制待后续。</div>

  <h2>示例</h2>
  <div class="row" style="margin-bottom:8px;">
    <div style="flex:1"></div>
    <select id="adminModelSel" class="hide">
    </select>
  </div>
  <pre id="examples"></pre>
  <div class="meta">以上示例用 master key(<code class="kk">MY_API_KEY</code>)填充;每把动态 key 的专属示例页可在上方「复制示例」拿到链接。统计有几分钟延迟,非实时。</div>
</div>

<script>
  ${BUILD_EXAMPLES_JS}
  var $=function(id){return document.getElementById(id);};
  function esc(s){return String(s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
  function show(el,on){el.classList[on?"remove":"add"]("hide");}

  var adminExamplesData = null;
  function renderAdminExamples(){
    if(!adminExamplesData) return;
    $("examples").textContent=buildExamples(adminExamplesData.origin, adminExamplesData.key, $("adminModelSel").value);
  }
  $("adminModelSel").onchange=renderAdminExamples;

  async function loadExamples(){
    try{
      var r=await fetch("/admin/api/examples",{credentials:"same-origin"});
      if(r.status===401){enterLogin();return;}
      var d=await r.json();
      if(!r.ok){ $("examples").textContent="加载示例失败:"+(d.error||r.status); return; }
      adminExamplesData = d;
      var sel=$("adminModelSel");
      if(d.models && d.models.length>0){
        sel.innerHTML='';
        for(var i=0;i<d.models.length;i++){
          var opt=document.createElement('option');
          opt.value=d.models[i]; opt.textContent=d.models[i];
          sel.appendChild(opt);
        }
        show(sel, true);
      } else {
        show(sel, false);
      }
      renderAdminExamples();
    }catch(e){$("examples").textContent="加载示例失败:"+e.message;}
  }

  async function loadStats(){
    $("err").textContent=""; $("meta").textContent="加载中…";
    try{
      var r=await fetch("/admin/api/stats?hours="+$("hours").value,{credentials:"same-origin"});
      if(r.status===401){enterLogin();return;}
      var d=await r.json();
      if(!r.ok)throw new Error((d.detail?JSON.stringify(d.detail,null,2):d.error)||("HTTP "+r.status));
      $("meta").textContent="窗口 "+d.start.slice(0,16).replace("T"," ")+" → "+d.end.slice(0,16).replace("T"," ");
      $("wcards").innerHTML=
        card(d.worker.requests,"请求数")+card(d.worker.errors,"错误数")+card(d.worker.subrequests,"子请求(上游调用)");
      var tb=$("gtbl").querySelector("tbody"); tb.innerHTML="";
      var rows=d.gateway.rows, CAP=50, shown=rows.slice(0,CAP);
      for(var i=0;i<shown.length;i++){var row=shown[i];var tr=document.createElement("tr");
        tr.innerHTML="<td>"+esc(row.model)+"</td><td>"+esc(row.provider)+"</td><td class=n>"+row.count+"</td>";tb.appendChild(tr);}
      var note=rows.length>CAP?(" — 仅显示请求数最高的 "+CAP+"/"+rows.length+" 个模型"):"";
      $("gmeta").textContent="网关总请求 "+d.gateway.total+(rows.length?note:" (此窗口无数据)");
    }catch(e){$("meta").textContent="";$("err").textContent="查询失败:\\n"+e.message;}
  }
  function card(v,l){return "<div class=card><div class=v>"+v+"</div><div class=l>"+l+"</div></div>";}

  function fmtTs(ts){return new Date(ts).toISOString().slice(0,16).replace("T"," ");}
  async function loadKeys(){
    $("kerr").textContent="";
    try{
      var r=await fetch("/admin/api/keys",{credentials:"same-origin"});
      if(r.status===401){enterLogin();return;}
      var d=await r.json();
      if(!r.ok)throw new Error(d.error||("HTTP "+r.status));
      var tb=$("ktbl").querySelector("tbody"); tb.innerHTML="";
      var now=Date.now();
      (d.keys||[]).forEach(function(k){
        var expired=k.expiresAt&&k.expiresAt<now;
        var stat=k.disabled?"<span class='pill off'>已禁用</span>":(expired?"<span class='pill off'>已过期</span>":"<span class='pill on'>启用</span>");
        var tr=document.createElement("tr");
        tr.innerHTML=
          "<td>"+esc(k.name||"-")+"</td>"+
          "<td><button class='ghost mini' data-copykey='"+esc(k.key)+"'>复制 apiKey</button> "+
          "<button class='ghost mini' data-copyex='"+esc(k.key)+"'>复制示例</button></td>"+
          "<td>"+(k.createdAt?fmtTs(k.createdAt):"-")+"</td>"+
          "<td>"+(k.expiresAt?fmtTs(k.expiresAt):"永不")+"</td>"+
          "<td>"+stat+"</td>"+
          "<td><button class='ghost mini' data-toggle='"+esc(k.key)+"' data-dis='"+(k.disabled?"0":"1")+"'>"+(k.disabled?"启用":"禁用")+"</button> "+
          "<button class='ghost mini' data-del='"+esc(k.key)+"'>删除</button></td>";
        tb.appendChild(tr);
      });
      $("kmeta").textContent=(d.keys&&d.keys.length)?("共 "+d.keys.length+" 个"):"暂无动态 key";
    }catch(e){$("kerr").textContent="加载失败:"+e.message;}
  }
  async function createKey(){
    $("kerr").textContent="";
    var payload={name:$("kname").value};
    var expDesc;
    if($("kttl").value==="custom"){
      var v=$("kdate").value;
      if(!v){$("kerr").textContent="请选择自定义到期时间";return;}
      payload.expiresAt=new Date(v).getTime(); // datetime-local 为本地时间,getTime 得 UTC 毫秒
      expDesc=v.replace("T"," ");
    }else{
      payload.ttlDays=Number($("kttl").value);
      expDesc=payload.ttlDays>0?(payload.ttlDays+" 天后"):"永不过期";
    }
    if(!confirm("确认新建 Key？\\n名称:"+(payload.name||"(无)")+"\\n有效期:"+expDesc))return;
    $("kcreate").disabled=true;
    try{
      var r=await fetch("/admin/api/keys",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      var d=await r.json();
      if(!r.ok)throw new Error(d.error||("HTTP "+r.status));
      $("kname").value=""; loadKeys();
    }catch(e){$("kerr").textContent="创建失败:"+e.message;}
    finally{$("kcreate").disabled=false;}
  }
  function toggleCustomDate(){
    var on=$("kttl").value==="custom";
    show($("kdate"),on);
    if(on){
      // 默认填「明天此刻」,并把可选下限设为当前(本地时区)
      var local=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
      $("kdate").min=local;
      if(!$("kdate").value)$("kdate").value=new Date(Date.now()+86400000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
    }
  }
  async function keyAction(url,payload){
    var r=await fetch(url,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(r.status===401){enterLogin();return;}
    if(!r.ok){var d=await r.json().catch(function(){return {};});$("kerr").textContent="操作失败:"+(d.error||r.status);return;}
    loadKeys();
  }

  function enterLogin(){show($("dash"),false);show($("login"),true);$("pw").focus();}
  function enterDash(){show($("login"),false);show($("dash"),true);loadExamples();loadStats();loadKeys();}

  async function doLogin(){
    var pw=$("pw").value; if(!pw){$("loginErr").textContent="请输入密码";return;}
    $("loginBtn").disabled=true;$("loginErr").textContent="";
    try{
      var r=await fetch("/admin/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});
      var d=await r.json().catch(function(){return {};});
      if(r.ok){$("pw").value="";enterDash();return;}
      $("loginErr").textContent=(d.error||"登录失败")+(d.retryAfter?(" — 请 "+d.retryAfter+" 秒后再试"):"");
    }catch(e){$("loginErr").textContent="网络错误:"+e.message;}
    finally{$("loginBtn").disabled=false;}
  }

  $("loginBtn").onclick=doLogin;
  $("pw").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});
  $("refresh").onclick=loadStats;
  $("hours").onchange=loadStats;
  $("logout").onclick=async function(){await fetch("/admin/logout",{method:"POST",credentials:"same-origin"});enterLogin();};

  $("kcreate").onclick=createKey;
  $("kttl").onchange=toggleCustomDate;
  $("ktbl").addEventListener("click",function(e){
    var t=e.target; if(t.tagName!=="BUTTON")return;
    function flash(){var old=t.textContent;t.textContent="已复制";setTimeout(function(){t.textContent=old;},1000);}
    function cp(s){if(navigator.clipboard)navigator.clipboard.writeText(s);}
    if(t.dataset.copykey!=null){
      cp(t.dataset.copykey);flash();
    }else if(t.dataset.copyex!=null){
      cp(location.origin+"/user/key/"+encodeURIComponent(t.dataset.copyex));flash();
    }else if(t.dataset.toggle!=null){
      var willDisable=t.dataset.dis==="1";
      if(confirm((willDisable?"确认禁用":"确认启用")+"该 key？"))keyAction("/admin/api/keys/update",{key:t.dataset.toggle,disabled:willDisable});
    }else if(t.dataset.del!=null){
      if(confirm("删除该 key？此操作不可恢复。"))keyAction("/admin/api/keys/delete",{key:t.dataset.del});
    }
  });

  // 启动:用 stats 探测是否已有会话
  (async function(){
    try{
      var r=await fetch("/admin/api/stats?hours=24",{credentials:"same-origin"});
      if(r.status===401){enterLogin();}else{enterDash();}
    }catch(e){enterLogin();}
  })();
</script></body></html>`;

// 生成随机对外 key:sk-relay-<48 hex>
function genKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  let hex = "";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  return "sk-relay-" + hex;
}

// 解析到期时间戳(ms):优先用绝对 expiresAt(面板"自定义"日期控件传来),否则用 ttlDays 天数。
// 返回:number=具体到期 / null=永不过期 / undefined=非法(过去或无效)→ 调用方应报错。
function resolveExpiry(b, now) {
  if (b.expiresAt != null && b.expiresAt !== "") {
    const t = Number(b.expiresAt);
    if (!Number.isFinite(t) || t <= now) return undefined;
    return t;
  }
  const ttlDays = Number(b.ttlDays);
  return ttlDays && ttlDays > 0 ? now + ttlDays * 86400 * 1000 : null;
}

// api_keys 行 → 对外结构(给缓存判过期 / 面板展示)
function rowToRec(r) {
  return {
    name: r.name || "",
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    disabled: !!r.disabled,
    allowedModels: r.allowed_models ? JSON.parse(r.allowed_models) : null,
    limits: r.limits ? JSON.parse(r.limits) : null,
  };
}

// ============================================================
// RelayStore:llm-relay 的公用存储(Durable Object,SQLite,单实例 idFromName("relay"))
// 一个 DO 内多张表,强一致:
//   api_keys       动态对外 key + 元数据(名称/有效期/禁用/预留 allowed_models、limits)
//   login_guard    按 IP 的登录爆破防护(原 LoginGuard,改成一张表)
//   usage_counters 预留:按 key 的用量计数(将来配额用,原子自增;当前未在热路径计数)
// 通过内部 fetch 调用:/keys/validate /keys/list /keys/create /keys/update /keys/delete /login/record
// sql.exec 同步执行,故各 op 为同步方法。
// ============================================================
export class RelayStore {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS api_keys(key TEXT PRIMARY KEY, name TEXT, created_at INTEGER, expires_at INTEGER, disabled INTEGER DEFAULT 0, allowed_models TEXT, limits TEXT)"
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS login_guard(ip TEXT PRIMARY KEY, fails INTEGER DEFAULT 0, window_start INTEGER, lock_until INTEGER DEFAULT 0)"
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS usage_counters(key TEXT, day TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(key, day))"
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const b = await request.json().catch(() => ({}));
    switch (url.pathname) {
      case "/keys/validate": return Response.json(this.validateKey(b.key));
      case "/keys/list": return Response.json({ keys: this.listKeys() });
      case "/keys/create": return Response.json(this.createKey(b));
      case "/keys/update": return Response.json(this.updateKey(b));
      case "/keys/delete": return Response.json(this.deleteKey(b));
      case "/login/record": return Response.json(this.loginRecord(b));
      default: return new Response("not found", { status: 404 });
    }
  }

  validateKey(key) {
    if (!key) return { valid: false };
    const row = this.sql.exec("SELECT * FROM api_keys WHERE key=?", key).toArray()[0];
    if (!row || row.disabled) return { valid: false };
    if (row.expires_at && row.expires_at < Date.now()) return { valid: false };
    return { valid: true, rec: rowToRec(row) };
  }

  listKeys() {
    return this.sql
      .exec("SELECT key, name, created_at, expires_at, disabled FROM api_keys ORDER BY created_at DESC")
      .toArray()
      .map((r) => ({ key: r.key, name: r.name || "", createdAt: r.created_at, expiresAt: r.expires_at, disabled: !!r.disabled }));
  }

  createKey(b) {
    const name = (typeof b.name === "string" ? b.name : "").slice(0, 64);
    const now = Date.now();
    const expiresAt = resolveExpiry(b, now);
    if (expiresAt === undefined) return { error: "到期时间需晚于当前时间" };
    const key = typeof b.key === "string" && b.key.trim() ? b.key.trim() : genKey();
    if (this.sql.exec("SELECT 1 FROM api_keys WHERE key=?", key).toArray()[0]) return { error: "key 已存在" };
    this.sql.exec(
      "INSERT INTO api_keys(key, name, created_at, expires_at, disabled, allowed_models, limits) VALUES(?,?,?,?,0,NULL,NULL)",
      key, name, now, expiresAt
    );
    return { ok: true, key, name, createdAt: now, expiresAt, disabled: false };
  }

  updateKey(b) {
    const key = typeof b.key === "string" ? b.key : "";
    if (!key) return { error: "missing key" };
    const row = this.sql.exec("SELECT name, expires_at, disabled FROM api_keys WHERE key=?", key).toArray()[0];
    if (!row) return { error: "not found" };
    let name = row.name, disabled = row.disabled, expiresAt = row.expires_at;
    if (typeof b.name === "string") name = b.name.slice(0, 64);
    if (typeof b.disabled === "boolean") disabled = b.disabled ? 1 : 0;
    if ("ttlDays" in b || "expiresAt" in b) {
      const e = resolveExpiry(b, Date.now());
      if (e === undefined) return { error: "到期时间需晚于当前时间" };
      expiresAt = e;
    }
    this.sql.exec("UPDATE api_keys SET name=?, disabled=?, expires_at=? WHERE key=?", name, disabled, expiresAt, key);
    return { ok: true };
  }

  deleteKey(b) {
    const key = typeof b.key === "string" ? b.key : "";
    if (!key) return { error: "missing key" };
    this.sql.exec("DELETE FROM api_keys WHERE key=?", key);
    return { ok: true };
  }

  // 登录爆破防护:成功清零;失败窗口内累加,达阈值锁定;锁定期内一律 locked。
  loginRecord(b) {
    const ip = typeof b.ip === "string" ? b.ip : "unknown";
    const ok = !!b.ok;
    const now = Date.now();
    const cur = this.sql.exec("SELECT fails, window_start, lock_until FROM login_guard WHERE ip=?", ip).toArray()[0] || {
      fails: 0, window_start: now, lock_until: 0,
    };

    if (cur.lock_until > now) return { locked: true, retryAfter: Math.ceil((cur.lock_until - now) / 1000) };
    if (ok) {
      this.sql.exec("DELETE FROM login_guard WHERE ip=?", ip);
      return { locked: false };
    }
    let fails = cur.fails, ws = cur.window_start;
    if (now - ws > ADMIN_WINDOW_MS) { ws = now; fails = 0; }
    fails += 1;
    if (fails >= ADMIN_MAX_FAILS) {
      const lock = now + ADMIN_LOCK_MS;
      this.sql.exec("INSERT OR REPLACE INTO login_guard(ip, fails, window_start, lock_until) VALUES(?,?,?,?)", ip, 0, now, lock);
      return { locked: true, retryAfter: Math.ceil(ADMIN_LOCK_MS / 1000) };
    }
    this.sql.exec("INSERT OR REPLACE INTO login_guard(ip, fails, window_start, lock_until) VALUES(?,?,?,?)", ip, fails, ws, 0);
    return { locked: false };
  }
}