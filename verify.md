# llm-relay 部署验证手册

部署完成后，用本手册逐条验证四条路由是否打通。约定：

```bash
export BASE="https://你的worker地址.workers.dev"
export KEY="你的_MY_API_KEY"
```

所有命令都加 `-i`，便于看 HTTP 状态码和响应头（重点看有没有 `cf-aig-log-id`，有就说明确实穿过了 AI Gateway）。

---

## 路由总览

| # | 路由 | model 写法 | 入口 | 计费 | 前提 |
|---|---|---|---|---|---|
| ① | Workers AI | `@cf/...` | `/v1/chat/completions` | Workers AI 计价，10k Neurons/天免费，超出按 Neuron 付费 | `CF_API_TOKEN` 含 Workers AI Read |
| ② | BYOK（OpenAI 格式） | `provider/model` 无前缀 | `/v1/chat/completions` | 你自己的 provider 账户（如 DeepSeek），不扣 CF credits | 已在 Provider Keys 存对应 key；`CF_API_TOKEN` 含 AI Gateway Run |
| ③ | BYOK（Anthropic 格式） | 裸名 `claude-...` 无前缀 | `/v1/messages` | 你自己的 Anthropic 账户，不扣 CF credits | 已存 Anthropic key；用 `x-api-key` + `anthropic-version` |
| ④ | Unified Billing | `@/provider/model` | `/v1/chat/completions` 或 `/v1/messages` | Cloudflare 垫付，扣你充的 credits（passthrough 价 + 充值时 5% 手续费） | 已充 credits |
| ⑤ | 协议转换（类 OpenRouter） | `/v1/messages` 上的**非 Claude** model（如 `deepseek/...`、`@cf/...`、`@/deepseek/...`） | `/v1/messages` | **复用 ①②④ 的计费**（按前缀分流） | 同对应前缀路由的前提；额外做 OpenAI↔Anthropic 转换 |

> 注意区分计费来源：① 是 Workers AI 的 Neuron 体系，④ 是 Unified Billing 的 credits，**两套独立的钱**，不通用。② ③ 都不花 CF 的钱，花的是你在 provider 那边的余额。
>
> ⑤ 不是独立计费路由，而是一种**入口能力**：在 Anthropic 入口上发非 Claude 模型时，Worker 自动把 Anthropic 格式转成 OpenAI 格式调上游、再转回——实际计费仍按 model 前缀落到 ①/②/④。验证见下文 ⑤。

---

## ① Workers AI（`@cf/`，CF 自家模型，免费额度）

```bash
curl -i -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"@cf/meta/llama-3.2-3b-instruct","messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200 + OpenAI 格式 JSON 回复。
- **确认计费**：Dashboard → AI → Workers AI，看 Neuron 用量增加；免费档每天 10k Neurons，UTC 00:00 重置。
- **挑模型**：只有 hosted 模型吃免费额度（Llama/Qwen/Gemma/gpt-oss 等小模型）。模型目录会变动，ID 失效会返回 410 deprecated；当前清单用下面命令自取：

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$你的ACCOUNT_ID/ai/models/search?task=Text+Generation&per_page=100" \
  -H "Authorization: Bearer $你的CF_API_TOKEN" | grep -o '"@cf/[^"]*"'
```

---

## ② BYOK / DeepSeek（无前缀，用你自己的 DeepSeek key）

前提：已在 AI Gateway → Provider Keys 存了 DeepSeek 的 key，自己在 DeepSeek 充值或用新号 5M 免费额度。

