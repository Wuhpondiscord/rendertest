const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const cors = require("cors");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);

// Use a fixed port
const PORT = 3001;

// Allow Discord iframes to fetch from this API
app.use(cors({ origin: "*" }));
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- DAW STATE ---
let savedProjects = {};
let state = {
  projectId: "default",
  projectName: "Untitled Session",
  bpm: 120,
  steps: 16,
  isPlaying: false,
  channels: []
};
let userCount = 0;

// --- DISCORD AUTHENTICATION ROUTE ---
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
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
    console.error("Token Exchange Error:", err);
    res.status(500).send({ error: "Failed to exchange token" });
  }
});

app.get("/", (req, res) => res.send("Discord DAW Server Running on port " + PORT));

io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel.pattern[stepIndex] = val;
      io.emit("stepToggled", { channelId, stepIndex, val });
    }
  });

  socket.on("addTrack", (authorName) => {
    state.channels.push({
      id: "c_" + crypto.randomUUID(),
      author: authorName || "Unknown User",
      inst: "Keys - Grand Piano (Synth)",
      note: "C4",
      vol: -6,
      speed: 2,
      pattern: Array(state.steps).fill(false)
    });
    io.emit("stateUpdate", state);
  });

  socket.on("removeTrack", (channelId) => {
    state.channels = state.channels.filter(c => c.id !== channelId);
    io.emit("stateUpdate", state);
  });

  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel[key] = value;
      socket.broadcast.emit("trackParamUpdated", { channelId, key, value });
    }
  });

  socket.on("setBPM", (newBpm) => {
    state.bpm = newBpm;
    io.emit("bpmUpdate", newBpm);
  });

  socket.on("togglePlay", (isPlaying) => {
    state.isPlaying = isPlaying;
    io.emit("playUpdate", isPlaying);
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

  socket.on("saveProject", (name) => {
    state.projectName = name;
    state.projectId = "proj_" + Date.now();
    savedProjects[state.projectName] = JSON.parse(JSON.stringify(state));
    io.emit("projectList", Object.keys(savedProjects));
    io.emit("stateUpdate", state);
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

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
