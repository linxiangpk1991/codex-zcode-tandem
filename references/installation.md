# Installation, checks, updates and rollback

[简体中文](installation.zh-CN.md) · [Home](../README.md)

## 1. Prepare Windows and Node

Use **Node 24.19.0**, Windows, and your own installed/signed-in ZCode. The current same-machine connection baseline is Desktop 3.14.5.7961 / native CLI 0.16.9. The launcher rejects other Node versions and platforms instead of silently relaxing the pin.

Confirm `node.exe --version` prints `v24.19.0` and `npm.cmd` belongs to that same Node installation. Obtain that release from [Node's official archive](https://nodejs.org/dist/v24.19.0/), if needed.

Clone the [public repository](https://github.com/linxiangpk1991/codex-zcode-tandem), or download its source ZIP. Choose a permanent folder; Chinese characters, spaces and non-system drives are supported.

From the source root:

```powershell
npm.cmd ci --prefix runtime --ignore-scripts --no-audit --no-fund
node.exe scripts/setup.mjs
```

npm installs the locked dependencies. The setup script itself neither downloads dependencies nor copies login information. If npm fails, fix the reported network or environment problem; do not delete the lockfile to disguise a mismatch.

## 2. Locate ZCode and sign in

Setup checks common LocalAppData/Programs/ZCode and Program Files locations. It does not scan every drive. For a custom location:

```powershell
node.exe scripts/setup.mjs --zcode-bin 'D:/Apps/ZCode/resources/glm/zcode.cjs'
```

Sign in through ZCode itself. `provider_config.json` is an **optional custom-provider configuration**, not a required Coding Plan login file. It may be absent. `--provider-file` selects an existing optional configuration; it is not an account-transfer mechanism.

Native data follows `ZCODE_HOME`, otherwise `HOME` or the current user's home plus `.zcode`. Do not paste tokens into chat, local config, or Git.

Path precedence: setup arguments → runtime/config.json → ZCODE_NATIVE_BIN / ZCODE_NATIVE_PROVIDER_FILE → discovery. The environment variable names retain native-adapter compatibility. Relative saved paths resolve from runtime/; relative setup arguments resolve from the shell directory. Absolute paths are easier to inspect.

## 3. Register the public skill

New installations use `~/.agents/skills/codex-zcode-tandem`, matching the [documented user skill directory](https://learn.chatgpt.com/docs/build-skills). An existing same-name entry under CODEX_HOME/skills (or ~/.codex/skills) is reused. If both locations contain it, setup asks you to select one explicitly:

```powershell
node.exe scripts/setup.mjs --skills-dir 'D:/MySkills'
```

A custom directory must also be discoverable by your Codex installation. Normally use the default. `--codex-home` supports the older layout; it cannot be combined with `--skills-dir`.

The public name is **codex-zcode-tandem**. A different skill named **zcode-native** is left alone. Installing Tandem does not migrate or replace it.

Changed existing entries require `--replace`. Setup first saves SKILL.md.backup-* and preserves other files. Repeated identical installation does not create repeated backups. If the checkout itself is the skill directory, its canonical SKILL.md stays intact; otherwise setup writes a small pointer recording the source root and this Node executable.

Reload skills or open a new Codex chat, then use `$codex-zcode-tandem`. If you move the checkout or Node installation, rerun setup.

## 4. Check the local setup and native connection

This check writes nothing:

```powershell
node.exe scripts/setup.mjs --check
```

`--check` reads file metadata, the pinned ACP version and this source root's last successful probe cache. It does not launch CLI, re-hash, or write files. `not_verified` means no baseline; `metadata_unchanged` does not prove unchanged source.

After a desktop update, run `node.exe scripts/setup.mjs --doctor`. It freshly reads Desktop product version, CLI `--version`, ACP version and native entry SHA256, compares the baseline, and never advances it. A changed hash requests a compatibility probe even if the CLI version matches. There is no implicit network lookup, upgrade or blanket task block.

A pass proves local paths, pinned versions and dependencies. It does not prove login, quota or a native connection. Run a connection probe without model inference:

```powershell
New-Item -ItemType Directory -Path work -Force | Out-Null
$probe = @{
  action = 'probe'
  cwd = (Get-Location).Path
  model = 'GLM-5.3'
  thought = 'max'
  mode = 'build'
  timeoutSeconds = 60
  progressFile = (Join-Path (Get-Location).Path 'work/probe-progress.json')
  resultFile = (Join-Path (Get-Location).Path 'work/probe-result.json')
}
$probe | ConvertTo-Json | Set-Content -LiteralPath work/probe-request.json -Encoding utf8
node.exe runtime/run-task.mjs work/probe-request.json
```

Inspect status=completed, the effective Coding Plan model, thoughtEffective=max, modeEffective=build, and cleanup. A successful probe still does not prove sufficient inference quota. Try a small real task next; see [examples](../docs/examples.md).

A completed probe with stable installation identity saves `work/native-identity.json` in this source root. Failed probes, unconfirmed cleanup and installation changes do not advance that baseline. A custom layout without an adjacent `ZCode.exe` reports a null Desktop version with a reason; CLI/SHA inspection remains available. No credential contents are read.

## 5. Update, roll back, or remove the entry

Pause and inspect active work first. Keep session/run IDs and results. Update the checkout using Git, install from the new lockfile, then run setup --check, setup --replace, and the probe. Existing local path/configuration values are preserved.

For rollback, stop new invocations, restore a retained checkout with its matching lockfile, and reinstall from it or restore its entry backup. Do not use the old client to take over a still-running newer session. Neither pause nor rollback of the adapter reverses edits made in your project.

To remove the skill, inspect and remove only its generated codex-zcode-tandem entry. The installer does not automatically delete source code, project files, or ZCode login data.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| zcode.cjs not found | Specify the real resources/glm/zcode.cjs inside your installation. |
| No provider_config.json | It is optional for built-in Coding Plan; test the connection, and fix login in ZCode. |
| Wrong/missing ACP | Run npm ci with the repository's lockfile. |
| ZCode version differs or probe fails | Keep the error and check the actual version. A local setup pass is not compatibility proof. |
| Entry already exists | Inspect the target and use --replace for the intended update. |
| Skill missing from Codex | Reload skills/open a new chat; check the discovery directory and active Codex home. |
| Quota unavailable | Resolve your subscription or wait; there is no automatic paid-channel switch. |
| ACP_LOGIN_SHELL_FALLBACK | ACP 0.65.1 exposes no supported Windows skip switch. Inspect environment.toolPaths and check project tools using explicit executables/installed dispatchers in the inherited environment. Do not change SHELL or inject Bash to suppress this warning. |
