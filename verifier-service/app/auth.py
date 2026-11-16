"""Service-to-service authentication: HMAC-SHA256 request signing.

WorkerAI's Node backend and this service share a secret
(VERIFIER_SHARED_SECRET) out-of-band (env var / secret manager in a real
deployment, never committed). Every request must carry:

  X-Timestamp: unix seconds, integer, as a string
  X-Signature: hex HMAC-SHA256 of "{timestamp}.{raw_body}", keyed by the
               shared secret

The timestamp is bound into the signature and checked against a clock-skew
window. This bounds how long a captured request stays valid (±5 minutes),
which is strictly better than a bare body signature that would let a
captured request be resent indefinitely, but it is NOT full replay
prevention: there is no nonce store or used-signature cache here, so a
captured, still-valid request can be resent any number of times within
that window. Full replay prevention would require tracking seen
(timestamp, signature) pairs for the lifetime of the window.

Deliberately NOT bearer-token auth: this is service-to-service traffic
between two backends that both hold the shared secret, not a per-user
credential. HMAC-over-body also gives tamper-evidence the body wasn't
modified in transit by an intermediary, which a bearer token alone does not.
"""

from __future__ import annotations

import hmac
import os
import time
from hashlib import sha256

from fastapi import Header, HTTPException, Request

MAX_CLOCK_SKEW_SECONDS = 300  # 5 minutes, same window used elsewhere in WorkerAI


def _shared_secret() -> str:
    secret = os.environ.get("VERIFIER_SHARED_SECRET", "")
    if not secret:
        # Fails closed: an unconfigured secret must never be treated as
        # "auth disabled": every request is rejected until it's set.
        raise HTTPException(status_code=503, detail="VERIFIER_SHARED_SECRET is not configured")
    return secret


def _compute_signature(secret: str, timestamp: str, raw_body: bytes) -> str:
    message = timestamp.encode("utf-8") + b"." + raw_body
    return hmac.new(secret.encode("utf-8"), message, sha256).hexdigest()


async def verify_signature(
    request: Request,
    x_timestamp: str = Header(..., alias="X-Timestamp"),
    x_signature: str = Header(..., alias="X-Signature"),
) -> None:
    """FastAPI dependency, raises 401 on any signature/timestamp failure."""
    secret = _shared_secret()

    try:
        ts = int(x_timestamp)
    except ValueError:
        raise HTTPException(status_code=401, detail="X-Timestamp must be an integer unix timestamp")

    now = int(time.time())
    if abs(now - ts) > MAX_CLOCK_SKEW_SECONDS:
        raise HTTPException(status_code=401, detail="request timestamp outside allowed clock-skew window")

    raw_body = await request.body()
    expected = _compute_signature(secret, x_timestamp, raw_body)

    if not hmac.compare_digest(expected, x_signature):
        raise HTTPException(status_code=401, detail="invalid signature")


def sign_request(secret: str, raw_body: bytes, timestamp: int | None = None) -> tuple[str, str]:
    """Helper used by tests and by TS/other clients porting this scheme:
    returns (x_timestamp, x_signature) for a given body."""
    ts = str(timestamp if timestamp is not None else int(time.time()))
    return ts, _compute_signature(secret, ts, raw_body)
