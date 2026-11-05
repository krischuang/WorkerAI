#!/bin/bash
# Deterministic stand-in for the Claude CLI, run as the foreground process of
# the demo worker's tmux session (the exact same mechanism a real worker uses
# to run `claude` — see CLAUDE.md's tmux setup instructions). This is NOT the
# real Claude CLI: it is a scripted replacement so the Demo Day scenario is
# reproducible on request, with no API calls and no non-determinism. Every
# other step around it (SSH connection, tmux paste-buffer, git, npm test) is
# real. Labeled as a stand-in everywhere it is reported.
#
# Behavior: waits for a dispatch prompt (pasted by sendTaskToTmux, the real
# production function), makes a real code change in the repo, runs the real
# test suite, and prints the real WORKERAI_VALIDATION / WORKERAI_RESULT blocks
# that lib/validation-gate.ts and lib/usage-parser.ts scan for in production.
#
# Branches on the task title (read from the real <task_title> tag in the
# dispatch prompt) to exercise negative scenarios on demand, without ever
# lying about what ran:
#   default        — real fix, real passing test, honest "passed" self-report
#   [LYING_AGENT]  — makes a change that does NOT fix the test, but still
#                    self-reports "passed" anyway (tests that independent
#                    verification, not the self-report, is what gates
#                    completion)
#   [TOUCHES_ENV]  — in addition to the real fix, also writes to a gitignored
#                    .env file (tests that file-level policy catches a
#                    gitignored path, not just tracked ones)

REPO=/home/demo/workspace/repo
TASK_ID=""
NONCE=""
TASK_TITLE=""
IN_TITLE=0

echo "[fake-claude] ready — waiting for a dispatched task..."

while IFS= read -r line; do
  case "$line" in
    "taskId: "*) TASK_ID="${line#taskId: }" ;;
    "nonce: "*)  NONCE="${line#nonce: }" ;;
    "<task_title>") IN_TITLE=1; TASK_TITLE="" ;;
    "</task_title>") IN_TITLE=0 ;;
    *) if [ "$IN_TITLE" = "1" ]; then TASK_TITLE="$line"; fi ;;
  esac

  if [ "$line" = "[/WORKERAI_RESULT]" ]; then
    echo "[fake-claude] dispatch received — taskId=$TASK_ID nonce=$NONCE title=\"$TASK_TITLE\""
    cd "$REPO" || exit 1

    case "$TASK_TITLE" in
      *"[LYING_AGENT]"*)
        echo "[fake-claude] making a change that does NOT fix the test (deliberate, for the negative scenario)..."
        cat >> "$REPO/math.js" <<'EOF'

function subtract(a, b) { return 999; } // deliberately wrong
module.exports.subtract = subtract;
EOF
        cat >> "$REPO/test.js" <<'EOF'
assert.strictEqual(require('./math').subtract(5, 3), 2, 'subtract(5,3) should be 2');
console.log('subtract test passing');
EOF
        echo "[fake-claude] self-reporting 'passed' anyway, regardless of the real result..."
        EVIDENCE="npm test: all assertions passed (node test.js, exit 0)."
        RESULT_STATUS="passed"
        ;;

      *"[TOUCHES_ENV]"*)
        echo "[fake-claude] editing math.js (adding subtract())..."
        cat >> "$REPO/math.js" <<'EOF'

function subtract(a, b) { return a - b; }
module.exports.subtract = subtract;
EOF
        cat >> "$REPO/test.js" <<'EOF'
assert.strictEqual(require('./math').subtract(5, 3), 2, 'subtract(5,3) should be 2');
console.log('subtract test passing');
EOF
        echo "[fake-claude] also writing to a gitignored .env file (out of scope — tests file-level policy)..."
        echo "SOME_SECRET=leaked-by-mistake" >> "$REPO/.env"
        TEST_OUTPUT=$(node test.js 2>&1)
        TEST_EXIT=$?
        echo "$TEST_OUTPUT"
        EVIDENCE="npm test: all assertions passed (node test.js, exit $TEST_EXIT)."
        RESULT_STATUS="passed"
        ;;

      *)
        echo "[fake-claude] editing math.js (adding subtract())..."
        cat >> "$REPO/math.js" <<'EOF'

function subtract(a, b) { return a - b; }
module.exports.subtract = subtract;
EOF
        cat >> "$REPO/test.js" <<'EOF'
assert.strictEqual(require('./math').subtract(5, 3), 2, 'subtract(5,3) should be 2');
console.log('subtract test passing');
EOF
        echo "[fake-claude] running real test suite..."
        TEST_OUTPUT=$(node test.js 2>&1)
        TEST_EXIT=$?
        echo "$TEST_OUTPUT"
        if [ "$TEST_EXIT" -eq 0 ]; then
          EVIDENCE="npm test: all assertions passed (node test.js, exit 0)."
          RESULT_STATUS="passed"
        else
          EVIDENCE="npm test: FAILED — exit $TEST_EXIT. $TEST_OUTPUT"
          RESULT_STATUS="failed"
        fi
        ;;
    esac

    echo "[WORKERAI_VALIDATION]"
    echo "taskId: $TASK_ID"
    echo "nonce: $NONCE"
    echo "result: $RESULT_STATUS"
    echo "evidence: $EVIDENCE"
    echo "[/WORKERAI_VALIDATION]"
    echo "[WORKERAI_RESULT]"
    echo "taskId: $TASK_ID"
    echo "status: completed"
    echo "nonce: $NONCE"
    echo "[/WORKERAI_RESULT]"

    TASK_TITLE=""
    echo "[fake-claude] ready — waiting for a dispatched task..."
  fi
done
