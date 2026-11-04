#!/usr/bin/env bash
# Re-vendor the FRAYMUS Logic Chain at an exact commit into vendor/logic-chain (a copied subtree, not a submodule,
# so `docker build` / `fly deploy` from a plain clone or zip always has the sidecar's code).
# Usage: scripts/sync-logic-chain.sh <commit-sha> [repo-url]
set -euo pipefail
sha="${1:?usage: scripts/sync-logic-chain.sh <commit-sha> [repo-url]}"
repo="${2:-https://github.com/eyeoverthink/FRAYMUS-Logic-Chain.git}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git clone --quiet "$repo" "$tmp/src"
full="$(git -C "$tmp/src" rev-parse --verify "$sha^{commit}")"
rm -rf "$root/vendor/logic-chain"; mkdir -p "$root/vendor/logic-chain"
git -C "$tmp/src" archive "$full" | tar -x -C "$root/vendor/logic-chain"
date="$(git -C "$tmp/src" show -s --format=%cI "$full")"
cat > "$root/vendor/logic-chain/UPSTREAM.md" <<MD
# Vendored: FRAYMUS Logic Chain

- Upstream: ${repo%.git}
- Pinned commit: \`$full\` ($date)
- Copied with \`git archive\` (no local edits). Python standard library only; nothing to pip install.

Do not edit files in this folder by hand. To move the pin, run:

    scripts/sync-logic-chain.sh <commit-sha>

which re-copies the tree at that exact commit and rewrites this file. Then run
\`npm run test:logic-chain\` (Node integration + the vendored Python tests).
MD
sed -i "s/^export const LOGIC_CHAIN_COMMIT = .*/export const LOGIC_CHAIN_COMMIT = '$full'/" "$root/server/logic-chain/index.ts"
echo "vendored $full"
