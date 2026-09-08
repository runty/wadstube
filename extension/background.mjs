import { CHANNEL_ID, libraryRequest, savePayload } from './library.mjs';

// Only our own popup can issue these fixed operations. No page-to-extension API,
// arbitrary URLs, automatic refresh, or background monitoring of browsing.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  const run = async () => {
    if (message?.type === 'folders') {
      const query = CHANNEL_ID.test(message.channelId || '') ? `?channelId=${encodeURIComponent(message.channelId)}` : '';
      return libraryRequest('/api/folders' + query);
    }
    if (message?.type === 'save') {
      if (typeof message.folderId !== 'string' || !message.folderId || message.folderId.length > 200) throw new Error('Choose a group first.');
      const result = await libraryRequest(`/api/folders/${encodeURIComponent(message.folderId)}/channels`, savePayload(message.channel));
      // Keep only the destination preference. Never persist the watched video.
      await chrome.storage.local.set({ lastFolder: message.folderId }).catch(() => {});
      return result;
    }
    throw new Error('Unsupported action.');
  };
  run().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true; // The save can finish even after the popup closes.
});
