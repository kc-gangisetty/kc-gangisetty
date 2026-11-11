window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "staff",
  num: "18",
  track: "Staff Engineer",
  title: "The staff engineer playbook",
  summary: "Platform design across accounts and environments, CI/CD with clones, cost governance as a program, data quality with data metric functions, Iceberg and Snowpark, and a capstone that ties the whole course together.",
  minutes: 90,
  level: "Staff",
  lessons: [
    {
      title: "Designing the platform",
      body: `
<p>A staff engineer's job on Snowflake is less about writing the cleverest SQL and more about decisions that hold up for years: how accounts, databases and roles are laid out, how changes get deployed, and how cost and quality stay under control as the team grows.</p>
<h3>Accounts and environments</h3>
<table>
<tr><th>Option</th><th>Pros</th><th>Cons</th></tr>
<tr><td>One account, env per database (PROD_ANALYTICS, DEV_ANALYTICS)</td><td>Simple; zero-copy clone prod to dev instantly</td><td>Account-level objects (integrations, network policies, users) are shared; a mistake in dev can touch prod</td></tr>
<tr><td>Separate accounts per environment</td><td>Strong isolation; prod admin rights are separate</td><td>Cloning across accounts isn't possible (use replication or sharing to seed non-prod); more to manage</td></tr>
</table>
<p>Most mature platforms use separate prod and non-prod accounts, with replication or shares feeding realistic (masked) data into non-prod.</p>
<h3>Layers inside the account</h3>
<p>A layout that works for most teams:</p>
<ul>
<li><b>RAW</b>: data exactly as it arrived (VARIANT or source-shaped), append-only, longer retention. Owned by the ingestion role.</li>
<li><b>STAGING / INTEGRATION</b>: cleaned, typed, deduplicated, conformed keys. Usually transient. Dynamic tables or dbt models.</li>
<li><b>ANALYTICS / MARTS</b>: business-facing facts and dimensions, documented, tested, governed with masking. Managed access schemas. Consumers only ever see this layer, ideally through views that act as a contract.</li>
<li><b>SANDBOX</b>: per-team or per-user scratch with short retention, a resource monitor and an expiry policy.</li>
</ul>
<h3>Everything as code</h3>
<p>Roles, grants, warehouses, databases and policies should live in version control and be applied by a pipeline: Terraform's Snowflake provider, the Snowflake CLI with SQL scripts, schemachange, or Snowflake's own declarative DCM projects. dbt or dynamic tables handle the transformation layer. Hand-made changes in production are how you end up with grants nobody can explain.</p>
`
    },
    {
      title: "CI/CD with zero-copy clones",
      body: `
<p>Clones make a testing pattern possible that's very expensive on other platforms: test every change against a full copy of production data, for almost nothing.</p>
<sql>
-- In CI, for pull request 482
CREATE OR REPLACE DATABASE ANALYTICS_PR_482 CLONE ANALYTICS;   -- seconds, no storage cost yet
-- grant the CI role access, then run the changed models / migrations against ANALYTICS_PR_482
-- run tests: row counts, uniqueness, reconciliation against prod, query profile checks

-- Compare the changed model with production
SELECT 'only_in_pr' AS side, * FROM (
  SELECT * FROM ANALYTICS_PR_482.MART.ORDER_REVENUE
  MINUS SELECT * FROM ANALYTICS.MART.ORDER_REVENUE)
UNION ALL
SELECT 'only_in_prod', * FROM (
  SELECT * FROM ANALYTICS.MART.ORDER_REVENUE
  MINUS SELECT * FROM ANALYTICS_PR_482.MART.ORDER_REVENUE)
LIMIT 100;

DROP DATABASE ANALYTICS_PR_482;   -- when the PR closes
</sql>
<p>For deploying big table rebuilds, use the blue/green pattern from module 07: build the new version next to the old one, validate, then <code>ALTER TABLE ... SWAP WITH</code>. For schema-level releases, the same idea works with cloned schemas and <code>ALTER SCHEMA ... SWAP WITH</code>.</p>
<p>Clean-up matters: a CI process that clones a database per PR and never drops them leaves dozens of databases that slowly diverge from prod and start costing storage. Add a nightly job that drops clones older than a few days.</p>
`
    },
    {
      title: "Cost governance as a program",
      body: `
<p>Cost isn't a one-time tuning exercise. It's a loop: <b>see it, own it, fix it, prevent it</b>.</p>
<ul>
<li><b>See:</b> daily cost by warehouse, service, team and query pattern (module 14). Unit costs such as cost per dashboard view, per dbt model, per GB ingested. Unit costs tell you whether rising spend is growth or waste.</li>
<li><b>Own:</b> tag warehouses and databases with cost centers, set QUERY_TAG in every tool, and send each team a monthly report with their numbers. People optimize what they're shown.</li>
<li><b>Fix:</b> the usual top five are idle warehouses (suspend times), oversized warehouses, full-refresh pipelines that could be incremental, expensive recurring queries (parameterized hash), and storage from high-churn tables on long retention.</li>
<li><b>Prevent:</b> resource monitors and budgets, statement timeouts, warehouse creation restricted to the platform team, review of new clustering/search optimization, and cost checks in CI for heavy models.</li>
</ul>
<sql>
-- Cost per team per month using object tags on warehouses
SELECT tr.TAG_VALUE                       AS cost_center,
       DATE_TRUNC('month', wm.START_TIME) AS month,
       ROUND(SUM(wm.CREDITS_USED), 1)     AS credits
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY wm
JOIN SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES tr
  ON tr.DOMAIN = 'WAREHOUSE'
 AND tr.OBJECT_NAME = wm.WAREHOUSE_NAME
 AND tr.TAG_NAME = 'COST_CENTER'
WHERE wm.START_TIME >= DATEADD(month, -6, CURRENT_DATE())
GROUP BY 1, 2
ORDER BY 2, 3 DESC;
</sql>
`
    },
    {
      title: "Data quality and observability",
      body: `
<p><b>Data metric functions</b> (DMFs, Enterprise) run quality checks on a schedule, managed by Snowflake. There are built-in ones in the <code>SNOWFLAKE.CORE</code> schema and you can write your own.</p>
<sql>
USE ROLE SYSADMIN;
-- Run attached DMFs whenever the table changes (or on a CRON schedule)
ALTER TABLE COURSE_DB.TPCH.ORDERS SET DATA_METRIC_SCHEDULE = 'TRIGGER_ON_CHANGES';

ALTER TABLE COURSE_DB.TPCH.ORDERS ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.NULL_COUNT      ON (O_CUSTKEY);
ALTER TABLE COURSE_DB.TPCH.ORDERS ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.DUPLICATE_COUNT ON (O_ORDERKEY);
ALTER TABLE COURSE_DB.TPCH.ORDERS ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.FRESHNESS       ON (O_ORDERDATE);

-- A custom rule: orders with a non-positive total
CREATE OR REPLACE DATA METRIC FUNCTION COURSE_DB.GOVERNANCE.NON_POSITIVE_COUNT(t TABLE(amount NUMBER))
RETURNS NUMBER AS
'SELECT COUNT_IF(amount <= 0) FROM t';
ALTER TABLE COURSE_DB.TPCH.ORDERS
  ADD DATA METRIC FUNCTION COURSE_DB.GOVERNANCE.NON_POSITIVE_COUNT ON (O_TOTALPRICE);

-- Results land in an event table you can alert on
SELECT MEASUREMENT_TIME, TABLE_NAME, METRIC_NAME, ARGUMENT_NAMES, VALUE
FROM SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_RESULTS
ORDER BY MEASUREMENT_TIME DESC
LIMIT 20;
</sql>
<p>An observability setup that catches most incidents before users do has four signals per important table: <b>freshness</b> (when did it last change versus its SLA), <b>volume</b> (rows added versus normal), <b>schema</b> (columns added, removed or retyped) and <b>quality</b> (nulls, duplicates, business rules). Wire each to an alert with an owner. Alerts without owners are noise.</p>
<p>For incidents, write short runbooks: how to tell what's broken (task history, dynamic table refresh history, copy history), how to stop the bleeding (suspend the task, swap back the previous table version), how to recover (Time Travel, CHANGES replay, clone and swap), and how to verify.</p>
`
    },
    {
      title: "Open formats, Snowpark and the wider platform",
      body: `
<h3>Apache Iceberg tables</h3>
<p>Iceberg tables store data as Parquet files plus Iceberg metadata in your own cloud storage (an external volume), so other engines like Spark or Trino can read the same tables. Two flavours:</p>
<ul>
<li><b>Snowflake-managed catalog</b>: Snowflake writes and manages the table; performance and features close to native tables; other engines read it through the Iceberg catalog (Snowflake Open Catalog / Polaris compatible).</li>
<li><b>Externally managed catalog</b> (Glue, Open Catalog, other REST catalogs): Snowflake reads (and in newer releases can write) tables another system owns.</li>
</ul>
<sql>
CREATE ICEBERG TABLE COURSE_DB.TPCH.ORDERS_ICEBERG
  CATALOG = 'SNOWFLAKE'
  EXTERNAL_VOLUME = 'MY_S3_VOLUME'
  BASE_LOCATION = 'tpch/orders/'
AS SELECT * FROM COURSE_DB.TPCH.ORDERS;
</sql>
<p>Choose Iceberg when multiple engines must share the data or you need to own the files for strategic reasons. Choose native tables when Snowflake is the only engine and you want the simplest operations.</p>
<h3>Snowpark</h3>
<p>Snowpark lets you write transformations in Python, Java or Scala with a DataFrame API that compiles to SQL and runs inside Snowflake. Data doesn't leave the platform. Use it when logic is easier in Python (ML features, complex parsing, reusing existing libraries) or when your team is more fluent in Python than SQL.</p>
<sql>
CREATE OR REPLACE PROCEDURE COURSE_DB.TPCH.TOP_SEGMENTS(n INT)
RETURNS TABLE()
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS $$
from snowflake.snowpark.functions import col, sum as sum_

def run(session, n):
    orders = session.table("COURSE_DB.TPCH.ORDERS")
    customers = session.table("COURSE_DB.TPCH.CUSTOMER")
    return (orders.join(customers, orders["O_CUSTKEY"] == customers["C_CUSTKEY"])
                  .group_by("C_MKTSEGMENT")
                  .agg(sum_(col("O_TOTALPRICE")).alias("REVENUE"))
                  .sort(col("REVENUE").desc())
                  .limit(n))
$$;

CALL COURSE_DB.TPCH.TOP_SEGMENTS(3);
</sql>
<h3>Other pieces worth knowing about</h3>
<ul>
<li><b>Hybrid tables</b> (Unistore): row-oriented storage with enforced primary keys and fast single-row reads and writes, for operational workloads next to analytics.</li>
<li><b>External access integrations</b>: let UDFs and procedures call external APIs through approved network rules and secrets.</li>
<li><b>Cortex AI functions</b>: LLM functions callable from SQL (summarize, classify, extract, complete) on data that stays in Snowflake, governed by the same roles.</li>
<li><b>Native Apps and Snowpark Container Services</b>: package and run applications and containers inside Snowflake.</li>
</ul>
`
    }
  ],
  quiz: [
    {
      q: "What's the strongest reason to use separate Snowflake accounts for prod and non-prod instead of separate databases?",
      options: [
        "Queries run faster in separate accounts",
        "Account-level objects (users, network policies, integrations, ACCOUNTADMIN rights) are isolated, so non-prod mistakes can't reach prod",
        "Separate accounts are cheaper",
        "Cloning only works across accounts"
      ],
      answer: 1,
      why: "<p>The isolation boundary for admin rights and account objects is the account. The trade-off is that you can't clone across accounts, so you seed non-prod with replication, shares or masked extracts.</p>"
    },
    {
      q: "Why are zero-copy clones ideal for CI testing of data changes?",
      options: [
        "They're encrypted differently",
        "A full copy of production data is available in seconds and only changed data costs storage",
        "They skip masking policies",
        "They run on serverless compute"
      ],
      answer: 1,
      why: "<p>Testing against real volumes and edge cases catches bugs synthetic data misses, and clones make that nearly free. Masking policies still apply in clones, which is a good thing.</p>"
    },
    {
      q: "Which signal set gives the best general-purpose table observability?",
      options: [
        "Query count and warehouse size",
        "Freshness, volume, schema changes and quality rules",
        "Storage bytes only",
        "Number of grants"
      ],
      answer: 1,
      why: "<p>Most data incidents show up as data arriving late, too much or too little of it, a changed structure, or rules being broken. Monitoring those four with owners on each alert catches problems before users do.</p>"
    },
    {
      q: "When does an Iceberg table make more sense than a native Snowflake table?",
      options: [
        "Always; it's faster",
        "When other engines (Spark, Trino and so on) must read or write the same data, or you need to own the files in open format",
        "When you need Time Travel",
        "When the table is small"
      ],
      answer: 1,
      why: "<p>Iceberg's value is interoperability and control of storage. If Snowflake is the only engine, native tables are simpler to run and get every feature first.</p>"
    },
    {
      q: "Unit cost metrics (like credits per 1,000 dashboard views) are useful because...",
      options: [
        "They replace resource monitors",
        "They show whether rising spend is driven by growth or by inefficiency",
        "Snowflake bills by them",
        "They're needed for replication"
      ],
      answer: 1,
      why: "<p>Total spend going up 30% can be great news if usage went up 60%. Unit costs separate efficiency from demand, which is the conversation finance actually wants to have.</p>"
    },
    {
      q: "What runs data metric functions?",
      options: [
        "Your BI tool",
        "Snowflake, on the schedule set by DATA_METRIC_SCHEDULE on the table, with results in an event table",
        "A task you must write",
        "dbt only"
      ],
      answer: 1,
      why: "<p>DMFs are attached to tables and run by Snowflake (serverless) on a schedule or on changes. Results land in SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_RESULTS, where you can alert on them.</p>"
    },
    {
      q: "A team asks for ACCOUNTADMIN \"to move faster\". What's the staff-level response?",
      options: [
        "Grant it; speed matters most",
        "Find the specific actions they're blocked on and give a narrowly scoped role or an owner's-rights procedure for those",
        "Refuse and close the request",
        "Give them SECURITYADMIN instead"
      ],
      answer: 1,
      why: "<p>The blocker is usually one or two specific actions, like creating a warehouse or managing grants in their own schema. Solve that with a scoped role, a managed-access schema they own, or an owner's-rights procedure. You keep least privilege and they get unblocked.</p>"
    }
  ],
  practice: [
    {
      level: "Medium",
      title: "PR environment script",
      prompt: "<p>Write the SQL a CI job runs for pull request N: clone COURSE_DB into a PR database, grant a CI role access, and on close drop it. Add a cleanup query that finds PR databases older than 3 days.</p>",
      answer: `-- On PR open (N = 482)
USE ROLE SYSADMIN;
CREATE OR REPLACE DATABASE COURSE_DB_PR_482 CLONE COURSE_DB
  COMMENT = 'CI clone for PR 482; safe to drop';

USE ROLE SECURITYADMIN;
GRANT USAGE ON DATABASE COURSE_DB_PR_482 TO ROLE FR_CI;
GRANT USAGE ON ALL SCHEMAS IN DATABASE COURSE_DB_PR_482 TO ROLE FR_CI;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN DATABASE COURSE_DB_PR_482 TO ROLE FR_CI;
GRANT CREATE TABLE, CREATE VIEW ON ALL SCHEMAS IN DATABASE COURSE_DB_PR_482 TO ROLE FR_CI;

-- On PR close
USE ROLE SYSADMIN;
DROP DATABASE IF EXISTS COURSE_DB_PR_482;

-- Nightly cleanup: stale PR clones
SELECT DATABASE_NAME, CREATED, DATABASE_OWNER
FROM SNOWFLAKE.ACCOUNT_USAGE.DATABASES
WHERE DATABASE_NAME LIKE 'COURSE\\\\_DB\\\\_PR\\\\_%' ESCAPE '\\\\'
  AND DELETED IS NULL
  AND CREATED < DATEADD(day, -3, CURRENT_TIMESTAMP());`,
      why: "<p>The clone is instant and storage-free until the PR's changes write data. The comment tells anyone browsing the account that it's disposable. Granting a dedicated CI role keeps CI from needing SYSADMIN at runtime. The cleanup query uses an escaped underscore so <code>_</code> isn't treated as a wildcard. Feed its output to a procedure that drops each one, and you'll never discover 70 forgotten clones during a cost review. (ACCOUNT_USAGE.DATABASES lags a bit; SHOW DATABASES is real-time.)</p>"
    },
    {
      level: "Medium",
      title: "Quality checks with DMFs",
      prompt: "<p>Attach data metric functions to <code>COURSE_DB.TPCH.LINEITEM</code> that track: null part keys, duplicate (order, line number) pairs, and lines where the discount is outside 0 to 0.10. Run them on a schedule and query the results.</p>",
      answer: `ALTER TABLE COURSE_DB.TPCH.LINEITEM SET DATA_METRIC_SCHEDULE = 'USING CRON 0 * * * * UTC';

ALTER TABLE COURSE_DB.TPCH.LINEITEM
  ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.NULL_COUNT ON (L_PARTKEY);

-- Duplicate composite key: custom DMF over two columns
CREATE OR REPLACE DATA METRIC FUNCTION COURSE_DB.GOVERNANCE.DUP_PAIR_COUNT(
  t TABLE(k1 NUMBER, k2 NUMBER))
RETURNS NUMBER AS
'SELECT COUNT(*) FROM (SELECT k1, k2 FROM t GROUP BY k1, k2 HAVING COUNT(*) > 1)';

ALTER TABLE COURSE_DB.TPCH.LINEITEM
  ADD DATA METRIC FUNCTION COURSE_DB.GOVERNANCE.DUP_PAIR_COUNT ON (L_ORDERKEY, L_LINENUMBER);

CREATE OR REPLACE DATA METRIC FUNCTION COURSE_DB.GOVERNANCE.BAD_DISCOUNT_COUNT(t TABLE(d NUMBER(12,2)))
RETURNS NUMBER AS
'SELECT COUNT_IF(d < 0 OR d > 0.10) FROM t';

ALTER TABLE COURSE_DB.TPCH.LINEITEM
  ADD DATA METRIC FUNCTION COURSE_DB.GOVERNANCE.BAD_DISCOUNT_COUNT ON (L_DISCOUNT);

-- After the next scheduled run
SELECT MEASUREMENT_TIME, METRIC_NAME, ARGUMENT_NAMES, VALUE
FROM SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_RESULTS
WHERE TABLE_NAME = 'LINEITEM'
ORDER BY MEASUREMENT_TIME DESC;`,
      why: "<p>Built-in DMFs cover common checks; custom DMFs take a table argument with the columns you pass and return a number, so any SQL rule fits. The composite duplicate check counts key pairs that occur more than once, which should be 0 for TPC-H. On clean TPC-H data all three metrics should be 0, so any non-zero value means something changed. Put an alert on the results table filtered to non-zero values, with an owner per table.</p>"
    },
    {
      level: "Hard",
      title: "Cost reduction plan from evidence",
      hint: "Combine idle analysis, refresh modes, parameterized hashes, storage churn and serverless spend.",
      prompt: "<p>Leadership wants a 25% cut in Snowflake spend without hurting SLAs. Write the set of diagnostic queries you'd run first (one per lever), and describe how you'd rank the opportunities.</p>",
      answer: `-- 1. Spend by service: where does the money actually go?
SELECT SERVICE_TYPE, ROUND(SUM(CREDITS_BILLED), 0) AS credits_30d
FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
WHERE USAGE_DATE >= DATEADD(day, -30, CURRENT_DATE())
GROUP BY 1 ORDER BY 2 DESC;

-- 2. Idle warehouse time (metered vs attributed), see module 14
--    -> candidates for shorter AUTO_SUSPEND or consolidation

-- 3. Oversized warehouses: low utilisation, no spilling, short queries
SELECT WAREHOUSE_NAME, WAREHOUSE_SIZE,
       COUNT(*) AS queries,
       APPROX_PERCENTILE(EXECUTION_TIME, 0.9) / 1000 AS p90_s,
       COUNT_IF(BYTES_SPILLED_TO_LOCAL_STORAGE > 0) AS spills
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE START_TIME >= DATEADD(day, -14, CURRENT_TIMESTAMP()) AND WAREHOUSE_NAME IS NOT NULL
GROUP BY 1, 2 ORDER BY 1;

-- 4. Expensive recurring query patterns
SELECT q.QUERY_PARAMETERIZED_HASH, COUNT(*) AS runs,
       ROUND(SUM(a.CREDITS_ATTRIBUTED_COMPUTE), 1) AS credits,
       ANY_VALUE(LEFT(q.QUERY_TEXT, 150)) AS example
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q
JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY a USING (QUERY_ID)
WHERE q.START_TIME >= DATEADD(day, -14, CURRENT_TIMESTAMP())
GROUP BY 1 ORDER BY credits DESC LIMIT 25;

-- 5. Pipelines doing full refreshes
SELECT NAME, REFRESH_ACTION, COUNT(*) AS refreshes
FROM TABLE(INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY())
GROUP BY 1, 2 ORDER BY 1;

-- 6. Storage churn: Time Travel and Fail-safe heavier than active data
SELECT TABLE_CATALOG || '.' || TABLE_SCHEMA || '.' || TABLE_NAME AS t,
       ROUND(ACTIVE_BYTES / 1e9) AS active_gb,
       ROUND((TIME_TRAVEL_BYTES + FAILSAFE_BYTES) / 1e9) AS history_gb
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
WHERE TIME_TRAVEL_BYTES + FAILSAFE_BYTES > 2 * ACTIVE_BYTES AND ACTIVE_BYTES > 1e9
ORDER BY history_gb DESC LIMIT 25;

-- 7. Serverless features: clustering, search optimization, MVs
SELECT TABLE_NAME, ROUND(SUM(CREDITS_USED), 1) AS clustering_credits
FROM SNOWFLAKE.ACCOUNT_USAGE.AUTOMATIC_CLUSTERING_HISTORY
WHERE START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;`,
      why: "<p>Start with where the money goes (query 1); a 25% cut has to come from the biggest buckets. Then rank each finding by <b>savings × confidence ÷ effort and risk</b>. Settings changes like AUTO_SUSPEND and right-sizing are high-confidence, low-effort and usually come first. Query rewrites of the top recurring patterns often give the biggest compute savings but need owners and testing. Switching pipelines from full to incremental and from permanent to transient tables for rebuildable data are medium effort with steady payoff. Clustering and search optimization should be kept only where profiles show the benefit. Present it as a table with estimated credits saved, owner and date, then track actual savings weekly. Guarding SLAs means checking p95 runtimes before and after each change, not just the bill.</p>"
    },
    {
      level: "Hard",
      title: "Capstone part 1: an incremental order pipeline",
      prompt: "<p>Build an end-to-end pipeline on the TPC-H copy: (1) a RAW layer that receives new orders and line items, (2) a dynamic table that produces one row per order with net revenue, line count and customer segment, (3) a mart table of daily revenue by segment with 30-minute freshness, (4) masking on customer name in the mart-facing view for non-PII roles, and (5) a data metric function and an alert on freshness. Write it all.</p>",
      answer: `USE ROLE SYSADMIN;
USE WAREHOUSE COURSE_WH;
CREATE DATABASE IF NOT EXISTS CAPSTONE;
CREATE SCHEMA IF NOT EXISTS CAPSTONE.RAW;
CREATE SCHEMA IF NOT EXISTS CAPSTONE.CORE;
CREATE SCHEMA IF NOT EXISTS CAPSTONE.MART WITH MANAGED ACCESS;

-- (1) RAW: start from history, new rows get appended by loaders
CREATE OR REPLACE TABLE CAPSTONE.RAW.ORDERS   CLONE COURSE_DB.TPCH.ORDERS;
CREATE OR REPLACE TABLE CAPSTONE.RAW.LINEITEM CLONE COURSE_DB.TPCH.LINEITEM;
CREATE OR REPLACE TABLE CAPSTONE.RAW.CUSTOMER CLONE COURSE_DB.TPCH.CUSTOMER;

-- (2) Order-level fact, incremental
CREATE OR REPLACE DYNAMIC TABLE CAPSTONE.CORE.FCT_ORDER
  TARGET_LAG = DOWNSTREAM WAREHOUSE = COURSE_WH REFRESH_MODE = INCREMENTAL AS
SELECT o.O_ORDERKEY, o.O_ORDERDATE, o.O_CUSTKEY, c.C_NAME, c.C_MKTSEGMENT,
       SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS net_revenue,
       COUNT(*)                                    AS line_count
FROM CAPSTONE.RAW.ORDERS o
JOIN CAPSTONE.RAW.LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
JOIN CAPSTONE.RAW.CUSTOMER c ON c.C_CUSTKEY  = o.O_CUSTKEY
GROUP BY o.O_ORDERKEY, o.O_ORDERDATE, o.O_CUSTKEY, c.C_NAME, c.C_MKTSEGMENT;

-- (3) Mart: daily revenue by segment, 30-minute freshness
CREATE OR REPLACE DYNAMIC TABLE CAPSTONE.MART.DAILY_SEGMENT_REVENUE
  TARGET_LAG = '30 minutes' WAREHOUSE = COURSE_WH AS
SELECT O_ORDERDATE AS order_date, C_MKTSEGMENT AS segment,
       SUM(net_revenue) AS revenue, COUNT(*) AS orders
FROM CAPSTONE.CORE.FCT_ORDER
GROUP BY ALL;

-- (4) Customer-level mart view with masked names
CREATE OR REPLACE MASKING POLICY CAPSTONE.MART.MASK_NAME AS (v STRING) RETURNS STRING ->
  CASE WHEN IS_ROLE_IN_SESSION('PII_READER') THEN v ELSE SHA2(v, 256) END;

CREATE OR REPLACE DYNAMIC TABLE CAPSTONE.MART.CUSTOMER_REVENUE
  TARGET_LAG = '30 minutes' WAREHOUSE = COURSE_WH AS
SELECT O_CUSTKEY, C_NAME, C_MKTSEGMENT, SUM(net_revenue) AS lifetime_revenue, COUNT(*) AS orders
FROM CAPSTONE.CORE.FCT_ORDER
GROUP BY ALL;

ALTER DYNAMIC TABLE CAPSTONE.MART.CUSTOMER_REVENUE
  MODIFY COLUMN C_NAME SET MASKING POLICY CAPSTONE.MART.MASK_NAME;

-- (5) Quality + freshness monitoring
ALTER TABLE CAPSTONE.RAW.ORDERS SET DATA_METRIC_SCHEDULE = 'TRIGGER_ON_CHANGES';
ALTER TABLE CAPSTONE.RAW.ORDERS ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.DUPLICATE_COUNT ON (O_ORDERKEY);

CREATE OR REPLACE ALERT CAPSTONE.MART.STALE_MART
  WAREHOUSE = COURSE_WH SCHEDULE = '15 MINUTE'
IF (EXISTS (
  SELECT 1
  FROM TABLE(CAPSTONE.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
         NAME => 'CAPSTONE.MART.DAILY_SEGMENT_REVENUE', RESULT_LIMIT => 1))
  WHERE STATE = 'FAILED'
     OR DATA_TIMESTAMP < DATEADD(minute, -60, CURRENT_TIMESTAMP())))
THEN
  CALL SYSTEM$SEND_EMAIL('EMAIL_INT', 'data-oncall@example.com',
       'CAPSTONE mart stale', 'DAILY_SEGMENT_REVENUE failed or is over 60 minutes behind.');
ALTER ALERT CAPSTONE.MART.STALE_MART RESUME;

-- Test the flow: add an order and watch it arrive
INSERT INTO CAPSTONE.RAW.ORDERS SELECT 9100001, 1, 'O', 0, CURRENT_DATE(), '1-URGENT', 'Clerk#1', 0, 'capstone';
INSERT INTO CAPSTONE.RAW.LINEITEM SELECT 9100001, 1, 1, 1, 10, 1000, 0.05, 0.02, 'N', 'O',
       CURRENT_DATE(), CURRENT_DATE(), CURRENT_DATE(), 'NONE', 'AIR', 'capstone';
ALTER DYNAMIC TABLE CAPSTONE.MART.DAILY_SEGMENT_REVENUE REFRESH;
SELECT * FROM CAPSTONE.MART.DAILY_SEGMENT_REVENUE WHERE order_date = CURRENT_DATE();`,
      why: "<p>This pulls the course together. Clones seed RAW instantly. The core fact is a pinned-incremental dynamic table with DOWNSTREAM lag, so it refreshes only when marts need it and never silently turns into a full rebuild of 6 million lines. Marts carry the freshness promise (30 minutes) and live in a managed-access schema. The customer mart masks names with a hash, so analysts can still count and join customers without seeing names; dynamic tables accept masking policies on their columns like regular tables. Quality runs on change through a DMF, and an alert watches both failures and freshness, using a 60-minute threshold so a single slow refresh doesn't page anyone. The final inserts are an end-to-end test: one new order should appear in today's revenue after the refresh. In a real project, the next steps are grants to functional roles, putting it all in version control, and a CI job that runs this against a clone.</p>"
    },
    {
      level: "Hard",
      title: "Capstone part 2: the design review",
      prompt: "<p>Write the one-page design note you'd bring to a review for the capstone pipeline, as SQL comments. Cover: the freshness SLA and how it's met, cost estimate and controls, failure modes and recovery, security model, and what you'd change at 100x the data volume.</p>",
      answer: `/* =====================================================================
   DESIGN NOTE: CAPSTONE order revenue pipeline
   ---------------------------------------------------------------------
   PURPOSE    Daily revenue by segment and customer lifetime revenue,
              fresh within 30 minutes, for BI and finance.

   FLOW       RAW.ORDERS / LINEITEM / CUSTOMER  (append by loaders)
                -> CORE.FCT_ORDER        dynamic table, INCREMENTAL, DOWNSTREAM
                -> MART.DAILY_SEGMENT_REVENUE, MART.CUSTOMER_REVENUE
                                         dynamic tables, 30 min target lag

   SLA        30 min target lag on marts; alert at 60 min or any failed refresh.
              Lag is a target, not a guarantee: refresh duration must stay well
              under 30 min. Track p95 refresh time in DYNAMIC_TABLE_REFRESH_HISTORY.

   COST       Refreshes run on COURSE_WH (XSMALL, 60 s suspend).
              Estimate: ~48 refreshes/day x ~40 s x 1 credit/h ~= 0.5 credits/day.
              Controls: resource monitor on the warehouse, INCREMENTAL pinned on
              the large table, NO_DATA refreshes when nothing changed.

   FAILURE MODES and RECOVERY
     - Bad data loaded to RAW      -> DMF + alert; fix rows (Time Travel BEFORE
                                      the load), dynamic tables self-correct on
                                      next refresh.
     - Refresh fails repeatedly    -> table auto-suspends; alert fires; fix query,
                                      ALTER DYNAMIC TABLE ... RESUME / REFRESH.
     - Bad deploy of a definition  -> keep previous DDL in git; CREATE OR REPLACE
                                      back. For mart contract, consumers read via
                                      views so swaps are invisible.
     - Region outage               -> CAPSTONE in failover group (RPO 10 min).

   SECURITY   MART is managed access. Names masked (SHA2) unless PII_READER.
              Consumers get database role CAPSTONE.MART_READ via functional roles.
              ACCESS_HISTORY report on C_NAME reviewed monthly.

   AT 100x VOLUME (~600M lines)
     - Move refreshes to a dedicated MEDIUM/LARGE warehouse; benchmark.
     - Cluster RAW.LINEITEM / FCT_ORDER on order date if late-arriving data
       breaks natural clustering (check SYSTEM$CLUSTERING_INFORMATION).
     - Consider splitting FCT_ORDER by recent vs historical data if refreshes
       touch old partitions; watch refresh STATISTICS for rows changed.
     - Snowpipe Streaming for RAW if the SLA tightens below ~5 minutes.
     - Re-check that every layer is still INCREMENTAL after any change.

   OPEN QUESTIONS
     - Do finance users need point-in-time history (SCD2 on customer segment)?
       If yes, add a stream + task SCD2 dimension; dynamic tables show
       current state only.
   ===================================================================== */`,
      why: "<p>A staff-level design note is short and decision-focused. It states the promise (SLA) and how you'll know if it's broken, puts a number on cost and names the controls, lists realistic failure modes each with a recovery path, makes the security model explicit, and shows you've thought about scale without over-building for it today. The open questions section is as important as the rest: it shows where you need input from the business, like whether history matters, which changes the architecture. If you can write this for every pipeline you own, you're doing the job this course was built toward.</p>"
    }
  ]
});
