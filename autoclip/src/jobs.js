// src/jobs.js
// Simple in-memory job queue. This is a single long-lived container (not
// serverless), so an in-memory Map is fine — no Redis needed for an MVP.
// Jobs and their output files are cleaned up after JOB_TTL_MS.

const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");
const { getInfo, downloadVideo } = require("./downloader");
const { cutClip, extractAudio, getDuration } = require("./clipper");
const { transcribe } = require("./transcriber");
const { findHighlights } = require("./highlighter");

const SOURCES_DIR = path.join(__dirname, "..", "tmp");
const CLIPS_DIR = path.join(__dirname, "..", "clips");
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

fs.mkdirSync(SOURCES_DIR, { recursive: true });
fs.mkdirSync(CLIPS_DIR, { recursive: true });

const jobs = new Map();

function createJob(params) {
  const id = uuid();
  const job = {
    id,
    params,
    status: "queued",
    message: "Menunggu giliran...",
    createdAt: Date.now(),
    clips: null,
    error: null,
  };
  jobs.set(id, job);
  process.nextTick(() => runJob(id).catch((e) => {
    job.status = "error";
    job.error = e.message;
  }));
  return id;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function update(job, status, message) {
  job.status = status;
  job.message = message;
  console.log(`[job ${job.id}] ${status}: ${message}`);
}

async function runJob(id) {
  const job = jobs.get(id);
  const { url, mode, numClips, minLen, maxLen, fixedDuration, segments, vertical } = job.params;

  update(job, "downloading", "Ngambil video dari link...");
  const info = await getInfo(url);
  const sourcePath = await downloadVideo(url, SOURCES_DIR, id);
  const duration = (await getDuration(sourcePath).catch(() => info.duration)) || info.duration;

  let plan; // [{start, end, hook, reason}]

  if (mode === "manual") {
    plan = (segments || []).map((s) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.min(duration, Number(s.end) || 0),
      hook: s.hook || "",
      reason: "manual",
    }));
  } else if (mode === "fixed") {
    const step = Math.max(5, Number(fixedDuration) || 30);
    plan = [];
    for (let t = 0; t < duration; t += step) {
      const end = Math.min(duration, t + step);
      if (end - t < 3) break; // skip a too-short tail clip
      plan.push({ start: t, end, hook: "", reason: "fixed-split" });
    }
  } else if (mode === "ai") {
    update(job, "transcribing", "Transkrip audio (AssemblyAI)...");
    const audioPath = path.join(SOURCES_DIR, `${id}.mp3`);
    await extractAudio(sourcePath, audioPath);
    const transcript = await transcribe(audioPath);
    fs.unlink(audioPath, () => {});

    if (!transcript.words.length) {
      throw new Error("Gak ada suara yang kedetect di video ini — coba mode fixed/manual aja.");
    }

    update(job, "analyzing", "Claude lagi nyari momen paling menarik...");
    plan = await findHighlights(transcript.words, duration, {
      numClips: numClips || 3,
      minLen: minLen || 15,
      maxLen: maxLen || 60,
    });

    if (!plan.length) {
      throw new Error("AI gak nemu momen yang cocok. Coba mode fixed atau manual.");
    }
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }

  update(job, "clipping", `Motong ${plan.length} klip...`);
  const clips = [];
  for (let i = 0; i < plan.length; i++) {
    const seg = plan[i];
    const filename = `${id}_${i + 1}.mp4`;
    const outPath = path.join(CLIPS_DIR, filename);
    await cutClip(sourcePath, outPath, seg.start, seg.end, { vertical: !!vertical });
    clips.push({
      filename,
      start: Number(seg.start.toFixed(1)),
      end: Number(seg.end.toFixed(1)),
      hook: seg.hook || "",
      url: `/clips/${filename}`,
    });
    update(job, "clipping", `Klip ${i + 1}/${plan.length} kelar...`);
  }

  job.clips = clips;
  job.videoTitle = info.title;
  update(job, "done", "Kelar!");

  // schedule cleanup
  setTimeout(() => {
    fs.unlink(sourcePath, () => {});
    for (const c of clips) fs.unlink(path.join(CLIPS_DIR, c.filename), () => {});
    jobs.delete(id);
  }, JOB_TTL_MS);
}

module.exports = { createJob, getJob };
