"""Remove each Terraform rejection guard in an isolated copy and rerun its tests."""

import ast
import copy
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


root = Path(__file__).resolve().parent.parent
survivors = []
count = 0
for action, variable in (("release-assets", "CSM_CI_TERRAFORM_ASSET_MODULE"),
                         ("release-build", "CSM_CI_TERRAFORM_COLLECT_MODULE")):
    source = root / "actions/server" / action / "terraform.py"
    tree = ast.parse(source.read_text())
    guards = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "require"]
    guards += [node for node in ast.walk(tree) if action == "release-build" and isinstance(node, ast.If)
               and any(isinstance(child, ast.Raise) for child in node.body)]
    for guard in guards:
        mutant = copy.deepcopy(tree)
        for node in ast.walk(mutant):
            if type(node) is type(guard) and node.lineno == guard.lineno and node.col_offset == guard.col_offset:
                if isinstance(node, ast.Call):
                    node.args[0] = ast.Constant(True)
                else:
                    node.test = ast.Constant(False)
        ast.fix_missing_locations(mutant)
        with tempfile.TemporaryDirectory(prefix="csm-ci-terraform-mutant-") as directory:
            path = Path(directory) / "terraform.py"
            path.write_text(ast.unparse(mutant))
            result = subprocess.run([sys.executable, "-B", str(source.with_name("terraform_test.py"))],
                                    env={**os.environ, variable: str(path)}, capture_output=True, timeout=60)
        label = f"{action}:{guard.lineno}"
        count += 1
        if result.returncode == 0:
            survivors.append(label)
        print(f"{'SURVIVED' if result.returncode == 0 else 'killed'} {label}", flush=True)
typescript = [
    ("provider length", "src/lib/config.ts", "provider_name: z.string().max(64)", "provider_name: z.string()"),
    ("provider grammar", "src/lib/config.ts", '.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?![\\s\\S])/u, "provider_name must be lowercase alphanumeric with single internal hyphens")', ""),
    ("unknown provider fields", "src/lib/config.ts", 'z.strictObject({\n    build_type: z.literal("terraform-provider")', 'z.object({\n    build_type: z.literal("terraform-provider")'),
    ("provider required", "src/lib/config.ts", '"provider_name must be lowercase alphanumeric with single internal hyphens"),', '"provider_name must be lowercase alphanumeric with single internal hyphens").optional(),'),
    ("planning metadata", "src/release/plan.ts", 'input.release.build_type === "terraform-provider" && version.includes("+")', "false"),
    ("serialized metadata", "src/release/plan-schema.ts", 'plan.release.build_type !== "terraform-provider" || !plan.version.includes("+")', "true"),
    ("public verification required", "src/release/publish.ts", 'if (!input.terraform) throw new Rejection("Terraform publication requires the verified public key and source timestamp");', ""),
    ("publication revalidation", "src/release/publish.ts", 'if (plan.release.build_type === "terraform-provider")', 'if (false)'),
    ("asset revalidation", "src/release/assets.ts", 'if (release?.build_type === "terraform-provider")', 'if (false)'),
]
bun = subprocess.check_output(["mise", "which", "bun"], cwd=root, text=True).strip()
with tempfile.TemporaryDirectory(prefix="csm-ci-terraform-ts-mutant-") as directory:
    workspace = Path(directory)
    for name in ("src", "actions"):
        shutil.copytree(root / name, workspace / name, ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(root / "package.json", workspace)
    (workspace / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
    command = [bun, "test", "src/lib/config.test.ts", "src/release/plan.test.ts", "src/release/publish.test.ts", "src/release/assets.test.ts"]
    baseline = subprocess.run(command, cwd=workspace, capture_output=True, timeout=60)
    if baseline.returncode:
        sys.stderr.buffer.write(baseline.stderr)
        raise RuntimeError("isolated TypeScript mutation baseline failed")
    for label, relative, before, after in typescript:
        path = workspace / relative
        original = path.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f"mutation no longer matches exactly once: {label}")
        try:
            path.write_text(original.replace(before, after))
            result = subprocess.run(command, cwd=workspace, capture_output=True, timeout=60)
        finally:
            path.write_text(original)
        count += 1
        if result.returncode == 0:
            survivors.append(label)
        print(f"{'SURVIVED' if result.returncode == 0 else 'killed'} {label}", flush=True)
print(f"{count - len(survivors)}/{count} rejection guards killed")
if survivors:
    sys.exit(1)
