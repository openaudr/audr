"""Fail if a distribution's own version string is written into a tracked Markdown file.

Every package under ``adapters/*/python`` and ``sinks/*/python`` declares its version in the
file named by ``[tool.hatch.version].path``; every package under ``*/*/typescript`` declares
it in ``package.json``. That exact string may appear in the package's ``CHANGELOG.md`` and
nowhere else in Markdown: READMEs carry a PyPI or npm badge instead, so a release never
leaves a stale number behind. A line that must state a version for another
reason carries the marker ``<!-- version-ok -->``.
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKER = "<!-- version-ok -->"


def package_versions() -> dict[str, str]:
    """Map each package directory to the version it declares."""
    versions: dict[str, str] = {}
    for pyproject in sorted(ROOT.glob("*/*/python/pyproject.toml")):
        data = tomllib.loads(pyproject.read_text())
        version_path = data["tool"]["hatch"]["version"]["path"]
        source = (pyproject.parent / version_path).read_text()
        match = re.search(r'__version__\s*=\s*"([^"]+)"', source)
        if match is None:
            sys.exit(f"{pyproject.parent / version_path}: no __version__ assignment found")
        versions[str(pyproject.parent.relative_to(ROOT))] = match.group(1)
    for package_json in sorted(ROOT.glob("*/*/typescript/package.json")):
        version = json.loads(package_json.read_text())["version"]
        versions[str(package_json.parent.relative_to(ROOT))] = version
    return versions


def tracked_markdown() -> list[pathlib.Path]:
    out = subprocess.run(
        ["git", "ls-files", "--", "*.md", "**/*.md"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    return [ROOT / line for line in out.splitlines() if line]


def main() -> int:
    versions = package_versions()
    patterns = {
        pkg: re.compile(rf"(?<![\w.]){re.escape(v)}(?![\w.])") for pkg, v in versions.items()
    }
    offences: list[str] = []
    for path in tracked_markdown():
        if path.name == "CHANGELOG.md":
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            if MARKER in line:
                continue
            for pkg, pattern in patterns.items():
                if pattern.search(line):
                    rel = path.relative_to(ROOT)
                    offences.append(f"  {rel}:{lineno}: states {versions[pkg]} ({pkg})")
    if offences:
        print(f"{len(offences)} Markdown line(s) state a distribution version:")
        print("\n".join(offences))
        print("Use a PyPI or npm badge, or mark the line with", MARKER)
        return 1
    print(f"  no Markdown file states a distribution version ({', '.join(versions.values())})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
