// ── popup.js ─────────────────────────────────────────────
// Full integration: auto-detect YouTube tab, index via backend,
// streaming answers, chat memory per video, export.

"use strict";

// ── State ─────────────────────────────────────────────────
const state = {
  videoId:    "",
  videoTitle: "",
  isIndexed:  false,
  isBusy:     false,        // true while indexing or awaiting answer
  backendUrl: "https://live-youtube-rag-assistant-production.up.railway.app",
};

// History stored as array of { role, text, sources }
let chatHistory = [];

// ── DOM helpers ───────────────────────────────────────────
const $ = id => document.getElementById(id);

const dom = {
  statusDot:      $("statusDot"),
  videoBar:       $("videoBar"),
  videoThumb:     $("videoThumb"),
  videoTitle:     $("videoTitle"),
  videoMeta:      $("videoMeta"),
  indexBadge:     $("indexBadge"),
  onboarding:     $("onboarding"),
  manualInput:    $("manualInput"),
  manualLoadBtn:  $("manualLoadBtn"),
  indexSection:   $("indexSection"),
  indexBtn:       $("indexBtn"),
  indexBtnLabel:  $("indexBtnLabel"),
  progressWrap:   $("progressWrap"),
  progressFill:   $("progressFill"),
  progressLabel:  $("progressLabel"),
  chatSection:    $("chatSection"),
  chatMessages:   $("chatMessages"),
  suggestionsRow: $("suggestionsRow"),
  inputBar:       $("inputBar"),
  questionInput:  $("questionInput"),
  sendBtn:        $("sendBtn"),
  footerBar:      $("footerBar"),
  exportBtn:      $("exportBtn"),
  clearBtn:       $("clearBtn"),
};

// ── Boot ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const saved = await chrome.storage.local.get("backendUrl");
  if (saved.backendUrl) state.backendUrl = saved.backendUrl;

  checkBackend();
  await detectVideo();
  bindEvents();
});

