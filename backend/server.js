/**
 * Discord Studio Pro — Backend
 * ════════════════════════════════════════════════════════════════
 *
 * Data model:
 *   Project
 *     └─ beats[]
 *           └─ layers[]
 *                 └─ pattern[]  (step sequencer booleans)
 *
 * Required env vars:
 *   CLIENT_ID              Discord application client ID
 *   DISCORD_CLIENT_SECRET  Discord application client secret
 *
 * Optional:
 *   PORT                   defaults to 3001
 */

"use strict";

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const crypto     = require("crypto");
const cors       = require("cors");

// Node 18+ has fetch built-in — no node-fetch package needed

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));  // Discord's proxy rewrites the origin — wildcard required
app.use(express.json());

const io = new Server(server, {
  // IMPORTANT: Discord's Activity proxy only supports HTTP (polling), not raw WebSocket.
  // allowEIO3 ensures compatibility with older socket.io clients.
  // The client inside Discord will connect via polling; direct browser uses websocket.
  cors: {
    origin : "*",
    methods: ["GET", "POST"],
  },
  allowEIO3     : true,          // backwards compat
  pingTimeout   : 60000,         // keep connections alive through Discord's proxy
  pingInterval  : 25000,
});

// ════════════════════════════════════════════════════════════════
//  STATE HELPERS
// ════════════════════════════════════════════════════════════════
function uuid()   { return crypto.randomUUID(); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

function makeLayer(author, steps) {
  return {
    id      : "layer_" + uuid(),
    author  : author || "Guest",
    label   : "",
    inst    : "Grand Piano",
    note    : "C4",
    vol     : -6,
    bpmMult : 1,
    fx      : { distortion:0, filterFreq:20000, filterType:"lowpass", delayWet:0, delayFeedback:.3, bitcrush:8 },
    pattern : Array(steps).fill(false),
  };
}

function makeBeat(name, steps) {
  return {
    id    : "beat_" + uuid(),
    name  : (name || "Beat 1").slice(0, 48),
    layers: [],
  };
}

const firstBeat = makeBeat("Beat 1", 16);

let STATE = {
  projectName : "Untitled Session",
  bpm         : 120,
  steps       : 16,
  isPlaying   : false,
  beats       : [firstBeat],
  activeBeat  : firstBeat.id,
};

let SAVED = {};
let userCount = 0;

function getActiveBeat(st) {
  return st.beats.find(b => b.id === st.activeBeat) || st.beats[0];
}
function findLayer(st, beatId, layerId) {
  const beat = st.beats.find(b => b.id === beatId);
  if (!beat) return null;
  return beat.layers.find(l => l.id === layerId) || null;
}

// ════════════════════════════════════════════════════════════════
//  HTTP ROUTES
// ════════════════════════════════════════════════════════════════
app.get("/api/config", (req, res) => {
  const clientId = process.env.CLIENT_ID || process.env.VITE_CLIENT_ID;
  if (!clientId) {
    console.error("CLIENT_ID is not set in environment variables!");
    return res.status(500).json({ error: "SERVER_MISCONFIGURED" });
  }
  res.json({ clientId });
});

app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing code" });

  const clientId     = process.env.CLIENT_ID || process.env.VITE_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: "SERVER_MISCONFIGURED" });
  }

  try {
    const r = await fetch("https://discord.com/api/oauth2/token", {
      method  : "POST",
      headers : { "Content-Type": "application/x-www-form-urlencoded" },
      body    : new URLSearchParams({
        client_id    : clientId,
        client_secret: clientSecret,
        grant_type   : "authorization_code",
        code,
      }),
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error_description || data.error });
    res.json(data);
  } catch (err) {
    console.error("Discord token exchange error:", err);
    res.status(500).json({ error: "TOKEN_EXCHANGE_FAILED" });
  }
});

app.get("/", (req, res) =>
  res.send(`<pre>Discord Studio Pro – Server running on port ${PORT}\nUsers online: ${userCount}</pre>`)
);

