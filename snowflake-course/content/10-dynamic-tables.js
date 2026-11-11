window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "dynamic",
  num: "10",
  track: "Pipelines and CDC",
  title: "Dynamic tables",
  summary: "Declarative pipelines: write the SELECT, set a target lag, and let Snowflake keep the result fresh. Refresh modes, DOWNSTREAM lag, monitoring, and when to pick dynamic tables over streams and tasks.",
  minutes: 55,
  level: "Intermediate to advanced",
  lessons: [
    {
      title: "What a dynamic table is",
      body: `
<p>A <b>dynamic table</b> is a table defined by a query. You say what the result should be and how fresh it must be, and Snowflake works out when and how to refresh it. No streams, no MERGE, no task graph to maintain.</p>
<sql>
USE ROLE SYSADMIN;
USE WAREHOUSE COURSE_WH;
CREATE SCHEMA IF NOT EXISTS COURSE_DB.DT;
USE SCHEMA COURSE_DB.DT;

-- Source tables we can change (dynamic tables need change tracking on their sources;
-- Snowflake turns it on automatically if the creating role owns them)
CREATE OR REPLACE TABLE ORDERS   CLONE COURSE_DB.TPCH.ORDERS;
CREATE OR REPLACE TABLE LINEITEM CLONE COURSE_DB.TPCH.LINEITEM;
CREATE OR REPLACE TABLE CUSTOMER CLONE COURSE_DB.TPCH.CUSTOMER;

CREATE OR REPLACE DYNAMIC TABLE ORDER_REVENUE
  TARGET_LAG = '10 minutes'
  WAREHOUSE  = COURSE_WH
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
SELECT o.O_ORDERKEY, o.O_CUSTKEY, o.O_ORDERDATE,
       SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS net_revenue,
       COUNT(*)                                    AS line_count
FROM ORDERS o
JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
GROUP BY o.O_ORDERKEY, o.O_CUSTKEY, o.O_ORDERDATE;

SELECT * FROM ORDER_REVENUE WHERE O_ORDERKEY = 1;
</sql>
<p>The parameters:</p>
<table>
<tr><th>Parameter</th><th>Meaning</th></tr>
<tr><td><code>TARGET_LAG</code></td><td>How stale the table may get relative to its sources. A duration (minimum 1 minute) or <code>DOWNSTREAM</code>.</td></tr>
<tr><td><code>WAREHOUSE</code></td><td>The warehouse that runs refreshes</td></tr>
<tr><td><code>REFRESH_MODE</code></td><td>AUTO (default), INCREMENTAL or FULL</td></tr>
<tr><td><code>INITIALIZE</code></td><td>ON_CREATE fills it immediately; ON_SCHEDULE waits for the first scheduled refresh</td></tr>
</table>
<p>You can't INSERT, UPDATE or DELETE a dynamic table directly. Its contents always come from its query.</p>
`
    },
    {
      title: "Incremental vs full refresh",
      body: `
<p>This is where dynamic tables earn their keep. In <b>incremental</b> mode, Snowflake works out which source rows changed since the last refresh and updates only the affected result rows. In <b>full</b> mode, it reruns the whole query and replaces the contents.</p>
<p>With <code>REFRESH_MODE = AUTO</code>, Snowflake chooses at creation time. Check what it picked and why:</p>
<sql>
SHOW DYNAMIC TABLES IN SCHEMA COURSE_DB.DT;
SELECT "name", "refresh_mode", "refresh_mode_reason", "target_lag", "scheduling_state"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
</sql>
<p>Most of what you'd write supports incremental refresh: projections, filters, inner and outer joins, GROUP BY aggregates, UNION ALL, many window functions, and FLATTEN. Things that often force full refresh include some non-deterministic functions, certain window and set operations, and sources that don't support change tracking. The exact list grows with each release, so read <code>refresh_mode_reason</code> rather than memorising it.</p>
<div class="tip"><b>Pin the mode in production</b>AUTO is convenient, but if a later edit to the query quietly flips a table from incremental to full, your costs can jump 50x overnight. Set <code>REFRESH_MODE = INCREMENTAL</code> explicitly on tables that must stay incremental. Creation then fails loudly if the query can't be refreshed incrementally.</div>
<p>When is full refresh fine? Small tables, or queries where most rows change every refresh anyway. Incremental refresh has overhead, and if 80% of the result changes each time, a full rebuild can be cheaper.</p>
`
    },
    {
      title: "Chaining dynamic tables and DOWNSTREAM lag",
      body: `
<p>Dynamic tables can read from other dynamic tables, which builds a pipeline. Snowflake understands the whole graph and refreshes it in order, with consistent snapshots: a downstream table never sees a half-refreshed upstream one.</p>
<sql>
-- Layer 2: enrich with the customer segment
CREATE OR REPLACE DYNAMIC TABLE ORDER_REVENUE_ENRICHED
  TARGET_LAG = DOWNSTREAM
  WAREHOUSE  = COURSE_WH
AS
SELECT r.*, c.C_MKTSEGMENT, c.C_NATIONKEY
FROM ORDER_REVENUE r
JOIN CUSTOMER c ON c.C_CUSTKEY = r.O_CUSTKEY;

-- Layer 3: what the dashboard reads
CREATE OR REPLACE DYNAMIC TABLE SEGMENT_MONTHLY
  TARGET_LAG = '30 minutes'
  WAREHOUSE  = COURSE_WH
AS
SELECT C_MKTSEGMENT,
       DATE_TRUNC('month', O_ORDERDATE) AS month,
       SUM(net_revenue)                 AS revenue,
       COUNT(*)                         AS orders
FROM ORDER_REVENUE_ENRICHED
GROUP BY ALL;
</sql>
<p><code>TARGET_LAG = DOWNSTREAM</code> means "refresh me only when something downstream needs me". ORDER_REVENUE_ENRICHED has no schedule of its own; it refreshes whenever SEGMENT_MONTHLY needs fresh data. The usual design: put a time-based lag only on the tables people actually query, and DOWNSTREAM on everything in between. That avoids paying to refresh intermediate tables more often than anyone reads them.</p>
<p>Lag isn't a schedule. Snowflake picks refresh times to keep each table within its target lag, and aligns refreshes across the graph so they share snapshots. A 30-minute lag may mean refreshes every 15 minutes or so, depending on how long each refresh takes.</p>
`
    },
    {
      title: "Operating dynamic tables",
      body: `
<sql>
-- Refresh history: status, duration, rows changed, and why a refresh happened
SELECT NAME, STATE, REFRESH_ACTION, REFRESH_TRIGGER,
       DATA_TIMESTAMP, REFRESH_START_TIME, REFRESH_END_TIME,
       STATISTICS:numInsertedRows::NUMBER AS inserted,
       STATISTICS:numDeletedRows::NUMBER  AS deleted,
       STATE_MESSAGE
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
       NAME_PREFIX => 'COURSE_DB.DT.'))
ORDER BY REFRESH_START_TIME DESC;

-- The dependency graph
SELECT NAME, INPUTS, TARGET_LAG_TYPE, TARGET_LAG_SEC, SCHEDULING_STATE
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.DYNAMIC_TABLE_GRAPH_HISTORY());

-- Manual control
ALTER DYNAMIC TABLE SEGMENT_MONTHLY REFRESH;     -- refresh now (and upstream as needed)
ALTER DYNAMIC TABLE SEGMENT_MONTHLY SUSPEND;     -- stop scheduled refreshes
ALTER DYNAMIC TABLE SEGMENT_MONTHLY RESUME;
ALTER DYNAMIC TABLE SEGMENT_MONTHLY SET TARGET_LAG = '1 hour';
</sql>
<p><code>REFRESH_ACTION</code> tells you what each refresh did: NO_DATA (nothing changed upstream, almost free), INCREMENTAL, FULL or REINITIALIZE. A table that should be incremental but shows FULL refreshes is a cost problem to investigate.</p>
<p>Snowsight shows the graph under the dynamic table's <b>Graph</b> tab, with lag and refresh status per node. Refreshes that fail several times in a row get the table suspended automatically, so alert on failures the same way you would for tasks.</p>
<h3>Which tool when?</h3>
<table>
<tr><th>Need</th><th>Reach for</th></tr>
<tr><td>Transform data with joins/aggregations and keep it fresh within minutes</td><td>Dynamic tables</td></tr>
<tr><td>Precompute an aggregate on one table that's queried constantly</td><td>Materialized view (always current, can be used by query rewrite)</td></tr>
<tr><td>Procedural logic, calling external functions, sending notifications, non-SQL steps, exact control over when things run</td><td>Streams and tasks</td></tr>
<tr><td>SCD Type 2 with precise valid_from/valid_to semantics</td><td>Streams and tasks (MERGE), or a carefully designed dynamic table</td></tr>
<tr><td>Sub-minute latency</td><td>Snowpipe Streaming into a table, queried directly</td></tr>
</table>
`
    }
  ],
  quiz: [
    {
      q: "What does <code>TARGET_LAG = '10 minutes'</code> promise?",
      options: [
        "The table refreshes exactly every 10 minutes",
        "Snowflake aims to keep the table's data no more than 10 minutes behind its sources",
        "Each refresh may take at most 10 minutes",
        "Queries on the table are cached for 10 minutes"
      ],
      answer: 1,
      why: "<p>Target lag is a freshness goal, not a cron schedule. Snowflake plans refreshes so that the data stays within that lag, taking refresh duration and upstream tables into account.</p>"
    },
    {
      q: "An intermediate dynamic table is only read by other dynamic tables. Which lag setting usually makes sense?",
      options: ["1 minute", "DOWNSTREAM", "24 hours", "It must match the source table"],
      answer: 1,
      why: "<p>DOWNSTREAM refreshes the table only when a consumer needs it. Putting time-based lags on intermediate tables makes them refresh on their own clocks, often more than necessary.</p>"
    },
    {
      q: "Can you run <code>UPDATE</code> on a dynamic table to fix a bad row?",
      options: [
        "Yes, like any table",
        "No, contents come only from the defining query; fix the source or the query",
        "Only with ACCOUNTADMIN",
        "Only when the table is suspended"
      ],
      answer: 1,
      why: "<p>Dynamic tables are read-only to DML. Correct the source data or change the definition, then refresh.</p>"
    },
    {
      q: "Why pin <code>REFRESH_MODE = INCREMENTAL</code> instead of leaving AUTO in production?",
      options: [
        "INCREMENTAL is always cheaper for every query",
        "So a future query change that can't be incremental fails at creation instead of silently switching to expensive full refreshes",
        "AUTO is deprecated",
        "INCREMENTAL allows DML on the table"
      ],
      answer: 1,
      why: "<p>AUTO picks a mode when the table is created. A small edit could flip it to FULL with no error. Pinning makes that a visible failure you can review.</p>"
    },
    {
      q: "Refresh history shows <code>REFRESH_ACTION = NO_DATA</code>. What happened?",
      options: [
        "The refresh failed",
        "No upstream data changed, so nothing needed doing",
        "The table was truncated",
        "The warehouse was suspended"
      ],
      answer: 1,
      why: "<p>NO_DATA refreshes are the system checking and finding nothing new. They cost very little. Lots of FULL refreshes on a big table is what deserves attention.</p>"
    },
    {
      q: "Which requirement is the strongest reason to use streams and tasks instead of a dynamic table?",
      options: [
        "A three-way join refreshed every 15 minutes",
        "A step that calls an external API and sends an email based on the results",
        "An aggregation by month",
        "Reading from another dynamic table"
      ],
      answer: 1,
      why: "<p>Dynamic tables are a single SQL query. Procedural logic, side effects like notifications, and calls to external systems belong in tasks and stored procedures.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Your first dynamic table",
      prompt: "<p>In <code>COURSE_DB.DT</code>, create a dynamic table <code>CUSTOMER_ORDER_COUNTS</code> with each customer's number of orders and total spend, a 5-minute target lag, using COURSE_WH. Check which refresh mode it got.</p>",
      answer: `CREATE OR REPLACE DYNAMIC TABLE COURSE_DB.DT.CUSTOMER_ORDER_COUNTS
  TARGET_LAG = '5 minutes'
  WAREHOUSE = COURSE_WH
AS
SELECT O_CUSTKEY, COUNT(*) AS orders, SUM(O_TOTALPRICE) AS spend
FROM COURSE_DB.DT.ORDERS
GROUP BY O_CUSTKEY;

SHOW DYNAMIC TABLES LIKE 'CUSTOMER_ORDER_COUNTS' IN SCHEMA COURSE_DB.DT;
SELECT "refresh_mode", "refresh_mode_reason" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));`,
      why: "<p>A simple GROUP BY over one table is a textbook incremental query, so AUTO should pick INCREMENTAL. When an order is added, only that customer's row gets recomputed. Remember a 5-minute lag means the warehouse may wake up often, so pick lags based on how fresh people actually need the data.</p>"
    },
    {
      level: "Easy",
      title: "Watch it refresh",
      prompt: "<p>Insert a new order for customer 1 into <code>COURSE_DB.DT.ORDERS</code>. Force a refresh of <code>CUSTOMER_ORDER_COUNTS</code> and confirm that customer 1's count went up. Then find that refresh in the history and see how many rows it changed.</p>",
      answer: `INSERT INTO COURSE_DB.DT.ORDERS
SELECT 9000001, 1, 'O', 500, '1998-08-02', '1-URGENT', 'Clerk#000000001', 0, 'test';

ALTER DYNAMIC TABLE COURSE_DB.DT.CUSTOMER_ORDER_COUNTS REFRESH;

SELECT * FROM COURSE_DB.DT.CUSTOMER_ORDER_COUNTS WHERE O_CUSTKEY = 1;

SELECT REFRESH_ACTION, REFRESH_TRIGGER,
       STATISTICS:numInsertedRows::NUMBER AS ins,
       STATISTICS:numDeletedRows::NUMBER  AS del
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
       NAME => 'COURSE_DB.DT.CUSTOMER_ORDER_COUNTS'))
ORDER BY REFRESH_START_TIME DESC
LIMIT 1;`,
      why: "<p>REFRESH_TRIGGER should be MANUAL and REFRESH_ACTION INCREMENTAL. You'll typically see 1 inserted and 1 deleted row: incremental refresh replaces customer 1's old aggregate row with a new one. That tiny change set, instead of 100,000 rows, is the whole point of incremental mode.</p>"
    },
    {
      level: "Medium",
      title: "A three-layer pipeline",
      hint: "Use DOWNSTREAM for the middle layer.",
      prompt: "<p>Build: (1) <code>DT_LINE_NET</code> with net revenue per line item joined to the order date, (2) <code>DT_NATION_DAILY</code> with revenue per nation per day (via CUSTOMER and NATION), (3) <code>DT_NATION_MONTHLY</code> that the BI team reads, with a 1-hour lag. Use DOWNSTREAM where it makes sense.</p>",
      answer: `CREATE OR REPLACE TABLE COURSE_DB.DT.NATION CLONE COURSE_DB.TPCH.NATION;

CREATE OR REPLACE DYNAMIC TABLE COURSE_DB.DT.DT_LINE_NET
  TARGET_LAG = DOWNSTREAM WAREHOUSE = COURSE_WH REFRESH_MODE = INCREMENTAL AS
SELECT l.L_ORDERKEY, l.L_LINENUMBER, o.O_CUSTKEY, o.O_ORDERDATE,
       l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT) AS net
FROM COURSE_DB.DT.LINEITEM l
JOIN COURSE_DB.DT.ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY;

CREATE OR REPLACE DYNAMIC TABLE COURSE_DB.DT.DT_NATION_DAILY
  TARGET_LAG = DOWNSTREAM WAREHOUSE = COURSE_WH REFRESH_MODE = INCREMENTAL AS
SELECT n.N_NAME AS nation, d.O_ORDERDATE AS day, SUM(d.net) AS revenue
FROM COURSE_DB.DT.DT_LINE_NET d
JOIN COURSE_DB.DT.CUSTOMER c ON c.C_CUSTKEY = d.O_CUSTKEY
JOIN COURSE_DB.DT.NATION n   ON n.N_NATIONKEY = c.C_NATIONKEY
GROUP BY ALL;

CREATE OR REPLACE DYNAMIC TABLE COURSE_DB.DT.DT_NATION_MONTHLY
  TARGET_LAG = '1 hour' WAREHOUSE = COURSE_WH AS
SELECT nation, DATE_TRUNC('month', day) AS month, SUM(revenue) AS revenue
FROM COURSE_DB.DT.DT_NATION_DAILY
GROUP BY ALL;`,
      why: "<p>Only the table people read has a time-based lag. The two upstream tables are DOWNSTREAM, so they refresh when DT_NATION_MONTHLY needs them and stay in sync with it. Pinning INCREMENTAL on the big upstream tables protects you from accidental full rebuilds of 6 million line items. The top table is small, so AUTO is fine there. Look at the Graph tab in Snowsight to see the three layers and their sources.</p>"
    },
    {
      level: "Medium",
      title: "Why is it full refresh?",
      prompt: "<p>Create a dynamic table that ranks each customer's orders by price with a window function, plus a column using <code>RANDOM()</code>. Check the refresh mode and reason. Then fix the query so it can be incremental and explain the change.</p>",
      answer: `CREATE OR REPLACE DYNAMIC TABLE COURSE_DB.DT.ORDER_RANK
  TARGET_LAG = '1 hour' WAREHOUSE = COURSE_WH REFRESH_MODE = AUTO AS
SELECT O_CUSTKEY, O_ORDERKEY, O_TOTALPRICE,
       RANK() OVER (PARTITION BY O_CUSTKEY ORDER BY O_TOTALPRICE DESC) AS price_rank,
       RANDOM() AS sample_key
FROM COURSE_DB.DT.ORDERS;

SHOW DYNAMIC TABLES LIKE 'ORDER_RANK' IN SCHEMA COURSE_DB.DT;
SELECT "refresh_mode", "refresh_mode_reason" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- Fix: replace the non-deterministic function with a deterministic one
CREATE OR REPLACE DYNAMIC TABLE COURSE_DB.DT.ORDER_RANK
  TARGET_LAG = '1 hour' WAREHOUSE = COURSE_WH REFRESH_MODE = INCREMENTAL AS
SELECT O_CUSTKEY, O_ORDERKEY, O_TOTALPRICE,
       RANK() OVER (PARTITION BY O_CUSTKEY ORDER BY O_TOTALPRICE DESC) AS price_rank,
       ABS(HASH(O_ORDERKEY)) % 100 AS sample_key
FROM COURSE_DB.DT.ORDERS;`,
      why: "<p>RANDOM() gives a different value every time it runs, so Snowflake can't update just the changed rows and still have a consistent result. That pushes the table to FULL refresh, and with REFRESH_MODE = INCREMENTAL it would refuse to create. The fix is a deterministic substitute: hashing the key gives a stable pseudo-random bucket that only changes if the key changes. Window functions partitioned by a key, like this RANK, can be refreshed incrementally per partition. Always read <code>refresh_mode_reason</code>; it names the construct that blocked incremental mode.</p>"
    },
    {
      level: "Hard",
      title: "Replace a stream-and-task pipeline",
      prompt: "<p>Module 08 kept <code>DIM_CUSTOMER_CURRENT</code> in sync with <code>CUSTOMER_SRC</code> using a stream, a MERGE and a task. Replace it with a dynamic table. Then explain what you gain, what you lose, and how you'd migrate in production without readers noticing.</p>",
      answer: `-- The whole pipeline becomes one statement
CREATE OR REPLACE DYNAMIC TABLE COURSE_DB.CDC.DIM_CUSTOMER_CURRENT_DT
  TARGET_LAG = '5 minutes'
  WAREHOUSE  = COURSE_WH
  REFRESH_MODE = INCREMENTAL
AS
SELECT c.C_CUSTKEY, c.C_NAME, c.C_ADDRESS, c.C_NATIONKEY, c.C_PHONE,
       c.C_ACCTBAL, c.C_MKTSEGMENT
FROM COURSE_DB.CDC.CUSTOMER_SRC c;

-- Migration: run both side by side, compare, then cut over
SELECT * FROM COURSE_DB.CDC.DIM_CUSTOMER_CURRENT
MINUS
SELECT * FROM COURSE_DB.CDC.DIM_CUSTOMER_CURRENT_DT;      -- expect 0 rows (and the reverse)

-- Cut over with a view so consumers don't change their SQL
CREATE OR REPLACE VIEW COURSE_DB.CDC.V_DIM_CUSTOMER COPY GRANTS AS
SELECT * FROM COURSE_DB.CDC.DIM_CUSTOMER_CURRENT_DT;

-- Retire the old pipeline: suspend whichever task ran the customer MERGE, then drop its stream
-- ALTER TASK COURSE_DB.CDC.<customer_merge_task> SUSPEND;
DROP STREAM IF EXISTS COURSE_DB.CDC.CUSTOMER_STREAM_MERGE;`,
      why: "<p><b>Gains:</b> one declarative statement instead of a stream, a MERGE with tricky ISUPDATE handling, and a task; no stale-stream risk; built-in lineage, lag monitoring and consistent snapshots across layers; backfills are just a refresh. <b>Losses:</b> less control over exact refresh timing; no procedural logic or side effects; history-keeping patterns like SCD2 are harder to express (a dynamic table shows current state of a query, it doesn't remember past versions on its own). <b>Migration:</b> build the dynamic table next to the old one, reconcile them with MINUS in both directions for a few days, then point a stable view (the contract consumers use) at the new table and retire the old pipeline. Putting consumers behind views from day one makes these swaps painless.</p>"
    }
  ]
});
