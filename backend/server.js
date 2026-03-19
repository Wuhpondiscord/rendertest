const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const cors = require("cors");

// Using dynamic import for node-fetch to support latest versions
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);

// Fixed Port
const PORT = 3001;

// Middlewares
app.use(cors({ origin: "*" }));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- DAW STATE MANAGEMENT ---
let savedProjects = {};
let state = {
  projectId: "session_" + Date.now(),
  projectName: "Untitled Session",
  bpm: 120,
  steps: 16,
  isPlaying: false,
  channels: [] // Will hold track objects {id, author, inst, note, vol, speed, pattern}
};
let userCount = 0;

// --- DISCORD AUTHENTICATION ---
// This handles the secure exchange of the Discord code for an access token
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).send({ error: "Missing code" });

  try {
    const response = await fetch(`https://discord.com/api/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.VITE_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
      }),
    });
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Discord Auth Error:", err);
    res.status(500).send({ error: "Failed to exchange token with Discord" });
  }
});

app.get("/", (req, res) => res.send("Studio Server Online - Port " + PORT));

// --- REAL-TIME COLLABORATION (SOCKETS) ---
io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);
  
  // Send current studio state to the new user
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  // Handle Note Toggles
  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel.pattern[stepIndex] = val;
      // Broadcast to everyone else to sync their grid
      socket.broadcast.emit("stepToggled", { channelId, stepIndex, val });
    }
  });

  // Add New Track
  socket.on("addTrack", (authorName) => {
    const newTrack = {
      id: "track_" + crypto.randomUUID(),
      author: authorName || "Guest",
      inst: "Keys - Grand Piano",
      note: "C4",
      vol: -6,
      speed: 2, // 1:Fast, 2:Normal, 4:Slow
      pattern: Array(state.steps).fill(false)
    };
    state.channels.push(newTrack);
    io.emit("stateUpdate", state);
  });

  // Remove Track
  socket.on("removeTrack", (channelId) => {
    state.channels = state.channels.filter(c => c.id !== channelId);
    io.emit("stateUpdate", state);
  });

  // Update Track Parameters (Instrument, Pitch, Volume, Speed)
  // This is the specific fix to ensure instruments swap without clearing
  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel[key] = value;
      // Sync parameters to all other users
      socket.broadcast.emit("trackParamUpdated", { channelId, key, value });
    }
  });

  // Global Transport Controls
  socket.on("setBPM", (newBpm) => {
    state.bpm = newBpm;
    io.emit("bpmUpdate", newBpm);
  });

  socket.on("togglePlay", (playing) => {
    state.isPlaying = playing;
    io.emit("playUpdate", playing);
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

  // --- PERSISTENCE (SAVE/LOAD) ---
  socket.on("saveProject", (name) => {
    if (!name) return;
    state.projectName = name;
    // Store a deep copy of the current state
    savedProjects[name] = JSON.parse(JSON.stringify(state));
    io.emit("projectList", Object.keys(savedProjects));
    io.emit("stateUpdate", state);
  });

  socket.on("loadProject", (name) => {
    if (savedProjects[name]) {
      state = JSON.parse(JSON.stringify(savedProjects[name]));
      state.isPlaying = false; // Safety: don't start playing immediately on load
      io.emit("stateUpdate", state);
    }
  });

  socket.on("disconnect", () => {
    userCount--;
    io.emit("userCount", userCount);
  });
});

server.listen(PORT, () => {
  console.log(`\n--- Discord DAW Server ---\nURL: http://localhost:${PORT}\n--------------------------\n`);
});
