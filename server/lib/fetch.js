// One deadline covers headers AND body; cap decoded bytes before XML/JSON parsing.
async function fetchBuffered(url, options = {}, { timeout = 10000, maxBytes = 2 * 1024 * 1024, discardErrors = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Upstream response timed out")), timeout);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    if (options.method === "HEAD" || response.status === 304 || (discardErrors && !response.ok)) {
      await response.body?.cancel();
      return { response, text: "" };
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return { response, text: Buffer.concat(chunks).toString("utf8") };
  } catch (err) {
    controller.abort();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchBuffered };
