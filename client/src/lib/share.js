// Native sharing must run directly from the user's click. Cancellation is not
// an error; unsupported/blocked sharing can still use the existing copy action.
export async function shareVideo(video, browser = navigator) {
  if (typeof browser.share !== "function") return "unavailable";
  try {
    await browser.share({ title: video.title, url: video.url });
    return "shared";
  } catch (error) {
    if (error?.name === "AbortError") return "cancelled";
    throw new Error("Could not share the link. Try Copy link or open the video.");
  }
}
