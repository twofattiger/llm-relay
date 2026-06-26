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

> 注意区分计费来源：① 是 Workers AI 的 Neuron 体系，④ 是 Unified Billing 的 credits，**两套独立的钱**，不通用。② ③ 都不花 CF 的钱，花的是你在 provider 那边的余额。

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
- **`@cf/` 不能走这个入口**：Workers AI 不支持 Anthropic Messages 格式，会被 Worker 拦截返回 400，改用 `/v1/chat/completions`。

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

## 怎么判断"通没通"——按报错来源定位

四条路由的核心排错思路：**看错误是哪一层发出来的**，就知道卡在哪。

| 报错特征 | 来源层 | 含义 / 处理 |
|---|---|---|
| Worker 返回 `{"error":{"type":"authentication_error"}}` 401 | **Worker 本身** | 你的 `MY_API_KEY` 没对上；检查 `Authorization`/`x-api-key` 是否带对 |
| `{"errors":[{"code":2021,...}]}` "add money to your gateway" | **Cloudflare AI Gateway** | ④ 统一计费没 credits；充值或改走 BYOK |
| 410 + "Model has been deprecated" | **Workers AI** | ① 模型 ID 下线，换有效 `@cf/...` ID |
| `{"type":"error",...,"request_id":"req_..."}` "credit balance is too low" | **上游 provider 本家**（如 Anthropic） | BYOK 已成功注入并打到上游，是 provider 账户没钱；去 provider 充值 |
| BYOK 路由 401 / gateway 认证失败 | Cloudflare | `CF_API_TOKEN` 缺 **AI Gateway Run** 权限 |
| `@cf/` 路由 401 / 权限错 | Cloudflare | `CF_API_TOKEN` 缺 **Workers AI Read** 权限 |

判定要点：**报错来自上游本家（带 provider 的 request_id / 格式），说明 BYOK 注入成功、路由全通**，剩下的是 provider 侧账户问题，与代码无关。报错来自 Worker 或 Cloudflare，才需要回头查鉴权/权限/credits。

---

## 隐私补充：上游看到的 IP

四条路由的上游调用都由 Worker 重新发起连接，**DeepSeek / Anthropic 等 provider 看到的是 Cloudflare 出口 IP，不是你的真实 IP**（你的 IP 在"你→Worker"那一跳就终止）。代码层面 `fwdHeaders` 从零重建，未透传 `cf-connecting-ip` / `x-forwarded-for`，不会泄露本机 IP。

注意：这只是对**第三方 provider** 隐藏，**Cloudflare 自身可见你的真实 IP**（边缘连接 + AI Gateway 日志均记录）。这是"经 CF 中转"的副产物，不是匿名方案。