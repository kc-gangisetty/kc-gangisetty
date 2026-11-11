window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "profile",
  num: "13",
  track: "Performance and Operations",
  title: "Reading the query profile",
  summary: "Open any query's profile and know within a minute where the time went. Operators, statistics, spilling, pruning, exploding joins, and how to get the same data with GET_QUERY_OPERATOR_STATS and EXPLAIN.",
  minutes: 50,
  level: "Advanced",
  lessons: [
    {
      title: "Opening and navigating the profile",
      body: `
<p>In Snowsight, open <b>Monitoring → Query History</b>, click a query, then the <b>Query Profile</b> tab. In a worksheet, click the query ID in the results pane. The profile has three parts:</p>
<ul>
<li><b>The operator tree</b>: boxes for each operator (scan, join, aggregate and so on) connected by arrows. Data flows from the bottom (scans) to the top (result). Each arrow shows how many rows passed along it. Each box shows its share of total execution time.</li>
<li><b>Most Expensive Nodes</b>: a short list of the operators that took the most time. Start here every time.</li>
<li><b>Profile Overview and Statistics</b>: where time went by category, plus I/O, pruning, spilling and network numbers for the whole query or for whichever operator you click.</li>
</ul>
<p>The overview splits time into categories. Here's what each one usually means:</p>
<table>
<tr><th>Category</th><th>What it is</th><th>When it's high</th></tr>
<tr><td>Processing</td><td>CPU work on data</td><td>Normal for heavy joins and aggregations. Reduce rows or size up.</td></tr>
<tr><td>Local Disk IO</td><td>Reading or writing the warehouse's local SSD</td><td>Spilling to local disk, or reading cached data</td></tr>
<tr><td>Remote Disk IO</td><td>Reading from or spilling to cloud storage</td><td>Cold scans of large data, or remote spilling (bad)</td></tr>
<tr><td>Network Communication</td><td>Moving data between nodes</td><td>Big shuffles from joins and aggregations on wide rows</td></tr>
<tr><td>Synchronization</td><td>Nodes waiting on each other</td><td>Skewed data: one node has far more work than others</td></tr>
<tr><td>Initialization</td><td>Setting up the query</td><td>Usually small; high for many tiny queries</td></tr>
</table>
<p>Multi-step queries (like those using a big CTE or a stored procedure) show several step tabs at the top. Check each one.</p>
`
    },
    {
      title: "Operators you'll see",
      body: `
<table>
<tr><th>Operator</th><th>What it does</th><th>Look for</th></tr>
<tr><td>TableScan</td><td>Reads micro-partitions of a table</td><td>Partitions scanned vs total, bytes scanned, % from cache</td></tr>
<tr><td>Filter</td><td>Removes rows that don't match a predicate</td><td>Rows in vs out. A filter that drops 99% of rows after a scan suggests pruning could do better.</td></tr>
<tr><td>JoinFilter</td><td>Runtime filter built from one side of a join, applied to the other side's scan</td><td>Good sign: it's pruning the probe side using values from the build side</td></tr>
<tr><td>Join (Inner/Left/...)</td><td>Hash join of two inputs</td><td>Output rows much larger than inputs = exploding join</td></tr>
<tr><td>CartesianJoin</td><td>Every row with every row</td><td>Almost always a missing or wrong join condition</td></tr>
<tr><td>Aggregate</td><td>GROUP BY and aggregate functions</td><td>Spilling with high-cardinality groupings</td></tr>
<tr><td>Sort / SortWithLimit</td><td>ORDER BY; SortWithLimit is a top-K</td><td>Big Sort near the top with no LIMIT: does anyone need the order?</td></tr>
<tr><td>WindowFunction</td><td>OVER (...) calculations</td><td>Huge partitions or skew on the PARTITION BY key</td></tr>
<tr><td>UnionAll</td><td>Combines inputs</td><td>An Aggregate right above it means you wrote UNION, not UNION ALL</td></tr>
<tr><td>Flatten</td><td>FLATTEN of semi-structured data</td><td>Row explosion from big arrays</td></tr>
<tr><td>WithClause / WithReference</td><td>A CTE computed once and reused</td><td>Fine; shows the CTE was materialized</td></tr>
<tr><td>ExternalScan</td><td>Reading a stage or external table</td><td>Slow external reads, many small files</td></tr>
<tr><td>Insert / Update / Delete / Merge</td><td>DML writes</td><td>Rows written and number of partitions rewritten</td></tr>
<tr><td>Result</td><td>Returns rows to the client</td><td>Large results: is the client really reading millions of rows?</td></tr>
</table>
`
    },
    {
      title: "The four patterns that explain most slow queries",
      body: `
<h3>1. Pruning didn't happen</h3>
<p>Click the TableScan: Partitions scanned 49,800 of 50,000 with a selective WHERE clause. Fix the predicate, the clustering, or use search optimization (module 12).</p>
<h3>2. Spilling</h3>
<p>Statistics show "Bytes spilled to local storage" and worse, "Bytes spilled to remote storage". The operator that spilled is usually a Join, Aggregate, Sort or WindowFunction. Local spilling is a mild slowdown. Remote spilling can make a query 10x slower. Fix by sizing up the warehouse, or by reducing the data that reaches that operator: fewer columns, earlier filtering, pre-aggregation.</p>
<h3>3. Exploding joins</h3>
<p>Arrows into a Join show 6M and 800K rows; the arrow out shows 24M. The output is bigger than either input, which means many-to-many matching. Sometimes that's intended. Usually it's a join on part of a composite key. Fix the join condition or deduplicate first.</p>
<h3>4. Skew</h3>
<p>Synchronization time is high and one Join or Aggregate dominates. A few key values have most of the rows (think a NULL key, or a default customer ID like 0 or -1). One worker gets all of them while the others wait. Filter out or handle the hot key separately, or salt it.</p>
<sql>
-- See exploding join and spilling numbers on a deliberately bad join
ALTER SESSION SET USE_CACHED_RESULT = FALSE;
USE WAREHOUSE COURSE_WH;   -- XSMALL makes spilling easier to see

SELECT l.L_PARTKEY, COUNT(*) AS c
FROM COURSE_DB.TPCH.LINEITEM l
JOIN COURSE_DB.TPCH.PARTSUPP ps ON ps.PS_PARTKEY = l.L_PARTKEY   -- missing PS_SUPPKEY condition
GROUP BY 1
ORDER BY c DESC;
</sql>
`
    },
    {
      title: "Profiles as data: GET_QUERY_OPERATOR_STATS and EXPLAIN",
      body: `
<p>The profile is also available as a table function, so you can analyze it with SQL, save it, or check it automatically in CI.</p>
<sql>
SELECT OPERATOR_ID, PARENT_OPERATORS, OPERATOR_TYPE,
       OPERATOR_STATISTICS:output_rows::NUMBER                         AS output_rows,
       OPERATOR_STATISTICS:input_rows::NUMBER                          AS input_rows,
       OPERATOR_STATISTICS:pruning.partitions_scanned::NUMBER          AS parts_scanned,
       OPERATOR_STATISTICS:pruning.partitions_total::NUMBER            AS parts_total,
       OPERATOR_STATISTICS:spilling.bytes_spilled_local_storage::NUMBER  AS spilled_local,
       OPERATOR_STATISTICS:spilling.bytes_spilled_remote_storage::NUMBER AS spilled_remote,
       EXECUTION_TIME_BREAKDOWN:overall_percentage::FLOAT              AS pct_of_time,
       OPERATOR_ATTRIBUTES
FROM TABLE(GET_QUERY_OPERATOR_STATS(LAST_QUERY_ID()))
ORDER BY pct_of_time DESC NULLS LAST;
</sql>
<p>Find exploding joins across a whole query by comparing output rows to input rows on Join operators. You can wrap that in a check that fails a deployment if a model starts fanning out.</p>
<p><b>EXPLAIN</b> shows the plan the optimizer intends to run, without running it. It gives estimated partitions and bytes, which is handy for checking pruning on an expensive query before you spend credits on it.</p>
<sql>
EXPLAIN USING TEXT
SELECT SUM(O_TOTALPRICE)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1000.ORDERS
WHERE O_ORDERDATE = '1996-03-15';
-- Look at partitionsAssigned vs partitionsTotal before running it on 1.5 billion rows
</sql>
<p>Query history also has per-query columns that summarize the profile: <code>PARTITIONS_SCANNED</code>, <code>PARTITIONS_TOTAL</code>, <code>BYTES_SPILLED_TO_LOCAL_STORAGE</code>, <code>BYTES_SPILLED_TO_REMOTE_STORAGE</code>, <code>PERCENTAGE_SCANNED_FROM_CACHE</code> and the queue and compile times. Use these to find bad queries in bulk, then open individual profiles to diagnose them.</p>
`
    }
  ],
  quiz: [
    {
      q: "Where should you look first when opening a query profile?",
      options: [
        "The Result operator",
        "Most Expensive Nodes",
        "The SQL text",
        "Initialization time"
      ],
      answer: 1,
      why: "<p>It points you straight to the operators that took the most time. Fixing anything else first is usually wasted effort.</p>"
    },
    {
      q: "A Join has inputs of 1.5M and 150K rows and outputs 40M rows. What's happening?",
      options: [
        "Normal behaviour for a hash join",
        "An exploding join from many-to-many matches, usually a wrong or incomplete join key",
        "Spilling",
        "The JoinFilter is disabled"
      ],
      answer: 1,
      why: "<p>A join on a proper key returns at most as many rows as the larger side (for one-to-many). Output far larger than both inputs means keys repeat on both sides.</p>"
    },
    {
      q: "Which statistic signals the most severe memory problem?",
      options: [
        "Bytes spilled to local storage",
        "Bytes spilled to remote storage",
        "Percentage scanned from cache",
        "Bytes sent over the network"
      ],
      answer: 1,
      why: "<p>Remote spilling means the operator ran out of memory and local disk and wrote to cloud storage, which is far slower. It's the strongest signal to size up or reduce data.</p>"
    },
    {
      q: "Synchronization time is very high and one Aggregate takes most of the time. Likely cause?",
      options: [
        "Too many clusters",
        "Data skew: a few group keys hold most rows, so one worker does most of the work",
        "The result cache",
        "A missing ORDER BY"
      ],
      answer: 1,
      why: "<p>Synchronization means workers are waiting for each other. Skewed keys (like a huge NULL or default group) create one overloaded worker. Handle hot keys separately or filter them.</p>"
    },
    {
      q: "You see an Aggregate operator directly above a UnionAll. What did the author probably write?",
      options: ["UNION ALL", "UNION", "INTERSECT", "A window function"],
      answer: 1,
      why: "<p>UNION is executed as UNION ALL followed by duplicate removal (an aggregate). If duplicates aren't possible or don't matter, UNION ALL avoids that step.</p>"
    },
    {
      q: "What does EXPLAIN do that a query profile can't?",
      options: [
        "Shows actual rows per operator",
        "Shows the planned operators and estimated partitions without running the query",
        "Shows spilling",
        "Shows which user ran the query"
      ],
      answer: 1,
      why: "<p>EXPLAIN compiles but doesn't execute, so it's free to run (apart from cloud services) and tells you whether pruning will work before you scan terabytes. The profile shows actual runtime behaviour after the fact.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Find the most expensive operator",
      prompt: "<p>Run TPC-H Query 3 style SQL below on <code>TPCH_SF10</code>, then use GET_QUERY_OPERATOR_STATS to list operators ordered by their share of time.</p><sql>SELECT l.L_ORDERKEY, SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS revenue, o.O_ORDERDATE, o.O_SHIPPRIORITY\nFROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF10.CUSTOMER c\nJOIN SNOWFLAKE_SAMPLE_DATA.TPCH_SF10.ORDERS o ON o.O_CUSTKEY = c.C_CUSTKEY\nJOIN SNOWFLAKE_SAMPLE_DATA.TPCH_SF10.LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY\nWHERE c.C_MKTSEGMENT = 'BUILDING'\n  AND o.O_ORDERDATE < '1995-03-15'\n  AND l.L_SHIPDATE > '1995-03-15'\nGROUP BY l.L_ORDERKEY, o.O_ORDERDATE, o.O_SHIPPRIORITY\nORDER BY revenue DESC, o.O_ORDERDATE\nLIMIT 10;</sql>",
      answer: `-- (run the query above first, then immediately:)
SELECT OPERATOR_ID,
       OPERATOR_TYPE,
       ROUND(EXECUTION_TIME_BREAKDOWN:overall_percentage::FLOAT * 100, 1) AS pct_time,
       OPERATOR_STATISTICS:input_rows::NUMBER  AS input_rows,
       OPERATOR_STATISTICS:output_rows::NUMBER AS output_rows,
       OPERATOR_ATTRIBUTES:table_name::STRING  AS table_name
FROM TABLE(GET_QUERY_OPERATOR_STATS(LAST_QUERY_ID()))
ORDER BY pct_time DESC NULLS LAST;`,
      why: "<p>Expect the LINEITEM TableScan and the join with it to dominate, because LINEITEM is about 60 million rows at SF10. Look for a JoinFilter on the LINEITEM side: Snowflake builds a filter from the qualifying orders and uses it to skip lineitem rows early. The final Sort should be a SortWithLimit, since only the top 10 rows are needed. overall_percentage is a fraction, so multiply by 100.</p>"
    },
    {
      level: "Easy",
      title: "Check pruning before you pay",
      prompt: "<p>Use EXPLAIN to see how many partitions a single-day filter on <code>TPCH_SF1000.LINEITEM</code> would scan, without running it.</p>",
      answer: `EXPLAIN USING TABULAR
SELECT COUNT(*), SUM(L_EXTENDEDPRICE)
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1000.LINEITEM
WHERE L_SHIPDATE = '1996-03-15';`,
      why: "<p>The TableScan row shows partitionsTotal, partitionsAssigned and bytesAssigned. If assigned is a small fraction of total, pruning works and the query is cheap. If it's close to total, you're about to read terabytes. Running EXPLAIN first on very large tables is a good habit and costs essentially nothing.</p>"
    },
    {
      level: "Medium",
      title: "Make it spill, then stop it spilling",
      hint: "A big GROUP BY on a high-cardinality key with wide aggregates, on XSMALL, from TPCH_SF100.",
      prompt: "<p>Write a query on <code>TPCH_SF100.LINEITEM</code> that spills on an XSMALL warehouse. Confirm the spill in query history. Then make it stop spilling twice: once by changing the warehouse, once by changing the query.</p>",
      answer: `ALTER SESSION SET USE_CACHED_RESULT = FALSE;
ALTER WAREHOUSE BENCH_WH SET WAREHOUSE_SIZE = 'XSMALL';
USE WAREHOUSE BENCH_WH;

-- Spills: ~150M distinct order keys, with string aggregates carrying a lot of data
SELECT L_ORDERKEY,
       LISTAGG(L_COMMENT, ' | ') AS all_comments,
       ARRAY_AGG(L_SHIPINSTRUCT) AS instructions,
       SUM(L_EXTENDEDPRICE)      AS amt
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.LINEITEM
GROUP BY L_ORDERKEY;

SELECT QUERY_ID, WAREHOUSE_SIZE, TOTAL_ELAPSED_TIME / 1000 AS s,
       BYTES_SPILLED_TO_LOCAL_STORAGE, BYTES_SPILLED_TO_REMOTE_STORAGE
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION())
ORDER BY START_TIME DESC LIMIT 3;

-- Fix 1: more memory
ALTER WAREHOUSE BENCH_WH SET WAREHOUSE_SIZE = 'LARGE';
-- rerun the same query and compare spill bytes

-- Fix 2: carry less data through the aggregate (the comments were never needed)
ALTER WAREHOUSE BENCH_WH SET WAREHOUSE_SIZE = 'XSMALL';
SELECT L_ORDERKEY, SUM(L_EXTENDEDPRICE) AS amt
FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF100.LINEITEM
GROUP BY L_ORDERKEY;`,
      why: "<p>The Aggregate must hold state for every distinct order key, and LISTAGG and ARRAY_AGG make each group's state large. On XSMALL that doesn't fit in memory and spills, first to local disk, then to remote storage. A LARGE warehouse has 8x the memory, so the spill shrinks or disappears. But the cheaper fix is often in the SQL: drop the wide string aggregates nobody needs, and the same XSMALL handles the query. Always ask whether the data reaching the expensive operator is really needed before paying for a bigger warehouse.</p>"
    },
    {
      level: "Medium",
      title: "Detect exploding joins automatically",
      prompt: "<p>Write a query that takes a query ID and reports every Join operator whose output rows exceed the larger of its inputs, with the fan-out ratio. Test it on the bad PARTSUPP join from the lesson.</p>",
      answer: `SET qid = LAST_QUERY_ID();   -- run right after the query you want to check

WITH ops AS (
  SELECT OPERATOR_ID, OPERATOR_TYPE, PARENT_OPERATORS,
         OPERATOR_STATISTICS:output_rows::NUMBER AS out_rows,
         OPERATOR_ATTRIBUTES:equality_join_condition::STRING AS join_cond
  FROM TABLE(GET_QUERY_OPERATOR_STATS($qid))
),
children AS (   -- each operator's rows as an input to its parent
  SELECT p.VALUE::NUMBER AS parent_id, o.out_rows
  FROM ops o, LATERAL FLATTEN(INPUT => o.PARENT_OPERATORS) p
)
SELECT j.OPERATOR_ID,
       j.join_cond,
       MAX(c.out_rows)                          AS largest_input,
       j.out_rows                               AS output_rows,
       ROUND(j.out_rows / NULLIF(MAX(c.out_rows), 0), 2) AS fan_out
FROM ops j
JOIN children c ON c.parent_id = j.OPERATOR_ID
WHERE j.OPERATOR_TYPE ILIKE '%Join%'
GROUP BY j.OPERATOR_ID, j.join_cond, j.out_rows
HAVING j.out_rows > MAX(c.out_rows)
ORDER BY fan_out DESC;`,
      why: "<p>Each operator lists its parents, so flattening PARENT_OPERATORS gives you the edges of the tree. For every Join, its inputs are the operators that list it as a parent. Comparing the join's output rows to its largest input finds fan-out. On the LINEITEM-to-PARTSUPP join on part key only, you'll see a fan-out close to 4. Wrap this in a stored procedure and run it after each model build in CI, and you catch grain bugs before they reach a dashboard.</p>"
    },
    {
      level: "Hard",
      title: "Diagnose from numbers only",
      prompt: "<p>A teammate pastes these profile numbers from a 14-minute query on a LARGE warehouse and asks what to do. Total time split: Processing 18%, Remote Disk IO 9%, Network 11%, Synchronization 57%, Initialization 1%. Most expensive node: Aggregate [GROUP BY C_CUSTKEY] 61%. TableScan on a fact table: 12,000 of 12,400 partitions. Bytes spilled to local: 40 GB, remote: 0. Rows into the aggregate: 2.1 billion; rows out: 9.8 million. What's wrong, in order of importance, and what SQL would you write to confirm the main hypothesis?</p>",
      answer: `-- Hypothesis: skew in the GROUP BY key. Check the distribution of the key.
SELECT C_CUSTKEY, COUNT(*) AS rows_for_key
FROM fact_table
GROUP BY C_CUSTKEY
ORDER BY rows_for_key DESC
LIMIT 20;

-- Typical finding: a handful of keys (NULL, 0, -1, an "unknown" customer) hold a big share
SELECT COUNT_IF(C_CUSTKEY IS NULL) / COUNT(*) AS null_share,
       COUNT_IF(C_CUSTKEY IN (0, -1)) / COUNT(*) AS default_share
FROM fact_table;

-- Fix pattern: aggregate the hot keys separately from the rest
SELECT C_CUSTKEY, SUM(amount) FROM fact_table
WHERE C_CUSTKEY IS NOT NULL AND C_CUSTKEY NOT IN (0, -1)
GROUP BY C_CUSTKEY
UNION ALL
SELECT C_CUSTKEY, SUM(amount) FROM fact_table
WHERE C_CUSTKEY IS NULL OR C_CUSTKEY IN (0, -1)
GROUP BY C_CUSTKEY;`,
      why: "<p><b>1. Skew (main issue).</b> 57% synchronization with one Aggregate at 61% is the signature of skew: one worker got a giant group and everyone else waited. Confirm by looking at the key distribution. Junk keys like NULL or a default \"unknown customer\" are the usual culprit. Fix it upstream (why do 30% of facts have no customer?), filter it, or aggregate hot keys separately as shown. A bigger warehouse barely helps skew, because the hot group still lands on one worker. <b>2. No pruning.</b> 12,000 of 12,400 partitions means the query reads almost the whole table. Check whether it's supposed to (a full-history aggregate) or whether a date filter is missing or not pruning. <b>3. Local spill (minor).</b> 40 GB local with no remote spill is tolerable on LARGE and will likely shrink once skew is fixed. The order matters: fixing skew first could take this from 14 minutes to 2 or 3, while upsizing first would mostly double the bill.</p>"
    }
  ]
});
