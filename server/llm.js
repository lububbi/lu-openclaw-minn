/**
 * LLM 调用层：把 OpenAI 兼容 API 与 Anthropic Messages API 统一成同一套内部消息格式。
 * 内部消息格式：
 *   { role: "user", content: string }
 *   { role: "assistant", content: string|null, tool_calls?: [{id,name,arguments:object}] }
 *   { role: "tool", tool_call_id: string, name: string, content: string }
 */
import { toolDefinitions, findTool, executeTool } from "./tools.js";

let idCounter = 0;
const localId = (prefix = "call") => `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

function endpoint(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (base.includes(path)) return base;
  return base + path;
}

function authHeaders(model, extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
  return headers;
}

async function readError(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  return `${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 500)}` : ""}`;
}

/** 逐条解析 SSE 的 data 字段 */
async function forEachSSE(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) onData(tail.slice(5).trim());
}

function safeParseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ------------------------- OpenAI 兼容 ------------------------- */

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.content || "" };
      if (m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content });
    }
  }
  return out;
}

async function streamOpenAI({ model, system, messages, tools, effort, onDelta, signal }) {
  const body = {
    model: model.modelId,
    stream: true,
    messages: toOpenAIMessages(system, messages),
    max_tokens: model.maxTokens || 4096,
  };
  if (effort === "high") body.reasoning_effort = "high";
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const res = await fetch(endpoint(model.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: authHeaders(model),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`模型请求失败：${await readError(res)}`);
  if (!res.body) throw new Error("模型未返回可读流");

  let content = "";
  const calls = new Map();
  let streamError = null;

  await forEachSSE(res.body, (data) => {
    if (data === "[DONE]") return;
    const json = safeParseJson(data, null);
    if (!json) return;
    if (json.error) {
      streamError = new Error(json.error.message || JSON.stringify(json.error));
      return;
    }
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const entry = calls.get(idx) || { id: "", name: "", argsText: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.argsText += tc.function.arguments;
        calls.set(idx, entry);
      }
    }
  });

  if (streamError) throw streamError;
  const toolCalls = [...calls.values()]
    .filter((e) => e.name)
    .map((e) => ({
      id: e.id || localId(),
      name: e.name,
      arguments: safeParseJson(e.argsText, {}),
    }));
  return { content, toolCalls };
}

/* ------------------------- Anthropic ------------------------- */

function pushUserBlock(out, block) {
  const last = out[out.length - 1];
  if (last?.role === "user") last.content.push(block);
  else out.push({ role: "user", content: [block] });
}

function toAnthropicMessages(system, messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      pushUserBlock(out, { type: "text", text: m.content });
    } else if (m.role === "tool") {
      pushUserBlock(out, {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content,
      });
    } else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments || {} });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    }
  }
  return out;
}

async function streamAnthropic({ model, system, messages, tools, effort, onDelta, signal }) {
  const maxTokens = model.maxTokens || 4096;
  const body = {
    model: model.modelId,
    stream: true,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(system, messages),
  };
  if (system) body.system = system;
  if (effort === "high") {
    body.thinking = { type: "enabled", budget_tokens: Math.min(2048, Math.max(1024, maxTokens - 1024)) };
  }
  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const res = await fetch(endpoint(model.baseUrl, "/messages"), {
    method: "POST",
    headers: authHeaders(model, { "x-api-key": model.apiKey || "", "anthropic-version": "2023-06-01" }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`模型请求失败：${await readError(res)}`);
  if (!res.body) throw new Error("模型未返回可读流");

  let content = "";
  const calls = new Map();
  let streamError = null;

  await forEachSSE(res.body, (data) => {
    const json = safeParseJson(data, null);
    if (!json) return;
    if (json.type === "error") {
      streamError = new Error(json.error?.message || JSON.stringify(json.error));
      return;
    }
    if (json.type === "content_block_start") {
      const block = json.content_block;
      if (block?.type === "tool_use") {
        calls.set(json.index, {
          id: block.id,
          name: block.name,
          argsText: JSON.stringify(block.input || {}),
        });
      }
    } else if (json.type === "content_block_delta") {
      const delta = json.delta;
      if (delta?.type === "text_delta" && delta.text) {
        content += delta.text;
        onDelta(delta.text);
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        const entry = calls.get(json.index) || { id: "", name: "", argsText: "" };
        entry.argsText += delta.partial_json;
        calls.set(json.index, entry);
      }
    } else if (json.type === "message_delta" && json.delta?.stop_reason === "max_tokens") {
      // 达到上限时仍正常返回已生成内容
    }
  });

  if (streamError) throw streamError;
  const toolCalls = [...calls.values()]
    .filter((e) => e.name)
    .map((e) => ({
      id: e.id || localId(),
      name: e.name,
      arguments: safeParseJson(e.argsText, {}),
    }));
  return { content, toolCalls };
}

/* ------------------------- 编排 ------------------------- */

/**
 * 执行一次完整对话（含工具调用循环）。
 * messages 为包含本轮用户消息的完整历史；返回本次新增的消息数组。
 */
export async function runChat({ model, system = "", messages, tools = [], effort = "default", onDelta = () => {}, onTool = () => {}, signal }) {
  if (!model) throw new Error("未选择模型");
  const defs = toolDefinitions(tools);
  const initialLength = messages.length;
  const working = [...messages];

  for (let round = 0; round < 8; round++) {
    const streamer = model.apiType === "anthropic" ? streamAnthropic : streamOpenAI;
    const { content, toolCalls } = await streamer({
      model,
      system,
      messages: working,
      tools: defs,
      effort,
      onDelta,
      signal,
    });

    if (!toolCalls.length) {
      working.push({ role: "assistant", content, createdAt: Date.now() });
      break;
    }

    working.push({ role: "assistant", content: content || null, tool_calls: toolCalls, createdAt: Date.now() });
    for (const tc of toolCalls) {
      const tool = findTool(tools, tc.name);
      let output;
      try {
        output = await executeTool(tool, tc.arguments);
      } catch (err) {
        output = `工具执行失败：${err.message}`;
      }
      onTool({ id: tc.id, name: tc.name, arguments: tc.arguments, output });
      working.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content: output,
        createdAt: Date.now(),
      });
    }
    if (round === 7) throw new Error("工具调用轮次超过上限（8）");
  }

  return { appended: working.slice(initialLength) };
}

/** 连接测试：发送一条极简消息，验证 URL / Key / 模型 ID 是否可用 */
export async function testConnection(model, signal) {
  const result = await runChat({
    model: { ...model, maxTokens: 64 },
    system: "",
    messages: [{ role: "user", content: "只回复 OK 两个字母，不要其他内容。" }],
    tools: [],
    signal,
  });
  const text = result.appended.find((m) => m.role === "assistant")?.content || "";
  return text.trim() || "连接成功（模型返回为空）";
}
