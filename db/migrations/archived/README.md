# Archived migration artifacts

Files in this directory are **not** part of the canonical Drizzle migration
chain (`db/migrations/meta/_journal.json`). Do not apply them to any
environment that has already applied the journaled chain.

## WBS-R1.8 relics (moved 2026-07-05)

The following files carried migration numbers that conflicted with the
surviving journaled chain but were never journal entries. Their schema
effects long ago converged into the canonical chain and are present in the
terminal snapshot (`meta/0026_snapshot.json`):

| Relic file | Effect | Present in journaled lineage since |
|---|---|---|
| `0008_content_posts_metadata.sql` | `content_posts.metadata` JSON column | snapshot `0003` |
| `0009_2fa_fields.sql` | `users.twoFactorEnabled` / `twoFactorMethod` | snapshot `0003` (`twoFactorEnabled`) |
| `0010_caption_adaptation.sql` | `campaign_assets.assetType` enum member | terminal snapshot |
| `0011_video_render_jobs.sql` | `video_render_jobs` table | snapshot `0004` |
| `0027_queue_durability_tables.sql` | queue durability tables | snapshot `0025` |

## Pre-rebuild manual patches

`0003_billing_engine.sql` … `0007_system_alerts.sql` and the
`manual_cloudsql_*.sql` files predate the rebuild and were archived by the
original team. They are retained for forensic reference only.
