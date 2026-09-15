#!/usr/bin/env bash
# Build, bundle, demo, and headless smoke tests. No network, no real money:
# demo/test mode runs the enforced purchase lifecycle over in-memory mocks.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

workdir="$(mktemp -d)"
# macOS exposes its temporary directory through /var -> /private/var.
# Session storage rejects symlink ancestors, so use the physical path.
workdir="$(cd "$workdir" && pwd -P)"
trap 'rm -rf "$workdir"' EXIT
export OPENCROWD_CONFIG_DIR="$workdir/config"

echo "smoke: build"
npm run build >/dev/null

echo "smoke: help renders"
node apps/cli/dist/index.js --help | grep -q "/approval ask|auto|off"

echo "smoke: headless demo run completes with a reviewed mock purchase"
node apps/cli/dist/index.js run --headless --test-mode \
  --prompt "smoke: buy a mock service and review it" \
  --output json --workspace "$workdir/headless" > "$workdir/headless.json"
node -e '
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (result.outcome !== "completed") throw new Error("headless outcome: " + result.outcome);
  if (!Array.isArray(result.service_calls) || result.service_calls.length < 1) throw new Error("no service calls recorded");
  if (Number(result.usdc_spent_cents.services) < 1) throw new Error("no mock service spend recorded");
' "$workdir/headless.json"

echo "smoke: non-interactive --demo runs the full lifecycle"
mkdir -p "$workdir/demo"
(cd "$workdir/demo" && node "$root/apps/cli/dist/index.js" --demo < /dev/null | grep -q "Demo complete")

echo "smoke: purchases ledger survives on disk"
ls "$workdir"/headless/sessions/*/purchases.jsonl >/dev/null
grep -q '"review_submitted"' "$workdir"/headless/sessions/*/purchases.jsonl

echo "smoke: bundle builds and runs"
npm run bundle --workspace opencrowd >/dev/null
node apps/cli/bundle/opencrowd.js --help >/dev/null

echo "smoke: bundle carries no deleted-surface dependencies"
! grep -q "startMcpServer\|startLocalApi" apps/cli/bundle/opencrowd.js

echo "smoke: all checks passed"
