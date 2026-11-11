window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "warehouses",
  num: "11",
  track: "Performance and Operations",
  title: "Virtual warehouses and cost control",
  summary: "Sizing, scaling up versus out, multi-cluster policies, auto-suspend trade-offs, resource monitors and timeouts. Measured on the bigger TPC-H scale factors.",
  minutes: 55,
  level: "Intermediate to advanced",
  edition: "Multi-cluster needs Enterprise",
  lessons: [
    {
      title: "Sizes, credits and what bigger actually buys",
      body: `
<table>
<tr><th>Size</th><th>Credits / hour</th><th>Relative compute</th></tr>
<tr><td>X-Small</td><td>1</td><td>1x</td></tr>
<tr><td>Small</td><td>2</td><td>2x</td></tr>
<tr><td>Medium</td><td>4</td><td>4x</td></tr>
<tr><td>Large</td><td>8</td><td>8x</td></tr>
<tr><td>X-Large</td><td>16</td><td>16x</td></tr>
<tr><td>2X-Large</td><td>32</td><td>32x</td></tr>
<tr><td>3X-Large</td><td>64</td><td>64x</td></tr>
<tr><td>4X-Large</td><td>128</td><td>128x</td></tr>
<tr><td>5X-Large / 6X-Large</td><td>256 / 512</td><td>256x / 512x</td></tr>
</table>
<p>Each size up doubles both the compute and the price per hour. So if a query parallelizes well, doubling the size halves the run time and the cost stays the same. You get the answer faster for free. If it doesn't parallelize (small data, a single-threaded step, one huge file), doubling the size just doubles the bill.</p>
<p>A bigger warehouse also has more memory and local disk. That matters for queries that <b>spill</b>: when a sort, join or aggregation doesn't fit in memory, data overflows to local disk and then to remote storage, which is very slow. Sizing up to stop remote spilling can make a query 10x faster.</p>
<p>Other warehouse types you'll meet: <b>Snowpark-optimized</b> warehouses have much more memory per node for ML training and big Python UDFs, and newer generation standard warehouses (Gen2) run on faster hardware at a different credit rate. Check what your account offers with <code>SHOW WAREHOUSES</code> and the docs for your region.</p>
<div class="note"><b>Scale up vs scale out</b>Scale <b>up</b> (bigger size) to make individual heavy queries faster. Scale <b>out</b> (more clusters) to handle more concurrent queries. They solve different problems, and mixing them up is the most common warehouse mistake.</div>
`
    },
    {
      title: "Measuring it on TPC-H",
      body: `
<p>The sample data has bigger scale factors so you can see the effect for real. TPC-H Query 1 on <code>TPCH_SF100</code> scans about 600 million lineitems.</p>
<sql>
USE ROLE SYSADMIN;
CREATE WAREHOUSE IF NOT EXISTS BENCH_WH WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 INITIALLY_SUSPENDED = TRUE;
USE WAREHOUSE BENCH_WH;
ALTER SESSION SET USE_CACHED_RESULT = FALSE;
ALTER SESSION SET QUERY_TAG = 'bench-xs';

SELECT L_RETURNFLAG, L_LINESTATUS,
       SUM(L_QUANTITY), SUM(L_EXTENDEDPRICE),
       SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)),
       SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT) * (1 + L_TAX)),
       AVG(L_QUANTITY), AVG(L_DISCOUNT), COUNT(*)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.LINEITEM
WHERE L_SHIPDATE <= '1998-09-02'
GROUP BY 1, 2 ORDER BY 1, 2;

ALTER WAREHOUSE BENCH_WH SET WAREHOUSE_SIZE = 'MEDIUM';
ALTER SESSION SET QUERY_TAG = 'bench-m';
-- run the same query again

-- Compare
SELECT QUERY_TAG, WAREHOUSE_SIZE, TOTAL_ELAPSED_TIME / 1000 AS seconds,
       BYTES_SCANNED, BYTES_SPILLED_TO_LOCAL_STORAGE
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION())
WHERE QUERY_TAG LIKE 'bench-%' AND QUERY_TYPE = 'SELECT'
ORDER BY START_TIME;
</sql>
<p>Credit cost of one run ≈ seconds ÷ 3600 × credits per hour. If XSMALL takes 80 seconds and MEDIUM takes 21, the costs are about 0.022 and 0.023 credits: the same, but the MEDIUM answer came four times faster. That's the sweet spot. Keep sizing up while the time roughly halves; stop when it doesn't.</p>
<p>Two things to note: warehouse resizes apply to new queries (running queries finish on the old size), and the first query after a resume reads from remote storage, so benchmark with a warm-up run or compare like with like.</p>
<p><code>QUERY_TAG</code> is your friend for cost attribution. Set it per session, per job or per dbt model, and you can group cost and performance by it later.</p>
`
    },
    {
      title: "Auto-suspend, auto-resume and the 60-second minimum",
      body: `
<p>Warehouses bill per second, but every time a warehouse starts (or resizes up) you pay for at least 60 seconds. That makes AUTO_SUSPEND a real trade-off:</p>
<ul>
<li><b>Too long</b> (say 30 minutes on an ad hoc warehouse): you pay for lots of idle time.</li>
<li><b>Too short</b> on a busy warehouse: it suspends and resumes constantly, paying the minimum each time and losing its local cache, so queries read from remote storage again.</li>
</ul>
<p>Rules of thumb people actually use:</p>
<table>
<tr><th>Workload</th><th>AUTO_SUSPEND</th><th>Why</th></tr>
<tr><td>Scheduled ELT / tasks</td><td>60 seconds</td><td>Jobs run and finish; there's nothing to keep warm</td></tr>
<tr><td>Ad hoc analysts</td><td>60 to 300 seconds</td><td>Bursty use, cache helps a bit</td></tr>
<tr><td>BI dashboards</td><td>300 to 600 seconds</td><td>Steady repeat queries benefit from the warehouse cache</td></tr>
</table>
<p>Setting AUTO_SUSPEND to 0 or NULL means never suspend. Almost never what you want.</p>
<sql>
ALTER WAREHOUSE COURSE_WH SET AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;
ALTER WAREHOUSE COURSE_WH SUSPEND;   -- manual stop, e.g. after a big job
</sql>
`
    },
    {
      title: "Multi-cluster warehouses",
      body: `
<p>A single warehouse cluster runs a limited number of queries at once (governed by <code>MAX_CONCURRENCY_LEVEL</code>, default 8, though it depends on query size). Extra queries wait in a queue. A <b>multi-cluster warehouse</b> (Enterprise edition) adds clusters of the same size when queries queue and removes them when load drops.</p>
<sql>
CREATE OR REPLACE WAREHOUSE BI_WH
  WAREHOUSE_SIZE    = 'SMALL'
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 4
  SCALING_POLICY    = 'STANDARD'
  AUTO_SUSPEND      = 300
  AUTO_RESUME       = TRUE;
</sql>
<table>
<tr><th>Setting</th><th>Behaviour</th></tr>
<tr><td>MIN = MAX (e.g. 3 and 3)</td><td><b>Maximized</b> mode: all clusters start together. Predictable, but you pay for all of them while running.</td></tr>
<tr><td>MIN &lt; MAX</td><td><b>Auto-scale</b> mode: clusters start and stop with load</td></tr>
<tr><td>SCALING_POLICY = STANDARD</td><td>Starts a new cluster as soon as queries queue. Favours performance.</td></tr>
<tr><td>SCALING_POLICY = ECONOMY</td><td>Only starts a cluster if there's enough work to keep it busy for about 6 minutes. Favours cost; queries may queue for a while.</td></tr>
</table>
<p>Multi-cluster doesn't make one query faster. If a single dashboard query takes 40 seconds, more clusters won't help; a bigger size might. If a dashboard is slow at 9 AM because 50 people open it at once, more clusters is the fix.</p>
<p>The symptom tells you which: in query history, look at <code>QUEUED_OVERLOAD_TIME</code>. High queue time means you need more clusters. Long execution time with spilling means you need a bigger size.</p>
`
    },
    {
      title: "Guardrails: resource monitors and timeouts",
      body: `
<p><b>Resource monitors</b> watch credit use and can notify or suspend warehouses at thresholds. Only ACCOUNTADMIN can create them.</p>
<sql>
USE ROLE ACCOUNTADMIN;

CREATE OR REPLACE RESOURCE MONITOR COURSE_MONTHLY
  WITH CREDIT_QUOTA = 50
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS
    ON 75  PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND             -- let running queries finish, then suspend
    ON 110 PERCENT DO SUSPEND_IMMEDIATE;  -- cancel running queries and suspend

ALTER WAREHOUSE COURSE_WH SET RESOURCE_MONITOR = COURSE_MONTHLY;
ALTER WAREHOUSE BENCH_WH  SET RESOURCE_MONITOR = COURSE_MONTHLY;
</sql>
<p>Resource monitors only track warehouse credits. They don't cover serverless features (Snowpipe, automatic clustering, serverless tasks and so on). For those and for per-team spend, use <b>Budgets</b>, which can cover groups of objects, including serverless usage, and send notifications.</p>
<p><b>Timeouts</b> stop runaway queries:</p>
<sql>
-- No query on this warehouse may run longer than 1 hour
ALTER WAREHOUSE COURSE_WH SET STATEMENT_TIMEOUT_IN_SECONDS = 3600;

-- Give up on queries that wait in the queue for more than 10 minutes
ALTER WAREHOUSE BI_WH SET STATEMENT_QUEUED_TIMEOUT_IN_SECONDS = 600;
</sql>
<p>The default statement timeout is 172,800 seconds (two days). A forgotten cartesian join on a 4XL for two days costs a lot of money. Set sensible timeouts on every warehouse.</p>
<div class="tip"><b>Warehouse strategy that scales</b>Split warehouses by workload, not by team: one for ingestion, one for transformation, one for BI, one for ad hoc and data science. Each gets its own size, suspend time, scaling policy, timeout and monitor. Then tag them (module 16) or use QUERY_TAG to attribute cost to teams.</div>
`
    }
  ],
  quiz: [
    {
      q: "A query runs in 120 seconds on SMALL and parallelizes well. Roughly what happens on MEDIUM?",
      options: [
        "60 seconds and about the same total credits",
        "120 seconds and double the credits",
        "30 seconds and half the credits",
        "60 seconds and double the credits"
      ],
      answer: 0,
      why: "<p>MEDIUM has twice the compute at twice the hourly rate. If the work splits evenly, time halves and cost stays about the same. That's why sizing up is often \"free speed\" until the query stops scaling.</p>"
    },
    {
      q: "At 9 AM, 60 analysts open the same dashboards and queries queue for minutes. Each query alone runs in 3 seconds. What's the fix?",
      options: [
        "Increase warehouse size to 2XL",
        "Use a multi-cluster warehouse with auto-scaling",
        "Lower AUTO_SUSPEND",
        "Add a clustering key"
      ],
      answer: 1,
      why: "<p>The queries are fast; there are just too many at once. More clusters handle more concurrency. A bigger size would mostly make 3-second queries into 1-second queries while they still queue.</p>"
    },
    {
      q: "What's the difference between STANDARD and ECONOMY scaling policies?",
      options: [
        "ECONOMY uses smaller clusters",
        "STANDARD starts clusters as soon as queries queue; ECONOMY waits until there's enough load to keep a new cluster busy for several minutes",
        "STANDARD is only for Standard edition",
        "ECONOMY disables auto-suspend"
      ],
      answer: 1,
      why: "<p>STANDARD minimizes queuing. ECONOMY tolerates some queuing to avoid starting clusters that would sit mostly idle. Both use the same cluster size.</p>"
    },
    {
      q: "Each time a suspended warehouse resumes, you're billed for at least...",
      options: ["1 second", "60 seconds", "5 minutes", "1 hour"],
      answer: 1,
      why: "<p>There's a 60-second minimum per start, then per-second billing. Very short AUTO_SUSPEND on a warehouse that gets a query every 90 seconds can cost more than leaving it up.</p>"
    },
    {
      q: "Which spend does a resource monitor NOT control?",
      options: [
        "Credits used by warehouses assigned to it",
        "Credits used by serverless features like Snowpipe and automatic clustering",
        "Credits across all warehouses when set at account level",
        "Monthly warehouse usage"
      ],
      answer: 1,
      why: "<p>Resource monitors only cover user-managed warehouses. Serverless features have their own billing and are better watched with Budgets and the METERING_HISTORY views.</p>"
    },
    {
      q: "Query history shows a query spent most of its time in QUEUED_OVERLOAD. What does that tell you?",
      options: [
        "The query spilled to disk",
        "The warehouse was busy with other queries and this one waited for capacity",
        "The warehouse was resuming",
        "The query was waiting on a lock"
      ],
      answer: 1,
      why: "<p>QUEUED_OVERLOAD_TIME is waiting for capacity on a busy warehouse, the signal for multi-cluster or workload separation. Waiting for a warehouse to start shows as QUEUED_PROVISIONING_TIME, and lock waits show as TRANSACTION_BLOCKED_TIME.</p>"
    },
    {
      q: "What's the default STATEMENT_TIMEOUT_IN_SECONDS?",
      options: ["3,600 (1 hour)", "86,400 (1 day)", "172,800 (2 days)", "No limit"],
      answer: 2,
      why: "<p>Two days. That's long enough for a mistaken query on a big warehouse to burn a lot of credits. Set tighter timeouts at the warehouse or user level.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Create a well-configured ELT warehouse",
      prompt: "<p>Create <code>ELT_WH</code>: SMALL, suspends after 60 seconds, resumes automatically, starts suspended, 2-hour statement timeout, and a comment saying who owns it.</p>",
      answer: `CREATE OR REPLACE WAREHOUSE ELT_WH
  WAREHOUSE_SIZE = 'SMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  STATEMENT_TIMEOUT_IN_SECONDS = 7200
  COMMENT = 'Owner: data-platform team. Scheduled ELT only.';

SHOW WAREHOUSES LIKE 'ELT_WH';`,
      why: "<p>INITIALLY_SUSPENDED stops the warehouse from starting (and billing a minute) the moment you create it. A 60-second suspend is right for scheduled jobs. The comment is how the next person knows who to ask before resizing it.</p>"
    },
    {
      level: "Easy",
      title: "Find idle-but-running warehouses",
      prompt: "<p>List warehouses that are currently started, with size, auto-suspend setting, and how many queries are running and queued.</p>",
      answer: `SHOW WAREHOUSES;

SELECT "name", "state", "size", "auto_suspend", "running", "queued", "scaling_policy",
       "min_cluster_count", "max_cluster_count"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "state" = 'STARTED'
ORDER BY "running", "name";`,
      why: "<p>A STARTED warehouse with 0 running queries is burning credits for nothing until it hits its auto-suspend. If you see one with auto_suspend of 3600 or null, that's a quick saving. Remember the lower-case quoted column names from SHOW output.</p>"
    },
    {
      level: "Medium",
      title: "Find the right size with data",
      hint: "Run the same query on XSMALL, SMALL, MEDIUM and LARGE with result cache off and a QUERY_TAG per size. Compute credits from elapsed time.",
      prompt: "<p>Run TPC-H Q1 on <code>TPCH_SF100</code> at four sizes and produce a table of size, seconds, credits used and speedup versus XSMALL. Which size would you choose and why?</p>",
      answer: `-- Repeat for each size: XSMALL, SMALL, MEDIUM, LARGE
ALTER WAREHOUSE BENCH_WH SET WAREHOUSE_SIZE = 'SMALL';
ALTER SESSION SET USE_CACHED_RESULT = FALSE;
ALTER SESSION SET QUERY_TAG = 'q1-SMALL';
SELECT L_RETURNFLAG, L_LINESTATUS, SUM(L_QUANTITY), SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)), COUNT(*)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.LINEITEM
WHERE L_SHIPDATE <= '1998-09-02' GROUP BY 1, 2;

-- Then compare
WITH runs AS (
  SELECT QUERY_TAG,
         WAREHOUSE_SIZE,
         EXECUTION_TIME / 1000.0 AS seconds,
         CASE WAREHOUSE_SIZE
           WHEN 'X-Small' THEN 1 WHEN 'Small' THEN 2 WHEN 'Medium' THEN 4
           WHEN 'Large' THEN 8 WHEN 'X-Large' THEN 16 END AS credits_per_hour
  FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION(RESULT_LIMIT => 200))
  WHERE QUERY_TAG LIKE 'q1-%' AND QUERY_TYPE = 'SELECT' AND EXECUTION_STATUS = 'SUCCESS'
)
SELECT WAREHOUSE_SIZE,
       ROUND(seconds, 1)                              AS seconds,
       ROUND(seconds / 3600 * credits_per_hour, 4)    AS credits,
       ROUND(MAX(IFF(WAREHOUSE_SIZE = 'X-Small', seconds, NULL)) OVER () / seconds, 1) AS speedup
FROM runs
ORDER BY credits_per_hour;`,
      why: "<p>EXECUTION_TIME excludes queuing and compilation, so it's the fair number to compare. Credits per run are seconds/3600 × the hourly rate (this ignores the 60-second minimum, which only applies per resume, not per query). Typically you'll see near-linear speedup up to a point, then diminishing returns. Choose the largest size where credits per run stay roughly flat, unless nobody needs the answer faster, in which case the smallest size that meets the deadline is fine. Note the size label in QUERY_HISTORY reads like 'X-Small', not 'XSMALL'.</p>"
    },
    {
      level: "Medium",
      title: "Guardrails for a team",
      prompt: "<p>The analytics team gets <code>ANALYTICS_WH</code> and a monthly budget of 200 credits. Create a resource monitor that emails at 50% and 90%, stops new queries at 100%, and kills running queries at 120%. Attach it, and set a 30-minute statement timeout and a 5-minute queue timeout on the warehouse.</p>",
      answer: `USE ROLE ACCOUNTADMIN;

CREATE OR REPLACE RESOURCE MONITOR ANALYTICS_MONTHLY
  WITH CREDIT_QUOTA = 200
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  NOTIFY_USERS = ('KC_ADMIN')          -- users must have verified email addresses
  TRIGGERS
    ON 50  PERCENT DO NOTIFY
    ON 90  PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND
    ON 120 PERCENT DO SUSPEND_IMMEDIATE;

CREATE WAREHOUSE IF NOT EXISTS ANALYTICS_WH
  WAREHOUSE_SIZE = 'SMALL' AUTO_SUSPEND = 120 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE;

ALTER WAREHOUSE ANALYTICS_WH SET
  RESOURCE_MONITOR = ANALYTICS_MONTHLY
  STATEMENT_TIMEOUT_IN_SECONDS = 1800
  STATEMENT_QUEUED_TIMEOUT_IN_SECONDS = 300;

SHOW RESOURCE MONITORS LIKE 'ANALYTICS_MONTHLY';`,
      why: "<p>SUSPEND lets running queries finish, so actual usage can go past 100%. That's why a SUSPEND_IMMEDIATE backstop above 100% is common. NOTIFY_USERS sends email to the named users, and account administrators with notifications enabled also get alerts. Talk to the team first: a hard suspend in the middle of month-end reporting is its own incident. Many companies use NOTIFY-only monitors plus Budgets, and keep hard stops for sandboxes.</p>"
    },
    {
      level: "Hard",
      title: "Diagnose a slow BI warehouse",
      hint: "Separate queue time, provisioning time, compilation and execution; check spilling and concurrency per hour.",
      prompt: "<p>Users say dashboards on <code>BI_WH</code> are slow every weekday morning. Write one query against ACCOUNT_USAGE that shows, per hour for the last 14 days, the number of queries, average and p95 execution time, average queue time, and how many queries spilled to remote storage. Then explain how you'd read the result to choose between sizing up, adding clusters, or something else.</p>",
      answer: `SELECT DATE_TRUNC('hour', START_TIME)                         AS hour,
       COUNT(*)                                               AS queries,
       ROUND(AVG(EXECUTION_TIME) / 1000, 1)                   AS avg_exec_s,
       ROUND(APPROX_PERCENTILE(EXECUTION_TIME, 0.95) / 1000, 1) AS p95_exec_s,
       ROUND(AVG(QUEUED_OVERLOAD_TIME) / 1000, 1)             AS avg_queue_s,
       ROUND(AVG(QUEUED_PROVISIONING_TIME) / 1000, 1)         AS avg_provision_s,
       ROUND(AVG(COMPILATION_TIME) / 1000, 1)                 AS avg_compile_s,
       COUNT_IF(BYTES_SPILLED_TO_REMOTE_STORAGE > 0)          AS remote_spills,
       ROUND(AVG(PERCENTAGE_SCANNED_FROM_CACHE) * 100, 0)     AS avg_cache_pct
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE WAREHOUSE_NAME = 'BI_WH'
  AND START_TIME >= DATEADD(day, -14, CURRENT_TIMESTAMP())
  AND EXECUTION_STATUS = 'SUCCESS'
GROUP BY hour
ORDER BY hour;`,
      why: "<p>Read the morning hours against the rest of the day. <b>High avg_queue_s, normal exec time:</b> concurrency problem, so add clusters (multi-cluster, STANDARD policy) or move heavy users to another warehouse. <b>High exec time with remote_spills:</b> queries don't fit in memory, so size up or fix the queries. <b>High avg_provision_s:</b> the warehouse is starting cold every morning; consider a longer AUTO_SUSPEND, or a scheduled task that resumes it just before people arrive. <b>Low avg_cache_pct in the morning:</b> cold cache after overnight suspend; same idea. <b>High compile time:</b> very complex generated SQL or huge views; simplify the semantic layer. Using p95 instead of just the average catches the few terrible queries that users actually remember. ACCOUNT_USAGE lags by up to 45 minutes, which is fine for a 14-day analysis.</p>"
    },
    {
      level: "Hard",
      title: "Design the warehouse layout",
      prompt: "<p>A company has: hourly Snowpipe + dbt loads, ~200 BI users mostly 8 AM to 6 PM, 15 data scientists running big ad hoc queries, and a nightly 2-hour backfill job. Today everyone shares one 2XL warehouse that never suspends. Propose a layout with sizes and settings, and write the DDL.</p>",
      answer: `-- Ingestion and transformation: short, scheduled, predictable
CREATE WAREHOUSE TRANSFORM_WH WAREHOUSE_SIZE = 'MEDIUM' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE STATEMENT_TIMEOUT_IN_SECONDS = 3600
  COMMENT = 'dbt hourly runs';

-- BI: many small concurrent queries, warm cache matters
CREATE WAREHOUSE BI_WH WAREHOUSE_SIZE = 'SMALL'
  MIN_CLUSTER_COUNT = 1 MAX_CLUSTER_COUNT = 6 SCALING_POLICY = 'STANDARD'
  AUTO_SUSPEND = 600 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE
  STATEMENT_TIMEOUT_IN_SECONDS = 900 STATEMENT_QUEUED_TIMEOUT_IN_SECONDS = 300;

-- Data science: heavy, bursty, fewer users
CREATE WAREHOUSE DS_WH WAREHOUSE_SIZE = 'LARGE'
  MIN_CLUSTER_COUNT = 1 MAX_CLUSTER_COUNT = 2 SCALING_POLICY = 'ECONOMY'
  AUTO_SUSPEND = 120 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE
  STATEMENT_TIMEOUT_IN_SECONDS = 7200;

-- Nightly backfill: one big job, then off
CREATE WAREHOUSE BACKFILL_WH WAREHOUSE_SIZE = 'XLARGE' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE STATEMENT_TIMEOUT_IN_SECONDS = 14400;

-- Then: resource monitors per warehouse, grants so each role only uses its warehouse,
-- and drop or resize the old shared 2XL once traffic has moved.`,
      why: "<p>The old setup pays for a 2XL (32 credits/hour) around the clock: about 768 credits a day before anyone runs anything. Splitting by workload lets each warehouse fit its job. Transformation runs and suspends. BI uses small clusters that scale out for the morning rush and keeps a warm cache with a 10-minute suspend. Data science gets a large size for heavy scans with ECONOMY scaling, since a little queuing is acceptable there. The backfill gets raw power for a short time. Snowpipe is serverless, so it needs no warehouse. Grant USAGE on each warehouse only to the roles that should use it, otherwise people drift back to whatever is biggest. Validate the sizes with the benchmarking and hourly analysis from the previous problems instead of guessing.</p>"
    }
  ]
});
