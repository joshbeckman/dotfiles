import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_URL = process.env.PI_JOSH_NOTES_MCP_URL ?? "https://joshbeckman--1818d72637f311f089f39e149126039e.web.val.run/mcp";
const DEFAULT_ALLOWED_TOOLS = ["search_posts", "get_post", "get_proverbs"];

type JsonRpcResponse = { jsonrpc: "2.0"; id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

class HttpMcpClient {
  private nextId = 1;
  private initialized: Promise<void> | undefined;

  constructor(private readonly url: string) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      await this.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-josh-notes-mcp-extension", version: "0.1.0" },
      }, signal);
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
    if (response.error) throw new Error(response.error.message || `Josh Notes MCP error ${response.error.code ?? "unknown"}`);
    return response.result;
  }

  private async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, signal);
  }

  private async post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Josh Notes MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
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
  throw new Error("Josh Notes MCP returned an empty event stream");
}

function sanitizeToolName(name: string): string {
  return `notes_${name}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function allowedToolNames(): Set<string> | undefined {
  const raw = process.env.PI_JOSH_NOTES_MCP_TOOLS;
  if (raw === "*") return undefined;
  return new Set((raw ? raw.split(",") : DEFAULT_ALLOWED_TOOLS).map((s) => s.trim()).filter(Boolean));
}

function schemaFor(tool: McpTool) {
  const schema = tool.inputSchema;
  if (schema && schema.type === "object") return schema as never;
  return Type.Object({}, { additionalProperties: true }) as never;
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

export default async function joshNotesMcpExtension(pi: ExtensionAPI) {
  const client = new HttpMcpClient(DEFAULT_URL);
  const allowed = allowedToolNames();

  pi.registerCommand("josh-notes-mcp-reload", {
    description: "Reconnect to Josh Notes MCP and refresh tools",
    handler: async (_args, ctx) => {
      client.reset();
      ctx.ui.notify("Josh Notes MCP reconnect requested; run /reload if tools changed", "info");
    },
  });

  let tools: McpTool[] = [];
  try {
    tools = (await client.listTools()).filter((tool) => !allowed || allowed.has(tool.name));
  } catch (error) {
    pi.registerTool({
      name: "notes_mcp_status",
      label: "Josh Notes MCP Status",
      description: "Report why Josh Notes MCP tools failed to load",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: `Josh Notes MCP failed to initialize: ${error instanceof Error ? error.message : String(error)}` }], details: { error: String(error) } };
      },
    });
    return;
  }

  for (const tool of tools) {
    const name = sanitizeToolName(tool.name);
    pi.registerTool({
      name,
      label: `Notes: ${tool.name}`,
      description: tool.description || `Call Josh Notes MCP tool ${tool.name}`,
      promptSnippet: `${tool.description || `Call Josh Notes MCP ${tool.name}`} (Josh Notes MCP)`,
      promptGuidelines: [`Use ${name} when the user asks about Josh's notes, blog posts, proverbs, or personal published writing.`],
      parameters: schemaFor(tool),
      async execute(_toolCallId, params, signal, onUpdate) {
        onUpdate?.({ content: [{ type: "text", text: `Calling Josh Notes MCP ${tool.name}...` }], details: {} });
        const result = await client.callTool(tool.name, params as Record<string, unknown>, signal);
        return { content: [{ type: "text", text: mcpResultToText(result) }], details: { mcpTool: tool.name, result } };
      },
    });
  }
}
