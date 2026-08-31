"use client";

import { useEffect, useRef, useState } from "react";
import { appendChunk } from "@/lib/merge";

const CHUNK_MS = 8000;
const STRIDE_MS = 7000; // 1s of overlap between consecutive chunks

function pickMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

export default function Recorder() {
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordersRef = useRef<Set<MediaRecorder>>(new Set());
  const transcriptBox = useRef<HTMLTextAreaElement>(null);

  // Chunks finish out of order; hold later ones until their turn.
  const nextSeq = useRef(0);
  const doneSeq = useRef(0);
  const buffered = useRef(new Map<number, string>());

  const commit = (seq: number, text: string) => {
    buffered.current.set(seq, text);
    let ready = "";
    while (buffered.current.has(doneSeq.current)) {
      ready = buffered.current.get(doneSeq.current)!;
      buffered.current.delete(doneSeq.current);
      doneSeq.current++;
      if (ready) setTranscript((t) => appendChunk(t, ready));
    }
  };

  const recordWindow = (stream: MediaStream, mime: string) => {
    const seq = nextSeq.current++;
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    recordersRef.current.add(rec);

    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = async () => {
      recordersRef.current.delete(rec);
      const type = rec.mimeType || "audio/webm";
      const ext = type.includes("mp4") ? "m4a" : "webm";
      const blob = new Blob(parts, { type });
      if (blob.size < 2000) return commit(seq, "");

      setPending((n) => n + 1);
      try {
        const form = new FormData();
        form.append("audio", new File([blob], `chunk-${seq}.${ext}`, { type }));
        const res = await fetch("/api/transcribe", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Transcription failed");
        commit(seq, data.text ?? "");
      } catch (e) {
        commit(seq, "");
        setError(e instanceof Error ? e.message : "Transcription failed");
      } finally {
        setPending((n) => n - 1);
      }
    };

    rec.start();
    setTimeout(() => rec.state !== "inactive" && rec.stop(), CHUNK_MS);
  };

  const start = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      streamRef.current = stream;
      nextSeq.current = doneSeq.current = 0;
      buffered.current.clear();
      setRecording(true);
      recordWindow(stream, mime);
      timerRef.current = setInterval(() => recordWindow(stream, mime), STRIDE_MS);
    } catch {
      setError("Microphone access was denied or unavailable.");
    }
  };

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    recordersRef.current.forEach((r) => r.state !== "inactive" && r.stop());
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setRecording(false);
  };

  useEffect(() => stop, []); // stop on unmount

  useEffect(() => {
    const el = transcriptBox.current;
    if (el && document.activeElement !== el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const generate = async () => {
    setError("");
    setGenerating(true);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Note generation failed");
      setNotes(data.notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Note generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([notes], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `lecturelogger-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const btn = "rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <main className="mx-auto flex h-screen max-w-6xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold">LectureLogger</h1>

        {recording ? (
          <span className="flex items-center gap-2 text-sm text-red-400">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            Recording{pending > 0 ? ` · ${pending} chunk${pending > 1 ? "s" : ""} transcribing` : ""}
          </span>
        ) : (
          pending > 0 && <span className="text-sm text-neutral-400">Finishing {pending}…</span>
        )}

        <button onClick={recording ? stop : start} className={`${btn} ${recording ? "bg-red-600 hover:bg-red-500" : "bg-emerald-600 hover:bg-emerald-500"}`}>
          {recording ? "Stop Recording" : "Start Recording"}
        </button>
        <button onClick={generate} disabled={!transcript.trim() || generating} className={`${btn} bg-indigo-600 hover:bg-indigo-500`}>
          {generating ? "Generating…" : "Generate Notes"}
        </button>
        <button onClick={download} disabled={!notes.trim()} className={`${btn} border border-neutral-700 hover:bg-neutral-800`}>
          Download Notes
        </button>
      </header>

      {error && (
        <div className="flex items-start gap-3 rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          <span className="grow">{error}</span>
          <button onClick={() => setError("")} className="text-amber-400 hover:text-amber-200">
            dismiss
          </button>
        </div>
      )}

      <div className="grid min-h-0 grow gap-4 md:grid-cols-2">
        <section className="flex min-h-0 flex-col gap-2">
          <h2 className="text-sm uppercase tracking-wide text-neutral-400">Transcript</h2>
          <textarea
            ref={transcriptBox}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Start recording and the live transcript appears here. You can edit it at any time."
            className="min-h-64 grow resize-none rounded-lg border border-neutral-800 bg-neutral-900 p-4 font-mono text-sm leading-relaxed outline-none focus:border-neutral-600"
          />
        </section>

        <section className="flex min-h-0 flex-col gap-2">
          <h2 className="text-sm uppercase tracking-wide text-neutral-400">Notes</h2>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Generated notes appear here as Markdown."
            className="min-h-64 grow resize-none rounded-lg border border-neutral-800 bg-neutral-900 p-4 font-mono text-sm leading-relaxed outline-none focus:border-neutral-600"
          />
        </section>
      </div>
    </main>
  );
}
