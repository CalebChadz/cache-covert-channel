#!/bin/sh
# Run the cross-process channel N times per configuration and record every
# result, so reliability is reported as a rate rather than a best run.
#   ./native/batch.sh [trials] > data/native/channel-batch.csv
set -u
N=${1:-20}
BIN=$(dirname "$0")/channel
TRACE_DIR=${TRACE_DIR:-}
echo "config,trial,send_qos,recv_qos,probe_mb,chip_ms,sent,received,checksum_ok,bit_errors,bits"
run() { # config send_qos recv_qos probe_mb msg
  cfg=$1; sq=$2; rq=$3; pm=$4; msg=$5
  i=1
  while [ "$i" -le "$N" ]; do
    extra=""
    [ "$sq" != "-" ] && extra="$extra --send-qos $sq"
    [ "$rq" != "-" ] && extra="$extra --recv-qos $rq"
    tr=""
    [ -n "$TRACE_DIR" ] && [ "$i" -eq 1 ] && tr="--trace $TRACE_DIR/channel-trace-$cfg.json"
    out=$($BIN run "$msg" --probe-mb "$pm" $extra $tr 2>/dev/null | tail -1)
    got=$(printf '%s' "$out" | sed -n 's/.*received "\(.*\)"  checksum.*/\1/p' | tr ',"' '__')
    ck=$(printf '%s' "$out" | grep -q 'checksum ok' && echo 1 || echo 0)
    be=$(printf '%s' "$out" | sed -n 's/.*bit errors \([0-9]*\)\/\([0-9]*\).*/\1,\2/p')
    echo "$cfg,$i,$sq,$rq,$pm,20,$msg,$got,$ck,$be"
    i=$((i + 1))
  done
}
run same-cluster-p   p p 8  cache
run default-sched    - - 8  cache
run default-long     - - 8  "through the cache"
run cross-cluster-l2 e p 8  cache
run cross-cluster-bw e p 64 cache
