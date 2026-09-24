"""Fail unless a package is ready to be released at a given version.

A release tag ``<distribution>/v<version>`` is valid only when the package's
``_version.py`` (the file named by ``[tool.hatch.version].path``) declares that version
and its ``CHANGELOG.md`` holds a dated section for it, ``## [<version>] - YYYY-MM-DD``.

Usage: ``python tools/check_release.py <package-dir> <version>``
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
import tomllib


def declared_version(package: pathlib.Path) -> str:
    data = tomllib.loads((package / "pyproject.toml").read_text())
    version_file = package / data["tool"]["hatch"]["version"]["path"]
    match = re.search(r'__version__\s*=\s*"([^"]+)"', version_file.read_text())
    if match is None:
        sys.exit(f"{version_file}: no __version__ assignment found")
    return match.group(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("package", type=pathlib.Path, help="package directory")
    parser.add_argument("version", help="version being released, without the leading v")
    args = parser.parse_args()

    errors: list[str] = []
    declared = declared_version(args.package)
    if declared != args.version:
        errors.append(f"_version.py declares {declared}, the tag names {args.version}")

    heading = rf"^## \[{re.escape(args.version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$"
    changelog = args.package / "CHANGELOG.md"
    if not re.search(heading, changelog.read_text(), re.MULTILINE):
        errors.append(f"{changelog} has no dated section for {args.version}")

    if errors:
        sys.exit("\n".join(f"release check failed: {error}" for error in errors))
    print(f"{args.package}: ready to release {args.version}")


if __name__ == "__main__":
    main()
