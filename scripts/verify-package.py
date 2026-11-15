#!/usr/bin/env python3
"""Inspect a packed artifact, extract safely in a temporary directory, then smoke its modules.

Usage: python scripts/verify-package.py ARCHIVE [--node NODE]
No installation or application launch is performed. All subprocess streams are inherited.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

REQUIRED = {"lib/index.js", "lib/client.js", "package.json", "cordis.patch.yml", "NOTICE", "README.md", "LICENSE"}
ROOT_FILES = {"package.json", "cordis.patch.yml", "NOTICE", "README.md", "LICENSE", "screenshots.json"}
RELEASE_FILES = REQUIRED | {"docs/validation-2026-11-14-standalone.md", "docs/preview/reference-menu-2026-11-14.png", "screenshots.json"}
EXTENSIONS = {".js", ".mjs", ".cjs", ".ts", ".map", ".json", ".md", ".txt", ".yml", ".yaml", ".svg", ".css", ".html", ".png", ".jpg", ".jpeg", ".webp"}
SECRET_PATTERNS = [
    rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    rb"\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b",
    rb'''(?i)["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{24,}["']''',
    rb'''(?i)["']?(?:private[_-]?doc[_-]?id|doc[_-]?id)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']''',
]


class VerificationError(Exception):
    """A closed validation failed; diagnostics intentionally exclude payload contents."""


def require(condition, code):
    if not condition:
        raise VerificationError(code)


def safe_member(member):
    name = member.name
    require("\\" not in name and not name.startswith("/") and ":" not in name, "unsafe-archive-path")
    parts = name.rstrip("/").split("/")
    require(parts[0] == "package" and all(p not in {"", ".", ".."} for p in parts), "non-package-or-traversal-path")
    require(member.isdir() or member.isfile(), "non-regular-archive-member")
    require(not member.issym() and not member.islnk(), "archive-link")
    relative = "/".join(parts[1:])
    if not relative:
        require(member.isdir(), "package-root-not-directory")
        return relative
    lower = relative.lower()
    require(not any(p.lower() in {"node_modules", ".env", ".dsh", "profiles", "credentials", ".git", ".ssh", "tmp", "temp"} or p.lower().startswith(".env.") for p in parts[1:]), "private-or-unexpected-directory")
    require(relative == "screenshots.json" or not re.search(r"(?:screenshot|screen-shot|capture[-_]?\d|docid[-_]|credentials|node[-_]?install|install[-_]?node)", lower), "private-or-temporary-payload")
    if member.isfile():
        require(relative in RELEASE_FILES, "unexpected-release-payload")
        require(relative in ROOT_FILES or parts[1] in {"lib", "docs"}, "unexpected-root-payload")
        require(relative in ROOT_FILES or PurePosixPath(relative).suffix.lower() in EXTENSIONS, "unexpected-file-type")
        require(not lower.endswith((".exe", ".dll", ".node", ".sh", ".ps1", ".bat", ".cmd")), "executable-payload")
        require(member.size <= 64 * 1024 * 1024, "member-size-limit")
    else:
        require(relative in {"lib", "docs", "docs/preview"}, "unexpected-root-directory")
    return relative


def scan_private(data):
    # Parameter names such as sourceCode/token are not credentials. Match actual
    # credential formats or long literal assignments, including in sourcemaps.
    for pattern in SECRET_PATTERNS:
        require(re.search(pattern, data) is None, "private-data-pattern")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return
    # Sourcemap JSON escapes must not hide sensitive sourcesContent literals.
    if text.lstrip().startswith("{"):
        try:
            parsed = json.loads(text)
        except ValueError:
            return
        if isinstance(parsed, dict) and isinstance(parsed.get("sourcesContent"), list):
            for content in parsed["sourcesContent"]:
                if isinstance(content, str):
                    for pattern in SECRET_PATTERNS:
                        require(re.search(pattern, content.encode()) is None, "private-sourcemap-data-pattern")


def existing_target(root, target):
    require(isinstance(target, str) and target.startswith("./") and "\\" not in target and ":" not in target, "invalid-package-target")
    parts = target[2:].split("/")
    require(all(p not in {"", ".", ".."} for p in parts), "unsafe-package-target")
    resolved = (root / target).resolve()
    require(resolved.is_relative_to(root.resolve()) and resolved.is_file() and not resolved.is_symlink(), "missing-regular-package-target")


def export_targets(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from export_targets(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from export_targets(nested)
    else:
        require(value is None, "invalid-exports-value")


def check_manifest(root):
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    require(manifest.get("name") == "dsh-browser-context" and manifest.get("version") == "0.2.0", "unexpected-package-identity")
    require(manifest.get("type") == "module", "not-esm-package")
    require(manifest.get("private") is True, "unexpected-package-publication-mode")
    published = manifest.get("files")
    require(isinstance(published, list) and all(isinstance(item, str) for item in published), "invalid-files-manifest")
    require(len(published) == len(set(published)) and set(published) == RELEASE_FILES - {"package.json"}, "unexpected-files-manifest")
    for relative in published:
        existing_target(root, "./" + relative)
    for field in ("dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"):
        require(not manifest.get(field), "nonempty-runtime-dependencies")
    scripts = manifest.get("scripts", {})
    require(not any(k.lower() in {"preinstall", "install", "postinstall"} for k in scripts), "node-install-lifecycle-script")
    require(not manifest.get("bin"), "unexpected-package-bin")
    existing_target(root, manifest.get("main"))
    exports = manifest.get("exports")
    require(isinstance(exports, dict) and "." in exports and "./client" in exports, "missing-face-exports")
    for target in export_targets(exports):
        existing_target(root, target)
    dsh = manifest.get("dsh", {})
    existing_target(root, dsh.get("bundle", {}).get("patch"))
    client = dsh.get("client")
    require(isinstance(client, dict) and client.get("platform") == "web", "missing-web-client-metadata")
    # Current metadata uses ./client export; also verify an explicit client path if supplied.
    for key in ("entry", "path"):
        if key in client:
            existing_target(root, client[key])
    print("PASS manifest: empty runtime dependencies; regular internal Host/client/patch targets", flush=True)


def check_patch(root):
    text = (root / "cordis.patch.yml").read_text(encoding="utf-8")
    # Deliberately recognize only this complete minimal YAML grammar. Unknown
    # metadata, aliases, tags, duplicate fields, disable/update/replace all fail.
    lines = [line.rstrip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    pattern = (r"- insert:\n    - id: dsh-browser-context\n      name: dsh-browser-context\n"
               r"      config:\n        maxTextBytes: ([1-9][0-9]*)\n        maxImageBytes: ([1-9][0-9]*)\n"
               r"        subtitleRequestTimeoutMs: ([1-9][0-9]*)")
    match = re.fullmatch(pattern, "\n".join(lines))
    require(match is not None, "patch-not-exact-self-insert")
    require(all(int(v) <= 9007199254740991 for v in match.groups()[:2]), "patch-limit-not-safe-integer")
    require(int(match.group(3)) <= 2147483647, "patch-timeout-out-of-range")
    print("PASS patch: one self insert only; no core disable/override", flush=True)


def verify(archive, node):
    helper = Path(__file__).with_suffix(".mjs").resolve()
    require(helper.is_file(), "node-helper-missing")
    with tempfile.TemporaryDirectory(prefix="dsh-packed-") as temporary:
        destination = Path(temporary).resolve()
        with tarfile.open(archive, "r:gz") as packed:
            members = packed.getmembers()
            require(len(members) <= 10000, "member-count-limit")
            seen = set()
            validated = []
            total = 0
            for member in members:
                relative = safe_member(member)
                require(relative.casefold() not in seen, "duplicate-or-case-colliding-member")
                seen.add(relative.casefold())
                target = (destination / "package" / relative).resolve()
                require(target.is_relative_to(destination / "package"), "extraction-target-outside-package")
                if member.isfile():
                    total += member.size
                validated.append((member, target, relative))
            require(total <= 256 * 1024 * 1024, "archive-size-limit")
            regulars = {relative for member, _, relative in validated if member.isfile()}
            require(REQUIRED <= regulars, "required-payload-missing")
            for member, target, _ in validated:
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                source = packed.extractfile(member)
                require(source is not None, "unreadable-archive-member")
                with source:
                    data = source.read()
                scan_private(data)
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as output:
                    output.write(data)
        root = destination / "package"
        require(not (root / "node_modules").exists() and not (destination / "node_modules").exists(), "isolated-directory-has-node-modules")
        print(f"PASS payload: {len(regulars)} regular files; safe package-only extraction; private-data scan", flush=True)
        for relative in sorted(regulars):
            # Only already-validated package-local filenames, never host paths/content.
            print(f"  package/{relative}", flush=True)
        check_manifest(root)
        check_patch(root)
        environment = dict(os.environ)
        environment.pop("NODE_PATH", None)
        environment.pop("NODE_OPTIONS", None)
        result = subprocess.run([node, str(helper), str(root)], cwd=temporary, env=environment, check=False, timeout=60)
        require(result.returncode == 0, "node-module-smoke-failed")
    print("PASS temporary extraction cleaned; evidence excludes profile installation and real-page validation", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    node = args.node if Path(args.node).is_file() else shutil.which(args.node)
    try:
        require(node is not None, "node-runtime-unavailable")
        verify(args.archive, node)
    except (VerificationError, OSError, ValueError, tarfile.TarError, subprocess.TimeoutExpired) as error:
        code = str(error) if isinstance(error, VerificationError) else type(error).__name__
        print(f"FAIL packed verification: {code}; no installation/application was requested", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
