<!-- BEGIN:review-severity-gate -->
## Review guidelines

These rules apply to every code review in this repository, whether Claude, Codex, another agent or a person does it. They also apply to every agent that acts on review findings.

- Rate each finding from 1 to 10 on how often it would happen in real use, and from 1 to 10 on how bad it would be. Report both scores and their product with the finding.
- Score severity 9–10 for exposed customer data or secrets, lost or corrupted data, wrong money movement, or production down.
- If the product is below 5, file the finding as an issue (Linear for Dharma work, otherwise this repository's issues) and leave the code alone. It does not block the merge.
- If the product is 5 or more, fix it in the change or block the merge on it.
- The threshold is 5 unless this file sets another value for this repository.

## Scope of changes

- Do not design for rare or future cases nobody asked about.
<!-- END:review-severity-gate -->
