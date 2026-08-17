// scripts/install-yt-dlp.js
// Downloads the standalone yt-dlp Linux binary into ./bin at npm-install time.
// This is what makes the app deployable on plain Node buildpacks (Render's
// native runtime, Railway's Nixpacks, etc.) without Docker or Python — the
// binary is self-contained, no interpreter needed.
const https = require("https");
const fs = require("fs");
const path = require("path");

const BIN_DIR = path.join(__dirname, "..", "bin");
const DEST = path.join(BIN_DIR, "yt-dlp");
// yt-dlp_linux is the standalone PyInstaller build (~30MB, embeds its own
// Python) — unlike the plain "yt-dlp" zipapp artifact, it needs nothing
// preinstalled on the host. That matters here since Render's native Node
// runtime has no system Python.
const URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          return resolve(download(res.headers.location, dest, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

(async () => {
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    console.log("Downloading yt-dlp standalone binary...");
    await download(URL, DEST);
    fs.chmodSync(DEST, 0o755);
    console.log("yt-dlp installed at", DEST);
    process.exit(0);
  } catch (e) {
    console.error("Failed to install yt-dlp:", e.message);
    console.error("The app will still start, but downloads will fail until this is fixed.");
    // Don't fail the whole `npm install` over this — let the app boot so
    // /api/health is reachable for debugging.
    process.exit(0);
  }
})();
