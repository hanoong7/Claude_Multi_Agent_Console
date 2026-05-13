// Electron entry point.
// Two modes:
//   1. Local mode (default): starts the bundled server in-process, then
//      opens a BrowserWindow on http://localhost:PORT.
//   2. Remote mode: set REMOTE_URL to skip starting a local server and
//      just open a window pointing at that URL (handy when the server runs
//      on another machine and you've SSH-tunneled its port to localhost).
import { app, BrowserWindow, Menu, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REMOTE_URL = process.env.REMOTE_URL || null;

// In dev (this source tree), the UI build output sits at env/dist after `npm run build`.
// In release/, the bundled app.js sits alongside a `public/` dir which is used directly.
// We detect which we are and configure env vars before importing the server.
const DEV_DIST = join(__dirname, "dist");
const DEV_SERVER_DATA = join(__dirname, "server");

if (!REMOTE_URL) {
  if (existsSync(DEV_DIST)) {
    // dev tree (env/)
    process.env.STATIC_DIR = DEV_DIST;
    process.env.DATA_DIR = DEV_SERVER_DATA;
    process.env.CLAUDE_CWD = process.env.CLAUDE_CWD || resolve(__dirname, "..");
  }
  // release tree (release/) — server defaults already point to ./public, ./data, ./workspace
  process.env.PROD = "1";
  process.env.PORT = process.env.PORT || "8787";
}

const SERVER_URL = REMOTE_URL || `http://localhost:${process.env.PORT || 8787}`;

async function startServer() {
  if (REMOTE_URL) return; // remote mode — nothing to start
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

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(SERVER_URL + "/health");
      if (res.ok) return true;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
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
  if (process.platform !== "darwin") app.quit();
});
