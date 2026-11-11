window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "timetravel",
  num: "07",
  track: "Building in Snowflake",
  title: "Time Travel, Fail-safe and zero-copy cloning",
  summary: "Query the past, undo mistakes with UNDROP, understand what Fail-safe really protects, and use clones for dev environments, backups and safe deployments.",
  minutes: 45,
  level: "Intermediate",
  lessons: [
    {
      title: "Time Travel: querying the past",
      body: `
<p>Because micro-partitions are immutable, Snowflake can keep old versions of a table around for a retention period. During that window you can query, clone or restore data as it was at any point.</p>
<sql>
USE SCHEMA COURSE_DB.TPCH;

-- Make a mistake on purpose
SET before_mistake = CURRENT_TIMESTAMP();
UPDATE ORDERS SET O_ORDERSTATUS = 'X' WHERE O_ORDERDATE < '1993-01-01';
SET bad_query = LAST_QUERY_ID();

-- Look at the data before the update, three different ways
SELECT O_ORDERSTATUS, COUNT(*) FROM ORDERS AT (TIMESTAMP => $before_mistake::TIMESTAMP_LTZ) GROUP BY 1;
SELECT O_ORDERSTATUS, COUNT(*) FROM ORDERS AT (OFFSET => -60) GROUP BY 1;          -- 60 seconds ago
SELECT O_ORDERSTATUS, COUNT(*) FROM ORDERS BEFORE (STATEMENT => $bad_query) GROUP BY 1;
</sql>
<p><code>AT</code> includes changes made by a statement at that exact point. <code>BEFORE (STATEMENT => id)</code> gives you the state just before a specific query ran, which is the cleanest way to undo one bad statement.</p>
<sql>
-- Fix it: put the old rows back
INSERT OVERWRITE INTO ORDERS
SELECT * FROM ORDERS BEFORE (STATEMENT => $bad_query);
</sql>
<p><code>INSERT OVERWRITE</code> truncates and reloads in one transaction. For a huge table, a safer and cheaper move is to clone the old version and swap it in, which you'll see shortly.</p>
<p><b>Retention</b> is set with <code>DATA_RETENTION_TIME_IN_DAYS</code> on the account, database, schema or table. Defaults to 1. Standard edition maxes out at 1 day; Enterprise allows up to 90 days on permanent tables. Transient and temporary tables allow 0 or 1. Longer retention means more storage cost on tables that change a lot, because every replaced micro-partition is kept for the full period.</p>
`
    },
    {
      title: "UNDROP and Fail-safe",
      body: `
<p>Dropped tables, schemas and databases stay recoverable for their retention period:</p>
<sql>
DROP TABLE COURSE_DB.TPCH.REGION;
SHOW TABLES HISTORY LIKE 'REGION' IN SCHEMA COURSE_DB.TPCH;   -- see the dropped_on column
UNDROP TABLE COURSE_DB.TPCH.REGION;
</sql>
<p>If you've already created a new table with the same name, UNDROP fails. Rename the new one first, then UNDROP.</p>
<p>After Time Travel ends, permanent tables enter <b>Fail-safe</b>: 7 more days during which Snowflake itself can recover the data. You can't query Fail-safe data and you can't recover it yourself. You open a support case, and recovery is best effort and can take hours or days. It's a disaster safety net, not a backup strategy.</p>
<table>
<tr><th>Table type</th><th>Time Travel</th><th>Fail-safe</th><th>Total protection</th></tr>
<tr><td>Permanent (Standard)</td><td>0 or 1 day</td><td>7 days</td><td>Up to 8 days</td></tr>
<tr><td>Permanent (Enterprise+)</td><td>0 to 90 days</td><td>7 days</td><td>Up to 97 days</td></tr>
<tr><td>Transient</td><td>0 or 1 day</td><td>None</td><td>Up to 1 day</td></tr>
<tr><td>Temporary</td><td>0 or 1 day (ends with session)</td><td>None</td><td>Session only</td></tr>
</table>
<p>Snowflake also offers backups (snapshot sets with retention locks) for immutable, point-in-time copies that protect against ransomware or a malicious admin. Time Travel alone doesn't, because someone with enough privileges can set retention to 0.</p>
`
    },
    {
      title: "Zero-copy cloning",
      body: `
<p><code>CLONE</code> creates a new table, schema or database that points at the same micro-partitions as the source. Nothing is copied, so it's nearly instant and free at first. You pay only for micro-partitions that change in either object afterwards.</p>
<sql>
-- A full dev copy of the course database in seconds
CREATE DATABASE COURSE_DB_DEV CLONE COURSE_DB;

-- A clone of a table as it was an hour ago (combines cloning with Time Travel)
CREATE TABLE COURSE_DB.TPCH.ORDERS_1H_AGO CLONE COURSE_DB.TPCH.ORDERS AT (OFFSET => -3600);
</sql>
<p>What clones carry and what they don't:</p>
<ul>
<li>Cloning a database or schema clones everything inside it, and child objects keep their grants. The top-level clone itself does not inherit the source's grants unless you clone with <code>COPY GRANTS</code> (tables) or re-grant.</li>
<li>Internal named stages aren't cloned when you clone a database or schema. External stages are.</li>
<li>Pipes that point at internal stages aren't cloned. Pipes on external stages are cloned but paused.</li>
<li>Streams in a cloned database start fresh: unconsumed records in the source stream aren't visible in the clone.</li>
<li>Tasks are cloned but suspended. You must resume them, which is a good thing: a dev clone shouldn't start writing on its own.</li>
</ul>
<p><b>The swap pattern</b> is how you deploy a rebuilt table with no downtime:</p>
<sql>
CREATE OR REPLACE TABLE COURSE_DB.TPCH.CUSTOMER_NEW CLONE COURSE_DB.TPCH.CUSTOMER;
-- ... transform CUSTOMER_NEW, test it ...
ALTER TABLE COURSE_DB.TPCH.CUSTOMER SWAP WITH COURSE_DB.TPCH.CUSTOMER_NEW;   -- atomic rename of both
</sql>
<p><code>SWAP WITH</code> exchanges the two names in one metadata operation. Readers go straight from the old version to the new one. If something's wrong, swap back.</p>
`
    }
  ],
  quiz: [
    {
      q: "A teammate ran a bad DELETE 20 minutes ago. Which query gives you the table exactly as it was right before that statement?",
      options: [
        "SELECT * FROM t AT (OFFSET => -1200)",
        "SELECT * FROM t BEFORE (STATEMENT => '&lt;delete query id&gt;')",
        "SELECT * FROM t CHANGES (INFORMATION => DEFAULT)",
        "UNDROP TABLE t"
      ],
      answer: 1,
      why: "<p>BEFORE with the statement's query ID is exact. An OFFSET of 20 minutes might land after other good changes or slightly before the delete. UNDROP is only for dropped objects.</p>"
    },
    {
      q: "What is the maximum Time Travel retention on a permanent table in Enterprise edition?",
      options: ["1 day", "7 days", "90 days", "365 days"],
      answer: 2,
      why: "<p>90 days on Enterprise and above. Standard edition is limited to 1 day. Transient and temporary tables are limited to 1 day on any edition.</p>"
    },
    {
      q: "Data in Fail-safe can be...",
      options: [
        "Queried with AT (TIMESTAMP => ...)",
        "Restored with UNDROP",
        "Recovered only by Snowflake support, on a best-effort basis",
        "Cloned to a new table"
      ],
      answer: 2,
      why: "<p>Fail-safe is invisible to customers. Only Snowflake can recover from it, and it's meant for disasters. Plan your own recovery around Time Travel, clones and backups.</p>"
    },
    {
      q: "You clone a 5 TB table. What do you pay for in storage immediately afterwards?",
      options: [
        "Another 5 TB",
        "Nothing extra until either table changes",
        "Half, 2.5 TB",
        "The clone is billed as compute, not storage"
      ],
      answer: 1,
      why: "<p>The clone shares micro-partitions with the source. Only new or changed partitions in either table add storage. Cloning is why spinning up full dev and test environments in Snowflake is cheap.</p>"
    },
    {
      q: "You clone a database that contains tasks. What state are the cloned tasks in?",
      options: ["Running on the source schedule", "Suspended", "Dropped", "Converted to stored procedures"],
      answer: 1,
      why: "<p>Cloned tasks are suspended so a clone doesn't start running pipelines by surprise. You resume them deliberately, ideally after pointing them at the right warehouse and targets.</p>"
    },
    {
      q: "What does <code>ALTER TABLE a SWAP WITH b</code> do?",
      options: [
        "Copies b's data into a",
        "Atomically exchanges the names of a and b",
        "Merges rows from b into a",
        "Creates a clone of b named a"
      ],
      answer: 1,
      why: "<p>SWAP is a metadata operation that renames both tables in one transaction. It's the standard blue/green deployment trick for tables: build the new version alongside, test it, swap.</p>"
    },
    {
      q: "Why doesn't long Time Travel retention protect you against a malicious admin?",
      options: [
        "Time Travel data is stored in a different region",
        "Someone with enough privileges can lower retention or drop and purge objects",
        "Time Travel only works on transient tables",
        "Admins can't see Time Travel data"
      ],
      answer: 1,
      why: "<p>Retention is just a parameter. An attacker with OWNERSHIP or ACCOUNTADMIN can set it to 0. Protection against that needs controls the attacker can't change, such as backups with retention locks, replication to another account, and tight control of powerful roles.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Undo a delete",
      prompt: "<p>In COURSE_DB.TPCH, delete every NATION row in region 0 (AFRICA). Then restore them using Time Travel without UNDROP.</p>",
      answer: `DELETE FROM COURSE_DB.TPCH.NATION WHERE N_REGIONKEY = 0;
SET del_id = LAST_QUERY_ID();

INSERT INTO COURSE_DB.TPCH.NATION
SELECT * FROM COURSE_DB.TPCH.NATION BEFORE (STATEMENT => $del_id)
WHERE N_REGIONKEY = 0;

SELECT COUNT(*) FROM COURSE_DB.TPCH.NATION;   -- 25 again`,
      why: "<p>Capturing <code>LAST_QUERY_ID()</code> right after the mistake gives you a precise restore point. Inserting only the affected rows is better than overwriting the whole table, because it doesn't undo any other changes made since. If you didn't save the ID, find it in Query History.</p>"
    },
    {
      level: "Easy",
      title: "Recover a dropped table",
      prompt: "<p>Drop <code>COURSE_DB.TPCH.REGION</code>, create a new empty table with the same name, then get the original back with its data.</p>",
      answer: `DROP TABLE COURSE_DB.TPCH.REGION;
CREATE TABLE COURSE_DB.TPCH.REGION (R_REGIONKEY NUMBER, R_NAME STRING, R_COMMENT STRING);

-- UNDROP would fail now because the name is taken. Move the new one aside first.
ALTER TABLE COURSE_DB.TPCH.REGION RENAME TO COURSE_DB.TPCH.REGION_EMPTY;
UNDROP TABLE COURSE_DB.TPCH.REGION;
DROP TABLE COURSE_DB.TPCH.REGION_EMPTY;

SELECT COUNT(*) FROM COURSE_DB.TPCH.REGION;   -- 5`,
      why: "<p>UNDROP restores the most recently dropped version with that name, and only if the name is free. <code>SHOW TABLES HISTORY</code> lists every dropped version. If a table was dropped and recreated several times, each UNDROP brings back the next most recent one.</p>"
    },
    {
      level: "Medium",
      title: "Compare two points in time",
      hint: "Use MINUS between an AT query and the current table, in both directions.",
      prompt: "<p>Update the account balance of 10 customers. Then write a query that shows exactly which rows changed in the last 10 minutes, with old and new balance side by side.</p>",
      answer: `UPDATE COURSE_DB.TPCH.CUSTOMER
SET C_ACCTBAL = C_ACCTBAL + 100
WHERE C_CUSTKEY BETWEEN 1 AND 10;

SELECT cur.C_CUSTKEY,
       old.C_ACCTBAL AS old_balance,
       cur.C_ACCTBAL AS new_balance
FROM COURSE_DB.TPCH.CUSTOMER cur
JOIN COURSE_DB.TPCH.CUSTOMER AT (OFFSET => -600) old
  ON old.C_CUSTKEY = cur.C_CUSTKEY
WHERE old.C_ACCTBAL IS DISTINCT FROM cur.C_ACCTBAL
ORDER BY cur.C_CUSTKEY;`,
      why: "<p>You can join a table to an older version of itself. <code>IS DISTINCT FROM</code> treats NULLs as comparable values, so a change from NULL to 5 is caught (a plain <code>&lt;&gt;</code> would miss it). This is a quick way to audit what a job did. For many columns, <code>HASH(*)</code> comparisons scale better than comparing each column. For inserts and deletes, use a FULL OUTER JOIN or the CHANGES clause from the next module.</p>"
    },
    {
      level: "Medium",
      title: "A dev environment in one statement",
      prompt: "<p>Create a dev copy of COURSE_DB as it was 30 minutes ago, give the dev role access, and explain what it costs.</p>",
      answer: `USE ROLE SYSADMIN;
CREATE OR REPLACE DATABASE COURSE_DB_DEV CLONE COURSE_DB AT (OFFSET => -1800);

-- Grants on the cloned database itself are not inherited; grant the dev role access
CREATE ROLE IF NOT EXISTS DEV_ENGINEER;
GRANT USAGE ON DATABASE COURSE_DB_DEV TO ROLE DEV_ENGINEER;
GRANT USAGE ON ALL SCHEMAS IN DATABASE COURSE_DB_DEV TO ROLE DEV_ENGINEER;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN DATABASE COURSE_DB_DEV TO ROLE DEV_ENGINEER;`,
      why: "<p>The clone shares storage with COURSE_DB, so it costs nothing until someone modifies data in either database. The point-in-time clone needs Time Travel data for every object, so it fails if any object's retention doesn't cover 30 minutes ago, for example a transient table with retention 0. Grants on child objects come across with the clone, but the new database's own privileges have to be granted. A real setup would put those grants in a script or Terraform so every refresh looks the same.</p>"
    },
    {
      level: "Hard",
      title: "Restore a 5 TB table fast",
      hint: "Avoid rewriting data. Clone the old version and swap.",
      prompt: "<p>A bad MERGE corrupted a 5 TB fact table two hours ago. Since then, a few small good loads have also happened. Describe and write the fastest, cheapest recovery that keeps the good loads. Use <code>COURSE_DB.TPCH.LINEITEM</code> to stand in for the fact table.</p>",
      answer: `-- 1. Clone the table as it was just before the bad MERGE (instant, no data copied)
CREATE TABLE COURSE_DB.TPCH.LINEITEM_RESTORE
  CLONE COURSE_DB.TPCH.LINEITEM BEFORE (STATEMENT => '<bad merge query id>');

-- 2. Replay the good loads that happened after the MERGE onto the restored copy.
--    Find them in query history, or recompute the delta:
INSERT INTO COURSE_DB.TPCH.LINEITEM_RESTORE
SELECT * FROM COURSE_DB.TPCH.LINEITEM
  CHANGES (INFORMATION => APPEND_ONLY)
  AT (STATEMENT => '<first good load query id>');
-- (needs CHANGE_TRACKING = TRUE on the table; otherwise rerun the load jobs)

-- 3. Validate, then swap atomically
SELECT COUNT(*), SUM(L_QUANTITY) FROM COURSE_DB.TPCH.LINEITEM_RESTORE;
ALTER TABLE COURSE_DB.TPCH.LINEITEM SWAP WITH COURSE_DB.TPCH.LINEITEM_RESTORE;

-- 4. Keep the corrupted version (now named LINEITEM_RESTORE) for the post-mortem, then drop it`,
      why: "<p>An <code>INSERT OVERWRITE ... SELECT ... BEFORE(...)</code> would rewrite 5 TB, which takes a long time on a big warehouse and creates 5 TB of new micro-partitions plus Time Travel on the old ones. A clone is metadata only. Replaying just the small good loads adds a little data, and SWAP makes the switch atomic, so readers never see a half-restored table. Keeping the corrupted copy around gives you evidence for the incident review, and you can drop it once you're done. The general lesson: in Snowflake, recovery is usually a metadata operation if you plan for it.</p>"
    }
  ]
});
