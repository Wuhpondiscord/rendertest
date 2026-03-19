const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { 
    origin: "*", // Necessary because frontend is on Netlify and backend is on Render
    methods: ["GET", "POST"] 
  }
});

const PORT = process.env.PORT || 3001;

// --- IN-MEMORY STORAGE ---
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

/**
 * 1. HEALTH CHECK
 * Visit your Render URL (e.g., https://your-app.onrender.com/) in a browser.
 * It will tell you if your Environment Variables are actually loaded.
 */
app.get("/", (req, res) => {
  res.send({
    status: "Online",
    VITE_CLIENT_ID: process.env.VITE_CLIENT_ID ? "LOADED" : "MISSING",
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET ? "LOADED" : "MISSING",
    info: "Discord Studio Pro Server"
  });
});

/**
 * 2. DISCORD AUTH BRIDGE
 * If the DAW hangs at 'Initializing', the error will appear in your Render Logs here.
 */
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    console.error("❌ Auth Error: No code received from frontend.");
    return res.status(400).json({ error: "No code provided" });
  }

  // Double-check variables are present
  const clientId = process.env.VITE_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ Config Error: Environment variables are not set on Render.");
    return res.status(500).json({ error: "Server environment variables missing" });
  }

  try {
    const response = await fetch(`https://discord.com/api/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: code,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Discord API Rejected the token exchange:", data);
      return res.status(response.status).json(data);
    }
    
    console.log("✅ Discord Auth Successful for code:", code.substring(0, 5) + "...");
    res.send(data);
  } catch (err) {
    console.error("❌ Critical Failure in Auth Bridge:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * 3. SOCKET.IO LOGIC
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
    io.emit("presenceUpdate", Object.values(activeUsers));
  });
});

server.listen(PORT, () => {
  console.log(`🚀 DAW Server Live: Port ${PORT}`);
});
