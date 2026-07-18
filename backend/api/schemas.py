"""Request models shared by the AurigaSQL API routers and handlers."""

from typing import Literal, Optional

from pydantic import BaseModel

from data.connections.demo import DemoGroupId
from data.connections.validation import ConnectionEngine


class FreechatStartRequest(BaseModel):
    source_id: str
    query: str
    model: Optional[str] = None
    parent_context: Optional[str] = None


class DataSourceResolveRequest(BaseModel):
    query: str
    model: Optional[str] = None


class TurnRequest(BaseModel):
    task_id: str
    message: str
    mode: str = "a-interact"
    model: Optional[str] = None


class AnswerUserRequest(BaseModel):
    task_id: str
    answer: str


class CancelRequest(BaseModel):
    task_id: str


class TitleRequest(BaseModel):
    text: str


class AnalyzeRequest(BaseModel):
    question: str
    sql: str = ""
    result: str
    model: Optional[str] = None


class BranchAnswerRequest(BaseModel):
    question: str
    parent_context: str = ""
    model: Optional[str] = None


class VisualizationRequest(BaseModel):
    question: str
    sql: str = ""
    result: str
    prompt: str


class ConnectionCreateRequest(BaseModel):
    name: str
    engine: ConnectionEngine
    path: str = ""
    host: str = ""
    port: int = 5432
    database: str = ""
    username: str = ""
    password: str = ""
    sslmode: str = "prefer"


class ConnectionUpdateRequest(BaseModel):
    name: Optional[str] = None
    path: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    database: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    sslmode: Optional[str] = None


class ConnectionTestRequest(BaseModel):
    engine: ConnectionEngine
    path: str = ""
    host: str = ""
    port: int = 5432
    database: str = ""
    username: str = ""
    password: str = ""
    sslmode: str = "prefer"


class DemoConnectionRequest(BaseModel):
    source_group: DemoGroupId


ProviderInput = Literal["openai", "gemini", "zai", "anthropic", "minimax", "xai", "ollama", "other"]


class LlmConfigCreateRequest(BaseModel):
    label: str
    provider: ProviderInput
    model: str
    api_key: str = ""
    api_base: str = ""
    enabled: bool = True
    set_default: bool = False


class LlmConfigUpdateRequest(BaseModel):
    label: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    enabled: Optional[bool] = None
    set_default: bool = False


class LlmConfigDraftTestRequest(BaseModel):
    profile_id: Optional[str] = None
    provider: ProviderInput
    model: Optional[str] = None
    api_key: Optional[str] = None
    api_base: Optional[str] = None


class SetDefaultRequest(BaseModel):
    model_id: str
