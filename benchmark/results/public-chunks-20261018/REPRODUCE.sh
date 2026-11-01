#!/bin/sh
# Exact source reconstruction and comparison; this is NOT a database migration.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
evidence="$repo/benchmark/results/public-chunks-20261018"
work=$(mktemp -d "${TMPDIR:-/private/tmp}/inibase-chunks-reproduce.XXXXXX")
for variant in before after; do
  mkdir "$work/$variant"
  tar -xzf "$evidence/$variant-source.tar.gz" -C "$work/$variant"
  ln -s "$repo/node_modules" "$work/$variant/node_modules"
  node "$repo/node_modules/typescript/bin/tsc" --project "$work/$variant/tsconfig.json"
done
cd "$repo"
node benchmark/qualification/column-replace-profile.mjs --module="$work/before/dist/file.js" --output="$work/profile-before.json"
node benchmark/qualification/column-replace-profile.mjs --module="$work/after/dist/file.js" --output="$work/profile-after.json"
# Same three-engine suite. Use isolated fresh directories and execute serially.
for variant in before after; do
  node benchmark/qualification/postgres/run.mjs --module="$work/$variant/dist/index.js" --engines=inibase,sqlite,postgres --rows=1000,10000,100000 --profiles=compact,cms,entropy --repeats=3 --samples=32 --writes=8 --mixedRounds=3 --flush=write-through --output="$work/$variant-results"
  node benchmark/qualification/postgres/report.mjs "$work/$variant-results"
done
printf 'Retained reproduction output: %s\n' "$work"
