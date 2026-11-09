#!/bin/zsh
# Reproduce the original dirty working tree without changing this checkout.
set -euo pipefail
repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
baseline_destination="${1:?Usage: rebuild-baseline.sh /absolute/new/baseline-directory}"
case "$baseline_destination" in /*) ;; *) print -u2 'An absolute destination is required'; exit 1 ;; esac
mkdir "$baseline_destination"
git -C "$repository_root" archive dd3ed9d72b13daa260e88b6f00327761eb52543d | tar -xf - -C "$baseline_destination"
(cd "$baseline_destination" && git apply "$repository_root/benchmark/results/optimization-20261017/preexisting.patch")
ln -s "$repository_root/node_modules" "$baseline_destination/node_modules"
node "$repository_root/node_modules/typescript/bin/tsc" -p "$baseline_destination/tsconfig.json"
print "Baseline module: $baseline_destination/dist/index.js"
