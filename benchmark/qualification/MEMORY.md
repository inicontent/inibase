# Comparing total memory fairly

The three-engine historical suite configures cache allowances. It does not limit
the complete deployment. Cache sizes, a V8 heap limit, an RSS watchdog and macOS
shell resource limits must not be described as equivalent total-memory limits.
The local October 18 audit found no installed container executable and the Mac
rejected the attempted resident-memory limit. No hard-limit trial is qualified.

`memory-limit.mjs` prepares a Linux cgroup v2 comparison. Its Linux path is not
yet exercised on this host. The local checks cover unsupported-host refusal,
preservation of failure evidence and rejection of invalid limits. Before trusting
Linux results, run both the success and intentional OOM probes below.

The launcher needs a **previously delegated cgroup parent** under
`/sys/fs/cgroup`, with `memory` enabled in `cgroup.subtree_control`, and permission
to create child cgroups, move the child shell and set limits. It neither enables
controllers globally nor changes the user's services. Do not use production data.
Set `INIBASE_CGROUP_PARENT` to that delegated directory. Paths below are examples;
use an installed Linux PostgreSQL binary directory and Linux-built dependencies.

```sh
# Must exit successfully, with qualified=true and no oom_kill events.
node benchmark/qualification/memory-limit.mjs \
  --parent="$INIBASE_CGROUP_PARENT" --bytes=67108864 \
  --output=/tmp/inibase-memory-success \
  -- node -e 'console.log(process.memoryUsage())'

# Must fail with status=oom, oomKills>0 and cleaned=true, while retaining evidence.
node benchmark/qualification/memory-limit.mjs \
  --parent="$INIBASE_CGROUP_PARENT" --bytes=67108864 \
  --output=/tmp/inibase-memory-oom \
  -- node -e 'const held=[]; setInterval(()=>held.push(Buffer.alloc(8*1024*1024,1)),10)'
```

Every trial needs its own fresh cgroup, including the runner, worker, all clients,
the complete PostgreSQL server process tree and charged filesystem cache. The
supervisor stays outside so it can retain failures after a group OOM kill.
Detached servers inherit the group. Whole-group OOM termination is configured;
remaining descendants are killed and recorded as a failed trial. Kernel memory
limits can temporarily overshoot. This is kernel charged-memory accounting,
not a sum of process RSS. Details follow the
[Linux cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

After both probes pass, compile the engine and run an initial matrix from the
repository root (requires existing PostgreSQL qualification dependencies):

```sh
node node_modules/typescript/bin/tsc
mkdir -p /tmp/inibase-hard-memory
for mib in 64 128 256 512; do
  for repeat in 1 2 3; do
    case "$repeat" in
      1) engine_order='inibase sqlite postgres' ;;
      2) engine_order='sqlite postgres inibase' ;;
      3) engine_order='postgres inibase sqlite' ;;
    esac
    for rows in 1000 10000 100000; do
      for profile in compact cms entropy; do
        for engine in $engine_order; do
          trial="/tmp/inibase-hard-memory/$mib-$repeat-$rows-$profile-$engine"
          mkdir "$trial"
          node benchmark/qualification/memory-limit.mjs \
            --parent="$INIBASE_CGROUP_PARENT" --bytes="$((mib * 1048576))" \
            --output="$trial/limit" \
            -- node benchmark/qualification/postgres/run.mjs \
              --pgBin="$PG_BIN" --module="$PWD/dist/index.js" \
              --engines="$engine" --budget=16777216 \
              --rows="$rows" --profiles="$profile" --repeats=1 \
              --samples=32 --writes=8 --mixedRounds=3 \
              --output="$trial/measured" >"$trial/console.log" 2>&1
          # Deliberately continue after OOM; retain every failed trial.
        done
      done
    done
  done
done
```

Run the loop using POSIX sh/bash, without `set -e`, so failures remain in the
matrix. It is 324 independent trials and can be expensive with the current
iniBase mutation implementation. Startup, including fresh PostgreSQL initdb,
counts against the limit; report setup failure separately from query failure.
This initial matrix includes a payload larger than 64 MiB (100k entropy rows);
add 1m entropy rows when qualifying datasets larger than all four limits.
Keep the exact source hashes in every trial's environment.json. The supervisor's
memory-limit.json includes the command, verified settings, kernel peak,
memory events, pressure, CPU and I/O counters, exit signal and cleanup result.

Fresh directories do not globally evict filesystem cache. Existing binaries and
shared pages may already be charged outside a fresh cgroup; retain rotated order
and report this limitation. Do not call these cold-NVMe trials. Do not silently
drop OOM/setup failures or compare only successful engines. Report success rate,
latency, throughput and charged-memory peaks at every limit, with disk use and
durability unchanged. Full materialized results stay in the matrix as existing
API behavior; qualify any future streaming API as a separate workload.

No current conclusion says iniBase fits a smaller total-memory deployment than
SQLite or PostgreSQL. A useful result must demonstrate compact storage or a
measurable memory/speed advantage under equal limits, without weakening features
or durability.