// ── Backend health ────────────────────────────────────────
async function checkBackend() {
  setStatus("checking");
  try {
    const res = await fetch(`${state.backendUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    setStatus(res.ok ? "online" : "offline");
  } catch {
    setStatus("offline");
    dom.statusDot.title = "Backend offline — start your FastAPI server";
  }
}

function setStatus(s) {
  dom.statusDot.className = `status-dot ${s}`;
  const labels = { online: "Backend connected", offline: "Backend offline", checking: "Checking…" };
  dom.statusDot.title = labels[s] || s;
}

// ── Auto-detect current YouTube tab ──────────────────────
async function detectVideo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return showOnboarding();

    const url = new URL(tab.url);

    let vid = null;
    if (url.hostname.includes("youtube.com") && url.searchParams.has("v")) {
      vid = url.searchParams.get("v");
    } else if (url.hostname === "youtu.be") {
      vid = url.pathname.slice(1);
    }

    if (!vid) return showOnboarding();

    const title = tab.title?.replace(/ ?[-–|] YouTube$/, "").trim() || vid;
    await loadVideo(vid, title);

  } catch (err) {
    console.warn("detectVideo:", err);
    showOnboarding();
  }
}

function showOnboarding() {
  dom.onboarding.classList.remove("hidden");
}

// ── Load a video (by ID + title) ─────────────────────────
async function loadVideo(vid, title) {
  if (!vid) return;
  state.videoId    = vid;
  state.videoTitle = title || vid;

  // Populate video bar
  dom.videoBar.classList.remove("hidden");
  dom.videoThumb.src          = `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;
  dom.videoTitle.textContent  = state.videoTitle;
  dom.videoMeta.textContent   = vid;

  // Check if already indexed (backend status endpoint or local flag)
  const local = await chrome.storage.local.get(`indexed_${vid}`);
  if (local[`indexed_${vid}`]) {
    markAsIndexed(local[`indexed_${vid}`]);
  } else {
    // Also check backend (handles server-restart case where disk index exists)
    try {
      const res  = await fetch(`${state.backendUrl}/status/${vid}`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      if (data.indexed) {
        markAsIndexed("disk");
        return;
      }
    } catch { /* backend may be offline */ }

    setBadge("pending", "Not indexed");
    dom.indexSection.classList.remove("hidden");
  }
}

function markAsIndexed(source) {
  state.isIndexed = true;
  const label = source === "disk" ? "Ready (cached)" : `Ready · ${source} chunks`;
  setBadge("ready", label);
  dom.indexSection.classList.add("hidden");
  showChat();
  loadChatHistory();
}

// ── Index the video ───────────────────────────────────────
async function indexVideo() {
  if (!state.videoId || state.isBusy) return;
  state.isBusy = true;

  dom.indexBtn.disabled    = true;
  dom.indexBtnLabel.textContent = "Indexing…";
  setBadge("indexing", "Indexing…");
  dom.progressWrap.classList.remove("hidden");

  // Animate progress steps while we wait for the real response
  const steps = [
    { pct: 15, label: "Fetching transcript…"       },
    { pct: 40, label: "Splitting into chunks…"      },
    { pct: 65, label: "Generating embeddings…"      },
    { pct: 85, label: "Building FAISS index…"       },
    { pct: 95, label: "Saving to disk…"             },
  ];
  let si = 0;
  const ticker = setInterval(() => {
    if (si < steps.length) {
      const s = steps[si++];
      dom.progressFill.style.width  = s.pct + "%";
      dom.progressLabel.textContent = s.label;
    }
  }, 2000);

  try {
    // Step 1 — fetch transcript from browser (your home IP)
// Fetch transcript directly from YouTube's timedtext API
const lang = "en";
const transcriptRes = await fetch(
  `https://www.youtube.com/api/timedtext?lang=${lang}&v=${state.videoId}&fmt=json3`
);
const transcriptData = await transcriptRes.json();

if (!transcriptData.events || transcriptData.events.length === 0) {
  throw new Error("No transcript available for this video");
}

// Flatten all text segments into plain text
const transcript = transcriptData.events
  .filter(e => e.segs)
  .map(e => e.segs.map(s => s.utf8).join(""))
  .join(" ")
  .replace(/\n/g, " ")
  .trim();

if (!transcript) {
  throw new Error("Could not extract transcript text");
}

// Send to Railway for indexing
const res = await fetch(`${state.backendUrl}/ingest-text`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    video_id: state.videoId,
    transcript: transcript,
  }),
});
const data = await res.json();
    clearInterval(ticker);

    if (data.error) throw new Error(data.error);

    dom.progressFill.style.width  = "100%";
    dom.progressLabel.textContent = "Done!";

    const chunks = data.chunks ?? "–";
    await chrome.storage.local.set({ [`indexed_${state.videoId}`]: chunks });

    await sleep(700);
    markAsIndexed(chunks);

  } catch (err) {
    clearInterval(ticker);
    dom.progressFill.style.background = "var(--danger)";
    dom.progressLabel.textContent     = "Error: " + err.message;
    setBadge("error", "Failed");
    dom.indexBtn.disabled             = false;
    dom.indexBtnLabel.textContent     = "Retry";
  } finally {
    state.isBusy = false;
  }
}

// ── Show chat UI ──────────────────────────────────────────
function showChat() {
  dom.chatSection.classList.remove("hidden");
  dom.inputBar.classList.remove("hidden");
  dom.footerBar.classList.remove("hidden");
  dom.questionInput.focus();
}

// ── Chat history (keyed per video) ───────────────────────
function historyKey() { return `chat_${state.videoId}`; }

async function saveChatHistory() {
  await chrome.storage.session.set({ [historyKey()]: chatHistory });
}

