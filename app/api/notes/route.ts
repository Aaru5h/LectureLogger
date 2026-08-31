import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// llama-3.1/3.3-70b-versatile are gone from this account's Groq catalog; gpt-oss-120b
// is the current large general model there. Override with GROQ_NOTES_MODEL.
const MODEL = process.env.GROQ_NOTES_MODEL ?? "openai/gpt-oss-120b";

const SYSTEM = `You turn a raw lecture transcript into clean lecture notes in Markdown.

Rules:
- Follow the lecture's original chronological flow. Never reorder by importance or merge topics that were discussed apart.
- Start a "## " header at each topic shift, "### " for subtopics within a topic.
- Use bullet points for sub-ideas, examples, and supporting detail.
- Bold key terms and their definitions, e.g. **entropy** — a measure of disorder.
- Fix transcription noise (filler words, false starts, obvious mis-hearings) but never invent content that was not said.
- Output only the Markdown notes. No preamble, no closing commentary.`;

export async function POST(req: Request) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return NextResponse.json({ error: "GROQ_API_KEY is not set" }, { status: 500 });

  const { transcript } = await req.json().catch(() => ({ transcript: "" }));
  if (typeof transcript !== "string" || !transcript.trim()) {
    return NextResponse.json({ error: "Transcript is empty" }, { status: 400 });
  }

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: transcript },
      ],
    }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: `Groq notes failed: ${await res.text()}` }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json({ notes: data.choices?.[0]?.message?.content ?? "" });
}
