const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// IMPORTANT: allow Netlify + Discord iframe
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

const STEPS = 16;
let bpm = 100;
let step = 0;

let grid = {
  kick: Array(STEPS).fill(false),
  snare: Array(STEPS).fill(false),
  hihat: Array(STEPS).fill(false)
};

// Prevent Render from sleeping as aggressively
app.get("/", (req, res) => {
  res.send("Server is running");
});

// 🔥 Server-controlled timing loop
setInterval(() => {
  step = (step + 1) % STEPS;

  io.emit("tick", {
    step,
    grid,
    bpm,
    time: Date.now()
  });

}, (60000 / bpm) / 4);

// Socket logic
io.on("connection", (socket) => {
  console.log("User connected");

  socket.emit("init", { grid, bpm });

  socket.on("toggleStep", ({ instrument, stepIndex }) => {
    grid[instrument][stepIndex] = !grid[instrument][stepIndex];
    io.emit("gridUpdate", grid);
  });

  socket.on("setBPM", (newBpm) => {
    bpm = newBpm;
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
