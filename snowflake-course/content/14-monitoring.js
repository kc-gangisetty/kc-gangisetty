window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "monitoring",
  num: "14",
  track: "Performance and Operations",
  title: "Warehouse and account monitoring",
  summary: "The SNOWFLAKE.ACCOUNT_USAGE views you'll query every week: credits by warehouse, cost per query, idle time, expensive query patterns, storage growth, serverless spend and failed logins.",
  minutes: 55,
  level: "Advanced",
  lessons: [
    {
      title: "Where monitoring data lives",
      body: `
<table>
<tr><th>Source</th><th>Scope</th><th>Latency</th><th>History</th><th>Use for</th></tr>
<tr><td><code>&lt;db&gt;.INFORMATION_SCHEMA</code> views and table functions</td><td>One database (plus some account-wide functions)</td><td>None</td><td>Usually 7 to 14 days</td><td>What just happened, live troubleshooting</td></tr>
<tr><td><code>SNOWFLAKE.ACCOUNT_USAGE</code></td><td>Whole account, including dropped objects</td><td>45 minutes to 3 hours, depending on view</td><td>1 year</td><td>Trends, cost reporting, audits</td></tr>
<tr><td><code>SNOWFLAKE.ORGANIZATION_USAGE</code></td><td>All accounts in the organization</td><td>Up to about 24 hours</td><td>1 year</td><td>Org-wide cost and contract tracking</td></tr>
</table>
<p>The <code>SNOWFLAKE</code> database is shared by Snowflake into every account. By default only ACCOUNTADMIN can see it. Grant access either all-or-nothing or with the built-in database roles:</p>
<sql>
USE ROLE ACCOUNTADMIN;
CREATE ROLE IF NOT EXISTS PLATFORM_MONITOR;

-- Option 1: everything in the SNOWFLAKE database
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE PLATFORM_MONITOR;

-- Option 2: narrower, using SNOWFLAKE database roles
GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER      TO ROLE PLATFORM_MONITOR;  -- usage and cost views
GRANT DATABASE ROLE SNOWFLAKE.OBJECT_VIEWER     TO ROLE PLATFORM_MONITOR;  -- object metadata
GRANT DATABASE ROLE SNOWFLAKE.GOVERNANCE_VIEWER TO ROLE PLATFORM_MONITOR;  -- policies, access history
GRANT DATABASE ROLE SNOWFLAKE.SECURITY_VIEWER   TO ROLE PLATFORM_MONITOR;  -- logins, users, grants
</sql>
<p>Most ACCOUNT_USAGE timestamps display in your session's time zone. Set <code>ALTER SESSION SET TIMEZONE = 'UTC'</code> when building reports so day boundaries are the same for everyone and daylight saving doesn't shift them.</p>
`
    },
    {
      title: "Warehouse credits and load",
      body: `
<sql>
USE ROLE ACCOUNTADMIN;   -- or PLATFORM_MONITOR
USE WAREHOUSE COURSE_WH;
ALTER SESSION SET TIMEZONE = 'UTC';

-- Credits per warehouse per day, last 30 days
SELECT TO_DATE(START_TIME)             AS day,
       WAREHOUSE_NAME,
       SUM(CREDITS_USED_COMPUTE)       AS compute_credits,
       SUM(CREDITS_USED_CLOUD_SERVICES) AS cloud_services_credits,
       SUM(CREDITS_USED)               AS total_credits
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE START_TIME >= DATEADD(day, -30, CURRENT_DATE())
GROUP BY 1, 2
ORDER BY 1, total_credits DESC;
</sql>
<p><code>WAREHOUSE_METERING_HISTORY</code> has one row per warehouse per hour. Note that <code>CREDITS_USED</code> includes cloud services before the 10% daily adjustment; for billed amounts use <code>METERING_DAILY_HISTORY</code>, which has <code>CREDITS_BILLED</code>.</p>
<p><code>WAREHOUSE_LOAD_HISTORY</code> shows average running, queued and blocked queries in 5-minute intervals. It's the best source for "do we need more clusters?":</p>
<sql>
SELECT DATE_TRUNC('hour', START_TIME) AS hour,
       AVG(AVG_RUNNING)       AS avg_running,
       AVG(AVG_QUEUED_LOAD)   AS avg_queued,
       AVG(AVG_QUEUED_PROVISIONING) AS avg_provisioning,
       AVG(AVG_BLOCKED)       AS avg_blocked
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
WHERE WAREHOUSE_NAME = 'COURSE_WH'
  AND START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY 1;
</sql>
<p><code>WAREHOUSE_EVENTS_HISTORY</code> records resumes, suspends, resizes and cluster changes, which helps explain unexpected spend ("who resized this to 4XL at 2 AM?").</p>
`
    },
    {
      title: "Query cost and expensive patterns",
      body: `
<p>Warehouses are billed by time running, not per query. To attribute cost to queries, Snowflake provides <code>QUERY_ATTRIBUTION_HISTORY</code>, which estimates compute credits per query (excluding idle time):</p>
<sql>
-- Top 20 most expensive individual queries in the last 7 days
SELECT qa.QUERY_ID,
       qa.WAREHOUSE_NAME,
       qa.USER_NAME,
       ROUND(qa.CREDITS_ATTRIBUTED_COMPUTE, 3) AS credits,
       q.TOTAL_ELAPSED_TIME / 1000            AS seconds,
       LEFT(q.QUERY_TEXT, 120)                AS query_start
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY qa
JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q ON q.QUERY_ID = qa.QUERY_ID
WHERE qa.START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
ORDER BY qa.CREDITS_ATTRIBUTED_COMPUTE DESC
LIMIT 20;
</sql>
<p>A single expensive query matters less than a moderately expensive query that runs 5,000 times a day. <code>QUERY_PARAMETERIZED_HASH</code> groups queries that are identical except for literal values, so you can find costly recurring patterns:</p>
<sql>
SELECT q.QUERY_PARAMETERIZED_HASH,
       COUNT(*)                                     AS runs,
       ROUND(SUM(qa.CREDITS_ATTRIBUTED_COMPUTE), 2) AS total_credits,
       ROUND(AVG(q.TOTAL_ELAPSED_TIME) / 1000, 1)   AS avg_seconds,
       ANY_VALUE(LEFT(q.QUERY_TEXT, 200))           AS example
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q
JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY qa ON qa.QUERY_ID = q.QUERY_ID
WHERE q.START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY total_credits DESC
LIMIT 20;
</sql>
<p>Other <code>QUERY_HISTORY</code> columns you'll filter on: <code>QUERY_TAG</code>, <code>ROLE_NAME</code>, <code>EXECUTION_STATUS</code> (SUCCESS, FAIL, INCIDENT), <code>ERROR_CODE</code>/<code>ERROR_MESSAGE</code>, <code>QUERY_TYPE</code>, and all the time and byte columns from the previous modules.</p>
`
    },
    {
      title: "Storage, serverless and security signals",
      body: `
<sql>
-- Biggest tables, including Time Travel and Fail-safe bytes
SELECT TABLE_CATALOG || '.' || TABLE_SCHEMA || '.' || TABLE_NAME AS table_name,
       ROUND(ACTIVE_BYTES / POWER(1024, 3), 2)       AS active_gb,
       ROUND(TIME_TRAVEL_BYTES / POWER(1024, 3), 2)  AS time_travel_gb,
       ROUND(FAILSAFE_BYTES / POWER(1024, 3), 2)     AS failsafe_gb,
       ROUND(RETAINED_FOR_CLONE_BYTES / POWER(1024, 3), 2) AS clone_retained_gb
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
WHERE DELETED IS NULL OR DELETED = FALSE
ORDER BY ACTIVE_BYTES + TIME_TRAVEL_BYTES + FAILSAFE_BYTES DESC
LIMIT 20;

-- Spend by service type (warehouses, pipes, clustering, serverless tasks, ...)
SELECT USAGE_DATE, SERVICE_TYPE, SUM(CREDITS_BILLED) AS credits_billed
FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
WHERE USAGE_DATE >= DATEADD(day, -30, CURRENT_DATE())
GROUP BY 1, 2
ORDER BY 1, 3 DESC;

-- Failed logins in the last day
SELECT EVENT_TIMESTAMP, USER_NAME, CLIENT_IP, REPORTED_CLIENT_TYPE, ERROR_MESSAGE
FROM SNOWFLAKE.ACCOUNT_USAGE.LOGIN_HISTORY
WHERE IS_SUCCESS = 'NO'
  AND EVENT_TIMESTAMP >= DATEADD(day, -1, CURRENT_TIMESTAMP())
ORDER BY EVENT_TIMESTAMP DESC;
</sql>
<p>A table where Time Travel and Fail-safe bytes are several times the active bytes is a high-churn table (lots of updates or full rebuilds) on long retention. Moving it to transient, or shortening retention, can cut its storage bill sharply.</p>
<p>Other views to know: <code>PIPE_USAGE_HISTORY</code>, <code>AUTOMATIC_CLUSTERING_HISTORY</code>, <code>MATERIALIZED_VIEW_REFRESH_HISTORY</code>, <code>SERVERLESS_TASK_HISTORY</code>, <code>SEARCH_OPTIMIZATION_HISTORY</code>, <code>COPY_HISTORY</code>, <code>ACCESS_HISTORY</code> (module 16), <code>GRANTS_TO_ROLES</code> and <code>GRANTS_TO_USERS</code> (module 15).</p>
<div class="tip"><b>Build it once</b>Put your monitoring queries into views in a dedicated <code>PLATFORM.MONITORING</code> schema, point a Snowsight dashboard at them, and put alerts (module 09) on the ones that need action, like a warehouse exceeding its daily budget or failed logins spiking.</div>
`
    }
  ],
  quiz: [
    {
      q: "A query ran 5 minutes ago and you need its stats now. Where do you look?",
      options: [
        "SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY",
        "INFORMATION_SCHEMA.QUERY_HISTORY table functions",
        "ORGANIZATION_USAGE.QUERY_HISTORY",
        "It's not available until tomorrow"
      ],
      answer: 1,
      why: "<p>ACCOUNT_USAGE.QUERY_HISTORY can lag by up to 45 minutes. The INFORMATION_SCHEMA table functions (QUERY_HISTORY, QUERY_HISTORY_BY_USER, BY_WAREHOUSE, BY_SESSION) are real-time but cover only the last 7 days.</p>"
    },
    {
      q: "How do you let a monitoring role read ACCOUNT_USAGE without making it ACCOUNTADMIN?",
      options: [
        "GRANT SELECT ON SCHEMA SNOWFLAKE.ACCOUNT_USAGE",
        "GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE, or grant SNOWFLAKE database roles like USAGE_VIEWER",
        "GRANT OWNERSHIP ON DATABASE SNOWFLAKE",
        "It's impossible"
      ],
      answer: 1,
      why: "<p>SNOWFLAKE is a shared database, so it uses IMPORTED PRIVILEGES. The SNOWFLAKE database roles give narrower slices: usage, objects, governance or security views.</p>"
    },
    {
      q: "Which view gives an estimated credit cost for each individual query?",
      options: ["WAREHOUSE_METERING_HISTORY", "QUERY_ATTRIBUTION_HISTORY", "METERING_DAILY_HISTORY", "LOGIN_HISTORY"],
      answer: 1,
      why: "<p>QUERY_ATTRIBUTION_HISTORY splits warehouse compute across the queries that ran. It doesn't include idle time, so per-query totals will be lower than the warehouse bill. The difference is your idle cost.</p>"
    },
    {
      q: "What does QUERY_PARAMETERIZED_HASH help you find?",
      options: [
        "Queries that failed",
        "Groups of queries that are the same apart from literal values, so you can find costly repeated patterns",
        "Duplicate tables",
        "Users with the same password"
      ],
      answer: 1,
      why: "<p>Dashboards and apps send the same query with different filter values thousands of times. Grouping by the parameterized hash adds those up and shows which pattern is worth optimizing.</p>"
    },
    {
      q: "A table has 200 GB active, 1.4 TB Time Travel and 1.1 TB Fail-safe bytes. What's going on?",
      options: [
        "The table is fine",
        "It's rewritten or updated heavily, and old versions are retained, so retention and Fail-safe dominate its storage",
        "It's a clone",
        "Snowflake double-counts Fail-safe"
      ],
      answer: 1,
      why: "<p>Every rewrite retires micro-partitions that are kept for retention plus 7 days of Fail-safe. For a table you rebuild daily, consider transient (no Fail-safe) and short retention.</p>"
    },
    {
      q: "Which view shows credits for Snowpipe, automatic clustering and serverless tasks alongside warehouses, after the cloud services adjustment?",
      options: ["WAREHOUSE_METERING_HISTORY", "METERING_DAILY_HISTORY", "TABLE_STORAGE_METRICS", "QUERY_HISTORY"],
      answer: 1,
      why: "<p>METERING_DAILY_HISTORY has one row per day per service type with CREDITS_BILLED, which reflects the cloud services adjustment. It's the closest view to your invoice.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Credits by warehouse this month",
      prompt: "<p>Show total credits used per warehouse since the start of the current month, largest first.</p>",
      answer: `SELECT WAREHOUSE_NAME,
       ROUND(SUM(CREDITS_USED), 2) AS credits
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE START_TIME >= DATE_TRUNC('month', CURRENT_DATE())
GROUP BY WAREHOUSE_NAME
ORDER BY credits DESC;`,
      why: "<p>One row per warehouse per hour, so summing gives the month to date. Multiply by your contract price per credit for dollars. Remember this includes cloud services before the 10% adjustment; for invoice-level numbers use METERING_DAILY_HISTORY.</p>"
    },
    {
      level: "Easy",
      title: "Slowest queries of the day",
      prompt: "<p>List the 10 longest-running successful queries in the last 24 hours with user, warehouse, size, seconds and the first 100 characters of SQL.</p>",
      answer: `SELECT USER_NAME, WAREHOUSE_NAME, WAREHOUSE_SIZE,
       ROUND(TOTAL_ELAPSED_TIME / 1000, 1) AS seconds,
       LEFT(QUERY_TEXT, 100)               AS sql_start,
       QUERY_ID
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE START_TIME >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
  AND EXECUTION_STATUS = 'SUCCESS'
  AND WAREHOUSE_NAME IS NOT NULL
ORDER BY TOTAL_ELAPSED_TIME DESC
LIMIT 10;`,
      why: "<p>Filtering on WAREHOUSE_NAME IS NOT NULL drops statements that ran with no warehouse at all, such as SHOW and DESCRIBE. Keep QUERY_ID in the output so you can jump straight to the profile.</p>"
    },
    {
      level: "Medium",
      title: "How much are we paying for idle?",
      hint: "Compare metered compute credits per warehouse to the sum of attributed query credits.",
      prompt: "<p>For each warehouse over the last 14 days, compare compute credits billed by the warehouse with credits attributed to queries, and show the idle share. Which warehouses need a shorter AUTO_SUSPEND?</p>",
      answer: `WITH metered AS (
  SELECT WAREHOUSE_NAME, SUM(CREDITS_USED_COMPUTE) AS metered_credits
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
  WHERE START_TIME >= DATEADD(day, -14, CURRENT_DATE())
  GROUP BY 1
),
attributed AS (
  SELECT WAREHOUSE_NAME, SUM(CREDITS_ATTRIBUTED_COMPUTE) AS query_credits
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY
  WHERE START_TIME >= DATEADD(day, -14, CURRENT_DATE())
  GROUP BY 1
)
SELECT m.WAREHOUSE_NAME,
       ROUND(m.metered_credits, 2)                                    AS metered,
       ROUND(COALESCE(a.query_credits, 0), 2)                         AS used_by_queries,
       ROUND(m.metered_credits - COALESCE(a.query_credits, 0), 2)     AS idle_credits,
       ROUND(100 * (1 - COALESCE(a.query_credits, 0) / NULLIF(m.metered_credits, 0)), 1) AS idle_pct
FROM metered m
LEFT JOIN attributed a USING (WAREHOUSE_NAME)
ORDER BY idle_credits DESC;`,
      why: "<p>The gap between what a warehouse was billed and what queries used is time it sat running with nothing to do: auto-suspend windows, the 60-second minimums, and gaps between queries. A warehouse at 60% idle with a 10-minute AUTO_SUSPEND is the easiest saving in Snowflake. Some idle is healthy on BI warehouses (warm cache), so weigh it against query speed. Note that QUERY_ATTRIBUTION_HISTORY excludes very short queries, so idle is slightly overstated.</p>"
    },
    {
      level: "Medium",
      title: "Cost by team with query tags",
      prompt: "<p>Assume every job sets a QUERY_TAG like <code>team=finance;job=daily_close</code>. Write a report of credits per team for the last 30 days, with untagged queries grouped as 'untagged'.</p>",
      answer: `SELECT COALESCE(NULLIF(REGEXP_SUBSTR(q.QUERY_TAG, 'team=([^;]+)', 1, 1, 'e', 1), ''), 'untagged') AS team,
       COUNT(*)                                     AS queries,
       ROUND(SUM(qa.CREDITS_ATTRIBUTED_COMPUTE), 2) AS credits
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY qa
JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q ON q.QUERY_ID = qa.QUERY_ID
WHERE qa.START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())
GROUP BY team
ORDER BY credits DESC;`,
      why: "<p>REGEXP_SUBSTR with the 'e' parameter returns the first capture group, here the value after <code>team=</code>. The share labelled 'untagged' tells you how well tagging is adopted. Enforce tags by setting QUERY_TAG at the user or service account level (<code>ALTER USER etl_svc SET QUERY_TAG = 'team=platform'</code>) and in dbt's query-tag config. Object tags on warehouses (module 16) are the other half of chargeback: they attribute idle warehouse time, which query attribution can't.</p>"
    },
    {
      level: "Hard",
      title: "A daily cost anomaly alert",
      hint: "Compare yesterday's credits per warehouse to the average and standard deviation of the previous 28 days.",
      prompt: "<p>Build a view that flags any warehouse whose credits yesterday were more than 3 standard deviations above its 28-day average (and at least 5 credits, to ignore tiny ones). Then create an alert that emails when the view has rows.</p>",
      answer: `USE ROLE ACCOUNTADMIN;
CREATE DATABASE IF NOT EXISTS PLATFORM;
CREATE SCHEMA IF NOT EXISTS PLATFORM.MONITORING;

CREATE OR REPLACE VIEW PLATFORM.MONITORING.WAREHOUSE_COST_ANOMALIES AS
WITH daily AS (
  SELECT WAREHOUSE_NAME, TO_DATE(START_TIME) AS day, SUM(CREDITS_USED) AS credits
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
  WHERE START_TIME >= DATEADD(day, -29, CURRENT_DATE())
    AND START_TIME <  CURRENT_DATE()
  GROUP BY 1, 2
),
baseline AS (
  SELECT WAREHOUSE_NAME, AVG(credits) AS avg_credits, STDDEV(credits) AS sd_credits
  FROM daily
  WHERE day < DATEADD(day, -1, CURRENT_DATE())
  GROUP BY 1
)
SELECT d.WAREHOUSE_NAME, d.day, ROUND(d.credits, 2) AS credits,
       ROUND(b.avg_credits, 2) AS avg_28d, ROUND(b.sd_credits, 2) AS sd_28d,
       ROUND((d.credits - b.avg_credits) / NULLIF(b.sd_credits, 0), 1) AS z_score
FROM daily d
JOIN baseline b USING (WAREHOUSE_NAME)
WHERE d.day = DATEADD(day, -1, CURRENT_DATE())
  AND d.credits >= 5
  AND d.credits > b.avg_credits + 3 * COALESCE(b.sd_credits, 0);

CREATE OR REPLACE ALERT PLATFORM.MONITORING.WAREHOUSE_COST_SPIKE
  WAREHOUSE = COURSE_WH
  SCHEDULE = 'USING CRON 0 9 * * * UTC'
IF (EXISTS (SELECT 1 FROM PLATFORM.MONITORING.WAREHOUSE_COST_ANOMALIES))
THEN
  CALL SYSTEM$SEND_EMAIL('EMAIL_INT', 'data-oncall@example.com',
    'Warehouse cost anomaly',
    'One or more warehouses spent far above their 28-day baseline yesterday. See PLATFORM.MONITORING.WAREHOUSE_COST_ANOMALIES.');

ALTER ALERT PLATFORM.MONITORING.WAREHOUSE_COST_SPIKE RESUME;`,
      why: "<p>A z-score against each warehouse's own baseline catches unusual spend without a fixed threshold that's wrong for every warehouse. The 5-credit floor stops tiny warehouses from paging people over pennies. The alert runs at 09:00 UTC, by which time yesterday's metering is complete (WAREHOUSE_METERING_HISTORY can lag up to 3 hours). Snowflake's Budgets feature can also alert on spend, and newer accounts may have built-in anomaly detection for cost. Building your own view still teaches you exactly what's being measured and lets you tune it. Next steps in a real setup: include the top 3 queries by attributed credits in the email, and add the same check for serverless services from METERING_DAILY_HISTORY.</p>"
    },
    {
      level: "Hard",
      title: "Weekly platform health report",
      prompt: "<p>Write a single query that returns one row per warehouse for the last 7 days with: credits, query count, failed query count, p95 execution seconds, queries that spilled to remote storage, average queue seconds, and the share of queries served from result cache. This is the report a staff engineer brings to the weekly platform review.</p>",
      answer: `WITH q AS (
  SELECT WAREHOUSE_NAME,
         COUNT(*)                                             AS queries,
         COUNT_IF(EXECUTION_STATUS = 'FAIL')                  AS failed,
         APPROX_PERCENTILE(EXECUTION_TIME, 0.95) / 1000       AS p95_exec_s,
         COUNT_IF(BYTES_SPILLED_TO_REMOTE_STORAGE > 0)        AS remote_spills,
         AVG(QUEUED_OVERLOAD_TIME) / 1000                     AS avg_queue_s
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
  WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
    AND WAREHOUSE_NAME IS NOT NULL
  GROUP BY 1
),
cache AS (   -- approximate: result cache hits scan no bytes and finish almost instantly
  SELECT COUNT_IF(BYTES_SCANNED = 0 AND EXECUTION_TIME < 100 AND QUERY_TYPE = 'SELECT')
           / NULLIF(COUNT_IF(QUERY_TYPE = 'SELECT'), 0) AS result_cache_share
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
  WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
),
m AS (
  SELECT WAREHOUSE_NAME, SUM(CREDITS_USED) AS credits
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
  WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
  GROUP BY 1
)
SELECT m.WAREHOUSE_NAME,
       ROUND(m.credits, 1)       AS credits,
       q.queries,
       q.failed,
       ROUND(q.p95_exec_s, 1)    AS p95_exec_s,
       q.remote_spills,
       ROUND(q.avg_queue_s, 2)   AS avg_queue_s,
       ROUND(100 * (SELECT result_cache_share FROM cache), 1) AS account_result_cache_pct
FROM m
LEFT JOIN q USING (WAREHOUSE_NAME)
ORDER BY credits DESC;`,
      why: "<p>Each column maps to an action: credits (is spend trending up?), failures (broken jobs or bad SQL), p95 (user experience), remote spills (warehouses too small or queries too wide), queue time (need clusters or workload split). Result cache hits are a little tricky: they're served without a warehouse, so they can't be attributed per warehouse from QUERY_HISTORY alone. Here they're reported account-wide as an approximation: a hit scans zero bytes and finishes almost instantly. Metadata-only queries like a bare COUNT(*) look the same, so treat the number as a trend, not an exact figure. A falling cache share often means someone added CURRENT_TIMESTAMP() or a random value to a dashboard query. Save the query as a view and chart it week over week; trends matter more than any single number.</p>"
    }
  ]
});
