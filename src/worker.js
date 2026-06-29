// llm-relay — AI Gateway 多路由代理 Worker
// 对外两个入口:
//   POST /v1/chat/completions  → OpenAI 格式
//   POST /v1/messages          → Anthropic 格式
// 每个入口再按 model 前缀分流:无前缀=BYOK / @cf/=Workers AI / @/=统一计费
//
// 环境变量说明:
//   MY_API_KEY    对外鉴权用的自有 key;客户端用 `Authorization: Bearer` 或 `x-api-key` 携带
//                 (OpenAI SDK 用前者,Anthropic SDK / Claude Code 用后者)
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
//                 ② 建议配 LOGIN_GUARD(Durable Object)做登录防爆破。
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
const ADMIN_MAX_FAILS = 5; // 窗口内最大失败次数(需配 LOGIN_GUARD DO 才生效)
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
      // 根路径直达面板:GET / → 跳转 /admin
      if (req.method === "GET" && (p === "/" || p === "")) {
        return Response.redirect(new URL("/admin", req.url).toString(), 302);
      }
      if (p === "/admin" || p === "/admin/") {
        return new Response(ADMIN_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (p === "/admin/login") return handleAdminLogin(req, env);
      if (p === "/admin/logout") return handleAdminLogout();
      if (p === "/admin/api/stats") return handleAdminStats(req, env);
    }

    if (req.method !== "POST") {
      return json({ error: { message: "Method not allowed", type: "invalid_request_error" } }, 405);
    }

    // 自有 API key 鉴权
    // 同时接受 Authorization: Bearer <key>(OpenAI SDK)和 x-api-key: <key>(Anthropic SDK / Claude Code)
    const token =
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      req.headers.get("x-api-key") ||
      "";
    if (!safeEqual(token, env.MY_API_KEY)) {
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

  // 登录防爆破:按 IP,需配 LOGIN_GUARD(Durable Object)
  if (env.LOGIN_GUARD) {
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    const stub = env.LOGIN_GUARD.get(env.LOGIN_GUARD.idFromName(ip));
    let verdict;
    try {
      const gr = await stub.fetch("https://guard/record", { method: "POST", body: JSON.stringify({ ok }) });
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

  <h2>请求示例</h2>
  <pre id="examples"></pre>
  <div class="meta">统计有几分钟延迟,非实时。Neuron 免费额度等更细数据请查 CF 后台。</div>
</div>

<script>
  var $=function(id){return document.getElementById(id);};
  function esc(s){return String(s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
  function show(el,on){el.classList[on?"remove":"add"]("hide");}

  function fillExamples(){
    var base=location.origin;
    var t=""
      +"# ① Workers AI(@cf/,免费额度)\\n"
      +"curl "+base+"/v1/chat/completions -H 'Authorization: Bearer <MY_API_KEY>' \\\\\\n"
      +"  -d '{\\"model\\":\\"@cf/meta/llama-3.2-3b-instruct\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}'\\n\\n"
      +"# ② BYOK(无前缀,用你自己的 key)\\n"
      +"curl "+base+"/v1/chat/completions -H 'Authorization: Bearer <MY_API_KEY>' \\\\\\n"
      +"  -d '{\\"model\\":\\"deepseek/deepseek-v4-flash\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}'\\n\\n"
      +"# ③ Anthropic BYOK(/v1/messages,用 x-api-key)\\n"
      +"curl "+base+"/v1/messages -H 'x-api-key: <MY_API_KEY>' -H 'anthropic-version: 2023-06-01' \\\\\\n"
      +"  -d '{\\"model\\":\\"claude-haiku-4-5\\",\\"max_tokens\\":64,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}'\\n\\n"
      +"# ④ 统一计费(@/,扣 credits)\\n"
      +"curl "+base+"/v1/chat/completions -H 'Authorization: Bearer <MY_API_KEY>' \\\\\\n"
      +"  -d '{\\"model\\":\\"@/deepseek/deepseek-v4-flash\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}'";
    $("examples").textContent=t;
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

  function enterLogin(){show($("dash"),false);show($("login"),true);$("pw").focus();}
  function enterDash(){show($("login"),false);show($("dash"),true);fillExamples();loadStats();}

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

  // 启动:用 stats 探测是否已有会话
  (async function(){
    try{
      var r=await fetch("/admin/api/stats?hours=24",{credentials:"same-origin"});
      if(r.status===401){enterLogin();}else{enterDash();}
    }catch(e){enterLogin();}
  })();
</script></body></html>`;

// ============================================================
// LoginGuard:按 IP 的登录爆破防护(Durable Object,强一致)
// 单次调用判定:传入本次尝试成功/失败,返回是否处于锁定态。
//   - 成功:清空该 IP 计数。
//   - 失败:窗口内累加;达到 ADMIN_MAX_FAILS 即锁定 ADMIN_LOCK_MS。
//   - 锁定期内任何尝试(即使密码正确)都返回 locked,直到锁定到期。
// 用 SQLite 版 DO(免费档可用),storage 惰性过期,无需 alarm。
// ============================================================
export class LoginGuard {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const body = await request.json().catch(() => ({ ok: false }));
    const ok = !!body.ok;
    const now = Date.now();
    const s = (await this.state.storage.get("s")) || { fails: 0, windowStart: now, lockUntil: 0 };

    if (s.lockUntil > now) {
      return Response.json({ locked: true, retryAfter: Math.ceil((s.lockUntil - now) / 1000) });
    }
    if (ok) {
      await this.state.storage.delete("s");
      return Response.json({ locked: false });
    }
    if (now - s.windowStart > ADMIN_WINDOW_MS) {
      s.windowStart = now;
      s.fails = 0;
    }
    s.fails += 1;
    if (s.fails >= ADMIN_MAX_FAILS) {
      s.lockUntil = now + ADMIN_LOCK_MS;
      s.fails = 0;
      s.windowStart = now;
      await this.state.storage.put("s", s);
      return Response.json({ locked: true, retryAfter: Math.ceil(ADMIN_LOCK_MS / 1000) });
    }
    await this.state.storage.put("s", s);
    return Response.json({ locked: false });
  }
}