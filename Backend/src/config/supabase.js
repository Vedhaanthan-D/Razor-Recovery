require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — check Backend/.env (see .env.example)."
  );
}

// Single shared client. All backend DB access goes through this (per CLAUDE.md).
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = { supabase };
