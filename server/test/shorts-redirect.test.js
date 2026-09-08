const test = require("node:test");
const assert = require("node:assert/strict");
const { checkIsShort } = require("../lib/youtube");

test("Shorts classification trusts only same-video YouTube watch redirects", async (t) => {
  const id = "abcdefghijk";
  let response;
  t.mock.method(globalThis, "fetch", async () => response);
  for (const location of ["/watch?v=" + id, "https://www.youtube.com/watch?v=" + id + "&feature=share", "https://m.youtube.com/watch?v=" + id]) {
    response = new Response(null, { status: 302, headers: { location } });
    assert.equal(await checkIsShort(id), "long");
  }
  for (const location of [null, "/watch?v=another", "https://consent.youtube.com/", "/signin", "https://youtube.com.evil.invalid/watch?v=" + id, "http://www.youtube.com/watch?v=" + id, "https://user@youtube.com/watch?v=" + id, "https://[malformed"]) {
    response = new Response(null, { status: 302, headers: location ? { location } : {} });
    assert.equal(await checkIsShort(id), "unknown", String(location));
  }
  for (const [status, expected] of [[200, "short"], [403, "unknown"], [429, "unknown"], [503, "unknown"]]) {
    response = new Response(null, { status });
    assert.equal(await checkIsShort(id), expected);
  }
});
