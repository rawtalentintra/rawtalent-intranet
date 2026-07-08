const GROQ_API = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';

function isConfigured() {
  return !!process.env.GROQ_API_KEY;
}

// Groq accepts mp3 directly (no ffmpeg/WAV conversion needed) and transcribes
// at ~200x realtime, so this typically completes in a couple of seconds even
// for a multi-minute call. Free tier: 2,000 requests/day, ~2h audio/hour.
async function transcribeAudio(base64Data, mimetype = 'audio/mpeg') {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Groq is not configured. Set GROQ_API_KEY.');

  const buffer = Buffer.from(base64Data, 'base64');
  const ext = mimetype.includes('wav') ? 'wav' : mimetype.includes('mp4') || mimetype.includes('m4a') ? 'm4a' : 'mp3';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), `recording.${ext}`);
  form.append('model', MODEL);
  form.append('language', 'en');
  form.append('response_format', 'json');

  const res = await fetch(GROQ_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq transcription failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.text) throw new Error('Groq response did not include transcript text');
  return data.text;
}

module.exports = { isConfigured, transcribeAudio };
