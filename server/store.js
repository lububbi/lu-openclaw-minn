import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const newId = () => crypto.randomUUID();

function seed() {
  const localId = newId();
  const openaiId = newId();
  return {
    connections: [
      {
        id: localId,
        name: "Ollama 本地模型",
        apiType: "openai",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "ollama",
        modelIds: ["llama3.2:latest"],
        maxTokens: 4096,
        createdAt: Date.now(),
      },
      {
        id: openaiId,
        name: "OpenAI",
        apiType: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        modelIds: ["gpt-6", "gpt-5.6"],
        maxTokens: 4096,
        createdAt: Date.now(),
      },
    ],
    agents: [
      {
        id: newId(),
        name: "测试助手",
        description: "示例 Agent：绑定本地模型，开启时间与计算器工具",
        systemPrompt: "你是一个乐于助人的 AI 助手。回答简洁清晰，需要时主动调用可用工具。",
        connectionId: localId,
        modelId: "llama3.2:latest",
        tools: [
          { type: "builtin", name: "get_time" },
          { type: "builtin", name: "calculator" },
        ],
        createdAt: Date.now(),
      },
    ],
    sessions: [],
  };
}

function load() {
  try {
    if (!fs.existsSync(STORE_PATH)) return seed();
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    if (!raw.trim()) return seed();
    const parsed = JSON.parse(raw);
    return {
      connections: Array.isArray(parsed.connections) ? parsed.connections : [],
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch (err) {
    console.error("[store] 读取失败，使用空数据：", err.message);
    return { connections: [], agents: [], sessions: [] };
  }
}

let state = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

/* ---------- 模型连接（分类） ---------- */
const listConnections = () => state.connections;
const getConnection = (id) => state.connections.find((c) => c.id === id);
function addConnection(data) {
  const conn = { ...data, id: newId(), createdAt: Date.now() };
  state.connections.push(conn);
  save();
  return conn;
}
function updateConnection(id, data) {
  const conn = getConnection(id);
  if (!conn) return null;
  Object.assign(conn, data, { id, updatedAt: Date.now() });
  save();
  return conn;
}
function removeConnection(id) {
  state.connections = state.connections.filter((c) => c.id !== id);
  for (const agent of state.agents) if (agent.connectionId === id) agent.connectionId = null;
  for (const session of state.sessions) if (session.connectionId === id) session.connectionId = null;
  save();
}

/* ---------- agents ---------- */
const listAgents = () => state.agents;
const getAgent = (id) => state.agents.find((a) => a.id === id);
function addAgent(data) {
  const agent = { ...data, id: newId(), createdAt: Date.now() };
  state.agents.push(agent);
  save();
  return agent;
}
function updateAgent(id, data) {
  const agent = getAgent(id);
  if (!agent) return null;
  Object.assign(agent, data, { id, updatedAt: Date.now() });
  save();
  return agent;
}
function removeAgent(id) {
  state.agents = state.agents.filter((a) => a.id !== id);
  for (const session of state.sessions) if (session.agentId === id) session.agentId = null;
  save();
}

/* ---------- sessions ---------- */
const listSessions = () =>
  [...state.sessions].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
const getSession = (id) => state.sessions.find((s) => s.id === id);
function addSession(data) {
  const session = {
    id: newId(),
    title: data.title || "新会话",
    connectionId: data.connectionId || null,
    modelId: data.modelId || null,
    agentId: data.agentId || null,
    effort: data.effort || "default",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.sessions.push(session);
  save();
  return session;
}
function updateSession(id, data) {
  const session = getSession(id);
  if (!session) return null;
  Object.assign(session, data, { id, updatedAt: Date.now() });
  save();
  return session;
}
function removeSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  save();
}

export const store = {
  newId,
  save,
  listConnections,
  getConnection,
  addConnection,
  updateConnection,
  removeConnection,
  listAgents,
  getAgent,
  addAgent,
  updateAgent,
  removeAgent,
  listSessions,
  getSession,
  addSession,
  updateSession,
  removeSession,
};
