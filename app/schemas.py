from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SlugPattern = re.compile(r"^[a-z][a-z0-9_-]{2,79}$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CozeConnectionInput(StrictModel):
    name: str = Field(min_length=2, max_length=128)
    base_url: str = Field(default="https://api.coze.cn", max_length=512)
    token: str | None = Field(default=None, min_length=8, max_length=4096)
    token_expires_at: datetime | None = None
    enabled: bool = True

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        value = value.rstrip("/")
        if not value.startswith(("https://", "http://")):
            raise ValueError("base_url must be HTTP(S)")
        return value


class AgentInput(StrictModel):
    slug: str
    display_name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    kind: Literal["coze_chat", "coze_workflow"]
    connection_id: uuid.UUID
    remote_id: str = Field(min_length=1, max_length=256)
    enabled: bool = True
    timeout_seconds: int = Field(default=60, ge=5, le=600)
    max_retries: int = Field(default=3, ge=0, le=8)

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        if not SlugPattern.fullmatch(value):
            raise ValueError("slug must match ^[a-z][a-z0-9_-]{2,79}$")
        return value


class CanvasPosition(StrictModel):
    x: float = Field(ge=-10000, le=10000)
    y: float = Field(ge=-10000, le=10000)


class DraftNode(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    role: str = Field(min_length=1, max_length=80)
    agent_id: uuid.UUID
    position: CanvasPosition = CanvasPosition(x=0, y=0)
    config: dict[str, Any] = Field(default_factory=dict)


class DraftEdge(StrictModel):
    source: str = Field(min_length=1, max_length=80)
    target: str = Field(min_length=1, max_length=80)
    condition: str | None = Field(default=None, max_length=160)


class OrchestrationDraft(StrictModel):
    template: Literal["topic_auction", "supervisor", "handoff", "parallel_review", "plan_execute"]
    nodes: list[DraftNode] = Field(default_factory=list, max_length=32)
    edges: list[DraftEdge] = Field(default_factory=list, max_length=128)
    settings: dict[str, Any] = Field(default_factory=dict)


class OrchestrationCreate(StrictModel):
    slug: str
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    draft: OrchestrationDraft
    enabled: bool = True

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        if not SlugPattern.fullmatch(value):
            raise ValueError("slug must match ^[a-z][a-z0-9_-]{2,79}$")
        return value


class DraftUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    draft: OrchestrationDraft


class UserInput(StrictModel):
    username: str = Field(min_length=3, max_length=128, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str = Field(min_length=12, max_length=256)
    role: Literal["admin", "user"] = "user"
    active: bool = True


class UserUpdate(StrictModel):
    username: str = Field(min_length=3, max_length=128, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str | None = Field(default=None, min_length=12, max_length=256)
    role: Literal["admin", "user"] = "user"
    active: bool = True


class ValidationIssue(BaseModel):
    path: str
    code: str
    message: str


class ValidationResult(BaseModel):
    valid: bool
    issues: list[ValidationIssue]
    diagram: str
