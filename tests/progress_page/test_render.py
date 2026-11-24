import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / "services" / "progress-page"))

from progress.render import render


class RenderTest(unittest.TestCase):
    def fixture(self):
        states = ("OK", "ZERO", "STALE", "MISSING", "UNKNOWN", "NOT_APPLICABLE")
        return {
            "schema": "PROGRESS_REGISTRY_V1", "generated_at": "2026-11-26T09:07:02+08:00",
            "generator": {"commit": "0123456789ab", "host": "LINUX"},
            "registry_sha256": "a" * 64, "stale_banner_after_h": 3,
            "sections_by_state": {state: 1 for state in states},
            "sections": [{"key": f"S{i}", "title_zh": state, "state": state,
                          "reason": None if state in ("OK", "ZERO") else "WHY",
                          "as_of": "2026-11-26T00:00:00+08:00", "freshness": {"age_h": 9},
                          "sources": [], "data": ({"value": f"VALUE-{state}"} if state in ("OK", "ZERO", "STALE") else None)}
                         for i, state in enumerate(states)]
        }

    def test_states_no_leak_stale_marker_and_meta(self):
        html = render(self.fixture())
        for state in ("OK", "ZERO", "STALE", "MISSING", "UNKNOWN", "NOT_APPLICABLE"):
            self.assertIn(f'data-state="{state}"', html)
        self.assertNotIn("VALUE-MISSING", html)
        self.assertNotIn("VALUE-UNKNOWN", html)
        self.assertIn("VALUE-STALE", html)
        self.assertIn("过期", html)
        self.assertIn('<meta name="progress-page" content="PROGRESS_REGISTRY_V1">', html)
        self.assertIn("Date.now()", html)
        self.assertIn("stale_banner_after_h", html)

    def test_escapes_and_has_no_external_resources(self):
        reg = self.fixture()
        reg["sections"][0]["data"] = {"x": '<script>alert(1)</script> "quote"'}
        html = render(reg)
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;", html)
        for token in ('src="http', 'href="http', "@import"):
            self.assertNotIn(token, html)

    def test_s7_grouped_without_percentages_and_pure(self):
        reg = self.fixture()
        reg["sections"].append({"key": "S7_PLAN_SNAPSHOT", "title_zh": "计划冻结", "state": "OK", "reason": None, "as_of": None, "freshness": {}, "sources": [], "data": {"workplan": [{"key": "W", "track": "研究", "state": "进行中", "name": "名字"}], "focus": [], "milestones": []}})
        first = render(reg)
        self.assertEqual(first, render(reg))
        self.assertIn("11-25 冻结，之后不再更新", first)
        self.assertIn("研究", first)
        self.assertNotIn("%", first)


if __name__ == "__main__":
    unittest.main()
