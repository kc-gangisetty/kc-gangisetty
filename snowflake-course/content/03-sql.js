window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "sql",
  num: "03",
  track: "Foundations",
  title: "SQL on TPC-H, from joins to QUALIFY",
  summary: "Joins across the TPC-H model, CTEs, window functions and the Snowflake SQL extras (QUALIFY, GROUP BY ALL, EXCLUDE, PIVOT, RESULT_SCAN) you'll use every day.",
  minutes: 60,
  level: "Beginner to intermediate",
  lessons: [
    {
      title: "Joining the model",
      body: `
<p>The TPC-H tables chain together: LINEITEM → ORDERS → CUSTOMER → NATION → REGION. Most business questions walk some part of that chain. Here's revenue by region for 1995:</p>
<sql>
USE SCHEMA COURSE_DB.TPCH;

SELECT r.R_NAME                                   AS region,
       SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS revenue
FROM LINEITEM l
JOIN ORDERS   o ON o.O_ORDERKEY  = l.L_ORDERKEY
JOIN CUSTOMER c ON c.C_CUSTKEY   = o.O_CUSTKEY
JOIN NATION   n ON n.N_NATIONKEY = c.C_NATIONKEY
JOIN REGION   r ON r.R_REGIONKEY = n.N_REGIONKEY
WHERE o.O_ORDERDATE >= '1995-01-01'
  AND o.O_ORDERDATE <  '1996-01-01'
GROUP BY r.R_NAME
ORDER BY revenue DESC;
</sql>
<p>Things to notice:</p>
<ul>
<li>The date filter uses a half-open range (<code>&gt;=</code> start, <code>&lt;</code> next start). It's correct for both DATE and TIMESTAMP columns and it prunes well. Wrapping the column in a function like <code>YEAR(O_ORDERDATE) = 1995</code> usually still prunes in Snowflake, but the range form is the habit that works everywhere.</li>
<li>Join on keys. A join where the right side has duplicate keys multiplies rows. That "exploding join" is a top cause of wrong numbers and slow queries.</li>
<li>LEFT JOIN keeps unmatched rows from the left. About a third of TPC-H customers have no orders, which makes a good test: <code>CUSTOMER LEFT JOIN ORDERS</code> and count where <code>O_ORDERKEY IS NULL</code>.</li>
</ul>
`
    },
    {
      title: "CTEs and the TPC-H pricing summary",
      body: `
<p>Common table expressions (<code>WITH</code> blocks) let you name intermediate steps. They make long queries readable and testable, and Snowflake's optimizer usually inlines them, so they don't cost extra.</p>
<p>TPC-H Query 1 is the classic pricing summary. Here it is, written with a CTE so each step reads clearly:</p>
<sql>
WITH shipped AS (
  SELECT *
  FROM COURSE_DB.TPCH.LINEITEM
  WHERE L_SHIPDATE <= DATEADD(day, -90, '1998-12-01'::DATE)
)
SELECT L_RETURNFLAG,
       L_LINESTATUS,
       SUM(L_QUANTITY)                                       AS sum_qty,
       SUM(L_EXTENDEDPRICE)                                  AS sum_base_price,
       SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT))               AS sum_disc_price,
       SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT) * (1 + L_TAX)) AS sum_charge,
       AVG(L_QUANTITY)                                       AS avg_qty,
       AVG(L_DISCOUNT)                                       AS avg_disc,
       COUNT(*)                                              AS count_order
FROM shipped
GROUP BY ALL
ORDER BY L_RETURNFLAG, L_LINESTATUS;
</sql>
<p><code>GROUP BY ALL</code> is a Snowflake shortcut: it groups by every non-aggregate expression in the SELECT list, so you don't repeat them. The <code>::DATE</code> is Snowflake's cast shorthand, the same as <code>CAST(x AS DATE)</code>.</p>
`
    },
    {
      title: "Window functions and QUALIFY",
      body: `
<p>A window function computes something across a set of rows related to the current row, without collapsing them like GROUP BY does. The pattern is <code>function() OVER (PARTITION BY ... ORDER BY ...)</code>.</p>
<sql>
-- Each customer's orders with a running total and the gap since their previous order
SELECT O_CUSTKEY,
       O_ORDERKEY,
       O_ORDERDATE,
       O_TOTALPRICE,
       SUM(O_TOTALPRICE) OVER (PARTITION BY O_CUSTKEY ORDER BY O_ORDERDATE
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_spend,
       DATEDIFF(day,
                LAG(O_ORDERDATE) OVER (PARTITION BY O_CUSTKEY ORDER BY O_ORDERDATE),
                O_ORDERDATE)                                                    AS days_since_prev
FROM COURSE_DB.TPCH.ORDERS
WHERE O_CUSTKEY IN (1, 2, 4)
ORDER BY O_CUSTKEY, O_ORDERDATE;
</sql>
<p>Ranking functions differ in how they handle ties:</p>
<table>
<tr><th>Function</th><th>Ties</th><th>Example for values 100, 90, 90, 80</th></tr>
<tr><td>ROW_NUMBER()</td><td>Always unique, ties broken arbitrarily</td><td>1, 2, 3, 4</td></tr>
<tr><td>RANK()</td><td>Same rank, then gaps</td><td>1, 2, 2, 4</td></tr>
<tr><td>DENSE_RANK()</td><td>Same rank, no gaps</td><td>1, 2, 2, 3</td></tr>
</table>
<p><code>QUALIFY</code> filters on window function results, the way <code>HAVING</code> filters on aggregates. Without it you'd need a subquery. Top 3 customers by spend in each market segment:</p>
<sql>
SELECT c.C_MKTSEGMENT, c.C_NAME, SUM(o.O_TOTALPRICE) AS spend
FROM COURSE_DB.TPCH.CUSTOMER c
JOIN COURSE_DB.TPCH.ORDERS o ON o.O_CUSTKEY = c.C_CUSTKEY
GROUP BY c.C_MKTSEGMENT, c.C_NAME
QUALIFY ROW_NUMBER() OVER (PARTITION BY c.C_MKTSEGMENT ORDER BY spend DESC) <= 3
ORDER BY c.C_MKTSEGMENT, spend DESC;
</sql>
<div class="tip"><b>The dedup pattern</b><code>QUALIFY ROW_NUMBER() OVER (PARTITION BY key ORDER BY updated_at DESC) = 1</code> keeps the latest row per key. You'll write it hundreds of times in CDC pipelines.</div>
`
    },
    {
      title: "Snowflake SQL extras worth knowing",
      body: `
<table>
<tr><th>Feature</th><th>What it does</th></tr>
<tr><td><code>SELECT * EXCLUDE (col)</code></td><td>All columns except some. <code>RENAME (a AS b)</code> and <code>REPLACE (expr AS col)</code> also work.</td></tr>
<tr><td><code>ILIKE</code></td><td>Case-insensitive LIKE</td></tr>
<tr><td><code>IFF(cond, a, b)</code></td><td>Short inline IF</td></tr>
<tr><td><code>PIVOT</code> / <code>UNPIVOT</code></td><td>Rotate rows to columns and back</td></tr>
<tr><td><code>SAMPLE (10)</code></td><td>Random 10% of rows, or <code>SAMPLE (1000 ROWS)</code></td></tr>
<tr><td><code>RESULT_SCAN(LAST_QUERY_ID())</code></td><td>Query the output of the previous statement, including SHOW commands</td></tr>
<tr><td><code>MINUS</code> / <code>EXCEPT</code></td><td>Rows in the first set that aren't in the second</td></tr>
<tr><td><code>ARRAY_AGG</code>, <code>LISTAGG</code></td><td>Aggregate values into an array or delimited string</td></tr>
</table>
<sql>
-- Revenue by year, one column per ship mode
SELECT *
FROM (
  SELECT YEAR(L_SHIPDATE) AS ship_year, L_SHIPMODE,
         L_EXTENDEDPRICE * (1 - L_DISCOUNT) AS revenue
  FROM COURSE_DB.TPCH.LINEITEM
)
PIVOT (SUM(revenue) FOR L_SHIPMODE IN ('AIR', 'RAIL', 'SHIP', 'TRUCK'))
ORDER BY ship_year;

-- Turn a SHOW command into a queryable table
SHOW TABLES IN SCHEMA COURSE_DB.TPCH;
SELECT "name", "rows", "bytes"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
ORDER BY "bytes" DESC;
</sql>
<p>Columns from SHOW output are lower case, so they need double quotes. That trips up nearly everyone the first time.</p>
`
    }
  ],
  quiz: [
    {
      q: "Which clause filters rows based on a window function result without a subquery?",
      options: ["HAVING", "WHERE", "QUALIFY", "FILTER"],
      answer: 2,
      why: "<p>The logical order is FROM, WHERE, GROUP BY, HAVING, window functions, QUALIFY, ORDER BY. WHERE and HAVING run before window functions exist, so they can't see them. QUALIFY runs after.</p>"
    },
    {
      q: "Values are 500, 400, 400, 300. What does DENSE_RANK() return when ordered descending?",
      options: ["1, 2, 3, 4", "1, 2, 2, 4", "1, 2, 2, 3", "1, 1, 2, 3"],
      answer: 2,
      why: "<p>DENSE_RANK gives ties the same rank and doesn't skip the next one. RANK would give 1, 2, 2, 4. ROW_NUMBER would give 1, 2, 3, 4 with an arbitrary order between the two 400s.</p>"
    },
    {
      q: "You join ORDERS to a table that accidentally has two rows for each O_CUSTKEY. SUM(O_TOTALPRICE) is now...",
      options: ["Unchanged", "Doubled for matching orders", "Halved", "An error about duplicate keys"],
      answer: 1,
      why: "<p>Each order matches two rows, so it appears twice and gets summed twice. Snowflake doesn't enforce primary or unique keys (only NOT NULL), so it won't stop you. Check join cardinality with a quick <code>COUNT(*)</code> before and after a join when numbers look high.</p>"
    },
    {
      q: "What does <code>GROUP BY ALL</code> do?",
      options: [
        "Groups by every column in the table",
        "Groups by every non-aggregate expression in the SELECT list",
        "Creates one group for the whole result",
        "Adds subtotal and grand total rows"
      ],
      answer: 1,
      why: "<p>It saves you repeating the SELECT expressions. Subtotals come from <code>GROUP BY ROLLUP</code>, <code>CUBE</code> or <code>GROUPING SETS</code>, which Snowflake also supports.</p>"
    },
    {
      q: "Why do columns from <code>RESULT_SCAN</code> of a SHOW command need double quotes?",
      options: [
        "SHOW output columns are lower case, and unquoted identifiers are converted to upper case",
        "RESULT_SCAN only returns VARIANT values",
        "SHOW output is always encrypted",
        "Double quotes force a fresh query"
      ],
      answer: 0,
      why: "<p>Snowflake upper-cases unquoted identifiers. SHOW returns lower-case column names like <code>name</code> and <code>rows</code>, so <code>SELECT name</code> looks for <code>NAME</code> and fails. Quoting keeps the exact case.</p>"
    },
    {
      q: "Which filter on ORDERS returns exactly the orders from March 1995 and works for both DATE and TIMESTAMP columns?",
      options: [
        "O_ORDERDATE BETWEEN '1995-03-01' AND '1995-03-31'",
        "O_ORDERDATE &gt;= '1995-03-01' AND O_ORDERDATE &lt; '1995-04-01'",
        "MONTH(O_ORDERDATE) = 3",
        "O_ORDERDATE LIKE '1995-03%'"
      ],
      answer: 1,
      why: "<p>The half-open range is exact for both types. BETWEEN with '1995-03-31' misses anything after midnight on the 31st if the column is a TIMESTAMP. MONTH() = 3 ignores the year. LIKE on a date forces a string conversion.</p>"
    },
    {
      q: "Which statement about CTEs in Snowflake is most accurate?",
      options: [
        "Every CTE is written to a temporary table first",
        "CTEs are usually inlined by the optimizer, so they mainly help readability",
        "CTEs can't be referenced more than once",
        "CTEs disable partition pruning"
      ],
      answer: 1,
      why: "<p>The optimizer usually treats a CTE like an inline view. If a CTE is referenced several times and is expensive, Snowflake may compute it once and reuse it (you'll see a WithClause/WithReference in the profile). Either way, use them freely for clarity.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Top 10 customers by balance",
      prompt: "<p>Return the 10 customers with the highest account balance, showing name, nation name and balance.</p>",
      answer: `SELECT c.C_NAME, n.N_NAME AS nation, c.C_ACCTBAL
FROM COURSE_DB.TPCH.CUSTOMER c
JOIN COURSE_DB.TPCH.NATION n ON n.N_NATIONKEY = c.C_NATIONKEY
ORDER BY c.C_ACCTBAL DESC
LIMIT 10;`,
      why: "<p>A simple join from CUSTOMER to NATION on the nation key, then ORDER BY with LIMIT. Snowflake optimizes ORDER BY plus LIMIT into a top-K sort (SortWithLimit in the profile), which only keeps the best 10 rows in memory instead of sorting all 150,000.</p>"
    },
    {
      level: "Easy",
      title: "Customers without orders",
      hint: "LEFT JOIN, then filter for the NULL side.",
      prompt: "<p>How many customers have never placed an order?</p>",
      answer: `SELECT COUNT(*) AS customers_without_orders
FROM COURSE_DB.TPCH.CUSTOMER c
LEFT JOIN COURSE_DB.TPCH.ORDERS o ON o.O_CUSTKEY = c.C_CUSTKEY
WHERE o.O_ORDERKEY IS NULL;

-- Equivalent and often clearer:
SELECT COUNT(*)
FROM COURSE_DB.TPCH.CUSTOMER c
WHERE NOT EXISTS (SELECT 1 FROM COURSE_DB.TPCH.ORDERS o WHERE o.O_CUSTKEY = c.C_CUSTKEY);`,
      why: "<p>The LEFT JOIN keeps every customer and fills order columns with NULL when there's no match. Filtering on <code>O_ORDERKEY IS NULL</code> leaves only the unmatched ones. You should get 50,000. TPC-H deliberately leaves every third customer key without orders. <code>NOT EXISTS</code> expresses the same anti-join and avoids accidental duplication.</p>"
    },
    {
      level: "Medium",
      title: "Monthly revenue with month-over-month change",
      hint: "Aggregate by DATE_TRUNC('month', O_ORDERDATE) in a CTE, then use LAG in the outer query.",
      prompt: "<p>Using LINEITEM and ORDERS, compute revenue per month for 1996 and the percent change from the previous month.</p>",
      answer: `WITH monthly AS (
  SELECT DATE_TRUNC('month', o.O_ORDERDATE)          AS month,
         SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS revenue
  FROM COURSE_DB.TPCH.ORDERS o
  JOIN COURSE_DB.TPCH.LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
  WHERE o.O_ORDERDATE >= '1996-01-01' AND o.O_ORDERDATE < '1997-01-01'
  GROUP BY 1
)
SELECT month,
       revenue,
       ROUND(100 * (revenue / LAG(revenue) OVER (ORDER BY month) - 1), 2) AS pct_change
FROM monthly
ORDER BY month;`,
      why: "<p>Aggregate first, then apply the window. Putting LAG inside the aggregation would compare line items instead of months. January gets NULL because there's no earlier month in the filtered set. If you wanted December 1995 as January's baseline, widen the CTE's date range and filter in the outer query instead.</p>"
    },
    {
      level: "Medium",
      title: "Each customer's largest order",
      hint: "QUALIFY with ROW_NUMBER, partitioned by customer.",
      prompt: "<p>Return one row per customer showing their single most expensive order (order key, date, total). Break ties by taking the most recent order.</p>",
      answer: `SELECT O_CUSTKEY, O_ORDERKEY, O_ORDERDATE, O_TOTALPRICE
FROM COURSE_DB.TPCH.ORDERS
QUALIFY ROW_NUMBER() OVER (
          PARTITION BY O_CUSTKEY
          ORDER BY O_TOTALPRICE DESC, O_ORDERDATE DESC
        ) = 1;`,
      why: "<p>ROW_NUMBER guarantees exactly one row per customer. The second ORDER BY column makes the tie-break explicit, so results are deterministic. If you used RANK instead, a tie on price would return two rows for that customer. You should get 100,000 rows, one for each customer that has orders.</p>"
    },
    {
      level: "Medium",
      title: "Segment mix by region",
      hint: "PIVOT on C_MKTSEGMENT after joining CUSTOMER → NATION → REGION.",
      prompt: "<p>Produce one row per region with a column for each of the five market segments showing the customer count.</p>",
      answer: `SELECT *
FROM (
  SELECT r.R_NAME AS region, c.C_MKTSEGMENT, c.C_CUSTKEY
  FROM COURSE_DB.TPCH.CUSTOMER c
  JOIN COURSE_DB.TPCH.NATION n ON n.N_NATIONKEY = c.C_NATIONKEY
  JOIN COURSE_DB.TPCH.REGION r ON r.R_REGIONKEY = n.N_REGIONKEY
)
PIVOT (COUNT(C_CUSTKEY) FOR C_MKTSEGMENT IN
       ('AUTOMOBILE', 'BUILDING', 'FURNITURE', 'HOUSEHOLD', 'MACHINERY'))
ORDER BY region;

-- Same result with conditional aggregation (works in any SQL dialect)
SELECT r.R_NAME AS region,
       COUNT_IF(c.C_MKTSEGMENT = 'AUTOMOBILE') AS automobile,
       COUNT_IF(c.C_MKTSEGMENT = 'BUILDING')   AS building,
       COUNT_IF(c.C_MKTSEGMENT = 'FURNITURE')  AS furniture,
       COUNT_IF(c.C_MKTSEGMENT = 'HOUSEHOLD')  AS household,
       COUNT_IF(c.C_MKTSEGMENT = 'MACHINERY')  AS machinery
FROM COURSE_DB.TPCH.CUSTOMER c
JOIN COURSE_DB.TPCH.NATION n ON n.N_NATIONKEY = c.C_NATIONKEY
JOIN COURSE_DB.TPCH.REGION r ON r.R_REGIONKEY = n.N_REGIONKEY
GROUP BY region
ORDER BY region;`,
      why: "<p>PIVOT needs a subquery that contains only the grouping column, the pivot column and the value column. Any extra column becomes an extra grouping key. The conditional aggregation version is longer but easier to extend, and <code>COUNT_IF</code> is a Snowflake shortcut for <code>SUM(IFF(cond, 1, 0))</code>. Snowflake also supports <code>PIVOT ... IN (ANY)</code> to pick up values dynamically.</p>"
    },
    {
      level: "Hard",
      title: "Customers whose spending grew three years in a row",
      hint: "Yearly spend per customer, then compare with LAG(1) and LAG(2) and filter with QUALIFY or an outer WHERE.",
      prompt: "<p>Find customers whose total order spend increased in each of 1995, 1996 and 1997 compared with the year before. Return the customer key and their spend for 1994 through 1997.</p>",
      answer: `WITH yearly AS (
  SELECT O_CUSTKEY,
         YEAR(O_ORDERDATE) AS yr,
         SUM(O_TOTALPRICE) AS spend
  FROM COURSE_DB.TPCH.ORDERS
  WHERE O_ORDERDATE >= '1994-01-01' AND O_ORDERDATE < '1998-01-01'
  GROUP BY 1, 2
),
complete AS (
  -- keep customers that ordered in all four years so LAG compares adjacent years
  SELECT *
  FROM yearly
  QUALIFY COUNT(*) OVER (PARTITION BY O_CUSTKEY) = 4
),
flagged AS (
  SELECT O_CUSTKEY, yr, spend,
         spend > LAG(spend) OVER (PARTITION BY O_CUSTKEY ORDER BY yr) AS grew
  FROM complete
)
SELECT O_CUSTKEY,
       MAX(IFF(yr = 1994, spend, NULL)) AS spend_1994,
       MAX(IFF(yr = 1995, spend, NULL)) AS spend_1995,
       MAX(IFF(yr = 1996, spend, NULL)) AS spend_1996,
       MAX(IFF(yr = 1997, spend, NULL)) AS spend_1997
FROM flagged
GROUP BY O_CUSTKEY
HAVING COUNT_IF(grew) = 3
ORDER BY spend_1997 DESC;`,
      why: "<p>The trap is gaps. If a customer has no orders in 1995, LAG on 1996 compares against 1994 and you'd wrongly call it consecutive growth. The <code>complete</code> CTE keeps only customers present in all four years, which makes LAG compare adjacent years. A window <code>COUNT(*)</code> in QUALIFY does that without another join. Then <code>COUNT_IF(grew) = 3</code> means 1995, 1996 and 1997 each grew (1994's LAG is NULL, so it's not counted). The last step pivots years into columns with conditional MAX.</p>"
    },
    {
      level: "Hard",
      title: "Suppliers who could fill a big order alone",
      hint: "PARTSUPP has PS_AVAILQTY per part and supplier. Compare against the order quantity per part.",
      prompt: "<p>For order key 1 (in your COURSE_DB copy), list each line item's part and, for each part, how many suppliers have enough available quantity to supply that line by themselves. Include lines where the answer is zero.</p>",
      answer: `SELECT l.L_LINENUMBER,
       l.L_PARTKEY,
       l.L_QUANTITY,
       COUNT(ps.PS_SUPPKEY) AS suppliers_able_to_fill
FROM COURSE_DB.TPCH.LINEITEM l
LEFT JOIN COURSE_DB.TPCH.PARTSUPP ps
       ON ps.PS_PARTKEY  = l.L_PARTKEY
      AND ps.PS_AVAILQTY >= l.L_QUANTITY
WHERE l.L_ORDERKEY = 1
GROUP BY ALL
ORDER BY l.L_LINENUMBER;`,
      why: "<p>The availability condition goes in the ON clause, not WHERE. If you put <code>ps.PS_AVAILQTY &gt;= l.L_QUANTITY</code> in WHERE, rows with no qualifying supplier would have NULLs there and be filtered out, silently turning the LEFT JOIN into an INNER JOIN. <code>COUNT(ps.PS_SUPPKEY)</code> counts only non-null matches, so lines with no supplier show 0. In TPC-H every part has exactly four suppliers, so the answer for each line is between 0 and 4.</p>"
    }
  ]
});
