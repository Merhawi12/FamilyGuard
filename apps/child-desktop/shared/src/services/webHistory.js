import { device as deviceApi } from './api.js';
import { onUnlinked } from './link.js';
import { readJson, writeJson } from './store.js';

const QUEUE_KEY = 'fg_web_history_queue';
const UPLOAD_INTERVAL = 60 * 1000;   // how often a non-empty queue is drained
const BATCH_SIZE = 200;              // must not exceed the server's per-request cap
const MAX_QUEUE = 2000;              // ceiling for a long offline stretch

const _state = {
  queued: 0,
  uploaded: 0,
  dropped: 0,
  lastUploadAt: null,
  lastError: null,
};

let _queue = [];
let _timer = null;
let _uploading = false;

export function getWebHistoryStatus() {
  return { ..._state, queued: _queue.length };
}

/**
 * An unlinked device must not carry its backlog into the next link.
 *
 * `link.js` deletes the persisted queue, but the in-memory copy is what actually
 * gets uploaded and it survives an unlink, because nothing restarts the process.
 * If the laptop is then linked to a sibling — the ordinary reason a parent
 * unlinks one — the next drain would post one child's browsing under the other
 * child's device token, and it would appear in their history as fact.
 */
onUnlinked(() => {
  _queue = [];
  _state.queued = 0;
  _state.lastError = null;
});

/** One key per domain per visit window, so a re-queued batch cannot double-count. */
const keyOf = (v) => `${v.domain}|${v.firstSeen}`;

/**
 * Fold a batch into the queue.
 *
 * The proxy already collapses repeat lookups within its flush window, but two
 * windows can carry the same domain, and a batch that failed to upload is put
 * back. Merging on (domain, firstSeen) means neither produces a duplicate: the
 * counts add up instead.
 */
function mergeIntoQueue(visits) {
  const index = new Map(_queue.map((v) => [keyOf(v), v]));

  for (const visit of visits) {
    const domain = String(visit?.domain || '').trim().toLowerCase();
    if (!domain) continue;

    const entry = {
      domain,
      firstSeen: Number(visit.firstSeen) || Date.now(),
      lastSeen: Number(visit.lastSeen) || Number(visit.firstSeen) || Date.now(),
      count: Number(visit.count) > 0 ? Math.floor(visit.count) : 1,
      blocked: !!visit.blocked,
    };

    const existing = index.get(keyOf(entry));
    if (existing) {
      existing.lastSeen = Math.max(existing.lastSeen, entry.lastSeen);
      existing.count += entry.count;
      existing.blocked = existing.blocked || entry.blocked;
      continue;
    }

    if (_queue.length >= MAX_QUEUE) {
      // Oldest first: a machine offline for days should still report what the
      // child did most recently rather than stopping at the first full queue.
      _queue.shift();
      _state.dropped += 1;
    }
    _queue.push(entry);
    index.set(keyOf(entry), entry);
  }
}

const persistQueue = () => writeJson(QUEUE_KEY, _queue).catch((err) => {
  console.warn('[webHistory] queue persist failed:', err.message);
});

/** Take a batch of visits from the resolver. */
export async function ingestVisits(visits) {
  if (!Array.isArray(visits) || visits.length === 0) return;
  mergeIntoQueue(visits);
  await persistQueue();
}

/**
 * Send queued visits to the API.
 *
 * A batch is only removed from the queue once the server has confirmed it, so a
 * failed upload is retried on the next pass rather than lost.
 */
export async function uploadWebHistory() {
  if (_uploading || _queue.length === 0) return _state;
  _uploading = true;

  try {
    while (_queue.length > 0) {
      const batch = _queue.slice(0, BATCH_SIZE);
      // Sent, not yet cleared: only a confirmed response drops these.
      const res = await deviceApi.logWebHistory(batch);

      _queue = _queue.slice(batch.length);
      _state.uploaded += (res.data?.created || 0) + (res.data?.merged || 0);
      _state.lastUploadAt = new Date().toISOString();
      _state.lastError = null;

      if (res.data?.rejected) {
        console.warn(`[webHistory] server rejected ${res.data.rejected} malformed entr(ies)`);
      }
      await persistQueue();
    }
  } catch (err) {
    _state.lastError = err.message;
    console.warn('[webHistory] upload failed, keeping queue:', err.message);
    await persistQueue();
  } finally {
    _uploading = false;
  }

  return _state;
}

export async function startWebHistory() {
  // A queue left over from a previous run is picked up before anything new is
  // collected, so a restart mid-backlog resumes rather than starts over.
  const restored = await readJson(QUEUE_KEY, []);
  _queue = Array.isArray(restored) ? restored : [];

  clearInterval(_timer);
  _timer = setInterval(() => { uploadWebHistory(); }, UPLOAD_INTERVAL);
  _timer.unref?.();

  // Anything already queued from a previous run goes out now rather than waiting
  // a full interval.
  await uploadWebHistory();
}

export function stopWebHistory() {
  clearInterval(_timer);
  _timer = null;
}

/** Test seam: feed visits in as though the resolver had emitted them. */
export const __testing = {
  queue: () => [..._queue],
  reset: () => { _queue = []; _state.uploaded = 0; _state.dropped = 0; _state.lastError = null; },
};
