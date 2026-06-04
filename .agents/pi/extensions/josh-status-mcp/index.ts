import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_URL = process.env.PI_JOSH_STATUS_MCP_URL ?? "https://joshbeckman--5ffab9e262b911f09d000224a6c84d84.web.val.run/mcp";

const TOOL_DEFINITIONS = [
  {
    name: "get_status",
    description: "Get the latest status of Josh Beckman.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "get_age",
    description: "Get the age of Josh Beckman.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "get_about",
    description: "Get basic information about Josh Beckman.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "get_current_time_of_day",
    description: "Get the current time of day Josh Beckman is experiencing, including timezone, part of day, and season.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "compare_time_relative",
    description: "Get the relative time from now to a given timestamp in Josh Beckman's timezone.",
    parameters: Type.Object({ timestamp: Type.String({ format: "date-time" }) }, { additionalProperties: false }),
  },
  {
    name: "send_email_to_josh",
    description: "Send an email to Josh Beckman. The 'subject' is the email subject line to uniquely identify the topic. The 'body' is the email content in plain text (markdown syntax supported). The 'from' field should uniquely identify the sender (either an agent's handle or a human user's username/handle). The optional 'replyTo' field sets the reply-to email address for responses to have Josh respond directly rather than through this MCP server.",
    parameters: Type.Object({
      subject: Type.String(),
      body: Type.String(),
      from: Type.String({ minLength: 1, maxLength: 39, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$" }),
      replyTo: Type.Optional(Type.String({ format: "email" })),
    }, { additionalProperties: false }),
    sideEffect: true,
  },
  {
    name: "send_push_notification_to_josh",
    description: "Send a push notification to Josh Beckman. The 'title' is the notification title, and the 'body' is the notification content. The 'from' field should uniquely identify the sender (either an agent's handle or a human user's username/handle).",
    parameters: Type.Object({
      title: Type.String({ maxLength: 50 }),
      body: Type.String({ maxLength: 150 }),
      from: Type.String({ minLength: 1, maxLength: 39, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$" }),
      url: Type.Optional(Type.String({ format: "uri" })),
    }, { additionalProperties: false }),
    sideEffect: true,
  },
  {
    name: "read_josh_email_responses",
    description: "Read emails sent from Josh to you. The 'to' field should be the username of the recipient (either an agent's handle or a human user's username/handle). The 'body_contains' and 'subject_contains' fields are optional search strings to filter messages by content and subject.",
    parameters: Type.Object({
      to: Type.String({ minLength: 1, maxLength: 39, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$" }),
      body_contains: Type.Optional(Type.String()),
      subject_contains: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
  },
] as const;

const DEFAULT_TOOL_NAMES = new Set(TOOL_DEFINITIONS.filter((tool) => !("sideEffect" in tool && tool.sideEffect)).map((tool) => tool.name));

type JsonRpcResponse = { jsonrpc: "2.0"; id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type ToolDefinition = typeof TOOL_DEFINITIONS[number];

class HttpMcpClient {
  private nextId = 1;
  private initialized: Promise<void> | undefined;

  constructor(private readonly url: string, private readonly authorization: string | undefined) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-josh-status-mcp-extension", version: "0.2.0" } }, signal);
      try { await this.notify("notifications/initialized", {}, signal); } catch {}
    })();
    return this.initialized;
  }

  reset(): void { this.initialized = undefined; }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.start(signal);
    const result = await this.call("tools/list", {}, signal) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.start(signal);
    return this.call("tools/call", { name, arguments: args }, signal);
  }

  private async call(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal);
    if (response.error) throw new Error(response.error.message || `Josh Status MCP error ${response.error.code ?? "unknown"}`);
    return response.result;
  }

  private async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, signal);
  }

  private async post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = { "content-type": "application/json", "accept": "application/json, text/event-stream" };
    if (this.authorization) headers.authorization = this.authorization;
    const response = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(payload), signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Josh Status MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    if (!text.trim()) return { jsonrpc: "2.0" };
    return parseMcpResponse(text, response.headers.get("content-type") ?? "");
  }
}

function parseMcpResponse(text: string, contentType: string): JsonRpcResponse {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text) as JsonRpcResponse;
  for (const event of text.split(/\n\n+/)) {
    const data = event.split(/\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) return JSON.parse(data) as JsonRpcResponse;
  }
  throw new Error("Josh Status MCP returned an empty event stream");
}

