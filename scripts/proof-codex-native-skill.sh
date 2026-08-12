#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_BIN="${CODEX_BIN:-/usr/local/bin/codex}"
MISE_BIN="${MISE_BIN:-${HOME}/.local/bin/mise}"
NODE22_BIN="$("${MISE_BIN}" exec node@22 -- which node)"
SOURCE_CODEX_HOME="${SOURCE_CODEX_HOME:-${HOME}/.codex}"
PROOF_ROOT="${PROOF_ROOT:-$(mktemp -d /tmp/dharma-codex-skill-proof.XXXXXX)}"
PROOF_CODEX_HOME="${PROOF_ROOT}/codex-home"
WORKSPACE="${PROOF_ROOT}/workspace"
BIN_DIR="${PROOF_ROOT}/bin"

mkdir -p "${PROOF_CODEX_HOME}" "${WORKSPACE}/src" "${BIN_DIR}"
if [[ ! -f "${SOURCE_CODEX_HOME}/auth.json" ]]; then
  echo "Codex authentication is unavailable at ${SOURCE_CODEX_HOME}/auth.json." >&2
  exit 1
fi
cp "${SOURCE_CODEX_HOME}/auth.json" "${PROOF_CODEX_HOME}/auth.json"
ln -s "${ROOT}/packages/cli/dist/bin.js" "${BIN_DIR}/dharma"
chmod +x "${ROOT}/packages/cli/dist/bin.js"
printf '{}\n' > "${WORKSPACE}/package.json"
printf 'export const ready = true;\n' > "${WORKSPACE}/src/index.js"
git -C "${WORKSPACE}" init -q
git -C "${WORKSPACE}" config user.email proof@dharma-ai.io
git -C "${WORKSPACE}" config user.name "Dharma Proof"
git -C "${WORKSPACE}" add .
git -C "${WORKSPACE}" commit -qm init

CODEX_HOME="${PROOF_CODEX_HOME}" ROOT="${ROOT}" WORKSPACE="${WORKSPACE}" \
  "${MISE_BIN}" exec node@22 -- node --input-type=module -e '
    const module = await import("file://" + process.env.ROOT + "/packages/cli/dist/index.js");
    await module.installRepositoryAgentFabricSkill({
      workspace: process.env.WORKSPACE,
      hqUrl: "https://www.dharma-ai.io",
      organizationId: "org_proof",
      workspaceId: "workspace_proof",
      policyRevision: "proof-v1",
    });
    await module.materializeWorkspacePolicy({
      workspace: process.env.WORKSPACE,
      organizationId: "org_proof",
      revision: "proof-v1",
    });
    console.log(JSON.stringify(await module.installNativeAgentFabricBootstrap({
      provider: "codex",
      workspace: process.env.WORKSPACE,
      workspaceId: "workspace_proof",
      organizationId: "org_proof",
      hqUrl: "https://www.dharma-ai.io",
    }), null, 2));
  '

CODEX_HOME="${PROOF_CODEX_HOME}" PATH="$(dirname "${NODE22_BIN}"):${BIN_DIR}:${PATH}" \
  "${MISE_BIN}" exec node@22 -- node "${ROOT}/packages/cli/dist/index.js" \
  skills verify --provider codex --workspace "${WORKSPACE}"

CODEX_HOME="${PROOF_CODEX_HOME}" PATH="$(dirname "${NODE22_BIN}"):${BIN_DIR}:${PATH}" \
  "${CODEX_BIN}" exec --ignore-user-config --ephemeral --skip-git-repo-check \
  -C "${WORKSPACE}" -s read-only -o "${PROOF_ROOT}/codex-result.txt" \
  'Use the dharma-agent-fabric skill. Run its required local verification command, then answer with the skill name and whether verification passed. Do not access network services.' \
  > "${PROOF_ROOT}/codex-events.log" 2>&1

printf 'PROOF_ROOT=%s\n' "${PROOF_ROOT}"
printf 'RESULT_START\n'
sed -n '1,80p' "${PROOF_ROOT}/codex-result.txt"
printf 'RESULT_END\n'
find "${PROOF_CODEX_HOME}/skills/dharma-agent-fabric" -maxdepth 1 -type f -printf '%f\n' | sort
