const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const cors = require("cors");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const PORT = 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

const io = new Server(server, { cors: { origin: "*" } });

let savedProjects = {};
let state = { projectId: "session_" + Date.now(), projectName: "Untitled Session", bpm: 120, steps: 16, isPlaying: false, channels: [] };
let userCount = 0;

// IMPORTANT: Config route for the frontend to get the Client ID
app.get("/api/config", (req, res) => {
  res.json({ clientId: process.env.VITE_CLIENT_ID });
});

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
    res.status(500).json({ error: "Auth failed" });
  }
});

app.get("/", (req, res) => res.send("Server Online"));

io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const ch = state.channels.find(c => c.id === channelId);
    if (ch) { ch.pattern[stepIndex] = val; socket.broadcast.emit("stepToggled", { channelId, stepIndex, val }); }
  });

  socket.on("addTrack", (author) => {
    state.channels.push({ id: "tr_" + crypto.randomUUID(), author: author || "Guest", inst: "Keys - Grand Piano", note: "C4", vol: -6, speed: 2, pattern: Array(state.steps).fill(false) });
    io.emit("stateUpdate", state);
  });

  socket.on("removeTrack", (id) => {
    state.channels = state.channels.filter(c => c.id !== id);
    io.emit("stateUpdate", state);
  });

  socket.on("updateTrackParam", ({ channelId, key, value }) => {
    const ch = state.channels.find(c => c.id === channelId);
    if (ch) { ch[key] = value; socket.broadcast.emit("trackParamUpdated", { channelId, key, value }); }
  });

  socket.on("setBPM", (v) => { state.bpm = v; io.emit("bpmUpdate", v); });
  socket.on("togglePlay", (v) => { state.isPlaying = v; io.emit("playUpdate", v); });
  socket.on("disconnect", () => { userCount--; io.emit("userCount", userCount); });
});

server.listen(PORT, () => console.log("DAW Server on 3001"));
