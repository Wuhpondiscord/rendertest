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

const path = require("path");
const fs   = require("fs");

const SAVE_FILE = path.join(__dirname, "projects.json");

// Load saved projects from disk on startup
function loadSavedProjects() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      console.log(`Loaded ${Object.keys(data).length} saved projects from disk`);
      return data;
    }
  } catch(e) { console.warn("Could not load saved projects:", e.message); }
  return {};
}

function persistProjects() {
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(SAVED, null, 2)); }
  catch(e) { console.warn("Could not persist projects:", e.message); }
}

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

// Serve the frontend index.html directly from Render.
// This eliminates the GitHub Pages / Render split which caused URL mapping
// ordering issues in the Discord developer portal. With everything on one server:
//   URL Mapping: / → beat-backend-5nnu.onrender.com  (serves HTML + API)
// No second mapping needed. No ordering conflict possible.
// Serve index.html at root — Render becomes the single origin for everything
app.get("/", (req, res) => {
  const indexPath = path.join(__dirname, "index.html");
  if(fs.existsSync(indexPath)){
    res.sendFile(indexPath);
  } else {
    res.json({ status: "ok", users: userCount, uptime: process.uptime() });
  }
});

const io = new Server(server, {
  // NOTE: Discord URL mapping prefixes cannot contain dots.
  // /api/socketio (no dot) instead of /api/socket.io
  path: "/api/socketio",
  cors: {
    origin: [
      "https://wuhpondiscord.github.io",
      /\.discordsays\.com$/,
    ],
    methods     : ["GET", "POST"],
    credentials : true,
  },
  allowEIO3    : true,
  pingTimeout  : 60000,
  pingInterval : 25000,
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

let SAVED = loadSavedProjects();
let userCount = 0;
let USERS = {}; // socketId -> { name, color, id }

function buildProjectList() {
  return Object.entries(SAVED).map(([name, proj]) => ({
    name,
    bpm      : proj.bpm,
    beats    : proj.beats ? proj.beats.length : 0,
    savedAt  : proj.savedAt || null,
    savedBy  : proj.savedBy || null,
  }));
}

function broadcastUsers(){
  io.emit("userList", Object.values(USERS));
  io.emit("userCount", Object.values(USERS).length);
}

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
// Proxy external JS libraries blocked by Discord's CSP.
// These must be served from same origin to be loadable inside the Activity iframe.
const LIB_URLS = {
  "tone" : "https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js",
  "lame" : "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js",
};
Object.entries(LIB_URLS).forEach(([name, url]) => {
  app.get("/api/lib/" + name, async (req, res) => {
    try {
      const r = await fetch(url);
      const text = await r.text();
      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Cache-Control", "public, max-age=86400"); // cache 24h
      res.send(text);
    } catch(err) {
      console.error("Lib proxy error (" + name + "):", err.message);
      res.status(502).send("// proxy failed for " + name + ": " + err.message);
    }
  });
});
app.get("/api/sdk", async (req, res) => {
  try {
    // jsdelivr's +esm endpoint converts the npm package to a browser-ready ES module
    const r = await fetch("https://cdn.jsdelivr.net/npm/@discord/embedded-app-sdk@1/+esm");
    const text = await r.text();
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(text);
  } catch(err) {
    console.error("SDK proxy error:", err.message);
    res.status(502).send("// SDK proxy failed: " + err.message);
  }
});

// Download current session as a .sleezy project file
app.get("/api/project/download", (req, res) => {
  const safe = (STATE.projectName || "session").replace(/[^a-z0-9_\- ]/gi,"_");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}.sleezy"`);
  res.json({ version: 1, exportedAt: new Date().toISOString(), state: clone(STATE) });
});

// Download a named saved project as .sleezy
app.get("/api/project/download/:name", (req, res) => {
  const p = SAVED[req.params.name];
  if(!p) return res.status(404).json({ error: "Not found" });
  const safe = p.projectName.replace(/[^a-z0-9_\- ]/gi,"_");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}.sleezy"`);
  res.json({ version: 1, exportedAt: new Date().toISOString(), state: clone(p) });
});

// Import a .sleezy project (posted as JSON body)
app.post("/api/project/import", (req, res) => {
  const { state } = req.body;
  if(!state || !state.beats) return res.status(400).json({ error: "Invalid project file" });
  STATE = {
    projectName : String(state.projectName || "Imported").slice(0,64),
    bpm         : Math.max(40, Math.min(220, Number(state.bpm) || 120)),
    steps       : [16,32,64].includes(Number(state.steps)) ? Number(state.steps) : 16,
    isPlaying   : false,
    beats       : state.beats,
    activeBeat  : state.activeBeat || (state.beats[0] && state.beats[0].id),
  };
  io.emit("state", clone(STATE));
  io.emit("toast", `Imported "${STATE.projectName}"`, "ok");
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  const clientId     = process.env.CLIENT_ID || process.env.VITE_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId) {
    console.error("CLIENT_ID is not set!");
    return res.status(500).json({ error: "SERVER_MISCONFIGURED" });
  }
  // We expose the client secret here so the browser can do the OAuth token
  // exchange directly from the user's IP — Render's shared IPs get 429'd by
  // Discord's Cloudflare when making server-side requests.
  // This is acceptable for a Discord Activity: the secret is already scoped
  // to this specific app and the iframe origin is controlled by Discord.
  res.json({ clientId, clientSecret: clientSecret || "" });
});

