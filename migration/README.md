# Moving edospmis to its own Supabase project

PMIS shares `cnlyuwslpcgosgwdmzav` with CRM, Hatch360 and POS. This moves it
out. **Do CRM first** -- it is the same process with a third of the parts,
and proving the method there costs an hour that this one does not have to
spend learning.

## What is being moved

Measured 2026-10-04:

| | |
|---|---|
| Tables | 65 (9 FK levels) |
| Rows | 1,526 |
| Functions | 82 |
| Triggers | 8 |
| Enum types | 1 (`edospmis_sub_status`) |
| Foreign keys **outside** PMIS | **0** |
| Tables with FK to `auth.users` | 2 |
| Auth users | 16 |
| Storage objects | **20** in `edospmis-attachments` |
| Migration ↔ schema drift | **none** (65 created, 65 present) |

Zero outside foreign keys is why this is safe to lift out whole.

## How this differs from CRM

Three things, each with a step of its own:

1. **20 real files.** CRM's buckets were empty. These are bid documents and
   case attachments -- `04-copy-storage.sh` exists for them. Storage is not
   in Postgres, so a database migration that "worked" can still leave every
   download 404ing.

2. **Two tables reference `auth.users`**, not one: `edospmis_users` and
   `edospmis_platform_admins`. The auth dump unions both, so a platform
   admin who is not also a tenant user is not quietly dropped.

3. **A self-referencing foreign key.** `edospmis_bid_submissions.returned_from`
   points back at the same table -- a bid returned for correction links to
   the one it replaced. It is not deferrable, and pg_dump writes rows in
   physical order, so a row whose parent sits later in the file fails.
   Right now **zero rows use it**, so a naive load would pass by luck and
   break later, once bids start being returned. `03-restore.sh` drops the
   constraint for the load and re-adds it immediately -- and re-adding it
   revalidates every row, which doubles as the proof it worked.

## Prerequisites

`psql` and `pg_dump` on PATH. Then:

```bash
export SRC_DB_URL='postgresql://postgres:...@db.cnlyuwslpcgosgwdmzav.supabase.co:5432/postgres'
export DST_DB_URL='postgresql://postgres:...@db.<new-ref>.supabase.co:5432/postgres'
# storage step only:
export SRC_PROJECT_URL='https://cnlyuwslpcgosgwdmzav.supabase.co'
export DST_PROJECT_URL='https://<new-ref>.supabase.co'
export SRC_SERVICE_KEY='...'
export DST_SERVICE_KEY='...'
```

**Never commit these or paste them into a chat.** They are superuser
credentials. `dump/` is gitignored and holds real records plus password
hashes -- delete it once the move is verified.

## Steps

### 1. Create the destination project
Account B, region `eu-west-1` to match the source.

### 2. Build the schema
```bash
cd ..
for f in supabase/migrations/*.sql; do
  echo "== $f"; psql "$DST_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```
All 63 run in order. Verified to produce exactly the 65 tables that exist
live, with no drift either way.

### 3. Create the buckets
| Bucket | Public |
|---|---|
| `edospmis-attachments` | no |
| `edospmis-branding` | **yes** |

Must exist before step 5 or every upload 404s.

### 4. Dump
```bash
cd migration
./01-dump-data.sh    # 65 files, FK order
./02-dump-auth.sh    # expect exactly 16 users
```
16, not 30. Thirty means you took the shared pool including Hatch360.

### 5. Restore and copy files
```bash
./03-restore.sh
./04-copy-storage.sh
```

### 6. Verify before switching anything
- Sign in as a real user with their **existing** password -- hashes carried
  over, no reset needed. A rejected login means identities did not load.
- Open a procurement case and walk it: PR, RFQ, quotations, PO, GRN,
  invoice, match exceptions. Those sit at FK levels 6-8; if they resolve,
  everything shallower did.
- Open a bid document and a case attachment. This is the only check that
  storage actually came across.
- Confirm RLS still isolates tenants.

### 7. Point the app at it
In Vercel, project `edospmis`:
```
NEXT_PUBLIC_SUPABASE_URL      -> https://<new-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY -> new anon key
SUPABASE_SERVICE_ROLE_KEY     -> new service role key
```
Also set `NEXT_PUBLIC_SITE_URL` -- PMIS currently has `http://localhost:3000`
there, which is wrong regardless of this migration.

Redeploy. No table was renamed, so nothing else changes.

## Rolling back

Steps 1-6 write nothing to the source. Until step 7, rollback is deleting
the new project. After step 7 it is restoring the old env vars -- but rows
written in the meantime stay behind. Do step 6 properly.

## Afterwards

Leave the source `edospmis_*` tables alone for a few days. Dropping them is
a separate, deliberate act and the only irreversible step here.
