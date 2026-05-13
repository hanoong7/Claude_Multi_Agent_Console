// One-shot launcher: SSH tunnel + remote ./start.sh + local Electron window.
// Reads connection info from env vars:
//   REMOTE_SSH    required — SSH alias (myserver) or user@host
//   REMOTE_PATH   optional — path to the repo on the remote (default: Claude_Multi_Agent_Console)
//   LOCAL_PORT    optional — local port to bind (default: 8787)
//   REMOTE_PORT   optional — remote server port (default: 8787)
//
// Requires SSH key auth (no password prompt). The remote server is killed when this exits.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const RemoteSsh = process.env.REMOTE_SSH;
const RemotePath = process.env.REMOTE_PATH || "Claude_Multi_Agent_Console";
const LocalPort = Number(process.env.LOCAL_PORT || 8787);
const RemotePort = Number(process.env.REMOTE_PORT || 8787);

if (!RemoteSsh) {
  console.error("REMOTE_SSH not set. Examples:");
  console.error('  PowerShell : $env:REMOTE_SSH="myserver"; npm run start:remote');
  console.error("  cmd        : set REMOTE_SSH=myserver && npm run start:remote");
  console.error("  bash       : REMOTE_SSH=myserver npm run start:remote");
  console.error("");
  console.error("  REMOTE_SSH can be an SSH config alias (e.g. \"myserver\") or user@host.");
  console.error("  Optional: REMOTE_PATH (default \"Claude_Multi_Agent_Console\"),");
  console.error("            LOCAL_PORT (default 8787), REMOTE_PORT (default 8787).");
  process.exit(1);
}

console.log(`→ Connecting to ${RemoteSsh}, forwarding ${LocalPort}, starting server…`);
const ssh = spawn(
  "ssh",
  [
    "-L",
    `${LocalPort}:localhost:${RemotePort}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    RemoteSsh,
    `cd '${RemotePath}' && exec ./start.sh`,
  ],
  { stdio: "inherit" }
);

let killed = false;
function cleanup() {
  if (killed) return;
  killed = true;
  try {
    ssh.kill("SIGTERM");
  } catch {}
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

console.log("→ Waiting for server to come up (max 30s)…");
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const res = await fetch(`http://localhost:${LocalPort}/health`);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {}
}

if (!ready) {
  console.error(
    `✗ Server didn't respond on localhost:${LocalPort} within 30s.\n` +
      `  Verify: 'ssh ${RemoteSsh}' works (key auth, no password prompt)\n` +
      `  Verify: the repo is at '${RemotePath}' on the remote\n` +
      `  Verify: nothing else is occupying remote port ${RemotePort}`
  );
  cleanup();
  process.exit(1);
}

console.log("✓ Server up. Launching desktop window…");

let electronBin;
try {
  electronBin = require("electron");
} catch {
  console.error("electron package not installed. Run 'npm install' first.");
  cleanup();
  process.exit(1);
}

const electron = spawn(electronBin, ["."], {
  env: { ...process.env, REMOTE_URL: `http://localhost:${LocalPort}` },
  stdio: "inherit",
});

electron.on("close", (code) => {
  cleanup();
  process.exit(code || 0);
});
