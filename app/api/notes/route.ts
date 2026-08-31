import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// llama-3.1/3.3-70b-versatile are gone from this account's Groq catalog; gpt-oss-120b
// is the current large general model there. Override with GROQ_NOTES_MODEL.
const MODEL = process.env.GROQ_NOTES_MODEL ?? "openai/gpt-oss-120b";

const SYSTEM = `You turn a raw lecture transcript into clean, study-ready lecture notes in Markdown.

Structure:
- Follow the lecture's original chronological flow. Never reorder by importance or merge topics that were discussed apart.
- Start a "## " header at each topic shift, "### " for subtopics within a topic.
- Use bullet points for sub-ideas, examples, and supporting detail.
- Bold key terms and their definitions, e.g. **entropy** — a measure of disorder.
- Fix transcription noise (filler words, false starts, obvious mis-hearings from speech-to-text).

Enrichment — this is what makes the notes useful:
- After the lecture's own content for a topic, add your own explanatory material for that topic: the missing definition of a term the lecturer used without defining, the formula or units behind a quantity they only named, a concrete worked example, the intuition behind a result, or a common misconception or exam trap.
- Put every addition in its own blockquote so the student can always tell it apart from what was actually said:
  > 📌 **Added context:** ...
- Add 1–3 such blockquotes per major topic. Do not add them where the lecturer's own explanation is already complete.
- Enrichment must stay strictly on the topic the lecturer was covering, at the same level of study. Never introduce a topic the lecture did not touch.
- Never blend your additions into the lecture's own bullets, and never rewrite what was said into something the lecturer did not claim. If a lecturer said something that appears factually wrong, keep their statement and flag it in a blockquote rather than silently correcting it.
- If you are not confident an addition is correct, leave it out. Wrong notes are worse than thin notes.

Write maths as $inline$ / $$block$$ or plain Unicode (S = k_B ln Ω), never as \\( \\) or \\[ \\] — the notes are downloaded as a .md file.

End with a "## Key Takeaways" section: 3–6 bullets covering the whole lecture, in the order the material appeared.

Output only the Markdown notes. No preamble, no closing commentary.`;

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
