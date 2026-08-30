const { Router } = require("express");
const { generateInsight, answerQuestion } = require("../agents/insightsService");

const router = Router();

// GET /api/insights — natural-language summary of the dashboard aggregate.
// Caching + never-throws live in the service; the route is a thin passthrough.
router.get("/insights", async (_req, res) => {
  const out = await generateInsight(); // never throws — worst case is a templated fallback
  res.json(out);
});

// POST /api/insights/ask — bounded Q&A over the dashboard's OWN data. { question } -> { answer }.
// Input validation, the reused per-session LLM ceiling, and the never-throws behaviour all live in
// the service; here we just map its result to a status code. Not cached — every question differs.
router.post("/insights/ask", async (req, res) => {
  const out = await answerQuestion(req.body && req.body.question); // never throws
  if (out.ok) return res.json({ answer: out.answer });
  return res.status(out.status).json({ error: out.error });
});

module.exports = router;
