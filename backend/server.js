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

// Project Database (In-Memory for now)
let savedProjects = {};

// Active Live State
let state = {
  projectId: "default",
  projectName: "Untitled Session",
  bpm: 120,
  steps: 16,
  isPlaying: false,
  channels: []
};

let userCount = 0;

app.get("/", (req, res) => res.send("Multiplayer DAW Server is running"));

io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  // STEP TOGGLES
  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel.pattern[stepIndex] = val;
      io.emit("stepToggled", { channelId, stepIndex, val });
    }
  });

  // TRACK MANAGEMENT
  socket.on("addTrack", (authorName) => {
    state.channels.push({
      id: "c_" + crypto.randomUUID(),
      author: authorName || "Unknown",
      inst: "Keys - Grand Piano (Synth)",
      note: "C4",
      vol: -6,
      speed: 2, // 1=Fast, 2=Normal, 4=Slow
      pattern: Array(state.steps).fill(false)
    });
    io.emit("stateUpdate", state);
  });

  socket.on("removeTrack", (channelId) => {
    state.channels = state.channels.filter(c => c.id !== channelId);
    io.emit("stateUpdate", state);
  });

  // SMOOTH PARAMETER SYNC (Fixes Volume Bug)
  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel[key] = value;
      socket.broadcast.emit("trackParamUpdated", { channelId, key, value });
    }
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
    // Deep copy current state
    savedProjects[state.projectName] = JSON.parse(JSON.stringify(state));
    io.emit("projectList", Object.keys(savedProjects));
    io.emit("stateUpdate", state);
  });

  socket.on("loadProject", (name) => {
    if (savedProjects[name]) {
      state = JSON.parse(JSON.stringify(savedProjects[name]));
      state.isPlaying = false; // Always load paused
      io.emit("stateUpdate", state);
    }
  });

  socket.on("disconnect", () => {
    userCount--;
    io.emit("userCount", userCount);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
