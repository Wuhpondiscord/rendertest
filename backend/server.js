const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3001;

// =========================
// In-Memory Storage
// =========================
let savedProjects = {};
let activeUsers = {}; // socket.id -> { userId, username }

// Active DAW state
let state = {
  projectId: "default",
  projectName: "Discord Jam Session",
  bpm: 120,
  steps: 16,
  isPlaying: false,
  channels: []
};

let userCount = 0;

app.use(express.json());

app.get("/", (req, res) => res.send("Multiplayer DAW Server is running"));

// =========================
// DISCORD AUTH BRIDGE
// =========================
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  try {
    const response = await fetch(`https://discord.com/api/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: process.env.VITE_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const data = await response.json();
    res.send(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch token" });
  }
});

// =========================
// SOCKET CONNECTION
// =========================
io.on("connection", (socket) => {
  userCount++;

  // Default state until registerUser is called via Discord SDK
  activeUsers[socket.id] = { userId: null, username: "Connecting..." };

  io.emit("userCount", userCount);
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  // USER AUTH (Called automatically after Discord SDK handshake)
  socket.on("registerUser", ({ userId, username }) => {
    activeUsers[socket.id] = { userId, username };
    io.emit("presenceUpdate", Object.values(activeUsers));
  });

  // STEP TOGGLES
  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const channel = state.channels.find(c => c.id === channelId);
    const user = activeUsers[socket.id];
    
    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    channel.pattern[stepIndex] = val;
    io.emit("stepToggled", { channelId, stepIndex, val });
  });

  // TRACK MANAGEMENT
  socket.on("addTrack", ({ userId, username }) => {
    const newTrack = {
      id: "c_" + crypto.randomUUID(),
      author: username || "Member",
      userId: userId || null,
      inst: "Keys - Grand Piano (Synth)",
      note: "C4",
      vol: -6,
      speed: 2,
      pattern: Array(state.steps).fill(false)
    };
    state.channels.push(newTrack);
    io.emit("stateUpdate", state);
  });

  socket.on("removeTrack", (channelId) => {
    const user = activeUsers[socket.id];
    const channel = state.channels.find(c => c.id === channelId);
    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    state.channels = state.channels.filter(c => c.id !== channelId);
    io.emit("stateUpdate", state);
  });

  // PARAM UPDATES (Fix: io.emit forces local update for instrument swapping)
  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const channel = state.channels.find(c => c.id === channelId);
    const user = activeUsers[socket.id];

    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    channel[key] = value;

    // Use io.emit so the sender also receives the confirmation to update their Tone.js player
    io.emit("trackParamUpdated", { channelId, key, value });
  });

  // GLOBAL CONTROLS
  socket.on("setBPM", (newBpm) => {
    state.bpm = newBpm;
    io.emit("bpmUpdate", state.bpm);
  });

  socket.on("togglePlay", (isPlaying) => {
    state.isPlaying = isPlaying;
    io.emit("playUpdate", state.isPlaying);
  });

  socket.on("changeSteps", (newSteps) => {
    state.steps = newSteps;
    state.channels.forEach(ch => {
      const newPattern = Array(newSteps).fill(false);
      for (let i = 0; i < Math.min(ch.pattern.length, newSteps); i++) {
        newPattern[i] = ch.pattern[i];
      }
      ch.pattern = newPattern;
    });
    io.emit("stateUpdate", state);
  });

  socket.on("clearGrid", () => {
    state.channels.forEach(ch => ch.pattern.fill(false));
    io.emit("stateUpdate", state);
  });

  // PROJECT MANAGEMENT
  socket.on("saveProject", (name) => {
    state.projectName = name;
    state.projectId = "proj_" + Date.now();
    savedProjects[state.projectName] = JSON.parse(JSON.stringify(state));
    io.emit("projectList", Object.keys(savedProjects));
  });

  socket.on("loadProject", (name) => {
    if (savedProjects[name]) {
      state = JSON.parse(JSON.stringify(savedProjects[name]));
      state.isPlaying = false;
      io.emit("stateUpdate", state);
    }
  });

  socket.on("disconnect", () => {
    userCount--;
    delete activeUsers[socket.id];
    io.emit("userCount", userCount);
    io.emit("presenceUpdate", Object.values(activeUsers));
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
