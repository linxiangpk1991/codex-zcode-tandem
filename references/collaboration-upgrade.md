# Working with the new ZCode release

This release targets ZCode Desktop 3.18.2.10443, CLI 0.17.1 and ACP adapter 0.85.3 on Windows. The ACP adapter is a community project with its own version number.

## Change a requirement while ZCode is working

Send `steer` with `priority: "now"` to request a correction during the current turn. The native engine may queue it until a safe boundary. `priority: "next"` explicitly queues it. `ask` remains a separate follow-up turn.

```json
{"action":"steer","priority":"now","message":"Also reject empty input with a clear error. Keep the interface signature."}
```

Submission only puts the command in the inbox. Read `controls` for its progress and `steering.events` for the native response. Queued input is matched to real `turn.steerDrained` events using an input ID and a hash of the complete text. An uncertain result is never retried automatically. Delivery of a message does not establish that the code meets it.

Development handoffs still run the default loop: implement, review in a fresh session, repair in the original session, run authorized checks, and review again in another fresh session. There are at most two repair rounds. Later corrections invalidate the earlier review. Unresolved findings, unknown steering outcomes and missing checks prevent a ready handoff.

## Answer several questions at once

Native `AskUserQuestion` calls can now send a form with multiple questions and multiple selections. Progress exposes `pendingInput.format: "form"`, its exact `interactionId`, and a `schema`. Use the fields and choices from that schema.

```json
{"action":"answer","interactionId":"copy-the-current-id","answers":{"q_0":"Windows","q_1":["JSON","Markdown"]}}
```

Save the command and run `node.exe runtime/control.mjs PROGRESS.json ANSWER.json`. Alternatively, save just the answer object and use `--action answer --interactionId ID --answers-file answers.json`. Existing single-option `optionId` answers still work. Invalid types, unknown choices, old questions and duplicate answers are refused. Pausing cancels the wait without choosing an answer. Tool authorization and plan approval are separate from ordinary questions.

## Keep a task in the right worktree

The controller selects or creates the worktree and passes its absolute path as `cwd`. The runtime records the real directory, Git worktree metadata directory, branch and HEAD, then checks them before later turns and handoff. Uncommitted files do not change that identity. Changing branches or HEAD during a call requires a new invocation.

When resuming, copy `workspaceBinding` from the previous trusted result into the new request, along with `sessionId` and `cwd`. This detects changes before resume. Without the earlier binding, monitoring begins at the new invocation; it does not prove the historical session's directory. A directory without Git is bound by its real path. The runtime does not initialize a repository for you.

## Hand screenshots to a controller that can see them

A text development session can check DOM state, interactions, logs and test results. Layout, appearance and design fidelity still need a controller with vision.

```json
{"delivery":{"candidateFiles":["src/page.tsx"],"userPaths":["signup"],"visualReview":"controller","visualArtifacts":["artifacts/signup-desktop.png","artifacts/signup-mobile.png"]}}
```

Image paths are relative to the task directory. PNG, JPEG and WebP are supported. `visualEvidence` records absolute paths, sizes, SHA-256 hashes and the reviewed candidate hash. Missing files, paths outside the task directory and files changed after handoff cannot provide valid evidence. `pending_controller` means someone still needs to inspect the images. File hashes and functional tests do not establish visual acceptance.

## What was checked

A real Windows native task received a correction, had a fresh reviewer find deliberately seeded defects, repaired them in the original session, passed actual tests, and passed another fresh review before handoff. A separate native task answered two questions while preserving both selected output formats.

Focused regressions cover worktree changes, stale or duplicate answers, question/permission separation, changed images, credential source restrictions and failed native turns. These checks do not validate arbitrary projects or establish support for other operating systems.
