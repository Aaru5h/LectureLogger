import { NextResponse } from "next/server";
import { isHallucination } from "@/lib/merge";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return NextResponse.json({ error: "GROQ_API_KEY is not set" }, { status: 500 });

  const form = await req.formData();
  const audio = form.get("audio");
  if (!(audio instanceof Blob)) return NextResponse.json({ error: "No audio provided" }, { status: 400 });

  const upstream = new FormData();
  // Groq infers the container from the extension, so keep the client's filename.
  upstream.append("file", audio, (audio as File).name || "chunk.webm");
  upstream.append("model", "whisper-large-v3");
  upstream.append("response_format", "json");
  upstream.append("temperature", "0"); // less hallucination on near-silent chunks

  // Prime Whisper with the transcript so far: it carries the lecture's jargon
  // and spelling into a chunk that would otherwise be transcribed cold.
  const context = form.get("context");
  if (typeof context === "string" && context.trim()) upstream.append("prompt", context.slice(-400));

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: upstream,
  });

  if (!res.ok) {
    return NextResponse.json({ error: `Groq transcription failed: ${await res.text()}` }, { status: res.status });
  }

  const data = await res.json();
  const text = (data.text ?? "").trim();
  return NextResponse.json({ text: isHallucination(text) ? "" : text });
}
