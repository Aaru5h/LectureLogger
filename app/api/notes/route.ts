import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120; // one section, plus room for a rate-limit wait

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
- The audio was captured in a room, so the transcript contains crosstalk: nearby chatter, side conversations, announcements and interruptions picked up alongside the lecturer. Drop anything that does not belong to the lecture's thread. A stray sentence that has nothing to do with the surrounding material is background noise, not content — leave it out rather than inventing a heading for it.

Enrichment — this is what makes the notes useful:
- After the lecture's own content for a topic, add your own explanatory material for that topic: the missing definition of a term the lecturer used without defining, the formula or units behind a quantity they only named, a concrete worked example, the intuition behind a result, or a common misconception or exam trap.
- Put every addition in its own blockquote so the student can always tell it apart from what was actually said:
  > 📌 **Added context:** ...
- Add 1–3 such blockquotes per major topic. Do not add them where the lecturer's own explanation is already complete.
- Enrichment must stay strictly on the topic the lecturer was covering, at the same level of study. Never introduce a topic the lecture did not touch.
- Never blend your additions into the lecture's own bullets, and never rewrite what was said into something the lecturer did not claim. If a lecturer said something that appears factually wrong, keep their statement and flag it in a blockquote rather than silently correcting it.
- If you are not confident an addition is correct, leave it out. Wrong notes are worse than thin notes.

Write maths as $inline$ / $$block$$ or plain Unicode (S = k_B ln Ω), never as \\( \\) or \\[ \\] — the notes are downloaded as a .md file.

Output only the Markdown notes. No preamble, no closing commentary.`;

// Long lectures are noted section by section; each call gets told where it sits.
function sectionInstructions(index: number, total: number, previousTail: string) {
  if (total === 1) return `End with a "## Key Takeaways" section: 3–6 bullets covering the whole lecture, in the order the material appeared.`;

  const lines = [
    `This is section ${index + 1} of ${total} of one continuous lecture. Note only this section's transcript.`,
    previousTail
      ? `The previous section ended with the text below. It is context only — do not re-note it. If this section carries on the same topic, title the header "## <Topic> (cont.)" rather than repeating the original header.\n\n---\n${previousTail}\n---`
      : "",
    index === total - 1
      ? `This is the final section. End with a "## Key Takeaways" section: 3–6 bullets covering the whole lecture, in the order the material appeared.`
      : `Do not write a summary, conclusion or takeaways section — the lecture continues after this section.`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

// Groq's free tier is 8k tokens/minute, and a long lecture will hit it. The 429
// tells us exactly how long to wait, so wait it out instead of failing the run.
function retryAfterMs(res: Response, body: string) {
  const header = Number(res.headers.get("retry-after"));
  if (header > 0) return header * 1000;
  const stated = body.match(/try again in ([\d.]+)s/i);
  return stated ? Math.ceil(Number(stated[1]) * 1000) + 500 : 5000;
}

export async function POST(req: Request) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return NextResponse.json({ error: "GROQ_API_KEY is not set" }, { status: 500 });

  const { transcript, index = 0, total = 1, previousTail = "" } = await req.json().catch(() => ({}));
  if (typeof transcript !== "string" || !transcript.trim()) {
    return NextResponse.json({ error: "Transcript is empty" }, { status: 400 });
  }

  const body = JSON.stringify({
    model: MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: `${SYSTEM}\n\n${sectionInstructions(index, total, previousTail)}` },
      { role: "user", content: transcript },
    ],
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
    });

    if (res.status === 429 && attempt < 3) {
      const text = await res.text();
      await new Promise((r) => setTimeout(r, Math.min(retryAfterMs(res, text), 60_000)));
      continue;
    }
    if (!res.ok) return NextResponse.json({ error: `Groq notes failed: ${await res.text()}` }, { status: res.status });

    const data = await res.json();
    // The model still slips into LaTeX delimiters that .md viewers don't render.
    const notes = (data.choices?.[0]?.message?.content ?? "")
      .replace(/\\\[|\\\]/g, "$$")
      .replace(/\\\(|\\\)/g, "$");
    return NextResponse.json({ notes });
  }

  return NextResponse.json({ error: "Groq rate limit did not clear — try again shortly." }, { status: 429 });
}
