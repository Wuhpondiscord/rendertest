const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); // Ensure fetch works in all Node environments

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3001;

/**
 * IN-MEMORY STORAGE & INITIAL STATE
 */
let savedProjects = {};
let activeUsers = {}; // socket.id -> { userId, username }

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

// Health Check
app.get("/", (req, res) => res.send("Discord DAW Server: Online"));

/**
 * DISCORD OAUTH2 TOKEN BRIDGE
 * This handles the secure exchange of the authorization code for an access token.
 */
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  
  if (!process.env.DISCORD_CLIENT_SECRET) {
    return res.status(500).json({ error: "Server missing environment variables" });
  }

  try {
    const response = await fetch(`https://discord.com/api/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: process.env.VITE_CLIENT_ID || "YOUR_CLIENT_ID",
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error_description || data.error);
    
    res.send(data);
  } catch (err) {
    console.error("Auth Bridge Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * SOCKET.IO LOGIC
 */
io.on("connection", (socket) => {
  userCount++;
  activeUsers[socket.id] = { userId: null, username: "Guest" };

  // Sync new user with current session
  io.emit("userCount", userCount);
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  // --- USER HANDSHAKE ---
  socket.on("registerUser", ({ userId, username }) => {
    activeUsers[socket.id] = { userId, username };
    console.log(`User Linked: ${username} (${userId})`);
    io.emit("presenceUpdate", Object.values(activeUsers));
  });

  // --- STEP SEQUENCER LOGIC ---
  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const channel = state.channels.find(c => c.id === channelId);
    const user = activeUsers[socket.id];
    
    // Strict Ownership Check: Only the creator of the track can edit steps
    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    if (stepIndex >= 0 && stepIndex < state.steps) {
      channel.pattern[stepIndex] = val;
      // Broadcast specifically to update specific UI buttons efficiently
      io.emit("stepToggled", { channelId, stepIndex, val });
    }
  });

  // --- TRACK MANAGEMENT ---
  socket.on("addTrack", (userData) => {
    const userId = userData.userId || activeUsers[socket.id].userId;
    const username = userData.username || activeUsers[socket.id].username;

    const newTrack = {
      id: "ch_" + crypto.randomBytes(4).toString("hex"),
      author: username,
      userId: userId,
      inst: "Kick - 808 Trap",
      note: "C1",
      vol: -6,
      speed: 2, // 1: Fast, 2: Normal, 4: Slow
      pattern: Array(state.steps).fill(false)
    };
    
    state.channels.push(newTrack);
    io.emit("stateUpdate", state);
  });

  socket.on("removeTrack", (channelId) => {
    const channel = state.channels.find(c => c.id === channelId);
    const user = activeUsers[socket.id];

    // Permissions: Only delete your own track
    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    state.channels = state.channels.filter(c => c.id !== channelId);
    io.emit("stateUpdate", state);
  });

  // --- PARAMETER UPDATES ---
  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const channel = state.channels.find(c => c.id === channelId);
    const user = activeUsers[socket.id];

    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    // Sanitize volume to prevent ear-blasting
    if (key === "vol") value = Math.max(-60, Math.min(12, value));
    
    channel[key] = value;
    io.emit("trackParamUpdated", { channelId, key, value });
  });

  // --- GLOBAL TRANSPORT ---
  socket.on("setBPM", (newBpm) => {
    state.bpm = Math.max(40, Math.min(240, newBpm));
    io.emit("bpmUpdate", state.bpm);
  });

  socket.on("togglePlay", (playing) => {
    state.isPlaying = playing;
    io.emit("playUpdate", state.isPlaying);
  });

  socket.on("changeSteps", (newSteps) => {
    const allowed = [16, 32, 64];
    if (!allowed.includes(newSteps)) return;

    state.steps = newSteps;
    state.channels.forEach(ch => {
      const oldPattern = ch.pattern;
      ch.pattern = Array(newSteps).fill(false);
      // Migrate old pattern to new grid without losing data
      for (let i = 0; i < Math.min(oldPattern.length, newSteps); i++) {
        ch.pattern[i] = oldPattern[i];
      }
    });
    io.emit("stateUpdate", state);
  });

  socket.on("clearGrid", () => {
    state.channels.forEach(ch => ch.pattern.fill(false));
    io.emit("stateUpdate", state);
  });

  // --- PERSISTENCE ---
  socket.on("saveProject", (name) => {
    if (!name) return;
    state.projectName = name;
    // Deep clone state to prevent reference issues
    savedProjects[name] = JSON.parse(JSON.stringify(state));
    io.emit("projectList", Object.keys(savedProjects));
    console.log(`Project Saved: ${name}`);
  });

  socket.on("loadProject", (name) => {
    if (savedProjects[name]) {
      state = JSON.parse(JSON.stringify(savedProjects[name]));
      state.isPlaying = false; // Always load in paused state
      io.emit("stateUpdate", state);
      console.log(`Project Loaded: ${name}`);
    }
  });

  // --- DISCONNECT ---
  socket.on("disconnect", () => {
    userCount = Math.max(0, userCount - 1);
    delete activeUsers[socket.id];
    io.emit("userCount", userCount);
    io.emit("presenceUpdate", Object.values(activeUsers));
  });
});

/**
 * RUN SERVER
 */
server.listen(PORT, () => {
  console.log(`
  -----------------------------------------
  🚀 DISCORD STUDIO PRO SERVER RUNNING
  PORT: ${PORT}
  ENVIRONMENT: ${process.env.NODE_ENV || 'development'}
  -----------------------------------------
  `);
});
