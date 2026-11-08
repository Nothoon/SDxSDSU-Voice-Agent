// Voice test page. Wires the voice controller to Nathan's backend the way the UI will:
// the page asks the backend for a cue, shows its text, then hands it to playCue().
import type { CueResponse, SessionEvent, SessionState } from "../../shared/types.js";
import { createVoiceController, type ThreadVoiceController } from "../browser/controller.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let voice: ThreadVoiceController;
let sessionId: string | null = null;
let state: SessionState | null = null;
let events: EventSource | null = null;
let liveSttAvailable = false;

function log(line: string) {
  const el = $("log");
  el.textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + el.textContent;
}

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

function makeVoice() {
  voice?.end();
  const simulated = $<HTMLInputElement>("simulated").checked;
  voice = createVoiceController({ simulated });
  $("simRow").style.display = simulated ? "flex" : "none";
  voice.on("transcript", (seg) => {
    if (seg.isFinal) {
      $("partial").textContent = "";
      const li = document.createElement("li");
      li.textContent = seg.text;
      $("finals").prepend(li);
    } else $("partial").textContent = seg.text;
  });
  voice.on("connection", (status, detail) => log(`STT ${status}${detail ? ` — ${detail}` : ""}`));
  voice.on("speaking", (active) => {
    $("speaking").textContent = active ? "speaking" : "quiet";
    $("speaking").className = active ? "speaking" : "";
  });
  voice.on("level", (rms) => ($("meter").style.width = `${Math.min(100, rms * 600)}%`));
  voice.on("error", (message) => log(`ERROR ${message}`));
  voice.on("playback", (e) => {
    const pill = $("playback");
    if (e.state === "waiting") {
      pill.textContent = "waiting for a pause";
      pill.className = "pill waiting";
    } else if (e.state === "playing") {
      pill.textContent = "playing";
      pill.className = "pill connected";
      log(`play "${e.cue.text}" — request→audible start ${e.startLatencyMs} ms`);
    } else {
      pill.textContent = e.reason;
      pill.className = "pill";
      const extra = e.stopLatencyMs !== undefined ? ` — speech onset→stop ${e.stopLatencyMs} ms` : "";
      log(`stop "${e.cue.text}" (${e.reason})${extra}${e.error ? ` — ${e.error}` : ""}`);
    }
  });
}

function render() {
  if (!state) return;
  const lc = state.lifecycle;
  $("sessionInfo").textContent = `session ${state.id.slice(0, 8)} · ${lc}`;
  $<HTMLButtonElement>("prepare").disabled = !state.outlineApproved;
  $<HTMLButtonElement>("start").disabled = lc !== "ready";
  $<HTMLButtonElement>("pause").disabled = lc !== "listening";
  $<HTMLButtonElement>("resume").disabled = lc !== "paused";
  $<HTMLButtonElement>("end").disabled = lc === "ended" || lc === "draft";
  $<HTMLButtonElement>("cue").disabled = lc !== "listening";
  $<HTMLButtonElement>("more").disabled = lc !== "listening";
  $<HTMLInputElement>("simulated").disabled = lc === "listening" || lc === "paused" || !liveSttAvailable;
  for (const p of ["stt", "tts"] as const) {
    $(p).textContent = state.providers[p];
    $(p).className = `pill ${state.providers[p]}`;
  }
  $("tracking").textContent = state.trackingStatus;
  $("tracking").className = `pill ${state.trackingStatus}`;
  $("coverage").innerHTML = state.outline
    .map((card) => {
      const c = state!.coverage[card.id];
      return `<tr><td>${esc(card.title)}${card.mustMention ? " *" : ""}</td><td><span class="pill ${c.status}">${c.status}</span></td><td class="note">${esc(card.cue)}</td></tr>`;
    })
    .join("");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

function subscribe(id: string) {
  events?.close();
  events = new EventSource(`/api/sessions/${id}/events`);
  events.onmessage = (msg) => {
    const event = JSON.parse(msg.data) as SessionEvent;
    if ("state" in event) {
      state = event.state;
      render();
    }
    if (event.type === "error") log(`backend: ${event.message}`);
  };
}

async function requestCue(level: "short" | "expanded") {
  if (!sessionId || state?.lifecycle !== "listening") return;
  try {
    const cue = await api<CueResponse>(`/api/sessions/${sessionId}/cue`, {
      method: "POST",
      body: JSON.stringify({ level }),
    });
    // Text first, so the cue is usable even if audio is slow or fails.
    $("cueText").textContent = cue.text;
    void voice.playCue(cue);
  } catch (err) {
    log(`cue failed: ${(err as Error).message}`);
  }
}

async function refreshOutputs() {
  const select = $<HTMLSelectElement>("output");
  const devices = await voice.listOutputDevices();
  select.innerHTML = `<option value="">System default output</option>` +
    devices.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Output " + d.deviceId.slice(0, 6))}</option>`).join("");
}

$("create").onclick = async () => {
  try {
    const { outline } = await api("/api/fixtures/outline");
    const created = await api<SessionState>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ outline, targetDurationSec: 180 }),
    });
    sessionId = created.id;
    state = await api<SessionState>(`/api/sessions/${sessionId}/approve`, { method: "POST" });
    subscribe(sessionId);
    render();
    $("finals").innerHTML = "";
    $("cueText").textContent = "";
    log(`session ${sessionId.slice(0, 8)} created and approved`);
    $("prepare").click();
  } catch (err) {
    log(`create failed: ${(err as Error).message}`);
  }
};

