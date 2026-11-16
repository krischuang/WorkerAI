# WorkerAI Verifier Service

A standalone Python/FastAPI microservice that independently classifies
autonomous-task completion evidence. See
`claude-task-monitor/docs/architecture.md` §5 for the full design rationale.
In short: this service judges evidence (agent self-report + already-
captured command exit codes + changed files) that the main Node backend
collected over SSH; it does not execute commands or hold SSH credentials
itself.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

export VERIFIER_SHARED_SECRET=dev-only-change-me
uvicorn app.main:app --port 8008
```

## Test

```bash
python -m pytest -v
```

20 tests: `tests/test_verdict.py` (pure classification logic, no I/O) and
`tests/test_api.py` (full FastAPI TestClient round trips, including a
tampered-body-after-signing test that proves the HMAC actually binds the
payload).

## API

### `GET /health`

No auth required. `{"status": "ok", "service": "workerai-verifier", "version": "..."}`

### `POST /verify`

Requires `X-Timestamp` (unix seconds) and `X-Signature` (hex HMAC-SHA256 of
`"{timestamp}.{raw_body}"`, keyed by `VERIFIER_SHARED_SECRET`) headers.
Rejects any request outside a 5-minute clock-skew window (bounds how long a
captured request stays valid; not a replay-prevention nonce, see `app/auth.py`).

Request / response contracts: `app/models.py`. Verdict logic: `app/verdict.py`.

## Docker

```bash
docker build -t workerai-verifier .
docker run -p 8008:8008 -e VERIFIER_SHARED_SECRET=... workerai-verifier
```

## Calling this from the Node backend

`claude-task-monitor/lib/verifier-client.ts` is a tested, optional client
(`callVerifierService`), set `VERIFIER_SERVICE_URL` and
`VERIFIER_SHARED_SECRET` (same secret as this service) to use it. It is not
currently called from the live task-completion pipeline. See
`claude-task-monitor/scripts/demo-python-verifier.ts` for a real, runnable
end-to-end example.
