// Local reads get a total deadline, including body consumption. Mutations can
// wait for the shared lock or run a large refresh; do not impose a read deadline
// on them or retry an action that may already have succeeded.
export function fetchRequest(url, options = {}) {
  if (!["GET", "HEAD"].includes((options.method || "GET").toUpperCase())) return globalThis.fetch(url, options);
  const deadline = AbortSignal.timeout(30000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  return globalThis.fetch(url, { ...options, signal });
}
