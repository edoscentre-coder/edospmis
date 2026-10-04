#!/usr/bin/env bash
# Dump edospmis application data from the SOURCE project.
#
# Data only -- the schema comes from replaying supabase/migrations against
# the destination. One file per table in FK order, because pg_dump given
# many --table flags emits in its own order, not dependency order.
set -euo pipefail
: "${SRC_DB_URL:?export SRC_DB_URL first (source project connection string)}"

OUT="dump/data"; mkdir -p "$OUT"; rm -f "$OUT"/*.sql
n=0
while read -r t; do
  [[ -z "$t" || "$t" == \#* ]] && continue
  n=$((n+1)); printf -v seq "%02d" "$n"
  echo "  [$seq] $t"
  pg_dump "$SRC_DB_URL" --data-only --no-owner --no-privileges \
    --table="public.${t}" --file="${OUT}/${seq}_${t}.sql"
done < tables-in-order.txt
echo; echo "Dumped $n tables (expect 65) to ${OUT}/"
