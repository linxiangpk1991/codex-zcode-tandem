// Bind a call to its real directory and Git worktree. Never creates, switches,
// stashes or cleans a worktree. The controller owns those operations.
import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function captureWorkspaceBinding(cwd) {
  const directory = realpathSync(cwd);
  let cursor = directory, hasGit = false;
  for (;;) {
    if (existsSync(join(cursor, '.git'))) { hasGit = true; break; }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!hasGit) return { version: 1, cwd: directory, git: null };
  const git = (...args) => execFileSync('git', ['-C', directory, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536, stdio: ['ignore','pipe','pipe'] }).trim();
  try {
    return { version: 1, cwd: directory, git: {
      root: realpathSync(git('rev-parse', '--show-toplevel')),
      directory: realpathSync(git('rev-parse', '--absolute-git-dir')),
      head: git('rev-parse', '--verify', 'HEAD'),
      branch: git('branch', '--show-current'),
    } };
  } catch { throw new Error('Cannot bind Git worktree identity; check Git availability, trust and HEAD'); }
}

export function assertWorkspaceBinding(cwd, expected) {
  const current = captureWorkspaceBinding(cwd);
  if (!expected || JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('Workspace identity changed: directory, worktree, HEAD or branch differs from the bound invocation');
  }
  return current;
}
