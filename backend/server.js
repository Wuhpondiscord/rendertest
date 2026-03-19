const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const cors = require("cors");

// Discord Docs require node-fetch or similar for server-side token exchange
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);

// Use Port from environment (for Render/Heroku) or 3001 for local
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

/**
 * DISCORD DOCS COMPLIANCE: Socket.io Configuration
 * We use 'websocket' and 'polling' to ensure stability through the Discord Proxy.
 */
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  path: "/socket.io"
});

/**
 * MULTIPLAYER INSTANCE MANAGEMENT
 * Discord Docs: "Instance IDs are generated when a user launches an application. 
 * Any users joining the same application will receive the same instanceId."
 */
let instances = {}; // Store states keyed by discordSdk.instanceId
let savedProjects = {}; // Global library of saved beats

/**
 * DISCORD AUTHENTICATION (Step 5 of Discord Docs)
 * Securely exchange the 'code' from the frontend for an 'access_token'.
 */
app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).send({ error: "Missing code" });

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
    console.error("Discord Auth Error:", err);
    res.status(500).send({ error: "Auth exchange failed" });
  }
});

app.get("/", (req, res) => res.send("Discord Studio Server - Documentation Compliant"));

// Helper to create a fresh state for a new room/instance
const createInitialState = (instanceId) => ({
  instanceId,
  projectName: "New Jam",
  bpm: 120,
  steps: 16,
  isPlaying: false,
  channels: []
});

io.on("connection", (socket) => {
  /**
   * DISCORD DOCS COMPLIANCE: Instance Identification
   * We pass the instanceId from the frontend during the handshake.
   */
  const instanceId = socket.handshake.query.instanceId;
  
  if (!instanceId) {
    console.log("Connection rejected: No instanceId provided.");
    return socket.disconnect();
  }

  socket.join(instanceId);

  // Initialize instance state if it doesn't exist
  if (!instances[instanceId]) {
    instances[instanceId] = createInitialState(instanceId);
  }

  const state = instances[instanceId];

  // Send the specific instance state to the joining user
  socket.emit("initState", state);
  socket.emit("projectList", Object.keys(savedProjects));

  // --- Track Management ---

  socket.on("addTrack", (userData) => {
    const newTrack = {
      id: crypto.randomUUID(),
      author: userData.username || "Unknown",
      color: userData.color || "#00d4ff",
      inst: "Keys - Grand Piano",
      note: "C4",
      vol: -12,
      speed: 1.0, // Per-track BPM multiplier
      pattern: Array(state.steps).fill(false),
      sampleUrl: null // Placeholder for custom audio
    };
    state.channels.push(newTrack);
    io.to(instanceId).emit("stateUpdate", state);
  });

  socket.on("removeTrack", (trackId) => {
    state.channels = state.channels.filter(t => t.id !== trackId);
    io.to(instanceId).emit("stateUpdate", state);
  });

  // --- Real-time Sync ---

  socket.on("toggleStep", ({ trackId, stepIndex, val }) => {
    const track = state.channels.find(t => t.id === trackId);
    if (track) {
      track.pattern[stepIndex] = val;
      // Broadcast to others in the same Discord Instance
      socket.to(instanceId).emit("stepToggled", { trackId, stepIndex, val });
    }
  });

  socket.on("updateTrackParam", ({ trackId, key, value }) => {
    const track = state.channels.find(t => t.id === trackId);
    if (track) {
      track[key] = value;
      // Sync parameters (Volume, Speed/BPM, Instrument)
      socket.to(instanceId).emit("trackParamUpdated", { trackId, key, value });
    }
  });

  // --- Transport Controls ---

  socket.on("setBPM", (newBpm) => {
    state.bpm = newBpm;
    io.to(instanceId).emit("bpmUpdate", newBpm);
  });

  socket.on("togglePlay", (playing) => {
    state.isPlaying = playing;
    io.to(instanceId).emit("playUpdate", playing);
  });

  // --- Save/Load Persistence ---

  socket.on("saveProject", (name) => {
    if (!name) return;
    state.projectName = name;
    // Store a snapshot of the current state
    savedProjects[name] = JSON.parse(JSON.stringify(state));
    io.emit("projectList", Object.keys(savedProjects));
  });

  socket.on("loadProject", (name) => {
    if (savedProjects[name]) {
      // Replace the room's current state with the saved project
      instances[instanceId] = JSON.parse(JSON.stringify(savedProjects[name]));
      instances[instanceId].instanceId = instanceId; // Keep the current Instance ID
      instances[instanceId].isPlaying = false;
      io.to(instanceId).emit("stateUpdate", instances[instanceId]);
    }
  });

  socket.on("disconnect", () => {
    const room = io.sockets.adapter.rooms.get(instanceId);
    if (!room || room.size === 0) {
      // Optional: Cleanup instance from memory if everyone left
      // delete instances[instanceId];
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n--- Discord Activity DAW Server ---`);
  console.log(`Instance Manager: Active`);
  console.log(`Port: ${PORT}\n`);
});
