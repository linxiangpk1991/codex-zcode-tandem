# Three ways to use Tandem

[简体中文](examples.zh-CN.md) · [Home](../README.md)

These are task briefs, not benchmark results. Replace project names, paths and commands with real ones. Start with a small disposable project if this is your first native ZCode task.

## 1. Fix one reproducible bug

In Codex:

> $codex-zcode-tandem The search field accepts whitespace as a valid query. Ask ZCode to fix this in the search module and add a regression test. Keep the API shape unchanged. First inspect the existing edits and preserve them. You review the diff and actual test output before calling it done.

Codex should inspect the project, identify ownership and the existing test command, then send that context to ZCode. The useful output is the small code change, a relevant test result and any unresolved issue.

During the task:

> Ask ZCode which input cases it has checked.
>
> Keep the current error message. Only change how an empty value is recognized.

The first message is a queued question; the second is queued steering. Neither can alter a tool call already running. Check the completion receipt before assuming a change was applied.

## 2. Get an independent review

> $codex-zcode-tandem Ask a fresh ZCode session to review the current diff against the original export requirements. Read only. Focus on date boundaries and missing rows. Report file locations and inputs that would trigger a problem. Do not make changes or run shell commands.

Give the reviewer the original requirement and actual candidate. Use a separate session, tool restrictions and a concrete scope. Codex evaluates each finding; the reviewer is not the final authority. Static inspection does not prove the tests ran.

## 3. Split a larger change without losing the joins

Suppose a change has an input-normalization module and an independent output-formatting module, followed by integration tests:

> $codex-zcode-tandem Prepare a native ZCode workflow: one actor owns normalization, one owns formatting, then a test node waits for both. Give a separate reviewer the completed candidate. Show the actor ownership and test command before starting. No actor may change the other's files or publish anything.

Use [native workflows](../references/native-workflows.md) when the project actually has independent work. Codex reviews the script and binds its hash/model. A paused or interrupted workflow can preserve node results, but unknown external writes still need readback before retry.

## Try the runner directly

The skill normally prepares the request. For manual use, copy runtime/request.example.json to work/request.json and replace every placeholder path. The example only permits read/search and asks for read-only inspection.

```powershell
New-Item -ItemType Directory -Path work -Force | Out-Null
Copy-Item runtime/request.example.json work/request.json
# Edit work/request.json: absolute cwd, progressFile and resultFile.
node.exe runtime/run-task.mjs work/request.json
```

In another PowerShell window, while it runs:

```powershell
node.exe runtime/control.mjs --progress work/example-progress.json --action status
```

Use the same progress path you put in the request. The real outputs are the progress snapshot and result JSON, plus whatever project files the authorized task changed. A question submitted after the process exits cannot be consumed; use the saved session in a new request.

See [task briefs](../references/worker-prompts.md) for phase templates and result fields.
