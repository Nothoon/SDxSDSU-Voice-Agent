import type {
  CueResponse,
  IdeaCard,
  SessionEvent,
  SessionRecap,
  SessionState,
} from "../shared/types.js";
import {
  createVoiceController,
  type ThreadVoiceController,
} from "../voice/browser/controller.js";
import { focusAfterCoverage, nextIdea, validateCard, formatTime, canShortcut } from "./model.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let stage: "prepare" | "setup" | "speak" | "recap" = "prepare";
let cards: IdeaCard[] = [],
  state: SessionState | null = null,
  health: {
    coverage: string;
    voice: { simulated: boolean; stt: boolean };
    outline?: { simulated: boolean };
  } | null = null;
let voice: ThreadVoiceController | null = null,
  events: EventSource | null = null,
  recap: SessionRecap | null = null;
let duration = 180,
  busy = false,
  cueBusy = false,
  error = "",
  message = "",
  audioEnabled = true,
  previewed = false,
  output = "",
  outputs: MediaDeviceInfo[] = [];
let focusId: string | null = null,
  delivered: CueResponse | null = null,
  hint = "",
  playback = "",
  intent = 0,
  clockAt = Date.now(),
  streamOk = true,
  transportStopped = false;
// A continuous loop of thread: decorative only, with no interaction hooks.
const threadMark = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false"><path d="M8 31c0-8 8-19 16-19 7 0 10 5 10 10 0 9-7 16-13 16-5 0-8-3-8-7 0-8 9-17 17-17 7 0 11 4 11 10 0 8-8 13-17 13H7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const threadArtwork = `<div class="intro-art" aria-hidden="true"><svg viewBox="0 0 320 150" fill="none" focusable="false"><path class="art-guide" d="M18 108h284M18 44h284"/><path class="art-thread" d="M18 109c42 0 58-85 109-85 33 0 53 23 53 49s-20 49-43 49c-21 0-36-14-36-34 0-34 41-61 75-61 35 0 53 19 53 42 0 27-24 40-51 40h124"/><circle cx="18" cy="109" r="5" class="art-end"/><circle cx="302" cy="109" r="5" class="art-end"/></svg><span>A LITTLE STRUCTURE. A NATURAL FLOW.</span></div>`;
const icon = (name: string) =>
  ({ thread: "⌁", prepare: "01", setup: "02", speak: "03" })[name] ?? name;
const button = (action: string, label: string, kind = "", disabled = false) =>
  `<button type="button" data-action="${action}" class="${kind}" ${disabled ? "disabled" : ""}>${label}</button>`;
const listening = () => state?.lifecycle === "listening" && !transportStopped;
const ordered = () => [...cards].sort((a, b) => a.order - b.order);
async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Error(data.error || `Connection failed (${response.status}).`);
  return data;
}
const sessionApi = <T = SessionState>(action: string, body: unknown = {}) =>
  api<T>(`/api/sessions/${state!.id}/${action}`, body);
function accept(next: SessionState) {
  if (state && next.id !== state.id) return;
  if (state && next.stateRevision < state.stateRevision) return;
  const nextFocus = state ? focusAfterCoverage(state, next, focusId) : focusId;
  const invalidateHint = state &&
    (next.transcriptRevision !== state.transcriptRevision || nextFocus !== focusId);
  state = next;
  focusId = nextFocus;
  if (invalidateHint) {
    cancel();
    delivered = null;
    hint = "";
    playback = "";
    message = "";
  }
  clockAt = Date.now();
}
function cancel() {
  intent++;
  cueBusy = false;
  voice?.stopPlayback();
}
function announce(text: string) {
  message = text;
  render();
}
function fail(e: unknown) {
  error = e instanceof Error ? e.message : String(e);
  render();
}

