-- GRA-103 (ADR 0019 as amended 2026-09-20): a relay provider's rows carry the generic `relay`
-- scheme; which upstream a row goes through is the provider's to know, and the open repository
-- names no vendor's. The one hosted relay provider wrote its rows under its own scheme name until
-- now, so those rows move onto `relay`. The column's enum is TypeScript-only on a `text` column, so
-- the snapshot beside this file records no change and `db:generate` produces nothing on top of it.
UPDATE "connection" SET "scheme" = 'relay' WHERE "scheme" = 'pipedream_connect_proxy';
