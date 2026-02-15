from pydantic import BaseModel
from typing import List, Optional


class ChatRequest(BaseModel):
    message: str
    session_id: str
    model: str = "llama-3.3-70b-versatile"


class ChatResponse(BaseModel):
    response: str
    sources: List[str] = []


class UploadResponse(BaseModel):
    filename: str
    status: str


class UserResponse(BaseModel):
    id: int
    username: str
    role: str

    model_config = {"from_attributes": True}


class UserListResponse(BaseModel):
    users: List[UserResponse]


class UserRoleUpdate(BaseModel):
    role: str