```bash
curl -i -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200 + 回复。
- **确认是 BYOK 而非别的**：去 DeepSeek 后台看 API 用量，这次调用在那儿出现 = 确实用了你的 key；AI Gateway → Logs 里这条不扣 credits。
- **关键对照**：同一个模型，`@/deepseek/deepseek-v4-flash`（④）在没 credits 时会失败，而本条（无前缀）成功——这就证明 ② 和 ④ 是两条独立的计费路径。

> `deepseek-chat` / `deepseek-reasoner` 是遗留别名，**2026-07-24 废弃**，届时只作为 `deepseek-v4-flash` 思考/非思考模式的兼容名。新代码直接用 `deepseek-v4-flash`。

---

## ③ BYOK / Anthropic（无前缀，走 `/v1/messages`）

前提：已在 Provider Keys 存了 Anthropic key，且该账户在 Anthropic 有余额/已开通计费。注意入口和头与 OpenAI 格式不同：用 `x-api-key`、带 `anthropic-version`。

```bash
curl -i -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200 + Anthropic 格式 JSON（含 `content` 数组、`stop_reason` 等）。
- **本项目已验证**：Anthropic BYOK 纯靠 `cf-aig-authorization` 即可注入，**不需要**启用 worker.js 里 `x-api-key` 兜底那行，也不需要配 `ANTHROPIC_API_KEY`。
- **`anthropic-version: 2023-06-01` 是稳定版本号，不用改**。
- **裸名 `claude-...` 走原生透传（不转换）**：只有 model 以 `claude` 开头或为 `@/anthropic/...` 时才是这条原生 Anthropic 路由；其它任何 model 都会触发协议转换（见 ⑤）。
- **`@cf/` 等非 Claude 模型现在也能走这个入口**：经协议转换（⑤）实现，不再返回 400。若客户端本就是 OpenAI 格式，直接用 `/v1/chat/completions` 更省一层转换。

---

## ④ Unified Billing（`@/`，Cloudflare 垫付，扣 credits）

前提：已充 credits（Dashboard → AI Gateway → Credits Available → Manage → Top-up）。OpenAI 和 Anthropic 两个入口都支持。

```bash
# OpenAI 格式
curl -i -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"@/deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'

# Anthropic 格式
curl -i -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"@/anthropic/claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200 + 回复，且 AI Gateway 的 Credits 余额下降。
- **没充 credits 时的预期报错**（这本身也验证了路由接线正确，确实打到了 Unified Billing）：

  ```json
  {"errors":[{"message":"Insufficient balance; add money to your gateway or use BYOK","code":2021}]}
  ```

> 个别模型可能被 Cloudflare 临时零费率（例如曾观察到 `deepseek-chat` 在 0 余额下也能成功）。这是目录侧的临时状态，**不是通用规则**，别据此假设 `@/` 免费。

---

## ⑤ 协议转换（类 OpenRouter）——Anthropic 入口跑非 Claude 模型

**触发场景（重点）**：在 **Anthropic 入口 `/v1/messages`** 上发一个**非 Claude 模型**（model 既不以 `claude` 开头、也不是 `@/anthropic/...`）。此时 Worker 不再原样透传，而是：Anthropic 请求体 →翻译成 OpenAI 格式 →按 model 前缀复用 ①②④ 的路由调上游 →把 OpenAI 响应（含流式 SSE）翻译回 Anthropic 格式返回。

典型用途：让 **Claude Code / Anthropic SDK** 这类只会说 Anthropic 协议的客户端，直接驱动 DeepSeek / Workers AI / GPT 等非 Claude 模型。

### ⑤-a 非 Claude + 无前缀（→ 复用 ② BYOK）

```bash
curl -i -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek/deepseek-v4-flash","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200 + **Anthropic 格式** JSON（含 `content` 数组、`stop_reason`、`usage.input_tokens/output_tokens`）——注意你发的是 Anthropic 格式、收到的也是 Anthropic 格式，但**上游跑的是 DeepSeek**。
- **证明确实转换了**：去 DeepSeek 后台看用量增加（说明打到了 DeepSeek），而响应却是 Anthropic 结构（说明 Worker 转了回来）。AI Gateway → Logs 里上游那条是 OpenAI 格式。

### ⑤-b 非 Claude + `@cf/`（→ 复用 ① Workers AI，旧版不支持，现已打通）

