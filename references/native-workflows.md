# Native workflows

[简体中文](native-workflows.zh-CN.md) · [Home](../README.md)

Use workflows when parallel roles, dependency joins, saved node results or recovery help the task. Sequential work can use ordinary prompt phases. Before writing a script, read ZCode's installed dynamic-workflows skill and use its native API.

## Review and bind a script

Review the entire script, actor ownership and every world.run command. Hash its exact UTF-8 bytes with SHA-256 and bind the canonical model. A script change requires another review within the existing authorization.

An amendment also binds workflowRunId to its predecessor. Resumed sessions may omit permission callbacks. Inspect both workflowObservations (script/model/target) and actual permissions. Observation is not a sandbox and cannot undo an already executed tool.

These fields extend a normal request:

```json
{
  "nativeWorkflow": true,
  "waitForBackground": true,
  "approvedWorkflowSha256": "<exact-sha256>",
  "approvedWorkflowModel": "account:bigmodel-individual-coding-plan/GLM-5.3$max",
  "prompts": [
    {
      "label": "launch",
      "requiredTools": ["CreateWorkflow"],
      "text": "Read dynamic-workflows. Call CreateWorkflow with the reviewed script and GLM-5.3$max. Return the identifier and finish this turn; the client will wait."
    },
    {
      "label": "readback",
      "requiredTools": ["GetWorkflowRun"],
      "text": "Inspect the settled run. Report native results, actual tests, independent review and remaining risks. Do not replay the work."
    }
  ]
}
```

This is a template, not a runnable complete request: add absolute cwd/output paths, model, thought=max, mode=build, allowed tools and deadline. Replace the hash with the actual value and bind any nonempty args. Actors use the bound default model unless the reviewed script and approved role bindings specify otherwise. Separate contexts do not imply tool isolation; a read-only prompt alone does not enforce read-only access. Declare roles explicitly and do not recursively add workers.

## Run, observe and recover

One invocation manages one workflow. After an amendment, the observed successor becomes the current run. A further amendment needs a new request with that successor as its predecessor.

ACP sessionId and workflowRunId are distinct. Live controls only act on the invocation's bound runs and directory. workflow-settings accepts maxConcurrency from 1 to 4; confirm the native run-caps-changed event.

After interruption, use action=workflow-status with the original sessionId/cwd. For action=workflow-events also include workflowRunId and afterSequence. These management calls do not need model inference. Follow nextAfterSequence, hasMore and truncated.

action=workflow-resume requires the exact session, directory and run. It only resumes native resumable stopped/cancelled/failed runs, and rejects completed runs. Saved nodes can be reused. External effects with unknown results still require readback; resume does not guarantee exactly-once execution.

## Notification boundary and amendments

Native CLI 0.16.9 management resume may produce no summary notification. That action cannot include a subsequent foreground prompt. It may return when the native journal is terminal with notificationDisposition=not_observed_no_foreground_handoff and backgroundNotificationFinished=false.

Ordinary launch/readback phases still require terminal native state and a completed notification turn. Notification failure is an error.

For an amendment, retain the conversation, bind the reviewed new script/model/predecessor, and require an actual AmendWorkflow call. Inspect cache hits and node events. Reusing a cached test node does not mean the test was rerun.

Global auto-resume, unattended scheduling and paid fallback are not enabled. See [verification](acceptance.md) for what was actually exercised.

## 1.4: reviewed inputs and a reusable workflow

Bind exact `approvedWorkflowArgs`, `approvedWorkflowModelBindings`, and, only when an explicit concurrency is wanted, `approvedWorkflowMaxConcurrency` (1..4). Keys in JSON objects may be reordered; values and array order must match. An omitted approval allows only empty args/model bindings, not arbitrary inputs. Role bindings must use a configured Coding Plan model at the requested thought level.

Native permission inputs expand a path to its body. Tandem checks the whole file hash, the exact expanded body and its metadata line offset. Unresolved `saved` names must first become a reviewed local path. Unknown additional fields are rejected. `model_bindings` is an internal native extension, not a promise that the model-facing tool exposes a role mapping editor. Inline model declarations still require full script review.

An explicitly requested native workflow exposes its tools through invocation-local `alwaysOn`; ordinary tasks keep workflows disabled. This neither changes desktop settings nor starts a workflow without the script binding. `guarded` is an explicit opt-in; `build` remains the default and Auto-review is not code review.

[review-workflow.ts](review-workflow.ts) runs implementation, a fresh review actor, targeted repair and a deterministic Node test. Review the task, owned/preserved files, test path and resolved Node runtime before hashing the script and approving args. Changing a command changes the reviewed artifact. Actor personas are not a read-only sandbox; do not use this sample for production writes or publishing. Cached node results are not newly executed tests.

Default development review is now built into the runner. The workflow below remains an advanced example for explicit actors and persisted nodes; it is not needed to enable review.
