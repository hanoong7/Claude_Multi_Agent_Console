#!/usr/bin/env node
// Minimal stdio MCP server that exposes ONE tool — `request_permission` —
// which Claude Code calls (via --permission-prompt-tool) whenever it needs
// the user to approve a tool invocation. The decision is forwarded to the
// main app server's HTTP /permission endpoint, which surfaces a modal in
// the UI and waits for the user's click before responding.
//
// Spawned by Claude Code; speaks JSON-RPC 2.0 over stdin/stdout.
//
// Env:
//   PERMISSION_MAIN_URL  e.g. "http://localhost:8787"   (required)
//   PERMISSION_SESSION_ID                              (optional — for routing)

import readline from "node:readline";
import { randomUUID } from "node:crypto";

const MAIN_URL = process.env.PERMISSION_MAIN_URL || "http://localhost:8787";
const SESSION_ID = process.env.PERMISSION_SESSION_ID || "";

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function replyError(id, message, code = -32000) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOL = {
  name: "request_permission",
  description:
    "Ask the user whether the agent should be allowed to perform a specific tool action.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
    },
    required: ["tool_name"],
    additionalProperties: true,
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "permission-prompt", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized") {
    return; // no reply
  }
  if (method === "tools/list") {
    reply(id, { tools: [TOOL] });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name !== TOOL.name) {
      return replyError(id, `Unknown tool: ${name}`);
    }
    const args = params?.arguments || {};
    const reqId = randomUUID();
    try {
      const res = await fetch(`${MAIN_URL}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: reqId,
          sessionId: SESSION_ID,
          tool: args.tool_name || "",
          input: args.input || {},
        }),
      });
      if (!res.ok) {
        return reply(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                behavior: "deny",
                message: `permission proxy returned ${res.status}`,
              }),
            },
          ],
        });
      }
      const data = await res.json();
      const behavior = data.approved ? "allow" : "deny";
      const payload = {
        behavior,
        message:
          behavior === "deny"
            ? data.reason || "사용자가 거부했습니다."
            : undefined,
        // Claude Code's permission-prompt-tool expects updatedInput on allow
        updatedInput: behavior === "allow" ? args.input || {} : undefined,
      };
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      });
    } catch (e) {
      reply(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              behavior: "deny",
              message: `permission proxy error: ${e.message}`,
            }),
          },
        ],
      });
    }
    return;
  }

  if (id !== undefined) {
    replyError(id, `Method not found: ${method}`, -32601);
  }
});

process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});
