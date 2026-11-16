"""Pure verdict-classification logic, no I/O, fully unit-testable.

This is the actual "independent evaluation" logic the FastAPI layer exposes
over HTTP. Keeping it dependency-free (no FastAPI/Pydantic imports) means it
can be tested directly with plain Python values, and reused outside the web
layer if needed.

Invariant (mirrors lib/validation-gate.ts in the main TypeScript backend):
`allowed is True` if and only if `verification_state ==
INDEPENDENTLY_VERIFIED`. An agent's self-reported "passed" claim is never,
by itself, sufficient.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Independent, minimal cross-check against WorkerAI's own policy-engine.ts
# "deny secret files" rule. This is NOT a replacement for policy-engine.ts,
# that remains the single source of truth evaluated at dispatch time and at
# the TS validation-gate's file-level check. This is a second, independently
# authored implementation applied as defense-in-depth: if the two ever
# disagree about a path, the more restrictive verdict should win in the
# caller's own policy, and the disagreement itself is a signal worth
# surfacing (see risk_flags).
SENSITIVE_FILE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(^|/)\.env(\.|$)"),
    re.compile(r"(^|/)\.ssh/"),
    re.compile(r"\.pem$"),
    re.compile(r"\.key$"),
    re.compile(r"(^|/)credentials\.json$"),
    re.compile(r"(^|/)service-account.*\.json$"),
    re.compile(r"(^|/)\.aws/credentials$"),
    re.compile(r"(^|/)\.kube/config$"),
    re.compile(r"(^|/)id_rsa$"),
    re.compile(r"(^|/)id_ed25519$"),
    re.compile(r"(^|/)\.npmrc$"),
    re.compile(r"(^|/)\.netrc$"),
]


def _touches_sensitive_path(changed_files: list[str]) -> list[str]:
    hits: list[str] = []
    for path in changed_files:
        if any(p.search(path) for p in SENSITIVE_FILE_PATTERNS):
            hits.append(path)
    return hits


@dataclass
class Verdict:
    verification_state: str
    allowed: bool
    reasons: list[str] = field(default_factory=list)
    risk_flags: list[str] = field(default_factory=list)


def classify(
    *,
    agent_reported_status: str | None,
    independent_results: list[dict],
    changed_files: list[str],
) -> Verdict:
    """Classify a completed task's evidence into a verification verdict.

    `independent_results` items are plain dicts with at least `exit_code`
    (int | None) and `label` (str), kept dict-shaped (rather than importing
    the Pydantic model) so this function has zero dependency on the web
    framework and can be called/tested in total isolation.
    """
    sensitive_hits = _touches_sensitive_path(changed_files)
    if sensitive_hits:
        return Verdict(
            verification_state="VERIFICATION_FAILED",
            allowed=False,
            reasons=[f"changed file(s) match a sensitive-path policy: {', '.join(sensitive_hits)}"],
            risk_flags=[f"policy:sensitive_file_touched:{f}" for f in sensitive_hits],
        )

    if agent_reported_status is None:
        return Verdict(
            verification_state="NOT_VERIFIED",
            allowed=False,
            reasons=["agent did not report a completion status, no claim to verify against"],
        )

    if agent_reported_status == "failed":
        return Verdict(
            verification_state="VERIFICATION_FAILED",
            allowed=False,
            reasons=["agent explicitly reported failure"],
        )

    if not independent_results:
        return Verdict(
            verification_state="NOT_VERIFIED",
            allowed=False,
            reasons=["agent reported success but no independent command results were supplied"],
        )

    inconclusive = [r for r in independent_results if r.get("exit_code") is None]
    if inconclusive:
        labels = ", ".join(r.get("label", "?") for r in inconclusive)
        return Verdict(
            verification_state="NOT_VERIFIED",
            allowed=False,
            reasons=[f"independent command(s) produced no exit code (execution error): {labels}"],
        )

    failed = [r for r in independent_results if r.get("exit_code") != 0]
    if failed:
        labels = ", ".join(f"{r.get('label', '?')}(exit={r.get('exit_code')})" for r in failed)
        return Verdict(
            verification_state="VERIFICATION_FAILED",
            allowed=False,
            reasons=[f"agent reported success but independent re-execution disagreed: {labels}"],
        )

    return Verdict(
        verification_state="INDEPENDENTLY_VERIFIED",
        allowed=True,
        reasons=["agent reported success; all independent commands exited 0; no sensitive files touched"],
    )
