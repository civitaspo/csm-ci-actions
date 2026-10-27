"""Mutation-check each E2E PR metadata rejection guard in an isolated checkout."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
bun = shutil.which("bun")
if not bun:
    raise RuntimeError("put the mise.toml Bun version on PATH")
mutations = [
    ("generated title", "e2e/pr-metadata.ts", "if (actual.title !== expected.title)", "if (false)"),
    ("generated body", "e2e/pr-metadata.ts", "if (actual.body !== expected.body)", "if (false)"),
    ("missing case", "e2e/harness.ts", "assert(intent, `missing PR case", "assert(true, `missing PR case"),
    ("managed ownership", "e2e/pr-metadata.ts", "if (owned?.pull?.number !== expected)", "if (false)"),
    ("one missing delimiter", "e2e/pr-metadata.ts", "start === -1 && end === -1", "start === -1 || end === -1"),
    ("missing start delimiter", "e2e/pr-metadata.ts", "start === -1 || end < start", "false || end < start"),
    ("reversed or missing end delimiter", "e2e/pr-metadata.ts", "end < start ||", "false ||"),
    ("duplicate start delimiter", "e2e/pr-metadata.ts", "original.indexOf(START, start + START.length) !== -1", "false"),
    ("duplicate end delimiter", "e2e/pr-metadata.ts", "original.indexOf(END, end + END.length) !== -1", "false"),
    ("lookup API failure", "e2e/pr-metadata.ts", "if (!hasStatus(error, 404)) throw error", "if (false) throw error"),
    ("creation API failure", "e2e/pr-metadata.ts", "if (!hasStatus(error, 422)) throw error", "if (false) throw error"),
    ("creation conflict requires reread", "e2e/pr-metadata.ts", "      await gh.rest.issues.getLabel({ ...repo, name: label.name });", ""),
]
survivors = []
with tempfile.TemporaryDirectory(prefix="csm-ci-e2e-intent-mutants-") as directory:
    workspace = Path(directory)
    for name in ("src", "e2e"):
        shutil.copytree(root / name, workspace / name)
    shutil.copy(root / "package.json", workspace)
    (workspace / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
    command = [bun, "test", "e2e/pr-metadata.test.ts"]
    baseline = subprocess.run(command, cwd=workspace, capture_output=True, timeout=20)
    if baseline.returncode:
        sys.stderr.buffer.write(baseline.stderr)
        raise RuntimeError("isolated mutation baseline failed")
    for label, relative, before, after in mutations:
        path = workspace / relative
        original = path.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f"mutation must match exactly once: {label}")
        try:
            path.write_text(original.replace(before, after))
            result = subprocess.run(command, cwd=workspace, capture_output=True, timeout=20)
        finally:
            path.write_text(original)
        if result.returncode == 0:
            survivors.append(label)
        print(f"{'SURVIVED' if result.returncode == 0 else 'killed'} {label}", flush=True)
print(f"{len(mutations) - len(survivors)}/{len(mutations)} rejection guards killed")
if survivors:
    sys.exit(1)
