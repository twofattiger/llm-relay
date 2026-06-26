# llm-relay

经 Cloudflare AI Gateway 的多路由 LLM 代理。一个部署在 Cloudflare Workers 上的轻量代理。对外同时暴露 **OpenAI 兼容**(`/v1/chat/completions`)和 **Anthropic 兼容**(`/v1/messages`)两个入口,通过 **入口路径选格式 + model 名前缀选计费路由** 两层分流,统一隐藏 Cloudflare 账号凭证、用自己的对外 API key 鉴权,并完整保留 AI Gateway 的可观测性。

## 项目结构

```
llm-relay/
├── src/
│   ├── worker.js         # Worker 主代码(路由 + 鉴权 + 透传)
│   └── wrangler.toml     # Wrangler 配置(name/main/非敏感 vars)
└── README.md             # 本文档
```

代码见 [`src/worker.js`](./src/worker.js),配置见 [`src/wrangler.toml`](./src/wrangler.toml)。本文档只讲原理、准备、部署与排错,不重复贴代码。

> 注意:`wrangler.toml` 放在 `src/` 下,因此所有 `npx wrangler` 命令都需先 `cd src` 再执行(或用 `-c src/wrangler.toml` 指定)。`main` 已相应设为相对 `src/` 的 `worker.js`。

---

## 1. 设计目标与核心结论

### 1.1 要解决的问题

- 对外只暴露**一个自己的 API key**,隐藏 Cloudflare 账号 ID、网关 token、各 provider 凭证。
- 同时支持 **OpenAI SDK** 和 **Anthropic SDK**(如 Claude Code)两类客户端。
- 在同一服务里混用三种计费/路由模式,调用方**只靠 model 名前缀**切换,不需要额外 header。
- 所有流量穿过 AI Gateway,保留日志、用量/成本分析、缓存、限流、重试、fallback、guardrails。

### 1.2 两层分流模型

**第一层:按入口路径选格式族**

| 入口路径 | 格式 | 适用客户端 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | OpenAI SDK 及一切 OpenAI 兼容客户端 |
| `POST /v1/messages` | Anthropic Messages | Anthropic SDK、Claude Code 等 |

**第二层:按 model 名前缀选计费路由**(两个入口共用同一套前缀约定)

OpenAI 入口(`/v1/chat/completions`):

| 调用方发的 model | 路由 | 上游端点 | 鉴权 | 计费 | 发给上游的 model |
|---|---|---|---|---|---|
| `deepseek/deepseek-v4-flash`(无前缀) | **BYOK** | `gateway.ai.cloudflare.com/.../compat/chat/completions` | `cf-aig-authorization` | 你自己的 provider 账户,**不扣 credits** | 原样 `provider/model` |
| `@cf/meta/llama-...`(`@cf/`) | **Workers AI** | `api.cloudflare.com/.../ai/v1/chat/completions` | `Authorization: Bearer` | Workers AI 计价(有免费额度) | 原样保留 `@cf/...` |
| `@/deepseek/deepseek-v4-flash`(`@/`) | **统一计费** | `api.cloudflare.com/.../ai/v1/chat/completions` | `Authorization: Bearer` | Unified Billing,**扣 credits** | 剥掉 `@/` → `provider/model` |

Anthropic 入口(`/v1/messages`):

| 调用方发的 model | 路由 | 上游端点 | 鉴权 | 计费 | 发给上游的 model |
|---|---|---|---|---|---|
| `claude-sonnet-4-5`(无前缀) | **BYOK** | `gateway.ai.cloudflare.com/.../anthropic/v1/messages` | `cf-aig-authorization` | 你自己的 Anthropic 账户,**不扣 credits** | 裸名 `claude-...` |
| `@/anthropic/claude-sonnet-4-5`(`@/`) | **统一计费** | `api.cloudflare.com/.../ai/v1/messages` | `Authorization: Bearer` | Unified Billing,**扣 credits** | 剥掉 `@/` → `anthropic/claude-...` |
| `@cf/...`(`@cf/`) | ❌ **不支持** | — | — | — | 报错,引导改用 `/v1/chat/completions` |