```bash
curl -i -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"@cf/meta/llama-3.2-3b-instruct","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200 + Anthropic 格式回复（旧版这里会 400，现经协议转换返回正常）。
- **确认计费**：同 ①，看 Workers AI 的 Neuron 用量增加。

### ⑤-c 流式（验证 SSE 双向事件映射）

```bash
curl -N -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek/deepseek-v4-flash","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"写一句话"}]}'
```

- **成功标志**：SSE 流里出现 **Anthropic 风格事件**：`event: message_start` → `content_block_start` → 多个 `content_block_delta`(`text_delta`) → `content_block_stop` → `message_delta` → `message_stop`（而**不是** OpenAI 的 `choices[].delta` chunk）。看到这套事件名就说明流式转换成功。

### ⑤-d 对照：同入口、只换 model 名 = 切换"是否转换"

```bash
# 原生透传（claude 开头）→ 走你的 Anthropic BYOK，不转换
curl -s -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}' | head -c 200
echo
# 协议转换（非 claude）→ 翻译后走 DeepSeek，再转回 Anthropic
curl -s -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek/deepseek-v4-flash","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}' | head -c 200
```

两条都返回 Anthropic 结构，但上游一个是 Anthropic、一个是 DeepSeek——**同一个客户端、同一个入口，仅靠 model 名是否以 `claude` 开头来切换是否转换**。

> **覆盖边界**：协议转换支持 system / 多轮 messages / 文本图片块 / tools / tool_use / tool_result / tool_choice / stop_reason / usage / 流式。**不覆盖** extended thinking、PDF 文档块、citations、prompt caching——需要这些请改用真正的 Claude 模型走原生透传（③ 或 ④ 的 `@/anthropic/`）。

---

## 扩展接入：OpenRouter / Ollama 等更多 provider

本中继**不硬编码 provider 列表**，无前缀路由只是把 `provider/model` 原样转发给 AI Gateway 的 compat 端点。所以**凡是 AI Gateway 支持的 provider，存好 BYOK key 就能用，无需改代码**——这些本质都是路由 ②（无前缀 BYOK），区别只在 provider slug 和 model 写法。

> 也都能配合协议转换（⑤）在 `/v1/messages` / Claude Code 上用：把 model 换成下面这些 `provider/model` 即可（不以 `claude` 开头 → 自动转换）。

### OpenRouter（AI Gateway 内置 provider）

前提：AI Gateway → **Provider Keys** → Add API Key → 选 **OpenRouter** → 填你自己的 OpenRouter key。

```bash
# OpenRouter 的模型 ID 本身带斜杠(vendor/model)，前面再加 openrouter/，故为两层
curl -i -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"openrouter/openai/gpt-4o","messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200 + OpenAI 格式回复。
- **确认是 BYOK**：去 OpenRouter 后台看用量出现这次调用 = 用了你的 key；不扣 CF credits。
- **模型 ID 以 OpenRouter 为准**：在 OpenRouter 的 models 列表查到的 `vendor/model`，统一前面加 `openrouter/`。
- ⚠ 即便是 `openrouter/anthropic/claude-...`，因前缀是 `openrouter` 而非 `claude`，在 `/v1/messages` 上**也走协议转换**（而非原生 Anthropic）。OpenRouter 本就用 OpenAI 格式对外，没问题。

### Ollama（本地模型，需先暴露成公网可达）

⚠ **关键限制**：AI Gateway 跑在 Cloudflare 云端，**够不到你本机的 `http://localhost:11434`**。要经本中继+AI Gateway 用 Ollama，必须先把 Ollama 暴露成一个**公网可达**的地址（如 Cloudflare Tunnel / 公网反代 / 带公网 IP 的服务器）。

前提：
1. Ollama 已起，并通过隧道/反代拿到公网根地址，如 `https://ollama.yourdomain.com`。
2. AI Gateway → Provider Keys → 添加一个 **custom / OpenAI-compatible provider**，**Base URL 只填根地址、不要带 `/v1`**（Ollama 的 OpenAI 兼容端点在 `/v1/chat/completions`，带了会变 `/v1/v1/...` → 404）；记下你给它起的 slug（如 `my-ollama`）。Ollama 默认无需 key，若后台要求填则填占位。

```bash
curl -i -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"my-ollama/llama3.2","messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200 + OpenAI 格式回复;`model` 为你 Ollama 拉取的模型名（`ollama list` 里那个）。
- **404 / 上游路径含 `/v1/v1`**：custom provider 的 Base URL 带了 `/v1`，去掉只留根地址。
- **502 / 连接超时**：AI Gateway 够不到你的 Ollama 公网地址——检查隧道是否在跑、地址是否对外可访问。
- **纯本地自测**：只想验证 Ollama 本身，直接打 `http://localhost:11434/v1/chat/completions` 即可，不必过本中继;要的是"统一入口 + AI Gateway 统计"才需要上面这套公网暴露。

> 其它 AI Gateway 支持的 provider（Groq、Mistral、Together、Perplexity 等）同理：存 BYOK key → `provider/model` 无前缀调用即可，本中继与代码都无需改动。

---

## 动态 API Key 验证（面板签发 + 公用 DO）

前提：已配 `ADMIN_PASSWORD` 并绑定 `RELAY_DO`（随 `wrangler deploy` 自动创建，无需手动建命名空间）。对外 key 有两类，校验顺序 **master → isolate 缓存 → DO**：

