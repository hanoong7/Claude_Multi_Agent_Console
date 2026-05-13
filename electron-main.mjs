// Electron entry point.
// Three modes (resolved from config.json next to the executable, with env vars overriding):
//   1. "local"  — start the bundled server in-process, open a window on it
//   2. "remote" — spawn SSH tunnel + remote ./start.sh, open a window on the tunneled port
//   3. legacy   — REMOTE_URL env var: skip server, just point at that URL
import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Diagnostic logging ──────────────────────────────────────────────────────
// Packaged GUI apps have no visible stdout/stderr, so write a log file next to
// the executable. Users can share this when something goes wrong.
function getLogPath() {
  const base =
    process.env.PORTABLE_EXECUTABLE_DIR ||
    (app.isPackaged ? dirname(app.getPath("exe")) : __dirname);
  return join(base, "electron.log");
}

const startedAt = Date.now();
function log(msg) {
  const t = ((Date.now() - startedAt) / 1000).toFixed(2);
  const line = `[+${t.padStart(7)}s] ${msg}\n`;
  try {
    process.stdout.write(line);
  } catch {}
  try {
    appendFileSync(getLogPath(), line);
  } catch {}
}

// Capture uncaught errors that would otherwise vanish silently
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT: ${err && (err.stack || err.message || err)}`);
});
process.on("unhandledRejection", (err) => {
  log(`UNHANDLED REJECTION: ${err && (err.stack || err.message || err)}`);
});

// Where to look for config.json. Order matters — first match wins.
// - portable .exe on Windows: PORTABLE_EXECUTABLE_DIR points to the
//   folder the user launched from (NOT the temp extraction dir).
// - other packaged builds: alongside the executable on disk.
// - unpackaged dev: alongside electron-main.mjs / in resources.
function loadConfig() {
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(join(process.env.PORTABLE_EXECUTABLE_DIR, "config.json"));
  }
  try {
    if (app.isPackaged) {
      candidates.push(join(dirname(app.getPath("exe")), "config.json"));
    }
  } catch {}
  candidates.push(join(__dirname, "config.json"));
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "config.json"));
    candidates.push(join(process.resourcesPath, "app", "config.json"));
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { path: p, data: JSON.parse(readFileSync(p, "utf8")) };
      } catch (e) {
        return { path: p, error: `Could not parse ${p}:\n${e.message}` };
      }
    }
  }
  return { path: null, data: {}, searched: candidates };
}

log("=== launch ===");
log(`platform: ${process.platform}  arch: ${process.arch}`);
log(`exe: ${process.execPath}`);
log(`PORTABLE_EXECUTABLE_DIR: ${process.env.PORTABLE_EXECUTABLE_DIR || "(unset)"}`);

const cfg = loadConfig();
if (cfg.error) {
  log(`[config] error: ${cfg.error}`);
  app.whenReady().then(() => {
    dialog.showErrorBox("Bad config.json", cfg.error);
    app.quit();
  });
}
log(`[config] using: ${cfg.path ?? "(none — defaults)"}`);
if (!cfg.path && cfg.searched) {
  log("[config] searched (none of these existed):");
  for (const p of cfg.searched) log("  - " + p);
}
log(`[config] mode: ${cfg.data.mode || "local"}`);
if (cfg.data.remote) log(`[config] remote: ${JSON.stringify(cfg.data.remote)}`);

// ─── Workspace selection ─────────────────────────────────────────────────────
// On launch we let the user pick which directory the orchestrator/workers
// operate on. The choice is saved so subsequent launches start from that
// folder as the default. config.json's askWorkspaceOnLaunch (default true)
// controls whether we prompt; set false to silently reuse the saved value.
function getStateDir() {
  return (
    process.env.PORTABLE_EXECUTABLE_DIR ||
    (app.isPackaged ? dirname(app.getPath("exe")) : __dirname)
  );
}
function workspaceStatePath() {
  return join(getStateDir(), "workspace.json");
}
function loadSavedWorkspace() {
  try {
    const raw = readFileSync(workspaceStatePath(), "utf8");
    return JSON.parse(raw).workspace || null;
  } catch {
    return null;
  }
}
function saveWorkspace(p) {
  try {
    writeFileSync(
      workspaceStatePath(),
      JSON.stringify({ workspace: p }, null, 2) + "\n"
    );
  } catch (e) {
    log(`[workspace] save failed: ${e.message}`);
  }
}

async function chooseWorkspace() {
  const ask = cfg.data.askWorkspaceOnLaunch !== false; // default: true
  const saved = loadSavedWorkspace();
  const mode = cfg.data.mode || "local";

  if (mode === "remote") {
    // Remote mode — we can't browse a remote filesystem easily from a
    // local folder dialog. Use config.json's remote.workspace or fall
    // back to no override (server uses ./workspace next to app.js).
    const explicit = cfg.data.remote?.workspace || null;
    log(`[workspace] remote mode, using config remote.workspace: ${explicit || "(default)"}`);
    return explicit;
  }

  if (!ask && saved) {
    log(`[workspace] askWorkspaceOnLaunch=false, using saved: ${saved}`);
    return saved;
  }

  await app.whenReady();
  log(`[workspace] prompting (saved default: ${saved || "(none)"})`);
  const result = await dialog.showOpenDialog({
    title: "Select workspace folder",
    message:
      "Choose the folder Claude should work in (creating files, reading code).\nThis will be the working directory for all delegations.",
    defaultPath: saved || app.getPath("home"),
    properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
    buttonLabel: "Use this folder",
  });

  if (result.canceled) {
    log(`[workspace] dialog canceled, using saved fallback: ${saved}`);
    return saved;
  }
  const picked = result.filePaths[0];
  log(`[workspace] picked: ${picked}`);
  saveWorkspace(picked);
  return picked;
}

const MODE =
  process.env.REMOTE_URL ? "url" : (cfg.data.mode || "local");
const REMOTE_URL = process.env.REMOTE_URL || null;

// Remote-mode config
const RemoteSsh = cfg.data.remote?.ssh || process.env.REMOTE_SSH || null;
const RemotePath = cfg.data.remote?.path || process.env.REMOTE_PATH || "Claude_Multi_Agent_Console";
const LocalPort = Number(cfg.data.remote?.localPort || process.env.LOCAL_PORT || 8787);
const RemotePort = Number(cfg.data.remote?.remotePort || process.env.REMOTE_PORT || 8787);

// In dev (this source tree), the UI build output sits at env/dist after `npm run build`.
// In release/, the bundled app.js sits alongside a `public/` dir which is used directly.
// We detect which we are and configure env vars before importing the server.
const DEV_DIST = join(__dirname, "dist");
const DEV_SERVER_DATA = join(__dirname, "server");

if (MODE === "local") {
  if (existsSync(DEV_DIST)) {
    // dev tree (env/)
    process.env.STATIC_DIR = DEV_DIST;
    process.env.DATA_DIR = DEV_SERVER_DATA;
    // CLAUDE_CWD will be set later from chooseWorkspace(); fall back here
    // only when chooseWorkspace returns nothing.
    process.env.CLAUDE_CWD =
      process.env.CLAUDE_CWD || resolve(__dirname, "..");
  } else if (app.isPackaged) {
    // Packaged build: app.js + public/ live inside asar (read-only).
    // Put user data + workspace alongside the executable, not inside asar.
    const writeRoot =
      process.env.PORTABLE_EXECUTABLE_DIR || dirname(app.getPath("exe"));
    process.env.DATA_DIR = process.env.DATA_DIR || join(writeRoot, "data");
    // CLAUDE_CWD intentionally NOT set here — chooseWorkspace() decides.
  }
  // release tree (release/, not packaged) — server defaults already point
  // to ./public, ./data, ./workspace next to electron-main.mjs.
  process.env.PROD = "1";
  process.env.PORT = process.env.PORT || String(LocalPort);
}

// In remote mode the configured LocalPort can fail to bind on Windows
// (reserved range from Hyper-V/WSL2, or held by another app). We probe
// for a free port at startup and substitute if needed. Mutable so other
// code paths can re-read it.
let EffectiveLocalPort = LocalPort;

function probeFreePort(port) {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.unref();
    s.on("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => {
      s.close(() => resolve(true));
    });
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function resolveLocalPort() {
  if (MODE !== "remote") return LocalPort;
  if (await probeFreePort(LocalPort)) return LocalPort;
  log(`[port] ${LocalPort} not bindable, picking a free port instead`);
  const fresh = await pickFreePort();
  log(`[port] using ${fresh} as local port`);
  return fresh;
}

function serverUrl() {
  if (MODE === "url") return REMOTE_URL;
  if (MODE === "remote") return `http://localhost:${EffectiveLocalPort}`;
  return `http://localhost:${process.env.PORT || LocalPort}`;
}

