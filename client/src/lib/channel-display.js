export const UNRESOLVED_CHANNEL_LABEL = "Needs resolution";
export const UNRESOLVED_CHANNEL_HELP =
  "Skipped during refresh. Paste a canonical channel ID, handle URL, or video URL below to resolve it in place.";

export function isUnresolvedChannel(channel) {
  return channel?.unresolved === true;
}

export function canUseAsFeedFilter(channel) {
  return !isUnresolvedChannel(channel);
}

export function ownValue(record, key, fallback = undefined) {
  return record && Object.hasOwn(record, key) ? record[key] : fallback;
}

export function moveDestinationFor(selections, channel) {
  return selections instanceof Map ? selections.get(channel?.id) || "" : "";
}
