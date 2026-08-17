const $ = (id) => document.getElementById(id);

let currentMode = "ai";
let manualRowCount = 0;
let pollTimer = null;
let startedAt = null;
let timerInterval = null;

const STATUS_LABEL = {
  queued: "STANDBY",
  downloading: "REC ●",
  transcribing: "REC ●",
  analyzing: "REC ●",
  clipping: "REC ●",
  done: "SELESAI",
  error: "ERROR",
};

function fmtTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function showError(msg) {
  const el = $("errorBanner");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function clearError() {
  $("errorBanner").classList.add("hidden");
}

// ---------- URL preview ----------
$("checkBtn").addEventListener("click", checkUrl);
$("urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") checkUrl(); });

async function checkUrl() {
  const url = $("urlInput").value.trim();
  $("urlError").classList.add("hidden");
  if (!url) return;

  $("checkBtn").disabled = true;
  $("checkBtn").textContent = "...";
  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Gagal ambil info video");

    $("previewThumb").src = data.thumbnail || "";
    $("previewTitle").textContent = data.title || "(tanpa judul)";
    $("previewMeta").textContent = `${data.extractor || "?"} · ${fmtTime(data.duration || 0)}`;
    $("preview").classList.remove("hidden");
    $("modeSection").classList.remove("hidden");
    $("startBtn").disabled = false;
    $("urlInput").dataset.duration = data.duration || 0;
  } catch (e) {
    $("urlError").textContent = e.message;
    $("urlError").classList.remove("hidden");
    $("modeSection").classList.add("hidden");
    $("startBtn").disabled = true;
  } finally {
    $("checkBtn").disabled = false;
    $("checkBtn").textContent = "CEK";
  }
}

// ---------- mode dial ----------
document.querySelectorAll(".dial-opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".dial-opt").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    currentMode = btn.dataset.mode;
    ["ai", "fixed", "manual"].forEach((m) =>
      $(`fields-${m}`).classList.toggle("hidden", m !== currentMode)
    );
    if (currentMode === "manual" && manualRowCount === 0) addManualRow();
  });
});

// ---------- manual rows ----------
$("addRowBtn").addEventListener("click", addManualRow);

function addManualRow() {
  manualRowCount++;
  const row = document.createElement("div");
  row.className = "manual-row";
  row.innerHTML = `
    <input type="number" class="ts start" placeholder="mulai (s)" min="0" step="1" />
    <span class="dash">–</span>
    <input type="number" class="ts end" placeholder="selesai (s)" min="0" step="1" />
    <input type="text" class="hook" placeholder="caption/hook (opsional)" />
    <button type="button" class="rm" title="Hapus">×</button>
  `;
  row.querySelector(".rm").addEventListener("click", () => { row.remove(); });
  $("manualRows").appendChild(row);
}

// ---------- start job ----------
$("startBtn").addEventListener("click", startJob);

function collectParams() {
  const url = $("urlInput").value.trim();
  const vertical = $("verticalToggle").checked;
  const base = { url, mode: currentMode, vertical };

  if (currentMode === "ai") {
    return {
      ...base,
      numClips: Number($("aiNumClips").value) || 3,
      minLen: Number($("aiMinLen").value) || 15,
      maxLen: Number($("aiMaxLen").value) || 60,
    };
  }
  if (currentMode === "fixed") {
    return { ...base, fixedDuration: Number($("fixedDuration").value) || 30 };
  }
  // manual
  const segments = Array.from(document.querySelectorAll(".manual-row")).map((row) => ({
    start: Number(row.querySelector(".start").value) || 0,
    end: Number(row.querySelector(".end").value) || 0,
    hook: row.querySelector(".hook").value || "",
  })).filter((s) => s.end > s.start);

  return { ...base, segments };
}

async function startJob() {
  clearError();
  const params = collectParams();
  if (params.mode === "manual" && !params.segments.length) {
    showError("Isi minimal 1 timestamp yang valid (selesai > mulai) dulu ya.");
    return;
  }

  $("startBtn").disabled = true;
  $("resultsSection").classList.add("hidden");
  $("osdSection").classList.remove("hidden");
  $("osdDot").classList.add("blink");
  startedAt = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    $("osdTimer").textContent = fmtTime((Date.now() - startedAt) / 1000);
  }, 500);

  try {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Gagal mulai job");
    pollJob(data.jobId);
  } catch (e) {
    finishWithError(e.message);
  }
}

function pollJob(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || "Job gak ketemu");

      $("osdStatus").textContent = STATUS_LABEL[job.status] || job.status.toUpperCase();
      $("osdMsg").textContent = job.message || "";

      if (job.status === "done") {
        clearInterval(pollTimer);
        clearInterval(timerInterval);
        $("osdDot").classList.remove("blink");
        renderResults(job);
        $("startBtn").disabled = false;
      } else if (job.status === "error") {
        clearInterval(pollTimer);
        clearInterval(timerInterval);
        finishWithError(job.error || "Gagal proses video");
      }
    } catch (e) {
      clearInterval(pollTimer);
      clearInterval(timerInterval);
      finishWithError(e.message);
    }
  }, 2000);
}

function finishWithError(msg) {
  $("osdDot").classList.remove("blink");
  $("osdStatus").textContent = "ERROR";
  $("startBtn").disabled = false;
  showError(msg);
}

function renderResults(job) {
  $("resultsCount").textContent = `${job.clips.length} KLIP`;
  const grid = $("resultsGrid");
  grid.innerHTML = "";
  job.clips.forEach((clip, i) => {
    const card = document.createElement("div");
    card.className = "clip-card";
    card.innerHTML = `
      <video src="${clip.url}" controls preload="metadata"></video>
      <div class="clip-meta">
        <div class="clip-time mono">#${i + 1} · ${fmtTime(clip.start)}–${fmtTime(clip.end)}</div>
        <div class="clip-hook">${clip.hook ? escapeHtml(clip.hook) : ""}</div>
        <a class="clip-dl" href="${clip.url}" download>DOWNLOAD</a>
      </div>
    `;
    grid.appendChild(card);
  });
  $("resultsSection").classList.remove("hidden");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
