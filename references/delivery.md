# Independent review, repair and verification by default

After an implementation finishes, the runner starts the following loop. It does not depend on the model remembering a checklist, a `nativeWorkflow` flag or a copied example.

1. A fresh native session reviews the original requirements, later corrections, declared candidate files and check information. It does not inherit the developer conversation. Its native tool list contains Read, Glob and Grep only.
2. Concrete, in-scope findings go back to the original developer session. File ownership and command permissions stay in force.
3. The runner executes the caller's authorized checks, or reuses still-valid receipts. Changed inputs require fresh input hashes and a new run; unaffected passing checks are reused.
4. A new session reviews the correction. At most two repair rounds are allowed. Unresolved issues block the handoff.

Read-only queries, quota calls and connection probes do not enter this loop. Editing requests, resumed editing requests, and execution/native workflow requests with owned paths do. `delivery: false` cannot turn it off. Self-review during development is useful, but does not replace the final independent review.

## Prepare verification

The controller first inspects the effects of the project's existing test command. Prepare its exact arguments and the source, test and configuration files that affect it:

```json
{
  "name": "editor save",
  "cwd": "C:/projects/example",
  "command": ["C:/tools/node.exe", "--test", "tests/editor.test.mjs"],
  "candidateFiles": ["src/editor.mjs", "tests/editor.test.mjs"],
  "userPaths": ["edit-save-refresh"]
}
```

Run `node.exe scripts/check-evidence.mjs prepare SPEC.json PREPARED.json`, then include this in the development request:

```json
{
  "delivery": {
    "candidateFiles": ["src/editor.mjs", "tests/editor.test.mjs"],
    "userPaths": ["edit-save-refresh"],
    "visualReview": "controller"
  },
  "verification": [{
    "preparedFile": "C:/projects/example/work/check-prepared.json",
    "receiptFile": "C:/projects/example/work/check-receipt.json",
    "execute": true,
    "timeoutSeconds": 120
  }]
}
```

`execute: true` authorizes that specific check. Before model work starts, the entry point captures its complete argument list, directory, input files and functional paths. Editing the prepared file later cannot substitute a different command. The executable must be an absolute path and the check must use the task directory. Shell pipeline wrappers are rejected. Each check defaults to 120 seconds, accepts 1–600 seconds, and is also bounded by the remaining task deadline. The runner saves the actual exit code and bounded output, and stops its owned process tree on cancellation.

Use this path for local tests. Tests requiring services, port leases, external writes or host-specific controls must keep using the project's maintained runner. This field does not bypass those controls.

External runner receipts remain supported: omitting `execute` grants no automatic execution. When only the controller has the required environment, it runs the check. Missing, failed or stale evidence blocks delivery; the model must not manufacture receipts. A documentation task that has no applicable runtime check may use `validation: "not_applicable"` with a specific reason. This cannot skip declared functional paths or failing declared checks.

Prepared files and receipts are protected from model edits even inside ownedPaths. Imported evidence is pinned at dispatch; a change during the call requires explicit controller handoff readback. Pre-existing receipts are caller-supplied trusted inputs: verify their provenance first. This tool does not authenticate arbitrary external JSON with a signature. Reuse only known genuine passing results whose inputs are unchanged.

## Status and recovery

`qualityLoop` records reviewing/repair/validation, the independent session IDs, original developer session ID, result paths, usage and check results. Reviewer usage lives in `qualityLoop.reviews[].metrics`; it is not included in the parent session's metric total.

| delivery.status | Meaning |
| --- | --- |
| needs_review | Review is incomplete, evidence is missing, the candidate changed, or work was interrupted |
| changes_requested | Review findings remain unresolved |
| awaiting_validation | Actual checks are missing, failed, stale or do not cover the declared paths |
| ready_for_controller_review | Independent review and declared checks are ready for final controller acceptance |
| not_applicable | This operation does not involve a development handoff |

Native `completed` is not a ready handoff. The CLI returns 4 when the invocation ended but delivery is not ready. Pause cancels the independent reviewer too and waits for cleanup. An unconfirmed child cleanup makes the parent require attention. A resumed development request handles the remaining work and gets a fresh review. Steering received during review is processed before another review, including steering during the final review. Earlier review files are retained.

After supplying the receipts named by the original request, the controller can run `node.exe scripts/check-evidence.mjs handoff RESULT.json` to reassess delivery without changing the old report or repeating implementation.

## What still needs the controller

A fresh session has separate context and a smaller native tool list. It is not an operating system sandbox and can still miss bugs. The runner checks actual reads of every declared candidate, file hashes, session identity and real verification evidence. It cannot infer review depth from a clean declaration. Candidate scope and test selection remain the controller's responsibility.

GLM handles code and functional checks. Browser functionality is checked through DOM state, requests/responses and persisted readback. Screenshots, layout and visual quality need a vision-capable controller or a person. `visualReview: "controller"` keeps `pending_controller` visible.

Upgrades affect new invocations. Existing calls keep their original runtime directory. Old same-session review reports are not promoted to independent approval.
