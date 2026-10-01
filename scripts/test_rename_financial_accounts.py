import copy
import unittest

import rename_financial_accounts as rename


PRODUCT_ID = "11111111-1111-1111-1111-111111111111"
FIRST_ID = "22222222-2222-2222-2222-222222222222"
SECOND_ID = "33333333-3333-3333-3333-333333333333"
CUSTOMER_ID = "44444444-4444-4444-4444-444444444444"


def fixture_row(key=FIRST_ID):
    return {
        rename.ID: key,
        rename.NAME: "Diamond Everyday Current - DEMO-CUST-0001",
        "rfd_holdingnumber": "DEMO-HLD-0001-01",
        "rfd_producttype": 100000000,
        "rfd_accountnumber": "00002047",
        "rfd_cardlastfour": None,
        "_rfd_productid_value": PRODUCT_ID,
        "_rfd_customerid_value": CUSTOMER_ID,
        "_rfd_linkedfinancialaccountid_value": None,
        "statecode": 0,
        "statuscode": 1,
        "versionnumber": 1,
    }


class FakeClient:
    def __init__(self, rows):
        self.rows = {row[rename.ID]: copy.deepcopy(row) for row in rows}
        self.products = {PRODUCT_ID: "Demo Diamond Everyday Current"}
        self.records = self
        self.calls = []
        self.skills = []
        self.reads = 0
        self.before_read = None
        self.fail_on_call = None

    def list(self, table, **kwargs):
        if table == rename.TABLE:
            self.reads += 1
            if self.before_read:
                self.before_read(self)
            return copy.deepcopy(list(self.rows.values()))
        if table == "product":
            return [{"productid": key, "name": value} for key, value in self.products.items()]
        raise AssertionError("Unexpected table read.")

    def writer(self, skill):
        self.skills.append(skill)
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def update(self, table, ids, changes):
        self.calls.append((table, ids, copy.deepcopy(changes)))
        if self.fail_on_call == len(self.calls):
            raise RuntimeError("Simulated partial SDK failure.")
        if table != rename.TABLE or len(ids) != len(changes):
            raise AssertionError("Unexpected update scope.")
        for key, payload in zip(ids, changes):
            if set(payload) != {rename.NAME}:
                raise AssertionError("A protected field was included in an update.")
            self.rows[key].update(payload)
            self.rows[key]["versionnumber"] += 1


