from fastapi import FastAPI, HTTPException, UploadFile, File, Depends, Form, status
from typing import List
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from datetime import timedelta

from backend.models import ChatRequest, UserListResponse, UserRoleUpdate
from backend.database import engine, Base, get_db, SessionLocal
from backend.models_db import User, Document, ChatSession
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
    delete_document_from_chroma,
    get_document_chunks,
)
import os
import shutil
import uuid

# Suppress USER_AGENT warning
os.environ.setdefault("USER_AGENT", "RAG_AI_App/1.0")

# Create Tables
Base.metadata.create_all(bind=engine)

app = FastAPI()


@app.on_event("startup")
async def startup_event():
    # Seed Superadmin
    super_username = os.getenv("SUPER_USERNAME")
    super_password = os.getenv("SUPER_PASSWORD")

    if super_username and super_password:
        # Get a new db session
        db = SessionLocal()
        try:
            # Check if superadmin exists
            existing_superadmin = (
                db.query(User).filter(User.username == super_username).first()
            )

            hashed_pwd = get_password_hash(super_password)

            if not existing_superadmin:
                print(f"Seeding Superadmin: {super_username}")
                new_user = User(
                    username=super_username,
                    hashed_password=hashed_pwd,
                    role="superadmin",
                )
                db.add(new_user)
            else:
                # Force update password to ensure .env is source of truth
                print(f"Updating Superadmin password and role for: {super_username}")
                existing_superadmin.hashed_password = hashed_pwd
                existing_superadmin.role = "superadmin"

            db.commit()
        except Exception as e:
            print(f"Error seeding superadmin: {e}")
        finally:
            db.close()


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
async def chat_endpoint(
    request: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session_id = request.session_id
    if not session_id:
        session_id = str(uuid.uuid4())

    # --- Session Isolation Check ---
    # Check if session exists
    chat_session = (
        db.query(ChatSession).filter(ChatSession.session_id == session_id).first()
    )

    if chat_session:
        # If exists, MUST belong to current_user
        if chat_session.user_id != current_user.id:
            raise HTTPException(
                status_code=403,
                detail="Access denied: You do not own this chat session.",
            )
    else:
        # If new, create and link to current_user
        new_session = ChatSession(session_id=session_id, user_id=current_user.id)
        db.add(new_session)
        db.commit()
    # -------------------------------

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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
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

    # --- Session Isolation Check ---
    chat_session = (
        db.query(ChatSession).filter(ChatSession.session_id == session_id).first()
    )
    if chat_session:
        if chat_session.user_id != current_user.id:
            raise HTTPException(
                status_code=403, detail="Access denied: Session ownership mismatch."
            )
    else:
        # Auto-create if not exists (though usually chat starts first)
        new_session = ChatSession(session_id=session_id, user_id=current_user.id)
        db.add(new_session)
        db.commit()
    # -------------------------------

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


@app.get("/api/documents")
async def list_documents(
    session_id: str = None,
    current_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """
    List documents.
    If session_id is provided, list session docs.
    Otherwise list global docs (Base Knowledge).
    """
    scope = "session" if session_id else "global"
    query = db.query(Document).filter(Document.scope == scope)
    if session_id:
        query = query.filter(Document.session_id == session_id)

    docs = query.order_by(Document.id.desc()).all()
    return {"documents": docs}


@app.delete("/api/documents/{doc_id}")
async def delete_document(
    doc_id: int,
    current_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Delete a document from DB and Vector Store."""
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Delete from Chroma
    delete_document_from_chroma(doc_id)

    # Delete from DB
    db.delete(doc)
    db.commit()

    return {"status": "success", "message": f"Document {doc.filename} deleted"}


@app.get("/api/documents/{doc_id}/chunks")
async def get_doc_chunks_endpoint(
    doc_id: int,
    current_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Get chunks for a document."""
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    chunks = get_document_chunks(doc_id)
    return {"filename": doc.filename, "chunks": chunks}


@app.post("/api/ingest")
async def ingest_base_knowledge(
    files: List[UploadFile] = File(...),
    chunk_size: int = Form(1000),
    chunk_overlap: int = Form(200),
    current_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """
    Admin/Superadmin upload. Stores as 'global' scope.
    Supports multiple files.
    """
    results = []
    total_chunks = 0
    errors = []

    from datetime import datetime

    for file in files:
        temp_file = f"temp_base_{file.filename}"
        try:
            # 1. Create DB Record
            new_doc = Document(
                filename=file.filename,
                upload_timestamp=datetime.now().isoformat(),
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                scope="global",
                session_id=None,
            )
            db.add(new_doc)
            db.commit()
            db.refresh(new_doc)

            # 2. Save file and Ingest
            with open(temp_file, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)

            num_chunks = ingest_document(
                temp_file,
                session_id=None,
                scope="global",
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                doc_id=new_doc.id,
            )
            total_chunks += num_chunks
            results.append(
                {"filename": file.filename, "chunks": num_chunks, "status": "success"}
            )

        except Exception as e:
            errors.append(f"{file.filename}: {str(e)}")
        finally:
            if os.path.exists(temp_file):
                os.remove(temp_file)

    if not results and errors:
        raise HTTPException(
            status_code=500, detail=f"All uploads failed: {'; '.join(errors)}"
        )

    return {
        "status": "success",
        "total_chunks": total_chunks,
        "results": results,
        "errors": errors,
    }


@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Transcribes audio using Groq Whisper."""
    # Create a temporary file to store the upload
    temp_filename = f"temp_{uuid.uuid4()}_{file.filename}"
    try:
        # Save uploaded file to disk
        with open(temp_filename, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        from groq import Groq

        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise HTTPException(
                status_code=500,
                detail="GROQ_API_KEY not found in environment variables",
            )

        client = Groq(api_key=api_key)

        # Open the saved file and send to Groq
        with open(temp_filename, "rb") as f:
            # Groq expects (filename, file_object) or just file_object
            # passing the file object directly is safer
            transcription = client.audio.transcriptions.create(
                file=(temp_filename, f.read()),  # Read bytes
                model="whisper-large-v3",
                response_format="json",
                language="id",  # Default to Indonesian
                temperature=0.0,
            )

        return {"text": transcription.text}
    except Exception as e:
        print(f"Transcription error: {e}")
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        # Clean up temp file
        if os.path.exists(temp_filename):
            try:
                os.remove(temp_filename)
            except Exception as cleanup_error:
                print(f"Error cleaning up temp file {temp_filename}: {cleanup_error}")


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
async def get_history(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns the chat history for a specific session."""
    # --- Session Isolation Check ---
    chat_session = (
        db.query(ChatSession).filter(ChatSession.session_id == session_id).first()
    )
    if not chat_session:
        # If session doesn't exist in DB but requested:
        # Could be legacy or invalid. Return empty.
        # OR force 404. Let's return empty to avoid UI break, but secure it.
        # Wait, if I request a random ID, I shouldn't see anything.
        # If I request MY legacy ID, I might not see it if I didn't migrate.
        # Strict mode: 403 or 404.
        return {"history": []}

    if chat_session.user_id != current_user.id:
        raise HTTPException(
            status_code=403, detail="Access denied: You do not own this chat session."
        )
    # -------------------------------

    try:
        history = await get_session_history(session_id)
        return {"history": history}
    except Exception as e:
        print(f"Error fetching history: {e}")
        return {"history": []}


@app.delete("/api/history/{session_id}")
async def delete_history(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Deletes the chat history for a specific session."""
    # --- Session Isolation Check ---
    chat_session = (
        db.query(ChatSession).filter(ChatSession.session_id == session_id).first()
    )
    if chat_session:
        if chat_session.user_id != current_user.id:
            raise HTTPException(
                status_code=403,
                detail="Access denied: You do not own this chat session.",
            )

        # Delete from SQL DB as well
        db.delete(chat_session)
        db.commit()
    # -------------------------------

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


@app.post("/api/auth/register")
async def register_user(
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    """
    Public registration for standard users.
    """
    existing_user = db.query(User).filter(User.username == username).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Username already registered")

    # Block registration of SUPER_USERNAME
    super_username = os.getenv("SUPER_USERNAME")
    if super_username and username == super_username:
        raise HTTPException(
            status_code=400, detail="This username is reserved. Please log in directly."
        )

    hashed_pwd = get_password_hash(password)
    # Default role is 'user'
    new_user = User(username=username, hashed_password=hashed_pwd, role="user")
    db.add(new_user)
    db.commit()
    return {"username": new_user.username, "role": new_user.role}


@app.get("/api/users", response_model=UserListResponse)
async def list_users(
    skip: int = 0,
    limit: int = 100,
    current_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """
    List all users. Restricted to Admins and Superadmins.
    """
    users = db.query(User).offset(skip).limit(limit).all()
    return {"users": users}


@app.post("/api/users")
async def create_user(
    username: str = Form(...),
    password: str = Form(...),
    role: str = Form(...),
    current_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """
    Admin/Superadmin create user.
    """
    # Check permissions
    if role == "superadmin" and current_user.role != "superadmin":
        raise HTTPException(
            status_code=403, detail="Only Superadmin can create Superadmin"
        )

    if role not in ["user", "admin", "superadmin"]:
        raise HTTPException(status_code=400, detail="Invalid role")

    existing_user = db.query(User).filter(User.username == username).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Username already registered")

    hashed_pwd = get_password_hash(password)
    new_user = User(username=username, hashed_password=hashed_pwd, role=role)
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return {"id": new_user.id, "username": new_user.username, "role": new_user.role}


@app.put("/api/users/{user_id}/role")
async def update_user_role(
    user_id: int,
    role_update: UserRoleUpdate,
    current_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """
    Update user role.
    - Superadmin can update anyone.
    - Admin can only update 'user' <-> 'admin'.
    """
    target_user = db.query(User).filter(User.id == user_id).first()
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    new_role = role_update.role

    # Validation
    if new_role not in ["user", "admin", "superadmin"]:
        raise HTTPException(status_code=400, detail="Invalid role")

    if current_user.role != "superadmin":
        # Regular Admin restrictions
        if target_user.role == "superadmin":
            raise HTTPException(status_code=403, detail="Cannot modify Superadmin")
        if new_role == "superadmin":
            raise HTTPException(status_code=403, detail="Cannot promote to Superadmin")

    target_user.role = new_role
    db.commit()
    return {
        "status": "success",
        "username": target_user.username,
        "role": target_user.role,
    }


# Mount frontend static files
# This must be last to avoid overriding API routes
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
