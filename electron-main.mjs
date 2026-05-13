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

// Where to look for config.json
// - dev (env/): env/config.json
// - unpackaged release: alongside electron-main.mjs
// - packaged (.exe / .AppImage / .app): alongside the executable on disk
function loadConfig() {
  const candidates = [];
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
        console.error(`[config] failed to parse ${p}:`, e.message);
      }
    }
  }
  return { path: null, data: {} };
}

const cfg = loadConfig();
console.log(`[config] ${cfg.path ?? "(no config.json found, using defaults)"}`);

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
  }
  // release tree (release/) — server defaults already point to ./public, ./data, ./workspace
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
      `cd '${RemotePath}' && exec ./start.sh`,
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
    console.error("[electron] server did not become ready in time");
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