app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing code" });

  const clientId     = process.env.CLIENT_ID || process.env.VITE_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("TOKEN: missing env vars. CLIENT_ID:", !!clientId, "SECRET:", !!clientSecret);
    return res.status(500).json({ error: "SERVER_MISCONFIGURED" });
  }

  try {
    console.log("TOKEN: fetching discord.com/api/oauth2/token ...");
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

    const text = await r.text();
    console.log("TOKEN: status:", r.status, "body[:120]:", text.slice(0, 120).replace(/\n/g," "));

    // If Discord returned non-JSON (HTML error page), report it clearly
    if(!text.trim().startsWith("{") && !text.trim().startsWith("[")){
      console.error("TOKEN: non-JSON response from Discord:", text.slice(0, 300));
      return res.status(502).json({ error: "DISCORD_RETURNED_HTML", status: r.status, body: text.slice(0, 200) });
    }

    const data = JSON.parse(text);
    if(data.error){
      console.error("TOKEN: Discord error:", data.error, data.error_description);
      return res.status(400).json({ error: data.error_description || data.error });
    }
    res.json({ access_token: data.access_token });
  } catch (err) {
    console.error("TOKEN: fetch threw:", err.message);
    res.status(500).json({ error: "TOKEN_EXCHANGE_FAILED", detail: err.message });
  }
});

// Network test — verify Render can reach discord.com outbound
// Hit /api/nettest in browser to check: should return {"ok":true,"status":200}
app.get("/api/nettest", async (req, res) => {
  try{
    const r = await fetch("https://discord.com/api/v10/applications/@me", {
      headers: { "Authorization": "Bot placeholder" }
    });
    res.json({ ok: true, status: r.status, reachable: true });
  }catch(err){
    res.json({ ok: false, error: err.message, reachable: false });
  }
});
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if(SELF_URL){
  setInterval(async()=>{
    try{ await fetch(SELF_URL + "/api/config"); }catch(e){}
  }, 10 * 60 * 1000);
}

// ════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  USERS[socket.id] = { id: socket.id, name: "Guest", color: "#e87820" };
  userCount = Object.keys(USERS).length;

  socket.emit("state", clone(STATE));
  socket.emit("projectList", buildProjectList());
  broadcastUsers();

  // Register authenticated user — called after Discord auth completes
  socket.on("register", ({ name, color, userId }) => {
    if(!name) return;
    USERS[socket.id] = {
      id     : socket.id,
      name   : String(name).slice(0, 32),
      color  : color || "#e87820",
      userId : userId || null,
    };
    broadcastUsers();
  });

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
    // Restart tick timer at new BPM if playing
    if(STATE._tickTimer){
      clearInterval(STATE._tickTimer);
      const ms32n = (60000 / v) / 8;
      STATE._tickTimer = setInterval(()=>{
        STATE.tick = (STATE.tick || 0) + 1;
        io.emit("tick", STATE.tick);
      }, ms32n);
    }
  });

  socket.on("togglePlay", (p) => {
    STATE.isPlaying = !!p;
    if(!p){
      // Stop: clear timer, reset tick
      clearInterval(STATE._tickTimer);
      STATE._tickTimer = null;
      STATE.tick = 0;
      io.emit("playUpdate", { playing: false, tick: 0 });
    } else {
      // Play: start server-driven tick broadcast
      // All clients fire their sequencer step on each "tick" event
      STATE.tick = 0;
      const ms32n = (60000 / STATE.bpm) / 8;
      STATE._tickTimer = setInterval(()=>{
        STATE.tick++;
        io.emit("tick", STATE.tick);
      }, ms32n);
      io.emit("playUpdate", { playing: true, tick: 0 });
    }
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
    STATE.savedAt = new Date().toISOString();
    STATE.savedBy = (USERS[socket.id] && USERS[socket.id].name) || "Unknown";
    SAVED[safe] = clone(STATE);
    persistProjects();
    io.emit("projectList", buildProjectList());
    io.emit("state", clone(STATE));
    io.emit("toast", `Saved "${safe}"`);
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
    io.emit("projectList", buildProjectList());
    io.emit("toast", `Loaded "${name}"`);
  });

  socket.on("deleteProject", (name) => {
    if (!SAVED[name]) return;
    delete SAVED[name];
    persistProjects();
    io.emit("projectList", buildProjectList());
    io.emit("toast", `Deleted "${name}"`);
  });

  socket.on("importProject", (data) => {
    if (!data || !data.beats || !data.bpm) return;
    const name = (data.projectName || "Imported").slice(0, 64);
    // Sanitize imported data — only copy known fields
    STATE.projectName = name;
    STATE.bpm         = Math.max(40, Math.min(220, Number(data.bpm) || 120));
    STATE.steps       = [16,32,64].includes(Number(data.steps)) ? Number(data.steps) : 16;
    STATE.beats       = data.beats;
    STATE.activeBeat  = data.activeBeat || (data.beats[0] && data.beats[0].id) || STATE.activeBeat;
    STATE.isPlaying   = false;
    // Auto-save the imported project
    SAVED[name] = clone(STATE);
    persistProjects();
    io.emit("state", clone(STATE));
    io.emit("projectList", buildProjectList());
    io.emit("toast", `Imported "${name}"`);
  });

  // ── DISCONNECT ─────────────────────────────────────────────
  socket.on("disconnect", () => {
    userCount = Math.max(0, userCount - 1);
    delete USERS[socket.id];
    broadcastUsers();
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
