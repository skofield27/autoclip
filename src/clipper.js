// src/clipper.js
// Cuts one segment out of a source video with ffmpeg. Re-encodes (rather than
// stream-copying) so cuts are frame-accurate at arbitrary timestamps instead
// of snapping to the nearest keyframe.

const { spawn } = require("child_process");

// ffmpeg-static downloads a platform-appropriate static binary at
// `npm install` time — no apt/Docker/system ffmpeg required.
const FFMPEG_BIN = (() => {
  try {
    return require("ffmpeg-static") || "ffmpeg";
  } catch {
    return "ffmpeg"; // fall back to PATH lookup for local dev
  }
})();

function run(args, timeoutMs = 3 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Cut [startSec, endSec) from inputPath into outputPath.
 * vertical=true reframes to 1080x1920 by scale-to-cover + center crop —
 * a plain center crop, not face/subject tracking. Good enough as a default,
 * but callers who need the subject perfectly centered should crop manually
 * afterward.
 */
async function cutClip(inputPath, outputPath, startSec, endSec, { vertical = false } = {}) {
  const duration = Math.max(0.5, endSec - startSec);
  const args = [
    "-y",
    "-ss",
    String(Math.max(0, startSec)),
    "-i",
    inputPath,
    "-t",
    String(duration),
  ];

  if (vertical) {
    args.push(
      "-vf",
      "scale=w=1080:h=1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"
    );
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath
  );

  await run(args);
  return outputPath;
}

/** Extract mono 16kHz audio for transcription (small, fast to upload). */
async function extractAudio(inputPath, outputPath) {
  await run([
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "4",
    outputPath,
  ]);
  return outputPath;
}

/** Probe duration (seconds) via ffmpeg's stderr banner — no ffprobe dependency needed. */
async function getDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, ["-i", inputPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return reject(new Error("Could not parse duration"));
      const [, h, min, s] = m;
      resolve(Number(h) * 3600 + Number(min) * 60 + Number(s));
    });
    child.on("error", reject);
  });
}

module.exports = { cutClip, extractAudio, getDuration };
