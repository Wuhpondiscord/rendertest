/**
 * Discord Studio Pro — Backend Server
 * ─────────────────────────────────────────────────────────────────
 * Features:
 *  - Real-time collaboration via Socket.IO
 *  - Discord OAuth2 token exchange
 *  - Multiple beat patterns per project
 *  - Per-track BPM multiplier + volume
 *  - Project save / load / rename (in-memory)
 *  - Per-socket user colors
 *  - Toast broadcast for collaborative feedback
 * ─────────────────────────────────────────────────────────────────
 * Required env vars:
 *   CLIENT_ID             — Discord app client ID
 *   DISCORD_CLIENT_SECRET — Discord app client secret
 *
 * Optional:
 *   PORT                  — defaults to 3001
 */

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const crypto  = require("crypto");
const cors    = require("cors");

// Dynamic import shim for node-fetch
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

// ─── MIDDLEWARE ──────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ─── HELPERS ─────────────────────────────────────────────────────
function makeId() {
  return crypto.randomUUID();
}

function makePattern(name, steps) {
  return {
    id      : "pat_" + makeId(),
    name    : name || "Beat 1",
    channels: [],
  };
}

function makeTrack(authorName, steps) {
  return {
    id      : "track_" + makeId(),
    author  : authorName || "Guest",
    inst    : "Keys - Grand Piano",
    note    : "C4",
    vol     : -6,
    bpmMult : 1,   // 0.5 = half speed, 1 = normal, 2 = double
    pattern : Array(steps).fill(false),
  };
}

function cloneState(s) {
  return JSON.parse(JSON.stringify(s));
}

// ─── STATE ───────────────────────────────────────────────────────
const initialPattern = makePattern("Beat 1", 16);

let state = {
  projectName   : "Untitled Session",
  bpm           : 120,
  steps         : 16,
  isPlaying     : false,
  channels      : [],          // tracks in the ACTIVE pattern (kept in sync)
  patterns      : [initialPattern],
  activePattern : initialPattern.id,
};

let savedProjects = {};  // { name: clonedState }
let userCount     = 0;
let connectedUsers = {}; // { socketId: { username, color } }

// Get the currently active pattern object from state
function getActivePattern() {
  return state.patterns.find(p => p.id === state.activePattern) || state.patterns[0];
}

// Sync state.channels ↔ active pattern channels (they reference the same array)
function syncChannels() {
  const pat = getActivePattern();
  state.channels = pat.channels;
}

// ─── HTTP ROUTES ─────────────────────────────────────────────────

// Discord client ID (safe to expose publicly)
app.get("/api/config", (req, res) => {
  const clientId = process.env.CLIENT_ID || process.env.VITE_CLIENT_ID;
  if (!clientId) {
    console.error("CLIENT_ID env var is not set!");
    return res.status(500).json({ error: "Server misconfiguration: CLIENT_ID missing" });
  }
  res.json({ clientId });
});

// Discord OAuth2 token exchange
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing code" });

  const clientId     = process.env.CLIENT_ID || process.env.VITE_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: "Server misconfiguration: OAuth credentials missing" });
  }

  try {
    const response = await fetch("https://discord.com/api/oauth2/token", {
      method  : "POST",
      headers : { "Content-Type": "application/x-www-form-urlencoded" },
      body    : new URLSearchParams({
        client_id    : clientId,
        client_secret: clientSecret,
        grant_type   : "authorization_code",
        code,
      }),
    });
    const data = await response.json();
    if (data.error) {
      console.error("Discord token error:", data);
      return res.status(400).json({ error: data.error_description || data.error });
    }
    res.json(data);
  } catch (err) {
    console.error("Discord Auth Error:", err);
    res.status(500).json({ error: "Failed to exchange token with Discord" });
  }
});

app.get("/", (req, res) =>
  res.send(`<pre>Discord Studio Pro — Server Online (port ${PORT})\nUsers: ${userCount}</pre>`)
);

