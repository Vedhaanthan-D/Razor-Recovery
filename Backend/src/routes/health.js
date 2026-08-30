const { Router } = require("express");
const { supabase } = require("../config/supabase");

const router = Router();

// GET /api/health — confirms the process is up AND Supabase is reachable.
router.get("/health", async (_req, res) => {
  const { error } = await supabase.from("payments").select("id").limit(1);
  if (error) {
    return res.status(500).json({ status: "error", db: "error", message: error.message });
  }
  res.json({ status: "ok", db: "connected", uptime: process.uptime() });
});

module.exports = router;
