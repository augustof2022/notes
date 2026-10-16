# Note

A browser app for infinite canvas notes, with nested folders and screenshot pasting. Built for Renz’s desktop workflow and prepared for GitHub Pages.

Current release: **v0.2.1**. The app sidebar shows the installed version; About → Version updates contains the release history. Keep `package.json`, the root version in `package-lock.json`, and the version entries in `public/about.html` together when releasing.

## What works

- Infinite boards: text, images, drawing, shapes, arrows, pan and zoom using the MIT-licensed Excalidraw editor. Pen strokes use fixed pressure, and text mode stays active for consecutive notes.
- Board snapping: tap **Snap: Off → Elements → Grid → Off** in the canvas controls. Elements shows alignment guides and snaps nearby edges, centers, and spacing while dragging. Grid shows a visible grid and snaps placement to its cells. Tap the adjacent size button to adjust each board’s grid from 1–100 pixels (default 20); the mode and size are saved with the board. Existing items stay in place until moved. Pen strokes remain freehand.
- Diagram mode: visual presets for Chen ER, crow’s-foot ER, relational tables, business processes, organization charts, and mind maps. Selected nodes offer Add sibling, Add child, and Add connection; connectors support attachment sides, editable routes, cardinality markers, colors, and diagram-scoped themes.
- Paste screenshots directly with Ctrl+V, or drag an image onto the canvas.
- Nested folders with rename, move, drag into another folder, and recoverable Trash. Library sections have separate New folder and New board actions. Folders and boards sort independently by name (A–Z/Z–A), creation date, or last modification (newest/oldest); choices are remembered on the device and also order the sidebar.
- Folder-scoped search across board names, typed notes, recognized English image text, and reviewed handwriting text. Results jump to the matching element when the view is unlocked.
- Local autosave in IndexedDB, partitioned by account, plus Supabase sync when configured and signed in.
- Images stored in private Supabase Storage or a private Google Drive “Note images” folder. Supabase stores Drive file IDs and OCR text; image bytes are not embedded in cloud board JSON.
- Free local printed-text OCR with bundled Tesseract.js workers, WASM, and English language data. Pasted and downloaded images are indexed automatically; Read text lets you retry.
- The pen stroke-width panel replaces the three presets with a slider and numeric value, supporting 0.5–12 in steps of 0.5. New boards default to 1 for writing, with a Default reset button. Width applies to new strokes and any selected pen strokes.
- Lock zoom holds only the zoom percentage while allowing pan, drawing, selection, and search navigation. Two-finger movement pans by the fingers' center at the current scale; Ctrl/Cmd + scroll pans instead of zooming. Gesture movement is intercepted before the editor can shift the zoom anchor, and batched per frame. It is saved per board; older view locks now behave as zoom locks.
- Read text → Read handwriting groups selected pen strokes (or all handwriting) into lines. Recognize handwriting runs quantized TrOCR locally in a worker; review/edit the words and choose Save searchable text. The first use downloads about 90 MB from Hugging Face; model files use the browser cache. No board images are sent to the model host or a paid API. You can enter the searchable words manually without downloading the model.
- Installable PWA, light/dark appearance, PNG export, and portable workspace backups including images.
- Revision checks preserve a conflict copy when two devices edit the same item.

## Run

```sh
npm ci
npm run dev
```

Open the Local URL printed by Vite. The app works without cloud configuration; it saves to that browser. For a production build:

```sh
npm test
npm run build
npm run preview
```

The postinstall script copies fonts, OCR assets, the handwriting WASM runtime, and the database setup into `public/`. Generated assets are ignored by Git. Do not interrupt the first install while these assets are copying.

## Build a diagram

1. Open a board and choose **Diagrams**. Select a diagram system and a shape, then choose **Add** and tap the board to place it. Text editing opens immediately; type the label and click outside or press Escape to finish. Table names and column/key lists are editable text.
2. Select a diagram shape to show its four quick actions. **Add child** creates a connected node below that shape. **Add sibling** creates another node beside it with the same parent; its connection goes to that shared parent. Adding a sibling to a root creates another root. New nodes avoid existing diagram shapes, and the view pans to keep a new node visible.
3. **Edit shape** opens the palette for a selected node. Pick a shape from the same diagram system and choose **Apply … to selected shape** to keep the node’s text, colors, hierarchy, and connections. **Add child** and **Add sibling** first offer that system’s shapes when more than one is available, then add the chosen shape. Systems with one shape add it directly. **Add new …** places a separate diagram. Canvas object menus are hidden while the palette is open, including on mobile. Floating diagram actions also hide while the built-in mobile Edit panel is open and return when it closes.
4. **Add connection** starts a link to another diagram shape. Choose From and To sides, then tap the target. Connections back to earlier nodes are allowed and do not change parent/child relationships. Escape or Cancel stops placement or connecting.
5. Select a connection and choose **Line options** for its sides, straight/right-angle/curved route, endpoint symbols, weight, solid/dashed/dotted style, or a double line. **Edit bends** opens point editing for straight/curved connections; drag a middle segment of a right-angle connection to adjust its route. **Label** adds or edits connection text.
6. Open **Diagrams** with a shape or connection selected to change its colors and lines. A **Diagram theme** colors that connected diagram, leaving other diagrams and ordinary board content alone. Creating a new standalone shape starts a separate diagram; connecting two diagrams joins their theme scope. Exit diagram mode from the palette to hide its quick actions.

