#!/bin/sh
# Benchmark reproduction; not a database conversion or migration.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
evidence="$repo/benchmark/results/automatic-deltas-20261101"
work=$(mktemp -d "${TMPDIR:-/private/tmp}/inibase-deltas-reproduce.XXXXXX")
for variant in before qualified; do
  mkdir "$work/$variant"
  tar -xzf "$evidence/$variant-source.tar.gz" -C "$work/$variant"
  ln -s "$repo/node_modules" "$work/$variant/node_modules"
  node "$repo/node_modules/typescript/bin/tsc" --project "$work/$variant/tsconfig.json"
done
cd "$repo"
for variant in before qualified; do
  node benchmark/qualification/postgres/run.mjs --module="$work/$variant/dist/index.js" --engines=inibase,sqlite,postgres --rows=1000,10000,100000 --profiles=compact,cms,entropy --repeats=3 --samples=32 --writes=8 --mixedRounds=3 --flush=write-through --output="$work/$variant-results"
  node benchmark/qualification/postgres/report.mjs "$work/$variant-results"
done
INIBASE_MAX_OVERLAY_RECORDS=64 node benchmark/qualification/postgres/run.mjs --module="$work/qualified/dist/index.js" --engines=inibase,sqlite,postgres --rows=10000 --profiles=cms --repeats=3 --samples=80 --writes=80 --mixedRounds=8 --flush=write-through --output="$work/stress"
node benchmark/qualification/postgres/report.mjs "$work/stress"
node benchmark/qualification/postgres/run.mjs --module="$work/qualified/dist/index.js" --scenario=concurrent --engines=inibase,sqlite,postgres --rows=1000 --profiles=compact --repeats=3 --writes=8 --flush=write-through --output="$work/concurrent"
node benchmark/qualification/postgres/run.mjs --module="$work/qualified/dist/index.js" --scenario=recovery --engines=inibase,sqlite,postgres --rows=1000 --profiles=compact --repeats=3 --writes=8 --flush=write-through --output="$work/recovery"
node benchmark/qualification/postgres/scenarios-report.mjs "$work"
# Unpack tests next to the qualified archived source before checking that source.
tar -xzf "$evidence/tests-source.tar.gz" -C "$work/qualified"
cp -R "$repo/benchmark/qualification/checks.mjs" "$work/qualified/benchmark/qualification/checks.mjs"
(cd "$work/qualified" && node benchmark/qualification/checks.mjs)
printf 'Retained reproduction output: %s\n' "$work"