> 为什么 Anthropic 入口没有 `@cf/`:Workers AI 模型走的是 OpenAI 格式,不接受 Anthropic Messages 格式。要调 Workers AI 请用 `/v1/chat/completions` 配 `@cf/`。

### 1.3 一条必须记住的底层事实

> **BYOK 只在 `gateway.ai.cloudflare.com` 上生效,在 `api.cloudflare.com/.../ai/*` 上无效。**

`api.cloudflare.com/.../ai/*`(REST 统一 API)对第三方模型**强制走 Unified Billing(credits)**,不会使用你存的 BYOK key。要用自己的 provider key,必须走 provider-native / `gateway.ai.cloudflare.com` 端点。这就是三条计费路由如此划分的根本原因:

- **BYOK(自带 key、不扣费)** → 只能走 `gateway.ai.cloudflare.com`(无前缀路由)。
- **Cloudflare 垫付的统一计费** → 走 `api.cloudflare.com`(`@/` 路由),**必须先充 credits**。
- **Workers AI(`@cf/`)** → 走 `api.cloudflare.com`,按 Workers AI 计价(不吃 credits)。

### 1.4 Anthropic + BYOK 的特别说明(务必先验证)

Anthropic 经 AI Gateway 时,凭证是以 `x-api-key` 形式传给上游的;部分 SDK 会强制要求带 key。理论上配好 BYOK 后,provider-native 端点只需 `cf-aig-authorization`,AI Gateway 会自动注入你存的 Anthropic key。但 Anthropic 这条历来比 DeepSeek/OpenAI 挑剔(Cloudflare 官方的 Claude Code 接入示例就明确**不用 BYOK**、改用环境变量里的 Anthropic key)。

**落地前请先用 curl 验证**:provider-native Anthropic 端点能否**纯靠 `cf-aig-authorization`**(不带 `x-api-key`)跑通 BYOK。
- 能 → 本设计直接可用,客户端无需任何 Anthropic key。
- 不能 → 两个选择:(a) 把 Anthropic key 存成 BYOK 再试注入;(b) 退而让 Worker 从 secret 里补一个 `x-api-key`(取消 `src/worker.js` 中相应注释行,并配置 `ANTHROPIC_API_KEY`),代价是 Worker 持有 Anthropic key。

---

## 2. 架构原理

```
                          ┌────────────────────────────────────────────────────┐
   OpenAI SDK ───────────▶│                  Cloudflare Worker                   │
   POST /v1/chat/...      │  1. CORS / 方法校验                                  │
                          │  2. 自有 API key 鉴权 (MY_API_KEY)                   │
   Anthropic SDK ────────▶│  3. 按 path 选格式族 (openai | anthropic)            │
   POST /v1/messages      │  4. 按 model 前缀选计费路由 + 改写 model             │
                          │  5. 换上对应上游鉴权头(必要时透传 anthropic-version)│
                          └───────────┬───────────────────────┬─────────────────┘
                  无前缀 (BYOK)        │                       │   @cf/  或  @/
                                      ▼                       ▼
        gateway.ai.cloudflare.com                  api.cloudflare.com/.../ai
        OpenAI:  /compat/chat/completions          OpenAI:    /ai/v1/chat/completions
        Anthropic: /anthropic/v1/messages          Anthropic: /ai/v1/messages
        header: cf-aig-authorization               header: Authorization + cf-aig-gateway-id
        → 注入你存的 BYOK key,不扣 credits          → @cf/: Workers AI 计价
                                                   → @/  : Unified Billing 扣 credits
                                      │                       │
                                      └───────────┬───────────┘
                                                  ▼
                                   AI Gateway 统计/日志/缓存/限流
                                                  ▼
                                          上游模型 provider
```

### 关键点