Shapes, text, hierarchy, and connection settings autosave with the board and are included in sync and backups. These are visual diagram templates; there is no database schema generation or strict notation validation.

## Connect cloud sync

This checkout is already configured for the browser-safe endpoint of your Supabase project, and its schema has been applied. Google sign-in needs the one-time provider setup below. Email accounts remain available as an alternative. The steps below also cover moving the app to another project.

1. Create or select a **free Supabase project**.
2. Run [`supabase/schema.sql`](supabase/schema.sql) in its SQL Editor. It creates account-isolated folders, boards, asset metadata, optimistic-save RPC, and a private image bucket. It is safe to rerun.
   For existing projects upgrading to v0.2.0, rerun this schema to add stable `created_at` values for folders and boards. New items retain their offline creation date when synced. Earlier releases did not record creation time, so older items use their earliest available saved timestamp; their exact original creation date cannot be recovered. The app remains compatible with the previous schema while you apply the update, but creation dates will not sync consistently between devices until it is applied.
3. Add the project URL and browser-safe publishable/anon key in the app’s Settings → Cloud sync. Alternatively set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at build time.
4. Set the site URL and redirect allowlist in Supabase Authentication → URL Configuration.
5. Choose **Continue with Google** after configuring the Google provider below. It creates or signs into your Note account and requests permission to store images in your own Drive. Alternatively choose Use email instead. Your Note account is separate from the Supabase dashboard account.
6. Sign in on another device to see your cloud boards. Automatic sync runs while the app is open every 20 seconds; Ctrl+S or the header status runs it immediately. Newly pasted images must finish uploading before a board is uploaded.

Device boards stay separate when signing in. Use Settings → Cloud sync → Copy this device’s boards into my account to migrate them intentionally. Signing out returns to the device workspace.

## Google Drive images

### Public Google sign-in branding

Public informational pages are served without sign-in or JavaScript: `about.html`, `privacy.html`, and `terms.html`. These pages identify Note, describe Google permissions and operator access, and provide the user-approved support contact. Privacy and terms are also linked in the app and sign-in dialog.

For this deployment, use app name **Note**, support email **renz.r.salvador@gmail.com**, homepage **https://augustof2022.github.io/notes/about.html**, privacy policy **https://augustof2022.github.io/notes/privacy.html**, and terms **https://augustof2022.github.io/notes/terms.html**. Keep the authorized domains `augustof2022.github.io` and `wrkoxjlzdeiffdtgbyvq.supabase.co`. Logo upload is optional; `public/icon-192.png` is the existing square Note icon. Save Branding before opening Audience → Publish app. If Google requests domain or brand verification, complete that separately; a saved form does not confirm verification or production status. Publishing public sign-in requires the app owner's confirmation.

The support address on these pages is public. Keep the policy accurate when changing storage, access, retention, or recognition behavior. Deletion requests are manual; Trash preserves records and files, and no automatic storage cleanup is implemented.

The **Continue with Google** button combines Supabase Google login and the `drive.file` permission. Each person uses their own Google account, and new image uploads go to that person's private “Note images” folder. No public file permissions or access links are created. Email login and Supabase image storage remain available.

This is a **one-time app owner setup**. People using Note do not need Google Cloud projects or client IDs:

