
"use strict";

/* =========================================================
   STATE
========================================================= */

const state = {
  videoId: "",
  videoTitle: "",
  isIndexed: false,
  isBusy: false,
  backendUrl:
    "https://live-youtube-rag-assistant-production.up.railway.app",
};

let chatHistory = [];

/* =========================================================
   DOM HELPERS
========================================================= */

const $ = (id) => document.getElementById(id);

const dom = {
  statusDot: $("statusDot"),

  videoBar: $("videoBar"),
  videoThumb: $("videoThumb"),
  videoTitle: $("videoTitle"),
  videoMeta: $("videoMeta"),

  indexBadge: $("indexBadge"),

  onboarding: $("onboarding"),
  manualInput: $("manualInput"),
  manualLoadBtn: $("manualLoadBtn"),

  indexSection: $("indexSection"),
  indexBtn: $("indexBtn"),
  indexBtnLabel: $("indexBtnLabel"),

  progressWrap: $("progressWrap"),
  progressFill: $("progressFill"),
  progressLabel: $("progressLabel"),

  chatSection: $("chatSection"),
  chatMessages: $("chatMessages"),
  suggestionsRow: $("suggestionsRow"),

  inputBar: $("inputBar"),
  questionInput: $("questionInput"),
  sendBtn: $("sendBtn"),

  footerBar: $("footerBar"),
  exportBtn: $("exportBtn"),
  clearBtn: $("clearBtn"),
};

/* =========================================================
   BOOT
========================================================= */

document.addEventListener("DOMContentLoaded", async () => {
  const saved = await chrome.storage.local.get("backendUrl");

  if (saved.backendUrl) {
    state.backendUrl = saved.backendUrl;
  }

  checkBackend();
  await detectVideo();
  bindEvents();
});

/* =========================================================
   BACKEND HEALTH
========================================================= */

async function checkBackend() {
  setStatus("checking");

  try {
    const res = await fetch(`${state.backendUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });

    setStatus(res.ok ? "online" : "offline");
  } catch {
    setStatus("offline");
    dom.statusDot.title =
      "Backend offline — start your FastAPI server";
  }
}

function setStatus(status) {
  dom.statusDot.className = `status-dot ${status}`;

  const labels = {
    online: "Backend connected",
    offline: "Backend offline",
    checking: "Checking…",
  };

  dom.statusDot.title = labels[status] || status;
}

/* =========================================================
   VIDEO DETECTION
========================================================= */

async function detectVideo() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.url) {
      return showOnboarding();
    }

    const url = new URL(tab.url);

    let vid = null;

    if (
      url.hostname.includes("youtube.com") &&
      url.searchParams.has("v")
    ) {
      vid = url.searchParams.get("v");
    } else if (url.hostname === "youtu.be") {
      vid = url.pathname.slice(1);
    }

    if (!vid) {
      return showOnboarding();
    }

    const title =
      tab.title?.replace(/ ?[-–|] YouTube$/, "").trim() || vid;

    await loadVideo(vid, title);
  } catch (err) {
    console.warn("detectVideo:", err);
    showOnboarding();
  }
}

function showOnboarding() {
  dom.onboarding.classList.remove("hidden");
}

/* =========================================================
   LOAD VIDEO
========================================================= */

async function loadVideo(vid, title) {
  if (!vid) return;

  state.videoId = vid;
  state.videoTitle = title || vid;

  dom.videoBar.classList.remove("hidden");

  dom.videoThumb.src =
    `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;

  dom.videoTitle.textContent = state.videoTitle;
  dom.videoMeta.textContent = vid;

  const local = await chrome.storage.local.get(
    `indexed_${vid}`
  );

  if (local[`indexed_${vid}`]) {
    markAsIndexed(local[`indexed_${vid}`]);
    return;
  }

  try {
    const res = await fetch(
      `${state.backendUrl}/status/${vid}`,
      {
        signal: AbortSignal.timeout(3000),
      }
    );

    const data = await res.json();

    if (data.indexed) {
      markAsIndexed("disk");
      return;
    }
  } catch {
    console.log("Backend offline");
  }

  setBadge("pending", "Not indexed");
  dom.indexSection.classList.remove("hidden");
}

/* =========================================================
   INDEX MANAGEMENT
========================================================= */

function markAsIndexed(source) {
  state.isIndexed = true;

  const label =
    source === "disk"
      ? "Ready (cached)"
      : `Ready · ${source} chunks`;

  setBadge("ready", label);

  dom.indexSection.classList.add("hidden");

  showChat();
  loadChatHistory();
}

async function indexVideo() {
  if (!state.videoId || state.isBusy) return;

  state.isBusy = true;

  dom.indexBtn.disabled = true;
  dom.indexBtnLabel.textContent = "Indexing…";

  setBadge("indexing", "Indexing…");

  dom.progressWrap.classList.remove("hidden");

  const steps = [
    {
      pct: 15,
      label: "Fetching transcript…",
    },
    {
      pct: 40,
      label: "Splitting into chunks…",
    },
    {
      pct: 65,
      label: "Generating embeddings…",
    },
    {
      pct: 85,
      label: "Building FAISS index…",
    },
    {
      pct: 95,
      label: "Saving to disk…",
    },
  ];

  let stepIndex = 0;

  const ticker = setInterval(() => {
    if (stepIndex < steps.length) {
      const step = steps[stepIndex++];

      dom.progressFill.style.width = `${step.pct}%`;
      dom.progressLabel.textContent = step.label;
    }
  }, 2000);

  try {
    const res = await fetch(
      `${state.backendUrl}/ingest`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          video_id: state.videoId,
        }),
      }
    );

    const data = await res.json();

    clearInterval(ticker);

    if (data.error) {
      throw new Error(data.error);
    }

    dom.progressFill.style.width = "100%";
    dom.progressLabel.textContent = "Done!";

    const chunks = data.chunks ?? "–";

    await chrome.storage.local.set({
      [`indexed_${state.videoId}`]: chunks,
    });

    await sleep(700);

    markAsIndexed(chunks);
  } catch (err) {
    clearInterval(ticker);

    dom.progressFill.style.background =
      "var(--danger)";

    dom.progressLabel.textContent =
      "Error: " + err.message;

    setBadge("error", "Failed");

    dom.indexBtn.disabled = false;
    dom.indexBtnLabel.textContent = "Retry";
  } finally {
    state.isBusy = false;
  }
}