1. **格式族由入口路径决定,计费路由由 model 前缀决定**,两者正交。
2. **`@cf/` 与 `@/` 打同一个 REST 端点、同一套 header**,唯一区别是 model 串(`@cf/` 保留前缀,`@/` 剥前缀)。
3. **无前缀是唯一走 `gateway.ai.cloudflare.com` 的**,也是唯一能用 BYOK 的。
4. Worker 只做**鉴权 + 路由 + 透传**,不解析/转换业务内容(不写 OpenAI↔Anthropic 转换器),因此原生支持流式(直接 pipe `upstream.body`),且两种格式互不污染。

---

## 3. 前置准备(Cloudflare 侧)

### 3.1 创建 AI Gateway

Dashboard → **AI → AI Gateway → 创建网关**,记下网关名称(如 `cf-ai-gateway`),对应 `GATEWAY` 变量。

### 3.2 开启 Authenticated Gateway 并生成网关 token

进入网关 → **Settings** → 打开 **Authenticated Gateway** → **Create authentication token**(自带 AI Gateway Run 权限)。**只显示一次,务必保存。** 这是 `CF_API_TOKEN`(用于 `cf-aig-authorization`,即所有 BYOK 路由)。

### 3.3 配置 BYOK(自带 provider key)

进入网关 → **Provider Keys** → **Add API Key** → 选 provider(DeepSeek / OpenAI / Anthropic …)→ 填入你自己的 provider key → 保存。

- BYOK 是**按 provider 存的**,不是按 model;存一次,该 provider 名下所有模型都能用 BYOK。
- 支持同一 provider 多 key,用 alias 区分;默认用 `default`,切换加 `cf-aig-byok-alias` 头。
- Anthropic 的 BYOK 请按 §1.4 先验证。
- 自定义 provider 的 Base URL 只填**根域名**(如 `https://api.deepseek.com`),不要带 `/v1`,否则上游收到 `/v1/v1/...` 会 404。

### 3.4 创建 Cloudflare API Token

Dashboard → **My Profile → API Tokens → Create Token**,赋权(用于 `api.cloudflare.com/.../ai/*`,即 `@cf/` 和 `@/` 路由):

- **AI Gateway — Read**
- **AI Gateway — Edit**
- **Workers AI — Read**

这是 `CF_API_TOKEN`。注意这几个权限**无法限定到单个网关**;多租户隔离请用独立账户。

### 3.5 充值 credits(仅 `@/` 统一计费路由需要)

Dashboard → AI Gateway → **Credits Available → Manage → Top-up**(先加 payment method)。**不充值则 `@/` 路由报错。** BYOK(无前缀)和 Workers AI(`@cf/`)不需要 credits。

---

## 4. 环境变量

| 变量名 | 类型 | 说明 | 示例 |
|---|---|---|---|
| `MY_API_KEY` | **secret** | 对外发放的 API key,客户端在 `Authorization: Bearer` 里带它 | `sk-proxy-xxxxx` |
| `CF_API_TOKEN` | **secret** | AI Gateway 网关认证 token(3.2),用于所有 BYOK 路由 | `cfat_e09xxx` |
| `CF_API_TOKEN` | **secret** | Cloudflare API token(3.4),用于 `@cf/` 和 `@/` 路由 | `xxxxxxxx` |
| `ANTHROPIC_API_KEY` | **secret**(可选) | 仅当 §1.4 验证出 Anthropic BYOK 不可用、需 Worker 补 `x-api-key` 时才用 | `sk-ant-xxx` |
| `ACCOUNT_ID` | var | Cloudflare 账号 ID(非敏感,可明文) | `abc123...` |
| `GATEWAY` | var | AI Gateway 网关名称 | `cf-ai-gateway` |

- **secret** 用 `npx wrangler secret put` 写入;**var** 写在 `src/wrangler.toml` 的 `[vars]`。
- 本地开发:在 `src/` 下手动建一个 `.dev.vars` 文件填入各 secret(`wrangler dev` 会从配置文件同目录读取);建议把 `.dev.vars` 加进 `.gitignore`,勿提交。

