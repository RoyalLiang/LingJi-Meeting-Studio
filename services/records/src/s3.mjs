import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, GetBucketVersioningCommand } from '@aws-sdk/client-s3';
import { requireThat } from '../../../packages/records/src/record.mjs';

// All object operations stay within this application's record-specific prefix.
export async function createS3Objects(options = {}) {
  const bucket = options.bucket || process.env.RECORD_S3_BUCKET;
  if (!bucket) return null;
  const client = options.client || new S3Client({ region: process.env.AWS_REGION || 'us-east-1', endpoint: process.env.RECORD_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.RECORD_S3_PATH_STYLE === 'true', maxAttempts: 3 });
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  requireThat(!versioning.Status, 's3_bucket_must_have_versioning_disabled', 500);
  const prefix = 'meeting-audio/';
  const keyFor = object => { requireThat(/^[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(object), 'invalid_object', 400); return prefix + object; };
  async function read(object) {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(object) }));
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    requireThat(createHash('sha256').update(bytes).digest('hex') === object.split('/')[1], 'audio_object_corrupt', 500); return bytes;
  }
  return {
    async put(recordId, bytes) {
      const hash = createHash('sha256').update(bytes).digest('hex'), object = `${recordId}/${hash}`;
      try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(object), Body: bytes,
        ContentType: 'application/octet-stream', ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'), IfNoneMatch: '*' })); }
      catch (error) { if (error.$metadata?.httpStatusCode !== 412) throw error; await read(object); }
      return { digest: hash, object };
    },
    read,
    async clean(recordId, live = new Set(), olderThan = Infinity) {
      requireThat(/^[a-f0-9-]{36}$/.test(recordId), 'invalid_record_id', 400);
      let token;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}${recordId}/`, ContinuationToken: token, MaxKeys: 1000 }));
        const objects = (page.Contents || []).filter(item => item.Key && !live.has(item.Key.slice(prefix.length)) && +item.LastModified < olderThan).map(item => ({ Key: item.Key }));
        if (objects.length) { const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } })); requireThat(!result.Errors?.length, 's3_cleanup_incomplete', 503); }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    close() { client.destroy?.(); }
  };
}
