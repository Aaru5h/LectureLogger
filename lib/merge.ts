// Chunks overlap by ~1s of audio, so consecutive transcriptions repeat a few
// words. Drop the longest word-run that the tail of `prev` and the head of
// `next` agree on.
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

export function mergeOverlap(prev: string, next: string, maxWords = 12): string {
  const a = prev.trim().split(/\s+/).filter(Boolean).map(norm);
  const words = next.trim().split(/\s+/).filter(Boolean);
  const b = words.map(norm);

  for (let k = Math.min(maxWords, a.length, b.length); k > 0; k--) {
    if (a.slice(-k).every((w, i) => w === b[i])) return words.slice(k).join(" ");
  }
  return words.join(" ");
}

export function appendChunk(transcript: string, chunk: string): string {
  const tail = mergeOverlap(transcript, chunk);
  if (!tail) return transcript;
  return transcript ? `${transcript.replace(/\s+$/, "")} ${tail}` : tail;
}
