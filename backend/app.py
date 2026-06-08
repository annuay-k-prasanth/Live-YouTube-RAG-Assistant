from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from youtube_transcript_api import YouTubeTranscriptApi

from langchain_text_splitters import RecursiveCharacterTextSplitter

from langchain_huggingface import (
    HuggingFaceEmbeddings,
    ChatHuggingFace,
    HuggingFaceEndpoint,
)

from langchain_community.vectorstores import FAISS

from langchain_core.prompts import PromptTemplate

from langchain_core.runnables import (
    RunnableParallel,
    RunnablePassthrough,
    RunnableLambda,
)

from langchain_core.output_parsers import StrOutputParser

import os
import json
import httpx




# ======================================================
# SETUP
# ======================================================

load_dotenv()

app = FastAPI(title="Live YouTube RAG Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ======================================================
# ENV CHECK
# ======================================================

HUGGINGFACEHUB_API_TOKEN = os.getenv("HUGGINGFACEHUB_API_TOKEN")

if not HUGGINGFACEHUB_API_TOKEN:
    raise ValueError("HUGGINGFACEHUB_API_TOKEN not found in .env")


# ======================================================
# GLOBAL SINGLETONS  (loaded once at startup)
# ======================================================

vector_stores: dict = {}          # video_id → FAISS

class IngestTextRequest(BaseModel):
    video_id: str
    transcript: str

embeddings = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-MiniLM-L6-v2",
    model_kwargs={"device": "cpu"},
    encode_kwargs={"normalize_embeddings": False}
)

llm = HuggingFaceEndpoint(
    repo_id="mistralai/Mistral-7B-Instruct-v0.3",
    task="text-generation",
    huggingfacehub_api_token=HUGGINGFACEHUB_API_TOKEN,
)

model = ChatHuggingFace(llm=llm, temperature=0.1)


# ======================================================
# REQUEST SCHEMAS
# ======================================================

class IngestRequest(BaseModel):
    video_id: str


class AskRequest(BaseModel):
    video_id: str
    question: str


# ======================================================
# HELPERS
# ======================================================

def vs_path(video_id: str) -> str:
    return f"vectorstores/{video_id}"


def format_docs(docs: list) -> str:
    return "\n\n".join(d.page_content for d in docs)


def get_retriever(video_id: str, k: int = 4):
    """Return retriever for video_id, loading from disk if needed."""
    if video_id not in vector_stores:
        path = vs_path(video_id)
        if os.path.exists(path):
            vector_stores[video_id] = FAISS.load_local(
                path,
                embeddings,
                allow_dangerous_deserialization=True,
            )
        else:
            return None
    return vector_stores[video_id].as_retriever(
        search_type="similarity",
        search_kwargs={"k": k},
    )


def build_chain(retriever):
    """Build the LangChain RAG pipeline."""
    prompt = PromptTemplate(
        template="""You are a helpful assistant.
Answer ONLY from the provided transcript context.
If the context is insufficient, say you don't know.

Context:
{context}

Question:
{question}
""",
        input_variables=["context", "question"],
    )

    return (
        RunnableParallel({
            "context":  retriever | RunnableLambda(format_docs),
            "question": RunnablePassthrough(),
        })
        | prompt
        | model
        | StrOutputParser()
    )


# ======================================================
# HEALTH
# ======================================================

@app.get("/health")
def health():
    return {"status": "ok"}


# ======================================================
# STATUS  — used by extension to check if a video is indexed
# ======================================================

@app.get("/status/{video_id}")
def status(video_id: str):
    indexed = (
        video_id in vector_stores
        or os.path.exists(vs_path(video_id))
    )
    return {"indexed": indexed}


# ======================================================
# INGEST
# ======================================================

@app.post("/ingest")
async def ingest(req: IngestRequest):
    try:
        if req.video_id in vector_stores:
            return {"status": "already_indexed"}

        path = vs_path(req.video_id)
        if os.path.exists(path):
            vector_stores[req.video_id] = FAISS.load_local(
                path, embeddings,
                allow_dangerous_deserialization=True,
            )
            return {"status": "loaded_from_disk"}

        # Fetch transcript via Supadata
        async with httpx.AsyncClient() as client:
            res = await client.get(
                f"https://api.supadata.ai/v1/youtube/transcript",
                params={"videoId": req.video_id, "text": "true"},
                headers={"x-api-key": os.getenv("SUPADATA_API_KEY")},
                timeout=30
            )
            data = res.json()

        if "error" in data:
            return {"error": data["error"]}

        transcript = data.get("content", "")
        if not transcript:
            return {"error": "No transcript found"}

        splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000, chunk_overlap=200
        )
        chunks = splitter.create_documents([transcript])
        vs = FAISS.from_documents(chunks, embeddings)

        os.makedirs("vectorstores", exist_ok=True)
        vs.save_local(path)
        vector_stores[req.video_id] = vs

        return {"status": "indexed", "chunks": len(chunks)}

    except Exception as e:
        return {"error": str(e)}
# ======================================================
# ASK  (non-streaming fallback)
# ======================================================

@app.post("/ask")
def ask(req: AskRequest):
    try:
        retriever = get_retriever(req.video_id)
        if not retriever:
            return {"error": "Video not indexed. Call /ingest first."}

        chain  = build_chain(retriever)
        answer = chain.invoke(req.question)

        return {"answer": answer}

    except Exception as e:
        return {"error": str(e)}


# ======================================================
# ASK-STREAM  (SSE streaming — used by popup.js)
# ======================================================

@app.post("/ask-stream")
def ask_stream(req: AskRequest):
    """
    Streams tokens as Server-Sent Events.
    Each event is:  data: {"token": "..."}\n\n
    Final event is: data: [DONE]\n\n
    """
    retriever = get_retriever(req.video_id)
    if not retriever:
        # Return error as SSE so the client handles it uniformly
        def error_gen():
            yield 'data: {"error": "Video not indexed"}\n\n'
            yield "data: [DONE]\n\n"
        return StreamingResponse(error_gen(), media_type="text/event-stream")

    chain = build_chain(retriever)

    def token_generator():
        try:
            for token in chain.stream(req.question):
                payload = json.dumps({"token": token})
                yield f"data: {payload}\n\n"
        except Exception as e:
            yield f'data: {{"error": "{str(e)}"}}\n\n'
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        token_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",      # disable nginx buffering if deployed
        },
    )