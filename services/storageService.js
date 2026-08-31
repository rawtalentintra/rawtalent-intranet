const { createClient } = require('@supabase/supabase-js');

let client;
function getStorageClient() {
  if (!client) {
    // Service-role key — full bucket access, server-side only. Never send
    // this key to the browser.
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return client;
}

// STORAGE_BUCKET_PREFIX (2026-08-30) — a test/staging deployment shares
// this same Supabase project (and so the same Storage buckets) with
// production; the DB-level isolation (a separate `staging` Postgres
// schema, see db/schema.sql's comment) says nothing about Storage. Unset
// in production (bucket names unchanged); set to e.g. 'staging-' for a
// staging environment so its uploads land in their own, separately-named
// buckets instead of writing into live team photos/payslips/task files.
const BUCKET_PREFIX = process.env.STORAGE_BUCKET_PREFIX || '';
const BUCKETS = {
  teamPhotos: BUCKET_PREFIX + 'team-photos',
  articleFiles: BUCKET_PREFIX + 'article-files',
  callRecordings: BUCKET_PREFIX + 'call-recordings',
  announcementFiles: BUCKET_PREFIX + 'announcement-files',
  projectFiles: BUCKET_PREFIX + 'project-files',
  ideaFiles: BUCKET_PREFIX + 'idea-files',
  leadRecordings: BUCKET_PREFIX + 'lead-recordings',
  centreRecordings: BUCKET_PREFIX + 'centre-recordings',
  payslips: BUCKET_PREFIX + 'payslips',
  taskFiles: BUCKET_PREFIX + 'task-files'
};

// Every other bucket above was provisioned manually in Supabase ahead of
// time. This one wasn't, so create it on first use if it's missing —
// private, same as the rest (reads go through downloadAsBuffer, never a
// public URL).
const ensuredBuckets = new Set();
async function ensureBucket(bucket) {
  if (ensuredBuckets.has(bucket)) return;
  const storage = getStorageClient().storage;
  const { data, error } = await storage.getBucket(bucket);
  if (error && !data) {
    const { error: createError } = await storage.createBucket(bucket, { public: false });
    if (createError && !/already exists/i.test(createError.message)) {
      throw new Error(`Bucket creation failed (${bucket}): ${createError.message}`);
    }
  }
  ensuredBuckets.add(bucket);
}

async function uploadBuffer(bucket, path, buffer, contentType) {
  const { error } = await getStorageClient().storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed (${bucket}/${path}): ${error.message}`);
  return path;
}

async function uploadBase64(bucket, path, base64, contentType) {
  return uploadBuffer(bucket, path, Buffer.from(base64, 'base64'), contentType);
}

// All 3 buckets are private (PII/confidential content) — every read goes
// through a short-lived signed URL rather than a public bucket URL.
async function getSignedUrl(bucket, path, expiresInSeconds = 3600) {
  const { data, error } = await getStorageClient().storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error) throw new Error(`Signed URL failed (${bucket}/${path}): ${error.message}`);
  return data.signedUrl;
}

async function downloadAsBuffer(bucket, path) {
  const { data, error } = await getStorageClient().storage.from(bucket).download(path);
  if (error) throw new Error(`Storage download failed (${bucket}/${path}): ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

async function remove(bucket, path) {
  const { error } = await getStorageClient().storage.from(bucket).remove([path]);
  if (error) throw new Error(`Storage remove failed (${bucket}/${path}): ${error.message}`);
}

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a' };
function extForMimetype(mimetype) {
  if (!mimetype) return 'bin';
  return MIME_EXT[mimetype] || mimetype.split('/')[1] || 'bin';
}

// The frontend sends photo uploads as a full data: URI (data:image/jpeg;
// base64,....), not plain base64 — split those apart before uploading raw
// bytes. Returns null if the string isn't a data URI (e.g. some other value
// was echoed back unchanged rather than a genuine new upload).
function parseDataUri(uri) {
  const m = typeof uri === 'string' && uri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { mimetype: m[1], base64: m[2] };
}

// Security-critical: every uploaded attachment's stored `mimetype` is
// whatever Content-Type the uploader's browser happened to send with that
// multipart field — not sniffed or verified server-side, so it's entirely
// attacker-controlled. A download route that echoes it back verbatim with
// `Content-Disposition: inline` lets anyone upload a file claiming to be
// text/html (or image/svg+xml, which can carry <script>) and have it
// execute as a same-origin page the moment another signed-in user previews
// it — stored XSS with full access to that user's session. Only these
// types are ever safe to render inline in a browser; everything else is
// forced to download instead, regardless of what the caller asked for or
// what the uploader claimed. Every attachment/file download route in this
// app must go through this rather than setting the headers by hand.
const INLINE_SAFE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
function setFileResponseHeaders(res, { mimetype, filename, wantInline }) {
  const safeInline = !!wantInline && INLINE_SAFE_MIMETYPES.has(mimetype);
  res.setHeader('Content-Type', safeInline ? mimetype : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename || 'file')}"`);
}

module.exports = { BUCKETS, uploadBuffer, uploadBase64, getSignedUrl, downloadAsBuffer, remove, extForMimetype, parseDataUri, ensureBucket, setFileResponseHeaders, INLINE_SAFE_MIMETYPES };
