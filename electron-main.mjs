// Electron entry point.
// Three modes (resolved from config.json next to the executable, with env vars overriding):
//   1. "local"  — start the bundled server in-process, open a window on it
//   2. "remote" — spawn SSH tunnel + remote ./start.sh, open a window on the tunneled port
//   3. legacy   — REMOTE_URL env var: skip server, just point at that URL
import { app, BrowserWindow, Menu, shell, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

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

// Validate a workspace path. Returns null if OK, or an error message.
function validateLocalPath(p) {
  if (!p || !p.trim()) return "Path is required.";
  const expanded = p.replace(/^~/, homedir());
  if (!existsSync(expanded)) return `Path doesn't exist: ${expanded}`;
  try {
    if (!statSync(expanded).isDirectory())
      return `Not a directory: ${expanded}`;
  } catch (e) {
    return `Could not access path: ${e.message}`;
  }
  return null;
}

function validateRemotePath(host, p) {
  return new Promise((resolve) => {
    if (!p || !p.trim()) return resolve("Path is required.");
    const escaped = p.replace(/'/g, "'\\''");
    const cmd = `[ -d '${escaped}' ] && echo OK || echo MISSING`;
    const proc = spawn(
      "ssh",
      ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", host, cmd],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("exit", (code) => {
      if (code !== 0)
        resolve(
          `Could not reach ${host}: ${err.trim().split("\n")[0] || `ssh exit ${code}`}`
        );
      else if (out.includes("OK")) resolve(null);
      else resolve(`Path doesn't exist on ${host}: ${p}`);
    });
    proc.on("error", (e) => resolve(`SSH spawn error: ${e.message}`));
  });
}

// Renderer-side HTML for the workspace prompt window. Inline so we don't
// need to ship a separate file inside the asar package. Loaded via data: URL.
const PROMPT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Workspace</title>
<style>
  html, body { background: #0b0d10; color: #e6e8eb; font-family: -apple-system, "Segoe UI", sans-serif; padding: 0; margin: 0; }
  body { padding: 22px 24px; }
  h2 { font-size: 14px; margin: 0 0 6px; color: #fff; font-weight: 600; }
  p { font-size: 12px; color: rgba(230,232,235,0.6); margin: 0 0 16px; line-height: 1.4; }
  input { width: 100%; padding: 10px 12px; background: #13171d; border: 1px solid rgba(255,255,255,0.12); color: white; border-radius: 6px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; box-sizing: border-box; }
  input:focus { outline: none; border-color: rgba(52,211,153,0.5); }
  .err { color: #f87171; font-size: 12px; margin-top: 8px; min-height: 14px; line-height: 1.4; word-break: break-all; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
  button { padding: 8px 16px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.3); color: white; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: inherit; }
  button.primary { background: rgba(52,211,153,0.2); border-color: rgba(52,211,153,0.4); color: #a7f3d0; }
  button:hover { background: rgba(255,255,255,0.08); }
  button.primary:hover { background: rgba(52,211,153,0.3); }
</style></head><body>
<h2 id="title">Workspace</h2>
<p id="message"></p>
<input id="input" type="text" autocomplete="off" spellcheck="false" />
<div class="err" id="err"></div>
<div class="actions">
  <button onclick="cancel()">Cancel</button>
  <button class="primary" onclick="submit()">OK</button>
</div>
<script>
try {
  console.log('[prompt-renderer] script started, requiring electron…');
  var { ipcRenderer } = require('electron');
  console.log('[prompt-renderer] ipcRenderer acquired');
} catch (e) {
  document.body.innerHTML = '<div style="color:#f87171;padding:20px;font-family:monospace">' +
    'Failed to load electron.ipcRenderer:<br>' + (e && e.message) + '</div>';
  throw e;
}
const inp = document.getElementById('input');
const errEl = document.getElementById('err');
const okBtn = document.querySelector('button.primary');
let pending = false;
ipcRenderer.on('init', (_, { title, message, defaultValue }) => {
  document.getElementById('title').textContent = title;
  document.getElementById('message').textContent = message;
  inp.value = defaultValue || '';
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
});
ipcRenderer.on('error', (_, msg) => {
  pending = false;
  okBtn.disabled = false;
  okBtn.textContent = 'OK';
  errEl.textContent = msg;
});
function submit() {
  if (pending) return;
  pending = true;
  errEl.textContent = '';
  okBtn.disabled = true;
  okBtn.textContent = 'Checking…';
  ipcRenderer.send('prompt-submit', inp.value);
}
function cancel() {
  ipcRenderer.send('prompt-cancel');
}
inp.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
  if (e.key === 'Escape') cancel();
});
</script></body></html>`;

function promptForPath({ title, message, defaultValue, validate }) {
  return new Promise(async (resolveP) => {
    await app.whenReady();
    log(`[prompt] opening window: ${title}`);
    const win = new BrowserWindow({
      width: 560,
      height: 300,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title,
      backgroundColor: "#0b0d10",
      center: true,
      // Show immediately. ready-to-show can hang on some setups and leaves the
      // window invisible forever; a brief blank flash is better than no window.
      show: true,
      webPreferences: {
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: true,
      },
    });
    win.setMenu(null);
    win.focus();
    win.webContents.on("console-message", (_e, level, msg) => {
      log(`[prompt console] ${msg}`);
    });

    let resolved = false;
    const cleanup = () => {
      ipcMain.removeListener("prompt-submit", onSubmit);
      ipcMain.removeListener("prompt-cancel", onCancel);
    };
    const onSubmit = async (_e, value) => {
      log(`[prompt] submit: ${value}`);
      const errMsg = await validate(value);
      if (errMsg) {
        log(`[prompt] invalid: ${errMsg}`);
        if (!win.isDestroyed()) win.webContents.send("error", errMsg);
        return;
      }
      log(`[prompt] valid, closing`);
      resolved = true;
      cleanup();
      if (!win.isDestroyed()) win.close();
      resolveP(value);
    };
    const onCancel = () => {
      log(`[prompt] cancel`);
      resolved = true;
      cleanup();
      if (!win.isDestroyed()) win.close();
      resolveP(null);
    };
    ipcMain.on("prompt-submit", onSubmit);
    ipcMain.on("prompt-cancel", onCancel);

    win.webContents.on("did-finish-load", () => {
      log(`[prompt] DOM loaded, sending init`);
      win.webContents.send("init", { title, message, defaultValue });
    });
    win.on("closed", () => {
      log(`[prompt] window closed (resolved=${resolved})`);
      if (!resolved) {
        cleanup();
        resolveP(null);
      }
    });

    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PROMPT_HTML));
  });
}

async function chooseWorkspace() {
  const ask = cfg.data.askWorkspaceOnLaunch !== false; // default: true
  const saved = loadSavedWorkspace();
  const mode = cfg.data.mode || "local";

  if (!ask && saved) {
    log(`[workspace] askWorkspaceOnLaunch=false, using saved: ${saved}`);
    return saved;
  }

  const defaultValue =
    saved || cfg.data.remote?.workspace || (mode === "local" ? homedir() : "");
  log(`[workspace] prompting (default: ${defaultValue || "(empty)"})`);

  const picked = await promptForPath({
    title: mode === "remote" ? "Remote workspace path" : "Local workspace path",
    message:
      mode === "remote"
        ? `Type the absolute path on ${RemoteSsh || "the remote server"} where workers should operate (e.g. /home/you/projects/myapp).`
        : "Type the absolute path to the folder you want Claude to work in. ~ is expanded to your home directory.",
    defaultValue,
    validate: (value) =>
      mode === "remote"
        ? validateRemotePath(RemoteSsh, value)
        : Promise.resolve(validateLocalPath(value)),
  });

  if (picked == null) {
    log(`[workspace] prompt canceled — using saved fallback: ${saved || "(none)"}`);
    return saved;
  }
  const expanded = mode === "local" ? picked.replace(/^~/, homedir()) : picked;
  log(`[workspace] picked: ${expanded}`);
  saveWorkspace(expanded);
  return expanded;
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

// Run startServer + createWindow only after app is ready.
// (Previous structure had 'await startServer()' at top level, which deadlocked
// when startServer awaited app.whenReady() internally — Electron with ESM
// entry waits for top-level await to finish before firing 'ready'.)
app.whenReady().then(async () => {
  try {
    buildMenu();
    await startServer();
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (e) {
    log(`[bootstrap] failed: ${e && (e.stack || e.message)}`);
    dialog.showErrorBox("Startup error", String(e && (e.stack || e.message) || e));
    app.quit();
  }
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