$("prepare").onclick = async () => {
  if (!sessionId) return;
  const t0 = performance.now();
  try {
    const r = await voice.prepare(sessionId);
    log(`prepared ${r.prepared} cue clips in ${Math.round(performance.now() - t0)} ms${r.simulated ? " (SIMULATED tones)" : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}`);
  } catch (err) {
    log(`prepare failed: ${(err as Error).message}`);
  }
};

$("start").onclick = async () => {
  if (!sessionId) return;
  try {
    state = await api(`/api/sessions/${sessionId}/start`, { method: "POST" });
    render();
    await voice.start(sessionId);
    log("listening");
  } catch (err) {
    log(`start failed: ${(err as Error).message}`);
  }
};

$("pause").onclick = async () => {
  voice.pause(); // Stop transmission and playback first.
  state = await api(`/api/sessions/${sessionId}/pause`, { method: "POST" });
  render();
};

$("resume").onclick = async () => {
  state = await api(`/api/sessions/${sessionId}/resume`, { method: "POST" });
  render();
  await voice.resume().catch((err) => log(`resume failed: ${err.message}`));
};

$("end").onclick = async () => {
  voice.end();
  state = await api(`/api/sessions/${sessionId}/end`, { method: "POST" });
  render();
  const recap = await api(`/api/sessions/${sessionId}/recap`);
  log(`recap: covered ${recap.covered.join(", ") || "none"}; missed must-mention ${recap.missedMustMention.join(", ") || "none"}`);
  makeVoice(); // Fresh controller for the next run.
};

$("cue").onclick = () => requestCue("short");
$("more").onclick = () => requestCue("expanded");
$("stopAudio").onclick = () => voice.stopPlayback();
$("preview").onclick = () => void voice.preview();
$("refreshOutputs").onclick = () => void refreshOutputs().catch((err) => log(err.message));
$<HTMLSelectElement>("output").onchange = async (e) => {
  const ok = await voice.setOutputDevice((e.target as HTMLSelectElement).value);
  log(ok ? "output device set" : "this browser cannot pick an output device; use system settings");
};
$("simulated").onchange = () => makeVoice();

const sayTyped = () => {
  const input = $<HTMLInputElement>("simText");
  void voice.simulateSpeech(input.value);
  input.value = "";
};
$("simSend").onclick = sayTyped;
$("simText").onkeydown = (e) => {
  if (e.key === "Enter") sayTyped();
};

document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT" || e.repeat) return;
  if (e.code === "Space") {
    e.preventDefault();
    void requestCue("short");
  } else if (e.key === "m" || e.key === "M") void requestCue("expanded");
});

(async () => {
  try {
    const health = await api("/api/health");
    liveSttAvailable = !!health.voice?.stt;
    if (!liveSttAvailable) {
      $<HTMLInputElement>("simulated").checked = true;
      $("simBanner").style.display = "block";
      $("simBanner").textContent =
        "SIMULATED voice: the server has no ELEVENLABS_API_KEY. Transcript input is typed and cue audio is a placeholder tone, not speech.";
    } else if (health.voice?.simulated === false) {
      log("ElevenLabs voice provider configured");
    }
    if (health.coverage === "mock") log("coverage tracking is the SIMULATED mock (word overlap)");
  } catch (err) {
    log(`backend unreachable: ${(err as Error).message}`);
  }
  makeVoice();
})();