function shell() {
  const step =
    stage === "recap" ? 3 : ["prepare", "setup", "speak"].indexOf(stage);
  return `<aside class="sidebar"><a class="brand" href="/" aria-label="Thread home"><span class="brand-icon">${threadMark}</span> thread<span class="brand-period">.</span></a><p class="side-caption">YOUR SPEAKING COMPANION</p><nav aria-label="Session steps">${[
    ["prepare", "Your ideas", "Make a little room for thought"],
    ["setup", "Your setup", "A quick check before you begin"],
    ["speak", "Your moment", "Speak in your own words"],
  ]
    .map(
      ([key, title, desc], i) =>
        `<div class="nav-step ${i === step ? "active" : ""} ${i < step ? "done" : ""}" ${i === step ? 'aria-current="step"' : ""}><span>${i < step ? "✓" : icon(key)}</span><div><strong>${title}</strong><small>${desc}</small></div></div>`,
    )
    .join(
      "",
    )}</nav><div class="side-bottom"><div class="thread-line">${threadMark}</div><p>You bring the ideas.<br>We’ll keep the thread.</p><span>Stay present. Sound like you.</span></div></aside><div class="workspace"><header><span>THE SPEAKING STUDIO</span><span class="connection"><i class="${health ? "" : "offline"}"></i>${health ? "Connected" : "Connecting"}</span></header><main id="main" tabindex="-1">${error ? `<div class="alert" role="alert"><span>${esc(error)}</span>${button("dismiss", "Dismiss", "text")}</div>` : ""}${message ? `<p class="notice" role="status">${esc(message)}</p>` : ""}${stage === "prepare" ? prepareView() : stage === "setup" ? setupView() : stage === "speak" ? speakingView() : recapView()}</main><footer><span>thread. &nbsp; Keep your flow.</span><span>Your voice leads the way.</span></footer></div>`;
}
function intro(kicker: string, title: string, desc: string) {
  return `<div class="intro"><div class="intro-copy"><span class="eyebrow">${kicker}</span><h1>${title}</h1><p>${desc}</p></div>${threadArtwork}</div>`;
}
function prepareView() {
  return `${intro("01 / PREPARE", "Find your rhythm.<br>Keep your thread.", "Build a few anchors for your talk. You can always find your own way between them.")}<div class="prepare-grid"><section><div class="section-heading"><h2>Your talking points <span class="number-badge">${cards.length}</span></h2><div class="heading-actions">${button("import", "⇪ Import slides or docs", "secondary", busy || !health)}${button("add", "＋ Add idea", "secondary", busy || cards.length >= 12)}</div></div><div class="idea-list">${
    ordered()
      .map(
        (c, i) =>
          `<article class="idea-card"><span class="card-number">${String(i + 1).padStart(2, "0")}</span><div class="card-content"><div class="card-heading"><h3>${esc(c.title)}</h3>${c.mustMention ? '<span class="must">Must mention</span>' : ""}</div><p>${esc(c.meaning)}</p><div class="anchor"><span>YOUR HINT</span> ${esc(c.cue)}</div></div><div class="card-tools">${button("edit:" + c.id, "Edit", "text", busy)}<div><button aria-label="Move ${esc(c.title)} up" data-action="up:${c.id}" class="icon-button" ${i === 0 ? "disabled" : ""}>↑</button><button aria-label="Move ${esc(c.title)} down" data-action="down:${c.id}" class="icon-button" ${i === cards.length - 1 ? "disabled" : ""}>↓</button></div></div></article>`,
      )
      .join("") ||
    `<div class="empty"><h3>Start with one thought.</h3><p>Add an idea, import your slides or notes, or try a sample outline to see how Thread works.</p><div class="empty-actions">${button("add", "Add your first idea", "primary", busy)}${button("import", "Import slides or docs", "secondary", busy || !health)}</div></div>`
  }</div><div class="list-footer">${button("sample", "Try a sample outline", "text", busy)}<span>Up to 12 ideas. Three to seven is a good start.</span></div></section><aside class="prep-summary"><span class="eyebrow">A LITTLE GUIDANCE</span><h2>Anchors,<br>not a script.</h2><p>A short hint should bring your idea back. A few familiar words are all you need.</p><div class="example"><span>“Your first customer”</span><small>A hint you’ll recognize at a glance.</small></div><label for="duration">How long is your talk?</label><select id="duration">${[
    [0, "No time target"],
    [120, "2 minutes"],
    [180, "3 minutes"],
    [300, "5 minutes"],
    [600, "10 minutes"],
  ]
    .map(
      ([v, t]) =>
        `<option value="${v}" ${duration === v ? "selected" : ""}>${t}</option>`,
    )
    .join(
      "",
    )}</select><hr><p class="fine">Review your wording before continuing. Thread only uses the hints you approve.</p>${button("approve", busy ? "Saving your ideas…" : "Review setup <span>→</span>", "primary full", busy || !cards.length || !health)}</aside></div>`;
}
function setupView() {
  const simulated = !!health?.voice.simulated;
  return `${intro("02 / SETUP", "Make yourself<br>comfortable.", "Your ideas are ready. Choose how you’d like Thread to help.")}<div class="setup-grid"><section class="setup-card"><div class="section-heading"><h2>Your listening setup</h2><span class="small-label">${simulated ? "Practice mode" : "ElevenLabs voice"}</span></div><div class="setup-row"><div class="setup-symbol">◉</div><div><h3>${simulated ? "Practice without a microphone" : "Live microphone"}</h3><p>${simulated ? "Live transcription is not configured. Type practice speech during your session." : "Your browser will ask for microphone access when you begin speaking."}</p></div></div><div class="setting-line"><label for="audio"><strong>Hear my hints</strong><span>${simulated ? "Practice audio is a placeholder tone, not a spoken hint." : "Short spoken reminders through your earbud."}</span></label><input id="audio" type="checkbox" role="switch" ${audioEnabled ? "checked" : ""}></div>${audioEnabled ? `<div class="audio-setup"><label for="output">Audio output</label><div class="output-row"><select id="output"><option value="">System default</option>${outputs.map((d) => `<option value="${esc(d.deviceId)}" ${output === d.deviceId ? "selected" : ""}>${esc(d.label || "Audio output")}</option>`).join("")}</select>${button("outputs", "Refresh", "secondary", busy)}</div><p class="fine">Connect an earbud. If your browser cannot select it, use your system sound settings.</p>${button("preview", busy ? "Checking audio…" : previewed ? "✓ Preview again" : "▷ Preview " + (simulated ? "practice tone" : "spoken hint"), "secondary", busy)}<label class="check-label"><input id="heard" type="checkbox" ${previewed ? "checked" : ""}> I heard the preview in my intended output.</label></div>` : '<p class="text-fallback">Text hints stay visible throughout your session.</p>'}<div class="provider-note">${health?.coverage === "mock" ? "Practice tracking uses word matching; it may miss paraphrases." : "Idea tracking follows meaning from your finalized speech."}</div></section><aside class="setup-summary"><span class="eyebrow">YOUR SESSION</span><h2>${cards.length} ideas.<br>Your own words.</h2><ul>${ordered()
    .map((c) => `<li><span>○</span>${esc(c.title)}</li>`)
    .join(
      "",
    )}</ul><div class="summary-time">◷ &nbsp;${duration ? formatTime(duration * 1000) + " target" : "No time target"}</div><p class="fine">You control when a hint plays. Pause stops your microphone and cue audio.</p>${button("start", busy ? "Getting ready…" : "Begin speaking <span>→</span>", "primary full", busy || (audioEnabled && !previewed))}${button("back", "← Back to ideas", "text full", busy)}</aside></div>`;
}
function speakingView() {
  const current = cards.find((c) => c.id === focusId);
  const next = state ? nextIdea(state, focusId) : null;
  const covered = cards.filter(
    (c) => state?.coverage[c.id]?.status === "covered",
  ).length;
  const paused = state?.lifecycle === "paused" || transportStopped;
  return `<div class="speaking-heading"><div><span class="eyebrow">03 / YOUR MOMENT</span><h1>Take the floor.</h1></div><div class="session-badge"><i class="${paused ? "paused" : ""}"></i>${paused ? "Paused" : health?.voice.simulated ? "Practice session" : "Listening"}<span id="timer">${formatTime(state?.elapsedMs || 0)}</span></div></div>${!streamOk ? '<p class="alert" role="status">Reconnecting to your session. Hints use the last confirmed state.</p>' : ""}${state?.trackingStatus !== "ok" ? '<p class="notice">Tracking needs a moment. Your ideas are safe; select one below for a hint.</p>' : ""}<div class="speaking-grid"><section class="speaking-main"><div class="focus-card"><div class="focus-top"><span>${paused ? "TAKE A BREATH" : hint ? "YOUR HINT" : "CURRENT IDEA"}</span><span>${current ? String(ordered().findIndex((c) => c.id === current.id) + 1).padStart(2, "0") : "—"} / ${String(cards.length).padStart(2, "0")}</span></div><h2 aria-live="polite">${paused ? "A moment to pause." : esc(hint || current?.title || "All points covered.")}</h2><p>${paused ? "Resume when you’re ready. Your place is saved." : hint ? esc(current?.title || "Your thread") : esc(current?.meaning || "You’ve shared every idea in your outline.")}</p><div class="wave" aria-hidden="true">${Array.from({ length: 23 }, (_, i) => `<i style="--height:${[10, 18, 8, 26, 14, 32, 20][i % 7]}px"></i>`).join("")}</div><div class="playback" role="status">${esc(playback || "Your voice leads. Ask for a hint when you need one.")}</div></div><div class="speaking-controls">${button("hint", "Hint <kbd>H</kbd>", "primary", busy || cueBusy || !listening() || !focusId)}${button("next", "Next idea <span>→</span>", "secondary", busy || cueBusy || !listening())}${button("more", "More detail", "text", busy || cueBusy || !listening() || !delivered?.cardId)}</div><div class="next-preview"><span>UP NEXT</span><strong>${esc(next?.card?.title || "End of your outline")}</strong><small>Moves on automatically when this idea is covered. Use Next idea to skip ahead.</small></div>${health?.voice.simulated ? `<form id="practice-form" class="practice-input"><label for="practice">Practice speech <span>SIMULATED INPUT · no microphone</span></label><div><input id="practice" name="speech" placeholder="Type what you would say…" required maxlength="3000" ${paused ? "disabled" : ""}><button class="secondary" ${paused || busy ? "disabled" : ""}>Send</button></div><p>Hints use approved text. Audio, if enabled, is a placeholder tone.</p></form>` : ""}<div class="lifecycle-controls">${button(paused ? "resume" : "pause", paused ? "▶ Resume" : "Ⅱ Pause", "secondary", busy || transportStopped)}${button("end", "End session", "text danger", busy)}${button("stop-audio", "Stop hint audio", "text", !listening())}</div></section><aside class="outline-panel"><div class="section-heading"><h2>Your thread</h2><span>${covered}/${cards.length}</span></div><div class="progress"><span style="width:${cards.length ? (covered / cards.length) * 100 : 0}%"></span></div><p class="fine">Select an idea to revisit it. Coverage follows what you say.</p><ol>${ordered()
    .map((c, i) => {
      const status = state?.coverage[c.id]?.status || "uncovered";
      return `<li><button data-action="select:${c.id}" class="outline-choice ${focusId === c.id ? "active" : ""}" aria-pressed="${focusId === c.id}" ${busy || !listening() ? "disabled" : ""}><span class="coverage-dot ${status}">${status === "covered" ? "✓" : i + 1}</span><span><strong>${esc(c.title)}</strong><small>${status === "covered" ? "Covered" : status === "partial" ? "In progress" : c.mustMention ? "Must mention" : "Not covered yet"}</small></span></button></li>`;
    })
    .join(
      "",
    )}</ol><div class="outline-foot">${health?.coverage === "mock" ? "Practice tracking · word matching" : "Live idea tracking"}<br>${audioEnabled ? "Text + audio hints" : "Text hints"}</div></aside></div>`;
}
function recapView() {
  const missed = cards.filter((c) => recap?.missedMustMention.includes(c.id));
  return `${intro("SESSION COMPLETE", "Your words.<br>Your progress.", "Take a moment to see what you shared and what you might revisit.")}<div class="recap-stats"><div><strong>${recap?.covered.length || 0}<small> / ${cards.length}</small></strong><span>Ideas covered</span></div><div><strong>${recap?.cueRequests || 0}</strong><span>Hints requested</span></div><div><strong>${formatTime(recap?.durationMs || 0)}</strong><span>Speaking time</span></div></div><section class="recap-card"><h2>${missed.length ? "Keep these close next time" : "Your essential ideas are covered"}</h2><p>${missed.length ? "These must-mention ideas weren’t fully covered." : "You reached each must-mention point in this session."}</p>${missed.map((c) => `<div class="recap-item"><strong>${esc(c.title)}</strong><span>${esc(c.cue)}</span></div>`).join("")}${health?.coverage === "mock" ? '<p class="provider-note">Practice results use simulated word matching, not verified semantic understanding.</p>' : ""}<div class="recap-actions">${button("again", "Prepare another round →", "primary")}<span>Your outline stays available. Session transcript buffers are cleared.</span></div></section>`;
}
function render(focus = false) {
  const active = document.activeElement as HTMLElement | null;
  const action = active?.dataset.action;
  const id = active?.id;
  const practice = $<HTMLInputElement>("practice");
  const draft = practice?.value;
  const cursor = practice?.selectionStart;
  const priorStage = $("main")?.dataset.stage;
  $("app").innerHTML = shell();
  $("main").dataset.stage = stage;
  if (draft !== undefined && $("practice")) {
    const field = $<HTMLInputElement>("practice");
    field.value = draft;
    if (cursor !== null && cursor !== undefined)
      field.setSelectionRange(cursor, cursor);
  }
  if (focus || priorStage !== stage) $("main").focus();
  else if (action) {
    const target = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-action]"),
    ].find((b) => b.dataset.action === action);
    target?.focus();
  } else if (id) $(id)?.focus();
}

