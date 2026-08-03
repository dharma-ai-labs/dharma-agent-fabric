# Source Basis and Architectural Differences

## Better Harness

Repository reviewed: `QoderAI/better-harness`.

Reusable strengths:

- provider-specific host adapters;
- workspace-qualified session evidence;
- configured asset inventory;
- evidence lanes kept separate;
- frozen evidence-bundle context;
- explicit partial and unavailable states;
- task-bounded findings;
- finding-bound repair topology;
- parser-safe CLI conventions;
- host support claims split by capability;
- MIT license.

Dharma additions:

- continuous relay daemon;
- encrypted raw local vault;
- adaptive deep remote sync;
- multi-tenant organization server;
- on-demand evidence expansion;
- server-initiated tasks;
- local and managed A2A;
- organization GitHub Skill repository;
- signed automatic Skill rollout;
- Failure Atlas and remediation package;
- managed and BYOK billing;
- MCP organization app.

Better Harness should remain a source of local evidence capability, not the authority for Dharma's server product, customer policy, billing, or release control.

## YC Paxel

Reference reviewed: `https://paxel.ycombinator.com/upload.sh` and associated public handling guidance.

Relevant pattern:

- analyze coding-agent sessions locally;
- reduce and structure evidence before upload;
- correlate session and repository evidence;
- avoid shipping every raw source file;
- send bounded derived material for server-side analysis.

Dharma difference:

- continuous rather than one-time upload;
- organization-controlled full-session reduced mode;
- local raw vault;
- exact server evidence requests;
- persistent bidirectional communication;
- remote task dispatch;
- automatic Skill remediation and rollout.

Paxel is inspiration, not an implementation dependency.

## Dharma current architecture

Relevant current boundaries:

- the organization control plane owns organization identity, access, billing, and developer-facing APIs;
- the Cognitive Integrity system owns evaluation, failure intelligence, remediation, release, and recovery;
- local provider credentials remain outside the server in BYOK mode;
- organization usage events must remain separate from CC-02 RAG and chat economics;
- claims must distinguish staged, production-path, customer-observed, and production-verified evidence.

## OpenAI plugin and app model

Official sources reviewed on 2026-08-03:

- `https://help.openai.com/en/articles/20001256-plugins-in-codex/`
- `https://help.openai.com/en/articles/11487775-apps-in-chatgpt`
- `https://help.openai.com/en/articles/12584461`

Current relevant principles:

- plugins can contain Skills and apps;
- apps connect external data and actions;
- source permissions still apply;
- admins can control read, write, confirmation, and access according to plan;
- Apps SDK is the recommended app packaging path;
- MCP-backed custom apps can be published to a workspace;
- public directory submission is possible.

Revalidate the exact manifest and submission contract at implementation time.
