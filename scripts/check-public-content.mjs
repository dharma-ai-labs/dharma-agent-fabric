import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const prohibitedPaths = [
  [/^docs\/superpowers\//i, 'implementation plans belong in a private engineering repository'],
  [/^docs\/(?:internal|operations)\//i, 'internal and operations documentation is not public'],
  [/^docs\/(?:00-product-specification|01-system-architecture|02-repository-and-module-layout|13-host-adapter-plan|14-openai-plugin-and-app)\.md$/i, 'internal product and implementation planning is not public'],
  [/^docs\/onboarding\/(?!customer-guide\.md$).*(?:first-ga|production-launch|customer-specific).*\.md$/i, 'customer-specific launch guides are private'],
  [/^\.github\/workflows\/deploy-/i, 'production deployment workflows belong in the private control plane'],
];

const prohibitedPublicText = [
  [/\bDIA-\d+\b/g, 'private work-tracker identifier'],
  [/\borg_[A-Za-z0-9]{18,}\b/g, 'live organization identifier'],
];

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function privateTerms() {
  return String(process.env.DHARMA_PUBLIC_CONTENT_DENYLIST || '')
    .split(/[\n,]/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 3);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

const files = trackedFiles();
const findings = [];
const denylist = privateTerms();

for (const file of files) {
  const normalized = file.replaceAll('\\', '/');

  // Deleted but unstaged files can remain in git ls-files during local review.
  if (!existsSync(file)) continue;

  for (const [pattern, reason] of prohibitedPaths) {
    if (pattern.test(normalized)) findings.push(`${normalized}: ${reason}`);
  }

  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  const source = bytes.toString('utf8');

  for (const [pattern, reason] of prohibitedPublicText) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      findings.push(`${normalized}:${lineNumber(source, match.index || 0)}: ${reason}`);
    }
  }

  const lower = source.toLowerCase();
  for (const term of denylist) {
    let offset = lower.indexOf(term);
    while (offset !== -1) {
      findings.push(`${normalized}:${lineNumber(source, offset)}: private denylist match`);
      offset = lower.indexOf(term, offset + term.length);
    }
  }
}

if (findings.length > 0) {
  console.error('Public content boundary failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Public content boundary passed for ${files.length} tracked files.`);
