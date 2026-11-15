import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {captureWorkspaceBinding,assertWorkspaceBinding} from '../workspace-binding.mjs';

test('actual worktree identity distinguishes equal HEADs and detects later commits', t => {
  const root=mkdtempSync(join(tmpdir(),'tandem-binding-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.equal(captureWorkspaceBinding(root).git,null);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe',windowsHide:true,timeout:10000});
  git('init','-b','main'); git('-c','user.name=Tandem test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','baseline');
  const before=captureWorkspaceBinding(root);
  const worktree=join(root,'other worktree');git('worktree','add','-b','other',worktree);
  const other=captureWorkspaceBinding(worktree);
  assert.equal(before.git.head,other.git.head);assert.notEqual(before.git.directory,other.git.directory);
  assert.throws(()=>assertWorkspaceBinding(worktree,before),/identity changed/);
  writeFileSync(join(root,'unrelated.txt'),'dirty work');
  assert.deepEqual(assertWorkspaceBinding(root,before),before,'unrelated dirty files do not change worktree identity');
  git('-c','user.name=Tandem test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','new head');
  assert.throws(()=>assertWorkspaceBinding(root,before),/identity changed/);
});
