window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "performance",
  num: "12",
  track: "Performance and Operations",
  title: "Query performance tuning",
  summary: "Pruning, clustering keys and clustering depth, search optimization, query acceleration, materialized views and the SQL patterns that make or break performance on big TPC-H tables.",
  minutes: 70,
  level: "Advanced",
  edition: "Search optimization and QAS need Enterprise",
  lessons: [
    {
      title: "Where query time goes",
      body: `
<p>Almost every slow Snowflake query has one of five problems. Learn to spot them and you'll fix most performance issues without guessing.</p>
<table>
<tr><th>Problem</th><th>Symptom in the profile</th><th>Usual fix</th></tr>
<tr><td>Poor pruning</td><td>Partitions scanned ≈ partitions total on a filtered query</td><td>Filter on well-clustered columns, add a clustering key, avoid functions that hide the column</td></tr>
<tr><td>Spilling</td><td>Bytes spilled to local or remote storage</td><td>Bigger warehouse, smaller intermediate results, fewer columns</td></tr>
<tr><td>Exploding joins</td><td>A join outputs far more rows than either input</td><td>Fix the join keys, deduplicate first, check for many-to-many</td></tr>
<tr><td>Too much data moved</td><td>Big network or "processing" times on wide rows</td><td>Select fewer columns, aggregate earlier, filter earlier</td></tr>
<tr><td>Queuing</td><td>Long queued time before execution</td><td>Multi-cluster or workload separation (module 11)</td></tr>
</table>
<p>The order you check them in matters. Look at the profile first (next module), find the most expensive operator, and fix that one thing. Don't start by adding clustering keys everywhere.</p>
`
    },
    {
      title: "Pruning and natural clustering",
      body: `
<p>Data lands in micro-partitions in the order it's loaded. If you load orders day by day, each partition naturally holds a narrow range of dates, and date filters prune beautifully. That's called <b>natural clustering</b>. If rows arrive in random order, every partition holds every date and nothing prunes.</p>
<p>See it on the sample data. Run these on a SMALL warehouse with the result cache off, and compare "Partitions scanned" in each profile:</p>
<sql>
ALTER SESSION SET USE_CACHED_RESULT = FALSE;
USE WAREHOUSE BENCH_WH;

-- Filter on ship date
SELECT COUNT(*), SUM(L_EXTENDEDPRICE)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.LINEITEM
WHERE L_SHIPDATE BETWEEN '1995-03-01' AND '1995-03-07';

-- Filter on a column with no relationship to load order
SELECT COUNT(*), SUM(L_EXTENDEDPRICE)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.LINEITEM
WHERE L_SUPPKEY = 4242;
</sql>
<p>Compare scanned versus total partitions. Whichever query scans fewer partitions has a filter column that lines up with how the data happens to be stored. The supplier filter is the needle-in-a-haystack type: few matching rows spread across almost every partition, so pruning can't help much. That's the case search optimization is built for.</p>
<p>Things that stop pruning even on well-clustered columns:</p>
<ul>
<li>Casting or wrapping the column in a way the optimizer can't reason about, e.g. <code>TO_VARCHAR(L_SHIPDATE) LIKE '1995-03%'</code>.</li>
<li>Filters on a joined table that only apply after the join. Snowflake does push some join filters down at runtime (you'll see "JoinFilter" in profiles), but explicit filters on the big table are more reliable.</li>
<li>Comparing with a subquery result. The optimizer may not know the value at compile time. Snowflake can sometimes still prune at runtime, but a literal or a variable is more predictable.</li>
</ul>
`
    },
    {
      title: "Clustering keys",
      body: `
<p>When natural clustering isn't good enough on a big table, define a <b>clustering key</b>. Snowflake's automatic clustering service then reorganizes micro-partitions in the background (serverless, billed separately) so rows with similar key values sit together.</p>
<sql>
USE WAREHOUSE COURSE_WH;
CREATE OR REPLACE TABLE COURSE_DB.TPCH.LINEITEM_SHUFFLED AS
SELECT * FROM COURSE_DB.TPCH.LINEITEM ORDER BY RANDOM();     -- destroy natural clustering

-- How well clustered is it on ship date?
SELECT SYSTEM$CLUSTERING_INFORMATION('COURSE_DB.TPCH.LINEITEM_SHUFFLED', '(L_SHIPDATE)');

ALTER TABLE COURSE_DB.TPCH.LINEITEM_SHUFFLED CLUSTER BY (L_SHIPDATE);
-- Wait a while (automatic clustering runs in the background), then check again
SELECT SYSTEM$CLUSTERING_INFORMATION('COURSE_DB.TPCH.LINEITEM_SHUFFLED');
</sql>
<p>Reading the output:</p>
<ul>
<li><b>average_depth</b>: on average, how many partitions overlap for a given value. Lower is better; 1 is perfect.</li>
<li><b>average_overlaps</b>: how many other partitions each partition overlaps with.</li>
<li><b>partition_depth_histogram</b>: the distribution. Lots of partitions in the high buckets means poor clustering.</li>
</ul>
<p>When to add a clustering key (all of these should be true):</p>
<ul>
<li>The table is large: multiple terabytes, or at least thousands of micro-partitions.</li>
<li>Queries filter or join on the same columns most of the time.</li>
<li>Queries are slow because of poor pruning, as shown in profiles.</li>
<li>The table isn't changing so much that reclustering would never catch up (heavy updates spread across the whole table keep re-scattering data).</li>
</ul>
<p>Choosing the key: put the column you filter on most first, choose columns with moderate cardinality (a date, not a timestamp to the microsecond; a region, not a unique ID), and keep it to 3 or 4 columns at most. For a high-cardinality column, cluster on an expression: <code>CLUSTER BY (TO_DATE(event_ts))</code> or <code>CLUSTER BY (SUBSTRING(id, 1, 4))</code>.</p>
<div class="warn"><b>Watch the cost</b>Automatic clustering costs credits every time new data arrives. Check <code>AUTOMATIC_CLUSTERING_HISTORY</code> monthly, and remember <code>ALTER TABLE ... SUSPEND RECLUSTER</code> if a key isn't paying off.</div>
`
    },
    {
      title: "Search optimization, query acceleration and materialized views",
      body: `
<p><b>Search optimization</b> (Enterprise) builds a persistent search access path that lets Snowflake skip partitions for point lookups and selective filters on high-cardinality columns, which clustering can't fix. Think "find all orders for customer 123456" or "find the row where id = X" on a billion-row table. It also helps substring searches, IN lists, geospatial predicates and lookups into VARIANT fields.</p>
<sql>
ALTER TABLE COURSE_DB.TPCH.LINEITEM_SHUFFLED ADD SEARCH OPTIMIZATION ON EQUALITY(L_ORDERKEY, L_PARTKEY);
SHOW TABLES LIKE 'LINEITEM_SHUFFLED' IN SCHEMA COURSE_DB.TPCH;   -- search_optimization_progress
SELECT SYSTEM$ESTIMATE_SEARCH_OPTIMIZATION_COSTS('COURSE_DB.TPCH.LINEITEM_SHUFFLED', 'EQUALITY(L_SUPPKEY)');
</sql>
<p>It costs storage for the search structure plus serverless credits to build and maintain it. Use it for selective lookups that run often, not for analytics that scan most of the table anyway.</p>
<p><b>Query Acceleration Service</b> (QAS, Enterprise) lends extra serverless compute to parts of eligible queries, mainly big scans with selective filters and aggregations. It helps warehouses that run a mix of normal queries and occasional huge outliers, without upsizing the whole warehouse.</p>
<sql>
ALTER WAREHOUSE BI_WH SET ENABLE_QUERY_ACCELERATION = TRUE QUERY_ACCELERATION_MAX_SCALE_FACTOR = 8;

-- Would a past query have benefited?
SELECT PARSE_JSON(SYSTEM$ESTIMATE_QUERY_ACCELERATION('<query_id>'));

-- Which recent queries would benefit most?
SELECT QUERY_ID, WAREHOUSE_NAME, ELIGIBLE_QUERY_ACCELERATION_TIME, UPPER_LIMIT_SCALE_FACTOR
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ACCELERATION_ELIGIBLE
ORDER BY ELIGIBLE_QUERY_ACCELERATION_TIME DESC
LIMIT 20;
</sql>
<p><b>Materialized views</b> (module 04) precompute single-table aggregates and filters. The optimizer can automatically use an MV to answer a query written against the base table, so users don't need to know it exists.</p>
<table>
<tr><th>Problem</th><th>Tool</th></tr>
<tr><td>Range filters on big tables don't prune</td><td>Clustering key</td></tr>
<tr><td>Point lookups / needle-in-haystack</td><td>Search optimization</td></tr>
<tr><td>Occasional huge scans on a shared warehouse</td><td>Query acceleration</td></tr>
<tr><td>Same expensive aggregate run all day</td><td>Materialized view or dynamic table</td></tr>
<tr><td>Identical repeated queries</td><td>Result cache (free)</td></tr>
</table>
`
    },
    {
      title: "SQL patterns that matter at scale",
      body: `
<ul>
<li><b>Select only the columns you need.</b> Columnar storage reads only those columns. <code>SELECT *</code> on a 100-column table can read 50x more data than needed.</li>
<li><b>Filter early, aggregate early.</b> Reduce the big table before joining it, especially before joining to other big tables.</li>
<li><b>Check join cardinality.</b> A join on a non-unique key creates duplicates and huge intermediate results. Snowflake's profile shows rows in and out of each join.</li>
<li><b>Avoid row-by-row logic.</b> Scalar subqueries, UDFs that run queries, and loops in stored procedures are all slow. Express the logic as set-based SQL.</li>
<li><b>Prefer UNION ALL to UNION</b> unless you need deduplication. UNION sorts or hashes everything to remove duplicates.</li>
<li><b>ORDER BY only at the end</b>, and only if someone reads the order. Sorting big results is expensive.</li>
<li><b>Use approximate functions</b> for big exploratory counts: <code>APPROX_COUNT_DISTINCT</code> and <code>APPROX_PERCENTILE</code> are far cheaper than exact versions and usually within a couple of percent.</li>
</ul>
<sql>
-- Slow pattern: join everything, then filter and aggregate
SELECT c.C_MKTSEGMENT, SUM(l.L_EXTENDEDPRICE)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.LINEITEM l
JOIN SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.ORDERS o   ON o.O_ORDERKEY = l.L_ORDERKEY
JOIN SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE YEAR(o.O_ORDERDATE) = 1996
GROUP BY 1;

-- Better: filter the order side with a sargable range, aggregate lineitem per order before the join
WITH o96 AS (
  SELECT O_ORDERKEY, O_CUSTKEY
  FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.ORDERS
  WHERE O_ORDERDATE >= '1996-01-01' AND O_ORDERDATE < '1997-01-01'
),
line_totals AS (
  SELECT L_ORDERKEY, SUM(L_EXTENDEDPRICE) AS amt
  FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.LINEITEM
  WHERE L_ORDERKEY IN (SELECT O_ORDERKEY FROM o96)
  GROUP BY 1
)
SELECT c.C_MKTSEGMENT, SUM(lt.amt)
FROM line_totals lt
JOIN o96 ON o96.O_ORDERKEY = lt.L_ORDERKEY
JOIN SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.CUSTOMER c ON c.C_CUSTKEY = o96.O_CUSTKEY
GROUP BY 1;
</sql>
<p>Snowflake's optimizer often finds a good plan for the first version on its own, so measure both before assuming. The habit of filtering and reducing early still pays off on complicated queries where the optimizer has less to go on.</p>
`
    }
  ],
  quiz: [
    {
      q: "A filtered query on a 3 TB table scans 49,800 of 50,000 partitions. What's the most likely issue?",
      options: [
        "The warehouse is too small",
        "The filter column isn't well clustered, so pruning can't skip partitions",
        "The result cache is disabled",
        "The table has too many columns"
      ],
      answer: 1,
      why: "<p>Scanning nearly every partition despite a selective filter means each partition's min/max range covers the filter value. Bigger warehouses would scan faster but still scan everything. Look at clustering or search optimization.</p>"
    },
    {
      q: "Which column is the best first choice for a clustering key on an events table usually queried by day?",
      options: [
        "event_id (unique)",
        "event_timestamp (to the microsecond)",
        "TO_DATE(event_timestamp)",
        "is_deleted (true/false)"
      ],
      answer: 2,
      why: "<p>Clustering works best on moderate cardinality. A unique ID or raw timestamp has too many distinct values to cluster cheaply; a boolean has too few to prune much. Clustering on the date expression matches the query pattern.</p>"
    },
    {
      q: "What does a high <code>average_depth</code> in SYSTEM$CLUSTERING_INFORMATION mean?",
      options: [
        "The table is well clustered",
        "Many partitions overlap for the same key values, so pruning on that key is poor",
        "The table has many columns",
        "Automatic clustering is disabled"
      ],
      answer: 1,
      why: "<p>Depth is how many partitions you'd have to read for one value. Depth near 1 is ideal. A high depth means values are spread across many partitions.</p>"
    },
    {
      q: "Users look up single orders by O_ORDERKEY in a 10-billion-row table with no useful clustering for that column. Best tool?",
      options: ["Clustering key on O_ORDERDATE", "Search optimization on O_ORDERKEY", "A bigger warehouse", "Query acceleration"],
      answer: 1,
      why: "<p>Search optimization is built for selective point lookups on high-cardinality columns. Clustering on the order key would also work in theory but is expensive to maintain on a key that's unique.</p>"
    },
    {
      q: "Which statement about Query Acceleration Service is true?",
      options: [
        "It makes every query faster",
        "It offloads parts of eligible large scan queries to serverless compute, up to a scale factor you set",
        "It replaces the need for a warehouse",
        "It's a type of cache"
      ],
      answer: 1,
      why: "<p>QAS helps outlier queries with large scans and selective filters. Not every query is eligible. Check QUERY_ACCELERATION_ELIGIBLE or SYSTEM$ESTIMATE_QUERY_ACCELERATION before enabling it.</p>"
    },
    {
      q: "Why can <code>UNION</code> be much slower than <code>UNION ALL</code>?",
      options: [
        "UNION runs each branch on a separate warehouse",
        "UNION removes duplicates, which needs a sort or hash over the whole result",
        "UNION disables pruning",
        "UNION ALL uses the result cache"
      ],
      answer: 1,
      why: "<p>UNION implies DISTINCT across the combined result. If the branches can't overlap, or you don't care, UNION ALL skips that work entirely.</p>"
    },
    {
      q: "When is a clustering key a bad idea?",
      options: [
        "A 5 TB table queried by date",
        "A 200 MB table",
        "A large table where most queries filter on the same two columns",
        "A fact table loaded daily in date order"
      ],
      answer: 1,
      why: "<p>A 200 MB table has only a handful of micro-partitions. There's nothing meaningful to prune, and you'd pay for reclustering for no gain. The fact table loaded in date order is already naturally clustered on date, so it likely doesn't need a key either.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "See pruning numbers",
      prompt: "<p>Run a query on <code>TPCH_SF100.ORDERS</code> that sums total price for one week in 1996. Find the partitions scanned and total in the query profile. Then run the same filter written as <code>TO_VARCHAR(O_ORDERDATE) LIKE '1996-03-0%'</code> and compare.</p>",
      answer: `ALTER SESSION SET USE_CACHED_RESULT = FALSE;

SELECT SUM(O_TOTALPRICE)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.ORDERS
WHERE O_ORDERDATE >= '1996-03-01' AND O_ORDERDATE < '1996-03-08';

SELECT SUM(O_TOTALPRICE)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.ORDERS
WHERE TO_VARCHAR(O_ORDERDATE) LIKE '1996-03-0%';

-- Partition stats for both, without opening the UI
SELECT QUERY_ID, QUERY_TEXT, PARTITIONS_SCANNED, PARTITIONS_TOTAL, TOTAL_ELAPSED_TIME
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION())
WHERE QUERY_TEXT ILIKE '%TPCH_SF100.ORDERS%'
ORDER BY START_TIME DESC LIMIT 2;`,
      why: "<p>The range filter compares the raw column with constants, which the optimizer can check against each partition's min/max. Converting the date to a string and using LIKE hides that relationship, so pruning gets much worse or disappears. (The LIKE version also catches 1996-03-08 and 09, so it isn't even the same filter.) PARTITIONS_SCANNED and PARTITIONS_TOTAL in query history let you check pruning in bulk across many queries.</p>"
    },
    {
      level: "Easy",
      title: "Approximate vs exact",
      prompt: "<p>Count distinct customers who placed orders in <code>TPCH_SF100.ORDERS</code> with <code>COUNT(DISTINCT)</code> and with <code>APPROX_COUNT_DISTINCT</code>. Compare time and accuracy.</p>",
      answer: `ALTER SESSION SET USE_CACHED_RESULT = FALSE;
SELECT COUNT(DISTINCT O_CUSTKEY)        FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.ORDERS;
SELECT APPROX_COUNT_DISTINCT(O_CUSTKEY) FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.ORDERS;`,
      why: "<p>The exact count must track every distinct key (about 10 million here), which needs lots of memory and shuffling. APPROX_COUNT_DISTINCT uses HyperLogLog, a fixed-size sketch, and is typically within about 1.6% of the true value. For dashboards and exploration that's plenty, and it can be much faster on big data.</p>"
    },
    {
      level: "Medium",
      title: "Cluster a shuffled table",
      hint: "Shuffle with ORDER BY RANDOM(), check clustering information, add a key, and compare a filtered query's partitions scanned before and after.",
      prompt: "<p>Create a shuffled copy of ORDERS from <code>TPCH_SF10</code> in COURSE_DB. Measure pruning on a one-month filter. Then instead of waiting for automatic clustering, rebuild the table sorted on the filter column and measure again. Report average_depth before and after.</p>",
      answer: `USE WAREHOUSE BENCH_WH;
ALTER SESSION SET USE_CACHED_RESULT = FALSE;

CREATE OR REPLACE TABLE COURSE_DB.TPCH.ORDERS_SF10_SHUFFLED AS
SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF10.ORDERS ORDER BY RANDOM();

SELECT SYSTEM$CLUSTERING_INFORMATION('COURSE_DB.TPCH.ORDERS_SF10_SHUFFLED', '(O_ORDERDATE)');

SELECT COUNT(*) FROM COURSE_DB.TPCH.ORDERS_SF10_SHUFFLED
WHERE O_ORDERDATE >= '1996-03-01' AND O_ORDERDATE < '1996-04-01';
-- note partitions scanned / total in the profile

-- Rebuild sorted (an instant "manual recluster")
CREATE OR REPLACE TABLE COURSE_DB.TPCH.ORDERS_SF10_SORTED AS
SELECT * FROM COURSE_DB.TPCH.ORDERS_SF10_SHUFFLED ORDER BY O_ORDERDATE;

SELECT SYSTEM$CLUSTERING_INFORMATION('COURSE_DB.TPCH.ORDERS_SF10_SORTED', '(O_ORDERDATE)');

SELECT COUNT(*) FROM COURSE_DB.TPCH.ORDERS_SF10_SORTED
WHERE O_ORDERDATE >= '1996-03-01' AND O_ORDERDATE < '1996-04-01';`,
      why: "<p>The shuffled table spreads every date across every partition, so average_depth is roughly the number of partitions and the filter scans everything. Sorting on load puts each date into a narrow band of partitions: depth drops close to 1 and the query scans a small fraction. Sorting on CTAS is a one-off fix. For a table that keeps receiving data out of order, set a clustering key and let automatic clustering maintain it. For a table you rebuild anyway, an ORDER BY in the build is often cheaper than a clustering key.</p>"
    },
    {
      level: "Medium",
      title: "Find the costliest clustering",
      prompt: "<p>Write a query that shows, for the last 30 days, the tables with automatic clustering, how many credits each used for clustering, and how many bytes and rows were reclustered.</p>",
      answer: `SELECT DATABASE_NAME || '.' || SCHEMA_NAME || '.' || TABLE_NAME AS table_name,
       ROUND(SUM(CREDITS_USED), 2)                         AS credits,
       ROUND(SUM(NUM_BYTES_RECLUSTERED) / POWER(1024, 3), 1) AS gb_reclustered,
       SUM(NUM_ROWS_RECLUSTERED)                           AS rows_reclustered
FROM SNOWFLAKE.ACCOUNT_USAGE.AUTOMATIC_CLUSTERING_HISTORY
WHERE START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY credits DESC;`,
      why: "<p>Clustering is serverless and easy to forget about. A table that reclusters terabytes a month is a red flag: maybe its key has too high cardinality, or the table gets random updates across all partitions so it never stays clustered. Compare these credits with the query time saved (fewer partitions scanned in QUERY_HISTORY). If the saving doesn't justify the cost, suspend reclustering or change the key.</p>"
    },
    {
      level: "Hard",
      title: "Fix an exploding join",
      hint: "Count rows per join key on both sides before joining. PARTSUPP has 4 suppliers per part.",
      prompt: "<p>An analyst wants total line revenue per part along with the part's supply cost, and writes the query below. The revenue numbers are about 4x too high. Explain why, prove it with a query, and fix it.</p><sql>SELECT l.L_PARTKEY,\n       SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS revenue,\n       AVG(ps.PS_SUPPLYCOST) AS avg_supply_cost\nFROM COURSE_DB.TPCH.LINEITEM l\nJOIN COURSE_DB.TPCH.PARTSUPP ps ON ps.PS_PARTKEY = l.L_PARTKEY\nGROUP BY l.L_PARTKEY;</sql>",
      answer: `-- Proof: PARTSUPP has several rows per part key
SELECT COUNT(*) AS rows_per_part, COUNT(DISTINCT PS_PARTKEY) AS parts
FROM COURSE_DB.TPCH.PARTSUPP;                         -- 800,000 rows, 200,000 parts

SELECT PS_PARTKEY, COUNT(*) FROM COURSE_DB.TPCH.PARTSUPP
GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 5;               -- every part has 4 suppliers

-- Fix 1: join on the full key (part AND supplier) so each line matches one row
SELECT l.L_PARTKEY,
       SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS revenue,
       AVG(ps.PS_SUPPLYCOST)                       AS avg_supply_cost_of_actual_suppliers
FROM COURSE_DB.TPCH.LINEITEM l
JOIN COURSE_DB.TPCH.PARTSUPP ps
  ON ps.PS_PARTKEY = l.L_PARTKEY AND ps.PS_SUPPKEY = l.L_SUPPKEY
GROUP BY l.L_PARTKEY;

-- Fix 2: aggregate each side to the grain of the answer first, then join 1:1
WITH rev AS (
  SELECT L_PARTKEY, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) AS revenue
  FROM COURSE_DB.TPCH.LINEITEM GROUP BY 1
),
cost AS (
  SELECT PS_PARTKEY, AVG(PS_SUPPLYCOST) AS avg_supply_cost
  FROM COURSE_DB.TPCH.PARTSUPP GROUP BY 1
)
SELECT rev.L_PARTKEY, rev.revenue, cost.avg_supply_cost
FROM rev JOIN cost ON cost.PS_PARTKEY = rev.L_PARTKEY;`,
      why: "<p>PARTSUPP's grain is (part, supplier). Joining on part alone matches each line item to all 4 supplier rows, so every line's revenue is counted 4 times. The AVG still looks right because averaging 4 copies doesn't change it, which is exactly why this bug slips through review. In the query profile you'd see the join output 4x the LINEITEM row count. Fix 1 joins on the true key, which also changes the meaning of the cost to \"cost from the suppliers actually used\". Fix 2 brings both sides to one row per part before joining, so it can't fan out. Choose based on what the business question really means. The general rule: know the grain of every table you join, and check row counts before and after.</p>"
    },
    {
      level: "Hard",
      title: "Pick the right optimization",
      prompt: "<p>For each case, choose the best tool (clustering, search optimization, QAS, materialized view, dynamic table, bigger warehouse, or a query rewrite), and justify it: (a) a 20 TB clickstream table, queries filter on <code>event_date</code> and are slow; data arrives continuously but out of order. (b) Support agents look up a single <code>order_id</code> in a 5-billion-row table, 10,000 times a day. (c) A finance query spills 300 GB to remote storage on a MEDIUM warehouse. (d) A shared warehouse runs fine except for a monthly report that scans 8 TB and takes an hour. (e) A dashboard tile runs <code>SELECT region, SUM(amount) FROM sales GROUP BY region</code> every 30 seconds.</p>",
      answer: `-- (a) Clustering key on the date the queries use
ALTER TABLE clickstream CLUSTER BY (event_date);

-- (b) Search optimization for point lookups
ALTER TABLE orders_big ADD SEARCH OPTIMIZATION ON EQUALITY(order_id);

-- (c) Bigger warehouse for that job (and look at reducing the data the query carries)
ALTER WAREHOUSE FINANCE_WH SET WAREHOUSE_SIZE = 'XLARGE';

-- (d) Query acceleration on the shared warehouse
ALTER WAREHOUSE SHARED_WH SET ENABLE_QUERY_ACCELERATION = TRUE
                              QUERY_ACCELERATION_MAX_SCALE_FACTOR = 16;

-- (e) Materialized view (single table aggregate) - or just let the result cache serve it
CREATE MATERIALIZED VIEW sales_by_region AS
SELECT region, SUM(amount) AS amount FROM sales GROUP BY region;`,
      why: "<p>(a) Out-of-order arrival ruins natural clustering on a huge table queried by date: the classic clustering key case. (b) Very selective lookups on a high-cardinality column are what search optimization is for. Clustering on a unique ID would be costly and less effective. (c) Remote spilling means the working set doesn't fit in memory, so a bigger warehouse fixes it directly. Also check whether the query can carry fewer columns or aggregate earlier. Run it on a separate, larger warehouse if it's a scheduled job. (d) One outlier on an otherwise healthy warehouse is the QAS use case: you don't upsize for everyone because of one report. (e) If <code>sales</code> doesn't change between runs, the result cache already serves this for free. If it changes constantly, an MV keeps the aggregate current and cheap to read. Many real answers combine tools, but naming the primary one and why is what interviewers and design reviews look for.</p>"
    }
  ]
});
