from app.verdict import classify


def passing_result(label="test", exit_code=0):
    return {"label": label, "command": "npm test", "exit_code": exit_code}


def test_all_pass_yields_independently_verified():
    v = classify(
        agent_reported_status="passed",
        independent_results=[passing_result("lint"), passing_result("test")],
        changed_files=["src/foo.ts"],
    )
    assert v.verification_state == "INDEPENDENTLY_VERIFIED"
    assert v.allowed is True


def test_no_independent_results_is_not_verified():
    v = classify(agent_reported_status="passed", independent_results=[], changed_files=[])
    assert v.verification_state == "NOT_VERIFIED"
    assert v.allowed is False


def test_missing_agent_claim_is_not_verified():
    v = classify(
        agent_reported_status=None,
        independent_results=[passing_result()],
        changed_files=[],
    )
    assert v.verification_state == "NOT_VERIFIED"
    assert v.allowed is False


def test_agent_reported_failure_is_verification_failed_even_if_commands_passed():
    v = classify(
        agent_reported_status="failed",
        independent_results=[passing_result()],
        changed_files=[],
    )
    assert v.verification_state == "VERIFICATION_FAILED"
    assert v.allowed is False


def test_exit_code_mismatch_is_verification_failed():
    v = classify(
        agent_reported_status="passed",
        independent_results=[passing_result("build", exit_code=1)],
        changed_files=[],
    )
    assert v.verification_state == "VERIFICATION_FAILED"
    assert v.allowed is False
    assert "build" in v.reasons[0]


def test_missing_exit_code_is_not_verified_not_failed():
    """A None exit code means the command couldn't even run (infra error),
    that's an inconclusive attempt, not a confirmed disagreement, so it must
    resolve to NOT_VERIFIED rather than VERIFICATION_FAILED."""
    v = classify(
        agent_reported_status="passed",
        independent_results=[passing_result("flaky-ssh", exit_code=None)],
        changed_files=[],
    )
    assert v.verification_state == "NOT_VERIFIED"
    assert v.allowed is False


def test_sensitive_file_touched_fails_even_with_all_green_commands():
    v = classify(
        agent_reported_status="passed",
        independent_results=[passing_result()],
        changed_files=[".env", "src/safe.ts"],
    )
    assert v.verification_state == "VERIFICATION_FAILED"
    assert v.allowed is False
    assert any("policy:sensitive_file_touched" in flag for flag in v.risk_flags)


def test_nested_env_file_is_still_detected():
    v = classify(
        agent_reported_status="passed",
        independent_results=[passing_result()],
        changed_files=["packages/api/.env.production"],
    )
    assert v.verification_state == "VERIFICATION_FAILED"


def test_ssh_key_path_is_detected():
    v = classify(
        agent_reported_status="passed",
        independent_results=[passing_result()],
        changed_files=["/home/agent/.ssh/id_rsa"],
    )
    assert v.verification_state == "VERIFICATION_FAILED"


def test_similarly_named_but_safe_file_is_not_flagged():
    """Regression guard against overly broad pattern matching,
    'environment.ts' must not be mistaken for '.env'."""
    v = classify(
        agent_reported_status="passed",
        independent_results=[passing_result()],
        changed_files=["src/environment.ts", "docs/key-concepts.md"],
    )
    assert v.verification_state == "INDEPENDENTLY_VERIFIED"


def test_multiple_commands_all_must_pass():
    v = classify(
        agent_reported_status="passed",
        independent_results=[passing_result("lint"), passing_result("test", exit_code=2)],
        changed_files=[],
    )
    assert v.verification_state == "VERIFICATION_FAILED"
