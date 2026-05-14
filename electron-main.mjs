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

let cfg = loadConfig();
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

// First-launch setup wizard. Asks the user which mode (local/remote) plus
// the parameters needed for that mode, then writes config.json next to the
// executable. Shown only when no config.json exists.
const SETUP_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Setup</title>
<style>
  html, body { background: #0b0d10; color: #e6e8eb; font-family: -apple-system, "Segoe UI", sans-serif; padding: 0; margin: 0; }
  body { padding: 20px 24px; }
  h2 { font-size: 14px; margin: 0 0 4px; color: #fff; font-weight: 600; }
  p.intro { font-size: 12px; color: rgba(230,232,235,0.6); margin: 0 0 14px; line-height: 1.4; }
  label { display: block; font-size: 11px; color: rgba(230,232,235,0.7); margin: 10px 0 4px; font-weight: 500; }
  input, select { width: 100%; padding: 8px 10px; background: #13171d; border: 1px solid rgba(255,255,255,0.12); color: white; border-radius: 6px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; box-sizing: border-box; }
  input:focus, select:focus { outline: none; border-color: rgba(52,211,153,0.5); }
  select { font-family: inherit; }
  .hint { font-size: 10.5px; color: rgba(230,232,235,0.4); margin-top: 3px; line-height: 1.3; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .err { color: #f87171; font-size: 12px; margin-top: 12px; min-height: 14px; line-height: 1.4; word-break: break-all; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  button { padding: 8px 16px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.3); color: white; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: inherit; }
  button.primary { background: rgba(52,211,153,0.2); border-color: rgba(52,211,153,0.4); color: #a7f3d0; }
  button:hover { background: rgba(255,255,255,0.08); }
  button.primary:hover { background: rgba(52,211,153,0.3); }
  button:disabled { opacity: 0.5; cursor: wait; }
</style></head><body>
<h2>Initial setup</h2>
<p class="intro">No config.json found. Tell us how you want to run Claude Multi-Agent Console.</p>

<label for="mode">Mode</label>
<select id="mode">
  <option value="local">Local — run on this machine</option>
  <option value="remote">Remote — connect to another machine via SSH</option>
</select>

<div id="localFields">
  <label for="localWs">Workspace path</label>
  <input id="localWs" type="text" placeholder="/home/you/projects/myapp" />
  <div class="hint">Folder Claude will operate in. ~ expands to your home directory.</div>
</div>

<div id="remoteFields" style="display:none">
  <label for="remoteSsh">SSH host or alias</label>
  <input id="remoteSsh" type="text" placeholder="user@host  or  alias from ~/.ssh/config" />
  <div class="hint">Key-based auth must be configured — no password prompts.</div>

  <label for="remoteInstall">Remote install path</label>
  <input id="remoteInstall" type="text" value="Claude_Multi_Agent_Console" />
  <div class="hint">Where this app is cloned on the remote (relative to remote $HOME).</div>

  <label for="remoteWs">Remote workspace path</label>
  <input id="remoteWs" type="text" placeholder="/home/you/projects/myapp" />
  <div class="hint">Absolute path on the remote where Claude will operate.</div>

  <div class="row">
    <div>
      <label for="localPort">Local port</label>
      <input id="localPort" type="number" min="1" max="65535" value="8787" />
    </div>
    <div>
      <label for="remotePort">Remote port</label>
      <input id="remotePort" type="number" min="1" max="65535" value="8787" />
    </div>
  </div>
</div>

<div class="err" id="err"></div>

<div class="actions">
  <button onclick="cancel()">Cancel</button>
  <button class="primary" onclick="submit()">Save &amp; Continue</button>
</div>

<script>
try {
  var { ipcRenderer } = require('electron');
} catch (e) {
  document.body.innerHTML = '<div style="color:#f87171;padding:20px;font-family:monospace">' +
    'Failed to load electron.ipcRenderer:<br>' + (e && e.message) + '</div>';
  throw e;
}
const modeEl = document.getElementById('mode');
const localFields = document.getElementById('localFields');
const remoteFields = document.getElementById('remoteFields');
const errEl = document.getElementById('err');
const okBtn = document.querySelector('button.primary');
let pending = false;

function syncMode() {
  const m = modeEl.value;
  localFields.style.display = m === 'local' ? '' : 'none';
  remoteFields.style.display = m === 'remote' ? '' : 'none';
  setTimeout(() => {
    (m === 'local' ? document.getElementById('localWs') : document.getElementById('remoteSsh')).focus();
  }, 20);
}
modeEl.addEventListener('change', syncMode);

function submit() {
  if (pending) return;
  pending = true;
  errEl.textContent = '';
  okBtn.disabled = true;
  okBtn.textContent = 'Checking…';
  const mode = modeEl.value;
  const payload = { mode };
  if (mode === 'local') {
    payload.workspace = document.getElementById('localWs').value.trim();
  } else {
    payload.workspace = document.getElementById('remoteWs').value.trim();
    payload.remote = {
      ssh: document.getElementById('remoteSsh').value.trim(),
      path: document.getElementById('remoteInstall').value.trim() || 'Claude_Multi_Agent_Console',
      localPort: parseInt(document.getElementById('localPort').value, 10) || 8787,
      remotePort: parseInt(document.getElementById('remotePort').value, 10) || 8787,
    };
  }
  ipcRenderer.send('setup-submit', payload);
}
function cancel() {
  ipcRenderer.send('setup-cancel');
}

ipcRenderer.on('error', (_, msg) => {
  pending = false;
  okBtn.disabled = false;
  okBtn.textContent = 'Save & Continue';
  errEl.textContent = msg;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !pending) submit();
  if (e.key === 'Escape') cancel();
});

setTimeout(() => document.getElementById('localWs').focus(), 50);
</script></body></html>`;

function promptForSetup() {
  return new Promise(async (resolveP) => {
    await app.whenReady();
    log(`[setup] opening wizard`);
    const win = new BrowserWindow({
      width: 580,
      height: 600,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "Claude Multi-Agent Console — Setup",
      backgroundColor: "#0b0d10",
      center: true,
      show: true,
      webPreferences: {
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: true,
      },
    });
    win.setMenu(null);
    win.focus();
    win.webContents.on("console-message", (_e, _level, msg) => {
      log(`[setup console] ${msg}`);
    });

    let resolved = false;
    const cleanup = () => {
      ipcMain.removeListener("setup-submit", onSubmit);
      ipcMain.removeListener("setup-cancel", onCancel);
    };
    const sendError = (msg) => {
      log(`[setup] invalid: ${msg}`);
      if (!win.isDestroyed()) win.webContents.send("error", msg);
    };
    const onSubmit = async (_e, payload) => {
      log(`[setup] submit: ${JSON.stringify(payload)}`);
      if (!payload || !payload.mode) return sendError("Mode is required.");
      if (!payload.workspace) return sendError("Workspace path is required.");

      if (payload.mode === "local") {
        const err = validateLocalPath(payload.workspace);
        if (err) return sendError(err);
      } else if (payload.mode === "remote") {
        const r = payload.remote || {};
        if (!r.ssh) return sendError("SSH host or alias is required.");
        const lp = Number(r.localPort);
        const rp = Number(r.remotePort);
        if (!Number.isFinite(lp) || lp < 1 || lp > 65535)
          return sendError("Local port must be between 1 and 65535.");
        if (!Number.isFinite(rp) || rp < 1 || rp > 65535)
          return sendError("Remote port must be between 1 and 65535.");
        const wsErr = await validateRemotePath(r.ssh, payload.workspace);
        if (wsErr) return sendError(wsErr);
      } else {
        return sendError(`Unknown mode: ${payload.mode}`);
      }

      log(`[setup] valid, closing`);
      resolved = true;
      cleanup();
      if (!win.isDestroyed()) win.close();
      resolveP(payload);
    };
    const onCancel = () => {
      log(`[setup] cancel`);
      resolved = true;
      cleanup();
      if (!win.isDestroyed()) win.close();
      resolveP(null);
    };
    ipcMain.on("setup-submit", onSubmit);
    ipcMain.on("setup-cancel", onCancel);

    win.on("closed", () => {
      log(`[setup] window closed (resolved=${resolved})`);
      if (!resolved) {
        cleanup();
        resolveP(null);
      }
    });

    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SETUP_HTML));
  });
}

function saveConfig(payload) {
  const data = {
    mode: payload.mode,
    askWorkspaceOnLaunch: true,
  };
  if (payload.mode === "remote") {
    data.remote = {
      ssh: payload.remote.ssh,
      path: payload.remote.path,
      localPort: payload.remote.localPort,
      remotePort: payload.remote.remotePort,
    };
  }
  const path = join(getStateDir(), "config.json");
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  log(`[setup] wrote ${path}`);
}

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

// Set true right after the setup wizard runs — workspace was just collected
// there, so we don't immediately ask again with a separate prompt.
let skipWorkspacePromptThisRun = false;

async function chooseWorkspace() {
  const ask = cfg.data.askWorkspaceOnLaunch !== false; // default: true
  const saved = loadSavedWorkspace();
  const mode = cfg.data.mode || "local";

  if (skipWorkspacePromptThisRun && saved) {
    log(`[workspace] skipping prompt (just set in wizard); using: ${saved}`);
    return saved;
  }

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

// All cfg-derived state is mutable so it can be (re)computed AFTER the
// first-launch setup wizard writes config.json. applyConfig() runs once
// during bootstrap, after cfg is finalized.
let MODE = "local";
const REMOTE_URL = process.env.REMOTE_URL || null;
let RemoteSsh = null;
let RemotePath = "Claude_Multi_Agent_Console";
let LocalPort = 8787;
let RemotePort = 8787;
let EffectiveLocalPort = 8787;

// In dev (this source tree), the UI build output sits at env/dist after `npm run build`.
// In release/, the bundled app.js sits alongside a `public/` dir which is used directly.
const DEV_DIST = join(__dirname, "dist");
const DEV_SERVER_DATA = join(__dirname, "server");

function applyConfig() {
  MODE = process.env.REMOTE_URL ? "url" : (cfg.data.mode || "local");
  RemoteSsh = cfg.data.remote?.ssh || process.env.REMOTE_SSH || null;
  RemotePath = cfg.data.remote?.path || process.env.REMOTE_PATH || "Claude_Multi_Agent_Console";
  LocalPort = Number(cfg.data.remote?.localPort || process.env.LOCAL_PORT || 8787);
  RemotePort = Number(cfg.data.remote?.remotePort || process.env.REMOTE_PORT || 8787);
  EffectiveLocalPort = LocalPort;

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
    process.env.PROD = "1";
    process.env.PORT = process.env.PORT || String(LocalPort);
  }
  log(`[config] applied — MODE=${MODE}${MODE === "remote" ? ` RemoteSsh=${RemoteSsh}` : ""}`);
}

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
let serverListeningSignal = false; // flips true when remote prints "[server] listening"
let chosenWorkspace = ""; // set by startServer after chooseWorkspace; read by startSshTunnel

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
  // Priority: user's pick from prompt > config.json remote.workspace > nothing
  const remoteWorkspace =
    chosenWorkspace || cfg.data.remote?.workspace || "";
  const cwdEnv = remoteWorkspace
    ? `CLAUDE_CWD='${remoteWorkspace.replace(/'/g, "'\\''")}' `
    : "";
  log(`[ssh] remote workspace: ${remoteWorkspace || "(default)"}`);
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
  serverListeningSignal = false;
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
    for (const line of s.split("\n").filter(Boolean)) {
      log(`[ssh stdout] ${line}`);
      // Definitive "new server is up" signal — trust this, not /health, because
      // a stale node from a previous run may still answer /health until our
      // remote pidfile cleanup kills it mid-stream.
      if (line.includes("[server] listening")) {
        if (!serverListeningSignal) log(`[ssh] new server bound (stdout marker)`);
        serverListeningSignal = true;
      }
    }
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

  // Resolve workspace (text prompt). The picked value applies to BOTH modes:
  //   - local: set process.env.CLAUDE_CWD before importing the server bundle
  //   - remote: stashed in chosenWorkspace so startSshTunnel can inject it as
  //     CLAUDE_CWD on the remote shell (NOT via local env, which SSH doesn't
  //     transmit)
  const chosen = await chooseWorkspace();
  if (chosen) {
    chosenWorkspace = chosen;
    process.env.CLAUDE_CWD = chosen; // applies to local mode
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
  const start = Date.now();

  // For remote mode, wait for the remote command's "[server] listening"
  // line on stdout BEFORE trusting /health. /health can transiently answer
  // from a zombie node that our cleanup is about to kill, which leaves us
  // racing the server going down between /health and loadURL.
  if (MODE === "remote") {
    log(`[health] waiting for new-server stdout marker (max ${timeoutMs}ms)`);
    while (!serverListeningSignal && Date.now() - start < timeoutMs) {
      if (sshChild === null) {
        log(`[health] aborting — SSH exited before marker`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!serverListeningSignal) {
      log(`[health] timeout waiting for stdout marker`);
      return false;
    }
    log(`[health] marker seen at ${Date.now() - start}ms; grace 400ms`);
    await new Promise((r) => setTimeout(r, 400)); // let socket finish binding
  }

  log(`[health] polling ${serverUrl()}/health`);
  let attempts = 0;
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    if (MODE === "remote" && sshChild === null) {
      log(`[health] aborting — SSH exited`);
      return false;
    }
    attempts++;
    try {
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
  // Retry loadURL — first attempt can hit a transient ERR_CONNECTION_RESET
  // if the SSH tunnel is still settling after the remote node just bound.
  let lastErr = null;
  for (let i = 1; i <= 4; i++) {
    try {
      await win.loadURL(serverUrl());
      log(`[loadURL] OK on attempt ${i}`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log(`[loadURL] attempt ${i} failed: ${e && e.message}`);
      if (i < 4) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  if (lastErr) throw lastErr;
}

// Run startServer + createWindow only after app is ready.
// Bootstrap is guarded by `bootstrapDone` so that the brief gap between
// "workspace prompt closes" and "main window opens" doesn't trigger the
// window-all-closed → quit handler (which would also kill SSH).
let bootstrapDone = false;

app.whenReady().then(async () => {
  try {
    buildMenu();

    // First-launch setup: if we're a packaged build with no config.json yet,
    // open a wizard to collect mode + parameters, then write config.json so
    // subsequent launches go straight to the workspace prompt.
    if (app.isPackaged && !cfg.path && !cfg.error) {
      const result = await promptForSetup();
      if (!result) {
        log(`[setup] canceled — quitting`);
        app.quit();
        return;
      }
      saveConfig(result);
      saveWorkspace(result.workspace);
      cfg = loadConfig();
      skipWorkspacePromptThisRun = true;
    }

    applyConfig();
    await startServer();
    await createWindow();
    bootstrapDone = true;
    log(`[bootstrap] done`);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (e) {
    log(`[bootstrap] failed: ${e && (e.stack || e.message)}`);
    bootstrapDone = true; // allow normal quit path
    dialog.showErrorBox("Startup error", String(e && (e.stack || e.message) || e));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (!bootstrapDone) {
    log(`[event] window-all-closed during bootstrap — ignoring`);
    return;
  }
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
