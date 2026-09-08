import test from "node:test";
import assert from "node:assert/strict";
import { shareVideo } from "../src/lib/share.js";

test("native sharing preserves the video link, handles cancellation and reports failures", async () => {
  const video = { title: "A video", url: "https://www.youtube.com/watch?v=abcdefghijk" };
  assert.equal(await shareVideo(video, {}), "unavailable");
  assert.equal(await shareVideo(video, { share: async data => assert.deepEqual(data, video) }), "shared");
  assert.equal(await shareVideo(video, { share: async () => { throw new DOMException("Cancelled", "AbortError"); } }), "cancelled");
  await assert.rejects(shareVideo(video, { share: async () => { throw new Error("blocked"); } }), /Copy link/);
});
