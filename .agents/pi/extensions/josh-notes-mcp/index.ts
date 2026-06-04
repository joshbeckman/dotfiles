import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_URL = process.env.PI_JOSH_NOTES_MCP_URL ?? "https://joshbeckman--1818d72637f311f089f39e149126039e.web.val.run/mcp";

const TOOL_DEFINITIONS = [
  {
    name: "search_posts",
    description: "Search for posts on the site, filtering by various metadata and attributes.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ default: 3, minimum: 1, maximum: 10 })),
      excludePostUrls: Type.Optional(Type.Array(Type.String())),
      tag: Type.Optional(Type.String()),
      startDate: Type.Optional(Type.String()),
      endDate: Type.Optional(Type.String()),
      author_id: Type.Optional(Type.String()),
      book: Type.Optional(Type.String()),
      category: Type.Optional(Type.Union([Type.Literal("blog"), Type.Literal("notes"), Type.Literal("exercise"), Type.Literal("replies"), Type.Literal("page")])),
    }, { additionalProperties: false }),
  },
  {
    name: "get_post",
    description: "Get the full content and metadata of a specific post by URL.",
    parameters: Type.Object({ url: Type.String() }, { additionalProperties: false }),
  },
  {
    name: "get_proverbs",
    description: "Retrieve Josh's favorite proverbs.",
    parameters: Type.Object({ limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  },
  {
    name: "get_sequences",
    description: "Retrieve post sequences from the site. Sequences are groups of related posts that link, one to the next, forming a chain of thought on a tag.",
    parameters: Type.Object({ limit: Type.Optional(Type.Number()), tag: Type.Optional(Type.String()) }, { additionalProperties: false }),
  },
  {
    name: "get_sequence",
    description: "Retrieve a specific post sequence by its ID.",
    parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
  },
  {
    name: "search_tags",
    description: "Search for tags used on the site.",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  },
  {
    name: "get_tag_urls",
    description: "Get the URLs of provided tags.",
    parameters: Type.Object({ tags: Type.Array(Type.String()) }, { additionalProperties: false }),
  },
  {
    name: "get_tags",
    description: "Get a list of all tags used on the site.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
] as const;

const DEFAULT_TOOL_NAMES = new Set(["search_posts", "get_post", "get_proverbs"]);

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
      await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-josh-notes-mcp-extension", version: "0.2.0" } }, signal);
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
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" }, body: JSON.stringify(payload), signal });
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
  return new Set((raw ? raw.split(",") : [...DEFAULT_TOOL_NAMES]).map((s) => s.trim()).filter(Boolean));
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

export default function joshNotesMcpExtension(pi: ExtensionAPI) {
  const client = new HttpMcpClient(DEFAULT_URL);
  const allowed = allowedToolNames();
  const tools = TOOL_DEFINITIONS.filter((tool) => !allowed || allowed.has(tool.name));

  pi.registerCommand("josh-notes-mcp-reload", {
    description: "Reconnect to Josh Notes MCP",
    handler: async (_args, ctx) => {
      client.reset();
      ctx.ui.notify("Josh Notes MCP reconnect requested; the next notes tool call will reconnect", "info");
    },
  });

  for (const tool of tools) registerTool(pi, client, tool);

  pi.registerTool({
    name: "notes_mcp_tools",
    label: "Josh Notes MCP Tools",
    description: "List Josh Notes MCP tools registered in Pi",
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
    label: `Notes: ${tool.name}`,
    description: `${tool.description} (lazy: connects on first use)`,
    promptSnippet: `${tool.description} (Josh Notes MCP)`,
    promptGuidelines: [`Use ${name} when the user asks about Josh's notes, blog posts, proverbs, or personal published writing.`],
    parameters: tool.parameters as never,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Calling Josh Notes MCP ${tool.name}...` }], details: {} });
      const result = await client.callTool(tool.name, params as Record<string, unknown>, signal);
      return { content: [{ type: "text", text: mcpResultToText(result) }], details: { mcpTool: tool.name, result } };
    },
  });
}
