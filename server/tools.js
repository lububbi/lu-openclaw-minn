/**
 * 工具注册表：内置工具 + Agent 自定义 Webhook 工具。
 * 工具定义以 provider 无关的中间格式保存，由 llm.js 转换成具体的 API 格式。
 */

const BUILTINS = {
  get_time: {
    name: "get_time",
    description: "获取当前日期和时间。可指定 IANA 时区（如 Asia/Shanghai、UTC）。",
    parameters: {
      type: "object",
      properties: {
        timeZone: { type: "string", description: "IANA 时区名称，留空则使用服务器本地时区" },
      },
      required: [],
    },
    async execute(args = {}) {
      const opts = { dateStyle: "full", timeStyle: "long" };
      if (args.timeZone) opts.timeZone = args.timeZone;
      try {
        return new Intl.DateTimeFormat("zh-CN", opts).format(new Date());
      } catch {
        return new Date().toISOString();
      }
    },
  },

  calculator: {
    name: "calculator",
    description: "计算一个基础算术表达式，支持 + - * / ( ) 与小数。例如 (12+8)*3/2。",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "待计算的算术表达式" },
      },
      required: ["expression"],
    },
    async execute(args = {}) {
      const expr = String(args.expression ?? "").trim();
      if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
        throw new Error("表达式包含不允许的字符，仅支持数字与 + - * / ( ) . 和空格");
      }
      // 字符集已严格限制，Function 仅做四则运算求值。
      const value = Function(`"use strict"; return (${expr});`)();
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("计算结果无效");
      }
      return String(value);
    },
  },

  echo: {
    name: "echo",
    description: "原样返回输入内容，用于测试工具调用链路是否打通。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要原样返回的文本" },
      },
      required: ["text"],
    },
    async execute(args = {}) {
      return String(args.text ?? "");
    },
  },
};

export function listBuiltinTools() {
  return Object.values(BUILTINS).map((t) => ({
    type: "builtin",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** 把 agent 储存的工具描述解析成 {name, description, parameters, execute, type, source} */
function resolveTool(tool) {
  if (!tool || !tool.name) return null;
  if (tool.type === "webhook") {
    if (!tool.url) return null;
    return {
      type: "webhook",
      name: tool.name,
      description: tool.description || "调用外部 HTTP 服务",
      parameters: tool.parameters || { type: "object", properties: {}, required: [] },
      async execute(args) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(tool.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args),
            signal: controller.signal,
          });
          const text = await res.text();
          let payload = text;
          try {
            payload = JSON.parse(text);
          } catch {
            /* 非 JSON 直接当文本返回 */
          }
          if (!res.ok) throw new Error(`Webhook ${res.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
          return typeof payload === "string" ? payload : JSON.stringify(payload);
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
  const builtin = BUILTINS[tool.name];
  if (!builtin) return null;
  return { type: "builtin", ...builtin };
}

export function resolveTools(toolDescriptors = []) {
  return toolDescriptors.map(resolveTool).filter(Boolean);
}

export function toolDefinitions(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export function findTool(tools, name) {
  return tools.find((t) => t.name === name);
}

export async function executeTool(tool, args) {
  if (!tool) throw new Error(`未找到工具定义`);
  return await tool.execute(args ?? {});
}

export async function testTool(toolDescriptor, input) {
  const tool = resolveTool(toolDescriptor);
  if (!tool) throw new Error("工具配置无效");
  return await executeTool(tool, input);
}
