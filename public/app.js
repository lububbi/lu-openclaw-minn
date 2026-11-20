/* Mini Agent Lab 前端：会话为主体 + 模型连接分类 + Agent 测试 */

const state = {
  view: "chat",
  connections: [],
  agents: [],
  sessions: [],
  tools: [],
  session: null,
  connectionForm: null,
  connectionTest: null,
  agentForm: null,
  streaming: false,
  streamText: "",
  streamTools: [],
};

const main = document.getElementById("main");
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sel = (value, options) => options.map(([v, label]) => `<option value="${esc(v)}" ${value === v ? "selected" : ""}>${esc(label)}</option>`).join("");
const short = (s, n = 46) => (s || "").length > n ? s.slice(0, n) + "…" : s || "";
const fmtTime = (ts) => ts ? new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";

function md(text) {
  let s = esc(text ?? "");
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.replace(/^\n/, "")}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.split(/\n{2,}/).map((p) => (p.includes("<pre") ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`)).join("");
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function loadAll() {
  const [connections, agents, sessions, tools] = await Promise.all([
    api("/api/connections"), api("/api/agents"), api("/api/sessions"), api("/api/tools"),
  ]);
  state.connections = connections;
  state.agents = agents;
  state.sessions = sessions;
  state.tools = tools;
}

const connectionOf = (id) => state.connections.find((c) => c.id === id);
const agentName = (id) => state.agents.find((a) => a.id === id)?.name || "无";
function modelLabel(connId, modelId) {
  const c = connectionOf(connId);
  return `${c?.name || "未选分类"}${modelId ? " / " + modelId : ""}`;
}
const firstRef = () => {
  const c = state.connections.find((x) => x.modelIds?.length);
  return c ? { connectionId: c.id, modelId: c.modelIds[0] } : { connectionId: null, modelId: null };
};

/* =========================== 渲染入口 =========================== */
function render() {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  if (state.view === "chat") renderChat();
  else if (state.view === "connections") renderConnections();
  else if (state.view === "agents") renderAgents();
}

function setView(view) { state.view = view; render(); }

/* =========================== 会话（主体） =========================== */
function sessionPanelHtml() {
  const items = state.sessions.map((s) => `
    <div class="session-item ${s.id === state.session?.id ? "active" : ""}" data-action="session-open" data-id="${s.id}">
      <span class="s-ico">💬</span>
      <div class="s-body">
        <div class="s-title">${esc(s.title)}</div>
        <div class="s-meta">${fmtTime(s.updatedAt)} · ${(s.messages || []).length} 条</div>
      </div>
      <button class="s-del" data-action="session-delete" data-id="${s.id}" title="删除会话">×</button>
    </div>`).join("");
  return `<aside class="session-panel">
    <div class="session-panel-head"><strong>会话</strong>
      <button class="btn small ghost" data-action="session-new" title="新建会话">＋</button>
    </div>
    <div class="session-list">${items || '<div class="s-empty">暂无会话<br>点右上角 ＋ 新建</div>'}</div>
  </aside>`;
}

function modelOptions(s) {
  if (!state.connections.length) return '<option value="">（请先在「模型连接」添加）</option>';
  const current = `${s.connectionId || ""}::${s.modelId || ""}`;
  return state.connections.map((c) => {
    const models = c.modelIds || [];
    if (!models.length) return "";
    return `<optgroup label="${esc(c.name)}">${models.map((id) => {
      const v = `${c.id}::${id}`;
      return `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(id)}</option>`;
    }).join("")}</optgroup>`;
  }).join("");
}

function chatMetaHtml(s) {
  return `<span class="badge blue">${esc(modelLabel(s.connectionId, s.modelId))}</span>
    ${s.effort === "high" ? '<span class="badge yellow">High</span>' : ""}
    ${s.agentId ? `<span class="badge purple">🤖 ${esc(agentName(s.agentId))}</span>` : ""}`;
}

function hintText(s) {
  return `模型：${esc(modelLabel(s.connectionId, s.modelId))} · 力度 ${s.effort === "high" ? "High" : "default"} · Agent ${s.agentId ? esc(agentName(s.agentId)) : "无"} · 消息保存在本地`;
}

function toolBlock(t) {
  return `<details class="tool-call"><summary>🔧 ${esc(t.name)}</summary>
    <pre>参数：${esc(JSON.stringify(t.arguments || {}, null, 2))}\n返回：${esc(typeof t.content === "string" ? t.content : JSON.stringify(t.content))}</pre></details>`;
}

function messagesHtml(messages) {
  let html = "";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      html += `<div class="msg user"><div class="avatar">🧑</div><div class="msg-body"><div class="msg-name">你 · ${fmtTime(m.createdAt)}</div><div class="bubble">${md(m.content)}</div></div></div>`;
    } else if (m.role === "assistant") {
      const children = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") { children.push(messages[j]); j++; }
      const calls = (m.tool_calls || []).map((tc) => `<details class="tool-call"><summary>⚙️ 调用 ${esc(tc.name)}</summary><pre>${esc(JSON.stringify(tc.arguments || {}, null, 2))}</pre></details>`).join("");
      html += `<div class="msg"><div class="avatar">🐋</div><div class="msg-body"><div class="msg-name">助手 · ${fmtTime(m.createdAt)}</div>
        <div class="bubble">${md(m.content || "")}${calls}</div>${children.map(toolBlock).join("")}</div></div>`;
      i = j - 1;
    } else if (m.role === "tool") {
      html += `<div class="msg"><div class="avatar">🔧</div><div class="msg-body">${toolBlock(m)}</div></div>`;
    }
  }
  return html;
}

function scrollBottom() {
  const el = $("#messages");
  if (el) el.scrollTop = el.scrollHeight;
}

function renderChat() {
  const s = state.session;
  const streamingHtml = state.streaming ? `
    <div class="msg streaming" id="stream-msg"><div class="avatar">🐋</div><div class="msg-body">
      <div class="msg-name">助手（生成中）</div>
      <div class="bubble"><span id="stream-text">${esc(state.streamText)}</span><span class="cursor"></span></div>
      <div id="stream-tools"></div>
    </div></div>` : "";

  let chatMain;
  if (!s) {
    chatMain = `<div class="chat-main"><div class="chat-empty"><span>🐋</span><p>还没有会话，点左侧「＋」开始对话。</p></div></div>`;
  } else {
    chatMain = `<div class="chat-main">
      <div class="chat-topbar">
        <div class="chat-title">${esc(s.title)}</div>
        <div class="chat-meta" id="chat-meta">${chatMetaHtml(s)}</div>
      </div>
      <div class="messages" id="messages">${messagesHtml(s.messages || [])}${streamingHtml}</div>
      <div class="composer-wrap">
        <div class="composer">
          <div class="composer-tools">
            <label>模型 <select id="chat-model">${modelOptions(s)}</select></label>
            <label>力度 <select id="chat-effort">${sel(s.effort || "default", [["default", "default"], ["high", "High"]])}</select></label>
            <label>Agent <select id="chat-agent">${sel(s.agentId || "", [["", "无"], ...state.agents.map((a) => [a.id, a.name])])}</select></label>
          </div>
          <div class="composer-input-row">
            <textarea id="composer-input" rows="1" placeholder="发消息给模型，Enter 发送，Shift+Enter 换行"></textarea>
            <button class="btn primary send" id="send-btn" data-action="chat-send" ${state.streaming ? "disabled" : ""}>${state.streaming ? "···" : "↑"}</button>
          </div>
        </div>
        <div class="composer-hint" id="composer-hint">${hintText(s)}</div>
      </div>
    </div>`;
  }

  main.innerHTML = `<div class="chat-view">${sessionPanelHtml()}${chatMain}</div>`;
  scrollBottom();
}

function updateChatMeta() {
  const s = state.session;
  if (!s) return;
  const meta = $("#chat-meta");
  const hint = $("#composer-hint");
  if (meta) meta.innerHTML = chatMetaHtml(s);
  if (hint) hint.innerHTML = hintText(s);
}

/* =========================== 模型连接（分类） =========================== */
const PRESETS = {
  openai: { name: "OpenAI", apiType: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", modelIds: ["gpt-6", "gpt-5.6"] },
  deepseek: { name: "DeepSeek", apiType: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "", modelIds: ["deepseek-chat", "deepseek-reasoner"] },
  anthropic: { name: "Anthropic", apiType: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "", modelIds: ["claude-sonnet-4-6"] },
  ollama: { name: "Ollama 本地模型", apiType: "openai", baseUrl: "http://localhost:11434/v1", apiKey: "ollama", modelIds: ["llama3.2:latest"] },
  custom: { name: "", apiType: "openai", baseUrl: "", apiKey: "", modelIds: [""] },
};
const clonePreset = (key) => ({ ...PRESETS[key], modelIds: [...PRESETS[key].modelIds] });

function connectionFormHtml() {
  const f = state.connectionForm;
  if (!f) return "";
  const test = state.connectionTest?.key === "form" ? state.connectionTest : null;
  const rows = (f.modelIds || []).map((id, i) => `
    <div class="modelid-row">
      <input data-field="modelIds.${i}" value="${esc(id)}" placeholder="例如：gpt-6" />
      <button class="btn small ghost" data-action="modelid-remove" data-index="${i}" title="移除">×</button>
    </div>`).join("");
  return `
  <div class="card form-card">
    <div class="card-title">${f.id ? "编辑模型连接" : "新增模型连接"}</div>
    <div class="presets">
      ${Object.entries(PRESETS).map(([k, v]) => `<button class="btn small" data-action="preset" data-preset="${k}">${esc(v.name || "自定义")}</button>`).join("")}
    </div>
    <div class="form-grid">
      <div class="field"><label>分类名称</label><input data-field="name" value="${esc(f.name)}" placeholder="例如：OpenAI / 我的中转" /></div>
      <div class="field"><label>API 类型</label><select data-field="apiType">
        ${sel(f.apiType || "openai", [["openai", "OpenAI 兼容"], ["anthropic", "Anthropic Messages"]])}
      </select></div>
      <div class="field full"><label>模型链接 Base URL</label><input data-field="baseUrl" value="${esc(f.baseUrl)}" placeholder="https://api.example.com/v1" /></div>
      <div class="field"><label>API Key</label><input data-field="apiKey" type="password" value="${esc(f.apiKey)}" placeholder="本地模型可留空" /></div>
      <div class="field"><label>最大输出 tokens</label><input data-field="maxTokens" type="number" value="${esc(f.maxTokens || 4096)}" /></div>
      <div class="field full">
        <label>该分类下的模型 ID（可多个，聊天与会话中按分类分组显示）</label>
        ${rows}
        <button class="btn small ghost" data-action="modelid-add" style="align-self:flex-start">＋ 添加模型 ID</button>
      </div>
      <div class="field"><label>测试用模型</label><select data-field="testModel">
        ${sel(f.testModel, (f.modelIds || []).filter(Boolean).map((id) => [id, id]))}
      </select></div>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-action="connection-save">保存</button>
      <button class="btn" data-action="connection-test">测试连接</button>
      <button class="btn ghost" data-action="connection-cancel">取消</button>
      ${test ? `<span class="test-result ${test.ok ? "ok" : "fail"}">${test.ok ? "✓ " + esc(short(test.reply || "连接成功", 80)) : "✗ " + esc(short(test.error, 120))}</span>` : ""}
    </div>
  </div>`;
}

function renderConnections() {
  const cards = state.connections.length
    ? state.connections.map((c) => {
        const test = state.connectionTest?.key === c.id ? state.connectionTest : null;
        return `<div class="card"><div class="card-row">
          <div>
            <div class="card-title">🔌 ${esc(c.name)} <span class="badge ${c.apiType === "anthropic" ? "purple" : "blue"}">${c.apiType === "anthropic" ? "Anthropic" : "OpenAI 兼容"}</span></div>
            <div class="card-sub">${esc(c.baseUrl)} · 模型：${esc((c.modelIds || []).join("、") || "无")}</div>
            ${test ? `<div class="test-result ${test.ok ? "ok" : "fail"}">${test.ok ? "✓ " + esc(short(test.reply || "连接成功", 80)) : "✗ " + esc(short(test.error, 120))}</div>` : ""}
          </div>
          <div class="card-actions">
            <button class="btn small" data-action="connection-edit" data-id="${c.id}">编辑</button>
            <button class="btn small danger" data-action="connection-delete" data-id="${c.id}">删除</button>
          </div>
        </div></div>`;
      }).join("")
    : `<div class="empty"><span class="emoji">🔌</span>还没有模型连接。添加一个分类，并在其中填入可使用的模型 ID。</div>`;

  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>模型连接</h1><p>按分类管理连接，例如 OpenAI 下可包含 gpt-6、gpt-5.6；聊天框中按分类选择模型。</p></div>
      <button class="btn primary" data-action="connection-new">＋ 新增连接</button></div>
    ${connectionFormHtml()}
    ${cards}
  </div>`;
}

/* =========================== Agent =========================== */
function newAgentForm() {
  const ref = firstRef();
  return { id: null, name: "", description: "", systemPrompt: "", connectionId: ref.connectionId, modelId: ref.modelId, builtins: [], webhooks: [] };
}

function agentModelOptions(connectionId) {
  const c = connectionOf(connectionId);
  return sel("", (c?.modelIds || []).map((id) => [id, id]));
}

function agentFormHtml() {
  const a = state.agentForm;
  if (!a) return "";
  const builtins = state.tools.map((t) => `
    <label class="checkbox-pill" title="${esc(t.description)}">
      <input type="checkbox" data-builtin="${esc(t.name)}" ${a.builtins.includes(t.name) ? "checked" : ""} />${esc(t.name)}
    </label>`).join("");
  const webhooks = a.webhooks.map((w, i) => `
    <div class="webhook-row">
      <div class="webhook-head"><strong>Webhook 工具 #${i + 1}</strong>
        <div style="display:flex;gap:6px">
          <button class="btn small" data-action="tool-test" data-index="${i}">测试工具</button>
          <button class="btn small danger" data-action="webhook-remove" data-index="${i}">移除</button>
        </div>
      </div>
      <div class="webhook-grid">
        <div class="field"><label>工具名称</label><input data-field="webhooks.${i}.name" value="${esc(w.name)}" placeholder="get_weather" /></div>
        <div class="field"><label>请求 URL</label><input data-field="webhooks.${i}.url" value="${esc(w.url)}" placeholder="http://localhost:8080/tool" /></div>
        <div class="field full"><label>描述</label><input data-field="webhooks.${i}.description" value="${esc(w.description)}" /></div>
        <div class="field full"><label>参数 JSON Schema</label><textarea data-field="webhooks.${i}.parameters" style="min-height:90px">${esc(w.parameters)}</textarea></div>
      </div>
    </div>`).join("");

  return `
  <div class="card form-card">
    <div class="card-title">${a.id ? "编辑 Agent" : "新增 Agent"}</div>
    <div class="form-grid">
      <div class="field"><label>名称</label><input data-field="name" value="${esc(a.name)}" /></div>
      <div class="field"><label>描述</label><input data-field="description" value="${esc(a.description)}" /></div>
      <div class="field"><label>绑定分类</label><select data-field="connectionId">
        ${sel(a.connectionId || "", [["", "（不绑定）"], ...state.connections.map((c) => [c.id, c.name])])}
      </select></div>
      <div class="field"><label>模型</label><select data-field="modelId">
        ${sel(a.modelId || "", [["", "（选择模型）"], ...(connectionOf(a.connectionId)?.modelIds || []).map((id) => [id, id])])}
      </select></div>
      <div class="field full"><label>系统提示词 (System Prompt)</label><textarea class="prompt" data-field="systemPrompt" placeholder="你是一个……">${esc(a.systemPrompt)}</textarea></div>
    </div>
    <div style="margin-top:18px"><div class="card-title" style="margin-bottom:10px">内置工具</div>
      <div class="checkbox-list">${builtins || '<span class="hint">暂无内置工具</span>'}</div></div>
    <div style="margin-top:18px">
      <div class="card-row" style="margin-bottom:4px"><div class="card-title">自定义工具 (Webhook)</div>
        <button class="btn small" data-action="webhook-add">＋ 添加工具</button></div>
      <div class="hint">模型调用工具时，后端将参数 JSON POST 到你填写的 URL，并把返回值交给模型。</div>
      ${webhooks}
    </div>
    <div class="form-actions">
      <button class="btn primary" data-action="agent-save">保存</button>
      <button class="btn ghost" data-action="agent-cancel">取消</button>
    </div>
  </div>`;
}

function renderAgents() {
  const cards = state.agents.length
    ? state.agents.map((a) => `<div class="card"><div class="card-row">
        <div>
          <div class="card-title">🤖 ${esc(a.name)} <span class="badge blue">${esc(modelLabel(a.connectionId, a.modelId))}</span></div>
          <div class="card-sub">${esc(a.description || "无描述")} · ${(a.tools || []).length} 个工具 · ${esc(short(a.systemPrompt, 60))}</div>
        </div>
        <div class="card-actions">
          <button class="btn small primary" data-action="agent-chat" data-id="${a.id}">对话测试</button>
          <button class="btn small" data-action="agent-edit" data-id="${a.id}">编辑</button>
          <button class="btn small danger" data-action="agent-delete" data-id="${a.id}">删除</button>
        </div>
      </div></div>`).join("")
    : `<div class="empty"><span class="emoji">🤖</span>还没有 Agent。配置系统提示词与工具后，即可开会话测试。</div>`;

  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Agent 测试</h1><p>定义系统提示词 + 工具，一键开启会话测试你的 Agent。</p></div>
      <button class="btn primary" data-action="agent-new">＋ 新增 Agent</button></div>
    ${agentFormHtml()}
    ${cards}
  </div>`;
}

/* =========================== 动作 =========================== */
async function openSession(id) {
  const s = await api(`/api/sessions/${id}`);
  state.session = s;
  state.streaming = false;
  setView("chat");
}

async function newSession() {
  const ref = firstRef();
  const s = await api("/api/sessions", { method: "POST", body: { title: "新会话", ...ref, agentId: null, effort: "default" } });
  await loadAll();
  await openSession(s.id);
}

async function updateCurrentSession(patch) {
  if (!state.session) return;
  try {
    state.session = await api(`/api/sessions/${state.session.id}`, { method: "PUT", body: patch });
    updateChatMeta();
  } catch (e) { toast(e.message); }
}

async function saveConnection() {
  const f = state.connectionForm;
  const modelIds = (f.modelIds || []).map((x) => String(x).trim()).filter(Boolean);
  if (!f.name?.trim() || !f.baseUrl?.trim() || !modelIds.length) return toast("请填写分类名称、Base URL 与至少一个模型 ID");
  const payload = { name: f.name.trim(), apiType: f.apiType, baseUrl: f.baseUrl.trim(), apiKey: f.apiKey || "", modelIds, maxTokens: Number(f.maxTokens) || 4096 };
  try {
    await api(f.id ? `/api/connections/${f.id}` : "/api/connections", { method: f.id ? "PUT" : "POST", body: payload });
    state.connectionForm = null; state.connectionTest = null;
    await loadAll(); render(); toast("连接已保存");
  } catch (e) { toast(e.message); }
}

async function testConnection(config, key) {
  const modelIds = (config.modelIds || []).map((x) => String(x).trim()).filter(Boolean);
  if (!config.baseUrl?.trim() || !modelIds.length) return toast("请填写 Base URL 与至少一个模型 ID");
  state.connectionTest = { key, pending: true }; render();
  try {
    const r = await api("/api/connections/test", { method: "POST", body: { ...config, baseUrl: config.baseUrl.trim(), modelIds, modelId: config.testModel || modelIds[0] } });
    state.connectionTest = r.ok ? { key, ok: true, reply: r.reply } : { key, ok: false, error: r.error };
  } catch (e) {
    state.connectionTest = { key, ok: false, error: e.message };
  }
  render();
}

function agentFromForm() {
  const a = state.agentForm;
  const tools = [
    ...a.builtins.map((name) => ({ type: "builtin", name })),
    ...a.webhooks.filter((w) => w.name?.trim() && w.url?.trim()).map((w) => {
      let parameters = { type: "object", properties: {}, required: [] };
      try { if (w.parameters?.trim()) parameters = JSON.parse(w.parameters); } catch { /* 用默认值 */ }
      return { type: "webhook", name: w.name.trim(), url: w.url.trim(), description: w.description || "", parameters };
    }),
  ];
  return { name: a.name.trim(), description: a.description || "", systemPrompt: a.systemPrompt || "", connectionId: a.connectionId || null, modelId: a.modelId || null, tools };
}

async function saveAgent() {
  const a = state.agentForm;
  if (!a.name?.trim()) return toast("请填写 Agent 名称");
  try {
    await api(a.id ? `/api/agents/${a.id}` : "/api/agents", { method: a.id ? "PUT" : "POST", body: agentFromForm() });
    state.agentForm = null;
    await loadAll(); render(); toast("Agent 已保存");
  } catch (e) { toast(e.message); }
}

async function sendChat() {
  if (state.streaming || !state.session) return;
  const input = $("#composer-input");
  const text = input?.value.trim();
  if (!text) return;
  input.value = "";
  state.streaming = true; state.streamText = ""; state.streamTools = [];
  const btn = $("#send-btn"); if (btn) { btn.disabled = true; btn.textContent = "···"; }
  $("#messages").insertAdjacentHTML("beforeend", `<div class="msg streaming" id="stream-msg"><div class="avatar">🐋</div><div class="msg-body">
    <div class="msg-name">助手（生成中）</div><div class="bubble"><span id="stream-text"></span><span class="cursor"></span></div><div id="stream-tools"></div></div></div>`);
  scrollBottom();

  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: state.session.id, content: text }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "请求失败"); }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === "delta") {
          state.streamText += ev.text || "";
          const el = $("#stream-text"); if (el) el.textContent = state.streamText;
          scrollBottom();
        } else if (ev.type === "tool") {
          state.streamTools.push(ev);
          const box = $("#stream-tools");
          if (box) box.insertAdjacentHTML("beforeend", `<details class="tool-call"><summary>⚙️ 调用 ${esc(ev.name)}</summary><pre>${esc(JSON.stringify(ev.arguments || {}, null, 2))}\n返回：${esc(short(String(ev.output), 300))}</pre></details>`);
          scrollBottom();
        } else if (ev.type === "error") {
          toast("模型错误：" + ev.message);
        }
      }
    }
  } catch (e) {
    toast("发送失败：" + e.message);
  } finally {
    state.streaming = false;
    await openSession(state.session.id);
    await loadAll();
  }
}

/* =========================== 事件绑定 =========================== */
$("#nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (btn) setView(btn.dataset.view);
});

main.addEventListener("input", (e) => {
  const f = e.target.dataset.field;
  if (!f) return;
  if (state.view === "connections" && state.connectionForm) {
    if (f.startsWith("modelIds.")) state.connectionForm.modelIds[Number(f.split(".")[1])] = e.target.value;
    else state.connectionForm[f] = e.target.value;
  } else if (state.view === "agents" && state.agentForm) {
    if (f.startsWith("webhooks.")) {
      const [, i, key] = f.split(".");
      state.agentForm.webhooks[Number(i)][key] = e.target.value;
    } else state.agentForm[f] = e.target.value;
  }
});

main.addEventListener("change", async (e) => {
  if (e.target.dataset.builtin && state.agentForm) {
    const name = e.target.dataset.builtin;
    if (e.target.checked && !state.agentForm.builtins.includes(name)) state.agentForm.builtins.push(name);
    if (!e.target.checked) state.agentForm.builtins = state.agentForm.builtins.filter((n) => n !== name);
  }
  if (e.target.dataset.field === "connectionId" && state.agentForm) {
    state.agentForm.modelId = connectionOf(e.target.value)?.modelIds?.[0] || "";
    render();
  }
  if (!state.session) return;
  if (e.target.id === "chat-model") {
    const [connectionId, modelId] = e.target.value.split("::");
    await updateCurrentSession({ connectionId, modelId });
  } else if (e.target.id === "chat-effort") {
    await updateCurrentSession({ effort: e.target.value });
  } else if (e.target.id === "chat-agent") {
    await updateCurrentSession({ agentId: e.target.value || null });
  }
});

main.addEventListener("keydown", (e) => {
  if (e.target.id === "composer-input" && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault(); sendChat();
  }
});

main.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;
  switch (action) {
    case "session-new": await newSession(); break;
    case "session-open": await openSession(id); break;
    case "session-delete":
      if (confirm("删除这个会话？")) { await api(`/api/sessions/${id}`, { method: "DELETE" }); await loadAll(); if (state.session?.id === id) { state.session = state.sessions[0] ? await api(`/api/sessions/${state.sessions[0].id}`) : null; } render(); toast("已删除"); }
      break;
    case "chat-send": await sendChat(); break;

    case "preset": state.connectionForm = clonePreset(el.dataset.preset); state.connectionTest = null; render(); break;
    case "connection-new": state.connectionForm = clonePreset("custom"); state.connectionTest = null; render(); break;
    case "connection-edit": state.connectionForm = { ...connectionOf(id), modelIds: [...(connectionOf(id).modelIds || [])], testModel: connectionOf(id).modelIds?.[0] }; state.connectionTest = null; render(); break;
    case "connection-cancel": state.connectionForm = null; state.connectionTest = null; render(); break;
    case "connection-save": await saveConnection(); break;
    case "connection-test": await testConnection(state.connectionForm, "form"); break;
    case "modelid-add": state.connectionForm.modelIds.push(""); render(); break;
    case "modelid-remove": state.connectionForm.modelIds.splice(Number(el.dataset.index), 1); render(); break;
    case "connection-delete":
      if (confirm("删除这个连接分类？")) { await api(`/api/connections/${id}`, { method: "DELETE" }); await loadAll(); render(); toast("已删除"); }
      break;

    case "agent-new": state.agentForm = newAgentForm(); render(); break;
    case "agent-edit": {
      const a = state.agents.find((x) => x.id === id);
      state.agentForm = { id: a.id, name: a.name, description: a.description || "", systemPrompt: a.systemPrompt || "", connectionId: a.connectionId || "", modelId: a.modelId || "", builtins: (a.tools || []).filter((t) => t.type === "builtin").map((t) => t.name), webhooks: (a.tools || []).filter((t) => t.type === "webhook").map((t) => ({ name: t.name, url: t.url, description: t.description || "", parameters: JSON.stringify(t.parameters || {}, null, 2) })) };
      render(); break;
    }
    case "agent-cancel": state.agentForm = null; render(); break;
    case "agent-save": await saveAgent(); break;
    case "webhook-add":
      state.agentForm.webhooks.push({ name: "", url: "", description: "", parameters: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}' });
      render(); break;
    case "webhook-remove": state.agentForm.webhooks.splice(Number(el.dataset.index), 1); render(); break;
    case "tool-test": {
      const w = state.agentForm.webhooks[Number(el.dataset.index)];
      let parameters = {}; try { parameters = JSON.parse(w.parameters || "{}"); } catch {}
      try {
        const r = await api("/api/tools/test", { method: "POST", body: { tool: { type: "webhook", name: w.name, url: w.url, description: w.description, parameters }, input: {} } });
        toast(r.ok ? "✓ 工具返回：" + short(String(r.output), 100) : "✗ " + r.error);
      } catch (err) { toast(err.message); }
      break;
    }
    case "agent-chat": {
      const a = state.agents.find((x) => x.id === id);
      if (!a) return;
      if (!a.connectionId || !a.modelId) return toast("该 Agent 未绑定模型，请先编辑");
      const s = await api("/api/sessions", { method: "POST", body: { title: `${a.name} · 测试`, connectionId: a.connectionId, modelId: a.modelId, agentId: a.id, effort: "default" } });
      await loadAll(); await openSession(s.id);
      break;
    }
    case "agent-delete":
      if (confirm("删除这个 Agent？")) { await api(`/api/agents/${id}`, { method: "DELETE" }); await loadAll(); render(); toast("已删除"); }
      break;
  }
});

/* =========================== 启动 =========================== */
(async () => {
  try {
    await loadAll();
    if (state.sessions.length) {
      await openSession(state.sessions[0].id);
    } else {
      const ref = firstRef();
      if (ref.connectionId) {
        const s = await api("/api/sessions", { method: "POST", body: { title: "新会话", ...ref, agentId: null, effort: "default" } });
        await loadAll();
        await openSession(s.id);
      } else {
        setView("chat");
      }
    }
  } catch (e) {
    main.innerHTML = `<div class="page"><div class="empty">加载失败：${esc(e.message)}<br>请确认后端服务已启动。</div></div>`;
  }
})();
