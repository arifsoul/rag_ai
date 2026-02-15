from fastapi import FastAPI, HTTPException, UploadFile, File, Depends, Form, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from datetime import timedelta

from backend.models import ChatRequest
from backend.database import engine, Base, get_db
from backend.models_db import User
from backend.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    create_access_token,
    get_current_superadmin,
    get_current_admin,
    get_password_hash,
    verify_password,
    get_current_user,
)

# Note: In a real package structure, you might use relative imports,
# but running from root with uvicorn makes absolute imports 'backend.rag' work.
from backend.rag import (
    query_rag,
    ingest_document,
    get_session_history,
    delete_session_history,
)
import os
import shutil
import uuid

# Create Tables
Base.metadata.create_all(bind=engine)

app = FastAPI()

# Session Middleware
# In a real app, use a secure secret key from env
app.add_middleware(SessionMiddleware, secret_key="supersecretkey")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    # Depending on how we want to handle sessions, we can use the one from the request body
    # or the one from the cookie. Here we use the body for explicit control from frontend.
    session_id = request.session_id
    if not session_id:
        session_id = str(uuid.uuid4())

    from fastapi.responses import StreamingResponse

    async def generate():
        try:
            async for chunk in query_rag(request.message, session_id, request.model):
                yield chunk
        except Exception as e:
            print(f"Streaming Error: {e}")
            yield f"Error: {str(e)}"

    return StreamingResponse(generate(), media_type="text/plain")


@app.post("/api/upload")
async def upload_document(
    file: UploadFile = File(...),
    session_id: str = Form(None),  # Make session_id optional/form field
):
    """
    User upload. Stores as 'session' scope.
    Publicly accessible but data is isolated by session_id.
    """
    if not session_id:
        # If no session provided (e.g. from old frontend), maybe generate one or error?
        # Ideally frontend sends it. logic in app.js needs update.
        # For now, let's assume it might happen and just use a random temp one (which means it won't be retrievable easily)
        # Better: require it.
        # But let's be lenient for backwards compat or testing.
        session_id = str(uuid.uuid4())

    temp_file = f"temp_{file.filename}"
    try:
        with open(temp_file, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        num_chunks = ingest_document(temp_file, session_id=session_id, scope="session")
        return {
            "filename": file.filename,
            "status": "success",
            "chunks": num_chunks,
            "scope": "session",
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"Upload error: {e}")  # Log the error
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)


@app.post("/api/ingest")
async def ingest_base_knowledge(
    file: UploadFile = File(...), current_user: User = Depends(get_current_admin)
):
    """
    Admin/Superadmin upload. Stores as 'global' scope.
    """
    temp_file = f"temp_base_{file.filename}"
    try:
        with open(temp_file, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        num_chunks = ingest_document(temp_file, session_id=None, scope="global")
        return {
            "filename": file.filename,
            "status": "success",
            "chunks": num_chunks,
            "scope": "global",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ingestion Error: {str(e)}")
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)


@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Transcribes audio using Groq Whisper."""
    temp_file = f"temp_{uuid.uuid4()}_{file.filename}"
    try:
        with open(temp_file, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        from groq import Groq

        client = Groq(api_key=os.environ.get("GROQ_API_KEY"))

        with open(temp_file, "rb") as f:
            transcription = client.audio.transcriptions.create(
                file=(temp_file, f.read()),
                model="whisper-large-v3",
                response_format="json",
                language="id",  # Set default language to Indonesian or auto
                temperature=0.0,
            )

        return {"text": transcription.text}
    except Exception as e:
        print(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except:
                pass


@app.get("/api/models")
async def get_models():
    """Fetches available models from Groq API."""
    try:
        from groq import Groq

        client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
        models = client.models.list()

        # Filter for chat models or return all
        model_list = [{"id": m.id, "owned_by": m.owned_by} for m in models.data]
        return {"models": model_list}
    except Exception as e:
        # Fallback list if API fails
        fallback = [
            {"id": "llama-3.3-70b-versatile", "owned_by": "Meta"},
            {"id": "llama-3.1-8b-instant", "owned_by": "Meta"},
            {"id": "mixtral-8x7b-32768", "owned_by": "Mistral AI"},
            {"id": "gemma2-9b-it", "owned_by": "Google"},
        ]
        print(f"Error fetching models: {e}")
        return {"models": fallback}


@app.get("/api/history/{session_id}")
async def get_history(session_id: str):
    """Returns the chat history for a specific session."""
    try:
        history = await get_session_history(session_id)
        return {"history": history}
    except Exception as e:
        print(f"Error fetching history: {e}")
        return {"history": []}


@app.delete("/api/history/{session_id}")
async def delete_history(session_id: str):
    """Deletes the chat history for a specific session."""
    try:
        success = await delete_session_history(session_id)
        if success:
            return {"status": "success", "message": "History deleted"}
        else:
            return {
                "status": "warning",
                "message": "Session not found or could not be deleted",
            }
    except Exception as e:
        print(f"Error deleting history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# --- Auth Endpoints ---


@app.post("/api/auth/token")
async def login_for_access_token(
    form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    return {"access_token": access_token, "token_type": "bearer", "role": user.role}


@app.post("/api/auth/register-superadmin")
async def register_superadmin(
    username: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)
):
    """
    Initial setup endpoint.
    Only works if no superadmin exists yet.
    """
    existing_superadmin = db.query(User).filter(User.role == "superadmin").first()
    if existing_superadmin:
        raise HTTPException(status_code=400, detail="Superadmin already exists")

    hashed_pwd = get_password_hash(password)
    new_user = User(username=username, hashed_password=hashed_pwd, role="superadmin")
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return {"username": new_user.username, "role": new_user.role}


@app.post("/api/auth/register-admin")
async def register_admin(
    username: str = Form(...),
    password: str = Form(...),
    current_user: User = Depends(get_current_superadmin),
    db: Session = Depends(get_db),
):
    """
    Create a new Admin. Only Superadmin can do this.
    """
    existing_user = db.query(User).filter(User.username == username).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Username already registered")

    hashed_pwd = get_password_hash(password)
    new_user = User(username=username, hashed_password=hashed_pwd, role="admin")
    db.add(new_user)
    db.commit()
    return {"username": new_user.username, "role": new_user.role}


@app.get("/api/users/me")
async def read_users_me(current_user: User = Depends(get_current_user)):
    return {"username": current_user.username, "role": current_user.role}


# Mount frontend static files
# This must be last to avoid overriding API routes
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
