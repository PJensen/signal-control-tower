import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { queueSignalDelivery } from "./signal-delivery.ts";

interface McpConfig {
  host: string;
  port: number;
  stateDirectory: string;
  workspace: string;
}
interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value?: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("MCP-Protocol-Version", "2025-11-25");
  response.end(value === undefined ? undefined : JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<string> {
  let output = "";
  for await (const chunk of request) output += String(chunk);
  if (output.length > 1_000_000) throw new Error("MCP request is too large.");
  return output;
}
function result(id: Rpc["id"], value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: value };
}
function error(id: Rpc["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function startMcpServer(config: McpConfig): Promise<Server> {
  const server = createServer(async (request, response) => {
    let requestId: Rpc["id"];
    if (request.method !== "POST" || request.url !== "/mcp") {
      json(response, 404, { error: "MCP endpoint is POST /mcp" });
      return;
    }
    try {
      const message = JSON.parse(await body(request)) as Rpc;
      requestId = message.id;
      if (message.jsonrpc !== "2.0" || !message.method) {
        throw new Error("Invalid JSON-RPC request.");
      }
      if (
        message.method === "notifications/initialized" ||
        message.method === "notifications/cancelled"
      ) {
        json(response, 202);
        return;
      }
      if (message.method === "initialize") {
        json(
          response,
          200,
          result(message.id, {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "signal-control-tower", version: "0.0.0" },
            instructions:
              "Use signal_send_message or signal_send_file to queue outbound Signal deliveries.",
          }),
        );
        return;
      }
      if (message.method === "tools/list") {
        json(
          response,
          200,
          result(message.id, {
            tools: [
              {
                name: "signal_send_message",
                description: "Queue a message for the configured Signal group.",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" }, title: { type: "string" } },
                  required: ["text"],
                },
              },
              {
                name: "signal_send_file",
                description: "Queue a workspace file for the configured Signal group.",
                inputSchema: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    message: { type: "string" },
                    title: { type: "string" },
                  },
                  required: ["path"],
                },
              },
              {
                name: "signal_outbox_status",
                description: "Return the configured Signal destination and workspace.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }),
        );
        return;
      }
      if (message.method !== "tools/call") {
        json(response, 200, error(message.id, -32601, `Unsupported method: ${message.method}`));
        return;
      }
      const params = message.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object"
        ? params.arguments as Record<string, unknown>
        : {};
      if (name === "signal_send_message") {
        if (typeof args.text !== "string") throw new Error("text is required");
        const queued = await queueSignalDelivery(
          config.stateDirectory,
          args.text,
          typeof args.title === "string" ? args.title : undefined,
        );
        json(
          response,
          200,
          result(message.id, {
            content: [{ type: "text", text: `Queued Signal delivery ${queued.id}` }],
            structuredContent: queued,
          }),
        );
        return;
      }
      if (name === "signal_send_file") {
        if (typeof args.path !== "string") throw new Error("path is required");
        const workspace = await realpath(config.workspace);
        const file = await realpath(
          isAbsolute(args.path) ? args.path : `${workspace}/${args.path}`,
        );
        const within = relative(workspace, file);
        if (
          !within || within === ".." ||
          within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)
        ) throw new Error("Attachment path must stay inside the workspace.");
        const queued = await queueSignalDelivery(
          config.stateDirectory,
          typeof args.message === "string" ? args.message : `Attached file: ${within}`,
          typeof args.title === "string" ? args.title : undefined,
          file,
        );
        json(
          response,
          200,
          result(message.id, {
            content: [{ type: "text", text: `Queued Signal delivery ${queued.id}` }],
            structuredContent: queued,
          }),
        );
        return;
      }
      if (name === "signal_outbox_status") {
        json(
          response,
          200,
          result(message.id, {
            content: [{ type: "text", text: `Signal outbox active for ${config.workspace}` }],
          }),
        );
        return;
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (caught) {
      json(
        response,
        200,
        error(requestId, -32602, caught instanceof Error ? caught.message : String(caught)),
      );
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
