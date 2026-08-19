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

const BUCKETS = {
  teamPhotos: 'team-photos',
  articleFiles: 'article-files',
  callRecordings: 'call-recordings',
  announcementFiles: 'announcement-files',
  projectFiles: 'project-files',
  ideaFiles: 'idea-files',
  leadRecordings: 'lead-recordings'
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

module.exports = { BUCKETS, uploadBuffer, uploadBase64, getSignedUrl, downloadAsBuffer, remove, extForMimetype, parseDataUri, ensureBucket };
