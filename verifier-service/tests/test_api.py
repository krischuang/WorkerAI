"""End-to-end tests against the real FastAPI app via TestClient (an in-process
ASGI call, no network socket, but the full request/response/middleware/
dependency-injection stack runs exactly as it would in production)."""

import json
import os
import time

import pytest
from fastapi.testclient import TestClient

os.environ["VERIFIER_SHARED_SECRET"] = "test-shared-secret-do-not-use-in-prod"

from app.auth import sign_request  # noqa: E402  (secret must be set before import-time use)
from app.main import app  # noqa: E402

SECRET = os.environ["VERIFIER_SHARED_SECRET"]

client = TestClient(app)


def post_signed(body: dict, *, header_overrides: dict | None = None, timestamp: int | None = None):
    """Signs over the EXACT bytes transmitted. Using httpx's `json=` kwarg
    for the request would let httpx re-serialize the dict independently of
    whatever we signed (key order/whitespace could legally differ), which
    would invalidate the whole point of these tests. This sends the
    identical raw bytes that were signed."""
    raw = json.dumps(body).encode("utf-8")
    ts, sig = sign_request(SECRET, raw, timestamp=timestamp)
    headers = {"X-Timestamp": ts, "X-Signature": sig, "content-type": "application/json"}
    if header_overrides:
        headers.update(header_overrides)
        for key, value in list(headers.items()):
            if value is None:
                del headers[key]
    return client.post("/verify", content=raw, headers=headers)


def test_health_requires_no_auth():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_verify_without_signature_headers_is_rejected():
    resp = client.post("/verify", json={"task_id": "t1"})
    assert resp.status_code == 422  # missing required headers


def test_verify_with_invalid_signature_is_rejected():
    body = {"task_id": "t1", "agent_reported_status": "passed", "independent_results": []}
    resp = post_signed(body, header_overrides={"X-Signature": "0" * 64})
    assert resp.status_code == 401


def test_verify_with_expired_timestamp_is_rejected():
    body = {"task_id": "t1", "agent_reported_status": "passed", "independent_results": []}
    resp = post_signed(body, timestamp=int(time.time()) - 10_000)
    assert resp.status_code == 401


def test_verify_happy_path_with_valid_signature():
    body = {
        "task_id": "task-abc",
        "agent_reported_status": "passed",
        "independent_results": [
            {"label": "lint", "command": "npm run lint", "exit_code": 0},
            {"label": "test", "command": "npm test", "exit_code": 0},
        ],
        "changed_files": ["src/foo.ts"],
    }
    resp = post_signed(body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["verification_state"] == "INDEPENDENTLY_VERIFIED"
    assert data["allowed"] is True
    assert data["task_id"] == "task-abc"


def test_verify_disagreement_is_not_allowed():
    body = {
        "task_id": "task-xyz",
        "agent_reported_status": "passed",
        "independent_results": [{"label": "build", "command": "npm run build", "exit_code": 1}],
        "changed_files": [],
    }
    resp = post_signed(body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["verification_state"] == "VERIFICATION_FAILED"
    assert data["allowed"] is False


def test_verify_tampered_body_after_signing_is_rejected():
    """A signature is computed over the exact raw body, if a
    man-in-the-middle (or a buggy proxy) alters the body after signing,
    verification must fail, proving the HMAC is actually binding the
    payload and not just checking header presence."""
    body = {"task_id": "task-1", "agent_reported_status": "passed", "independent_results": []}
    raw = json.dumps(body).encode("utf-8")
    ts, sig = sign_request(SECRET, raw)
    headers = {"X-Timestamp": ts, "X-Signature": sig, "content-type": "application/json"}

    tampered_raw = json.dumps({**body, "task_id": "task-attacker-controlled"}).encode("utf-8")
    resp = client.post("/verify", content=tampered_raw, headers=headers)
    assert resp.status_code == 401


@pytest.mark.parametrize("missing_header", ["X-Timestamp", "X-Signature"])
def test_verify_missing_individual_header_is_rejected(missing_header):
    body = {"task_id": "t1", "agent_reported_status": "passed", "independent_results": []}
    resp = post_signed(body, header_overrides={missing_header: None})
    assert resp.status_code == 422
