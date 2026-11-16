"""Typed request/response contracts for the verifier service.

Mirrors the verification-state vocabulary already established in the
Next.js backend's lib/validation-gate.ts (NOT_VERIFIED / AGENT_REPORTED /
INDEPENDENTLY_VERIFIED / VERIFICATION_FAILED) so the two independently
authored implementations agree on what each state means. See
docs/architecture.md in the main repo for the full rationale: this service
*classifies* evidence that WorkerAI's Node backend already collected over
SSH, it does not re-run commands or hold SSH credentials itself.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class VerificationState(str, Enum):
    NOT_VERIFIED = "NOT_VERIFIED"
    INDEPENDENTLY_VERIFIED = "INDEPENDENTLY_VERIFIED"
    VERIFICATION_FAILED = "VERIFICATION_FAILED"


class CommandResult(BaseModel):
    """One independently-executed command's outcome, as already captured by
    the caller (WorkerAI's Node backend, over SSH against the task's real
    workspace). This service never executes commands itself."""

    label: str = Field(..., min_length=1, max_length=64)
    command: str = Field(..., min_length=1, max_length=500)
    exit_code: Optional[int] = Field(default=None, ge=-1, le=255)
    stdout_summary: str = Field(default="", max_length=4096)
    stderr_summary: str = Field(default="", max_length=4096)
    duration_ms: int = Field(default=0, ge=0)


class VerificationRequest(BaseModel):
    task_id: str = Field(..., min_length=1, max_length=128)
    agent_reported_status: Optional[Literal["passed", "failed"]] = None
    agent_evidence: Optional[str] = Field(default=None, max_length=8192)
    independent_results: list[CommandResult] = Field(default_factory=list, max_length=32)
    changed_files: list[str] = Field(default_factory=list, max_length=500)

    @field_validator("changed_files")
    @classmethod
    def _cap_path_length(cls, paths: list[str]) -> list[str]:
        for p in paths:
            if len(p) > 1024:
                raise ValueError("changed_files entries must be 1024 characters or fewer")
        return paths


class VerificationVerdict(BaseModel):
    task_id: str
    verification_state: VerificationState
    allowed: bool
    reasons: list[str]
    risk_flags: list[str]


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    version: str
