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


if __name__ == "__main__":
    unittest.main()
