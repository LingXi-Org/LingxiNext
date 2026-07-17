from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRAPH = ROOT / "vendor" / "LingxiGraph"
PYPROJECT = ROOT / "pyproject.toml"


def run(*args: str, cwd: Path = ROOT, check: bool = True) -> str:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout.strip()


def latest_chainlit() -> str:
    with urllib.request.urlopen("https://pypi.org/pypi/chainlit/json", timeout=20) as response:
        payload = json.load(response)
    return str(payload["info"]["version"])


def remote_graph_sha() -> str:
    output = run("git", "ls-remote", "origin", "refs/heads/main", cwd=GRAPH)
    return output.split()[0]


def current_graph_sha() -> str:
    return run("git", "rev-parse", "HEAD", cwd=GRAPH)


def current_chainlit() -> str:
    match = re.search(r'"chainlit==([^";]+)"', PYPROJECT.read_text(encoding="utf-8"))
    if not match:
        raise RuntimeError("pyproject.toml must pin chainlit with ==")
    return match.group(1)


def apply_updates(graph_sha: str, chainlit_version: str) -> None:
    run("git", "fetch", "origin", "main", cwd=GRAPH)
    run("git", "checkout", "--detach", graph_sha, cwd=GRAPH)
    content = PYPROJECT.read_text(encoding="utf-8")
    content = re.sub(r'"chainlit==[^";]+"', f'"chainlit=={chainlit_version}"', content)
    PYPROJECT.write_text(content, encoding="utf-8", newline="\n")
    run("uv", "lock")
    run("uv", "sync", "--extra", "dev")
    run("uv", "run", "ruff", "check", "app", "scripts", "tests")
    run("uv", "run", "ruff", "format", "--check", "app", "scripts", "tests")
    run("uv", "run", "mypy", "app")
    run("uv", "run", "pytest", "-q")
    run("docker", "build", "--tag", "lingxinext-upstream-check", ".")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inspect or apply LingxiGraph and Chainlit updates"
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    graph_current, graph_remote = current_graph_sha(), remote_graph_sha()
    chainlit_current, chainlit_remote = current_chainlit(), latest_chainlit()
    report = {
        "lingxigraph": {"current": graph_current, "latest_main": graph_remote},
        "chainlit": {"current": chainlit_current, "latest_stable": chainlit_remote},
        "updates_available": graph_current != graph_remote or chainlit_current != chainlit_remote,
    }
    print(json.dumps(report, indent=2))
    if args.apply and report["updates_available"]:
        apply_updates(graph_remote, chainlit_remote)
        print("Upstreams updated and compatibility checks passed. Review and commit manually.")
    elif args.check and report["updates_available"]:
        sys.exit(2)


if __name__ == "__main__":
    main()
