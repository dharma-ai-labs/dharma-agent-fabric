// Submission-time check for the ChatGPT app package. Run it on the substituted
// copy that is pasted into the OpenAI form, never on the committed package:
//
//   node scripts/openai-app-submission-filled.mjs <substituted-copy.json>
//
// It exits 1 and names every string field that still holds a placeholder
// ({{NAME}}, or a bare REVIEWER_* name left after removing the braces), exits 2
// on bad usage or an unreadable file, and prints {"ok":true,"placeholders":0}
// otherwise. No network, and no values are printed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLACEHOLDER = /\{\{\s*[A-Za-z0-9_]+\s*\}\}|\bREVIEWER_[A-Z0-9_]+\b/g;

function* stringFields(value, path) {
  if (typeof value === 'string') {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* stringFields(item, `${path}[${index}]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* stringFields(item, path ? `${path}.${key}` : key);
  }
}

const args = process.argv.slice(2);
if (args.length !== 1 || !/\.json$/i.test(args[0])) {
  process.stderr.write('Usage: openai-app-submission-filled.mjs <substituted-copy.json>\n');
  process.exit(2);
}

let submission;
try {
  submission = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
} catch {
  process.stderr.write('submission_unreadable\n');
  process.exit(2);
}

const found = [];
for (const [path, text] of stringFields(submission, '')) {
  for (const match of text.matchAll(PLACEHOLDER)) found.push(`${match[0]} at ${path}`);
}

if (found.length > 0) {
  process.stderr.write(`not ready to submit: ${found.length} unsubstituted placeholder(s). Fill them from the private seed receipt.\n`);
  for (const line of found) process.stderr.write(`  ${line}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ ok: true, placeholders: 0 })}\n`);
