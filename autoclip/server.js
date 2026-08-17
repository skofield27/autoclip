// server.js
const express = require("express");
const path = require("path");
const { createJob, getJob } = require("./src/jobs");
const { getInfo } = require("./src/downloader");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/clips", express.static(path.join(__dirname, "clips")));

// Quick metadata lookup — lets the frontend show a title/thumbnail/duration
// preview before committing to a full download.
app.post("/api/info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    const info = await getInfo(url);
    res.json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/jobs", (req, res) => {
  const { url, mode } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  if (!["ai", "fixed", "manual"].includes(mode)) {
    return res.status(400).json({ error: "mode must be ai, fixed, or manual" });
  }
  if (mode === "manual" && (!Array.isArray(req.body.segments) || !req.body.segments.length)) {
    return res.status(400).json({ error: "manual mode needs a non-empty segments array" });
  }
  const id = createJob(req.body);
  res.json({ jobId: id });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found (it may have expired)" });
  res.json({
    id: job.id,
    status: job.status,
    message: job.message,
    error: job.error,
    videoTitle: job.videoTitle || null,
    clips: job.clips,
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasAssemblyAIKey: !!process.env.ASSEMBLYAI_API_KEY,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`autoclip listening on :${PORT}`));
