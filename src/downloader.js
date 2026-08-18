// src/downloader.js
// Thin wrapper around the yt-dlp binary. yt-dlp supports YouTube, TikTok,
// Instagram, X/Twitter, Facebook, and 1800+ other sites, so this file is
// intentionally platform-agnostic — we never branch on "which platform".
//
// Two things are NOT guaranteed to work out of the box:
//  1. YouTube increasingly blocks requests from cloud/datacenter IPs with
//     "Sign in to confirm you're not a bot". Fix: provide cookies from a
//     logged-in YouTube session — see YTDLP_COOKIES_CONTENT below. Also
//     matters for private/age-gated content on any platform.
//  2. TikTok/Instagram change their site frequently and can break yt-dlp's
//     extractor for a few days until upstream ships a fix. If a download
//     fails with a 4xx/extraction error, redeploy to pull the latest
//     yt-dlp binary via scripts/install-yt-dlp.js.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Two ways to supply cookies:
//  - YTDLP_COOKIES_FILE: path to a cookies.txt already on disk (local dev)
//  - YTDLP_COOKIES_CONTENT: the cookies.txt *contents* pasted directly into
//    an env var (what you want on Railway/Render — never commit a real
//    cookies.txt to a public repo, since it's basically a session token).
//    We write it to a local tmp file once at startup and use that.
function resolveCookiesFile() {
  const direct = process.env.YTDLP_COOKIES_FILE;
  if (direct && fs.existsSync(direct)) return direct;

  const content = process.env.YTDLP_COOKIES_CONTENT;
  if (content && content.trim()) {
    const dest = path.join(__dirname, "..", "tmp", "cookies.txt");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, { mode: 0o600 });
    return dest;
  }
  return null;
}

const COOKIES_FILE = resolveCookiesFile();

// Prefer the standalone binary fetched by scripts/install-yt-dlp.js at
// `npm install` time (works with no system Python/Docker). Falls back to
// whatever `yt-dlp` is on PATH — handy for local dev if you already have it
// installed via brew/pip.
const BUNDLED_BIN = path.join(__dirname, "..", "bin", "yt-dlp");
const YTDLP_BIN = fs.existsSync(BUNDLED_BIN) ? BUNDLED_BIN : "yt-dlp";

function baseArgs() {
  const args = ["--no-warnings", "--no-playlist", "--no-progress", "--verbose"];
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    args.push("--cookies", COOKIES_FILE);
  }
  // yt-dlp needs to shell out to ffmpeg for merging separate video+audio
  // streams and for post-processing. Point it at ffmpeg-static's bundled
  // binary rather than hoping ffmpeg is on PATH.
  try {
    const ffmpegPath = require("ffmpeg-static");
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
  } catch {
    /* ffmpeg-static not installed — fall back to PATH lookup */
  }
  return args;
}

function run(args, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start yt-dlp at "${YTDLP_BIN}": ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        // The most useful debug lines (yt-dlp version, whether cookies
        // loaded, which player client was tried) are near the START of
        // verbose output, with the final error at the END. Show both ends
        // instead of just the tail, or we're debugging blind.
        const head = stderr.slice(0, 1200);
        const tail = stderr.slice(-1200);
        const body = stderr.length > 2400 ? `${head}\n...[snip]...\n${tail}` : stderr;
        reject(new Error(`yt-dlp exited with code ${code}:\n${body}`));
      }
    });
  });
}

/**
 * Fetch metadata only (no download). Fast, used to show a preview /
 * validate the URL before committing to a full download.
 */
async function getInfo(url) {
  const args = [...baseArgs(), "--dump-json", "--skip-download", url];
  const { stdout } = await run(args, { timeoutMs: 60 * 1000 });
  // yt-dlp can print one JSON object per line for multi-video URLs; we only
  // support single videos (--no-playlist above), so take the first line.
  const line = stdout.trim().split("\n")[0];
  const info = JSON.parse(line);
  return {
    id: info.id,
    title: info.title,
    duration: info.duration || 0, // seconds
    thumbnail: info.thumbnail || null,
    uploader: info.uploader || null,
    extractor: info.extractor || null,
    webpage_url: info.webpage_url || url,
  };
}

/**
 * Download the source video into outDir. Returns the absolute file path.
 * Caps resolution at 1080p to keep download + ffmpeg processing time sane —
 * short-form clips don't need more than that.
 */
async function downloadVideo(url, outDir, jobId) {
  fs.mkdirSync(outDir, { recursive: true });
  const outputTemplate = path.join(outDir, `${jobId}.%(ext)s`);
  const args = [
    ...baseArgs(),
    "-f",
    "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    url,
  ];
  await run(args, { timeoutMs: 15 * 60 * 1000 });

  const expected = path.join(outDir, `${jobId}.mp4`);
  if (fs.existsSync(expected)) return expected;

  // Fallback: in rare cases yt-dlp writes a different extension despite
  // --merge-output-format (e.g. no video track to merge). Find whatever it wrote.
  const match = fs
    .readdirSync(outDir)
    .find((f) => f.startsWith(jobId + "."));
  if (!match) throw new Error("yt-dlp reported success but no output file was found");
  return path.join(outDir, match);
}

module.exports = { getInfo, downloadVideo };
