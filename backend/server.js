const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const cors = require("cors");

// Import node-fetch for Discord API communication
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);

// Use Render's assigned port or default to 3001
const PORT = process.env.PORT || 3001;

// Allow GitHub Pages and Discord Proxy to communicate with this server
app.use(cors({ origin: "*" }));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- DAW STATE ---
let savedProjects = {};
let state = {
  projectId: "session_" + Date.now(),
  projectName: "Untitled Session",
  bpm: 120,
  steps: 16,
  isPlaying: false,
  channels: [] 
};
let userCount = 0;

// --- CONFIG INJECTION ---
// The frontend calls this to get the Client ID without it being hardcoded on GitHub
app.get("/api/config", (req, res) => {
  res.json({ clientId: process.env.VITE_CLIENT_ID });
});

// --- DISCORD AUTHENTICATION ---
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing code" });

  try {
    const response = await fetch(`https://discord.com/api/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.VITE_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
        // CRITICAL FIX: This must be exactly https://127.0.0.1 for Discord Activities
        redirect_uri: "https://127.0.0.1", 
      }),
    });
    
    const data = await response.json();
    
    if (data.error) {
      console.error("Discord API Error:", data);
      return res.status(400).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Token Exchange Error:", err);
    res.status(500).json({ error: "Internal server error during auth" });
  }
});

app.get("/", (req, res) => res.send("Studio Server Online"));

// --- REAL-TIME COLLABORATION ---
io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);
  
  // Send current state to newly connected users
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  // Handle Note Toggles
  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel.pattern[stepIndex] = val;
      socket.broadcast.emit("stepToggled", { channelId, stepIndex, val });
    }
  });

  // Add Track
  socket.on("addTrack", (authorName) => {
    const newTrack = {
      id: "tr_" + crypto.randomUUID(),
      author: authorName || "Producer",
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

  // Update Track Params (Volume, Instrument, Speed)
  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel[key] = value;
      // Broadcast change to all other users
      socket.broadcast.emit("trackParamUpdated", { channelId, key, value });
    }
  });

  // Transport Controls
  socket.on("setBPM", (newBpm) => {
    state.bpm = newBpm;
    io.emit("bpmUpdate", newBpm);
  });

  socket.on("togglePlay", (playing) => {
    state.isPlaying = playing;
    io.emit("playUpdate", playing);
  });

  socket.on("clearGrid", () => {
    state.channels.forEach(ch => ch.pattern.fill(false));
    io.emit("stateUpdate", state);
  });

  // Save/Load Project
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
    userCount--;
    io.emit("userCount", userCount);
  });
});

server.listen(PORT, () => {
  console.log(`DAW Backend running on port ${PORT}`);
});
