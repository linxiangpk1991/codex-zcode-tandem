# Usage and review metrics

[简体中文](metrics.zh-CN.md) · [Home](../README.md)

Give each prompt an explicit `phase`: `implementation`, `review`, `repair`, `validation` or `other`. Omitted phases become `other`; the automatic first-pass review becomes `review`. A steering message is not automatically counted as a repair.

```json
{"label":"repair-boundary","phase":"repair","text":"Fix the confirmed issue and run the approved check."}
```

`result.metrics`, `progress.metrics` and `summary.metrics` share one source. `total` covers ended foreground prompts, `stages` groups their declared phases, and `turns[].metrics` keeps each turn. `elapsedMs` is local wall time including tools and waiting. Failed and interrupted calls remain visible.

Tokens come only from the corresponding ACP `PromptResponse.usage`. `reportedByField` tells you how many turns supplied each value. If two of three turns report total tokens, the sum covers two turns; it is not a complete task bill. Missing or invalid values remain `null`; a reported zero remains zero. Input tokens exclude cache reads/writes, which have separate fields.

Native `turnState` notifications have no turn ID and also cover context compaction. Tandem subscribes to one alias and uses it only as session activity, so `nativeTurnMs` remains `null`. Background actor usage is outside foreground prompt coverage. Shared-account quota snapshots are not task billing.

`firstPass` counts fixed/open issues declared by the model and labels them `model_reported`. Later steering invalidates that declaration. `controllerFindings` stays `null` when no controller findings were collected; no quality improvement rate is invented.