1. In Google Cloud Console, enable **Google Drive API** in a project.
2. Configure Google Auth Platform with `openid`, `userinfo.email`, `userinfo.profile`, and `https://www.googleapis.com/auth/drive.file`. While the consent screen is in Testing, add each allowed Google account as a test user.
3. Create an **OAuth client → Web application**. Add the app origin (e.g. `https://augustof2022.github.io` and `http://127.0.0.1:5173`) to Authorized JavaScript origins. Add **`https://wrkoxjlzdeiffdtgbyvq.supabase.co/auth/v1/callback`** to Authorized redirect URIs. Use your own project's callback if moving projects.
4. In Supabase → Authentication → Sign In / Providers → Google, enable Google and enter the OAuth **client ID and client secret there**. Never put the client secret in Note settings, GitHub, frontend environment variables, or chat.
5. In Supabase Authentication → URL Configuration, allow the deployed Note URL, including its repository path (e.g. `https://augustof2022.github.io/notes/`). Local testing also needs `http://127.0.0.1:5173/`.
6. In Note, choose Continue with Google and grant permission for app-created Drive files. New uploads automatically use Google Drive. Use the same Google account on each device. For a personal-only app, you can disable new Supabase signups after creating your account; keep signups available if you intend other people to use their own accounts.

The app checks the Google identity before using a Drive connection and blocks image requests from another Note account. Google access tokens stay in memory; the stored Supabase session omits Google access and refresh tokens. Google may require reconnection after reloading Note or when its access token expires. Settings → Images & search always provides Reconnect Google Drive for a signed-in account, plus Retry uploads now and the actual upload error. A failed image upload holds the referencing board locally until the image and its metadata sync successfully. Supabase does not refresh Google's tokens. Images remain saved locally while uploads wait. A future server-side token refresh service would be needed for seamless long-lived Drive access.

Images are uploaded automatically to “Note images”. Switching providers affects new uploads; existing image references retain their provider. Do not delete or move images out of the app’s folder unless you have a complete backup. Files deliberately stay in storage when a board moves to Trash so restoration works; storage garbage collection is not included.

## GitHub Pages

The included `.github/workflows/pages.yml` builds, tests, and deploys on push to `main`.

1. Add source files to your repository. Never commit personal backups, board data, service-role keys, Google client secrets, or passwords.
2. Repository Settings → Pages → Source: **GitHub Actions**.
3. Optional repository **variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Google credentials are configured only in Supabase's provider settings.
4. Push to main or manually run “Publish Note”. The workflow sets the repository URL prefix automatically.

GitHub Free requires a public repository for Pages; a private repository requires a supported paid plan. The public app source contains no private board data. Supabase row-level security protects boards and image metadata; private storage policies protect image bytes.

## Shortcuts

| Action | Shortcut |
|---|---|
| Find across boards | Ctrl+K |
| New board | Ctrl+Alt+N |
| New folder | Ctrl+Alt+Shift+N |
| Save / sync | Ctrl+S |
| Rename open board | F2 |
| Paste image / text | Ctrl+V |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Duplicate selected object | Ctrl+D |
| Add text | T |
| Pan | Space+drag |
| Zoom | Ctrl+scroll |
| Shortcut guide | ? |

Cmd replaces Ctrl on Mac. Browser-reserved Ctrl+N and Ctrl+Shift+N are avoided.

## Backups and limits

Export in Settings → Preferences & backup before clearing browser data. Exports download all referenced image files; reconnect Google Drive first if required. Import creates new boards rather than replacing current ones. Backups contain private content; keep them outside the source repository.

Image OCR recognizes printed English text; small screenshots and low contrast can be inaccurate. Handwriting uses the free [TrOCR small handwritten model](https://huggingface.co/Xenova/trocr-small-handwritten), designed for single lines, and needs review. This app does not reproduce Nebo’s proprietary handwriting recognition. Re-read after editing pen strokes; stale handwriting indexes are excluded from search. Recognition is an explicit action so phones do not download or run the handwriting model while writing. Offline use requires a successful first production load so the service worker can cache the editor and OCR assets. External sign-in and cloud sync need internet. The PWA uses update prompts, so an update will not silently reload an active editor.

Cloud sync is personal-device sync, not real-time multi-user collaboration. Supabase free quotas and Google Drive account storage limits apply. Image deletion and storage reclamation are intentionally not automated. Search scans the loaded account’s board content and OCR metadata on-device; large libraries will eventually need server-side search.

## Validation

`npm test` also covers constant pen pressure, sticky text mode, zoom-only locking with pan, numeric pen widths, upload retry and failure reporting, handwriting scoping and stale indexes, OCR deduplication/retries and failures. It covers recursive folder scoping, typed and OCR search, deleted items, account separation, Trash, conflict preservation, SQL access policies, Google token storage, Google identity matching, declined Drive permission, expiry, and account switching. `npm run build` type-checks and generates the production site. Google OAuth must be enabled with the app owner's credentials before live sign-in and Drive uploads can be validated.
