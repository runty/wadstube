export const UNRESOLVED_CHANNEL_LABEL = "Needs resolution";
export const UNRESOLVED_CHANNEL_HELP =
  "Skipped during refresh. Remove it and add a supported channel, handle, or video URL to replace it.";

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
