const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3001;
const STEPS = 16;

// Global State
let state = {
  bpm: 120,
  isPlaying: false,
  grid: {
    kick: Array(STEPS).fill(false),
    snare: Array(STEPS).fill(false),
    clap: Array(STEPS).fill(false),
    hihat: Array(STEPS).fill(false),
    openhat: Array(STEPS).fill(false),
    perc: Array(STEPS).fill(false)
  }
};

app.get("/", (req, res) => res.send("Beat Server is running"));

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Send current state to new user
  socket.emit("initState", state);

  // Handle note toggles
  socket.on("toggleStep", ({ instrument, stepIndex }) => {
    state.grid[instrument][stepIndex] = !state.grid[instrument][stepIndex];
    io.emit("gridUpdate", state.grid);
  });

  // Handle BPM changes
  socket.on("setBPM", (newBpm) => {
    state.bpm = newBpm;
    io.emit("bpmUpdate", state.bpm);
  });

  // Handle Play/Pause
  socket.on("togglePlay", (isPlaying) => {
    state.isPlaying = isPlaying;
    io.emit("playUpdate", state.isPlaying);
  });

  // Handle Clear
  socket.on("clearGrid", () => {
    Object.keys(state.grid).forEach(inst => {
      state.grid[inst] = Array(STEPS).fill(false);
    });
    io.emit("gridUpdate", state.grid);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
