# Demo Readiness Checklist: EAI Interview

Run through this once the evening before, once again 30 minutes before the
call. Everything here is local/disposable, nothing touches a live remote
server or production data.

## 1. Environment sanity (one-time, or after a fresh clone)

- [ ] `cd claude-task-monitor && npm install`
- [ ] Postgres running: `docker ps` shows `medflow-postgres` (or start it:
      see `README.md` §Setup)
- [ ] `.env` present with a real `DATABASE_URL` and `AUTH_SECRET`
- [ ] `npm run db:migrate`, no pending migrations error
- [ ] `cd ../verifier-service && python3 -m venv .venv && . .venv/bin/activate
      && pip install -r requirements-dev.txt`

## 2. Validation run (do this the night before, not 5 minutes before)

```bash
cd claude-task-monitor
npx tsc --noEmit                 # expect: clean
npm run lint                     # expect: clean
npx vitest run                   # expect: all passing (service-account 16, verifier-client 4, +others)
npm run build                    # expect: production build succeeds
```

```bash
cd ../verifier-service && . .venv/bin/activate
python -m pytest -v              # expect: 20 passed
```

If any of these fail, **do not** proceed to the live demo until fixed or
the affected segment is dropped from the script, never paper over a real
failure mid-interview.

## 3. Live demo dry-run (do this at least once before the call)

```bash
cd claude-task-monitor
npm run demo:validation
```
Expect: agent self-reports `PASSED`, independent re-execution reports
`FAILED` on the `test` step, final verdict disagrees and blocks completion.

```bash
cd verifier-service && . .venv/bin/activate
VERIFIER_SHARED_SECRET=demo-secret uvicorn app.main:app --port 8008 &
cd ../claude-task-monitor
VERIFIER_SERVICE_URL=http://localhost:8008 VERIFIER_SHARED_SECRET=demo-secret \
  npx tsx scripts/demo-python-verifier.ts
# when done:
pkill -f "uvicorn app.main:app"
```
Expect: three verdicts print (all-green / build-disagreement / sensitive-file).

- [ ] Both scripts ran clean, in this exact order, on this machine, today
- [ ] Port 8008 is free before the call (kill any stray `uvicorn` from a
      previous dry-run: `pkill -f "uvicorn app.main:app"`)

## 4. Showcase site

- [ ] https://krischuang.github.io/WorkerAI/ loads, check the `#walkthrough`
      section and the architecture diagram render without horizontal
      scrollbars at your actual screen-share resolution
- [ ] Every screenshot in `#screenshots` is captioned 1–4 with no gaps, and
      the LIVE / SEEDED legend above them is visible

## 5. Tabs and windows to have ready before the call

- [ ] Terminal, font size bumped up (test it on the actual external monitor
      /projector resolution if you can, not just your laptop screen)
- [ ] `lib/validation-gate.ts` open in an editor, `VerificationState` type
      visible without scrolling
- [ ] `lib/service-account.ts` and `app/api/v1/projects/[id]/route.ts` open
- [ ] `verifier-service/app/auth.py` and `verdict.py` open
- [ ] Showcase site tab
- [ ] GitHub repo tab, specifically the Actions tab (if asked "does CI
      actually run this", you want to click, not describe)
- [ ] Close Slack/email/calendar notifications. Screen-sharing a popup
      notification mid-interview is a bad look regardless of content.
- [ ] Confirm Teams is sharing the specific window/app, not the whole
      desktop, unless you intend that

## 6. The honesty script, memorize this part specifically

If asked anything close to "is this production-ready" or "is this real":

> "The independent-verification state machine and the policy/kill-switch
> gates are pre-existing and load-bearing in this app's actual task
> pipeline. The service-account scoping and the Python verifier are new
> this pass, tested, and real, but the Python verifier is not wired into
> the live completion path, that's a documented, deliberate choice, not a
> gap I'm hiding."

Have `EAI-TRADEOFFS.md`'s "Known technical debt, ranked" section memorized
well enough to summarize without reading it verbatim.

## 7. Timing

- Technical round: use `EAI-WALKTHROUGH.md` (~4 minutes, 4 segments)
- HR round: use `../eai-interview-demo.md` (~3 minutes, 2 segments)
- Either way: leave the last 30–60 seconds of your allotted time unused on
  purpose, for a follow-up question, don't run the clock to zero on a
  monologue

## 8. What this checklist explicitly does NOT cover

- Dispatching a real task to a real remote worker over SSH/tmux, this demo
  intentionally never does that live; the recorded evidence in
  `docs/DEMO_RUN_RECORD.md` stands in for it, and is labeled as a captured
  record, not a live run, if shown
- Any change to `AUTH_SECRET`, `ADMIN_PASSWORD`, or production
  configuration, none of this checklist should ever touch a non-local
  environment
