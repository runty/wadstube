export function rssFallbackSuffix(summary) {
  const count = Number(summary?.rss_fallbacks) || 0;
  if (count <= 0) return "";
  return ` · ${count} channel${count === 1 ? "" : "s"} used RSS fallback`;
}
