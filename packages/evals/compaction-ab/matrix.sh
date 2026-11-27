#!/bin/bash
# usage: matrix.sh <arm> <root> <wallet> <out> <model> <reps> [tasks...]
arm=$1 root=$2 wallet=$3 out=$4 model=$5 reps=$6; shift 6
tasks=${@:-vendor_selection incident_logs assistant_mission}
for rep in $(seq 1 $reps); do for task in $tasks; do
  AGENTCASH_WALLET_PATH=$wallet timeout 1800 node run.mjs --root $root --arm $arm --task $task --rep $rep --model $model --window 32000 --max-output 4096 --out $out
done; done
echo "ARM $arm FINISHED"
