# Live YouTube RAG Assistant

> Ask anything about any YouTube video — powered by LangChain, Llama 3.1, and FAISS vector search.

---

## 📌 Overview

Live YouTube RAG Assistant is a Chrome extension + FastAPI backend that lets you have a real conversation with any YouTube video. It fetches the video transcript, chunks and embeds it into a FAISS vector store, and uses Llama 3.1 (8B Instruct) via HuggingFace to answer your questions — with streaming responses, per-video chat history, and export support.

---

## ✨ Features

- 🔍 Auto-detects the active YouTube video from the browser tab
- 📄 Transcript ingestion — fetches, chunks, and embeds the video transcript on demand
- 🧠 RAG pipeline — retrieves relevant chunks and answers via Llama 3.1
- ⚡ Streaming responses — tokens streamed live via Server-Sent Events (SSE)
- 💬 Per-video chat history — persisted across popup opens using `chrome.storage.session`
- 📤 Export conversation as a Markdown file
- 🟢 Backend health indicator — live status dot in the popup
- 🚀 Deployed on Railway — backend runs in the cloud, no local server required

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Chrome Extension | Manifest V3, Vanilla JS |
| Backend API | FastAPI (Python) |
| LLM | meta-llama/Llama-3.1-8B-Instruct via HuggingFace |
| Embeddings | sentence-transformers/all-mpnet-base-v2 |
| Vector Store | FAISS (local disk persistence) |
| RAG Framework | LangChain |
| Deployment | Railway |

---

## 🎥 Watch Demo

[▶ Watch Demo on Google Drive](https://drive.google.com/file/d/10dWkZogvSuEpdo0xrIsX4bQRinfUAxbw/view?usp=drive_link)
