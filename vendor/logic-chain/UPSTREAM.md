# Vendored: FRAYMUS Logic Chain

- Upstream: https://github.com/eyeoverthink/FRAYMUS-Logic-Chain
- Pinned commit: `c0771d0373d960dbcc961adf3226cf5109d38af8` (main, merge c0771d0, 2026-11-03: signed chain)
- Copied with `git archive` (no local edits). Python standard library only; nothing to pip install.

Do not edit files in this folder by hand. To move the pin, run:

    scripts/sync-logic-chain.sh <commit-sha>

which re-copies the tree at that exact commit and rewrites this file. Then run
`npm run test:logic-chain` (Node integration + the vendored Python tests).
