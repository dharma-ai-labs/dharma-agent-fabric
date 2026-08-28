# Public documentation boundary

This repository contains the open Agent Fabric edge: installable packages,
versioned contracts, provider adapters, local security controls, and public
integration documentation. It is not the system of record for customer
delivery, production operations, commercial policy, or Dharma's private
control plane.

## Public material

- package installation and command reference;
- public API and schema contracts;
- provider capability statements backed by released tests;
- local vault, task-authority, privacy, and threat-model boundaries;
- generic onboarding examples using placeholders;
- contribution, test, release, license, and upstream-attribution guidance.

## Private material

- customer names, organization identifiers, repositories, traffic, incidents,
  launch procedures, evidence, results, usage, pricing, and support history;
- private work-tracker identifiers and internal implementation plans;
- production project, service-account, federation, deployment, rollback, and
  incident-response runbooks;
- proprietary evaluation logic, hidden truth, internal data models, commercial
  policy, cost structure, margins, and sales plans;
- credentials, private endpoints, correlation receipts, or screenshots from
  authenticated systems.

Customer delivery belongs in the customer's private control repository.
Engineering and operations material belongs in the private platform
repository. Canonical doctrine belongs in the governed truth repository.

## Enforcement

`npm run public:content:check` rejects prohibited paths and common private
identifiers. Repository CI also receives a private denylist through the
`DHARMA_PUBLIC_CONTENT_DENYLIST` secret; matches report only file and line, not
the protected term.

Reviewers must classify every new document before merge. Moving a file out of
the current branch does not erase it from Git history. Any historical
redaction requires a separately approved inventory, archive, history rewrite,
tag and release review, force-push window, and consumer migration plan.
