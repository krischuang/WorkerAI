"""Structured JSON logging with request correlation IDs.

Every log line is a single JSON object (easy to ship to any log aggregator
without a parsing layer) and carries the current request's correlation ID
via a contextvar, so a single `request_id` can be grepped across every line
an individual HTTP call produced, including inside verdict logic, without
threading the ID through every function signature by hand.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from contextvars import ContextVar

_request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")


def set_request_id(request_id: str) -> None:
    _request_id_ctx.set(request_id)


def get_request_id() -> str:
    return _request_id_ctx.get()


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": get_request_id(),
        }
        # Structured extra fields (e.g. task_id, verification_state, duration_ms)
        # passed via logger.info(..., extra={"fields": {...}}).
        extra_fields = getattr(record, "fields", None)
        if isinstance(extra_fields, dict):
            payload.update(extra_fields)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
