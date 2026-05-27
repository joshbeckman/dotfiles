import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_COMMAND = process.env.PI_SHOPIFY_DEV_MCP_COMMAND ?? "pnpx";
const DEFAULT_ARGS = (process.env.PI_SHOPIFY_DEV_MCP_ARGS ?? "@shopify/dev-mcp@latest").split(" ").filter(Boolean);

const TOOL_DEFINITIONS = [
  {
    name: "learn_shopify_api",
    description: "Mandatory first step before using other Shopify Dev MCP tools. Loads API documentation context and returns a conversationId.",
    parameters: Type.Object({ api: Type.String(), conversationId: Type.Optional(Type.String()), model: Type.Optional(Type.String()), user_prompt: Type.Optional(Type.String()) }, { additionalProperties: true }),
  },
  {
    name: "search_docs_chunks",
    description: "Search shopify.dev documentation chunks for relevant docs and examples.",
    parameters: Type.Object({ conversationId: Type.String(), prompt: Type.String(), max_num_results: Type.Optional(Type.Number()), api_name: Type.Optional(Type.String()) }, { additionalProperties: true }),
  },
  {
    name: "validate_component_codeblocks",
    description: "Validate generated Shopify component JSX/TSX/web component code blocks against Shopify component APIs.",
    parameters: Type.Object({ conversationId: Type.String(), api: Type.String(), code: Type.Array(Type.Object({ content: Type.String(), artifactId: Type.Optional(Type.String()), revision: Type.Optional(Type.Number()) }, { additionalProperties: true })), extensionTarget: Type.Optional(Type.String()) }, { additionalProperties: true }),
  },
  {
    name: "validate_graphql_codeblocks",
    description: "Validate generated Shopify GraphQL operations against the selected Shopify GraphQL schema.",
    parameters: Type.Object({ conversationId: Type.String(), api: Type.Optional(Type.String()), codeblocks: Type.Array(Type.Object({ content: Type.String(), artifactId: Type.Optional(Type.String()), revision: Type.Optional(Type.Number()) }, { additionalProperties: true })) }, { additionalProperties: true }),
  },
  {
    name: "validate_theme",
    description: "Validate Liquid/theme files generated or updated inside a Shopify theme directory.",
    parameters: Type.Object({ conversationId: Type.String(), absoluteThemePath: Type.String(), filesCreatedOrUpdated: Type.Array(Type.Object({ path: Type.String(), artifactId: Type.Optional(Type.String()), revision: Type.Optional(Type.Number()) }, { additionalProperties: true })) }, { additionalProperties: true }),
  },
] as const;

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type ToolDefinition = typeof TOOL_DEFINITIONS[number];

class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private ready: Promise<void> | undefined;

  constructor(private readonly command: string, private readonly args: string[]) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      this.child = child;
      child.once("error", reject);
      child.once("spawn", () => resolve());
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (process.env.PI_SHOPIFY_DEV_MCP_DEBUG) process.stderr.write(`[shopify-dev-mcp] ${chunk}`);
      });
      child.once("exit", (code, sig) => {
        const error = new Error(`Shopify Dev MCP server exited (${sig ?? code ?? "unknown"})`);
        for (const { reject } of this.pending.values()) reject(error);
        this.pending.clear();
        this.child = undefined;
        this.ready = undefined;
      });
      signal?.addEventListener("abort", () => this.stop(), { once: true });
    });

    await this.ready;
    await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-shopify-dev-mcp-extension", version: "0.2.0" } }, signal);
    this.notify("notifications/initialized", {});
  }

  stop(): void {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    setTimeout(() => this.child?.kill("SIGKILL"), 1_000).unref?.();
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.start(signal);
    const result = await this.call("tools/list", {}, signal) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.start(signal);
    return this.call("tools/call", { name, arguments: args }, signal);
  }

  private call(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child) throw new Error("Shopify Dev MCP server is not running");
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const abort = () => { this.pending.delete(id); reject(new Error(`Shopify Dev MCP ${method} aborted`)); };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
      });
      child.stdin.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try { message = JSON.parse(line) as JsonRpcResponse; } catch { continue; }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `MCP error ${message.error.code ?? "unknown"}`));
      else pending.resolve(message.result);
    }
  }
}

function sanitizeToolName(name: string): string {
  return `shopify_dev_${name}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function allowedToolNames(): Set<string> | undefined {
  const raw = process.env.PI_SHOPIFY_DEV_MCP_TOOLS;
  if (!raw || raw === "*") return undefined;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
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

export default function shopifyDevMcpExtension(pi: ExtensionAPI) {
  const client = new StdioMcpClient(DEFAULT_COMMAND, DEFAULT_ARGS);
  const allowed = allowedToolNames();
  const tools = TOOL_DEFINITIONS.filter((tool) => !allowed || allowed.has(tool.name));

  pi.registerCommand("shopify-dev-mcp-reload", {
    description: "Reconnect to Shopify Dev MCP",
    handler: async (_args, ctx) => {
      client.stop();
      ctx.ui.notify("Shopify Dev MCP reconnect requested; the next Shopify Dev tool call will restart it", "info");
    },
  });

  for (const tool of tools) registerTool(pi, client, tool);

  pi.registerTool({
    name: "shopify_dev_mcp_tools",
    label: "Shopify Dev MCP Tools",
    description: "List Shopify Dev MCP tools registered in Pi",
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

function registerTool(pi: ExtensionAPI, client: StdioMcpClient, tool: ToolDefinition) {
  const name = sanitizeToolName(tool.name);
  pi.registerTool({
    name,
    label: `Shopify Dev: ${tool.name}`,
    description: `${tool.description} (lazy: starts Shopify Dev MCP on first use)`,
    promptSnippet: `${tool.description} (Shopify Dev MCP)`,
    parameters: tool.parameters as never,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Starting Shopify Dev MCP and calling ${tool.name}...` }], details: {} });
      const result = await client.callTool(tool.name, params as Record<string, unknown>, signal);
      return { content: [{ type: "text", text: mcpResultToText(result) }], details: { mcpTool: tool.name, result } };
    },
  });
}