async function loadChatHistory() {
  dom.chatMessages.innerHTML = "";
  chatHistory = [];
  const data = await chrome.storage.session.get(historyKey());
  const msgs = data[historyKey()] || [];
  msgs.forEach(m => {
    chatHistory.push(m);
    renderBubble(m.role, m.text, m.sources || [], false);
  });
  scrollChat();
}

// ── Send question ─────────────────────────────────────────
async function sendQuestion() {
  const q = dom.questionInput.value.trim();
  if (!q || state.isBusy || !state.isIndexed) return;

  // Clear input
  dom.questionInput.value = "";
  resizeTextarea();
  dom.sendBtn.disabled = true;
  dom.suggestionsRow.classList.add("hidden");
  state.isBusy = true;

  // User bubble
  const userMsg = { role: "user", text: q, sources: [] };
  chatHistory.push(userMsg);
  renderBubble("user", q);
  await saveChatHistory();

  // Typing indicator
  const typingEl = addTypingIndicator();

  try {
    await streamAnswer(q, typingEl);
  } catch (err) {
    typingEl.remove();
    const errText = "Sorry, something went wrong: " + err.message;
    chatHistory.push({ role: "bot", text: errText, sources: [] });
    renderBubble("bot", errText);
    await saveChatHistory();
  } finally {
    state.isBusy     = false;
    dom.sendBtn.disabled = !dom.questionInput.value.trim();
    dom.questionInput.focus();
  }
}

// ── Streaming answer ──────────────────────────────────────
async function streamAnswer(question, typingEl) {
  const res = await fetch(`${state.backendUrl}/ask-stream`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ video_id: state.videoId, question }),
  });

  if (!res.ok) {
    // Fallback: try /ask (non-streaming)
    typingEl.remove();
    await regularAnswer(question);
    return;
  }

  typingEl.remove();
  const { row, bubble } = createBubble("bot");
  dom.chatMessages.appendChild(row);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText  = "";
  let sources   = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") break;

      try {
        const obj = JSON.parse(payload);
        if (obj.token)   { fullText += obj.token; bubble.innerHTML = formatMarkdown(fullText);; }
        if (obj.sources) { sources = obj.sources; }
      } catch {
        // Plain text token (non-JSON SSE)
        fullText += payload;
        bubble.innerHTML = formatMarkdown(fullText);
      }
    }
    scrollChat();
  }

  if (sources.length) addSourceChips(bubble, sources);
  chatHistory.push({ role: "bot", text: fullText, sources });
  await saveChatHistory();
}

// Fallback for non-streaming /ask
async function regularAnswer(question) {
  const res  = await fetch(`${state.backendUrl}/ask`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ video_id: state.videoId, question }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  renderBubble("bot", data.answer, data.sources || []);
  chatHistory.push({ role: "bot", text: data.answer, sources: data.sources || [] });
  await saveChatHistory();
}

