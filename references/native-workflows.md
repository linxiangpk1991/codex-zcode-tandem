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

This is a template, not a runnable complete request: add absolute cwd/output paths, model, thought=max, mode=build, allowed tools and deadline. Replace the hash with the actual value. All actors share the bound model. Separate contexts do not imply tool isolation; a read-only prompt alone does not enforce read-only access. Declare roles explicitly and do not recursively add workers.

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