function makeVoice() {
  voice?.end();
  voice = createVoiceController({
    simulated: !!health?.voice.simulated,
    maxGapWaitMs: 2000,
  });
  voice.on("error", (msg) => {
    error = msg + " Your text hint remains available.";
    render();
  });
  voice.on("speaking", (active) => {
    if (active) {
      cancel();
      playback = "You have the floor.";
      render();
    }
  });
  voice.on("playback", (event) => {
    playback =
      event.state === "waiting"
        ? "Waiting for a pause…"
        : event.state === "playing"
          ? "Playing your hint…"
          : event.reason === "failed"
            ? "Audio unavailable. Your hint stays on screen."
            : event.reason === "speaker-resumed"
              ? "You have the floor."
              : "";
    render();
  });
  return voice;
}
function subscribe(id: string) {
  events?.close();
  events = new EventSource(`/api/sessions/${id}/events`);
  events.onopen = () => {
    streamOk = true;
    render();
  };
  events.onerror = () => {
    streamOk = false;
    render();
  };
  events.onmessage = (event) => {
    try {
      const update = JSON.parse(event.data) as SessionEvent;
      if ("state" in update && state?.id === id) {
        accept(update.state);
        render();
      }
      if (update.type === "error") fail(update.message);
    } catch {
      fail("Could not read a session update. Reconnect or end this session.");
    }
  };
}
async function cue(level: "short" | "expanded", explicitId?: string) {
  if (!listening() || busy || cueBusy) return;
  error = "";
  cancel();
  cueBusy = true;
  const token = intent;
  const id = state!.id;
  const transcript = state!.transcriptRevision;
  render();
  try {
    if (explicitId && state!.selectedCardId !== explicitId) {
      const selected = await sessionApi("select", { cardId: explicitId });
      if (token !== intent || state?.id !== id || !listening()) return;
      accept(selected);
      focusId = explicitId;
      delivered = null;
      hint = "";
      render();
    }
    const result = await sessionApi<CueResponse>("cue", { level });
    if (
      token !== intent ||
      state?.id !== id ||
      !listening() ||
      state.transcriptRevision !== transcript
    )
      return;
    delivered = result;
    hint = result.text;
    message = "";
    if (result.cardId) focusId = result.cardId;
    render();
    if (audioEnabled && result.cardId) void voice?.playCue(result).catch(fail);
  } catch (e) {
    if (token === intent) {
      const c = cards.find(
        (c) => c.id === (level === "expanded" ? delivered?.cardId : focusId),
      );
      if (c) {
        hint = level === "expanded" ? c.expandedCue : c.cue;
      }
      fail(e);
    }
  } finally {
    if (token === intent) cueBusy = false;
    render();
  }
}
async function select(id: string) {
  cancel();
  delivered = null;
  hint = "";
  accept(await sessionApi("select", { cardId: id }));
  focusId = id;
  message = "";
  render();
}
async function startOrResume(resume = false) {
  cancel();
  error = "";
  try {
    accept(await sessionApi(resume ? "resume" : "start"));
    stage = "speak";
    transportStopped = false;
    const controller = makeVoice();
    if (output) await controller.setOutputDevice(output);
    await controller.start(state!.id);
    message = "";
    render(true);
  } catch (e) {
    voice?.end();
    try {
      accept(await sessionApi("pause"));
    } catch {
      transportStopped = true;
    }
    stage = "speak";
    fail(e);
  }
}
async function run(action: string) {
  if (action === "dismiss") {
    error = "";
    render();
    return;
  }
  if (busy) return;
  if (action === "hint") {
    await cue("short", focusId || undefined);
    return;
  }
  if (action === "more") {
    await cue("expanded");
    return;
  }
  if (action === "next") {
    const next = nextIdea(state!, focusId);
    if (!next.card) {
      cancel();
      delivered = null;
      hint = next.message;
      announce(next.message);
      return;
    }
    await cue("short", next.card.id);
    return;
  }
  busy = true;
  error = "";
  render();
  try {
    if (action.startsWith("edit:")) editor(action.slice(5));
    else if (action === "add") editor();
    else if (action === "import") importer();
    else if (action.startsWith("up:") || action.startsWith("down:")) {
      const id = action.split(":")[1],
        i = cards.findIndex((c) => c.id === id),
        j = i + (action.startsWith("up:") ? -1 : 1);
      if (j >= 0 && j < cards.length) {
        [cards[i], cards[j]] = [cards[j], cards[i]];
        cards.forEach((c, index) => (c.order = index));
      }
    } else if (action === "sample") {
      const data = await api<{ outline: IdeaCard[] }>("/api/fixtures/outline");
      cards = data.outline;
    } else if (action === "approve") {
      if (cards.some((c) => validateCard(c)))
        throw Error("Review each idea and use 2–5 words per hint.");
      if (state && state.lifecycle !== "ended") {
        await sessionApi("end");
        events?.close();
      }
      state = null;
      state = await api<SessionState>("/api/sessions", {
        outline: cards,
        targetDurationSec: duration || null,
      });
      accept(await sessionApi("approve"));
      focusId = cards[0]?.id || null;
      delivered = null;
      hint = "";
      makeVoice();
      stage = "setup";
      previewed = false;
      subscribe(state.id);
      const preparingSession = state.id;
      void voice!
        .prepare(state.id)
        .then((result) => {
          if (state?.id === preparingSession && stage === "setup" && result.failed.length)
            announce(
              "Some audio could not be prepared. Text hints will still work.",
            );
        })
        .catch((err) => { if (state?.id === preparingSession && stage === "setup") fail(err); });
    } else if (action === "back") {
      voice?.end();
      events?.close();
      if (state && state.lifecycle !== "ended") accept(await sessionApi("end"));
      stage = "prepare";
      previewed = false;
    } else if (action === "outputs") {
      outputs = await voice!.listOutputDevices();
    } else if (action === "preview") {
      const result = await voice!.preview();
      if (result === "failed")
        throw Error(
          "Could not play the preview. Check your output or turn off audio hints.",
        );
      message = "If you heard the preview, confirm it below to continue.";
    } else if (action === "start") await startOrResume();
    else if (action === "resume") await startOrResume(true);
    else if (action === "pause") {
      cancel();
      voice?.pause();
      try {
        accept(await sessionApi("pause"));
      } catch (e) {
        transportStopped = true;
        throw e;
      }
      playback = "";
    } else if (action === "end") {
      cancel();
      voice?.end();
      try {
        accept(await sessionApi("end"));
      } catch (e) {
        transportStopped = true;
        throw e;
      }
      events?.close();
      recap = await api<SessionRecap>(`/api/sessions/${state!.id}/recap`);
      delivered = null;
      hint = "";
      focusId = null;
      stage = "recap";
      message = "";
    } else if (action === "again") {
      voice?.end();
      events?.close();
      state = null;
      recap = null;
      stage = "prepare";
      hint = "";
      delivered = null;
      focusId = null;
      transportStopped = false;
      previewed = false;
    } else if (action.startsWith("select:")) await select(action.slice(7));
    else if (action === "stop-audio") {
      cancel();
      playback = "Hint audio stopped.";
    }
  } catch (e) {
    fail(e);
  } finally {
    busy = false;
    render();
  }
}

