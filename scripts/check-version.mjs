import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const { version } = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));

if (!version || lock.version !== version || lock.packages?.['']?.version !== version) {
  throw new Error('Keep the root version in package.json and package-lock.json in sync.');
}

// These pages deliberately work without JavaScript. Keep their current-version
// labels in sync with the package metadata used by the app, and update the
// current release notes when bumping that version. Historical entries are plain text.
for (const path of ['public/about.html', 'public/updates.html']) {
  const page = await read(path);
  const labels = [...page.matchAll(/<span data-app-version>([^<]+)<\/span>/g)];
  if (!labels.length || labels.some(([, value]) => value.trim() !== version)) {
    throw new Error(`Update the data-app-version labels and current release notes in ${path} to match package.json (${version}).`);
  }
}

console.log(`Note ${version}: app and About page versions match.`);
