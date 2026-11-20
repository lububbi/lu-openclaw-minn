import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./store.js";
import { runChat, testConnection } from "./llm.js";
import { listBuiltinTools, resolveTools, testTool } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw new Error("请求体过大");
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const sse = (res, event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

/** 把会话里的连接引用解析成 llm.js 使用的扁平模型配置 */
function resolveSessionModel(session) {
  const conn = store.getConnection(session.connectionId);
  if (!conn || !session.modelId) return null;
  return {
    apiType: conn.apiType,
    baseUrl: conn.baseUrl,
    apiKey: conn.apiKey,
    modelId: session.modelId,
    maxTokens: conn.maxTokens || 4096,
  };
}

async function handleChat(req, res) {
  const body = await readJson(req);
  const session = store.getSession(body.sessionId);
  if (!session) return sendJson(res, 404, { error: "会话不存在" });
  const content = String(body.content ?? "").trim();
  if (!content) return sendJson(res, 400, { error: "消息内容为空" });

  const agent = session.agentId ? store.getAgent(session.agentId) : null;
  const model = resolveSessionModel(session);
  if (!model) return sendJson(res, 400, { error: "会话尚未选择模型，请在聊天框中选择" });

  const userMessage = { role: "user", content, createdAt: Date.now() };
  session.messages.push(userMessage);
  if (session.title === "新会话" && session.messages.length === 1) {
    session.title = content.length > 20 ? content.slice(0, 20) + "…" : content;
  }
  store.save();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    const { appended } = await runChat({
      model,
      system: agent?.systemPrompt || "",
      messages: session.messages,
      tools: resolveTools(agent?.tools || []),
      effort: session.effort,
      signal: abortController.signal,
      onDelta: (text) => sse(res, { type: "delta", text }),
      onTool: (info) => sse(res, { type: "tool", ...info }),
    });
    session.messages.push(...appended);
    session.updatedAt = Date.now();
    store.save();
    const assistant = [...appended].reverse().find((m) => m.role === "assistant");
    sse(res, { type: "done", message: assistant || null });
  } catch (err) {
    if (err.name !== "AbortError") sse(res, { type: "error", message: err.message || String(err) });
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  try {
    if (p === "/api/health") return sendJson(res, 200, { ok: true });

    /* ---- 模型连接（分类） ---- */
    if (p === "/api/connections" && req.method === "GET") return sendJson(res, 200, store.listConnections());
    if (p === "/api/connections" && req.method === "POST") return sendJson(res, 201, store.addConnection(await readJson(req)));
    if (p.startsWith("/api/connections/") && req.method === "PUT") {
      const conn = store.updateConnection(p.split("/")[3], await readJson(req));
      return conn ? sendJson(res, 200, conn) : sendJson(res, 404, { error: "连接不存在" });
    }
    if (p.startsWith("/api/connections/") && req.method === "DELETE") {
      store.removeConnection(p.split("/")[3]);
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/connections/test" && req.method === "POST") {
      const config = await readJson(req);
      const modelId = config.modelId || config.modelIds?.[0];
      if (!config.baseUrl?.trim() || !modelId) return sendJson(res, 200, { ok: false, error: "请填写 Base URL 与至少一个模型 ID" });
      const model = { apiType: config.apiType, baseUrl: config.baseUrl.trim(), apiKey: config.apiKey || "", modelId, maxTokens: config.maxTokens || 4096 };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const reply = await testConnection(model, controller.signal);
        return sendJson(res, 200, { ok: true, reply });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message || String(err) });
      } finally {
        clearTimeout(timer);
      }
    }

    /* ---- agents ---- */
    if (p === "/api/agents" && req.method === "GET") return sendJson(res, 200, store.listAgents());
    if (p === "/api/agents" && req.method === "POST") return sendJson(res, 201, store.addAgent(await readJson(req)));
    if (p.startsWith("/api/agents/") && req.method === "PUT") {
      const agent = store.updateAgent(p.split("/")[3], await readJson(req));
      return agent ? sendJson(res, 200, agent) : sendJson(res, 404, { error: "Agent 不存在" });
    }
    if (p.startsWith("/api/agents/") && req.method === "DELETE") {
      store.removeAgent(p.split("/")[3]);
      return sendJson(res, 200, { ok: true });
    }

    /* ---- sessions ---- */
    if (p === "/api/sessions" && req.method === "GET") return sendJson(res, 200, store.listSessions());
    if (p === "/api/sessions" && req.method === "POST") return sendJson(res, 201, store.addSession(await readJson(req)));
    if (p.startsWith("/api/sessions/") && req.method === "GET" && p.split("/").length === 4) {
      const session = store.getSession(p.split("/")[3]);
      return session ? sendJson(res, 200, session) : sendJson(res, 404, { error: "会话不存在" });
    }
    if (p.startsWith("/api/sessions/") && req.method === "PUT") {
      const session = store.updateSession(p.split("/")[3], await readJson(req));
      return session ? sendJson(res, 200, session) : sendJson(res, 404, { error: "会话不存在" });
    }
    if (p.startsWith("/api/sessions/") && req.method === "DELETE") {
      store.removeSession(p.split("/")[3]);
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/chat" && req.method === "POST") return await handleChat(req, res);

    /* ---- tools ---- */
    if (p === "/api/tools" && req.method === "GET") return sendJson(res, 200, listBuiltinTools());
    if (p === "/api/tools/test" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const output = await testTool(body.tool, body.input);
        return sendJson(res, 200, { ok: true, output });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message || String(err) });
      }
    }

    if (p.startsWith("/api/")) return sendJson(res, 404, { error: "接口不存在" });
    return serveStatic(res, p);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message || String(err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Mini Agent Lab 已启动`);
  console.log(`  → http://localhost:${PORT}\n`);
});
