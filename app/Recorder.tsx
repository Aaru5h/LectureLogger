"use client";

import { useEffect, useRef, useState } from "react";
import { appendChunk } from "@/lib/merge";

const CHUNK_MS = 8000;
const STRIDE_MS = 7000; // 1s of overlap between consecutive chunks

// ponytail: fixed RMS gate, tune with the level meter in the header. A real room
// has a real noise floor — swap for an adaptive floor (rolling percentile) if
// lecture halls with loud HVAC start eating quiet speech.
const SILENCE_RMS = 0.012;

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

  const [level, setLevel] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordersRef = useRef<Set<MediaRecorder>>(new Set());
  const transcriptBox = useRef<HTMLTextAreaElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const peakListeners = useRef<Set<(rms: number) => void>>(new Set());
  // Whisper transcribes each chunk cold; the tail of the transcript primes it
  // with the lecture's vocabulary so terms stay spelled consistently.
  const contextRef = useRef("");

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
      if (ready)
        setTranscript((t) => {
          const next = appendChunk(t, ready);
          contextRef.current = next.slice(-400);
          return next;
        });
    }
  };

  const recordWindow = (stream: MediaStream, mime: string) => {
    const seq = nextSeq.current++;
    const rec = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      audioBitsPerSecond: 32000, // opus speech quality; ~4x smaller uploads than default
    });
    const parts: Blob[] = [];
    recordersRef.current.add(rec);

    let peak = 0;
    const onLevel = (rms: number) => (peak = Math.max(peak, rms));
    peakListeners.current.add(onLevel);

    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = async () => {
      recordersRef.current.delete(rec);
      peakListeners.current.delete(onLevel);
      const type = rec.mimeType || "audio/webm";
      const ext = type.includes("mp4") ? "m4a" : "webm";
      const blob = new Blob(parts, { type });
      // Nothing was said in this window — skip the round trip and the
      // hallucinated "Thank you." that Whisper returns for silence.
      if (blob.size < 2000 || peak < SILENCE_RMS) return commit(seq, "");

      setPending((n) => n + 1);
      try {
        const form = new FormData();
        form.append("audio", new File([blob], `chunk-${seq}.${ext}`, { type }));
        if (contextRef.current) form.append("context", contextRef.current);
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

  const startMeter = (stream: MediaStream) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    audioCtxRef.current = ctx;

    const buf = new Float32Array(analyser.fftSize);
    meterRef.current = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      peakListeners.current.forEach((fn) => fn(rms));
      setLevel(rms);
    }, 100);
  };

  const start = async () => {
    setError("");
    try {
      // Browser-native WebRTC audio processing: kills steady background noise,
      // room echo, and level swings before a single byte is uploaded.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const mime = pickMime();
      streamRef.current = stream;
      nextSeq.current = doneSeq.current = 0;
      buffered.current.clear();
      contextRef.current = transcript.slice(-400);
      startMeter(stream);
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
    if (meterRef.current) clearInterval(meterRef.current);
    meterRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setLevel(0);
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
            <span className="ml-1 h-2 w-24 overflow-hidden rounded-full bg-neutral-800" title="Input level — bars below the marker are treated as silence">
              <span
                className={`block h-full transition-[width] duration-100 ${level < SILENCE_RMS ? "bg-neutral-600" : "bg-emerald-500"}`}
                style={{ width: `${Math.min(100, level * 400)}%` }}
              />
            </span>
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