function editor(id?: string) {
  const existing = cards.find((c) => c.id === id);
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "edit-title");
  const c = existing || {
    title: "",
    meaning: "",
    cue: "",
    expandedCue: "",
    mustMention: false,
  };
  dialog.innerHTML = `<form id="card-form"><div class="dialog-heading"><span class="eyebrow">YOUR NEXT THOUGHT</span><h2 id="edit-title">${existing ? "Edit your idea" : "Add an idea"}</h2></div><label>Idea title<input name="title" required maxlength="80" value="${esc(c.title)}" placeholder="e.g. Our first customer"></label><label>What do you want to say?<textarea name="meaning" required maxlength="700" placeholder="Describe the idea Thread should listen for.">${esc(c.meaning)}</textarea></label><div class="field-pair"><label>Short hint <span>2–5 words</span><input name="cue" required maxlength="100" value="${esc(c.cue)}" placeholder="Your first customer"></label><label class="check-label"><input name="mustMention" type="checkbox" ${c.mustMention ? "checked" : ""}>Must mention</label></div><label>More detail<textarea name="expandedCue" required maxlength="350" placeholder="One sentence to help if the short hint isn’t enough.">${esc(c.expandedCue)}</textarea></label><p id="card-error" role="alert"></p><div class="dialog-actions">${existing ? '<button type="button" id="delete-card" class="text danger">Delete idea</button>' : "<span></span>"}<div><button type="button" id="cancel-edit" class="secondary">Cancel</button> <button class="primary">Save idea</button></div></div></form>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.onclose = () => dialog.remove();
  $("cancel-edit").onclick = () => dialog.close();
  if (existing)
    $("delete-card").onclick = () => {
      cards = cards.filter((c) => c.id !== id);
      cards.forEach((c, i) => (c.order = i));
      dialog.close();
      render();
    };
  $("card-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const card: IdeaCard = {
      id: id || crypto.randomUUID(),
      title: String(f.get("title")).trim(),
      meaning: String(f.get("meaning")).trim(),
      cue: String(f.get("cue")).trim(),
      expandedCue: String(f.get("expandedCue")).trim(),
      mustMention: f.has("mustMention"),
      order: existing?.order ?? cards.length,
    };
    const error = validateCard(card);
    if (error) {
      $("card-error").textContent = error;
      return;
    }
    if (existing) cards = cards.map((c) => (c.id === id ? card : c));
    else cards.push(card);
    dialog.close();
    render();
  };
}
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function importer() {
  const simulated = !!health?.outline?.simulated;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "import-title");
  dialog.innerHTML = `<form id="import-form"><div class="dialog-heading"><span class="eyebrow">START FROM YOUR MATERIAL</span><h2 id="import-title">Import slides or docs</h2></div><p class="dialog-lede">Thread drafts talking points and short hints from your own material. You’ll review every card before you speak.</p><label class="file-drop">Slides or document <span>PDF, PowerPoint (.pptx), Word (.docx), or text · up to 10 MB</span><input type="file" name="file" accept=".pdf,.pptx,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"></label><div class="or-divider" aria-hidden="true"><span>or</span></div><label>Paste your notes<textarea name="text" maxlength="50000" placeholder="A speech draft, an outline, or a few bullets…"></textarea></label>${cards.length ? `<p class="fine">Imported ideas replace your current ${cards.length} ${cards.length === 1 ? "idea" : "ideas"}.</p>` : ""}${simulated ? '<p class="provider-note">Practice import splits your material by slide or heading without AI, so expect to edit more. PDFs need AI import on the server.</p>' : ""}<p id="import-error" role="alert"></p><div class="dialog-actions"><span></span><div><button type="button" id="cancel-import" class="secondary">Cancel</button> <button class="primary" id="run-import">Create talking points</button></div></div></form>`;
  document.body.append(dialog);
  dialog.showModal();
  const controller = new AbortController();
  dialog.onclose = () => {
    controller.abort();
    dialog.remove();
  };
  $("cancel-import").onclick = () => dialog.close();
  const form = $<HTMLFormElement>("import-form");
  const fileInput = form.elements.namedItem("file") as HTMLInputElement;
  const textInput = form.elements.namedItem("text") as HTMLTextAreaElement;
  const submit = $<HTMLButtonElement>("run-import");
  const showError = (text: string) => ($("import-error").textContent = text);
  form.onsubmit = async (e) => {
    e.preventDefault();
    showError("");
    const file = fileInput.files?.[0];
    const text = textInput.value.trim();
    if (!file && !text) return showError("Choose a file or paste your notes.");
    if (file && file.size > IMPORT_MAX_BYTES) return showError("Keep uploads under 10 MB.");
    submit.disabled = true;
    submit.textContent = "Reading your material…";
    try {
      const body = file
        ? { filename: file.name, data: toBase64(new Uint8Array(await file.arrayBuffer())) }
        : { text };
      const result = await api<{
        outline: IdeaCard[];
        source: { name: string };
        simulated: boolean;
      }>("/api/outline/generate", body, "POST", {
        timeoutMs: 120000,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      cards = result.outline;
      focusId = cards[0]?.id || null;
      error = "";
      message = `Drafted ${cards.length} talking ${cards.length === 1 ? "point" : "points"} from ${file ? result.source.name : "your notes"}. Review each one and reword any hint that doesn’t sound like you.${result.simulated ? " (Practice import: simple splitting, not AI.)" : ""}`;
      dialog.close();
      render();
    } catch (err) {
      if (controller.signal.aborted) return;
      showError(
        err instanceof DOMException && err.name === "TimeoutError"
          ? "That took too long. Try a smaller file or paste your notes."
          : err instanceof Error ? err.message : String(err),
      );
      submit.disabled = false;
      submit.textContent = "Create talking points";
    }
  };
}
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-action]",
  );
  if (b && !b.disabled) void run(b.dataset.action!);
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "duration") duration = Number(el.value);
  if (el.id === "audio") {
    audioEnabled = el.checked;
    previewed = false;
    render();
  }
  if (el.id === "heard") {
    previewed = el.checked;
    render();
  }
  if (el.id === "output") {
    output = el.value;
    previewed = false;
    void voice!
      .setOutputDevice(output)
      .then((ok) => {
        if (!ok)
          announce("Use your system sound settings to choose the earbud.");
      })
      .catch(fail);
    render();
  }
});
document.addEventListener("submit", (e) => {
  const form = e.target as HTMLFormElement;
  if (form.id !== "practice-form") return;
  e.preventDefault();
  if (!listening() || busy) return;
  const input = $<HTMLInputElement>("practice");
  const text = input.value.trim();
  if (text) {
    input.value = "";
    void voice?.simulateSpeech(text).catch(fail);
  }
});
document.addEventListener("keydown", (e) => {
  if (stage !== "speak" || !listening() || busy || cueBusy) return;
  const editable = !!(e.target as HTMLElement).closest(
    "input,textarea,select,button,a,[contenteditable],dialog",
  );
  if (!canShortcut(e, editable)) return;
  const action = (
    { h: "hint", c: "hint", m: "more", ArrowRight: "next" } as Record<
      string,
      string
    >
  )[e.key];
  if (action) {
    e.preventDefault();
    void run(action);
  }
});
setInterval(() => {
  const timer = $("timer");
  if (timer && state)
    timer.textContent = formatTime(
      state.elapsedMs + (listening() ? Date.now() - clockAt : 0),
    );
}, 1000);
window.addEventListener("pagehide", () => {
  cancel();
  voice?.end();
  events?.close();
  if (state && state.lifecycle !== "ended")
    void fetch(`/api/sessions/${state.id}/end`, {
      method: "POST",
      keepalive: true,
    });
});
(async () => {
  render();
  try {
    health = await api("/api/health");
    audioEnabled = !health!.voice.simulated;
    cards = (await api<{ outline: IdeaCard[] }>("/api/fixtures/outline"))
      .outline;
    focusId = cards[0]?.id || null;
    render();
  } catch (e) {
    error =
      "Cannot connect to Thread. Start the server, then reload this page. " +
      (e as Error).message;
    render();
  }
})();