let sshChild = null;

let sshOutBuf = "";

async function startSshTunnel() {
  if (!RemoteSsh) {
    log("[ssh] no remote.ssh configured");
    dialog.showErrorBox(
      "Remote mode misconfigured",
      "config.json mode is 'remote' but remote.ssh is empty.\n\nEdit config.json next to the executable and set remote.ssh to your SSH alias or user@host."
    );
    app.quit();
    return false;
  }
  log(`[ssh] target=${RemoteSsh} forward=${EffectiveLocalPort}→${RemotePort} path=${RemotePath}`);

  // Remote command. Self-contained, doesn't rely on server-side start.sh.
  //   - PATH: include ~/.local/bin etc. so non-interactive SSH finds claude
  //   - pidfile-based cleanup: previous run wrote its PID to ~/.claude-...,
  //     so we kill exactly that PID (no risk of killing our own bash session
  //     like 'pkill -f node app.js' did)
  //   - 'trap' on the bash: when SSH disconnects, bash gets SIGHUP and the
  //     trap propagates SIGTERM to node so it dies cleanly. This is what
  //     fixed the zombie-node-after-disconnect problem.
  const PID_FILE = `$HOME/.claude-multi-agent-${RemotePort}.pid`;
  const remoteWorkspace = cfg.data.remote?.workspace || "";
  const cwdEnv = remoteWorkspace
    ? `CLAUDE_CWD='${remoteWorkspace.replace(/'/g, "'\\''")}' `
    : "";
  const remoteCmd = [
    `export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/usr/local/bin:$PATH"`,
    `echo "[remote] pwd=$(pwd)"`,
    `cd '${RemotePath}' || { echo "[remote] cd failed: ${RemotePath}"; exit 11; }`,
    `echo "[remote] cwd-ok=$(pwd)"`,
    `command -v node >/dev/null 2>&1 || { echo "[remote] node missing in PATH=$PATH"; exit 12; }`,
    `echo "[remote] node=$(node --version 2>&1)"`,
    `[ -f app.js ] || { echo "[remote] app.js missing in $(pwd)"; exit 13; }`,
    remoteWorkspace
      ? `echo "[remote] workspace=${remoteWorkspace}"`
      : `echo "[remote] workspace=(default)"`,
    // Cleanup: if our pidfile points to a live process, kill it
    `if [ -f "${PID_FILE}" ]; then ` +
      `OLD_PID=$(cat "${PID_FILE}" 2>/dev/null); ` +
      `if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then ` +
      `kill "$OLD_PID" 2>/dev/null; ` +
      `for i in 1 2 3 4 5; do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 0.2; done; ` +
      `echo "[remote] cleanup=killed-pid-$OLD_PID"; ` +
      `else echo "[remote] cleanup=stale-pidfile"; fi; ` +
      `else echo "[remote] cleanup=none"; fi`,
    // Start node in background, record PID, set trap so SSH disconnect kills it.
    // Note: 'cmd &' cannot be followed by ';' (bash syntax error), so we
    // collapse '... &' and '$!' capture into a single statement.
    `echo "[remote] launching node"`,
    `${cwdEnv}PROD=1 PORT=${RemotePort} node app.js & NODE_PID=$!`,
    `echo "$NODE_PID" > "${PID_FILE}"`,
    `trap 'kill $NODE_PID 2>/dev/null; rm -f "${PID_FILE}"' EXIT HUP INT TERM`,
    `wait $NODE_PID`,
  ].join("; ");

  sshOutBuf = "";
  sshChild = spawn(
    "ssh",
    [
      "-L",
      `${EffectiveLocalPort}:localhost:${RemotePort}`,
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ConnectTimeout=10",
      RemoteSsh,
      remoteCmd,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  sshChild.stdout.on("data", (d) => {
    const s = d.toString();
    sshOutBuf += s;
    for (const line of s.split("\n").filter(Boolean)) log(`[ssh stdout] ${line}`);
  });
  sshChild.stderr.on("data", (d) => {
    const s = d.toString();
    sshOutBuf += s;
    for (const line of s.split("\n").filter(Boolean)) log(`[ssh stderr] ${line}`);
  });
  sshChild.on("exit", (code, signal) => {
    log(`[ssh] exited code=${code} signal=${signal}`);
    sshChild = null;
  });
  return true;
}

async function startServer() {
  if (MODE === "url") return; // legacy REMOTE_URL: do nothing

  // Resolve workspace (folder picker for local mode, config for remote).
  const chosen = await chooseWorkspace();
  if (chosen) {
    process.env.CLAUDE_CWD = chosen;
    log(`[workspace] CLAUDE_CWD set to: ${chosen}`);
  } else {
    log(`[workspace] using default workspace (no override)`);
  }

  if (MODE === "remote") {
    try {
      EffectiveLocalPort = await resolveLocalPort();
    } catch (e) {
      log(`[port] resolveLocalPort failed: ${e && e.message}`);
    }
    const ok = await startSshTunnel();
    return ok;
  }
  // local mode — import the bundled server
  try {
    const devServer = join(__dirname, "server", "server.mjs");
    const relServer = join(__dirname, "app.js");
    let target = null;
    if (existsSync(devServer)) target = devServer;
    else if (existsSync(relServer)) target = relServer;
    else throw new Error("server entry not found");
    // On Windows, dynamic import() of an absolute path fails with
    // ERR_UNSUPPORTED_ESM_URL_SCHEME ("c:" is parsed as a protocol).
    // pathToFileURL converts it into a proper file:// URL.
    await import(pathToFileURL(target).href);
  } catch (e) {
    log(`[server] failed to import: ${e && (e.stack || e.message)}`);
    const detail = (e && (e.stack || e.message)) || String(e);
    await app.whenReady();
    dialog.showErrorBox(
      "Server failed to start",
      `Local mode could not start the bundled server.\n\n${detail}\n\nFull log: ${getLogPath()}`
    );
    app.quit();
  }
}

async function waitForServer(timeoutMs = 30000) {
  log(`[health] polling ${serverUrl()}/health for up to ${timeoutMs}ms`);
  const start = Date.now();
  let attempts = 0;
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    // detect SSH exit early — no point waiting if SSH died
    if (MODE === "remote" && sshChild === null) {
      log(`[health] aborting — SSH exited before server became ready`);
      return false;
    }
    attempts++;
    try {
      // Per-attempt timeout: fetch has no built-in timeout, and a hung
      // socket would otherwise block the whole 30s window in a single call.
      const res = await fetch(serverUrl() + "/health", {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        log(`[health] OK after ${attempts} attempts (${Date.now() - start}ms)`);
        return true;
      }
      log(`[health] non-200 status=${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log(
    `[health] timeout after ${attempts} attempts; last error: ${
      lastErr ? lastErr.message : "(none)"
    }`
  );
  return false;
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Open in browser",
          click: () => shell.openExternal(serverUrl()),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const ready = await waitForServer();
  if (!ready) {
    const sshTail = sshOutBuf.split("\n").slice(-20).join("\n").trim();
    const logPath = getLogPath();
    const detail =
      MODE === "remote"
        ? `SSH connection to "${RemoteSsh}" didn't yield a healthy server within 30s.\n\nCheck:\n  • SSH key auth works (try 'ssh ${RemoteSsh}' in a terminal)\n  • Remote repo is at '${RemotePath}'\n  • Port ${RemotePort} is free on the remote\n  • Local port ${LocalPort} is free here\n\nLast SSH output:\n${sshTail || "(no output captured)"}\n\nFull log: ${logPath}`
        : `Local server did not respond on ${serverUrl()} within 30s.\n\nThis usually means the server crashed at startup.\n\nFull log: ${logPath}`;
    dialog.showErrorBox("Server not responding", detail);
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0d10",
    title: "Claude Multi-Agent Console",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(serverUrl());
}

await startServer();

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (sshChild && !sshChild.killed) {
    try {
      sshChild.kill("SIGTERM");
    } catch {}
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (sshChild && !sshChild.killed) {
    try {
      sshChild.kill("SIGTERM");
    } catch {}
  }
});
