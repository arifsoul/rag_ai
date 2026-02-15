import os
import sys
from typing import List, Dict, Any, Annotated, TypedDict
from dotenv import load_dotenv

# LangChain Imports
from langchain_groq import ChatGroq
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import (
    PyPDFLoader,
    TextLoader,
    WebBaseLoader,
    Docx2txtLoader,
    CSVLoader,
)
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langchain_core.runnables import RunnableConfig

# LangGraph Imports
from langgraph.graph import StateGraph, START, END

# from langgraph.checkpoint.memory import MemorySaver # Removed unused import
from langgraph.graph.message import add_messages

# Load Environment Variables
load_dotenv()

# --- Configuration ---
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
CHROMA_PATH = "databases"
EMBEDDING_MODEL_NAME = "all-MiniLM-L6-v2"  # Efficient and good enough for RAG

if not GROQ_API_KEY:
    print("WARNING: GROQ_API_KEY not found in environment variables.")

# --- Initialization ---
embeddings = HuggingFaceEmbeddings(model_name=EMBEDDING_MODEL_NAME)
vector_store = Chroma(
    collection_name="rag_collection",
    embedding_function=embeddings,
    persist_directory=CHROMA_PATH,
)


# --- Helper for Dynamic LLM ---
def get_llm(model_name: str):
    return ChatGroq(
        model=model_name,
        temperature=0,
        max_tokens=None,
        timeout=None,
        max_retries=2,
        api_key=GROQ_API_KEY,
        streaming=True,  # Ensure streaming is enabled
    )


# --- State ---
class State(TypedDict):
    messages: Annotated[List[Any], add_messages]
    context: List[Document]
    model: str  # Add model to state
    session_id: str  # Add session ID for filtering
    scope: str  # Add scope for filtering


# --- Workflow Functions ---
def retrieve(state: State):
    query = state["messages"][-1].content
    session_id = state.get("session_id", "default")

    # Filter: Global Knowledge OR Session Knowledge
    # Chroma filter syntax: {"$or": [{"scope": {"$eq": "global"}}, {"session_id": {"$eq": session_id}}]}
    # Note: Chroma filter syntax can be tricky.
    # Simple valid filter:
    filter_dict = {
        "$or": [{"scope": {"$eq": "global"}}, {"session_id": {"$eq": session_id}}]
    }

    # Retrieve top 3 relevant documents
    docs = vector_store.similarity_search(query, k=3, filter=filter_dict)
    return {"context": docs}


async def generate(state: State, config: RunnableConfig):
    messages = state["messages"]
    context = state["context"]
    model_name = state.get("model", "llama-3.3-70b-versatile")

    # Instantiate LLM on the fly
    llm = get_llm(model_name)

    # Format context
    context_text = "\n\n".join([d.page_content for d in context])

    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "You are a professional consultant AI. Use the following context to answer the user's question.\n\nContext:\n{context}",
            ),
            ("placeholder", "{messages}"),
        ]
    )

    chain = prompt | llm

    response_content = ""
    # Pass config to astream to propagate callbacks
    async for chunk in chain.astream(
        {"context": context_text, "messages": messages}, config=config
    ):
        response_content += chunk.content

    response = AIMessage(content=response_content)

    return {"messages": [response]}


# --- Graph Definition ---
workflow = StateGraph(State)
workflow.add_node("retrieve", retrieve)
workflow.add_node("generate", generate)

workflow.add_edge(START, "retrieve")
workflow.add_edge("retrieve", "generate")
workflow.add_edge("generate", END)

# Compile with persistent storage
# Compile with persistent storage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
import aiosqlite

# We need a connection for SqliteSaver.
# Best practice: use a context manager or a long-lived connection managed carefully.
# For simplicity here, we create a connection.
# Note: AsyncSqliteSaver needs an async connection context manager,
# but for global app compilation, we might need to initialize it differently or use checkpointer argument at runtime?
# LangGraph docs say: with AsyncSqliteSaver.from_conn_string("checkpoints.db") as memory: ...
# But app is global.
# Let's use memory = AsyncSqliteSaver.from_conn_string("checkpoints.db") if supported, or manage connection manually.
# Actually, the error said "Consider using AsyncSqliteSaver instead."

# Let's try this pattern which works for many async setups:
# Global variables for lazy initialization
_rag_app = None
_db_connection = None


async def get_compiled_app():
    global _rag_app, _db_connection
    if _rag_app is None:
        # Create connection
        # Check if databases directory exists
        if not os.path.exists("databases"):
            os.makedirs("databases")

        _db_connection = await aiosqlite.connect(
            "databases/checkpoints.db", check_same_thread=False
        )

        # Initialize checkpointer
        memory = AsyncSqliteSaver(_db_connection)

        # Compile app
        _rag_app = workflow.compile(checkpointer=memory)

    return _rag_app


