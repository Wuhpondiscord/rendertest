const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

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
let activeUsers = {}; 

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

// Health Check - Visit this URL in your browser to verify the server is up
app.get("/", (req, res) => {
  res.send({
    status: "Online",
    clientIdLoaded: !!process.env.VITE_CLIENT_ID,
    clientSecretLoaded: !!process.env.DISCORD_CLIENT_SECRET
  });
});

/**
 * DISCORD OAUTH2 TOKEN BRIDGE
 * FIXED: Added better error logging to debug "Stuck at Initializing"
 */
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    console.error("❌ Auth Error: No code provided by frontend.");
    return res.status(400).json({ error: "No code provided" });
  }

  if (!process.env.DISCORD_CLIENT_SECRET || !process.env.VITE_CLIENT_ID) {
    console.error("❌ Config Error: Render Environment Variables are missing!");
    return res.status(500).json({ error: "Server missing environment variables" });
  }

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

    if (!response.ok) {
      console.error("❌ Discord API Error:", data);
      return res.status(response.status).json(data);
    }
    
    console.log("✅ Discord Auth Successful");
    res.send(data);
  } catch (err) {
    console.error("❌ Auth Bridge Critical Failure:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * SOCKET.IO LOGIC
 */
io.on("connection", (socket) => {
  userCount++;
  activeUsers[socket.id] = { userId: null, username: "Guest" };

  io.emit("userCount", userCount);
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  socket.on("registerUser", ({ userId, username }) => {
    activeUsers[socket.id] = { userId, username };
    console.log(`👤 User Joined: ${username} (${userId})`);
    io.emit("presenceUpdate", Object.values(activeUsers));
  });

  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const channel = state.channels.find(c => c.id === channelId);
    const user = activeUsers[socket.id];
    
    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    if (stepIndex >= 0 && stepIndex < state.steps) {
      channel.pattern[stepIndex] = val;
      io.emit("stepToggled", { channelId, stepIndex, val });
    }
  });

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
      speed: 2, 
      pattern: Array(state.steps).fill(false)
    };
    
    state.channels.push(newTrack);
    io.emit("stateUpdate", state);
  });

  socket.on("removeTrack", (channelId) => {
    const channel = state.channels.find(c => c.id === channelId);
    const user = activeUsers[socket.id];
    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    state.channels = state.channels.filter(c => c.id !== channelId);
    io.emit("stateUpdate", state);
  });

  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const channel = state.channels.find(c => c.id === channelId);
    const user = activeUsers[socket.id];
    if (!channel || (channel.userId && channel.userId !== user.userId)) return;

    if (key === "vol") value = Math.max(-60, Math.min(12, value));
    
    channel[key] = value;
    io.emit("trackParamUpdated", { channelId, key, value });
  });

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

  socket.on("saveProject", (name) => {
    if (!name) return;
    state.projectName = name;
    savedProjects[name] = JSON.parse(JSON.stringify(state));
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
    userCount = Math.max(0, userCount - 1);
    delete activeUsers[socket.id];
    io.emit("userCount", userCount);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 DAW Server Running on Port ${PORT}`);
});
