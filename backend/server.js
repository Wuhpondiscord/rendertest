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
    hihat: Array(STEPS).fill(false),
    tom: Array(STEPS).fill(false),
    bongo: Array(STEPS).fill(false)
  }
};

app.get("/", (req, res) => res.send("Beat Server is running"));

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.emit("initState", state);

  socket.on("toggleStep", ({ instrument, stepIndex }) => {
    state.grid[instrument][stepIndex] = !state.grid[instrument][stepIndex];
    io.emit("gridUpdate", state.grid);
  });

  socket.on("setBPM", (newBpm) => {
    state.bpm = newBpm;
    io.emit("bpmUpdate", state.bpm);
  });

  socket.on("togglePlay", (isPlaying) => {
    state.isPlaying = isPlaying;
    io.emit("playUpdate", state.isPlaying);
  });

  socket.on("clearGrid", () => {
    Object.keys(state.grid).forEach(inst => {
      state.grid[inst] = Array(STEPS).fill(false);
    });
    io.emit("gridUpdate", state.grid);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