---

## 5. 部署流程(npx wrangler)

> 全程 `npx wrangler`,无需全局安装。需 Node.js ≥ 18。
> `wrangler.toml` 在 `src/` 下,**所有 wrangler 命令都在 `src/` 目录里执行**(或在任意位置加 `-c src/wrangler.toml` 指定配置文件)。下面以 `cd src` 为准。

### 5.1 安装依赖

```bash
cd llm-relay/src                  # wrangler.toml 所在目录,在此执行所有 wrangler 命令
npm init -y                       # 若还没有 package.json
npm install --save-dev wrangler

# 本地开发用:在 src/ 下手动创建 .dev.vars 并填入 secret(勿提交)
cat > .dev.vars <<'EOF'
MY_API_KEY=sk-proxy-local-test
CF_API_TOKEN=xxx
# ANTHROPIC_API_KEY=sk-ant-xxx   # 仅 Anthropic BYOK 需补 x-api-key 时
EOF
```

### 5.2 登录(二选一)

```bash
# 方式 A:交互式 OAuth
npx wrangler login

# 方式 B:CI/无头环境
export CLOUDFLARE_API_TOKEN=你的_有_Workers_编辑权限的_token
export CLOUDFLARE_ACCOUNT_ID=你的账号ID
```

> 5.2 这个 token 是**部署用**的(需 Workers Scripts Edit 权限),与运行时的 `CF_API_TOKEN`(AI 权限)是两回事,别混。

### 5.3 写入 secrets

```bash
npx wrangler secret put MY_API_KEY      # 对外发放的 key
npx wrangler secret put CF_API_TOKEN    # Cloudflare API token(AI Gateway Read+Edit / Workers AI Read)
# 可选:npx wrangler secret put ANTHROPIC_API_KEY

npx wrangler secret list                # 查看已配置的 secret 名(不显示值)
```

### 5.4 本地调试

```bash
npx wrangler dev    # http://localhost:8787,读取 src/.dev.vars
```

### 5.5 部署

```bash
npx wrangler deploy
# 输出形如 https://llm-relay.<子域>.workers.dev
```

### 5.6 查看实时日志

```bash
npx wrangler tail
```

---

## 6. 调用示例

约定:`BASE` = 你的 Worker 地址(如 `https://llm-relay.<子域>.workers.dev`),`MY_API_KEY` = 你的对外 key。

### 6.0 model 命名速查

| 前缀 | 路由 | OpenAI 入口 model 写法 | Anthropic 入口 model 写法 |
|---|---|---|---|
| 无前缀 | BYOK(自己的 key,不扣 credits) | `provider/model`,如 `deepseek/deepseek-chat` | 裸名,如 `claude-sonnet-4-5` |
| `@cf/` | Workers AI(免费额度) | `@cf/<目录ID>`,如 `@cf/meta/llama-3.3-70b-instruct` | ❌ 不支持 |
| `@/` | 统一计费(扣 credits) | `@/provider/model`,如 `@/openai/gpt-4o` | `@/anthropic/claude-sonnet-4-5` |

> 占位说明:下文中 `<...>` 的模型 ID 需替换成真实值。Workers AI 的 `@cf/...` ID 见 Dashboard 的 Workers AI models 页或 `GET /accounts/{id}/ai/models/search`;统一计费的 `provider/model` 见 AI Gateway 的 supported-models / model catalog;BYOK 的 provider slug 以你在 Provider Keys 里配置的为准。

---

### 6.1 路由一:BYOK(无前缀,用你自己的 provider key,不扣 credits)

前提:已在 AI Gateway 的 Provider Keys 给对应 provider 存了 key。

**DeepSeek**

