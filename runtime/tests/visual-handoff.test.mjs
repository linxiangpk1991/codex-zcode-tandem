import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeVisualArtifacts,captureVisualArtifacts,verifyVisualArtifacts} from '../visual-handoff.mjs';

test('image provenance stays pending and refuses changed images, candidates or paths',t=>{
  const root=mkdtempSync(join(tmpdir(),'tandem-visual-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'screen.png');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=','base64');
  writeFileSync(file,png);
  const request={cwd:root,delivery:{visualArtifacts:['screen.png']}};
  const report={firstPassReview:{candidateSha256:'candidate-a'},visualEvidence:captureVisualArtifacts(root,['screen.png'],'candidate-a')};
  assert.equal(report.visualEvidence.status,'pending_controller');verifyVisualArtifacts(request,report);
  report.firstPassReview.candidateSha256='candidate-b';assert.throws(()=>verifyVisualArtifacts(request,report),/changed/);
  report.firstPassReview.candidateSha256='candidate-a';writeFileSync(file,Buffer.concat([png,Buffer.from('changed')]));
  assert.throws(()=>verifyVisualArtifacts(request,report),/changed/);
  assert.throws(()=>normalizeVisualArtifacts(['../screen.png']),/relative/);
  writeFileSync(file,'not an image');assert.throws(()=>captureVisualArtifacts(root,['screen.png'],'a'),/recognized image/);
});
