"""Verify the built adapter wheel installs and imports in isolation."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = ROOT / "dist"
CORE_DIR = ROOT.parents[2] / "adapters" / "core" / "python"

_BASE_CHECK = (
    "import sys; "
    "import audr_adapter_nemo_relay as adapter; "
    "assert 'nemo_relay' not in sys.modules; "
    "assert adapter.NeMoRelayConfig().to_dict()"
)
_RUNTIME_CHECK = (
    "import nemo_relay; "
    "import audr_adapter_nemo_relay as adapter; "
    "assert adapter.PLUGIN_KIND; "
    "print(adapter.__version__)"
)


def _find_wheel(dist_dir: Path) -> Path:
    wheels = sorted(dist_dir.glob("*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"expected exactly one wheel in {dist_dir}, found {wheels}")
    return wheels[0]


def _venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def verify_distribution(dist_dir: Path, core_dir: Path) -> None:
    """Install the adapter and sibling core wheels into a clean environment."""
    wheel = _find_wheel(dist_dir)
    with tempfile.TemporaryDirectory() as tmp:
        links = Path(tmp) / "links"
        subprocess.run(
            ["uv", "build", "--wheel", "--out-dir", str(links), str(core_dir)],
            check=True,
            capture_output=True,
        )
        venv_dir = Path(tmp) / ".venv"
        subprocess.run(["uv", "venv", str(venv_dir)], check=True, capture_output=True)
        python = _venv_python(venv_dir)
        subprocess.run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(python),
                "--find-links",
                str(links),
                str(wheel),
            ],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [str(python), "-c", _BASE_CHECK],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(python),
                "--find-links",
                str(links),
                f"{wheel}[runtime]",
            ],
            check=True,
            capture_output=True,
        )
        result = subprocess.run(
            [str(python), "-c", _RUNTIME_CHECK],
            check=True,
            capture_output=True,
            text=True,
        )
        print(result.stdout.strip())


def main() -> None:
    verify_distribution(DIST_DIR, CORE_DIR)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"verify_distribution failed: {exc}", file=sys.stderr)
        if isinstance(exc, subprocess.CalledProcessError):
            if exc.stdout:
                print(exc.stdout, file=sys.stderr)
            if exc.stderr:
                print(exc.stderr, file=sys.stderr)
        sys.exit(1)