```bash
curl -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

**OpenAI**

```bash
curl -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"你好"}]}'
```

**自定义 provider**(slug 为 `custom-deepseek01` 这类,以你创建时为准)

```bash
curl -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"custom-deepseek01/<你的模型名>","messages":[{"role":"user","content":"你好"}]}'
```

**流式**(任意 provider,加 `"stream":true`;响应为 SSE)

```bash
curl -N -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-chat","stream":true,"messages":[{"role":"user","content":"写一句话"}]}'
```

**Anthropic 经 BYOK**(走 `/v1/messages`,model 用裸名;先按 §1.4 验证 Anthropic BYOK 可用)

```bash
curl -X POST "$BASE/v1/messages" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

---

### 6.2 路由二:Workers AI(`@cf/`,Cloudflare 自家模型,有免费额度)

仅 OpenAI 入口可用。model 必须是 Workers AI 目录里的真实 ID。

**Llama**

```bash
curl -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"@cf/meta/llama-3.3-70b-instruct","messages":[{"role":"user","content":"你好"}]}'
```

**其它 Workers AI 模型**(把 ID 换成目录里的真实值,如 Qwen、Mistral、Gemma 等)

```bash
curl -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"@cf/<workers-ai-目录里的模型ID>","messages":[{"role":"user","content":"你好"}]}'
```

> 在 `/v1/messages` 上用 `@cf/` 会被 Worker 拒绝(400),Workers AI 不支持 Anthropic 格式,请改用 `/v1/chat/completions`。

**关于免费额度(重要)**

Workers AI 按 **Neuron**(Cloudflare 衡量 GPU 算力的内部单位,$0.011 / 1000 Neurons)计费,**每天有 10,000 Neurons 免费额度,UTC 00:00 重置,超出后请求直接报错(免费版不自动扣费)**。但这个免费额度有两个前提,务必注意:

1. **只有 hosted 模型才吃免费额度**。Cloudflare 目录里 `@cf/` 模型分两类:
   - **Hosted**(跑在 Cloudflare 自家 GPU 上的开源权重模型,如 Llama / Qwen / Gemma / Mistral / DeepSeek 蒸馏版)→ 用 Neuron 计费,**享受免费额度**。
   - **Proxied**(实际推理在第三方 GPU 上,Cloudflare 只转发)→ **完全绕开 Neuron 系统,没有免费额度**,按 provider 标准价收费,账单出现在对应 provider 处。
   - 所以想"白嫖"免费额度,`@cf/` 只能挑 **hosted** 的开源模型。
2. **10,000 Neurons 折算成多少 token 因模型而异**(每个模型 Neuron 换算率不同,无统一汇率)。各模型的 Neuron 单价见其文档页或 `GET /accounts/{id}/ai/models/search` 返回的元数据;实时用量在 Workers AI Dashboard 可查。

> DeepSeek 别混:Workers AI 上 hosted 的是 DeepSeek **蒸馏开源版**(`@cf/deepseek-ai/deepseek-r1-distill-...`,吃免费额度);DeepSeek 官方的 `deepseek-chat` 等要走 BYOK(无前缀)或统一计费(`@/`),不属于这条免费路由。

---

### 6.3 路由三:统一计费(`@/`,Cloudflare 垫付,扣 credits)

前提:账户已充 credits(§3.5)。OpenAI 入口和 Anthropic 入口都支持。

**OpenAI 格式 — DeepSeek**

```bash
curl -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"@/deepseek/deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

**OpenAI 格式 — OpenAI / Google 等目录 provider**

```bash
# OpenAI
curl -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"@/openai/gpt-4o","messages":[{"role":"user","content":"你好"}]}'

# Google Gemini(provider slug 以目录为准)
curl -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"@/google-ai-studio/<gemini-模型名>","messages":[{"role":"user","content":"你好"}]}'
```

**Anthropic 格式 — Claude**(走 `/v1/messages`,model 带 `@/anthropic/` 前缀)

```bash
curl -X POST "$BASE/v1/messages" \
  -H "Authorization: Bearer $MY_API_KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"@/anthropic/claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

---

### 6.4 SDK 接入

**OpenAI SDK(Python)**——切路由只改 model 名,其它不变:

