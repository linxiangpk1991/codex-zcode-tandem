# Workspace protection and test evidence

## Quota summaries in 1.2

`summary.quotaSnapshots.before/after` and `action=quota`'s `summary.quota` show GLM provider status, window remainingPercent/usedPercent, UTC resetsAt and original epoch-millisecond nextResetTime. Missing or invalid values are null. A successful ACP response may still contain auth_error, rate_limited or unavailable. Raw responses remain in resultFile. These are shared-account observations, not exact task billing; the upstream API exposes no manual-reset count and this skill does not infer or trigger resets.

A finished model turn is not a passing test. Before accepting a handoff, check which files changed and what the test runner actually returned.

## Declare ownership in the request

Editing and shell execution now require `workspace`. Paths are relative to `cwd`; a directory covers its descendants. Preserved paths take precedence over owned paths. Git metadata is protected, and symlinks and Windows junctions are checked against their resolved targets.

```json
{
  "workspace": {
    "ownedPaths": ["src/cache", "tests/cache.test.mjs"],
    "preservedPaths": ["src/cache/controller-notes.md"],
    "commands": ["git status --short", "node --test tests/cache.test.mjs"]
  },
  "allowToolKinds": ["read", "search", "edit", "execute"]
}
```

Each Bash command must match a complete reviewed `commands` entry exactly. A prefix such as `node` or `git` is not a grant. Codex should inspect the script, arguments and effects first; do not approve arbitrary generated scripts. A different command needs a new request. File ownership applies to file tools, not to writes inside an approved script.

Common direct `git stash/reset/clean/switch/checkout/restore/worktree` calls are also rejected. Codex prepares baseline directories and worktrees. Shelving everybody's changes is not routine test preparation.

This is a permission-callback guard, not an OS sandbox or a full shell parser. Native auto-allowed tools, resumed sessions and background actors may omit callbacks. The client also compares completed tool events with the policy: a violation marks needs_attention and stops later planned phases. This post-hoc observation cannot undo effects. Use an isolated checkout when edits need isolation; external MCP tools and approved scripts do not inherit the file-tool path restrictions.

## Keep the actual test result

Use the project's existing test runner. Prepare an input specification first:

```json
{
  "name": "cache regression",
  "cwd": "C:/projects/example",
  "command": ["C:/tools/node.exe", "--test", "tests/cache.test.mjs"],
  "candidateFiles": ["src/cache/store.mjs", "tests/cache.test.mjs", "package-lock.json"]
}
```

Run `node scripts/check-evidence.mjs prepare SPEC.json PREPARED.json`, execute the same argv through the existing runner, then run `node scripts/check-evidence.mjs inspect PREPARED.json RECEIPT.json`. Use a separate local receipt for each execution.

Preparation binds the command, directory, time and declared inputs' SHA-256. Include every source, test and configuration file that the conclusion depends on. Unlisted inputs are outside the claim. Do not prepare the binding after the test. Execute first and filter the log separately; `test | grep ...; echo done` does not preserve the test's exit code.

The importer accepts `codex-bounded-command` schema 2, but that runner is not a dependency. Other runners can emit this format using their actual process result, never values inferred by a model from prose:

```json
{
  "kind": "tandem-command-receipt", "version": 1,
  "cwd": "C:/projects/example",
  "command": ["C:/tools/node.exe", "--test", "tests/cache.test.mjs"],
  "startedAt": "2026-10-07T01:00:00.000Z",
  "finishedAt": "2026-10-07T01:00:02.000Z",
  "exitCode": 1, "outcome": "fail", "outputTruncated": false
}
```

Add `verification: [{"preparedFile":"absolute path","receiptFile":"absolute path","failureClass":"unclassified"}]` to a task request. Other failure classes are `product`, `fixture`, `environment` and `known_baseline`. Classification never turns a failure into a pass.

Missing receipts are `not_run`; changed inputs are `stale`; command or time mismatches are `invalid`; truncated output is `incomplete`. The aggregate is `pass` only when every declared check passes. These are reviewable local records, not tamper-proof or independently signed attestations.

## Give steering a useful boundary

Choose coherent `prompts` phases: plan/compatibility, implementation, tests, self-review as appropriate. Avoid both one turn per command and an hour of work inside the first turn. Queued steering runs after the current foreground turn and before the next planned phase.

Controls retain `submittedAt`, `acceptedAt`, `startedAt` and `completedAt`. `queueDurationMs` measures submission to start; `executionDurationMs` measures execution. A queue older than five minutes shows `waiting_for_foreground_boundary` without polling the model. Pause rejects unexecuted messages; it does not replay them automatically.

New progress files also bind runtimeRoot. Mutating controls must use that runtime directory. For legacy progress without a binding, keep using its original control.mjs; read-only status remains available across versions. Prepare upgrades in separate version directories so new invocations can use the new version while existing ones retain their original files.

## Diagnose startup and read a smaller handoff

ACP 0.65.1 probes the environment using POSIX `-l -c env -0` arguments. When SHELL points to PowerShell or pwsh this may fail and fall back to the inherited environment. Tandem preserves stderr and reports `ACP_LOGIN_SHELL_FALLBACK`. It does not patch the dependency or rewrite global PATH. A successful session proves native startup, not the availability of project tools. Child Python processes explicitly use UTF-8.

Set `summaryFile` for a compact status, verification result, recent controls and evidence boundaries. Full details stay in `resultFile`. `previewTruncated` means a turn preview exceeds 2000 characters; the old `truncated` alias remains for compatibility. `evidence.*Truncated` describes retained full records. Unmeasured transport bytes are `null`.

Policy-relevant inputs are retained before log compaction, without keeping file contents. If their retention budget is exceeded, unverifiedToolScopes records unknown evidence and the task needs attention; it does not label an unknown input as a confirmed violation.

Optional `quotaSnapshots: true` reads shared account usage once before and once after the task. Unavailable data is reported as unavailable. There is no background polling or paid-provider fallback. Shared quota changes are not exact task billing, and response length is not a token count.

## Choose checks that match the change

- Cache semantics: cover an existing warm cache, a new cold cache and recomputation after invalidation.
- DOM, escaping or visible text: use a real browser when the claim depends on rendering. Fix incorrectly escaped fixtures without changing correct product behavior.
- Missing patches in an isolated directory or child-process encoding failures: check controller preparation and environment before blaming the native engine or product code.

These checks apply when relevant; they do not require a browser or a full regression run for every task.
