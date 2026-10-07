// Permission-callback guard, not a sandbox. Shell grants bind reviewed text;
// they cannot constrain what a script, dependency, or resumed native worker does.
import { existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, sep } from 'node:path';

function canonical(path) {
  const tail = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot resolve path');
    tail.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}

function inside(root, path) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

export function normalizeWorkspace(value, cwd) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workspace must be an object');
  for (const key of Object.keys(value)) {
    if (!['ownedPaths', 'preservedPaths', 'commands'].includes(key)) throw new Error(`Unknown workspace field: ${key}`);
  }
  const result = {};
  for (const key of ['ownedPaths', 'preservedPaths', 'commands']) {
    const items = value[key] ?? [];
    if (!Array.isArray(items) || items.some(p => typeof p !== 'string' || !p.trim())) {
      throw new Error(`workspace.${key} must contain nonempty strings`);
    }
    result[key] = [...new Set(items)];
  }
  const root = canonical(cwd);
  for (const path of [...result.ownedPaths, ...result.preservedPaths]) {
    if (!inside(root, canonical(resolve(root, path)))) throw new Error('workspace paths must stay inside cwd');
  }
  return result;
}

function editPaths(name, input) {
  if (name === 'ApplyPatch') {
    const patch = input?.patch ?? input?.patch_text ?? input?.input;
    if (typeof patch !== 'string') return [];
    return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1].trim());
  }
  // MultiEdit's edits all apply to the top-level file_path in the native schema.
  const paths = [input?.file_path, input?.path];
  for (const edit of input?.edits ?? []) {
    paths.push(edit.file_path, edit.path);
  }
  return paths.filter(p => typeof p === 'string' && p.length);
}

// Keep only policy-relevant input, before report compaction. Large file contents
// do not need to be retained to check their destination.
export function scopeInput(name, input) {
  if (!input || typeof input !== 'object' || input.truncated) return null;
  if (name === 'Bash') return { command: input.command, cwd: input.cwd,
    run_in_background: input.run_in_background, env: input.env ? true : undefined };
  if (name === 'ApplyPatch') {
    const patch = input.patch ?? input.patch_text ?? input.input;
    return typeof patch === 'string' ? { patch: patch.split('\n').filter(line => /^\*\*\* (?:Add File|Update File|Delete File|Move to): /.test(line)).join('\n') } : null;
  }
  return { file_path: input.file_path, path: input.path,
    edits: Array.isArray(input.edits) ? input.edits.map(e => ({ file_path: e?.file_path, path: e?.path })) : input.edits };
}

export function workspaceDecision(request, nativeName, rawInput) {
  const scope = request.workspace;
  const deny = reason => ({ allowed: false, reason, binding: 'workspace' });
  if (!scope) return deny('edit/execute requires explicit workspace ownership and reviewed commands');
  try {
    const root = canonical(request.cwd);
    if (nativeName === 'Bash') {
      if (rawInput?.run_in_background || rawInput?.env) return deny('background execution or per-command environment is not in the grant');
      const command = rawInput?.command;
      if (typeof command !== 'string' || !scope.commands.includes(command)) {
        return deny('shell command is not an exact reviewed workspace.commands entry');
      }
      if (rawInput.cwd && canonical(resolve(root, rawInput.cwd)) !== root) return deny('shell cwd differs from bound workspace');
      // Defense in depth for common direct Git commands, not a shell parser.
      // All other text, including wrappers and aliases, still needs exact review.
      if (/^\s*git(?:\.exe)?\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+)*(?:stash|reset|clean|switch|checkout|worktree|restore)\b/i.test(command)) {
        return deny('Git workspace state changes belong to the controller');
      }
      return { allowed: true, reason: 'exact reviewed shell command at bound cwd', binding: 'workspace' };
    }
    const paths = editPaths(nativeName, rawInput);
    if (!paths.length) return deny('cannot determine all edited paths');
    for (const path of paths) {
      const lexical = resolve(root, path);
      const target = canonical(lexical);
      if ([lexical, target].some(p => !inside(root, p) || relative(root, p).split(sep).some(s => s.toLowerCase() === '.git'))) {
        return deny('edit escapes workspace or targets Git metadata');
      }
      if (scope.preservedPaths.some(p => inside(canonical(resolve(root, p)), target))) return deny('edit targets a preserved path');
      if (!scope.ownedPaths.some(p => inside(canonical(resolve(root, p)), target))) return deny('edit is outside owned paths');
    }
    return { allowed: true, reason: 'all edited paths are owned and not preserved', binding: 'workspace' };
  } catch (e) { return deny(`workspace check failed: ${e.message}`); }
}
