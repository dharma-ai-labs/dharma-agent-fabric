# Repo-local Agent Skills

`.agents/skills/` is for repo-local host skills, host wrappers, and generated
mirrors. It is not the canonical home for shared workflows; put those in root
`skills/`.

Each direct skill directory uses `SKILL.md` as its entrypoint. Keep host-only
logic local, make wrappers point to their canonical root `skills/` owner in
their instructions, and document generated-file ownership beside the generator.
A separate `mirror.json` sidecar is not part of this repository's contract.
