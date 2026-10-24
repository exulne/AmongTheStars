// Turns dist/index.html (a full document) into the artifact page format:
// title + meta + style + body markup + inline scripts, no html/head/body wrappers.
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
const styles = head.match(/<style[\s\S]*?<\/style>/g) ?? [];
const scripts = head.match(/<script[\s\S]*?<\/script>/g) ?? [];
const out = [
  title,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  ...styles,
  body,
  ...scripts,
].join('\n');
writeFileSync('dist/artifact.html', out);
console.log(`artifact.html ${(out.length / 1024).toFixed(0)} KB`);
