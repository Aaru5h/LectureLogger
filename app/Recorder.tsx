"use client";

import { useEffect, useRef, useState } from "react";
import { appendChunk, splitSections } from "@/lib/merge";
import { downloadNotesAsPdf } from "@/lib/pdf";
import Icon from "./Icon";

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
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
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
    if (starting || pending > 0) return;
    setStarting(true);
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
      navigator.mediaDevices.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === "audioinput"))).catch(() => {});
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
      stop();
      setError("Microphone unavailable. Allow microphone access in your browser settings, then try again. You can also paste a transcript below.");
    } finally {
      setStarting(false);
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
    if (!recording) return;
    const startedAt = Date.now();
    const previous = elapsed;
    const timer = setInterval(() => setElapsed(previous + Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
    // Capture the elapsed duration only when recording resumes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === "audioinput"))).catch(() => {});
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

  const downloadPdf = async () => {
    if (!notes.trim() || exportingPdf) return;
    setExportingPdf(true);
    try {
      await downloadNotesAsPdf(notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate PDF");
    } finally {
      setExportingPdf(false);
    }
  };

  const downloadMd = () => {
    const url = URL.createObjectURL(new Blob([notes], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `lecturelogger-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const wordCount = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
  const duration = `${Math.floor(elapsed / 60).toString().padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;
  const busy = recording || starting || pending > 0;
  const status = recording ? "Recording" : starting ? "Connecting microphone" : pending > 0 ? "Finishing transcript" : "Ready to record";

  return (
    <main className="workspace">
      <header className="app-header">
        <a className="brand" href="/" aria-label="LectureLogger home">
          <span className="brand-mark"><Icon name="mic" /></span>
          <span>Lecture<span className="brand-light">Logger</span></span>
        </a>
        <span className="header-description">A little more focus. A lot less note-taking.</span>
        <span className="workspace-label"><span className="status-dot" /> Lecture workspace</span>
      </header>

      <section className="intro" aria-labelledby="workspace-title">
        <div>
          <h1 id="workspace-title">Stay in the lecture.</h1>
          <p>Capture the conversation. Turn it into notes you can come back to.</p>
        </div>
        <div className="workflow" aria-label="Workflow: Record, transcribe, generate notes">
          <span className={recording ? "current-step" : ""}>Record</span><Icon name="chevron" />
          <span className={transcript && !notes ? "current-step" : ""}>Transcribe</span><Icon name="chevron" />
          <span className={notes ? "current-step" : ""}>Make it yours</span>
        </div>
      </section>

      <section className={`recording-panel ${recording ? "is-recording" : ""}`} aria-label="Recording controls">
        <div className="recording-main">
          <div className="recording-info">
            <div className="recording-status" role="status"><span className={`status-dot ${recording ? "live-dot" : ""}`} />{status}</div>
            <div className="session-time"><span>{duration}</span><span className="session-caption">{recording ? "Listening to your lecture" : elapsed > 0 ? "Recorded this session" : "Your next idea starts here"}</span></div>
          </div>
          <div className="recording-actions">
            <div className="input-visual" aria-hidden="true">
              {Array.from({ length: 25 }, (_, i) => <span key={i} style={{ height: recording ? `${Math.max(4, Math.min(34, level * 500 * (0.45 + Math.abs(Math.sin(i * 1.7))))) }px` : "4px" }} />)}
            </div>
            <button onClick={recording ? stop : start} disabled={!recording && (starting || pending > 0)} className={`button record-button ${recording ? "stop-button" : ""}`}>
              <Icon name={recording ? "stop" : "mic"} />
              {recording ? "Stop recording" : starting ? "Connecting…" : pending > 0 ? "Finishing…" : elapsed > 0 ? "Resume recording" : "Start recording"}
            </button>
          </div>
        </div>
        <details className="audio-settings">
          <summary><Icon name="settings" /><span>Audio settings</span><span className="settings-summary">Microphone & noise gate</span><Icon name="chevron" className="settings-chevron" /></summary>
          <div className="settings-content">
            <label className="input-setting" htmlFor="microphone">Microphone
              <select id="microphone" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={recording || starting}>
                <option value="">System default</option>
                {devices.filter((d) => d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
              </select>
            </label>
            <div className="gate-setting">
              <label htmlFor="noise-gate">Noise gate <output htmlFor="noise-gate">{gate.toFixed(3)}</output></label>
              <input id="noise-gate" type="range" min={0} max={0.05} step={0.001} value={gate} onChange={(e) => setGate(Number(e.target.value))} aria-describedby="gate-help" />
            </div>
            <div className="meter-setting"><span>Input level</span>
              <div className="level-meter" role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, level * 400))}>
                <span className={level < gate ? "below-gate" : "above-gate"} style={{ width: `${Math.min(100, level * 400)}%` }} />
                <i style={{ left: `${Math.min(100, gate * 400)}%` }} />
              </div>
            </div>
            <p id="gate-help">Noisy room? Raise the gate until only the teacher’s voice turns the input bar green.</p>
          </div>
        </details>
      </section>

      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><Icon name="close" /></button></div>}

      <div className="editor-grid">
        <section className="editor-panel" aria-labelledby="transcript-heading">
          <div className="editor-header"><div className="editor-title"><Icon name="mic" /><h2 id="transcript-heading">Live transcript</h2></div><span className={`editor-badge ${recording ? "live-badge" : ""}`}>{recording ? "Live" : "Editable"}</span></div>
          <div className="editor-body">
            {!transcript && <div className="empty-state" aria-hidden="true"><div className="empty-symbol transcript-symbol"><Icon name="mic" /></div><h3>Let the lecture unfold.</h3><p>Start recording and your words will appear here.<br />Already have a transcript? Paste it below.</p><span className="empty-hint">Click anywhere to start typing</span></div>}
            <textarea id="transcript" aria-label="Live transcript" ref={transcriptBox} value={transcript} onChange={(e) => setTranscript(e.target.value)} spellCheck className="editor-textarea" />
          </div>
          <footer className="editor-footer"><span>{wordCount(transcript).toLocaleString()} words</span><span role="status">{pending > 0 ? `Transcribing ${pending} audio ${pending === 1 ? "segment" : "segments"}…` : "Edit your transcript at any time"}</span></footer>
        </section>

        <section className="editor-panel notes-panel" aria-labelledby="notes-heading" aria-busy={generating}>
          <div className="editor-header"><div className="editor-title"><Icon name="notes" /><h2 id="notes-heading">Lecture notes</h2></div>
            <button onClick={generate} disabled={!transcript.trim() || generating || busy} className="button generate-button" title={busy ? "Finish recording and transcription before generating notes" : undefined}>
              {generating ? <span className="spinner" /> : <Icon name="arrow" />}<span>{generating ? "Generating…" : "Generate notes"}</span>
            </button>
          </div>
          <div className="editor-body">
            {!notes && <div className="empty-state" aria-hidden="true"><div className="empty-symbol notes-symbol"><Icon name="notes" /></div><h3>{generating ? "Making sense of your lecture…" : "From spoken to structured."}</h3><p>{generating ? "Your notes will appear here as each section is ready." : "Turn your transcript into organized notes, ready to review, edit, and take with you."}</p>{!generating && <span className="empty-hint">Add a transcript, then generate your notes</span>}</div>}
            <textarea aria-label="Lecture notes in Markdown" value={notes} onChange={(e) => setNotes(e.target.value)} readOnly={generating} className="editor-textarea notes-textarea" spellCheck />
          </div>
          {generating && <div className="generation-progress" role="status"><span>{progress ? `Writing section ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : "Preparing notes…"}</span><progress value={progress?.done ?? 0} max={progress?.total || 1} /></div>}
          <footer className="editor-footer notes-footer"><span>Markdown · {wordCount(notes).toLocaleString()} words</span><div className="export-actions"><button onClick={downloadMd} disabled={!notes.trim() || generating} className="export-button" aria-label="Download notes as Markdown">.md</button><button onClick={downloadPdf} disabled={!notes.trim() || exportingPdf || generating} className="export-button"><Icon name="download" />{exportingPdf ? "Exporting…" : "Export PDF"}</button></div></footer>
        </section>
      </div>
      <footer className="workspace-footer"><span>Space to listen. Room to think.</span><span>Notes stay in this session. Export before you leave.</span></footer>
    </main>
  );
}
