from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
 
from youtube_transcript_api import YouTubeTranscriptApi
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEmbeddings, HuggingFaceEndpoint
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import PromptTemplate
from langchain_core.runnables import RunnableParallel, RunnablePassthrough, RunnableLambda
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
# GLOBAL SINGLETONS
# ======================================================
 
vector_stores: dict = {}
 
embeddings = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-MiniLM-L6-v2",
    model_kwargs={"device": "cpu"},
    encode_kwargs={"normalize_embeddings": False}
)
 
# Using HuggingFaceEndpoint directly — no ChatHuggingFace wrapper
llm = HuggingFaceEndpoint(
    repo_id="mistralai/Mistral-7B-Instruct-v0.3",
    task="conversational",
    huggingfacehub_api_token=HUGGINGFACEHUB_API_TOKEN,
    max_new_tokens=512,
    temperature=0.1,
)
 
# ======================================================
# REQUEST SCHEMAS
# ======================================================
 
class IngestRequest(BaseModel):
    video_id: str
 
class IngestTextRequest(BaseModel):
    video_id: str
    transcript: str
 
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
    prompt = PromptTemplate(
        template="""You are a helpful assistant.
Answer ONLY from the provided transcript context.
If the context is insufficient, say you don't know.
 
Formatting rules:
- For summaries or explanations → reply in clean paragraphs
- For roadmaps, steps, tips → reply in numbered or bullet points
- For short factual questions → reply in one or two sentences
- Use **bold** for important terms
 
Context:
{context}
 
Question:
{question}
 
Answer:""",
        input_variables=["context", "question"],
    )
 
    return (
        RunnableParallel({
            "context":  retriever | RunnableLambda(format_docs),
            "question": RunnablePassthrough(),
        })
        | prompt
        | llm
        | StrOutputParser()
        |  RunnableLambda(lambda x: x.split("Answer:")[-1].strip())
    )
 
# ======================================================
# HEALTH
# ======================================================
 
@app.get("/health")
def health():
    return {"status": "ok"}
 
# ======================================================
# STATUS
# ======================================================
 
@app.get("/status/{video_id}")
def status(video_id: str):
    indexed = (
        video_id in vector_stores
        or os.path.exists(vs_path(video_id))
    )
    return {"indexed": indexed}
 
# ======================================================
# INGEST — fetches transcript via Supadata API
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
        supadata_key = os.getenv("SUPADATA_API_KEY")
        if not supadata_key:
            return {"error": "SUPADATA_API_KEY not set in environment variables"}
 
        async with httpx.AsyncClient() as client:
            res = await client.get(
                "https://api.supadata.ai/v1/youtube/transcript",
                params={"videoId": req.video_id, "text": "true"},
                headers={"x-api-key": supadata_key},
                timeout=30
            )
            data = res.json()
 
        if "error" in data:
            return {"error": f"Transcript error: {data['error']}"}
 
        transcript = data.get("content", "")
        if not transcript:
            return {"error": "No transcript found for this video"}
 
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
# INGEST-TEXT — accepts transcript directly from extension
# ======================================================
 
@app.post("/ingest-text")
async def ingest_text(req: IngestTextRequest):
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
 
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000, chunk_overlap=200
        )
        chunks = splitter.create_documents([req.transcript])
        vs = FAISS.from_documents(chunks, embeddings)
 
        os.makedirs("vectorstores", exist_ok=True)
        vs.save_local(path)
        vector_stores[req.video_id] = vs
 
        return {"status": "indexed", "chunks": len(chunks)}
 
    except Exception as e:
        return {"error": str(e)}
 
# ======================================================
# ASK — non-streaming fallback
# ======================================================
 
@app.post("/ask")
def ask(req: AskRequest):
    try:
        retriever = get_retriever(req.video_id)
        if not retriever:
            return {"error": "Video not indexed. Call /ingest first."}
 
        chain  = build_chain(retriever)
        answer = chain.invoke(req.question)

        answer = answer.split("Answer:")[-1].strip()

        if not answer or len(answer) < 3:
            return {"answer": "The model returned an empty response. Please try again."}
 
        # Clean HuggingFace error responses
        if isinstance(answer, str) and answer.strip().startswith('{"error"'):
            return {"answer": "The AI model is temporarily unavailable. Please try again in a moment."}
 
        return {"answer": answer}
 
    except Exception as e:
        error_msg = str(e)
        if "429" in error_msg or "Rate limit" in error_msg:
            return {"answer": "Rate limit reached. Please wait 1-2 minutes and try again."}
        if "401" in error_msg or "unauthorized" in error_msg.lower():
            return {"answer": "HuggingFace token is invalid. Please check your API key."}
        return {"error": error_msg}
 
# ======================================================
# ASK-STREAM — SSE streaming
# ======================================================
 
@app.post("/ask-stream")
def ask_stream(req: AskRequest):
    retriever = get_retriever(req.video_id)
    if not retriever:
        def error_gen():
            yield 'data: {"error": "Video not indexed"}\n\n'
            yield "data: [DONE]\n\n"
        return StreamingResponse(error_gen(), media_type="text/event-stream")
 
    chain = build_chain(retriever)
 
    def token_generator():
        try:
            answer = chain.invoke(req.question)
            # Strip prompt echo
            answer = answer.split("Answer:")[-1].strip()
            payload = json.dumps({"token": answer})
            yield f"data: {payload}\n\n"
        except Exception as e:
            error_msg = str(e)
            if "429" in error_msg or "Rate limit" in error_msg:
                msg = "Rate limit reached. Please wait 1–2 minutes and try again."
            else:
                msg = f"Something went wrong: {error_msg}"
            yield f'data: {{"token": "{msg}"}}\n\n'
        finally:
            yield "data: [DONE]\n\n"
 
    return StreamingResponse(
        token_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )