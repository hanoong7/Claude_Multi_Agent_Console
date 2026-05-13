// Electron entry point.
// Three modes (resolved from config.json next to the executable, with env vars overriding):
//   1. "local"  — start the bundled server in-process, open a window on it
//   2. "remote" — spawn SSH tunnel + remote ./start.sh, open a window on the tunneled port
//   3. legacy   — REMOTE_URL env var: skip server, just point at that URL
import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const cfg = loadConfig();
if (cfg.error) {
  app.whenReady().then(() => {
    dialog.showErrorBox("Bad config.json", cfg.error);
    app.quit();
  });
}
console.log(`[config] ${cfg.path ?? "(no config.json found, using defaults)"}`);
if (!cfg.path && cfg.searched) {
  console.log("[config] looked in:");
  for (const p of cfg.searched) console.log("  - " + p);
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
    process.env.CLAUDE_CWD = process.env.CLAUDE_CWD || resolve(__dirname, "..");
  } else if (app.isPackaged) {
    // Packaged build: app.js + public/ live inside asar (read-only).
    // Put user data + workspace alongside the executable, not inside asar.
    const writeRoot =
      process.env.PORTABLE_EXECUTABLE_DIR || dirname(app.getPath("exe"));
    process.env.DATA_DIR = process.env.DATA_DIR || join(writeRoot, "data");
    process.env.CLAUDE_CWD =
      process.env.CLAUDE_CWD || join(writeRoot, "workspace");
  }
  // release tree (release/, not packaged) — server defaults already point
  // to ./public, ./data, ./workspace next to electron-main.mjs.
  process.env.PROD = "1";
  process.env.PORT = process.env.PORT || String(LocalPort);
}

const SERVER_URL =
  MODE === "url"
    ? REMOTE_URL
    : MODE === "remote"
      ? `http://localhost:${LocalPort}`
      : `http://localhost:${process.env.PORT || LocalPort}`;

let sshChild = null;

async function startSshTunnel() {
  if (!RemoteSsh) {
    dialog.showErrorBox(
      "Remote mode misconfigured",
      "config.json mode is 'remote' but remote.ssh is empty.\n\nEdit config.json next to the executable and set remote.ssh to your SSH alias or user@host."
    );
    app.quit();
    return false;
  }
  console.log(
    `[ssh] connecting to ${RemoteSsh}, forwarding ${LocalPort}, starting remote server…`
  );
  // Inline the env + cleanup directly in the SSH command so behavior doesn't
  // depend on whether the remote has an up-to-date start.sh.
  //   - Add common per-user bin dirs to PATH (~/.local/bin holds the claude CLI
  //     in most installs; non-interactive SSH skips .bashrc that usually does this).
  //   - Kill any stale process on the port before launching node (TIME_WAIT
  //     after a quick relaunch otherwise causes EADDRINUSE → silent crash).
  // Three layers of port cleanup. Many minimal Linux containers ship
  // without fuser AND lsof; pkill is a near-universal fallback (procps).
  // 'exec' replaces the shell so SIGTERM/SIGHUP from sshd reaches node directly.
  const remoteCmd =
    `export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/usr/local/bin:$PATH"; ` +
    `cd '${RemotePath}' || exit 1; ` +
    `if command -v fuser >/dev/null 2>&1; then ` +
    `  fuser -k ${RemotePort}/tcp >/dev/null 2>&1 || true; ` +
    `elif command -v lsof >/dev/null 2>&1; then ` +
    `  P=$(lsof -ti tcp:${RemotePort} 2>/dev/null); ` +
    `  [ -n "$P" ] && kill $P 2>/dev/null || true; ` +
    `else ` +
    `  pkill -f 'node app.js' >/dev/null 2>&1 || true; ` +
    `fi; ` +
    `sleep 0.5; ` +
    `PROD=1 PORT=${RemotePort} exec node app.js`;
  sshChild = spawn(
    "ssh",
    [
      "-L",
      `${LocalPort}:localhost:${RemotePort}`,
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      RemoteSsh,
      remoteCmd,
    ],
    { stdio: "inherit" }
  );
  sshChild.on("exit", (code) => {
    console.log(`[ssh] exited (${code})`);
    sshChild = null;
  });
  return true;
}

async function startServer() {
  if (MODE === "url") return; // legacy REMOTE_URL: do nothing
  if (MODE === "remote") {
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
    console.error("[electron] failed to start server:", e);
    const detail = (e && (e.stack || e.message)) || String(e);
    await app.whenReady();
    dialog.showErrorBox(
      "Server failed to start",
      `Local mode could not start the bundled server.\n\n${detail}`
    );
    app.quit();
  }
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(SERVER_URL + "/health");
      if (res.ok) return true;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (lastErr) console.error("[electron] last health-check error:", lastErr.message);
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
          click: () => shell.openExternal(SERVER_URL),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const ready = await waitForServer();
  if (!ready) {
    const detail =
      MODE === "remote"
        ? `SSH connection to "${RemoteSsh}" didn't yield a healthy server within 30s.\n\nCheck:\n  • SSH key auth works (try 'ssh ${RemoteSsh}' in a terminal)\n  • Remote repo is at '${RemotePath}'\n  • Port ${RemotePort} is free on the remote\n  • Local port ${LocalPort} is free here`
        : `Local server did not respond on ${SERVER_URL} within 30s.\n\nThis usually means the server crashed at startup. Try running the .exe from a terminal to see error output.`;
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
  await win.loadURL(SERVER_URL);
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
