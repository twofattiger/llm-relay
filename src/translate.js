// translate.js — Anthropic Messages <-> OpenAI Chat Completions 协议翻译
//
// 用途:让 /v1/messages(Anthropic 格式,如 Claude Code)的请求,后端跑非 Claude 的
//       OpenAI 系模型(DeepSeek / Workers AI / GPT 等)——类 OpenRouter。
//
// 覆盖:system、多轮 messages、文本/图片内容块、tools/tool_use/tool_result、tool_choice、
//       stop_reason、usage,以及流式 SSE 双向事件映射。
// 不覆盖(已知边界,见文末):Anthropic extended thinking、文档块(PDF)、
//       citations、prompt caching 控制、部分 vision 细节。

const rid = (p) => p + (globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)).replace(/-/g, "").slice(0, 24);

// /v1/messages 上是否为"原生 Anthropic 目标"(走透传),否则走翻译
export function isAnthropicNative(model) {
  return /^claude/i.test(model) || model.startsWith("@/anthropic/");
}

function mapFinishToStop(fr) {
  switch (fr) {
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    case "stop": return "end_turn";
    case "content_filter": return "end_turn";
    default: return fr ? "end_turn" : null;
  }
}

function systemToText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  return "";
}

function imageBlockToOpenAI(block) {
  const src = block.source || {};
  if (src.type === "base64") return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  if (src.type === "url") return { type: "image_url", image_url: { url: src.url } };
  return null;
}

function toolResultContentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && b.type === "text") return b.text;
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

// 把一条 Anthropic message 展开成一条或多条 OpenAI message,push 进 out
function pushMessage(out, m) {
  const content = m.content;
  if (typeof content === "string") {
    out.push({ role: m.role, content });
    return;
  }
  if (!Array.isArray(content)) {
    out.push({ role: m.role, content: "" });
    return;
  }

  if (m.role === "assistant") {
    let text = "";
    const toolCalls = [];
    for (const b of content) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") {
        toolCalls.push({ id: b.id || rid("call_"), type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      }
    }
    const msg = { role: "assistant" };
    msg.content = text || null;
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
    return;
  }

  // role === "user"(或 tool 结果载体)
  const parts = [];
  const toolMsgs = [];
  for (const b of content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "image") {
      const img = imageBlockToOpenAI(b);
      if (img) parts.push(img);
    } else if (b.type === "tool_result") {
      toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultContentToText(b.content) });
    }
  }
  // tool 消息要紧跟在触发它的 assistant.tool_calls 之后;Anthropic 通常把 tool_result 单独放一个 user turn,
  // 因此这里先发 tool 消息,再发剩余文本/图片(若有)。
  for (const tm of toolMsgs) out.push(tm);
  if (parts.length) {
    const onlyText = parts.length === 1 && parts[0].type === "text";
    out.push({ role: "user", content: onlyText ? parts[0].text : parts });
  }
}

function mapToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  return "auto";
}

// Anthropic 请求体 → OpenAI 请求体
export function anthropicToOpenAI(a) {
  const o = { model: a.model, messages: [] };
  const sys = systemToText(a.system);
  if (sys) o.messages.push({ role: "system", content: sys });
  for (const m of a.messages || []) pushMessage(o.messages, m);

  if (a.max_tokens != null) o.max_tokens = a.max_tokens;
  if (a.temperature != null) o.temperature = a.temperature;
  if (a.top_p != null) o.top_p = a.top_p;
  if (a.stop_sequences) o.stop = a.stop_sequences;
  if (a.tools && a.tools.length) {
    o.tools = a.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || { type: "object" } } }));
  }
  const tc = mapToolChoice(a.tool_choice);
  if (tc !== undefined) o.tool_choice = tc;
  if (a.stream) {
    o.stream = true;
    o.stream_options = { include_usage: true };
  }
  return o;
}

function safeParseJSON(s) {
  if (typeof s !== "string" || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// OpenAI 非流式响应 → Anthropic 响应
export function openAIToAnthropic(o, model) {
  const choice = (o.choices && o.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({ type: "tool_use", id: tc.id || rid("toolu_"), name: tc.function?.name || "", input: safeParseJSON(tc.function?.arguments) });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: o.id || rid("msg_"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapFinishToStop(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: o.usage?.prompt_tokens || 0, output_tokens: o.usage?.completion_tokens || 0 },
  };
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// OpenAI 流式 SSE → Anthropic 流式 SSE,返回 ReadableStream
export function streamOpenAIToAnthropic(upstreamBody, model) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  let started = false;
  let textIndex = -1;
  let textOpen = false;
  let nextIndex = 0;
  const toolBlocks = {}; // openai tool_call index -> { index, closed }
  let finish = null;
  let inTokens = 0;
  let outTokens = 0;
  const msgId = rid("msg_");

  return new ReadableStream({
    async start(controller) {
      const enq = (s) => controller.enqueue(encoder.encode(s));
      const ensureStart = () => {
        if (started) return;
        started = true;
        enq(sse("message_start", {
          type: "message_start",
          message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inTokens, output_tokens: 0 } },
        }));
        enq(sse("ping", { type: "ping" }));
      };
      const openText = () => {
        ensureStart();
        if (textIndex < 0) {
          textIndex = nextIndex++;
          textOpen = true;
          enq(sse("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } }));
        }
      };
      const closeBlocks = () => {
        if (textOpen) { enq(sse("content_block_stop", { type: "content_block_stop", index: textIndex })); textOpen = false; }
        for (const k in toolBlocks) {
          const tb = toolBlocks[k];
          if (!tb.closed) { enq(sse("content_block_stop", { type: "content_block_stop", index: tb.index })); tb.closed = true; }
        }
      };

      try {
        const handleLine = (line) => {
          line = line.trim();
          if (!line || !line.startsWith("data:")) return;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          let chunk;
          try { chunk = JSON.parse(data); } catch { return; }

          if (chunk.usage) {
            inTokens = chunk.usage.prompt_tokens || inTokens;
            outTokens = chunk.usage.completion_tokens || outTokens;
          }
          const ch = chunk.choices && chunk.choices[0];
          if (!ch) return;
          const delta = ch.delta || {};

          if (delta.content) {
            openText();
            enq(sse("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta.content } }));
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const oi = tc.index != null ? tc.index : 0;
              if (!toolBlocks[oi]) {
                ensureStart();
                const ai = nextIndex++;
                toolBlocks[oi] = { index: ai, closed: false };
                enq(sse("content_block_start", { type: "content_block_start", index: ai, content_block: { type: "tool_use", id: tc.id || rid("toolu_"), name: tc.function?.name || "", input: {} } }));
              }
              const args = tc.function && tc.function.arguments;
              if (args) {
                enq(sse("content_block_delta", { type: "content_block_delta", index: toolBlocks[oi].index, delta: { type: "input_json_delta", partial_json: args } }));
              }
            }
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            handleLine(line);
          }
        }
        buf += decoder.decode(); // flush 多字节尾部
        if (buf.trim()) handleLine(buf); // 处理无换行结尾的最后一行
        ensureStart();
        closeBlocks();
        enq(sse("message_delta", { type: "message_delta", delta: { stop_reason: mapFinishToStop(finish), stop_sequence: null }, usage: { output_tokens: outTokens } }));
        enq(sse("message_stop", { type: "message_stop" }));
        controller.close();
      } catch (e) {
        try { controller.error(e); } catch {}
      }
    },
  });
}