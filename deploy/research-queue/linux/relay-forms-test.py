#!/usr/bin/python3
import importlib.util
import pathlib
import unittest


HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("q137_capture", HERE / "relay-capture-forms.py")
forms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forms)


class FormRefusalTest(unittest.TestCase):
    def test_only_two_exact_forms_are_in_the_producer_language(self):
        allowed = {forms.PUSH_FORM, forms.PULL_FORM}
        self.assertEqual(len(allowed), 2)
        mutations = set()
        for form in allowed:
            mutations.update({
                form + " ", form + " EXTRA", form + "\n", form.replace("rsync", "RSYNC", 1),
                form.replace(" . ", " ../ "), form.replace(" -log", " -slog"),
                form.replace(" -log", " --delete -log"), form.replace(" -log", " --remove-source-files -log"),
                form.replace("rsync --server", "scp"), form + ";id", form + "|cat",
            })
        mutations.update({
            forms.PUSH_FORM.replace("fact-packs/", "../fact-packs/"),
            forms.PUSH_FORM.replace("fact-packs/", "/var/lib/research-queue/inbox/fact-packs/"),
            forms.PUSH_FORM.replace("fact-packs/", "sibling/"),
            forms.PULL_FORM.replace("/var/lib/research-queue/outbox/", "/var/lib/research-queue/inbox/"),
            forms.PULL_FORM.replace(" --sender", ""),
        })
        self.assertTrue(mutations.isdisjoint(allowed))
        self.assertGreaterEqual(len(mutations), 20)
        for form in allowed:
            self.assertNotIn("--protect-args", form)
            self.assertNotIn(" -s", form)


if __name__ == "__main__":
    unittest.main()
