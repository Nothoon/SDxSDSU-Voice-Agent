// UI-only fixtures. Nathan and Vineet replace these through createAdapters().
// These mocks do not capture a microphone, infer meaning, or play audio.
export function createDemoAdapters() {
  let cards = [], coverage = {}, lastId = null, revision = 0, lifecycle = 'ready';
  let connection = 'connected', audio = 'idle', segments = [];
  const snapshot = () => ({ coverage: { ...coverage }, revision, lifecycle, connection, audio, segments: [...segments] });
  return {
    mode: 'demo',
    session: {
      async start(outline) { cards = structuredClone(outline); coverage = Object.fromEntries(cards.map(c => [c.id, 'uncovered'])); lastId = null; segments = []; lifecycle = 'listening'; connection = 'connected'; revision++; return snapshot(); },
      async cue({ requestId, cardId, level }) {
        if (lifecycle !== 'listening') throw Error('Resume the session to request a cue.');
        // Deterministic fixture only; real selection belongs to Nathan.
        const id = level === 'expanded' ? lastId : cardId || lastId || cards.find(c => coverage[c.id] !== 'covered')?.id;
        const card = cards.find(c => c.id === id); lastId = card?.id || null;
        return { requestId, cardId: card?.id || null, level, text: card ? (level === 'expanded' ? card.expandedCue : card.cue) : 'All points covered.', stateRevision: revision };
      },
      async select(id) { lastId = id; revision++; return snapshot(); },
      async pause() { lifecycle = 'paused'; revision++; return snapshot(); },
      async resume() { lifecycle = 'listening'; revision++; return snapshot(); },
      async end() { cards = []; coverage = {}; segments = []; lastId = null; lifecycle = 'ended'; audio = 'idle'; revision++; return snapshot(); },
      fixture({ cardId, status, text, disconnected }) {
        if (lifecycle !== 'listening') return snapshot();
        if (typeof disconnected === 'boolean') connection = disconnected ? 'disconnected' : 'connected';
        if (cardId && Object.hasOwn(coverage, cardId)) { coverage[cardId] = status; lastId = null; if (text) segments.push({ id: crypto.randomUUID(), text, isFinal: true }); }
        revision++; return snapshot();
      },
    },
    voice: {
      async start() { audio = 'ready'; },
      async preview() { return { text: 'Find your thread', simulated: true }; },
      async play() { audio = 'simulated'; },
      cancel() { audio = 'idle'; },
      async pause() { audio = 'idle'; },
      async stop() { audio = 'idle'; },
    },
  };
}
