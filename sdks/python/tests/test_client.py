import json
import unittest
from unittest.mock import patch

from dharma_agent_fabric import AgentFabricClient


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class AgentFabricClientTest(unittest.TestCase):
    def test_base_url_accepts_https_and_exact_loopback_hosts_only(self):
        AgentFabricClient("org", "token", "https://www.dharma-ai.io")
        AgentFabricClient("org", "token", "http://localhost:3000")
        AgentFabricClient("org", "token", "http://127.0.0.1:3000")
        with self.assertRaisesRegex(ValueError, "HTTPS or localhost"):
            AgentFabricClient("org", "token", "http://localhost.evil.example")
        with self.assertRaisesRegex(ValueError, "credential-free origin"):
            AgentFabricClient("org", "token", "https://user:pass@hq.dharma-ai.io")

    def test_byok_and_handoff_use_org_scoped_hq_routes(self):
        captured = []

        def fake_urlopen(request, timeout):
            captured.append((request, timeout))
            return _Response({"ok": True})

        client = AgentFabricClient("org Northstar", "dharma_org_test")
        with patch("dharma_agent_fabric.client.urlopen", fake_urlopen):
            client.verify_gcp_byok()
            client.dispatch_handoff({
                "sourceTaskId": "11111111-1111-4111-8111-111111111111",
                "targetEndpointId": "22222222-2222-4222-8222-222222222222",
                "requestedResponse": "proposal",
                "stateEnvelope": {"intent": "bounded help"},
            })

        self.assertEqual(captured[0][0].full_url, "https://www.dharma-ai.io/api/v1/orgs/org%20Northstar/agent-fabric/byok/gcp")
        self.assertEqual(json.loads(captured[0][0].data), {"action": "verify"})
        self.assertEqual(captured[1][0].headers["Authorization"], "Bearer dharma_org_test")

    def test_multimodal_managed_run_uses_hq_contract(self):
        captured = []

        def fake_urlopen(request, timeout):
            captured.append((request, timeout))
            return _Response({"ok": True, "runId": "run-1"})

        client = AgentFabricClient("org_northstar", "dharma_org_test")
        with patch("dharma_agent_fabric.client.urlopen", fake_urlopen):
            client.submit_managed_run({
                "agentId": "garment-appraisal",
                "prompt": "Estimate price from the supplied garment evidence.",
                "attachments": [{
                    "displayName": "garment-front.png",
                    "mimeType": "image/png",
                    "dataBase64": "iVBORw0KGgo=",
                    "sha256": f"sha256:{'a' * 64}",
                }],
            })

        request = captured[0][0]
        self.assertEqual(request.full_url, "https://www.dharma-ai.io/api/orgs/org_northstar/agent-runs")
        self.assertEqual(json.loads(request.data)["attachments"][0]["mimeType"], "image/png")
        self.assertNotIn("run.app", request.full_url)

    def test_action_decision_uses_hq_and_keeps_acknowledgement_device_only(self):
        captured = []

        def fake_urlopen(request, timeout):
            captured.append((request, timeout))
            return _Response({"ok": True, "decision": {"outcome": "release"}})

        client = AgentFabricClient("org_northstar", "dharma_org_test")
        with patch("dharma_agent_fabric.client.urlopen", fake_urlopen):
            client.request_action_decision({
                "evaluationContractId": "11111111-1111-4111-8111-111111111111",
                "task": {"taskId": "22222222-2222-4222-8222-222222222222"},
                "stateEnvelope": {"proposed_action": "apply_patch"},
                "evidenceReferences": [],
            })
            client.list_action_decisions()
            client.transition_evaluation_contract({
                "contractId": "11111111-1111-4111-8111-111111111111",
                "action": "activate",
                "confirmation": "ACTIVATE EVALUATION CONTRACT 11111111-1111-4111-8111-111111111111",
            })

        self.assertEqual(captured[0][0].full_url, "https://www.dharma-ai.io/api/v1/orgs/org_northstar/agent-fabric/decisions")
        self.assertEqual(captured[1][0].full_url, "https://www.dharma-ai.io/api/v1/orgs/org_northstar/agent-fabric/decisions")
        self.assertEqual(captured[2][0].full_url, "https://www.dharma-ai.io/api/v1/orgs/org_northstar/agent-fabric/evaluation-contracts")
        self.assertFalse(hasattr(client, "acknowledge_action_decision_enforcement"))

    def test_control_agent_messages_use_org_token_and_admin_decisions_use_portal_link(self):
        captured = []

        def fake_urlopen(request, timeout):
            captured.append((request, timeout))
            return _Response({"ok": True})

        client = AgentFabricClient("org_northstar", "dharma_org_test")
        with patch("dharma_agent_fabric.client.urlopen", fake_urlopen):
            client.list_control_agent_events("session / one", after_sequence=7)
            client.submit_control_agent_message("session / one", "Inspect the latest failures.")

        events_request = captured[0][0]
        self.assertEqual(
            events_request.full_url,
            "https://www.dharma-ai.io/api/v1/orgs/org_northstar/control-agent/sessions/session%20%2F%20one/events?afterSequence=7",
        )
        self.assertEqual(events_request.headers["Authorization"], "Bearer dharma_org_test")

        message_request = captured[1][0]
        self.assertEqual(json.loads(message_request.data), {"message": "Inspect the latest failures."})
        self.assertEqual(message_request.headers["Authorization"], "Bearer dharma_org_test")

        self.assertEqual(
            client.control_agent_decision_url("tool / one", "approve", "session / one"),
            "https://www.dharma-ai.io/portal/dashboard?orgId=org_northstar&controlAgent=open&toolCallId=tool+%2F+one&decision=approve&sessionId=session+%2F+one",
        )

    def test_control_agent_decision_url_rejects_unknown_decisions(self):
        client = AgentFabricClient("org_northstar", "dharma_org_test")
        with self.assertRaisesRegex(ValueError, "decision must be approve or reject"):
            client.control_agent_decision_url("tool-one", "execute")
        self.assertFalse(hasattr(client, "approve_control_agent_tool_call"))


if __name__ == "__main__":
    unittest.main()
