import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import pino from "pino";
import { mkdir, rm } from "node:fs/promises";
import baileysModule from "@whiskeysockets/baileys";

// Baileys 6.x is CommonJS. Under Node ESM its default import is the complete
// exports object, not makeWASocket itself. Resolve both shapes so upgrades do
// not bring the container down with "makeWASocket is not a function".
const baileys = baileysModule?.makeWASocket
  ? baileysModule
  : baileysModule?.default || baileysModule;
const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

if (typeof makeWASocket !== "function") {
  throw new TypeError("Baileys socket export could not be loaded");
}

const PORT = process.env.PORT || 3000;
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "change-me";
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";

if (SERVICE_TOKEN === "change-me") {
  console.error("SERVICE_TOKEN must be configured");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

let sock = null;
let connected = false;
let lastQr = "";
let starting = null;
let reconnectTimer = null;
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

async function start() {
  if (starting) return starting;
  const myGeneration = ++generation;
  startupError = "";
  starting = (async () => {
  await mkdir(AUTH_DIR, { recursive: true });
  await stopSocket();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const nextSocket = makeWASocket({
    version,
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
      console.log("WhatsApp connected ✅");
    }
    if (connection === "close") {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("connection closed", code);
      if (code !== DisconnectReason.loggedOut) {
        reconnectTimer = setTimeout(() => start().catch(console.error), 5000);
      }
    }
  });
  })();
  try {
    await starting;
  } catch (error) {
    startupError = error?.message || String(error);
    connected = false;
    console.error("start failed", error);
    throw error;
  } finally {
    starting = null;
  }
}
start().catch((e) => console.error("start failed", e));

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (h !== "Bearer " + SERVICE_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/", (_req, res) => res.json({ ok: true, service: "whatsapp-notifier" }));

app.get("/status", auth, (_req, res) => {
  res.json({
    ok: !startupError,
    connected,
    status: startupError ? "error" : connected ? "connected" : starting ? "starting" : "waiting",
    error: startupError || undefined,
    qr: lastQr || undefined,
    persistentAuth: AUTH_DIR.startsWith("/data/"),
  });
});

app.get("/qr", auth, (_req, res) => res.json({ qr: lastQr || null, connected }));

app.post("/send", auth, async (req, res) => {
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

app.post("/logout", auth, async (_req, res) => {
  try {
    await sock?.logout();
  } catch {}
  generation++;
  await stopSocket();
  await rm(AUTH_DIR, { recursive: true, force: true });
  connected = false;
  lastQr = "";
  await start();
  res.json({ ok: true, message: "logged out; new QR is being generated" });
});

app.post("/restart", auth, async (_req, res) => {
  connected = false;
  lastQr = "";
  await start();
  res.json({ ok: true, message: "connection reinitialized; saved session preserved" });
});

app.listen(PORT, () => console.log("listening on " + PORT));
