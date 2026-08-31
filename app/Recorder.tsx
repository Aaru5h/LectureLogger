"use client";

import { useEffect, useRef, useState } from "react";
import { appendChunk, splitSections } from "@/lib/merge";

const CHUNK_MS = 8000;
const STRIDE_MS = 7000; // 1s of overlap between consecutive chunks

// Every room has a different noise floor and every PA a different loudness, so
// this is a starting point, not a constant — the slider in the header moves it.
// Raise it in a noisy hall: the teacher on the PA is far louder than the people
// around you, so a higher gate drops chunks that are only crosstalk.
const DEFAULT_GATE = 0.012;

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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");

  const [level, setLevel] = useState(0);
  const [gate, setGate] = useState(DEFAULT_GATE);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");

  // Read inside recorder callbacks without restarting the meter on every change.
  const gateRef = useRef(gate);
  gateRef.current = gate;

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
      if (blob.size < 2000 || peak < gateRef.current) return commit(seq, "");

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
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      // Labels are blank until mic permission is granted, so refresh the list here.
      navigator.mediaDevices.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === "audioinput")));
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
    navigator.mediaDevices?.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === "audioinput")));
  }, []);

  useEffect(() => {
    const el = transcriptBox.current;
    if (el && document.activeElement !== el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // A 90-minute lecture is noted one section at a time, sequentially: it keeps
  // peak token usage under Groq's per-minute limit and lets notes appear as
  // they finish instead of after a single multi-minute request.
  const generate = async () => {
    setError("");
    setGenerating(true);
    setNotes("");
    const sections = splitSections(transcript);
    setProgress({ done: 0, total: sections.length });

    try {
      for (let i = 0; i < sections.length; i++) {
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: sections[i],
            index: i,
            total: sections.length,
            previousTail: i > 0 ? sections[i - 1].split(/\s+/).slice(-120).join(" ") : "",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Note generation failed");
        setNotes((n) => (n ? `${n}\n\n${data.notes}` : data.notes));
        setProgress({ done: i + 1, total: sections.length });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Note generation failed");
    } finally {
      setGenerating(false);
      setProgress(null);
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
          {generating
            ? progress && progress.total > 1
              ? `Generating ${progress.done}/${progress.total}…`
              : "Generating…"
            : "Generate Notes"}
        </button>
        <button onClick={download} disabled={!notes.trim()} className={`${btn} border border-neutral-700 hover:bg-neutral-800`}>
          Download Notes
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-xs text-neutral-400">
        <label className="flex items-center gap-2">
          Input
          <select
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            disabled={recording}
            className="max-w-56 truncate rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200 disabled:opacity-50"
          >
            <option value="">System default</option>
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex grow items-center gap-2">
          Noise gate
          {/* Level meter with the gate drawn on it: anything left of the line is never uploaded. */}
          <span className="relative h-2.5 w-40 shrink-0 overflow-hidden rounded-full bg-neutral-800">
            <span
              className={`block h-full transition-[width] duration-100 ${level < gate ? "bg-neutral-600" : "bg-emerald-500"}`}
              style={{ width: `${Math.min(100, level * 400)}%` }}
            />
            <span className="absolute inset-y-0 w-px bg-amber-400" style={{ left: `${Math.min(100, gate * 400)}%` }} />
          </span>
          <input
            type="range"
            min={0}
            max={0.05}
            step={0.001}
            value={gate}
            onChange={(e) => setGate(Number(e.target.value))}
            className="w-40 accent-amber-400"
          />
          <span className="tabular-nums">{gate.toFixed(3)}</span>
        </label>

        <span className="text-neutral-500">
          Noisy room? Raise the gate until only the teacher&apos;s voice turns the bar green.
        </span>
      </div>

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
