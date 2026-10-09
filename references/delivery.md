# Review, repair, verify, then hand back

ZCode should inspect its final changes, fix the problems it finds, and run the relevant checks before Codex starts final acceptance. This workflow makes that first pass explicit without treating the author's own review as independent approval.

## Describe the candidate

An `action=run` request granting `edit`, or declaring owned paths for execution/native workflows gets a final `tandem:first-pass-review` turn automatically. Read-only queries, quota calls and connection probes do not. The turn uses the existing permissions and total timeout. It does not grant commands or launch another agent. Existing self-review prompts may remain as intermediate checks, or be removed to avoid duplication.

Add this to an implementation request:

```json
{
  "delivery": {
    "candidateFiles": ["src/editor.ts", "tests/editor.test.ts"],
    "userPaths": ["edit-save-refresh"],
    "validation": "required",
    "visualReview": "controller"
  },
  "verification": [
    {
      "preparedFile": "C:/projects/example/work/save-prepared.json",
      "receiptFile": "C:/projects/example/work/save-receipt.json"
    }
  ]
}
```

`candidateFiles` lists concrete paths relative to the project directory: no directories, wildcards or escaping paths. Include the source, tests and configuration covered by this review. Deleted files may be listed for review of their deletion diff. Omitting the scope still runs review, but cannot produce a ready handoff.

`userPaths` names the functional flows that need verification. Omit it when the change has no user interaction. Add the same names to the existing SPEC used by `check-evidence.mjs prepare`. A passing receipt then covers those declared flows. Codex must check that the test actually exercises them; renaming a unit test does not make it a browser or business test.

Use the project's existing runner. Prepare the check before execution, including its actual source/test/config dependencies in the SPEC's `candidateFiles`, then inspect the runner's receipt. Never ask the model to manufacture a receipt from its summary. A prose-only change may use `validation: "not_applicable"` with a specific `validationReason`; this cannot skip declared user paths or hide declared failing checks.

## What the first pass should do

- Check the shortest essential user flow before expanding to other modules. For editing, cover opening, changing, the actual save request, its response, and persisted readback after refresh.
- Read the final diff and integration points. A component existing does not mean it is registered; a passing API test does not mean the form sends the right fields.
- Reinspect fixes and rerun only affected checks. Reuse passing checks whose inputs remain unchanged.
- Distinguish product, test/fixture, environment and proven baseline failures. After two attempts at the same cause without new evidence, diagnose or report the blocker instead of repeating.
- If execution or environment access is unavailable, report pending validation. Codex can run the approved checks and send actual failures back for repair.

The automatic turn requires observed inspection tool activity and a structured `tandem-review` declaration listing fixed and open issues. The runtime records the candidate content at completion. It can verify the turn, content binding and receipts, but cannot prove that the review was thorough or free of missed defects.

## Functional checks and visual acceptance

GLM-5.3 can work with DOM state, network requests and test output. Screenshot interpretation, layout judgment and overall visual quality belong to a vision-capable controller or a person. With `visualReview: "controller"`, the result stays `pending_controller`; passing functional checks never mark visual acceptance complete. A model's vision capability and the tools available through a particular ACP session must be verified separately. This feature does not switch models.

## Read the result and resume safely

| `delivery.status` | Next step |
| --- | --- |
| `needs_review` | Complete review or scope; inspect interruption, late steering, changed files or missing evidence |
| `changes_requested` | Resolve the review's open issues |
| `awaiting_validation` | Supply missing checks or repair failed/stale checks |
| `ready_for_controller_review` | Start independent acceptance; visual review may still be pending |
| `not_applicable` | No delivery check was declared for this operation; this is not implementation acceptance |

`status: completed` still means the native invocation ended. An unready implementation now exits with **4**. Existing codes 1/2/3 retain error, timeout/cancellation and pause meanings. Update callers to handle 4; do not interpret it as an engine crash and replay all the work.

After Codex runs checks into the receipt locations from the original request, reevaluate without another model call:

```powershell
node.exe scripts/check-evidence.mjs handoff C:/projects/example/work/result.json
```

This read-only command uses the contract saved in the result, checks current files and receipts, and leaves the original result unchanged. Exit 0 means ready for controller review; 4 means something remains. Do not rewrite an old report to clear findings.

After a pause, resume the original `sessionId` with the same ownership, candidate scope and verification requirements, requesting only unfinished work. The runtime adds a fresh final review. Steering after review invalidates it even if the files did not change: the new requirements still need review. Background work must finish first. A `workflow-resume` management result is not a delivery result; follow it with a scoped `run` for final review.

Upgrades do not change old invocations. Use the recorded `runtimeRoot` to control an existing task; new calls can use the new version.
