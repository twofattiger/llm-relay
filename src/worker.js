// llm-relay — AI Gateway 多路由代理 Worker
// 对外两个入口:
//   POST /v1/chat/completions  → OpenAI 格式
//   POST /v1/messages          → Anthropic 格式
// 每个入口再按 model 前缀分流:无前缀=BYOK / @cf/=Workers AI / @/=统一计费
// 环境变量说明:
//   MY_API_KEY    对外鉴权用的自有 key
//   CF_API_TOKEN  唯一的 Cloudflare API token(需含 AI Gateway Read/Edit + Workers AI Read 权限)
//                 同时用于 cf-aig-authorization(BYOK 路由)和 Authorization Bearer(REST 路由)
//   ACCOUNT_ID    Cloudflare 账号 ID
//   GATEWAY       AI Gateway 网关名称

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, anthropic-version, anthropic-beta",
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

export default {
  async fetch(req, env) {
    // CORS 预检
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
      return json({ error: { message: "Method not allowed", type: "invalid_request_error" } }, 405);
    }

    // 自有 API key 鉴权
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
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
function resolveAnthropic(model, body, env) {
  if (model.startsWith("@cf/")) {
    return {
      error: "Workers AI (@cf/) does not support the Anthropic Messages format. Use /v1/chat/completions instead.",
      status: 400,
    };
  }
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