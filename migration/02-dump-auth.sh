#!/usr/bin/env bash
# Dump the auth identities belonging to PMIS.
#
# TWO tables reference auth.users here, not one: edospmis_users and
# edospmis_platform_admins. A platform admin who is not also a tenant user
# would be missed by the obvious query, so both are unioned.
#
# auth.identities travels with auth.users. Without it the account exists and
# every login is rejected -- the password hash lives in users, the provider
# linkage in identities, and Supabase needs both.
set -euo pipefail
: "${SRC_DB_URL:?export SRC_DB_URL first}"

OUT="dump/auth"; mkdir -p "$OUT"
IDS="select id from public.edospmis_users union select user_id from public.edospmis_platform_admins"

psql "$SRC_DB_URL" -v ON_ERROR_STOP=1 -c \
  "\copy (select * from auth.users where id in ($IDS)) to '${OUT}/users.csv' with (format csv, header true)"
psql "$SRC_DB_URL" -v ON_ERROR_STOP=1 -c \
  "\copy (select * from auth.identities where user_id in ($IDS)) to '${OUT}/identities.csv' with (format csv, header true)"

for tbl in users identities; do
  psql "$SRC_DB_URL" -At -c \
    "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
      where table_schema='auth' and table_name='${tbl}'" > "${OUT}/${tbl}.columns"
done

echo "users:      $(( $(wc -l < "${OUT}/users.csv") - 1 )) rows"
echo "identities: $(( $(wc -l < "${OUT}/identities.csv") - 1 )) rows"
echo
echo "Expect 16 users. 30 means you grabbed the whole shared pool -- stop."