// ─── SOCKET.IO ───────────────────────────────────────────────────
io.on("connection", (socket) => {
  userCount++;
  connectedUsers[socket.id] = { username: "Guest" };
  io.emit("userCount", userCount);

  // Send full state to new user
  syncChannels();
  socket.emit("initState", cloneState(state));
  socket.emit("projectList", Object.keys(savedProjects));

  // ── STEP TOGGLE ──────────────────────────────────────────────
  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const pat = getActivePattern();
    const ch  = pat.channels.find(c => c.id === channelId);
    if (!ch || stepIndex < 0 || stepIndex >= ch.pattern.length) return;
    ch.pattern[stepIndex] = val;
    syncChannels();
    socket.broadcast.emit("stepToggled", { channelId, stepIndex, val });
  });

  // ── ADD TRACK ────────────────────────────────────────────────
  socket.on("addTrack", (authorName) => {
    const pat   = getActivePattern();
    const track = makeTrack(authorName, state.steps);
    pat.channels.push(track);
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
  });

  // ── REMOVE TRACK ─────────────────────────────────────────────
  socket.on("removeTrack", (channelId) => {
    const pat = getActivePattern();
    pat.channels = pat.channels.filter(c => c.id !== channelId);
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
  });

  // ── UPDATE TRACK PARAM ───────────────────────────────────────
  // Handles: inst, note, vol, bpmMult
  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const pat = getActivePattern();
    const ch  = pat.channels.find(c => c.id === channelId);
    if (!ch) return;

    const allowed = ["inst", "note", "vol", "bpmMult"];
    if (!allowed.includes(key)) return;

    ch[key] = value;
    syncChannels();
    // Broadcast delta to all other clients (avoids full grid rebuild for vol)
    socket.broadcast.emit("trackParamUpdated", { channelId, key, value });
  });

  // ── TRANSPORT ────────────────────────────────────────────────
  socket.on("setBPM", (bpm) => {
    const v = Math.max(40, Math.min(220, Number(bpm)));
    state.bpm = v;
    io.emit("bpmUpdate", v);
  });

  socket.on("togglePlay", (playing) => {
    state.isPlaying = !!playing;
    io.emit("playUpdate", state.isPlaying);
  });

  socket.on("changeSteps", (newSteps) => {
    const n = [16, 32, 64].includes(newSteps) ? newSteps : 16;
    state.steps = n;
    // Resize patterns for all patterns
    state.patterns.forEach(pat => {
      pat.channels.forEach(ch => {
        const fresh = Array(n).fill(false);
        for (let i = 0; i < Math.min(ch.pattern.length, n); i++) {
          fresh[i] = ch.pattern[i];
        }
        ch.pattern = fresh;
      });
    });
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
  });

  socket.on("clearGrid", () => {
    const pat = getActivePattern();
    pat.channels.forEach(ch => ch.pattern.fill(false));
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
  });

  // ── PATTERNS ─────────────────────────────────────────────────
  socket.on("addPattern", (name) => {
    const pat = makePattern(name || `Beat ${state.patterns.length + 1}`, state.steps);
    state.patterns.push(pat);
    state.activePattern = pat.id;
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
    io.emit("toast", `Pattern "${pat.name}" created`);
  });

  socket.on("switchPattern", (patternId) => {
    const pat = state.patterns.find(p => p.id === patternId);
    if (!pat) return;
    state.activePattern = patternId;
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
  });

  socket.on("renamePattern", ({ patternId, name }) => {
    const pat = state.patterns.find(p => p.id === patternId);
    if (!pat || !name) return;
    pat.name = name.slice(0, 32);
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
  });

  socket.on("deletePattern", (patternId) => {
    if (state.patterns.length <= 1) return; // always keep at least one
    state.patterns = state.patterns.filter(p => p.id !== patternId);
    if (state.activePattern === patternId) {
      state.activePattern = state.patterns[0].id;
    }
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
  });

  // ── PROJECTS ─────────────────────────────────────────────────
  socket.on("saveProject", (name) => {
    if (!name || typeof name !== "string") return;
    const safeName = name.trim().slice(0, 64);
    state.projectName = safeName;
    savedProjects[safeName] = cloneState(state);
    io.emit("projectList", Object.keys(savedProjects));
    io.emit("stateUpdate", cloneState(state));
    io.emit("toast", `Project "${safeName}" saved`);
  });

  socket.on("renameProject", (name) => {
    if (!name || typeof name !== "string") return;
    state.projectName = name.trim().slice(0, 64);
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
  });

  socket.on("loadProject", (name) => {
    if (!savedProjects[name]) return;
    state = cloneState(savedProjects[name]);
    state.isPlaying = false;
    syncChannels();
    io.emit("stateUpdate", cloneState(state));
    io.emit("toast", `Loaded "${name}"`);
  });

  // ── DISCONNECT ───────────────────────────────────────────────
  socket.on("disconnect", () => {
    userCount = Math.max(0, userCount - 1);
    delete connectedUsers[socket.id];
    io.emit("userCount", userCount);
  });
});

// ─── START ───────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║      Discord Studio Pro — Server      ║
╠═══════════════════════════════════════╣
║  URL  : http://localhost:${PORT}          ║
║  Mode : ${process.env.NODE_ENV || "development"}                    ║
╚═══════════════════════════════════════╝
  `);

  if (!process.env.CLIENT_ID && !process.env.VITE_CLIENT_ID) {
    console.warn("⚠  WARNING: CLIENT_ID env var is not set. Discord auth will fail.");
  }
  if (!process.env.DISCORD_CLIENT_SECRET) {
    console.warn("⚠  WARNING: DISCORD_CLIENT_SECRET env var is not set. Discord auth will fail.");
  }
});
