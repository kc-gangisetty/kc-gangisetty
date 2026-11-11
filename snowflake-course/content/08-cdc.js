window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "cdc",
  num: "08",
  track: "Pipelines and CDC",
  title: "Change data capture with streams",
  summary: "Track inserts, updates and deletes on TPC-H tables with streams and the CHANGES clause, apply them with MERGE, and build a Type 2 slowly changing dimension.",
  minutes: 70,
  level: "Intermediate to advanced",
  lessons: [
    {
      title: "What a stream is",
      body: `
<p>A <b>stream</b> is a bookmark on a table. It records a point in the table's version history (the offset) and, when you query it, returns the rows that changed between that offset and now. It doesn't copy data. It reads the table's change tracking metadata and micro-partition versions.</p>
<sql>
USE ROLE SYSADMIN;
USE WAREHOUSE COURSE_WH;
CREATE SCHEMA IF NOT EXISTS COURSE_DB.CDC;
USE SCHEMA COURSE_DB.CDC;

-- A source table we can change freely
CREATE OR REPLACE TABLE CUSTOMER_SRC AS
SELECT C_CUSTKEY, C_NAME, C_ADDRESS, C_NATIONKEY, C_PHONE, C_ACCTBAL, C_MKTSEGMENT
FROM COURSE_DB.TPCH.CUSTOMER;

CREATE OR REPLACE STREAM CUSTOMER_STREAM ON TABLE CUSTOMER_SRC;

-- Make some changes
UPDATE CUSTOMER_SRC SET C_ACCTBAL = C_ACCTBAL + 500 WHERE C_CUSTKEY IN (1, 2);
DELETE FROM CUSTOMER_SRC WHERE C_CUSTKEY = 3;
INSERT INTO CUSTOMER_SRC VALUES (900001, 'Customer#900001', '1 New St', 7, '17-555-0100', 1000, 'BUILDING');

SELECT C_CUSTKEY, C_ACCTBAL, METADATA$ACTION, METADATA$ISUPDATE, METADATA$ROW_ID
FROM CUSTOMER_STREAM
ORDER BY C_CUSTKEY, METADATA$ACTION;
</sql>
<p>Each row comes with three metadata columns:</p>
<table>
<tr><th>Column</th><th>Meaning</th></tr>
<tr><td><code>METADATA$ACTION</code></td><td>INSERT or DELETE</td></tr>
<tr><td><code>METADATA$ISUPDATE</code></td><td>TRUE if the row is half of an update</td></tr>
<tr><td><code>METADATA$ROW_ID</code></td><td>A stable, unique ID for the row, so you can track it over time</td></tr>
</table>
<p>An update shows up as two rows: a DELETE of the old values and an INSERT of the new ones, both with ISUPDATE = TRUE. Customer 3 shows as a DELETE with ISUPDATE = FALSE, and 900001 as an INSERT with ISUPDATE = FALSE.</p>
<p>The stream returns the <b>net</b> change since its offset. If you insert a row and delete it before consuming the stream, the stream shows nothing for it. If you update the same row three times, you see one DELETE (original values) and one INSERT (latest values).</p>
`
    },
    {
      title: "Offsets, consumption and staleness",
      body: `
<p>Selecting from a stream doesn't move its offset. The offset only advances when the stream is read by a <b>DML statement that commits</b>: an INSERT, MERGE, UPDATE or DELETE that uses the stream as a source. That's what makes streams exactly-once: if the DML fails or rolls back, the offset stays put and you can try again.</p>
<sql>
CREATE OR REPLACE TABLE CUSTOMER_CHANGES_LOG (
  c_custkey NUMBER, c_acctbal NUMBER(12,2), action STRING, is_update BOOLEAN, logged_at TIMESTAMP_LTZ);

INSERT INTO CUSTOMER_CHANGES_LOG
SELECT C_CUSTKEY, C_ACCTBAL, METADATA$ACTION, METADATA$ISUPDATE, CURRENT_TIMESTAMP()
FROM CUSTOMER_STREAM;

SELECT COUNT(*) FROM CUSTOMER_STREAM;              -- 0, the offset moved
SELECT SYSTEM$STREAM_HAS_DATA('CUSTOMER_STREAM');  -- FALSE
</sql>
<p>Stream types:</p>
<ul>
<li><b>Standard</b> (default): inserts, updates and deletes, net of each other.</li>
<li><b>Append-only</b>: inserts only. Much cheaper to compute on tables that are only appended to, because Snowflake doesn't need to diff partitions. <code>CREATE STREAM s ON TABLE t APPEND_ONLY = TRUE;</code></li>
<li><b>Insert-only</b>: for external and Iceberg tables, inserts only.</li>
</ul>
<p>Streams also work on views (including secure views), directory tables, dynamic tables and event tables. Streams on views need change tracking on every underlying table.</p>
<div class="warn"><b>Stale streams</b>A stream needs the table's history back to its offset. If nobody consumes the stream for longer than the table's retention period, the stream goes <b>stale</b> and has to be recreated, which means you've lost changes. To help, Snowflake temporarily extends retention for tables with unconsumed streams, up to <code>MAX_DATA_EXTENSION_TIME_IN_DAYS</code> (default 14). Check the <code>stale_after</code> column of <code>SHOW STREAMS</code> and alert well before it.</div>
<p>Multiple consumers? Create one stream per consumer. Each stream keeps its own offset, so two pipelines can read the same table's changes independently.</p>
`
    },
    {
      title: "The CHANGES clause",
      body: `
<p>Sometimes you want changes between two arbitrary points in time without managing a stream object. The <code>CHANGES</code> clause gives you stream-style output for any window in the table's Time Travel history. It needs change tracking turned on first.</p>
<sql>
ALTER TABLE CUSTOMER_SRC SET CHANGE_TRACKING = TRUE;
SET t0 = CURRENT_TIMESTAMP();

UPDATE CUSTOMER_SRC SET C_MKTSEGMENT = 'MACHINERY' WHERE C_CUSTKEY = 10;

SELECT C_CUSTKEY, C_MKTSEGMENT, METADATA$ACTION, METADATA$ISUPDATE
FROM CUSTOMER_SRC
  CHANGES (INFORMATION => DEFAULT)
  AT (TIMESTAMP => $t0::TIMESTAMP_LTZ);
</sql>
<p>CHANGES never advances anything; it's a read-only query. Use it for audits, backfills, and replaying a time window. Use streams when you need a durable bookmark that a pipeline consumes exactly once.</p>
`
    },
    {
      title: "Applying changes with MERGE",
      body: `
<p>A typical CDC pipeline reads a stream and applies it to a target with MERGE. The target here is a curated customer table.</p>
<sql>
CREATE OR REPLACE TABLE DIM_CUSTOMER_CURRENT AS
SELECT * FROM CUSTOMER_SRC;

CREATE OR REPLACE STREAM CUSTOMER_STREAM_MERGE ON TABLE CUSTOMER_SRC;

-- New changes to apply
UPDATE CUSTOMER_SRC SET C_PHONE = '11-111-1111' WHERE C_CUSTKEY = 20;
DELETE FROM CUSTOMER_SRC WHERE C_CUSTKEY = 21;
INSERT INTO CUSTOMER_SRC VALUES (900002, 'Customer#900002', '2 New St', 3, '13-555-0101', 50, 'FURNITURE');

MERGE INTO DIM_CUSTOMER_CURRENT t
USING (
  -- Drop the DELETE half of updates; keep real deletes and all inserts
  SELECT * FROM CUSTOMER_STREAM_MERGE
  WHERE NOT (METADATA$ACTION = 'DELETE' AND METADATA$ISUPDATE)
) s
ON t.C_CUSTKEY = s.C_CUSTKEY
WHEN MATCHED AND s.METADATA$ACTION = 'DELETE' THEN DELETE
WHEN MATCHED AND s.METADATA$ACTION = 'INSERT' THEN UPDATE SET
  t.C_NAME = s.C_NAME, t.C_ADDRESS = s.C_ADDRESS, t.C_NATIONKEY = s.C_NATIONKEY,
  t.C_PHONE = s.C_PHONE, t.C_ACCTBAL = s.C_ACCTBAL, t.C_MKTSEGMENT = s.C_MKTSEGMENT
WHEN NOT MATCHED AND s.METADATA$ACTION = 'INSERT' THEN INSERT
  (C_CUSTKEY, C_NAME, C_ADDRESS, C_NATIONKEY, C_PHONE, C_ACCTBAL, C_MKTSEGMENT)
  VALUES (s.C_CUSTKEY, s.C_NAME, s.C_ADDRESS, s.C_NATIONKEY, s.C_PHONE, s.C_ACCTBAL, s.C_MKTSEGMENT);
</sql>
<p>Why filter out the DELETE half of updates? Each updated key appears twice in the stream. If both rows reach the MERGE, two source rows match one target row, and MERGE either errors with "Duplicate row detected" or picks one at random (depending on <code>ERROR_ON_NONDETERMINISTIC_MERGE</code>). Removing it leaves exactly one source row per key.</p>
<div class="tip"><b>When the source has true duplicates</b>If changes come from a raw feed rather than a stream (say, a CDC tool landing every event), dedupe first with <code>QUALIFY ROW_NUMBER() OVER (PARTITION BY key ORDER BY event_ts DESC) = 1</code>.</div>
`
    },
    {
      title: "Slowly changing dimension Type 2",
      body: `
<p>SCD Type 2 keeps history: when a tracked attribute changes, you close the old row and insert a new one. With a stream, the whole thing fits in one MERGE using a well-known trick: send each changed key through the MERGE twice, once to close the old row and once to insert the new one.</p>
<sql>
CREATE OR REPLACE TABLE DIM_CUSTOMER_HIST (
  C_CUSTKEY NUMBER, C_NAME STRING, C_ADDRESS STRING, C_MKTSEGMENT STRING, C_ACCTBAL NUMBER(12,2),
  valid_from TIMESTAMP_LTZ, valid_to TIMESTAMP_LTZ, is_current BOOLEAN);

INSERT INTO DIM_CUSTOMER_HIST
SELECT C_CUSTKEY, C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL,
       '1900-01-01'::TIMESTAMP_LTZ, NULL, TRUE
FROM CUSTOMER_SRC;

CREATE OR REPLACE STREAM CUSTOMER_STREAM_SCD2 ON TABLE CUSTOMER_SRC;

UPDATE CUSTOMER_SRC SET C_MKTSEGMENT = 'AUTOMOBILE', C_ACCTBAL = 999 WHERE C_CUSTKEY = 30;

MERGE INTO DIM_CUSTOMER_HIST t
USING (
  -- Row 1 per changed key: used to close the current version (merge_key = real key)
  SELECT C_CUSTKEY AS merge_key, s.*
  FROM CUSTOMER_STREAM_SCD2 s
  WHERE METADATA$ACTION = 'INSERT'
  UNION ALL
  -- Row 2 per updated key: NULL merge_key never matches, so it gets INSERTed as the new version
  SELECT NULL AS merge_key, s.*
  FROM CUSTOMER_STREAM_SCD2 s
  WHERE METADATA$ACTION = 'INSERT' AND METADATA$ISUPDATE
  UNION ALL
  -- Hard deletes: close the current version
  SELECT C_CUSTKEY AS merge_key, s.*
  FROM CUSTOMER_STREAM_SCD2 s
  WHERE METADATA$ACTION = 'DELETE' AND NOT METADATA$ISUPDATE
) s
ON t.C_CUSTKEY = s.merge_key AND t.is_current
WHEN MATCHED THEN UPDATE SET
  t.valid_to = CURRENT_TIMESTAMP(), t.is_current = FALSE
WHEN NOT MATCHED AND s.METADATA$ACTION = 'INSERT' THEN INSERT
  (C_CUSTKEY, C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL, valid_from, valid_to, is_current)
  VALUES (s.C_CUSTKEY, s.C_NAME, s.C_ADDRESS, s.C_MKTSEGMENT, s.C_ACCTBAL, CURRENT_TIMESTAMP(), NULL, TRUE);

SELECT * FROM DIM_CUSTOMER_HIST WHERE C_CUSTKEY = 30 ORDER BY valid_from;
</sql>
<p>Walk through customer 30: the first branch matches the current row and closes it. The second branch has a NULL merge key, so it never matches and inserts the new version. A brand new customer only appears in the first branch, doesn't match, and gets inserted. A hard delete matches and closes the row. All of it commits together, and the stream's offset moves forward once.</p>
`
    }
  ],
  quiz: [
    {
      q: "You SELECT from a stream three times. How many times does its offset move?",
      options: ["Three times", "Once", "Zero times", "It depends on the warehouse size"],
      answer: 2,
      why: "<p>Plain SELECTs never advance the offset. Only a committed DML statement that reads from the stream does. That lets you inspect a stream safely before processing it.</p>"
    },
    {
      q: "A row is updated in the source table. How does it appear in a standard stream?",
      options: [
        "One row with METADATA$ACTION = 'UPDATE'",
        "A DELETE row with old values and an INSERT row with new values, both with METADATA$ISUPDATE = TRUE",
        "Only the new values, as an INSERT with ISUPDATE = FALSE",
        "It doesn't appear until the next day"
      ],
      answer: 1,
      why: "<p>There's no UPDATE action. Updates are modelled as a delete/insert pair flagged with ISUPDATE = TRUE. That's why MERGE logic needs to drop the DELETE half or handle it explicitly.</p>"
    },
    {
      q: "A row is inserted and then deleted before the stream is consumed. What does the stream show?",
      options: ["An INSERT and a DELETE", "Only the DELETE", "Nothing for that row", "Only the INSERT"],
      answer: 2,
      why: "<p>Standard streams return the net change between the offset and now. A row that was born and died in between has no net effect. Append-only streams are different: they would still show the insert.</p>"
    },
    {
      q: "What makes a stream go stale?",
      options: [
        "Querying it more than 100 times",
        "Not consuming it before the table's retention (including any extension) runs out",
        "Running it on a different warehouse",
        "Cloning the source table"
      ],
      answer: 1,
      why: "<p>The stream relies on table history from its offset onward. Once that history ages out of retention (extended up to MAX_DATA_EXTENSION_TIME_IN_DAYS for unconsumed streams), the stream can't produce its changes and becomes stale. You have to recreate it and backfill.</p>"
    },
    {
      q: "Your MERGE from a stream fails with \"Duplicate row detected during DML action\". What's the most likely cause?",
      options: [
        "The target table has no primary key",
        "Updated keys appear twice in the stream (DELETE + INSERT) and both reach the MERGE",
        "The stream is stale",
        "The warehouse is too small"
      ],
      answer: 1,
      why: "<p>MERGE requires at most one source row per target row it updates or deletes. Filter out <code>METADATA$ACTION = 'DELETE' AND METADATA$ISUPDATE</code>, or deduplicate the source with QUALIFY.</p>"
    },
    {
      q: "Your table only ever gets inserts. Which stream type is best?",
      options: ["Standard", "Append-only", "Insert-only", "A view with CHANGES"],
      answer: 1,
      why: "<p>Append-only streams ignore updates and deletes, so Snowflake doesn't need to compute row-level diffs. They're cheaper and faster on insert-heavy tables like event logs. Insert-only is the equivalent for external and Iceberg tables.</p>"
    },
    {
      q: "Two separate pipelines both need every change from ORDERS. What should you do?",
      options: [
        "Share one stream and have each pipeline read half the rows",
        "Create one stream per pipeline",
        "Use one stream and copy it to a table first, then both read the table",
        "Streams only support one consumer per table, so use CHANGES instead"
      ],
      answer: 1,
      why: "<p>Each stream has its own offset. One stream per consumer keeps them independent. Option C also works but adds a hop and its own cleanup problem. There's no limit of one stream per table.</p>"
    },
    {
      q: "What does the CHANGES clause need that a stream sets up automatically?",
      options: [
        "A running task",
        "CHANGE_TRACKING = TRUE on the table",
        "An append-only flag",
        "A materialized view"
      ],
      answer: 1,
      why: "<p>Creating a stream turns on change tracking for you. For CHANGES without a stream, run <code>ALTER TABLE ... SET CHANGE_TRACKING = TRUE</code> first. Change tracking only captures history from the moment it's enabled.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Your first stream",
      prompt: "<p>Create <code>COURSE_DB.CDC.ORDERS_SRC</code> as a copy of the 1998 orders, put a stream on it, update the priority of 5 orders, and show the stream contents.</p>",
      answer: `CREATE OR REPLACE TABLE COURSE_DB.CDC.ORDERS_SRC AS
SELECT * FROM COURSE_DB.TPCH.ORDERS WHERE O_ORDERDATE >= '1998-01-01';

CREATE OR REPLACE STREAM COURSE_DB.CDC.ORDERS_SRC_STREAM ON TABLE COURSE_DB.CDC.ORDERS_SRC;

UPDATE COURSE_DB.CDC.ORDERS_SRC
SET O_ORDERPRIORITY = '1-URGENT'
WHERE O_ORDERKEY IN (SELECT O_ORDERKEY FROM COURSE_DB.CDC.ORDERS_SRC ORDER BY O_ORDERKEY LIMIT 5);

SELECT O_ORDERKEY, O_ORDERPRIORITY, METADATA$ACTION, METADATA$ISUPDATE
FROM COURSE_DB.CDC.ORDERS_SRC_STREAM
ORDER BY O_ORDERKEY, METADATA$ACTION;`,
      why: "<p>You'll see 10 rows: for each of the 5 orders, a DELETE with the old priority and an INSERT with the new one, all with ISUPDATE = TRUE. If any of those orders already had priority 1-URGENT, Snowflake still records the update because the row was rewritten, even though the values didn't change.</p>"
    },
    {
      level: "Easy",
      title: "Consume and confirm",
      prompt: "<p>Move the stream's contents into a log table and prove the stream is now empty.</p>",
      answer: `CREATE OR REPLACE TABLE COURSE_DB.CDC.ORDERS_CHANGE_LOG AS
SELECT *, 'INSERT' AS action, TRUE AS is_update, CURRENT_TIMESTAMP() AS seen_at
FROM COURSE_DB.CDC.ORDERS_SRC
WHERE 1 = 0;   -- just the shape, built from the base table

INSERT INTO COURSE_DB.CDC.ORDERS_CHANGE_LOG
SELECT *, METADATA$ACTION, METADATA$ISUPDATE, CURRENT_TIMESTAMP()
FROM COURSE_DB.CDC.ORDERS_SRC_STREAM;

SELECT SYSTEM$STREAM_HAS_DATA('COURSE_DB.CDC.ORDERS_SRC_STREAM') AS has_data;   -- FALSE`,
      why: "<p>The CTAS with <code>WHERE 1 = 0</code> builds an empty table with the right columns. It reads the base table, not the stream, so there's no question of it touching the offset. The INSERT is the consuming statement: once it commits, the offset moves past every change it read. SYSTEM$STREAM_HAS_DATA is cheap to call, and tasks use it in their WHEN clause to skip runs when there's nothing to do.</p>"
    },
    {
      level: "Medium",
      title: "Net changes",
      hint: "Insert a row, update it twice, then look at the stream.",
      prompt: "<p>On a fresh stream over <code>ORDERS_SRC</code>, insert a new order, update its total price twice, and update an existing order then delete it. Predict what the stream will show, then check.</p>",
      answer: `CREATE OR REPLACE STREAM COURSE_DB.CDC.ORDERS_NET ON TABLE COURSE_DB.CDC.ORDERS_SRC;

INSERT INTO COURSE_DB.CDC.ORDERS_SRC
SELECT 9999991, 1, 'O', 100, '1998-08-02', '5-LOW', 'Clerk#000000001', 0, 'new';
UPDATE COURSE_DB.CDC.ORDERS_SRC SET O_TOTALPRICE = 200 WHERE O_ORDERKEY = 9999991;
UPDATE COURSE_DB.CDC.ORDERS_SRC SET O_TOTALPRICE = 300 WHERE O_ORDERKEY = 9999991;

SET existing = (SELECT MIN(O_ORDERKEY) FROM COURSE_DB.CDC.ORDERS_SRC);
UPDATE COURSE_DB.CDC.ORDERS_SRC SET O_TOTALPRICE = 1 WHERE O_ORDERKEY = $existing;
DELETE FROM COURSE_DB.CDC.ORDERS_SRC WHERE O_ORDERKEY = $existing;

SELECT O_ORDERKEY, O_TOTALPRICE, METADATA$ACTION, METADATA$ISUPDATE
FROM COURSE_DB.CDC.ORDERS_NET
ORDER BY O_ORDERKEY;`,
      why: "<p>Two rows. The new order shows as one INSERT with total 300 and ISUPDATE = FALSE: from the stream's point of view it simply didn't exist before. The existing order shows as one DELETE with its <i>original</i> total (not 1) and ISUPDATE = FALSE. The stream compares the table at the offset with the table now, and everything in between collapses. If you need every intermediate event, you need an event log or append-only CDC feed, not a standard stream.</p>"
    },
    {
      level: "Medium",
      title: "Upsert from a stream",
      hint: "Filter out the DELETE half of updates before the MERGE.",
      prompt: "<p>Create <code>ORDERS_TGT</code> as a copy of <code>ORDERS_SRC</code>, a stream on the source, make a mix of inserts, updates and deletes on the source, then write one MERGE that makes the target match the source. Verify with MINUS in both directions.</p>",
      answer: `CREATE OR REPLACE TABLE COURSE_DB.CDC.ORDERS_TGT CLONE COURSE_DB.CDC.ORDERS_SRC;
CREATE OR REPLACE STREAM COURSE_DB.CDC.ORDERS_SYNC ON TABLE COURSE_DB.CDC.ORDERS_SRC;

UPDATE COURSE_DB.CDC.ORDERS_SRC SET O_ORDERSTATUS = 'F' WHERE O_ORDERKEY % 97 = 0;
DELETE FROM COURSE_DB.CDC.ORDERS_SRC WHERE O_ORDERKEY % 101 = 0;
INSERT INTO COURSE_DB.CDC.ORDERS_SRC
SELECT O_ORDERKEY + 10000000, O_CUSTKEY, O_ORDERSTATUS, O_TOTALPRICE, O_ORDERDATE,
       O_ORDERPRIORITY, O_CLERK, O_SHIPPRIORITY, O_COMMENT
FROM COURSE_DB.CDC.ORDERS_SRC WHERE O_ORDERKEY % 103 = 0;

MERGE INTO COURSE_DB.CDC.ORDERS_TGT t
USING (
  SELECT * FROM COURSE_DB.CDC.ORDERS_SYNC
  WHERE NOT (METADATA$ACTION = 'DELETE' AND METADATA$ISUPDATE)
) s
ON t.O_ORDERKEY = s.O_ORDERKEY
WHEN MATCHED AND s.METADATA$ACTION = 'DELETE' THEN DELETE
WHEN MATCHED THEN UPDATE SET
  t.O_CUSTKEY = s.O_CUSTKEY, t.O_ORDERSTATUS = s.O_ORDERSTATUS, t.O_TOTALPRICE = s.O_TOTALPRICE,
  t.O_ORDERDATE = s.O_ORDERDATE, t.O_ORDERPRIORITY = s.O_ORDERPRIORITY, t.O_CLERK = s.O_CLERK,
  t.O_SHIPPRIORITY = s.O_SHIPPRIORITY, t.O_COMMENT = s.O_COMMENT
WHEN NOT MATCHED AND s.METADATA$ACTION = 'INSERT' THEN INSERT
  VALUES (s.O_ORDERKEY, s.O_CUSTKEY, s.O_ORDERSTATUS, s.O_TOTALPRICE, s.O_ORDERDATE,
          s.O_ORDERPRIORITY, s.O_CLERK, s.O_SHIPPRIORITY, s.O_COMMENT);

-- Both should return 0 rows
SELECT * FROM COURSE_DB.CDC.ORDERS_SRC MINUS SELECT * FROM COURSE_DB.CDC.ORDERS_TGT;
SELECT * FROM COURSE_DB.CDC.ORDERS_TGT MINUS SELECT * FROM COURSE_DB.CDC.ORDERS_SRC;`,
      why: "<p>After filtering, each key appears at most once in the source: real deletes as DELETE, and inserts or the new half of updates as INSERT. The second WHEN MATCHED catches the INSERT-action rows for existing keys (updates). Some keys might be both updated and deleted (multiples of 97 and 101); the stream nets that to a single DELETE. A two-way MINUS is a quick equality proof for tables without duplicate rows. Note that <code>INSERT VALUES</code> without a column list relies on column order, which is fine for clones but fragile in general.</p>"
    },
    {
      level: "Hard",
      title: "SCD2 with only meaningful changes",
      hint: "Compare a hash of the tracked columns between the stream's DELETE and INSERT rows for the same key.",
      prompt: "<p>The SCD2 MERGE in the lesson creates a new version even when an update didn't change anything tracked (for example, someone reran an UPDATE that set the same values, or changed an untracked column like C_PHONE). Change it so only real changes to <code>C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL</code> create a new version.</p>",
      answer: `MERGE INTO COURSE_DB.CDC.DIM_CUSTOMER_HIST t
USING (
  WITH ins AS (
    SELECT *, HASH(C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL) AS h
    FROM COURSE_DB.CDC.CUSTOMER_STREAM_SCD2
    WHERE METADATA$ACTION = 'INSERT'
  ),
  del AS (
    SELECT C_CUSTKEY, HASH(C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL) AS h
    FROM COURSE_DB.CDC.CUSTOMER_STREAM_SCD2
    WHERE METADATA$ACTION = 'DELETE' AND METADATA$ISUPDATE
  ),
  changed AS (                         -- new keys, or updates where tracked values differ
    SELECT ins.*
    FROM ins
    LEFT JOIN del ON del.C_CUSTKEY = ins.C_CUSTKEY
    WHERE del.C_CUSTKEY IS NULL OR del.h <> ins.h
  )
  SELECT C_CUSTKEY AS merge_key, C_CUSTKEY, C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL,
         'UPSERT' AS op FROM changed
  UNION ALL
  SELECT NULL, C_CUSTKEY, C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL,
         'UPSERT' FROM changed
  WHERE C_CUSTKEY IN (SELECT C_CUSTKEY FROM del)          -- only real updates need a 2nd row
  UNION ALL
  SELECT C_CUSTKEY, C_CUSTKEY, C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL, 'DELETE'
  FROM COURSE_DB.CDC.CUSTOMER_STREAM_SCD2
  WHERE METADATA$ACTION = 'DELETE' AND NOT METADATA$ISUPDATE
) s
ON t.C_CUSTKEY = s.merge_key AND t.is_current
WHEN MATCHED THEN UPDATE SET t.valid_to = CURRENT_TIMESTAMP(), t.is_current = FALSE
WHEN NOT MATCHED AND s.op = 'UPSERT' THEN INSERT
  (C_CUSTKEY, C_NAME, C_ADDRESS, C_MKTSEGMENT, C_ACCTBAL, valid_from, valid_to, is_current)
  VALUES (s.C_CUSTKEY, s.C_NAME, s.C_ADDRESS, s.C_MKTSEGMENT, s.C_ACCTBAL,
          CURRENT_TIMESTAMP(), NULL, TRUE);`,
      why: "<p>For an update, the stream gives you the before image (DELETE, ISUPDATE) and the after image (INSERT). Hashing just the tracked columns on both sides and comparing tells you whether anything you care about changed. Unchanged updates fall out in <code>changed</code>, so they produce no MERGE rows at all, and the stream is still consumed because the MERGE reads it. New customers have no before image, so <code>del.C_CUSTKEY IS NULL</code> keeps them, and they get only one row (it won't match and gets inserted). Real updates get two rows: one closes the current version, the NULL-key copy inserts the new version. HASH can collide in theory; if you need certainty, compare the columns directly with IS DISTINCT FROM.</p>"
    },
    {
      level: "Hard",
      title: "Recover from a stale stream",
      prompt: "<p>A stream feeding <code>ORDERS_TGT</code> went stale over a long weekend because the consuming task was suspended. Describe a recovery that doesn't lose changes, and write the SQL. Assume ORDERS_SRC has 7 days of Time Travel and change tracking is on, and you know the time of the last successful MERGE.</p>",
      answer: `-- 1. Recreate the stream first, so no new changes are missed while you backfill.
--    Its offset starts now.
CREATE OR REPLACE STREAM COURSE_DB.CDC.ORDERS_SYNC ON TABLE COURSE_DB.CDC.ORDERS_SRC;
SET recreated_at = CURRENT_TIMESTAMP();
SET last_good    = '2026-11-07 02:00:00'::TIMESTAMP_LTZ;   -- last successful MERGE

-- 2. Apply the missed window with the CHANGES clause (same MERGE shape as the stream)
MERGE INTO COURSE_DB.CDC.ORDERS_TGT t
USING (
  SELECT * FROM COURSE_DB.CDC.ORDERS_SRC
    CHANGES (INFORMATION => DEFAULT)
    AT (TIMESTAMP => $last_good)
    END (TIMESTAMP => $recreated_at::TIMESTAMP_LTZ)
  WHERE NOT (METADATA$ACTION = 'DELETE' AND METADATA$ISUPDATE)
) s
ON t.O_ORDERKEY = s.O_ORDERKEY
WHEN MATCHED AND s.METADATA$ACTION = 'DELETE' THEN DELETE
WHEN MATCHED THEN UPDATE SET t.O_ORDERSTATUS = s.O_ORDERSTATUS, t.O_TOTALPRICE = s.O_TOTALPRICE
WHEN NOT MATCHED AND s.METADATA$ACTION = 'INSERT' THEN INSERT
  (O_ORDERKEY, O_CUSTKEY, O_ORDERSTATUS, O_TOTALPRICE, O_ORDERDATE)
  VALUES (s.O_ORDERKEY, s.O_CUSTKEY, s.O_ORDERSTATUS, s.O_TOTALPRICE, s.O_ORDERDATE);

-- 3. Resume the task. Its next run consumes the new stream from $recreated_at.
ALTER TASK COURSE_DB.CDC.ORDERS_SYNC_TASK RESUME;

-- 4. Prevent a repeat: alert on streams that are close to going stale
SHOW STREAMS IN SCHEMA COURSE_DB.CDC;
SELECT "name", "stale", "stale_after"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "stale_after" < DATEADD(day, 2, CURRENT_TIMESTAMP());`,
      why: "<p>The order of steps is the whole trick. Recreate the stream first so it starts collecting changes from a known timestamp. Then use CHANGES with an AT/END window to replay exactly the gap between the last good MERGE and that timestamp. No overlap, no gap. CHANGES works because change tracking is on and the window is inside Time Travel retention. If the outage were longer than retention, the only option is a full reconciliation: compare source and target (MINUS or hash by key) and fix differences. Then add monitoring on <code>stale_after</code> so it never gets that far again. A suspended consuming task is the most common cause of stale streams in real life.</p>"
    }
  ]
});
