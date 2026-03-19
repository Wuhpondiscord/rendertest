const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const cors = require("cors");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// OPEN CORS - This ensures the browser doesn't block the request
app.use(cors({ origin: "*" }));
app.use(express.json());

const io = new Server(server, { 
  cors: { origin: "*" } 
});

let savedProjects = {};
let state = { bpm: 120, steps: 16, channels: [] };

// Config for Frontend
app.get("/api/config", (req, res) => {
  res.json({ clientId: process.env.VITE_CLIENT_ID });
});

// Discord Token Exchange
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
        redirect_uri: "https://127.0.0.1", 
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Auth failed" });
  }
});

app.get("/", (req, res) => res.send("DAW Server Online"));

// Socket handlers
io.on("connection", (socket) => {
  socket.emit("initState", state);
  socket.on("addTrack", (author) => {
    state.channels.push({ id: "tr_" + crypto.randomUUID(), author: author || "Producer", inst: "Keys - Piano", note: "C4", vol: -6, speed: 2, pattern: Array(state.steps).fill(false) });
    io.emit("stateUpdate", state);
  });
  socket.on("toggleStep", ({ channelId, stepIndex, val }) => {
    const ch = state.channels.find(c => c.id === channelId);
    if (ch) { ch.pattern[stepIndex] = val; socket.broadcast.emit("stepToggled", { channelId, stepIndex, val }); }
  });
});

server.listen(PORT, () => console.log("Backend running on " + PORT));
