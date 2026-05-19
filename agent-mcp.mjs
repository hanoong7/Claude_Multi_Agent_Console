#!/usr/bin/env node
// Stdio MCP server that gives workers (and the orchestrator) peer-to-peer
// messaging + a shared task list. All calls proxy through HTTP to the main
// app server which holds the actual state per chat session.
//
// Spawned by Claude Code via --mcp-config; speaks JSON-RPC 2.0 over stdio.
//
// Env:
//   AGENT_MAIN_URL  e.g. "http://localhost:8787"   (required)
//   AGENT_SESSION_ID                              (required — chat session)
//   AGENT_WORKER_NAME  e.g. "coder"               (optional — defaults to "orchestrator")

import readline from "node:readline";

const MAIN_URL = process.env.AGENT_MAIN_URL || "http://localhost:8787";
const SESSION_ID = process.env.AGENT_SESSION_ID || "";
const WORKER = process.env.AGENT_WORKER_NAME || "orchestrator";

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function replyError(id, message, code = -32000) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

// IMPORTANT: every tool accepts `from` — the calling worker's key (e.g.
// "coder", "designer", "orchestrator"). Workers must declare their identity
// on each call so the server can route messages and attribute task
// ownership correctly.
const FROM_PROP = {
  type: "string",
  description:
    "your own worker key (e.g. 'coder', 'designer', 'orchestrator')",
};

const TOOLS = [
  {
    name: "send_message",
    description:
      "Append a message to another worker's inbox. The target worker will see it on their next read_inbox call or when next spawned.",
    inputSchema: {
      type: "object",
      properties: {
        from: FROM_PROP,
        to: { type: "string", description: "recipient worker key" },
        content: { type: "string" },
      },
      required: ["from", "to", "content"],
    },
  },
  {
    name: "read_inbox",
    description:
      "Read (and drain) your own inbox — messages other workers have sent you.",
    inputSchema: {
      type: "object",
      properties: { from: FROM_PROP },
      required: ["from"],
    },
  },
  {
    name: "create_task",
    description:
      "Add a task to the shared task list. Optionally pre-assign or leave unassigned for any worker to claim.",
    inputSchema: {
      type: "object",
      properties: {
        from: FROM_PROP,
        title: { type: "string" },
        description: { type: "string" },
        assignee: { type: "string" },
      },
      required: ["from", "title"],
    },
  },
  {
    name: "list_tasks",
    description: "Read the shared task list; optionally filter by status.",
    inputSchema: {
      type: "object",
      properties: {
        from: FROM_PROP,
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
        },
      },
      required: ["from"],
    },
  },
  {
    name: "claim_task",
    description: "Claim a pending task as yourself.",
    inputSchema: {
      type: "object",
      properties: { from: FROM_PROP, id: { type: "string" } },
      required: ["from", "id"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task you (or anyone) claimed as completed.",
    inputSchema: {
      type: "object",
      properties: {
        from: FROM_PROP,
        id: { type: "string" },
        summary: { type: "string" },
      },
      required: ["from", "id"],
    },
  },
];

async function callMain(path, body, fromOverride) {
  const res = await fetch(`${MAIN_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      worker: fromOverride || WORKER,
      ...body,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

async function dispatch(name, args) {
  // Worker identity: tool's `from` arg overrides the spawn-time env var.
  // Needed because all subagents from one claude process may share this MCP
  // instance — each call must declare who's calling.
  const from = args.from || WORKER;
  switch (name) {
    case "send_message":
      return await callMain(
        "/agent/send_message",
        { to: args.to, content: args.content },
        from
      );
    case "read_inbox":
      return await callMain("/agent/read_inbox", {}, from);
    case "create_task":
      return await callMain(
        "/agent/create_task",
        {
          title: args.title,
          description: args.description || "",
          assignee: args.assignee || null,
        },
        from
      );
    case "list_tasks":
      return await callMain(
        "/agent/list_tasks",
        { status: args.status || null },
        from
      );
    case "claim_task":
      return await callMain("/agent/claim_task", { id: args.id }, from);
    case "complete_task":
      return await callMain(
        "/agent/complete_task",
        { id: args.id, summary: args.summary || "" },
        from
      );
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

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
      serverInfo: { name: "agent-coord", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await dispatch(name, args);
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    } catch (e) {
      reply(id, {
        content: [
          { type: "text", text: JSON.stringify({ error: e.message }) },
        ],
        isError: true,
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