// ── DOM render helpers ────────────────────────────────────
function createBubble(role) {
  const row    = document.createElement("div");
  row.className = `msg-row ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  row.appendChild(bubble);
  return { row, bubble };
}

function renderBubble(role, text, sources = [], scroll = true) {
  const { row, bubble } = createBubble(role);
  if (role === "bot") {
    bubble.innerHTML = formatMarkdown(text);
  } else {
    bubble.textContent = text;
  }
  if (sources.length && role === "bot") addSourceChips(bubble, sources);
  dom.chatMessages.appendChild(row);
  if (scroll) scrollChat();
}

function formatMarkdown(text) {
  return text
    // Bold **text**
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    // Italic *text*
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    // Numbered list: "1. item" → <ol>
    .replace(/^\d+\.\s(.+)/gm, "<li>$1</li>")
    // Bullet list: "- item" or "• item" → <ul>
    .replace(/^[-•]\s(.+)/gm, "<li>$1</li>")
    // Wrap consecutive <li> items in <ul> or <ol>
    .replace(/(<li>.*<\/li>)/gs, (match) => {
      return match.includes("1.") ? `<ol>${match}</ol>` : `<ul>${match}</ul>`;
    })
    // Headings: ## heading
    .replace(/^##\s(.+)/gm, "<strong style='font-size:13px;display:block;margin-top:8px'>$1</strong>")
    // Single newlines → line breaks
    .replace(/\n/g, "<br>");
}

function addSourceChips(bubble, sources) {
  const wrap = document.createElement("div");
  wrap.className = "sources";
  sources.forEach(s => {
    const chip = document.createElement("span");
    chip.className = "src-chip";
    chip.textContent = typeof s === "string" ? s : `Chunk ${s}`;
    wrap.appendChild(chip);
  });
  bubble.appendChild(wrap);
}

function addTypingIndicator() {
  const row    = document.createElement("div");
  row.className = "msg-row bot typing-row";
  const bubble = document.createElement("div");
  bubble.className = "typing-bubble";
  bubble.innerHTML = "<span></span><span></span><span></span>";
  row.appendChild(bubble);
  dom.chatMessages.appendChild(row);
  scrollChat();
  return row;
}

function scrollChat() {
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

// ── Badge helper ──────────────────────────────────────────
function setBadge(state, text) {
  dom.indexBadge.className     = `indexed-badge ${state}`;
  dom.indexBadge.textContent   = text;
}

// ── Textarea auto-resize ──────────────────────────────────
function resizeTextarea() {
  const ta = dom.questionInput;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 90) + "px";
}

// ── Export conversation ───────────────────────────────────
function exportConversation() {
  if (!chatHistory.length) return alert("No conversation to export.");

  let md = `# YT RAG — ${state.videoTitle}\n`;
  md    += `Video ID: ${state.videoId}\n`;
  md    += `Exported: ${new Date().toLocaleString()}\n\n---\n\n`;

  chatHistory.forEach(m => {
    md += m.role === "user"
      ? `**You:** ${m.text}\n\n`
      : `**Assistant:** ${m.text}\n\n`;
  });

  const blob = new Blob([md], { type: "text/markdown" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: `yt-rag-${state.videoId}.md` });
  a.click();
  URL.revokeObjectURL(url);
}

// ── Clear conversation ────────────────────────────────────
async function clearConversation() {
  chatHistory = [];
  await chrome.storage.session.remove(historyKey());
  dom.chatMessages.innerHTML = "";
  dom.suggestionsRow.classList.remove("hidden");
}

// ── Utility ───────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Event bindings ────────────────────────────────────────
function bindEvents() {
  // Send
  dom.sendBtn.addEventListener("click", sendQuestion);
  dom.questionInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuestion();
    }
  });

  // Auto-resize + toggle send button
  dom.questionInput.addEventListener("input", () => {
    resizeTextarea();
    dom.sendBtn.disabled = !dom.questionInput.value.trim() || !state.isIndexed;
  });

  // Index
  dom.indexBtn.addEventListener("click", indexVideo);

  // Manual video load
  dom.manualLoadBtn.addEventListener("click", async () => {
    const vid = dom.manualInput.value.trim();
    if (vid) {
      dom.onboarding.classList.add("hidden");
      await loadVideo(vid, vid);
    }
  });
  dom.manualInput.addEventListener("keydown", async e => {
    if (e.key === "Enter") {
      const vid = dom.manualInput.value.trim();
      if (vid) {
        dom.onboarding.classList.add("hidden");
        await loadVideo(vid, vid);
      }
    }
  });

  // Suggestion chips
  dom.suggestionsRow.addEventListener("click", e => {
    const chip = e.target.closest(".sug");
    if (!chip) return;
    dom.questionInput.value = chip.dataset.q;
    resizeTextarea();
    dom.sendBtn.disabled = false;
    sendQuestion();
  });

  // Footer actions
  dom.exportBtn.addEventListener("click", exportConversation);
  dom.clearBtn.addEventListener("click",  clearConversation);
}