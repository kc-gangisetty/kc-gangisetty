window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "architecture",
  num: "02",
  track: "Foundations",
  title: "How Snowflake is built",
  summary: "The three layers, micro-partitions, the three caches, editions and how billing actually works. The mental model everything else hangs on.",
  minutes: 40,
  level: "Beginner",
  lessons: [
    {
      title: "Three layers that scale separately",
      body: `
<p>Snowflake splits the work of a database into three layers, and each one scales on its own.</p>
<table>
<tr><th>Layer</th><th>What lives there</th><th>How you pay</th></tr>
<tr><td>Storage</td><td>Your tables, compressed into columnar micro-partitions, sitting in cloud object storage (S3, Azure Blob or GCS)</td><td>Per TB per month, averaged over the month</td></tr>
<tr><td>Compute</td><td>Virtual warehouses: clusters of machines that run your queries</td><td>Credits per second while running (60-second minimum each time it starts)</td></tr>
<tr><td>Cloud services</td><td>The brain: authentication, the query optimizer, metadata, transactions, access control</td><td>Credits, but only the part above 10% of your daily warehouse spend</td></tr>
</table>
<p>The practical result: ten warehouses can read the same table at the same time without fighting over CPU. The data team's giant nightly load and the finance team's dashboard can each get their own warehouse, so one doesn't slow the other down. That's the "separation of storage and compute" people talk about.</p>
<p>It also means a warehouse holds no data permanently. Suspend it and you lose its local cache, but nothing else. Your tables are untouched.</p>
<div class="note"><b>Mental model</b>Think of storage as a library, warehouses as reading rooms you rent by the second, and cloud services as the librarian who knows where every book is and who's allowed to read it.</div>
`
    },
    {
      title: "Micro-partitions and pruning",
      body: `
<p>When you load data, Snowflake breaks it into micro-partitions. Each one holds 50 to 500 MB of uncompressed data (much smaller once compressed), stored column by column. You don't define them and you can't see them directly. They're created automatically in the order data arrives.</p>
<p>For every micro-partition, the cloud services layer keeps metadata: the row count and, for each column, the min value, max value and number of distinct values. That metadata is what makes Snowflake fast without indexes. Say you run:</p>
<sql>
SELECT SUM(O_TOTALPRICE)
FROM COURSE_DB.TPCH.ORDERS
WHERE O_ORDERDATE BETWEEN '1995-03-01' AND '1995-03-31';
</sql>
<p>The optimizer checks each micro-partition's min and max <code>O_ORDERDATE</code>. Any partition whose range doesn't overlap March 1995 gets skipped without being read. That's <b>partition pruning</b>, and it's the single most important performance idea in Snowflake. You'll see it as "Partitions scanned" versus "Partitions total" in the query profile.</p>
<p>Two more properties to remember:</p>
<ul>
<li><b>Micro-partitions are immutable.</b> An UPDATE doesn't change a file. It writes new micro-partitions with the changed rows and marks the old ones as replaced. That's how Time Travel works: the old partitions are still there for a while.</li>
<li><b>Columnar means you pay for the columns you read.</b> <code>SELECT *</code> on LINEITEM reads all 16 columns. Selecting three columns reads roughly three sixteenths as much.</li>
</ul>
`
    },
    {
      title: "The three caches",
      body: `
<p>Snowflake has three different caches, and mixing them up is one of the most common interview mistakes.</p>
<table>
<tr><th>Cache</th><th>Lives in</th><th>What it holds</th><th>How long</th></tr>
<tr><td>Result cache</td><td>Cloud services</td><td>The full result of a query</td><td>24 hours, reset each time it's reused, up to 31 days</td></tr>
<tr><td>Warehouse (local disk) cache</td><td>The warehouse's SSD and memory</td><td>Raw micro-partition data the warehouse already read</td><td>Until the warehouse suspends or resizes</td></tr>
<tr><td>Metadata cache</td><td>Cloud services</td><td>Row counts, min/max per partition, table stats</td><td>Always current</td></tr>
</table>
<p>The result cache is reused only when the query text is the same, the underlying data hasn't changed, the role has access, and the query doesn't use functions that change on every call like <code>CURRENT_TIMESTAMP()</code> or <code>RANDOM()</code>. A cached result costs no warehouse time at all, and it works across users with the same access.</p>
<sql>
-- Run this twice. The second run should say "Query result reuse" in the profile.
SELECT C_MKTSEGMENT, COUNT(*), AVG(C_ACCTBAL)
FROM COURSE_DB.TPCH.CUSTOMER
GROUP BY C_MKTSEGMENT;

-- Turn it off for your session when you're benchmarking
ALTER SESSION SET USE_CACHED_RESULT = FALSE;
</sql>
<div class="tip"><b>Trade-off you'll defend in a design review</b>A short AUTO_SUSPEND saves credits but throws away the warehouse cache. For a BI warehouse that serves the same dashboards all day, a longer suspend (5 to 10 minutes) can be cheaper overall because queries keep hitting warm cache.</div>
`
    },
    {
      title: "Editions, credits and what drives the bill",
      body: `
<p>Snowflake sells four editions. The one you're on decides which features you can use, and the course flags Enterprise-only features as they come up.</p>
<table>
<tr><th>Edition</th><th>Adds</th></tr>
<tr><td>Standard</td><td>Core platform, Time Travel up to 1 day, single-cluster warehouses</td></tr>
<tr><td>Enterprise</td><td>Time Travel up to 90 days, multi-cluster warehouses, materialized views, search optimization, query acceleration, masking and row access policies, tag-based governance</td></tr>
<tr><td>Business Critical</td><td>Tri-Secret Secure (customer-managed keys), private connectivity, failover and failback, HIPAA/PCI support</td></tr>
<tr><td>Virtual Private Snowflake</td><td>A completely separate Snowflake environment for the strictest isolation needs</td></tr>
</table>
<p>The bill has three parts:</p>
<ul>
<li><b>Compute.</b> Warehouses charge credits per second while running. An XSMALL uses 1 credit per hour, and every size up doubles it (SMALL 2, MEDIUM 4, LARGE 8 and so on). Each resume has a 60-second minimum.</li>
<li><b>Serverless features.</b> Snowpipe, automatic clustering, materialized view refresh, search optimization, serverless tasks and others run on Snowflake-managed compute and bill their own credits.</li>
<li><b>Storage.</b> Charged on the average compressed bytes per month, including Time Travel and Fail-safe copies. Cloned tables only pay for the data that changes after the clone.</li>
</ul>
<p>The price of one credit depends on your edition, cloud and region. In almost every account, warehouse compute is the biggest line on the bill, which is why modules 11 and 14 spend so long on it.</p>
`
    }
  ],
  quiz: [
    {
      q: "Two teams query the same 2 TB table at the same time, each on its own warehouse. What happens?",
      options: [
        "The second team's query waits for the first to release a table lock",
        "Both run independently because compute is separate from storage",
        "Snowflake copies the table into the second warehouse first",
        "Only one warehouse can attach to a database at a time"
      ],
      answer: 1,
      why: "<p>Warehouses read from shared storage and don't hold data permanently. Reads never block each other, so each team gets the full power of its own warehouse. This is the whole point of separating storage and compute.</p>"
    },
    {
      q: "What does Snowflake use to skip micro-partitions during a query?",
      options: [
        "B-tree indexes created on every column",
        "Min and max values per column, kept as metadata for each micro-partition",
        "Hash partitions you define when you create the table",
        "The result cache from earlier queries"
      ],
      answer: 1,
      why: "<p>Cloud services stores min/max (and distinct counts) for every column in every micro-partition. When a filter can't match a partition's range, that partition is never read. Snowflake has no traditional indexes. Search optimization (module 12) adds a different kind of access structure, but pruning comes from this metadata.</p>"
    },
    {
      q: "You run an UPDATE that changes 10 rows in a big table. What happens to storage?",
      options: [
        "The 10 rows are edited in place inside their micro-partitions",
        "The micro-partitions holding those rows are rewritten as new partitions, and the old ones are kept for Time Travel",
        "The whole table is rewritten",
        "A delta log is written and merged nightly"
      ],
      answer: 1,
      why: "<p>Micro-partitions are immutable. Snowflake writes new versions of only the affected partitions and retires the old ones. The retired partitions stay around for the Time Travel retention period and then Fail-safe, which is why heavy update workloads can grow storage costs.</p>"
    },
    {
      q: "Which query can reuse a cached result from an identical query run an hour ago, assuming the data hasn't changed?",
      options: [
        "SELECT UUID_STRING(), COUNT(*) FROM ORDERS",
        "SELECT C_MKTSEGMENT, COUNT(*) FROM CUSTOMER GROUP BY 1",
        "SELECT RANDOM(), C_NAME FROM CUSTOMER LIMIT 5",
        "SELECT CURRENT_TIMESTAMP(), COUNT(*) FROM CUSTOMER"
      ],
      answer: 1,
      why: "<p>Queries with functions that are evaluated at run time, such as <code>CURRENT_TIMESTAMP()</code> and <code>RANDOM()</code>, aren't eligible. <code>UUID_STRING()</code> is the same story. (Oddly, <code>CURRENT_DATE()</code> is an exception and can still be reused.) The plain GROUP BY query is deterministic, so it can be served from the result cache with no warehouse at all.</p>"
    },
    {
      q: "A warehouse suspends after being idle. What is lost?",
      options: [
        "The result cache",
        "The tables the warehouse created",
        "The warehouse's local disk cache of micro-partition data",
        "The metadata about micro-partitions"
      ],
      answer: 2,
      why: "<p>The local disk cache belongs to the warehouse's machines, so it's dropped on suspend. The result cache and metadata live in cloud services and survive. Tables live in storage and are never affected by warehouse state.</p>"
    },
    {
      q: "How much does a MEDIUM warehouse cost per hour of running time?",
      options: ["1 credit", "2 credits", "4 credits", "8 credits"],
      answer: 2,
      why: "<p>XSMALL is 1 credit per hour and each size doubles: SMALL 2, MEDIUM 4, LARGE 8, XLARGE 16. Billing is per second with a 60-second minimum every time the warehouse starts.</p>"
    },
    {
      q: "When do you get billed for cloud services credits?",
      options: [
        "Always, at a flat rate per query",
        "Only for the part of daily cloud services usage above 10% of daily warehouse usage",
        "Never, cloud services are free",
        "Only on Business Critical edition"
      ],
      answer: 1,
      why: "<p>Snowflake applies a daily adjustment that waives cloud services usage up to 10% of that day's warehouse compute. Accounts with tons of tiny queries, heavy metadata operations or lots of SHOW commands can cross that line, which is a cost signal worth watching.</p>"
    },
    {
      q: "Which feature needs Enterprise edition or higher?",
      options: [
        "Time Travel of 1 day",
        "Zero-copy cloning",
        "Multi-cluster warehouses",
        "Secure Data Sharing"
      ],
      answer: 2,
      why: "<p>Multi-cluster warehouses are Enterprise. Cloning, sharing and 1 day of Time Travel are available on Standard. Other Enterprise features to remember: up to 90 days of Time Travel, materialized views, masking and row access policies, search optimization and query acceleration.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Watch the result cache work",
      prompt: "<p>Run a query that counts lineitems by <code>L_SHIPMODE</code> in <code>COURSE_DB.TPCH.LINEITEM</code>. Run it a second time. Then run it a third time with result caching turned off for your session. Write down the duration of each run.</p>",
      answer: `SELECT L_SHIPMODE, COUNT(*) AS line_count
FROM COURSE_DB.TPCH.LINEITEM
GROUP BY L_SHIPMODE;

-- run again: should come back from the result cache

ALTER SESSION SET USE_CACHED_RESULT = FALSE;

SELECT L_SHIPMODE, COUNT(*) AS line_count
FROM COURSE_DB.TPCH.LINEITEM
GROUP BY L_SHIPMODE;

ALTER SESSION SET USE_CACHED_RESULT = TRUE;`,
      why: "<p>The first run reads data with the warehouse. The second comes from the result cache in milliseconds, with no warehouse time. The third has to recompute, but it's usually faster than the first because the warehouse still has the micro-partitions in its local cache. Open the query profile for each and you'll see the difference: \"Query result reuse\" on run two, and a higher \"Percentage scanned from cache\" on run three.</p>"
    },
    {
      level: "Easy",
      title: "Read the column list",
      prompt: "<p>List the column names and data types of the LINEITEM table in your sandbox, in their table order.</p>",
      answer: `SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
FROM COURSE_DB.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'TPCH'
  AND TABLE_NAME = 'LINEITEM'
ORDER BY ORDINAL_POSITION;

-- or simply
DESCRIBE TABLE COURSE_DB.TPCH.LINEITEM;`,
      why: "<p>Every database has an INFORMATION_SCHEMA with views over its own objects. Names are stored in upper case unless they were created with double quotes, so filter with upper-case literals. <code>DESCRIBE TABLE</code> gives the same info in a quick format but you can't filter or join it without <code>RESULT_SCAN</code>.</p>"
    },
    {
      level: "Medium",
      title: "Measure how much a column choice costs",
      hint: "Turn off the result cache, then compare bytes scanned in Query History or the profile for SELECT * vs a narrow column list.",
      prompt: "<p>Show, with numbers from the query profile, that selecting only <code>L_ORDERKEY, L_QUANTITY</code> from LINEITEM reads far fewer bytes than <code>SELECT *</code>. Use a <code>LIMIT</code>-free aggregate so the whole table is read both times.</p>",
      answer: `ALTER SESSION SET USE_CACHED_RESULT = FALSE;

-- Wide: reads every column
SELECT COUNT(*), HASH_AGG(*) FROM COURSE_DB.TPCH.LINEITEM;

-- Narrow: reads two columns
SELECT COUNT(*), HASH_AGG(L_ORDERKEY, L_QUANTITY) FROM COURSE_DB.TPCH.LINEITEM;

-- Compare the two from query history
SELECT QUERY_TEXT, BYTES_SCANNED, TOTAL_ELAPSED_TIME
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION())
WHERE QUERY_TEXT ILIKE '%HASH_AGG%'
ORDER BY START_TIME DESC
LIMIT 2;`,
      why: "<p>We use <code>HASH_AGG</code> to force Snowflake to actually read the columns. A plain <code>COUNT(*)</code> would be answered from metadata and read nothing. The narrow query scans a fraction of the bytes because columnar storage only fetches the columns referenced. This is why <code>SELECT *</code> in views and ELT jobs quietly costs money on wide tables.</p>"
    },
    {
      level: "Medium",
      title: "Find the edition-sensitive objects",
      hint: "Look at SHOW PARAMETERS for DATA_RETENTION_TIME_IN_DAYS at the account level.",
      prompt: "<p>Find out the current default Time Travel retention for your account and for the COURSE_DB database. What does the answer tell you about how retention is inherited?</p>",
      answer: `SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN ACCOUNT;
SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN DATABASE COURSE_DB;
SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN TABLE COURSE_DB.TPCH.ORDERS;`,
      why: "<p>Parameters cascade: account, then database, then schema, then table. Each level shows a <code>level</code> column telling you where the value was set. If the table says level is blank or DATABASE/ACCOUNT, it's inheriting. The default is 1 day. On Enterprise you can raise it to 90 for permanent objects. Knowing the cascade matters when someone sets retention to 0 at the account level and suddenly nobody can UNDROP anything.</p>"
    },
    {
      level: "Hard",
      title: "Explain a slow first run",
      prompt: "<p>A colleague says: \"I ran the same report at 9:00 and 9:30. At 9:00 it took 40 seconds, at 9:30 it took 0.2 seconds. At 10:15 it took 25 seconds even though nothing changed.\" The warehouse has <code>AUTO_SUSPEND = 600</code> and the source table is loaded by a pipeline every hour on the hour. Explain each timing, and write the query you'd use to confirm your theory.</p>",
      answer: `-- Confirm: was the 9:30 run a result-cache hit, and did the table change before 10:15?
SELECT START_TIME,
       TOTAL_ELAPSED_TIME / 1000 AS seconds,
       BYTES_SCANNED,
       PERCENTAGE_SCANNED_FROM_CACHE,
       QUERY_TEXT
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE QUERY_TEXT ILIKE '%<a unique bit of the report SQL>%'
  AND START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())
ORDER BY START_TIME;

-- When did the table last change?
SELECT TABLE_NAME, LAST_ALTERED
FROM COURSE_DB.INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'ORDERS';`,
      why: "<p><b>9:00:</b> cold. The pipeline just loaded at 9:00, so there's no valid result cache, and the warehouse was probably suspended so its disk cache was empty. Full cost. <b>9:30:</b> same query text, same role, data unchanged since 9:00, so the result cache served it. Zero bytes scanned. <b>10:15:</b> the 10:00 load changed the table, which invalidates the cached result. The warehouse also suspended after 10 idle minutes, so the disk cache was gone too. It's faster than 9:00 because only some micro-partitions are new and the warehouse may have resumed recently for other work. In QUERY_HISTORY a result-cache hit shows almost zero bytes scanned, and PERCENTAGE_SCANNED_FROM_CACHE tells you how much came from warehouse cache. (ACCOUNT_USAGE has up to 45 minutes of lag, so for very recent queries use the INFORMATION_SCHEMA table functions.)</p>"
    }
  ]
});