```python
from openai import OpenAI

client = OpenAI(api_key="<MY_API_KEY>", base_url="https://<你的worker>/v1")

# 三条路由示例
for model in [
    "deepseek/deepseek-chat",                 # 无前缀 → BYOK
    "@cf/meta/llama-3.3-70b-instruct",        # @cf/   → Workers AI
    "@/openai/gpt-4o",                        # @/     → 统一计费
]:
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "你好"}],
    )
    print(model, "→", resp.choices[0].message.content)
```

**OpenAI SDK 流式**:

```python
stream = client.chat.completions.create(
    model="deepseek/deepseek-chat",
    messages=[{"role": "user", "content": "讲个冷笑话"}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

**Anthropic SDK(Python)**——`base_url` 指向 Worker 根(不带 `/v1`):

```python
from anthropic import Anthropic

client = Anthropic(api_key="<MY_API_KEY>", base_url="https://<你的worker>")

msg = client.messages.create(
    model="claude-sonnet-4-5",            # 无前缀 → BYOK
    # model="@/anthropic/claude-sonnet-4-5",  # 改成这个 → 统一计费
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
)
print(msg.content)
```

**Claude Code 接入**:

```bash
export ANTHROPIC_BASE_URL="https://<你的worker>"
export ANTHROPIC_API_KEY="<MY_API_KEY>"
# 之后 Claude Code 的请求会打到 /v1/messages,默认走无前缀=BYOK
```

> Anthropic SDK 默认请求 `{base_url}/v1/messages`,所以 `base_url` 不要再带 `/v1`。

---

## 7. 排错对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `10000 Authentication error` | `CF_API_TOKEN` 权限不足 | 补齐 AI Gateway Read+Edit、Workers AI Read |
| 提示充值 / 余额不足(走 `@/`) | 统一计费需要 credits | 充 credits;或改无前缀走 BYOK |
| 配了 BYOK 仍提示充值 | BYOK 在 `api.cloudflare.com/.../ai/*` 上**无效** | 改成**无前缀**走 gateway 端点 |
| Anthropic 入口 401 / 要 key | Anthropic BYOK 未注入 | 见 §1.4:验证 BYOK,或启用 Worker 补 `x-api-key` 的可选项 |
| Anthropic 入口报 version 错误 | 缺 `anthropic-version` | 代码已自动补默认值;客户端也可显式带 |
| `@cf/` 打到 `/v1/messages` 报错 | Workers AI 不支持 Anthropic 格式 | 改用 `/v1/chat/completions` |
| `404`,上游路径出现 `/v1/v1/...` | 自定义 provider 的 `base_url` 带了 `/v1` | `base_url` 只填根域名 |
| `@cf/` 路由 404 | Workers AI 模型 ID 不对 | 用目录里的真实 `@cf/...` ID |
| 浏览器端被 CORS 挡 | 缺预检/跨域头 | 代码已含 `OPTIONS` 与 CORS 头(含 anthropic-* 允许头) |

---

## 8. 安全与限制

- **凭证隔离**:对外只用 `MY_API_KEY`;CF 账号 token、BYOK key 都在服务端/CF 托管。`MY_API_KEY` 轮换只需改 secret,无需改代码。
- **Anthropic key 暴露面**:若启用 `x-api-key` 可选项,Worker 会持有 Anthropic key;能用纯 BYOK 就尽量别开,以维持"密钥不落地"。
- **租户隔离**:AI Gateway 权限不能限定到单个网关;多租户用独立账户。
- **限流/配额**:本 Worker 不含限额;交给 AI Gateway 配置,或在 Worker 里基于 `MY_API_KEY`/用户维度自行加(KV / D1 / Durable Objects)。
- **可观测性**:四条有效路由都穿过 AI Gateway,日志/分析在对应网关下可见;REST 路由已带 `cf-aig-gateway-id`。
- **范围**:覆盖 `chat/completions` 与 `messages`。embeddings、responses 等按相同模式扩展入口与 `resolve*` 即可。
- **格式不互转**:本设计**不做** OpenAI↔Anthropic 转换,两个入口各自原样透传;客户端用哪个 SDK 就打哪个 path。

---

## 9. 后续可扩展方向

1. **服务端模型白名单/别名表**:把"哪些 provider 有 BYOK、各模型走哪条路、属于哪个格式族"做成 Worker 内映射表(或 KV/D1),对调用方屏蔽前缀细节,自动选路由与格式入口。
2. **多 BYOK key 切换**:按调用方身份注入 `cf-aig-byok-alias`,实现 dev/prod key 隔离。
3. **`/v1/models` 合成端点**:AI Gateway 无上游 models 列表接口,可在 Worker 合成(Workers AI 用 `GET /accounts/{id}/ai/models/search`,第三方目录维护静态表)。
4. **按 key 计量与配额**:结合 Durable Objects 做精确的 per-key 速率/额度控制。
5. **格式自动适配(进阶,慎做)**:若确有需求把单一格式入口同时服务两类客户端,再考虑写转换层;注意 thinking/tool_use/stop_reason 的映射成本很高,优先用本设计的双入口原样透传。
6. **作为 CF 内部统一 AI 出口(Service Bindings)**:让你其它 Cloudflare Worker 项目通过 Service Binding 直接调用本中继,不走公网、零额外延迟、不计入对外请求数。详见 §10。

---

## 10. 进阶:作为 CF 内部统一 AI 出口(Service Bindings)

把 llm-relay 当成你 Cloudflare 上所有项目的"统一 AI 出口层":其它 Worker(如 host-relay、未来的 AI 记忆层等)通过 **Service Binding** 在 CF 内部直接调它,统一鉴权、路由与 AI Gateway 统计,上层项目完全不碰 provider 凭证和路由细节。

### 为什么用 Service Binding 而不是 fetch 公网地址

| | Service Binding | fetch 公网 `workers.dev` |
|---|---|---|
| 网络路径 | CF 内部直达,不出公网 | 绕一圈公网回到自己 |
| 延迟 | 零额外网络延迟 | 多一跳 |
| 对外请求计数 | 不计入 | 计入 |
| 适用范围 | 仅 CF 内的 Worker | 任意客户端(含 CF 外) |

> CF **外部**的调用方(本地脚本、其他平台服务、第三方 app)无法用 binding,仍走公网 HTTP 调 `workers.dev` 或自定义域。中继本身不用改——binding 和 HTTP 打进来的是同一个 `fetch` handler。

### 调用方配置(在“调用方”项目的 wrangler.toml)

```toml
[[services]]
binding = "LLM"            # 代码里用 env.LLM
service = "llm-relay"      # 目标 Worker 名(本中继的 name)
```

### 调用方代码

```js
// env.LLM.fetch() 直接进入 llm-relay 的 fetch handler,不走公网。
// URL 的 host 任意(内部不解析域名),路径要对(/v1/chat/completions 或 /v1/messages)。
const resp = await env.LLM.fetch(
  new Request("https://internal/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MY_API_KEY}`,   // 与中继约定的对外 key
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat",              // 无前缀=BYOK,前缀规则同公网
      messages: [{ role: "user", content: "你好" }],
    }),
  })
);

// 流式同样支持:resp.body 可直接 pipe
const data = await resp.json();
```

### 可选:免去内部鉴权

Service Binding 调用是内部可信的。若不想给每个内部调用方都发 `MY_API_KEY`,可在中继里识别"来自 binding 的内部请求"跳过 `MY_API_KEY` 校验——例如约定一个内部 header(如 `x-internal: 1`),或用更进阶的 RPC 模式(`WorkerEntrypoint`)。保持统一鉴权也完全可行,看是否想简化。

> 本中继 `src/worker.js` 无需任何改动即可被 binding 调用;以上扩展都在“调用方”侧或可选地在中继的鉴权分支里做。