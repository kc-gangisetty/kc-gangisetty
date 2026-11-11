window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "setup",
  num: "01",
  track: "Foundations",
  title: "Getting set up with the sample data",
  summary: "Find SNOWFLAKE_SAMPLE_DATA, learn how session context works, tour the TPC-H tables and build the sandbox database the rest of the course uses.",
  minutes: 35,
  level: "Beginner",
  lessons: [
    {
      title: "Find the sample database",
      body: `
<p>Every Snowflake account can see a database called <code>SNOWFLAKE_SAMPLE_DATA</code>. It isn't stored in your account. Snowflake shares it with you through Secure Data Sharing, which is why it costs nothing to keep and why you can't change anything in it.</p>
<p>Sign in to Snowsight (the web UI), open <b>Projects → Worksheets</b>, and create a SQL worksheet. Then run:</p>
<sql>
SHOW DATABASES LIKE 'SNOWFLAKE_SAMPLE_DATA';
SHOW SCHEMAS IN DATABASE SNOWFLAKE_SAMPLE_DATA;
</sql>
<p>You should see schemas like <code>TPCH_SF1</code>, <code>TPCH_SF10</code>, <code>TPCH_SF100</code>, <code>TPCH_SF1000</code>, <code>TPCDS_SF10TCL</code> and <code>TPCDS_SF100TCL</code>. The number after SF is the scale factor. SF1 is roughly 1 GB of raw data, SF1000 is roughly 1 TB.</p>
<div class="note"><b>If it's missing</b>Some newer or trimmed-down accounts don't mount it by default. An ACCOUNTADMIN can create it from the share and hand out access:</div>
<sql>
USE ROLE ACCOUNTADMIN;
CREATE DATABASE SNOWFLAKE_SAMPLE_DATA FROM SHARE SFC_SAMPLES.SAMPLE_DATA;
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE_SAMPLE_DATA TO ROLE PUBLIC;
</sql>
<p>Notice the grant is <code>IMPORTED PRIVILEGES</code>, not <code>USAGE</code> and <code>SELECT</code>. Databases created from a share are all-or-nothing: you can't grant access to one table inside them. You'll see why in the data sharing lesson later.</p>
`
    },
    {
      title: "Session context: role, warehouse, database, schema",
      body: `
<p>Every query you run happens inside a session, and the session has four settings that matter more than anything else:</p>
<table>
<tr><th>Setting</th><th>What it controls</th><th>How to set it</th></tr>
<tr><td>Role</td><td>What you're allowed to see and do</td><td><code>USE ROLE SYSADMIN;</code></td></tr>
<tr><td>Warehouse</td><td>Which compute runs your query (and gets billed)</td><td><code>USE WAREHOUSE COURSE_WH;</code></td></tr>
<tr><td>Database</td><td>Default database for unqualified names</td><td><code>USE DATABASE COURSE_DB;</code></td></tr>
<tr><td>Schema</td><td>Default schema for unqualified names</td><td><code>USE SCHEMA TPCH;</code></td></tr>
</table>
<p>You can always check where you are:</p>
<sql>
SELECT CURRENT_ROLE(), CURRENT_WAREHOUSE(), CURRENT_DATABASE(), CURRENT_SCHEMA(),
       CURRENT_USER(), CURRENT_ACCOUNT(), CURRENT_REGION();
</sql>
<p>Object names resolve in three parts: <code>database.schema.object</code>. If you leave parts off, Snowflake fills them in from the session. That's handy in a worksheet and dangerous in production code, because the same script can hit a different table depending on who runs it. In pipelines, fully qualify everything.</p>
<sql>
-- Works anywhere, no matter what your session is set to
SELECT COUNT(*) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.ORDERS;

-- Only works if your session database is SNOWFLAKE_SAMPLE_DATA
SELECT COUNT(*) FROM TPCH_SF1.ORDERS;
</sql>
<div class="tip"><b>Habit worth forming</b>Metadata queries like <code>SELECT COUNT(*)</code> on a table often run without a warehouse at all, because Snowflake answers them from table metadata. A query that actually reads rows needs a running warehouse.</div>
`
    },
    {
      title: "A tour of the TPC-H tables",
      body: `
<p>TPC-H models a wholesale supplier. Customers place orders, each order has line items, and each line item is a part bought from a particular supplier. Here is what you're working with at scale factor 1:</p>
<table>
<tr><th>Table</th><th>Rows (SF1)</th><th>What a row is</th></tr>
<tr><td>REGION</td><td>5</td><td>AFRICA, AMERICA, ASIA, EUROPE, MIDDLE EAST</td></tr>
<tr><td>NATION</td><td>25</td><td>A country, belonging to one region</td></tr>
<tr><td>CUSTOMER</td><td>150,000</td><td>A buyer with a nation, account balance and market segment</td></tr>
<tr><td>SUPPLIER</td><td>10,000</td><td>A seller with a nation and account balance</td></tr>
<tr><td>PART</td><td>200,000</td><td>A product with brand, type, size and retail price</td></tr>
<tr><td>PARTSUPP</td><td>800,000</td><td>Which supplier sells which part, at what cost and available quantity</td></tr>
<tr><td>ORDERS</td><td>1,500,000</td><td>One order header: customer, date, status, total price, priority</td></tr>
<tr><td>LINEITEM</td><td>~6,000,000</td><td>One line of an order: part, supplier, quantity, price, discount, ship dates</td></tr>
</table>
<p>A few facts about the data that come up again and again:</p>
<ul>
<li>Order dates run from 1992-01-01 to 1998-08-02.</li>
<li><code>O_ORDERSTATUS</code> is F (fulfilled), O (open) or P (partially fulfilled).</li>
<li><code>C_MKTSEGMENT</code> has five values: AUTOMOBILE, BUILDING, FURNITURE, HOUSEHOLD, MACHINERY.</li>
<li>Revenue for a line is <code>L_EXTENDEDPRICE * (1 - L_DISCOUNT)</code>. Discount is a fraction, like 0.04.</li>
<li><code>L_RETURNFLAG</code> is R (returned), A or N. <code>L_SHIPMODE</code> values include AIR, MAIL, SHIP, TRUCK, RAIL, FOB and REG AIR.</li>
</ul>
<sql>
USE SCHEMA SNOWFLAKE_SAMPLE_DATA.TPCH_SF1;

SELECT * FROM ORDERS LIMIT 10;

SELECT O_ORDERSTATUS, COUNT(*) AS orders
FROM ORDERS
GROUP BY O_ORDERSTATUS
ORDER BY orders DESC;
</sql>
`
    },
    {
      title: "Build your sandbox",
      body: `
<p>The sample database is read-only, and you can't put streams, clustering keys or masking policies on someone else's shared tables. So we copy the data into a database we own. Everything in the course builds on this setup, so run it once now.</p>
<sql>
USE ROLE SYSADMIN;

-- A small warehouse that shuts itself off after 60 idle seconds
CREATE WAREHOUSE IF NOT EXISTS COURSE_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

CREATE DATABASE IF NOT EXISTS COURSE_DB;
CREATE SCHEMA IF NOT EXISTS COURSE_DB.TPCH;

USE WAREHOUSE COURSE_WH;
USE SCHEMA COURSE_DB.TPCH;

-- Copy every TPC-H table (CTAS = CREATE TABLE AS SELECT)
CREATE OR REPLACE TABLE REGION   AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.REGION;
CREATE OR REPLACE TABLE NATION   AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.NATION;
CREATE OR REPLACE TABLE CUSTOMER AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.CUSTOMER;
CREATE OR REPLACE TABLE SUPPLIER AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.SUPPLIER;
CREATE OR REPLACE TABLE PART     AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.PART;
CREATE OR REPLACE TABLE PARTSUPP AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.PARTSUPP;
CREATE OR REPLACE TABLE ORDERS   AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.ORDERS;
CREATE OR REPLACE TABLE LINEITEM AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.LINEITEM;

SHOW TABLES IN SCHEMA COURSE_DB.TPCH;
</sql>
<p>On an XSMALL warehouse this takes a minute or two and costs a few cents of credits. The copies take up storage in your account (a few hundred MB compressed), which is cheap but not free. Drop <code>COURSE_DB</code> when you finish the course.</p>
<div class="warn"><b>Trial accounts</b>On a trial you're usually ACCOUNTADMIN by default. Switch to SYSADMIN for building objects anyway. Module 15 explains why owning everything as ACCOUNTADMIN causes pain later.</div>
`
    }
  ],
  quiz: [
    {
      q: "Why can't you run <code>UPDATE</code> against <code>SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.ORDERS</code>?",
      options: [
        "The table is too large for DML on a trial account",
        "The database comes from a share, and shared databases are read-only for the consumer",
        "TPC-H tables have no primary key, so updates are blocked",
        "You need the ACCOUNTADMIN role to update sample data"
      ],
      answer: 1,
      why: "<p>SNOWFLAKE_SAMPLE_DATA is mounted from a share (<code>SFC_SAMPLES.SAMPLE_DATA</code>). The provider owns the data and consumers only get read access. No role in your account, including ACCOUNTADMIN, can modify it. That's why we copy it into COURSE_DB.</p>"
    },
    {
      q: "Which grant gives a role access to a database created from a share?",
      options: [
        "GRANT USAGE ON DATABASE ... TO ROLE ...",
        "GRANT SELECT ON ALL TABLES IN DATABASE ... TO ROLE ...",
        "GRANT IMPORTED PRIVILEGES ON DATABASE ... TO ROLE ...",
        "GRANT OWNERSHIP ON DATABASE ... TO ROLE ..."
      ],
      answer: 2,
      why: "<p>Shared databases use <code>IMPORTED PRIVILEGES</code>. It's a single switch that gives the role everything the provider shared. You can't grant per-table privileges on objects inside a shared database.</p>"
    },
    {
      q: "Your session is set to database COURSE_DB and schema TPCH. Which table does <code>SELECT * FROM ORDERS</code> read?",
      options: [
        "SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.ORDERS",
        "COURSE_DB.TPCH.ORDERS",
        "COURSE_DB.PUBLIC.ORDERS",
        "It errors because the name is ambiguous"
      ],
      answer: 1,
      why: "<p>Unqualified names resolve against the session's current database and schema, so <code>ORDERS</code> becomes <code>COURSE_DB.TPCH.ORDERS</code>. This is exactly why pipeline code should use fully qualified names: the result depends on session state.</p>"
    },
    {
      q: "How is revenue for a single TPC-H line item calculated?",
      options: [
        "L_EXTENDEDPRICE - L_DISCOUNT",
        "L_QUANTITY * L_EXTENDEDPRICE",
        "L_EXTENDEDPRICE * (1 - L_DISCOUNT)",
        "O_TOTALPRICE / L_LINENUMBER"
      ],
      answer: 2,
      why: "<p><code>L_EXTENDEDPRICE</code> is already quantity times unit price. <code>L_DISCOUNT</code> is a fraction (0.00 to 0.10), so the discounted revenue is <code>L_EXTENDEDPRICE * (1 - L_DISCOUNT)</code>. You'll use this expression in nearly every revenue question.</p>"
    },
    {
      q: "What does <code>AUTO_SUSPEND = 60</code> do on a warehouse?",
      options: [
        "Limits each query to 60 seconds",
        "Suspends the warehouse after 60 seconds with no running queries",
        "Suspends the warehouse after 60 minutes of uptime",
        "Bills in 60-second blocks instead of per second"
      ],
      answer: 1,
      why: "<p>AUTO_SUSPEND is the idle time, in seconds, before the warehouse shuts down. A suspended warehouse costs nothing. AUTO_RESUME brings it back when the next query arrives. Query time limits are a separate parameter (<code>STATEMENT_TIMEOUT_IN_SECONDS</code>).</p>"
    },
    {
      q: "Which schema would you use if you needed a table with billions of rows to test performance?",
      options: ["TPCH_SF1", "TPCH_SF10", "TPCH_SF1000", "INFORMATION_SCHEMA"],
      answer: 2,
      why: "<p>The scale factor sets the size. TPCH_SF1000 is around 1 TB raw, with about 6 billion LINEITEM rows and 1.5 billion ORDERS rows. It's great for seeing partition pruning and spilling in a query profile, but query it on a bigger warehouse and always with filters.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Count the customers",
      prompt: "<p>Using the shared sample data directly, return the number of customers in <code>TPCH_SF1</code>.</p>",
      answer: `SELECT COUNT(*) AS customer_count
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.CUSTOMER;`,
      why: "<p>The fully qualified name means this works regardless of session context. You should get 150,000. Run it twice and look at the query details: Snowflake often answers a bare <code>COUNT(*)</code> from metadata it keeps for every micro-partition, so it returns almost instantly.</p>"
    },
    {
      level: "Easy",
      title: "Check your context",
      prompt: "<p>Write one query that shows your current role, warehouse, database and schema. Then set your session so unqualified names point to <code>COURSE_DB.TPCH</code>.</p>",
      answer: `SELECT CURRENT_ROLE(), CURRENT_WAREHOUSE(), CURRENT_DATABASE(), CURRENT_SCHEMA();

USE ROLE SYSADMIN;
USE WAREHOUSE COURSE_WH;
USE SCHEMA COURSE_DB.TPCH;  -- sets database and schema together`,
      why: "<p>The context functions read session state. <code>USE SCHEMA db.schema</code> sets both database and schema in one go. Snowsight also shows these four settings at the top of each worksheet, and each worksheet keeps its own context.</p>"
    },
    {
      level: "Medium",
      title: "Orders by status and year",
      hint: "Use YEAR() on O_ORDERDATE and group by two columns.",
      prompt: "<p>From your copy in <code>COURSE_DB.TPCH</code>, show the number of orders per year and order status, sorted by year then status.</p>",
      answer: `SELECT YEAR(O_ORDERDATE) AS order_year,
       O_ORDERSTATUS,
       COUNT(*)            AS orders
FROM COURSE_DB.TPCH.ORDERS
GROUP BY order_year, O_ORDERSTATUS
ORDER BY order_year, O_ORDERSTATUS;`,
      why: "<p>Snowflake lets you group by a column alias defined in the SELECT list (<code>order_year</code>), which keeps the query readable. You'll notice the early years are almost all F and 1998 has lots of O. TPC-H generates status from the ship dates, so older orders are fulfilled and recent ones are still open. Knowing the shape of your data like this matters when you write tests later.</p>"
    },
    {
      level: "Medium",
      title: "Verify the copy",
      hint: "Compare COUNT(*) from both databases in one result using a UNION ALL or scalar subqueries.",
      prompt: "<p>Prove that your copy of LINEITEM has exactly the same number of rows as the shared source. Return both counts and a boolean column saying whether they match.</p>",
      answer: `SELECT src.cnt AS source_rows,
       tgt.cnt AS copy_rows,
       src.cnt = tgt.cnt AS matches
FROM (SELECT COUNT(*) AS cnt FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.LINEITEM) src
CROSS JOIN (SELECT COUNT(*) AS cnt FROM COURSE_DB.TPCH.LINEITEM) tgt;`,
      why: "<p>Each subquery returns one row, so a CROSS JOIN puts them side by side. Row count reconciliation is the first check in any migration or copy job. A stronger version would also compare a checksum, for example <code>HASH_AGG(*)</code> on each side, which catches changed values and not just missing rows.</p>"
    },
    {
      level: "Hard",
      title: "Reconcile every table at once",
      hint: "Query COURSE_DB.INFORMATION_SCHEMA.TABLES for row counts and join to a list of source counts. Or build one UNION ALL per table and compare HASH_AGG values.",
      prompt: "<p>Write a single query that checks all eight copied tables against the source and returns table name, source row count, copy row count and whether a full-content hash matches.</p>",
      answer: `WITH src AS (
  SELECT 'REGION' t, COUNT(*) n, HASH_AGG(*) h FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.REGION   UNION ALL
  SELECT 'NATION',   COUNT(*), HASH_AGG(*) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.NATION   UNION ALL
  SELECT 'CUSTOMER', COUNT(*), HASH_AGG(*) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.CUSTOMER UNION ALL
  SELECT 'SUPPLIER', COUNT(*), HASH_AGG(*) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.SUPPLIER UNION ALL
  SELECT 'PART',     COUNT(*), HASH_AGG(*) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.PART     UNION ALL
  SELECT 'PARTSUPP', COUNT(*), HASH_AGG(*) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.PARTSUPP UNION ALL
  SELECT 'ORDERS',   COUNT(*), HASH_AGG(*) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.ORDERS   UNION ALL
  SELECT 'LINEITEM', COUNT(*), HASH_AGG(*) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.LINEITEM
),
tgt AS (
  SELECT 'REGION' t, COUNT(*) n, HASH_AGG(*) h FROM COURSE_DB.TPCH.REGION   UNION ALL
  SELECT 'NATION',   COUNT(*), HASH_AGG(*) FROM COURSE_DB.TPCH.NATION   UNION ALL
  SELECT 'CUSTOMER', COUNT(*), HASH_AGG(*) FROM COURSE_DB.TPCH.CUSTOMER UNION ALL
  SELECT 'SUPPLIER', COUNT(*), HASH_AGG(*) FROM COURSE_DB.TPCH.SUPPLIER UNION ALL
  SELECT 'PART',     COUNT(*), HASH_AGG(*) FROM COURSE_DB.TPCH.PART     UNION ALL
  SELECT 'PARTSUPP', COUNT(*), HASH_AGG(*) FROM COURSE_DB.TPCH.PARTSUPP UNION ALL
  SELECT 'ORDERS',   COUNT(*), HASH_AGG(*) FROM COURSE_DB.TPCH.ORDERS   UNION ALL
  SELECT 'LINEITEM', COUNT(*), HASH_AGG(*) FROM COURSE_DB.TPCH.LINEITEM
)
SELECT src.t AS table_name,
       src.n AS source_rows,
       tgt.n AS copy_rows,
       src.h = tgt.h AS content_matches
FROM src
JOIN tgt USING (t)
ORDER BY table_name;`,
      why: "<p><code>HASH_AGG(*)</code> computes one order-independent hash over every column of every row. If any value differs, the hash differs, so it's a cheap way to prove two tables hold identical data without comparing row by row. Doing it in two CTEs and joining on table name gives you a reconciliation report you could schedule after any copy or migration. At larger scale you'd generate this SQL from <code>INFORMATION_SCHEMA.TABLES</code> instead of typing it, which is the kind of thing a stored procedure is good for (module 04).</p>"
    }
  ]
});
