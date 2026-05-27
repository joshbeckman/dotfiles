import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_URL = process.env.PI_JOSH_STATUS_MCP_URL ?? "https://joshbeckman--5ffab9e262b911f09d000224a6c84d84.web.val.run/mcp";

const TOOL_DEFINITIONS = [
  {
    name: "get_status",
    description: "Get Josh's current status, availability, and location context.",
    parameters: Type.Object({}, { additionalProperties: true }),
  },
  {
    name: "get_current_time_of_day",
    description: "Get Josh's current time of day / date context.",
    parameters: Type.Object({}, { additionalProperties: true }),
  },
] as const;

type JsonRpcResponse = { jsonrpc: "2.0"; id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type ToolDefinition = typeof TOOL_DEFINITIONS[number];

class HttpMcpClient {
  private nextId = 1;
  private initialized: Promise<void> | undefined;

  constructor(private readonly url: string) {}

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
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" }, body: JSON.stringify(payload), signal });
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
  return new Set((raw ? raw.split(",") : TOOL_DEFINITIONS.map((tool) => tool.name)).map((s) => s.trim()).filter(Boolean));
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
  const client = new HttpMcpClient(DEFAULT_URL);
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
  pi.registerTool({
    name,
    label: `Josh Status: ${tool.name}`,
    description: `${tool.description} (lazy: connects on first use)`,
    promptSnippet: `${tool.description} (Josh Status MCP)`,
    promptGuidelines: [`Use ${name} when determining Josh's current status, availability, location context, or current time/day.`],
    parameters: tool.parameters as never,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Calling Josh Status MCP ${tool.name}...` }], details: {} });
      const result = await client.callTool(tool.name, params as Record<string, unknown>, signal);
      return { content: [{ type: "text", text: mcpResultToText(result) }], details: { mcpTool: tool.name, result } };
    },
  });
}
