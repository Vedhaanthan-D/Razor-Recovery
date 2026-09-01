require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const healthRoute = require("./routes/health");
const webhookRoute = require("./routes/webhook");
const dashboardRoute = require("./routes/dashboard");
const insightsRoute = require("./routes/insights");
const testRoute = require("./routes/test");

const app = express();

app.use(cors());
// Capture the raw body so the Razorpay webhook can verify the HMAC over exact bytes.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.use("/api", healthRoute);
app.use("/api", webhookRoute);
app.use("/api", dashboardRoute);
app.use("/api", insightsRoute);
app.use("/api/debug", testRoute);

// Explicit 404 for unmatched /api/* requests so mistyped endpoints return JSON, not the SPA fallback index.html.
app.use("/api", (req, res) => res.status(404).json({ error: "not found", path: req.originalUrl }));

// Serve the built frontend + SPA history-fallback, so a single URL (Express) can back the whole
// demo. Registered AFTER every /api route so it never swallows a real API request. Dev doesn't hit
// this path — Vite serves the frontend and proxies /api here (see frontend/vite.config.ts). Note:
// __dirname is Backend/src, so dist is two levels up at the repo root.
// ponytail: an unknown GET /api/* now returns index.html instead of a 404; scope the catch-all
// away from /api if that ever confuses a client's JSON.parse.
const distDir = path.join(__dirname, "..", "..", "frontend", "dist");
app.use(express.static(distDir));
app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
