import { APP_ORIGIN, flattenFolders, videoIdFromUrl } from './library.mjs';
import { readYouTubeChannel } from './detect.mjs';

const $ = id => document.getElementById(id);
let channel = null, folders = [], selected = null, saving = false, loadingGroups = false, tabId = null, generation = 0;

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'The extension could not connect. Close it and try again.');
  return response.data;
}

function showError(error) {
  $('error-detail').textContent = error.message;
  $('error').hidden = false;
  $('connection-label').textContent = 'Connection needs attention';
  $('connection-dot').classList.remove('connected');
}

function updateSelection() {
  const choice = folders.find(folder => folder.id === selected && !folder.added);
  $('save').disabled = saving || loadingGroups || !choice;
  $('save').querySelector('span').textContent = saving ? 'Saving channel…' : choice ? `Add to ${choice.name}` : 'Add to group';
  $('selection').textContent = choice ? `Destination: ${choice.path}` : 'Choose where this channel belongs.';
}

function renderGroups() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const visible = folders.filter(folder => folder.path.toLocaleLowerCase().includes(query));
  $('groups').replaceChildren();
  for (const folder of visible) {
    const row = $('group-template').content.firstElementChild.cloneNode(true);
    row.querySelector('.group-name').textContent = folder.name;
    row.querySelector('.group-parent').textContent = folder.parent;
    row.title = folder.path;
    const radio = row.querySelector('input');
    radio.value = folder.id;
    radio.setAttribute('aria-label', `${folder.path}${folder.added ? ' — already added' : ''}`);
    radio.checked = selected === folder.id;
    radio.disabled = folder.added || saving || loadingGroups;
    radio.addEventListener('change', () => { selected = folder.id; updateSelection(); });
    row.querySelector('.added-badge').hidden = !folder.added;
    $('groups').append(row);
  }
  $('no-groups').hidden = visible.length > 0;
  $('no-groups').textContent = folders.length ? 'No matching groups. Try another name.' : 'No groups yet. Create one in WadsTube, then reload here.';
  $('group-count').textContent = String(folders.length);
  updateSelection();
}

async function loadGroups() {
  const current = ++generation;
  loadingGroups = true;
  $('error').hidden = true;
  $('reload').disabled = true;
  $('save').disabled = true;
  try {
    const tree = await request({ type: 'folders', channelId: channel.channelId });
    if (current !== generation) return;
    if (!Array.isArray(tree)) throw new Error('WadsTube returned an unexpected group list. Please retry.');
    if (channel.channelId && tree.some(folder => typeof folder.containsChannel !== 'boolean')) {
      throw new Error('Install the companion server update first so existing group memberships can be checked safely.');
    }
    folders = flattenFolders(tree);
    const memberships = folders.filter(folder => folder.added).length;
    $('channel-handle').textContent = (channel.handle ? `${channel.handle} · ` : '') +
      (memberships ? `In ${memberships} ${memberships === 1 ? 'group' : 'groups'} already` : channel.channelId ? 'New to your library' : 'Channel verified when you save');
    const { lastFolder } = await chrome.storage.local.get('lastFolder');
    if (current !== generation) return;
    const preferred = selected || lastFolder;
    selected = folders.some(folder => folder.id === preferred && !folder.added) ? preferred : null;
    $('loading').hidden = true;
    $('picker').hidden = false;
    $('connection-label').textContent = 'Connected to WadsTube';
    $('connection-dot').classList.add('connected');
    renderGroups();
  } catch (error) {
    if (current !== generation) return;
    $('loading').hidden = true;
    $('picker').hidden = true;
    showError(error);
  } finally {
    if (current === generation) { loadingGroups = false; $('reload').disabled = false; renderGroups(); }
  }
}

async function initialize() {
  $('error').hidden = true;
  $('loading').hidden = false;
  $('empty').hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !videoIdFromUrl(tab.url)) {
      $('loading').hidden = true;
      $('empty').hidden = false;
      return;
    }
    tabId = tab.id;
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readYouTubeChannel });
    if (!result || result.videoId !== videoIdFromUrl(tab.url)) throw new Error('The video changed while opening. Close this popup and try again.');
    channel = result;
    $('channel-name').textContent = channel.name;
    $('channel-handle').textContent = channel.handle || (channel.channelId ? 'Ready for your library' : 'Channel verified when you save');
    $('initial').textContent = [...channel.name][0]?.toUpperCase() || '▶';
    $('identified').hidden = !channel.channelId;
    $('video-title').textContent = channel.title;
    $('video-title').hidden = !channel.title;
    if (channel.avatar) {
      $('channel-avatar').src = channel.avatar;
      $('channel-avatar').hidden = false;
      $('channel-avatar').addEventListener('error', () => { $('channel-avatar').hidden = true; }, { once: true });
    }
    $('save-note').textContent = channel.channelId ? 'Adds the channel. Videos refresh when you choose.' : 'Uses one YouTube API lookup to identify the channel.';
    $('channel-card').hidden = false;
    await loadGroups();
  } catch (error) { $('loading').hidden = true; showError(error); }
}

$('save').addEventListener('click', async () => {
  const folder = folders.find(item => item.id === selected && !item.added);
  if (!folder || saving || loadingGroups) return;
  saving = true;
  $('error').hidden = true;
  $('reload').disabled = true;
  $('search').disabled = true;
  renderGroups();
  try {
    // A playing tab can navigate while the popup stays open (autoplay/keyboard).
    const tab = await chrome.tabs.get(tabId);
    if (videoIdFromUrl(tab.url) !== channel.videoId) throw new Error('The YouTube video changed. Reopen the extension to save its current channel.');
    const result = await request({ type: 'save', folderId: folder.id, channel });
    channel.channelId = result.channelId;
    folder.added = true;
    $('picker').hidden = true;
    $('success-detail').textContent = `${result.channelName && result.channelName !== 'Unknown' ? result.channelName : channel.name} is saved in ${folder.path}.`;
    $('open-group').href = `${APP_ORIGIN}/?folder=${encodeURIComponent(folder.id)}`;
    $('success').hidden = false;
    $('open-group').focus();
  } catch (error) { showError(error); }
  finally { saving = false; $('reload').disabled = false; $('search').disabled = false; renderGroups(); }
});
$('search').addEventListener('input', renderGroups);
$('reload').addEventListener('click', loadGroups);
$('retry').addEventListener('click', () => channel ? loadGroups() : initialize());
$('another').addEventListener('click', () => {
  $('success').hidden = true;
  $('search').value = '';
  selected = null;
  loadGroups().then(() => $('search').focus());
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && event.target.tagName !== 'INPUT' && !$('picker').hidden) {
    event.preventDefault(); $('search').focus();
  }
});
initialize();
