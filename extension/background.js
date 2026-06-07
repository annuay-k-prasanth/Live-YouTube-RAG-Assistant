// Runs as a background service worker (MV3)
// Keeps default settings and does a health ping when the extension installs

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("backendUrl");
  if (!existing.backendUrl) {
    await chrome.storage.local.set({ backendUrl: "live-youtube-rag-assistant-production.up.railway.app" });
  }
});