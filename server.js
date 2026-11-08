import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import pino from "pino";
import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile, unlink } from "node:fs/promises";
import baileysModule from "@whiskeysockets/baileys";

// Baileys 6.x is CommonJS. Under Node ESM its default import is the complete
// exports object, not makeWASocket itself. Resolve both shapes.
const baileys = baileysModule?.makeWASocket
  ? baileysModule
  : baileysModule?.default || baileysModule;
const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

if (typeof makeWASocket !== "function") {
  throw new TypeError("Baileys socket export could not be loaded");
}

// \u0644\u0627 \u064A\u062D\u062A\u0627\u062C \u0623\u064A \u0645\u062A\u063A\u064A\u0631\u0627\u062A: Render \u064A\u0636\u0628\u0637 PORT \u062A\u0644\u0642\u0627\u0626\u064A\u0627\u064B.
const PORT = process.env.PORT || 3000;

process.on("unhandledRejection", (e) => console.error("unhandled", e));
process.on("uncaughtException", (e) => console.error("uncaught", e));

/* ---------- \u0645\u062C\u0644\u062F \u0627\u0644\u062C\u0644\u0633\u0629: \u0623\u0648\u0644 \u0645\u062C\u0644\u062F \u0642\u0627\u0628\u0644 \u0644\u0644\u0643\u062A\u0627\u0628\u0629 ---------- */
// /data \u064A\u0639\u0645\u0644 \u0641\u0642\u0637 \u0625\u0646 \u0643\u0627\u0646 \u0639\u0646\u062F\u0643 \u0642\u0631\u0635 Disk\u061B \u0648\u0625\u0644\u0627 \u0646\u0633\u062A\u062E\u062F\u0645 \u0645\u062C\u0644\u062F \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062B\u0645 \u0645\u062C\u0644\u062F \u0627\u0644\u0646\u0638\u0627\u0645 \u0627\u0644\u0645\u0624\u0642\u062A.
const CANDIDATE_DIRS = [
  "/data/auth",
  path.join(process.cwd(), "auth"),
  path.join(os.tmpdir(), "whatsapp-auth"),
];
let AUTH_DIR = "";

async function canWrite(dir) {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    await writeFile(probe, "ok");
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

async function resolveAuthDir() {
  if (AUTH_DIR) return AUTH_DIR;
  for (const dir of CANDIDATE_DIRS) {
    if (await canWrite(dir)) {
      AUTH_DIR = dir;
      console.log("session folder: " + dir);
      return dir;
    }
  }
  throw new Error("no writable folder for the WhatsApp session");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

let sock = null;
let connected = false;
let lastQr = "";
let starting = null;
let reconnectTimer = null;
let retryTimer = null;
let generation = 0;
let startupError = "";

async function stopSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = sock;
  sock = null;
  if (!current) return;
  try { current.ev.removeAllListeners(); } catch {}
  try { current.ws?.close(); } catch {}
  try { current.end?.(new Error("reinitialize")); } catch {}
}

async function latestVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch {
    return undefined; // \u064A\u0633\u062A\u062E\u062F\u0645 \u0627\u0644\u0646\u0633\u062E\u0629 \u0627\u0644\u0645\u0636\u0645\u0651\u0646\u0629 \u0641\u064A \u0627\u0644\u0645\u0643\u062A\u0628\u0629
  }
}

async function start() {
  if (starting) return starting;
  const myGeneration = ++generation;
  startupError = "";
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  starting = (async () => {
    const dir = await resolveAuthDir();
    await stopSocket();
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const version = await latestVersion();
    const nextSocket = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["Store Notifier", "Chrome", "1.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    sock = nextSocket;

    nextSocket.ev.on("creds.update", saveCreds);
    nextSocket.ev.on("connection.update", async (u) => {
      if (myGeneration !== generation) return;
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        lastQr = await qrcode.toDataURL(qr);
        connected = false;
      }
      if (connection === "open") {
        connected = true;
        lastQr = "";
        startupError = "";
        console.log("WhatsApp connected \u2705");
      }
      if (connection === "close") {
        connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log("connection closed", code);
        if (code === DisconnectReason.loggedOut) {
          // \u062E\u0631\u062C \u0645\u0646 \u0627\u0644\u0623\u062C\u0647\u0632\u0629 \u0627\u0644\u0645\u0631\u062A\u0628\u0637\u0629: \u0646\u062D\u0630\u0641 \u0627\u0644\u062C\u0644\u0633\u0629 \u0648\u0646\u0648\u0644\u0651\u062F QR \u062C\u062F\u064A\u062F \u062A\u0644\u0642\u0627\u0626\u064A\u0627\u064B
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          AUTH_DIR = "";
        }
        reconnectTimer = setTimeout(() => start().catch(() => {}), 5000);
      }
    });
  })();
  try {
    await starting;
  } catch (error) {
    startupError = error?.message || String(error);
    connected = false;
    console.error("start failed", error);
    // \u0625\u0639\u0627\u062F\u0629 \u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0629 \u062A\u0644\u0642\u0627\u0626\u064A\u0627\u064B \u0628\u062F\u0644 \u0627\u0644\u062A\u0648\u0642\u0641
    retryTimer = setTimeout(() => start().catch(() => {}), 15000);
    throw error;
  } finally {
    starting = null;
  }
}
start().catch(() => {});

/* ---------- \u0625\u0628\u0642\u0627\u0621 \u0627\u0644\u0633\u064A\u0631\u0641\u0631 \u0645\u0633\u062A\u064A\u0642\u0638\u0627\u064B \u0639\u0644\u0649 \u062E\u0637\u0629 Render \u0627\u0644\u0645\u062C\u0627\u0646\u064A\u0629 ---------- */
// Render \u064A\u0636\u0628\u0637 RENDER_EXTERNAL_URL \u062A\u0644\u0642\u0627\u0626\u064A\u0627\u064B \u2014 \u0644\u0627 \u062A\u062D\u062A\u0627\u062C \u0644\u0625\u0636\u0627\u0641\u062A\u0647.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || "";
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL + "/ping").catch(() => {});
  }, 10 * 60 * 1000);
}

app.get("/", (_req, res) => res.json({ ok: true, service: "whatsapp-notifier", connected }));
app.get("/ping", (_req, res) => res.json({ ok: true }));

app.get("/status", (_req, res) => {
  res.json({
    ok: !startupError,
    connected,
    status: startupError ? "error" : connected ? "connected" : starting ? "starting" : "waiting",
    error: startupError || undefined,
    qr: lastQr || undefined,
    sessionFolder: AUTH_DIR || undefined,
    persistentAuth: AUTH_DIR.startsWith("/data/"),
  });
});

app.get("/qr", (_req, res) => res.json({ qr: lastQr || null, connected }));

app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: "to & message required" });
    if (!sock || !connected) return res.status(503).json({ error: "whatsapp not connected" });
    const jid = String(to).replace(/\D/g, "") + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: String(message) });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "send failed" });
  }
});

app.post("/logout", async (_req, res) => {
  try {
    await sock?.logout();
  } catch {}
  generation++;
  await stopSocket();
  if (AUTH_DIR) await rm(AUTH_DIR, { recursive: true, force: true }).catch(() => {});
  AUTH_DIR = "";
  connected = false;
  lastQr = "";
  start().catch(() => {});
  res.json({ ok: true, message: "logged out; new QR is being generated" });
});

app.post("/restart", async (_req, res) => {
  connected = false;
  lastQr = "";
  start().catch(() => {});
  res.json({ ok: true, message: "connection reinitialized; saved session preserved" });
});

app.listen(PORT, () => console.log("listening on " + PORT));
