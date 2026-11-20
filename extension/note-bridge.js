// Runs only on Note. Hands a waiting page to the open board through
// window.postMessage on Note's own origin, and clears it once Note confirms.
(() => {
  const origin = location.origin;
  let sending = null;
  async function deliver() {
    const { notePage } = await chrome.storage.local.get('notePage');
    if (!notePage?.page) return;
    sending = notePage.id;
    window.postMessage({ type: 'note-learn-page', id: notePage.id, page: notePage.page }, origin);
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin) return;
    if (event.data?.type === 'note-learn-ready') deliver();
    if (event.data?.type === 'note-learn-received' && event.data.id === sending) { sending = null; chrome.storage.local.remove('notePage'); }
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.notePage?.newValue) deliver(); });
  deliver();
})();