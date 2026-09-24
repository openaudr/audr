"""Tests for tools/check_release.py, run as the release workflow runs it."""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "check_release.py"

PYPROJECT = """\
[project]
name = "audr-sink-example"
dynamic = ["version"]

[tool.hatch.version]
path = "src/audr_sink_example/_version.py"
"""


class CheckReleaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.package = pathlib.Path(self._tmp.name)
        (self.package / "pyproject.toml").write_text(PYPROJECT)
        (self.package / "src" / "audr_sink_example").mkdir(parents=True)

    def write(self, version_source: str, changelog: str) -> None:
        (self.package / "src" / "audr_sink_example" / "_version.py").write_text(version_source)
        (self.package / "CHANGELOG.md").write_text(changelog)

    def run_check(self, version: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.package), version],
            capture_output=True, text=True, check=False,
        )

    def test_matching_version_and_dated_section_passes(self) -> None:
        self.write('__version__ = "1.2.0"\n', "# Changelog\n\n## [1.2.0] - 2026-09-24\n")
        result = self.run_check("1.2.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ready to release 1.2.0", result.stdout)

    def test_pre_release_version_passes(self) -> None:
        self.write('__version__ = "1.2.0rc1"\n', "## [1.2.0rc1] - 2026-09-24\n")
        self.assertEqual(self.run_check("1.2.0rc1").returncode, 0)

    def test_version_mismatch_fails(self) -> None:
        self.write('__version__ = "1.1.0"\n', "## [1.2.0] - 2026-09-24\n")
        result = self.run_check("1.2.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("_version.py declares 1.1.0, the tag names 1.2.0", result.stderr)

    def test_missing_section_fails(self) -> None:
        self.write('__version__ = "1.2.0"\n', "## [Unreleased]\n\n## [1.1.0] - 2026-09-01\n")
        result = self.run_check("1.2.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("has no dated section for 1.2.0", result.stderr)

    def test_undated_section_fails(self) -> None:
        self.write('__version__ = "1.2.0"\n', "## [1.2.0]\n")
        self.assertEqual(self.run_check("1.2.0").returncode, 1)

    def test_section_for_a_longer_version_does_not_match(self) -> None:
        self.write('__version__ = "1.2.1"\n', "## [1.2.10] - 2026-09-24\n")
        self.assertEqual(self.run_check("1.2.1").returncode, 1)

    def test_version_dots_are_matched_literally(self) -> None:
        self.write('__version__ = "1.2.0"\n', "## [1x2y0] - 2026-09-24\n")
        self.assertEqual(self.run_check("1.2.0").returncode, 1)

    def test_both_failures_are_reported_together(self) -> None:
        self.write('__version__ = "1.1.0"\n', "## [Unreleased]\n")
        result = self.run_check("1.2.0")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.count("release check failed"), 2)

    def test_missing_version_assignment_fails(self) -> None:
        self.write("VERSION = '1.2.0'\n", "## [1.2.0] - 2026-09-24\n")
        result = self.run_check("1.2.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no __version__ assignment found", result.stderr)


if __name__ == "__main__":
    unittest.main()
