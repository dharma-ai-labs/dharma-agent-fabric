import { readFileSync } from 'node:fs';

const contracts = [
  {
    file: 'README.md',
    required: [
      'Copy setup instructions for my coding agent',
      'dharma bootstrap',
      'Manual browser-confirmed enrollment remains a fallback',
    ],
  },
  {
    file: 'docs/onboarding/customer-guide.md',
    required: [
      'Copy setup instructions for my coding agent',
      'dharma bootstrap',
      'Manual enrollment fallback',
      'stage: "complete"',
      'relay.state: "running"',
      'organizationApi.ready: true',
    ],
  },
  {
    file: 'packages/cli/README.md',
    required: [
      'Autonomous organization setup',
      'dharma bootstrap',
      'Manual enrollment',
      'stage: "complete"',
    ],
  },
];

const findings = [];

for (const contract of contracts) {
  const source = readFileSync(contract.file, 'utf8').replace(/\s+/g, ' ');
  for (const required of contract.required) {
    if (!source.includes(required)) findings.push(`${contract.file}: missing onboarding contract text: ${required}`);
  }
}

if (findings.length) {
  console.error('Onboarding documentation verification failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Onboarding documentation contract passed for ${contracts.length} public surfaces.`);