function sanitizeToolName(name: string): string {
  return `josh_status_${name}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function allowedToolNames(): Set<string> | undefined {
  const raw = process.env.PI_JOSH_STATUS_MCP_TOOLS;
  if (raw === "*") return undefined;
  return new Set((raw ? raw.split(",") : [...DEFAULT_TOOL_NAMES]).map((s) => s.trim()).filter(Boolean));
}

function authorizationHeader(): string | undefined {
  const explicit = process.env.PI_JOSH_STATUS_MCP_AUTHORIZATION;
  if (explicit) return explicit;
  const token = process.env.PI_JOSH_STATUS_MCP_TOKEN;
  if (token) return `Bearer ${token}`;

  try {
    const claudeConfigPath = join(homedir(), ".claude.json");
    const config = JSON.parse(readFileSync(claudeConfigPath, "utf8")) as { mcpServers?: Record<string, { headers?: Record<string, string> }> };
    return config.mcpServers?.["josh-beckman-status"]?.headers?.Authorization;
  } catch {
    return undefined;
  }
}

function mcpResultToText(result: unknown): string {
  const r = result as { content?: Array<Record<string, unknown>>; structuredContent?: unknown };
  const parts: string[] = [];
  for (const item of r.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "image") parts.push("[image omitted]");
    else parts.push(JSON.stringify(item));
  }
  if (r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  if (parts.length === 0) parts.push(JSON.stringify(result, null, 2));
  return parts.join("\n");
}

export default function joshStatusMcpExtension(pi: ExtensionAPI) {
  const client = new HttpMcpClient(DEFAULT_URL, authorizationHeader());
  const allowed = allowedToolNames();
  const tools = TOOL_DEFINITIONS.filter((tool) => !allowed || allowed.has(tool.name));

  pi.registerCommand("josh-status-mcp-reload", {
    description: "Reconnect to Josh Status MCP",
    handler: async (_args, ctx) => {
      client.reset();
      ctx.ui.notify("Josh Status MCP reconnect requested; the next status tool call will reconnect", "info");
    },
  });

  for (const tool of tools) registerTool(pi, client, tool);

  pi.registerTool({
    name: "josh_status_mcp_tools",
    label: "Josh Status MCP Tools",
    description: "List Josh Status MCP tools registered in Pi",
    parameters: Type.Object({ live: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params, signal) {
      if ((params as { live?: boolean }).live === true) {
        const liveTools = await client.listTools(signal);
        return { content: [{ type: "text", text: liveTools.map((tool) => `${sanitizeToolName(tool.name)} — ${tool.description ?? tool.name}`).join("\n") }], details: { live: true, tools: liveTools } };
      }
      return { content: [{ type: "text", text: tools.map((tool) => `${sanitizeToolName(tool.name)} — ${tool.description}`).join("\n") }], details: { live: false, tools } };
    },
  });
}

function registerTool(pi: ExtensionAPI, client: HttpMcpClient, tool: ToolDefinition) {
  const name = sanitizeToolName(tool.name);
  const promptGuidelines = [`Use ${name} when determining Josh's current status, availability, location context, or current time/day.`];
  if ("sideEffect" in tool && tool.sideEffect) promptGuidelines.push(`Ask the user for explicit confirmation before using ${name}; it sends something to Josh outside this chat.`);
  pi.registerTool({
    name,
    label: `Josh Status: ${tool.name}`,
    description: `${tool.description} (lazy: connects on first use)`,
    promptSnippet: `${tool.description} (Josh Status MCP)`,
    promptGuidelines,
    parameters: tool.parameters as never,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Calling Josh Status MCP ${tool.name}...` }], details: {} });
      const result = await client.callTool(tool.name, params as Record<string, unknown>, signal);
      return { content: [{ type: "text", text: mcpResultToText(result) }], details: { mcpTool: tool.name, result } };
    },
  });
}
