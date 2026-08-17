// src/transcriber.js
// Speech-to-text via AssemblyAI, used only for AI-highlight mode (fixed-split
// and manual-timestamp modes never call this — they don't need a transcript).
// Free tier is generous enough for testing: https://www.assemblyai.com/dashboard

const fs = require("fs");

const API_BASE = "https://api.assemblyai.com/v2";

function requireApiKey() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    throw new Error(
      "ASSEMBLYAI_API_KEY is not set. AI-highlight mode needs it for transcription — get a free key at assemblyai.com and add it as an env var."
    );
  }
  return key;
}

async function uploadAudio(filePath) {
  const apiKey = requireApiKey();
  const data = fs.readFileSync(filePath);
  const res = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/octet-stream" },
    body: data,
  });
  if (!res.ok) throw new Error(`AssemblyAI upload failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.upload_url;
}

async function requestTranscript(uploadUrl) {
  const apiKey = requireApiKey();
  const res = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: uploadUrl,
      auto_highlights: true,
      punctuate: true,
      format_text: true,
    }),
  });
  if (!res.ok) throw new Error(`AssemblyAI transcript request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id;
}

async function pollTranscript(id, { intervalMs = 3000, timeoutMs = 10 * 60 * 1000 } = {}) {
  const apiKey = requireApiKey();
  const started = Date.now();
  while (true) {
    const res = await fetch(`${API_BASE}/transcript/${id}`, {
      headers: { authorization: apiKey },
    });
    if (!res.ok) throw new Error(`AssemblyAI poll failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    if (json.status === "completed") return json;
    if (json.status === "error") throw new Error(`AssemblyAI transcription error: ${json.error}`);
    if (Date.now() - started > timeoutMs) throw new Error("AssemblyAI transcription timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Full pipeline: local audio file -> transcript with word-level timestamps.
 * Returns { text, words: [{text, start, end}] (ms), highlights: [{text, rank, timestamps}] }
 */
async function transcribe(audioFilePath) {
  const uploadUrl = await uploadAudio(audioFilePath);
  const id = await requestTranscript(uploadUrl);
  const result = await pollTranscript(id);
  return {
    text: result.text || "",
    words: result.words || [], // [{text, start, end, confidence}], start/end in ms
    highlights: result.auto_highlights_result?.results || [],
  };
}

module.exports = { transcribe };
