// What `taskflow push` will do over HTTP, done in-process: send the payload, then
// whatever blobs the server says it lacks.

import { ingestCycle, putBlob } from '../../ingest.mjs';

export async function push(db, { projectId, userId, payload, blobs, only = () => true }) {
  const result = await ingestCycle(db, { projectId, userId, payload });
  const uploaded = [];
  for (const hash of result.missing) {
    if (!only(hash)) continue;
    await putBlob(db, { projectId, sha256: hash, body: await blobs.get(hash).read() });
    uploaded.push(hash);
  }
  return { ...result, uploaded };
}
