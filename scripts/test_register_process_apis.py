import unittest
from types import SimpleNamespace
from register_process_apis import api_definitions, assert_existing_api, create_children, manifest_hash, RegistrationError


PLUGIN = "11111111-1111-1111-1111-111111111111"
API = "22222222-2222-2222-2222-222222222222"
CONTRACT = {"api": {"actions": ["rfd_RecordEmailProcessEvent", "rfd_GetEmailProcessState"]}}


class RegistrationTests(unittest.TestCase):
    def test_actions_have_explicit_string_contract_and_privileges(self):
        definitions = api_definitions(CONTRACT, PLUGIN, "prvReadProcess", "prvCreateEvent")
        self.assertEqual(definitions[0]["body"]["executeprivilegename"], "prvCreateEvent")
        self.assertEqual(definitions[1]["body"]["executeprivilegename"], "prvReadProcess")
        for definition in definitions:
            self.assertFalse(definition["body"]["isfunction"])
            self.assertFalse(definition["body"]["isprivate"])
            self.assertEqual(definition["body"]["allowedcustomprocessingsteptype"], 0)
            self.assertEqual(definition["request"]["type"], 10)
            self.assertEqual(definition["response"]["type"], 10)
            self.assertEqual(definition["body"]["PluginTypeId@odata.bind"], f"/plugintypes({PLUGIN})")

    def test_reject_duplicate_and_nonpublisher_names(self):
        for names in [["rfd_One", "rfd_One"], ["other_Action"]]:
            with self.assertRaises(RegistrationError):
                api_definitions({"api": {"actions": names}}, PLUGIN, "read", "write")

    def test_existing_api_drift_rejected(self):
        body = api_definitions(CONTRACT, PLUGIN, "read", "write")[0]["body"]
        actual = {**body, "_plugintypeid_value": PLUGIN}
        assert_existing_api(actual, body, PLUGIN)
        with self.assertRaises(RegistrationError):
            assert_existing_api({**actual, "isfunction": True}, body, PLUGIN)
        with self.assertRaises(RegistrationError):
            assert_existing_api({**actual, "_plugintypeid_value": API}, body, PLUGIN)

    def test_response_property_uses_correct_entity_set_and_readback(self):
        rows = {}
        requests = []
        def request(path, method, body):
            requests.append(path)
            table = "customapirequestparameter" if path.endswith("customapirequestparameters") else "customapiresponseproperty"
            rows[table] = [body]
        client = SimpleNamespace(records=SimpleNamespace(list=lambda table, **kwargs: rows.get(table, [])))
        definition = api_definitions(CONTRACT, PLUGIN, "read", "write")[0]
        create_children(client, SimpleNamespace(request=request), API, definition)
        self.assertEqual(requests, ["/api/data/v9.2/customapirequestparameters", "/api/data/v9.2/customapiresponseproperties"])
        create_children(client, SimpleNamespace(request=request), API, definition)
        self.assertEqual(len(requests), 2)

    def test_contract_digest_changes_with_api_scope(self):
        self.assertEqual(manifest_hash(CONTRACT), manifest_hash({"api": CONTRACT["api"]}))
        self.assertNotEqual(manifest_hash(CONTRACT), manifest_hash({"api": {"actions": ["rfd_Other"]}}))


if __name__ == "__main__":
    unittest.main()