// ════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);

  socket.emit("state", clone(STATE));
  socket.emit("projectList", Object.keys(SAVED));

  // ── STEP TOGGLE ────────────────────────────────────────────
  socket.on("toggleStep", ({ beatId, layerId, stepIndex, val }) => {
    const layer = findLayer(STATE, beatId, layerId);
    if (!layer || stepIndex < 0 || stepIndex >= layer.pattern.length) return;
    layer.pattern[stepIndex] = !!val;
    socket.broadcast.emit("stepToggled", { beatId, layerId, stepIndex, val: !!val });
  });

  // ── ADD LAYER ──────────────────────────────────────────────
  socket.on("addLayer", ({ beatId, author }) => {
    const beat = STATE.beats.find(b => b.id === beatId);
    if (!beat) return;
    beat.layers.push(makeLayer(author, STATE.steps));
    io.emit("state", clone(STATE));
  });

  // ── REMOVE LAYER ───────────────────────────────────────────
  socket.on("removeLayer", ({ beatId, layerId }) => {
    const beat = STATE.beats.find(b => b.id === beatId);
    if (!beat) return;
    beat.layers = beat.layers.filter(l => l.id !== layerId);
    io.emit("state", clone(STATE));
  });

  // ── DUPLICATE LAYER ────────────────────────────────────────
  socket.on("duplicateLayer", ({ beatId, layerId }) => {
    const beat = STATE.beats.find(b => b.id === beatId);
    if (!beat) return;
    const src = beat.layers.find(l => l.id === layerId);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id    = "layer_" + uuid();
    copy.label = copy.label ? copy.label + " copy" : "copy";
    beat.layers.push(copy);
    io.emit("state", clone(STATE));
  });

  // ── UPDATE LAYER PARAM ─────────────────────────────────────
  socket.on("updateLayer", ({ beatId, layerId, key, value }) => {
    const ALLOWED = ["inst", "note", "vol", "bpmMult", "label", "fx"];
    if (!ALLOWED.includes(key)) return;

    const layer = findLayer(STATE, beatId, layerId);
    if (!layer) return;

    if (key === "vol")     value = Math.max(-60, Math.min(12, parseFloat(value) || 0));
    if (key === "bpmMult") value = Math.max(0.25, Math.min(4, parseFloat(value) || 1));
    if (key === "label")   value = String(value).slice(0, 32);

    layer[key] = value;

    if (key === "vol") {
      // FIX: broadcast a targeted param update to all OTHER clients.
      // The old code emitted a blank stepToggled (no-op) then layerParamUpdate
      // but the original frontend had no listener for layerParamUpdate.
      // Now the frontend listens for layerParamUpdate correctly.
      socket.broadcast.emit("layerParamUpdate", { beatId, layerId, key, value });
    } else {
      io.emit("state", clone(STATE));
    }
  });

  // ── TRANSPORT ──────────────────────────────────────────────
  socket.on("setBPM", (bpm) => {
    const v = Math.max(40, Math.min(220, Number(bpm) || 120));
    STATE.bpm = v;
    io.emit("bpmUpdate", v);
  });

  socket.on("togglePlay", (p) => {
    STATE.isPlaying = !!p;
    io.emit("playUpdate", STATE.isPlaying);
  });

  socket.on("changeSteps", (n) => {
    const steps = [16, 32, 64].includes(Number(n)) ? Number(n) : 16;
    STATE.steps = steps;
    STATE.beats.forEach(beat => {
      beat.layers.forEach(layer => {
        const fresh = Array(steps).fill(false);
        for (let i = 0; i < Math.min(layer.pattern.length, steps); i++) {
          fresh[i] = layer.pattern[i];
        }
        layer.pattern = fresh;
      });
    });
    io.emit("state", clone(STATE));
  });

  socket.on("clearGrid", (beatId) => {
    const beat = STATE.beats.find(b => b.id === beatId) || getActiveBeat(STATE);
    if (!beat) return;
    beat.layers.forEach(l => l.pattern.fill(false));
    io.emit("state", clone(STATE));
  });

  // ── BEATS ──────────────────────────────────────────────────
  socket.on("addBeat", (name) => {
    const beat = makeBeat(name, STATE.steps);
    STATE.beats.push(beat);
    STATE.activeBeat = beat.id;
    io.emit("state", clone(STATE));
    io.emit("toast", `Beat "${beat.name}" added`);
  });

  socket.on("switchBeat", (beatId) => {
    if (!STATE.beats.find(b => b.id === beatId)) return;
    STATE.activeBeat = beatId;
    io.emit("state", clone(STATE));
  });

  socket.on("renameBeat", ({ beatId, name }) => {
    const beat = STATE.beats.find(b => b.id === beatId);
    if (!beat || !name) return;
    beat.name = String(name).slice(0, 48);
    io.emit("state", clone(STATE));
  });

  socket.on("deleteBeat", (beatId) => {
    if (STATE.beats.length <= 1) return;
    STATE.beats = STATE.beats.filter(b => b.id !== beatId);
    if (STATE.activeBeat === beatId) STATE.activeBeat = STATE.beats[0].id;
    io.emit("state", clone(STATE));
  });

  // ── PROJECTS ───────────────────────────────────────────────
  socket.on("saveProject", (name) => {
    if (!name || typeof name !== "string") return;
    const safe = name.trim().slice(0, 64);
    if (!safe) return;
    STATE.projectName = safe;
    SAVED[safe] = clone(STATE);
    io.emit("projectList", Object.keys(SAVED));
    io.emit("state", clone(STATE));
    io.emit("toast", `Saved "${safe}"`, "ok");
  });

  socket.on("renameProject", (name) => {
    if (!name || typeof name !== "string") return;
    STATE.projectName = name.trim().slice(0, 64);
    io.emit("state", clone(STATE));
  });

  socket.on("loadProject", (name) => {
    if (!SAVED[name]) return;
    STATE = clone(SAVED[name]);
    STATE.isPlaying = false;
    io.emit("state", clone(STATE));
    io.emit("projectList", Object.keys(SAVED));
    io.emit("toast", `Loaded "${name}"`, "ok");
  });

  // ── DISCONNECT ─────────────────────────────────────────────
  socket.on("disconnect", () => {
    userCount = Math.max(0, userCount - 1);
    io.emit("userCount", userCount);
  });
});

// ════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║      Discord Studio Pro  —  Server       ║
╠══════════════════════════════════════════╣
║  Port : ${PORT}                              ║
║  Mode : ${(process.env.NODE_ENV || "development").padEnd(32)} ║
╚══════════════════════════════════════════╝
  `);
  if (!process.env.CLIENT_ID && !process.env.VITE_CLIENT_ID)
    console.warn("⚠  WARNING: CLIENT_ID not set — Discord OAuth will fail.");
  if (!process.env.DISCORD_CLIENT_SECRET)
    console.warn("⚠  WARNING: DISCORD_CLIENT_SECRET not set — Discord OAuth will fail.");
});
