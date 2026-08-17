// src/highlighter.js
// Sends the transcript to Claude and asks it to pick the N most engaging
// segments to cut as standalone short-form clips. This is AI-highlight mode
// only — fixed-split and manual modes skip this file entirely.

const MODEL = "claude-sonnet-5"; // swap via ANTHROPIC_MODEL env var if you want a different tier

function requireApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. AI-highlight mode needs it to pick moments — get one at console.anthropic.com and add it as an env var."
    );
  }
  return key;
}

/** Group raw words (ms timestamps) into ~sentence chunks with second timestamps, to keep the prompt compact. */
function buildTimestampedTranscript(words) {
  const chunks = [];
  let current = { text: "", startMs: null, endMs: null };
  for (const w of words) {
    if (current.startMs === null) current.startMs = w.start;
    current.text += (current.text ? " " : "") + w.text;
    current.endMs = w.end;
    if (/[.?!]$/.test(w.text) || current.text.split(" ").length > 25) {
      chunks.push(current);
      current = { text: "", startMs: null, endMs: null };
    }
  }
  if (current.text) chunks.push(current);

  return chunks
    .map((c) => `[${(c.startMs / 1000).toFixed(1)}s-${(c.endMs / 1000).toFixed(1)}s] ${c.text}`)
    .join("\n");
}

/**
 * Ask Claude to pick `numClips` segments, each between minLen-maxLen seconds,
 * from a transcript covering a video of `durationSec` total length.
 * Returns [{start, end, hook, reason}], timestamps clamped to valid range.
 */
async function findHighlights(words, durationSec, { numClips = 3, minLen = 15, maxLen = 60 } = {}) {
  const apiKey = requireApiKey();
  const transcript = buildTimestampedTranscript(words);

  const system = `You are a short-form video editor picking the most engaging moments from a transcript to cut into standalone clips (TikTok/Reels/Shorts style). Respond with ONLY a JSON array, no prose, no markdown code fences. Each element: {"start": number, "end": number, "hook": string, "reason": string}. "start"/"end" are seconds and MUST come from the given timestamps. "hook" is a short (<10 word) caption idea in the same language as the transcript. Pick moments that are self-contained (make sense without earlier context), have a clear payoff/punchline/insight, and stay within ${minLen}-${maxLen} seconds each. Do not overlap segments.`;

  const user = `Video duration: ${durationSec.toFixed(1)}s\nPick exactly ${numClips} clip(s).\n\nTranscript:\n${transcript}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const raw = json.content?.find((b) => b.type === "text")?.text || "[]";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let segments;
  try {
    segments = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Could not parse Claude's response as JSON: ${cleaned.slice(0, 300)}`);
  }

  // Clamp/validate against real video bounds so a model slip-up can't produce
  // an out-of-range ffmpeg cut.
  return segments
    .map((s) => ({
      start: Math.max(0, Math.min(Number(s.start) || 0, durationSec - 1)),
      end: Math.max(0, Math.min(Number(s.end) || 0, durationSec)),
      hook: s.hook || "",
      reason: s.reason || "",
    }))
    .filter((s) => s.end - s.start >= 3)
    .slice(0, numClips);
}

module.exports = { findHighlights };