- **`MY_API_KEY`（master）**：始终有效、不经 DO，吊销/变更即时（改 secret）。
- **动态 key**：`/admin` 面板"API Key 管理"里签发，带名称/有效期，存 DO `api_keys` 表。

### 在面板签发后验证

登录 `/admin` → 新建一把 key（如名称 `test`、有效期 7 天）→ 复制得到 `sk-relay-...`，然后：

```bash
export DK="sk-relay-...刚签发的"
curl -i -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $DK" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

- **成功标志**：200，和用 `MY_API_KEY` 一样能调通——证明动态 key 已写入 DO 且校验放行。
- **新建即时可用**：只缓存"通过"结果，新 key 不受缓存影响，签发后马上能用。

### 禁用/删除的生效窗口（关键）

在面板把这把 key **禁用或删除**后，立刻再发上面的请求：

- **可能仍返回 200，最多约 60s**——这是热路径 isolate 缓存（`KEY_CACHE_TTL_MS` 默认 60s）造成的预期滞后，等约 1 分钟后会变 401。
- 要**即时失效**：用 `MY_API_KEY`（master 不经缓存），或把 `worker.js` 的 `KEY_CACHE_TTL_MS` 调小后重新部署。

### 有效期到期

到期后该 key 自动失效返回 401（DO 按 `expires_at` 判，缓存也不会续命）。可在面板把有效期改长再试。

> **DO 未绑定时**：面板"API Key 管理"会提示「DO 未绑定(RELAY_DO)」，此时只有 `MY_API_KEY` 可用、登录防爆破跳过。检查 `wrangler.toml` 的 `RelayStore` 绑定与迁移、重新 `deploy`。

---

## 怎么判断"通没通"——按报错来源定位

各路由的核心排错思路：**看错误是哪一层发出来的**，就知道卡在哪。

| 报错特征 | 来源层 | 含义 / 处理 |
|---|---|---|
| Worker 返回 `{"error":{"type":"authentication_error"}}` 401 | **Worker 本身** | key 没对上：检查 `Authorization`/`x-api-key`；动态 key 可能已禁用/过期/删除（删除后还能用最多 ~60s 是缓存所致） |
| `{"errors":[{"code":2021,...}]}` "add money to your gateway" | **Cloudflare AI Gateway** | ④ 统一计费没 credits；充值或改走 BYOK |
| 410 + "Model has been deprecated" | **Workers AI** | ① 模型 ID 下线，换有效 `@cf/...` ID |
| `{"type":"error",...,"request_id":"req_..."}` "credit balance is too low" | **上游 provider 本家**（如 Anthropic） | BYOK 已成功注入并打到上游，是 provider 账户没钱；去 provider 充值 |
| BYOK 路由 401 / gateway 认证失败 | Cloudflare | `CF_API_TOKEN` 缺 **AI Gateway Run** 权限 |
| `@cf/` 路由 401 / 权限错 | Cloudflare | `CF_API_TOKEN` 缺 **Workers AI Read** 权限 |
| `/v1/messages` 非 Claude 模型返回 `{"type":"error",...,"message":"Upstream <code>: ..."}` | **协议转换路径（⑤）下的上游** | Worker 已转换并打到上游，但上游报错；按 `<code>` 当成 ①②④ 的对应问题排查（鉴权/credits/模型 ID） |
| `/v1/messages` 非 Claude 模型返回正常但**缺 thinking / 引用 / 缓存** | 协议转换不覆盖（⑤ 边界） | 这是预期；需要 Claude 全部能力请改用真正的 Claude 模型走原生透传 |

判定要点：**报错来自上游本家（带 provider 的 request_id / 格式），说明 BYOK 注入成功、路由全通**，剩下的是 provider 侧账户问题，与代码无关。报错来自 Worker 或 Cloudflare，才需要回头查鉴权/权限/credits。

---

## 隐私补充：上游看到的 IP

所有路由（含协议转换 ⑤）的上游调用都由 Worker 重新发起连接，**DeepSeek / Anthropic 等 provider 看到的是 Cloudflare 出口 IP，不是你的真实 IP**（你的 IP 在"你→Worker"那一跳就终止）。代码层面 `fwdHeaders` 从零重建，未透传 `cf-connecting-ip` / `x-forwarded-for`，不会泄露本机 IP。

注意：这只是对**第三方 provider** 隐藏，**Cloudflare 自身可见你的真实 IP**（边缘连接 + AI Gateway 日志均记录）。这是"经 CF 中转"的副产物，不是匿名方案。