# --- Helper Functions for Ingestion ---
def ingest_document(
    file_path: str,
    session_id: str = None,
    scope: str = "global",
    chunk_size: int = 1000,
    chunk_overlap: int = 200,
    doc_id: int = None,
):
    """Ingests a document into the vector store."""
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".pdf":
        loader = PyPDFLoader(file_path)
    elif ext == ".txt":
        loader = TextLoader(file_path)
    elif ext == ".docx":
        loader = Docx2txtLoader(file_path)
    elif ext == ".csv":
        loader = CSVLoader(file_path)
    else:
        # Default fallback or error
        raise ValueError(f"Unsupported file type: {ext}")

    docs = loader.load()

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size, chunk_overlap=chunk_overlap
    )
    splits = splitter.split_documents(docs)

    # Add metadata for isolation
    for split in splits:
        split.metadata["scope"] = scope
        if session_id:
            split.metadata["session_id"] = session_id
        else:
            split.metadata["session_id"] = "global"

        if doc_id:
            split.metadata["doc_id"] = doc_id

    vector_store.add_documents(documents=splits)
    return len(splits)


def delete_document_from_chroma(doc_id: int):
    """Deletes all chunks associated with a specific document ID."""
    try:
        # Chroma filter for doc_id
        result = vector_store.get(where={"doc_id": doc_id})
        ids_to_delete = result["ids"]
        if ids_to_delete:
            vector_store.delete(ids=ids_to_delete)
            return True
        return False
    except Exception as e:
        print(f"Error deleting document {doc_id} from Chroma: {e}")
        return False


def get_document_chunks(doc_id: int):
    """Retrieves chunks for a specific document ID."""
    try:
        result = vector_store.get(
            where={"doc_id": doc_id}, include=["documents", "metadatas"]
        )
        chunks = []
        for i, text in enumerate(result["documents"]):
            chunks.append({"content": text, "metadata": result["metadatas"][i]})
        return chunks
    except Exception as e:
        print(f"Error getting chunks for document {doc_id}: {e}")
        return []


async def query_rag(
    message: str, session_id: str, model_name: str = "llama-3.3-70b-versatile"
):
    """
    Runs the RAG pipeline for a given message and session, yielding chunks.
    """
    app = await get_compiled_app()
    config = {"configurable": {"thread_id": session_id}}

    # Run the graph
    input_state = {
        "messages": [HumanMessage(content=message)],
        "model": model_name,
        "session_id": session_id,
    }

    # Use astream_events to get token-level streaming
    # Filtering for 'on_chat_model_stream' ensures we get tokens from the LLM
    async for event in app.astream_events(input_state, config=config, version="v2"):
        kind = event["event"]
        if kind == "on_chat_model_stream":
            content = event["data"]["chunk"].content
            if content:
                yield content


# --- In-Memory Delete Tracking ---
# deleted_sessions = set() # No longer needed with SqliteSaver and direct deletion


async def get_session_history(session_id: str):
    """Retrieves the chat history for a given session."""
    # if session_id in deleted_sessions: # No longer needed
    #     return []

    app = await get_compiled_app()
    config = {"configurable": {"thread_id": session_id}}
    state = await app.aget_state(config)

    # Check if state exists (empty state has no values)
    if not state.values:
        return []

    # LangGraph state returns current state values. Not necessarily just messages.
    # Our State definition has: messages, context, model
    messages = state.values.get("messages", [])

    history = []
    for msg in messages:
        if isinstance(msg, HumanMessage):
            role = "user"
        else:
            role = "ai"
        history.append({"role": role, "content": msg.content})

    return history


async def delete_session_history(session_id: str):
    """Deletes the chat history for a specific session."""
    try:
        config = {"configurable": {"thread_id": session_id}}

        # 1. Delete Chat History (Checkpoint)
        async with aiosqlite.connect("databases/checkpoints.db") as db:
            await db.execute(
                "DELETE FROM checkpoints WHERE thread_id = ?", (session_id,)
            )
            await db.execute("DELETE FROM writes WHERE thread_id = ?", (session_id,))
            await db.commit()

        # 2. Delete Session Knowledge (Vector Store)
        # Chroma delete using where filter
        try:
            # Get all ids for this session
            result = vector_store.get(where={"session_id": session_id})
            ids_to_delete = result["ids"]
            if ids_to_delete:
                vector_store.delete(ids=ids_to_delete)
        except Exception as e:
            print(f"Error deleting vector data: {e}")

        return True
    except Exception as e:
        sys.stderr.write(f"Error deleting session {session_id}: {e}\n")
    return False
