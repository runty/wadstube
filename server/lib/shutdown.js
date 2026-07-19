async function waitForRefreshDrain(appState, timeoutMs = 20_000) {
  if (!appState.refreshLock) return true;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const drained = await Promise.race([
    appState.refreshLock.then(() => true),
    timeout,
  ]);
  clearTimeout(timer);
  return drained;
}

async function waitForTasksDrain(tasks, timeoutMs = 20_000) {
  const pending = [...(tasks || [])];
  if (!pending.length) return true;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const drained = await Promise.race([
    Promise.allSettled(pending).then(() => true),
    timeout,
  ]);
  clearTimeout(timer);
  return drained;
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
  });
}

module.exports = { waitForRefreshDrain, waitForTasksDrain, closeServer };