class NamingTests(unittest.TestCase):
    def test_catalogue_brand_and_current_account(self):
        row = fixture_row()
        self.assertEqual(
            rename.target_name(row, {PRODUCT_ID: "Demo Diamond Everyday Current"}, 200),
            "Gravity Everyday Current Account ending 2047",
        )

    def test_card_suffix_is_preferred_to_account_number(self):
        row = fixture_row()
        row.update({
            rename.NAME: "Diamond Visa Debit Card - DEMO-CUST-0001",
            "rfd_producttype": 100000006, "rfd_cardlastfour": "4821",
        })
        self.assertEqual(
            rename.target_name(row, {PRODUCT_ID: "Demo Diamond Visa Debit Card"}, 200),
            "Gravity Visa Debit Card ending 4821",
        )

    def test_mortgage_system_reference_is_not_a_bank_suffix(self):
        row = fixture_row()
        row.update({
            rename.NAME: "Diamond Repayment Mortgage - DEMO-HLD-0001-01",
            "rfd_producttype": 100000003, "rfd_accountnumber": "MTG-0001",
        })
        self.assertEqual(
            rename.target_name(row, {PRODUCT_ID: "Demo Diamond Repayment Mortgage"}, 200),
            "Gravity Repayment Mortgage",
        )

    def test_missing_reference_has_no_invented_suffix(self):
        row = fixture_row()
        row["rfd_accountnumber"] = None
        self.assertEqual(
            rename.target_name(row, {PRODUCT_ID: "Demo Diamond Everyday Current"}, 200),
            "Gravity Everyday Current Account",
        )

    def test_missing_product_uses_cleaned_source(self):
        row = fixture_row()
        row["_rfd_productid_value"] = None
        self.assertEqual(
            rename.target_name(row, {}, 200),
            "Gravity Everyday Current Account ending 2047",
        )

    def test_already_named_record_is_idempotent(self):
        row = fixture_row()
        row[rename.NAME] = "Gravity Everyday Current Account ending 2047"
        self.assertEqual(
            rename.target_name(row, {PRODUCT_ID: "Demo Diamond Everyday Current"}, 200),
            row[rename.NAME],
        )

    def test_source_name_disagreement_fails_closed(self):
        row = fixture_row()
        row[rename.NAME] = "Diamond Unrelated Product - DEMO-CUST-0001"
        with self.assertRaises(rename.PlanError):
            rename.target_name(row, {PRODUCT_ID: "Demo Diamond Everyday Current"}, 200)

    def test_max_length_is_enforced(self):
        with self.assertRaises(rename.PlanError):
            rename.target_name(fixture_row(), {PRODUCT_ID: "Demo Diamond Everyday Current"}, 20)

    def test_invalid_card_suffix_fails_closed(self):
        row = fixture_row()
        row.update({"rfd_producttype": 100000006, "rfd_cardlastfour": "821"})
        with self.assertRaises(rename.PlanError):
            rename.existing_suffix(row)


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient([fixture_row(), fixture_row(SECOND_ID)])
        rows, products = rename.read_snapshot(self.client)
        self.plan = rename.prepare_plan(rows, products, 200)
        self.targets = rename.validate_plan(self.plan, 200, self.plan["sha256"])

    def apply_fake(self, selected=None, batch_size=25):
        return rename.apply_plan(
            self.client, self.client.writer, self.plan, self.targets, 200,
            set(self.targets) if selected is None else selected, batch_size,
        )

    def test_plan_has_only_target_fields_and_no_full_numbers(self):
        for target in self.plan["records"]:
            self.assertEqual(set(target), {"record_id", "new_name"})
        encoded = rename.json.dumps(self.plan)
        self.assertNotIn("00002047", encoded)
        self.assertNotIn(CUSTOMER_ID, encoded)
        self.assertNotIn("DEMO-CUST-0001", encoded)
        self.assertNotIn("DEMO-HLD-0001-01", encoded)

    def test_modified_preview_rejects_original_approved_hash(self):
        changed = copy.deepcopy(self.plan)
        changed["records"][0]["new_name"] = "Gravity Different Account"
        with self.assertRaises(rename.PlanError):
            rename.validate_plan(changed, 200, self.plan["sha256"])

    def test_only_names_are_updated_and_second_run_has_no_writes(self):
        protected = {
            key: {field: row[field] for field in rename.PROTECTED_FIELDS}
            for key, row in self.client.rows.items()
        }
        self.assertEqual(self.apply_fake(), {"selected": 2, "updated": 2, "verified": 2})
        self.assertEqual(self.client.skills, ["dv-data"])
        self.assertEqual(len(self.client.calls), 1)
        for key, row in self.client.rows.items():
            self.assertEqual({field: row[field] for field in rename.PROTECTED_FIELDS}, protected[key])
        self.assertEqual(self.apply_fake()["updated"], 0)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(self.client.skills, ["dv-data"])

    def test_surgical_apply_leaves_unselected_name(self):
        other = self.client.rows[SECOND_ID][rename.NAME]
        self.assertEqual(self.apply_fake({FIRST_ID})["updated"], 1)
        self.assertEqual(self.client.rows[SECOND_ID][rename.NAME], other)

    def test_surgical_guid_must_belong_to_plan(self):
        with self.assertRaises(rename.PlanError):
            self.apply_fake({CUSTOMER_ID})
        self.assertEqual(self.client.calls, [])

    def test_same_suffix_but_changed_account_number_is_rejected(self):
        self.client.rows[FIRST_ID]["rfd_accountnumber"] = "99992047"
        with self.assertRaises(rename.PlanError):
            self.apply_fake()
        self.assertEqual(self.client.calls, [])

    def test_source_name_drift_is_rejected(self):
        self.client.rows[FIRST_ID][rename.NAME] = "Manually Changed Name"
        with self.assertRaises(rename.PlanError):
            self.apply_fake()
        self.assertEqual(self.client.calls, [])

    def test_relationship_drift_is_rejected(self):
        self.client.rows[FIRST_ID]["_rfd_customerid_value"] = SECOND_ID
        with self.assertRaises(rename.PlanError):
            self.apply_fake()
        self.assertEqual(self.client.calls, [])

    def test_catalogue_label_drift_is_rejected(self):
        self.client.products[PRODUCT_ID] = "Demo Gravity Everyday Current"
        with self.assertRaises(rename.PlanError):
            self.apply_fake()
        self.assertEqual(self.client.calls, [])

    def test_row_count_or_guid_drift_is_rejected(self):
        self.client.rows.pop(SECOND_ID)
        with self.assertRaises(rename.PlanError):
            self.apply_fake()
        self.assertEqual(self.client.calls, [])

    def test_pending_version_change_is_rejected_before_write(self):
        read_count = self.client.reads

        def concurrent_change(client):
            if client.reads == read_count + 2:
                client.rows[FIRST_ID]["versionnumber"] += 1

        self.client.before_read = concurrent_change
        with self.assertRaises(rename.PlanError):
            self.apply_fake()
        self.assertEqual(self.client.calls, [])

    def test_partial_sdk_failure_can_resume_same_plan(self):
        self.client.fail_on_call = 2
        with self.assertRaises(RuntimeError):
            self.apply_fake(batch_size=1)
        self.assertEqual(self.client.rows[FIRST_ID][rename.NAME], self.targets[FIRST_ID])
        self.client.fail_on_call = None
        self.assertEqual(self.apply_fake(batch_size=1)["updated"], 1)
        self.assertEqual(self.apply_fake()["updated"], 0)

    def test_server_did_not_apply_name_is_detected(self):
        self.client.update = lambda *args: None
        with self.assertRaises(rename.PlanError):
            self.apply_fake()


if __name__ == "__main__":
    unittest.main()
