from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, Callable, NotRequired, TypedDict
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


@dataclass
class AgentFabricError(Exception):
    status: int
    code: str
    message: str
    correlation_id: str | None = None

    def __str__(self) -> str:
        return self.message


class AgentFabricImageAttachment(TypedDict):
    displayName: str
    mimeType: str
    dataBase64: str
    sha256: str


class AgentFabricManagedRun(TypedDict):
    agentId: str
    prompt: str
    attachments: NotRequired[list[AgentFabricImageAttachment]]
    metadata: NotRequired[dict[str, Any]]
    maxRuntimeSeconds: NotRequired[int]
    estimatedCredits: NotRequired[int]


class AgentFabricClient:
    def __init__(
        self,
        organization_id: str,
        token: str | Callable[[], str],
        base_url: str = "https://www.dharma-ai.io",
        timeout_seconds: float = 30.0,
    ) -> None:
        if not organization_id.strip():
            raise ValueError("organization_id is required")
        parsed_base_url = urlparse(base_url)
        localhost_http = parsed_base_url.scheme == "http" and parsed_base_url.hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed_base_url.scheme != "https" and not localhost_http:
            raise ValueError("base_url must be HTTPS or localhost")
        if not parsed_base_url.hostname or parsed_base_url.username or parsed_base_url.password or parsed_base_url.query or parsed_base_url.fragment:
            raise ValueError("base_url must be a credential-free origin")
        self.organization_id = organization_id
        self._encoded_organization_id = quote(organization_id, safe="")
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def _token(self) -> str:
        value = self.token() if callable(self.token) else self.token
        if not value.strip():
            raise ValueError("token resolver returned an empty token")
        return value

    def _org_path(self, path: str) -> str:
        return f"/api/v1/orgs/{self._encoded_organization_id}/agent-fabric{path}"

    def _managed_path(self, path: str) -> str:
        return f"/api/orgs/{self._encoded_organization_id}{path}"

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if not path.startswith("/"):
            raise ValueError("path must start with /")
        mutation = method.upper() not in {"GET", "HEAD", "OPTIONS"}
        headers = {"Authorization": f"Bearer {self._token()}", "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if mutation:
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        request = Request(f"{self.base_url}{path}", data=data, headers=headers, method=method.upper())
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                payload = {}
            details = payload.get("error", payload)
            raise AgentFabricError(
                status=error.code,
                code=str(details.get("code", "agent_fabric_request_failed")),
                message=str(details.get("message", f"Request failed with status {error.code}.")),
                correlation_id=details.get("correlationId"),
            ) from error

    def onboarding(self) -> dict[str, Any]:
        return self.request("GET", self._org_path("/onboarding"))

    def start_onboarding(self, company_name: str, runtime_mode: str, **options: Any) -> dict[str, Any]:
        return self.request("POST", self._org_path("/onboarding"), {
            "companyName": company_name,
            "runtimeMode": runtime_mode,
            **options,
        })

    def advance_onboarding(self) -> dict[str, Any]:
        return self.request("POST", self._org_path("/onboarding"), {"action": "advance"})

    def gcp_byok(self) -> dict[str, Any]:
        return self.request("GET", self._org_path("/byok/gcp"))

    def configure_gcp_byok(self, configuration: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self._org_path("/byok/gcp"), {**configuration, "action": "configure"})

    def verify_gcp_byok(self) -> dict[str, Any]:
        return self.request("POST", self._org_path("/byok/gcp"), {"action": "verify"})

    def dispatch_task(self, task: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self._org_path("/tasks"), task)

    def list_tasks(self) -> dict[str, Any]:
        return self.request("GET", self._org_path("/tasks"))

    def list_action_decisions(self) -> dict[str, Any]:
        return self.request("GET", self._org_path("/decisions"))

    def request_action_decision(self, decision: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self._org_path("/decisions"), decision)

    def dispatch_handoff(self, handoff: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self._org_path("/conversations"), handoff)

    def list_handoffs(self) -> dict[str, Any]:
        return self.request("GET", self._org_path("/conversations"))

    def request_analysis(self, analysis: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self._org_path("/evals"), analysis)

    def list_evaluation_contracts(self) -> dict[str, Any]:
        return self.request("GET", self._org_path("/evaluation-contracts"))

    def transition_evaluation_contract(self, transition: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self._org_path("/evaluation-contracts"), transition)

    def submit_managed_run(self, run: AgentFabricManagedRun) -> dict[str, Any]:
        return self.request("POST", self._managed_path("/agent-runs"), run)

    def get_managed_run(self, run_id: str) -> dict[str, Any]:
        return self.request("GET", self._managed_path(f"/agent-runs/{quote(run_id, safe='')}"))

    def get_managed_run_events(self, run_id: str) -> dict[str, Any]:
        return self.request("GET", self._managed_path(f"/agent-runs/{quote(run_id, safe='')}/events"))

    def create_managed_agent(self, agent: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self._managed_path("/managed-agents"), agent)

    def create_managed_eval(self, campaign: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self._managed_path("/managed-evals/campaigns"), campaign)

    def list_managed_traces(self) -> dict[str, Any]:
        return self.request("GET", self._managed_path("/managed-traces"))

    def list_remediation_candidates(self) -> dict[str, Any]:
        return self.request("GET", self._managed_path("/managed-remediation/candidates"))

    def usage(self) -> dict[str, Any]:
        return self.request("GET", self._org_path("/usage"))
