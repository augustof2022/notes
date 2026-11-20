// Note Learn helper: reads the open page only when you click the toolbar
// button, the shortcut, or the right-click item (activeTab), keeps it in this
// browser's extension storage, and opens Note. Nothing is sent anywhere else.
const NOTE_URL = 'https://augustof2022.github.io/notes/';
const NOTE_TABS = ['https://augustof2022.github.io/notes/*', 'http://127.0.0.1:5173/*'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'note-learn', title: 'Send to Note Learn', contexts: ['page', 'selection'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => { if (tab) send(tab); });
chrome.action.onClicked.addListener(tab => send(tab));

function readPage() {
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 20000);
  return { title: document.title, url: location.href, text, selection: String(getSelection() || '').slice(0, 4000) };
}

async function send(tab) {
  if (!tab.id || !/^https?:/.test(tab.url || '')) return flag(tab.id, 'Only web pages can be sent to Note.');
  if (NOTE_TABS.some(pattern => new RegExp('^' + pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')).test(tab.url))) return flag(tab.id, 'This is Note itself.');
  let page;
  try { [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage }); }
  catch { return flag(tab.id, 'Chrome does not allow reading this page.'); }
  await chrome.storage.local.set({ notePage: { id: crypto.randomUUID(), page } });
  // Prefer the published Note over a local test copy.
  const [note] = [...await chrome.tabs.query({ url: NOTE_TABS[0] }), ...await chrome.tabs.query({ url: NOTE_TABS.slice(1) })];
  if (note?.id) { await chrome.tabs.update(note.id, { active: true }); await chrome.windows.update(note.windowId, { focused: true }); }
  else await chrome.tabs.create({ url: NOTE_URL });
  chrome.action.setBadgeText({ tabId: tab.id, text: '' });
}

function flag(tabId, message) {
  if (tabId) { chrome.action.setBadgeText({ tabId, text: '!' }); chrome.action.setTitle({ tabId, title: message }); }
}