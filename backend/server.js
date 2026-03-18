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

// Global State
let state = {
  bpm: 120,
  steps: 16,
  isPlaying: false,
  channels: [
    { id: "c_" + crypto.randomUUID(), inst: "Kick - 808", note: "C2", pattern: Array(16).fill(false) },
    { id: "c_" + crypto.randomUUID(), inst: "Snare - Tight", note: "C4", pattern: Array(16).fill(false) },
    { id: "c_" + crypto.randomUUID(), inst: "Hat - Closed", note: "C4", pattern: Array(16).fill(false) }
  ]
};

let userCount = 0;

app.get("/", (req, res) => res.send("Multiplayer DAW Server is running"));

io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);

  socket.emit("initState", state);

  socket.on("toggleStep", ({ channelId, stepIndex }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel.pattern[stepIndex] = !channel.pattern[stepIndex];
      io.emit("stateUpdate", state);
    }
  });

  socket.on("addTrack", () => {
    state.channels.push({
      id: "c_" + crypto.randomUUID(),
      inst: "Keys - Sine Piano", // Default new instrument
      note: "C4",
      pattern: Array(state.steps).fill(false)
    });
    io.emit("stateUpdate", state);
  });

  socket.on("removeTrack", (channelId) => {
    state.channels = state.channels.filter(c => c.id !== channelId);
    io.emit("stateUpdate", state);
  });

  socket.on("updateTrack", ({ channelId, key, value }) => {
    const channel = state.channels.find(c => c.id === channelId);
    if (channel) {
      channel[key] = value;
      io.emit("stateUpdate", state);
    }
  });

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
    state.channels.forEach(ch => {
      ch.pattern = Array(state.steps).fill(false);
    });
    io.emit("stateUpdate", state);
  });

  socket.on("disconnect", () => {
    userCount--;
    io.emit("userCount", userCount);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
