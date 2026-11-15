// Screenshot provenance only. Hashes prove which files were handed over;
// neither a screenshot nor a GLM text response proves visual acceptance.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';

export function normalizeVisualArtifacts(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('visualArtifacts must contain at most 20 local image paths');
  for (const file of value) {
    if (typeof file !== 'string' || !file.trim() || isAbsolute(file) || file.split(/[\\/]/).includes('..')
      || !['.png','.jpg','.jpeg','.webp'].includes(extname(file).toLowerCase())) throw new Error('visualArtifacts must name relative PNG/JPEG/WebP files');
  }
  return [...new Set(value)];
}
export function captureVisualArtifacts(cwd, files, candidateSha256) {
  const root = realpathSync(cwd);
  return { status: files.length ? 'pending_controller' : 'not_supplied', candidateSha256,
    capturedAt: new Date().toISOString(), artifacts: files.map(file => {
      const path = realpathSync(resolve(root, file)), part = relative(root, path), stat = statSync(path);
      if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`) || !stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Visual artifact escapes cwd or exceeds 25 MiB');
      const data = readFileSync(path);
      const png = data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpg = data[0] === 255 && data[1] === 216 && data[2] === 255;
      const webp = data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP';
      if (!png && !jpg && !webp) throw new Error('Visual artifact is not a recognized image');
      return { file, path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    }), boundary: 'Controller visual review required; this record is file provenance, not visual acceptance.' };
}
export function verifyVisualArtifacts(request, report) {
  const files = request.delivery?.visualArtifacts ?? [];
  if (!files.length) return;
  const previous = report.visualEvidence;
  const current = captureVisualArtifacts(request.cwd, files, report.firstPassReview?.candidateSha256);
  if (!previous || previous.candidateSha256 !== current.candidateSha256
    || JSON.stringify(previous.artifacts) !== JSON.stringify(current.artifacts)) throw new Error('Visual evidence is missing or changed since handoff');
}
