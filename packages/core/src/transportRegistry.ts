import { TransportBus } from './transportBus';
import { WorkletTransport } from './transportWorklet';

export interface SharedTransportEntry {
  transport: WorkletTransport;
  bus: TransportBus;
  refs: number;
}

interface SharedTransportState {
  context: AudioContext;
  // Settled entry for the current generation, null while loading / after disposal.
  entry: SharedTransportEntry | null;
  // Single in-flight creation promise for this context.
  loader: Promise<SharedTransportEntry> | null;
  // Number of outstanding users. Every acquire claims one slot synchronously and
  // every release gives one back; failed acquisitions roll their slot back when
  // the caller has not already released it.
  refs: number;
  // Acquire calls whose promise has not settled yet. A release happening before
  // settlement pairs with one of these so a later rejection cannot remove the
  // same claim twice.
  pendingClaims: Set<SharedTransportClaim>;
}

interface SharedTransportClaim {
  released: boolean;
}

const SHARED_TRANSPORT_OPTIONS = {
  bpm: 120,
  startBeat: 0,
  tickIntervalSec: 0.025,
} as const;

// One lifecycle state per AudioContext. A WeakMap also lets the context be GC'd.
const sharedTransports = new WeakMap<AudioContext, SharedTransportState>();

const getSharedTransportState = (context: AudioContext): SharedTransportState => {
  let state = sharedTransports.get(context);
  if (!state) {
    state = {
      context,
      entry: null,
      loader: null,
      refs: 0,
      pendingClaims: new Set(),
    };
    sharedTransports.set(context, state);
  }
  return state;
};

const disposeSharedEntry = (entry: SharedTransportEntry): void => {
  // Tear every resource down independently so one failure cannot strand the
  // worklet node or leave listeners attached.
  try {
    entry.bus.dispose();
  } catch {
    /* bus teardown must not block transport teardown */
  }
  try {
    entry.transport.dispose();
  } catch {
    /* transport teardown is best-effort as well */
  }
};

/**
 * Keep entry.refs in sync and destroy the shared entry as soon as the last
 * user goes away. Must be called after every refs/loader/entry mutation.
 */
const reconcileSharedState = (
  context: AudioContext,
  state: SharedTransportState
): void => {
  if (state.entry) {
    state.entry.refs = state.refs;
  }

  if (state.refs <= 0 && state.entry) {
    const entry = state.entry;
    state.entry = null;
    disposeSharedEntry(entry);
  }

  if (
    state.refs <= 0 &&
    !state.entry &&
    !state.loader &&
    sharedTransports.get(context) === state
  ) {
    // No users, no entry and no pending work: drop all cached state so the
    // next acquire builds a brand new worklet/bus pair.
    sharedTransports.delete(context);
  }
};

const createSharedTransportLoader = (
  context: AudioContext,
  state: SharedTransportState
): Promise<SharedTransportEntry> =>
  WorkletTransport.create(context, SHARED_TRANSPORT_OPTIONS)
    .then((transport) => {
      // Build the bus before publishing so callers never observe a half entry.
      const bus = new TransportBus(transport);
      const entry: SharedTransportEntry = {
        transport,
        bus,
        refs: state.refs,
      };

      // Publish atomically with clearing the in-flight loader. If every claimant
      // released while creation was in flight, reconcile disposes the newborn
      // transport immediately instead of handing out a leaked node.
      state.loader = null;
      state.entry = entry;
      reconcileSharedState(context, state);
      return entry;
    })
    .catch((error: unknown) => {
      // Never leave a half-initialized entry or a settled/rejected loader cached.
      state.loader = null;
      state.entry = null;
      reconcileSharedState(context, state);
      throw error;
    });

export const acquireSharedTransport = async (
  context: AudioContext
): Promise<SharedTransportEntry> => {
  const state = getSharedTransportState(context);

  // Claim the reference synchronously. This closes the window where a
  // concurrent release could observe refs === 0 between promise resolution and
  // the old asynchronous `entry.refs += 1`.
  const claim: SharedTransportClaim = { released: false };
  state.pendingClaims.add(claim);
  state.refs += 1;

  try {
    if (state.entry) {
      reconcileSharedState(context, state);
      return state.entry;
    }

    if (!state.loader) {
      state.loader = createSharedTransportLoader(context, state);
    }

    const entry = await state.loader;
    return entry;
  } catch (error) {
    // A failed acquirer is not a user. Roll the claim back unless a release
    // happening before settlement already consumed this slot.
    if (!claim.released) {
      state.refs = Math.max(0, state.refs - 1);
      reconcileSharedState(context, state);
    }
    throw error;
  } finally {
    state.pendingClaims.delete(claim);
  }
};

export const releaseSharedTransport = (context: AudioContext): void => {
  const state = sharedTransports.get(context);
  if (!state) {
    // Unmatched release after the generation was already torn down: nothing to do.
    return;
  }

  // Pair this release with an unsettled claim when possible so that claim's
  // later rejection does not decrement the counter a second time.
  const pendingClaim = state.pendingClaims.values().next().value as
    | SharedTransportClaim
    | undefined;
  if (pendingClaim) {
    pendingClaim.released = true;
    state.pendingClaims.delete(pendingClaim);
  }

  state.refs = Math.max(0, state.refs - 1);
  reconcileSharedState(context, state);
};
