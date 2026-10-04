#!/usr/bin/env bash
# Restore into the DESTINATION project. Schema must already exist (run the
# migrations first -- README step 2).
#
# Auth loads before data: edospmis_users AND edospmis_platform_admins both
# have foreign keys to auth.users.
#
# THE SELF-REFERENCE. edospmis_bid_submissions.returned_from points back at
# the same table (a bid returned for correction links to the one it
# replaced). The constraint is NOT deferrable, and pg_dump writes rows in
# physical order, so a row whose parent happens to sit later in the file
# fails the load. Today zero rows use it, so this would pass by luck. It
# will not stay zero -- every returned bid adds one. So the constraint comes
# off for the load and goes straight back on, and re-adding it revalidates
# every row, which is the check that it worked.
set -euo pipefail
: "${DST_DB_URL:?export DST_DB_URL first (destination project connection string)}"

AUTH="dump/auth"; DATA="dump/data"
[[ -f "${AUTH}/users.csv" ]] || { echo "No auth dump. Run 02-dump-auth.sh."; exit 1; }
ls "${DATA}"/*.sql >/dev/null 2>&1 || { echo "No data dump. Run 01-dump-data.sh."; exit 1; }

echo "== verifying destination schema =="
LIST=$(grep -v '^#' tables-in-order.txt | grep -v '^$' | sed "s/.*/'&'/" | paste -sd,)
missing=$(psql "$DST_DB_URL" -At -c \
  "select count(*) from (select unnest(array[$LIST]) as t) x
    where not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name=x.t)")
[[ "$missing" == "0" ]] || { echo "  $missing of 65 tables missing. Run migrations first."; exit 1; }
echo "  all 65 tables present"

echo "== phase 1: auth =="
U_COLS=$(cat "${AUTH}/users.columns"); I_COLS=$(cat "${AUTH}/identities.columns")
psql "$DST_DB_URL" -v ON_ERROR_STOP=1 <<SQL
begin;
\copy auth.users (${U_COLS}) from '${AUTH}/users.csv' with (format csv, header true)
\copy auth.identities (${I_COLS}) from '${AUTH}/identities.csv' with (format csv, header true)
commit;
SQL
echo "  auth loaded"

echo "== phase 2: application data =="
{
  echo "begin;"
  echo "alter table public.edospmis_bid_submissions drop constraint if exists edospmis_bid_submissions_returned_from_fkey;"
  for f in $(ls "${DATA}"/*.sql | sort); do
    echo "\echo '  loading $(basename "$f")'"
    echo "\i ${f}"
  done
  # Re-adding without NOT VALID forces a full check of every row.
  echo "alter table public.edospmis_bid_submissions add constraint edospmis_bid_submissions_returned_from_fkey"
  echo "  foreign key (returned_from) references public.edospmis_bid_submissions(id) on delete set null;"
  echo "commit;"
} > dump/_restore-all.sql

psql "$DST_DB_URL" -v ON_ERROR_STOP=1 -f dump/_restore-all.sql

echo
echo "== destination row counts =="
psql "$DST_DB_URL" -c \
  "select c.relname, (xpath('/row/cnt/text()', query_to_xml(
     format('select count(*) as cnt from public.%I', c.relname),false,true,'')))[1]::text::bigint as rows
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like 'edospmis%'
     and (xpath('/row/cnt/text()', query_to_xml(
          format('select count(*) as cnt from public.%I', c.relname),false,true,'')))[1]::text::bigint > 0
   order by rows desc"
echo
echo "Expect 1,526 rows total across edospmis tables. Compare with source."
