# Note Learn helper (Chrome extension)

Sends the page you are reading to Note, so you can ask about it in the **Learn** panel and open each term in its own thread.

## Install (once)

1. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
2. Choose **Load unpacked** and pick this `extension` folder.
3. Pin **Note Learn helper** to the toolbar if you like.

## Use

1. Open a board in Note (signed in) in one tab.
2. On any web page, click the helper's toolbar button, press **Alt+Shift+N**, or right-click → **Send to Note Learn**. Select text first to send your selection too.
3. Note comes to the front with a 📄 page card selected. Double-click it, select words, and choose **Explain** or **Ask**. Each answer appears in connected notes to the right; repeat on any of them.

## What it reads and where it goes

- It reads a page only when you click it (Chrome's `activeTab` permission): the title, the address, up to 20,000 characters of visible text, and your selection.
- The page waits in this browser's extension storage until Note confirms it arrived, then it is deleted there. It is saved on your board like any note.
- When you ask, the page text goes to Google Gemini with your own key. Free-tier questions may be used by Google to improve its products, so do not send private or work pages.
- It talks only to the published Note (augustof2022.github.io/notes). To test a local copy, add its address to `matches` and `host_permissions` in `manifest.json` and to `NOTE_TABS` in `background.js`, then reload the extension.
- It cannot read `chrome://` pages, the Chrome Web Store, or PDFs opened in Chrome's viewer.