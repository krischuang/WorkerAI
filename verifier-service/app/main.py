"""WorkerAI Independent Verifier Service.

A standalone FastAPI microservice that classifies task-completion evidence
(agent self-report + independently-captured command exit codes + changed
files) into a verification verdict. See docs/architecture.md in the main
repo for why this is a *classifier* over evidence the Node backend already
collected via SSH, not a service that executes commands or holds SSH
credentials itself, that split keeps the untrusted-I/O boundary (SSH)
in exactly one place while still demonstrating a genuinely independent,
separately-authored, separately-deployable verification process.

Run locally:
    uvicorn app.main:app --port 8008

Required env var: VERIFIER_SHARED_SECRET (HMAC key shared with the caller).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.auth import verify_signature
from app.logging_config import configure_logging, set_request_id
from app.models import HealthResponse, VerificationRequest, VerificationVerdict
from app.verdict import classify

VERSION = "0.1.0"
REQUEST_TIMEOUT_SECONDS = 10.0

logger = logging.getLogger("verifier")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    configure_logging()
    logger.info("verifier service starting", extra={"fields": {"version": VERSION}})
    yield


app = FastAPI(title="WorkerAI Verifier Service", version=VERSION, lifespan=lifespan)


class CorrelationAndTimeoutMiddleware(BaseHTTPMiddleware):
    """Assigns/propagates a request ID for structured logging and enforces a
    hard wall-clock ceiling on every request, a hung downstream call (or a
    pathological payload) can never hang this service indefinitely."""

    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        set_request_id(request_id)
        started = time.monotonic()
        try:
            response = await asyncio.wait_for(call_next(request), timeout=REQUEST_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            logger.error(
                "request timed out",
                extra={"fields": {"path": request.url.path, "timeout_s": REQUEST_TIMEOUT_SECONDS}},
            )
            return JSONResponse(status_code=504, content={"error": "request timed out"})
        duration_ms = int((time.monotonic() - started) * 1000)
        response.headers["x-request-id"] = request_id
        logger.info(
            "request completed",
            extra={"fields": {
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            }},
        )
        return response


app.add_middleware(CorrelationAndTimeoutMiddleware)


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    # Never leak internals (stack traces, file paths, secret values) in the
    # response body, log them server-side only, same philosophy as
    # lib/api-error.ts's serverError() in the Node backend.
    logger.error("unhandled exception", exc_info=exc)
    return JSONResponse(status_code=500, content={"error": "internal server error"})


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", service="workerai-verifier", version=VERSION)


@app.post("/verify", response_model=VerificationVerdict, dependencies=[Depends(verify_signature)])
async def verify(payload: VerificationRequest) -> VerificationVerdict:
    if len(payload.independent_results) > 32:
        # Belt-and-suspenders: Pydantic's max_length already enforces this,
        # but an explicit check here keeps the invariant visible at the
        # handler level without relying on reading the model definition.
        raise HTTPException(status_code=422, detail="too many independent_results")

    verdict = classify(
        agent_reported_status=payload.agent_reported_status,
        independent_results=[r.model_dump() for r in payload.independent_results],
        changed_files=payload.changed_files,
    )

    logger.info(
        "verification classified",
        extra={"fields": {
            "task_id": payload.task_id,
            "verification_state": verdict.verification_state,
            "allowed": verdict.allowed,
        }},
    )

    return VerificationVerdict(
        task_id=payload.task_id,
        verification_state=verdict.verification_state,
        allowed=verdict.allowed,
        reasons=verdict.reasons,
        risk_flags=verdict.risk_flags,
    )
