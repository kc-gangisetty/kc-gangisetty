window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "semi",
  num: "06",
  track: "Building in Snowflake",
  title: "Semi-structured data: VARIANT and FLATTEN",
  summary: "Turn TPC-H orders into nested JSON, then query it back with path notation, casting and FLATTEN. Plus when to keep JSON and when to pull fields into columns.",
  minutes: 45,
  level: "Intermediate",
  lessons: [
    {
      title: "VARIANT, OBJECT and ARRAY",
      body: `
<p>Snowflake stores JSON, Avro, Parquet, ORC and XML in a <code>VARIANT</code> column. A VARIANT can hold any value: a number, a string, an <code>OBJECT</code> (key/value pairs) or an <code>ARRAY</code>. Behind the scenes Snowflake pulls common paths out into their own columnar storage, so querying a field inside a VARIANT is usually nearly as fast as a regular column.</p>
<p>We don't have JSON files, so let's build realistic JSON from TPC-H: one document per order with its line items nested inside.</p>
<sql>
USE SCHEMA COURSE_DB.LANDING;

CREATE OR REPLACE TABLE ORDER_DOCS AS
SELECT o.O_ORDERKEY AS order_key,
       OBJECT_CONSTRUCT(
         'orderKey',  o.O_ORDERKEY,
         'orderDate', o.O_ORDERDATE,
         'status',    o.O_ORDERSTATUS,
         'customer',  OBJECT_CONSTRUCT('id', c.C_CUSTKEY, 'name', c.C_NAME,
                                       'segment', c.C_MKTSEGMENT, 'phone', c.C_PHONE),
         'lines',     ARRAY_AGG(OBJECT_CONSTRUCT(
                         'line', l.L_LINENUMBER, 'partKey', l.L_PARTKEY,
                         'qty', l.L_QUANTITY, 'price', l.L_EXTENDEDPRICE,
                         'discount', l.L_DISCOUNT, 'shipMode', l.L_SHIPMODE))
                       WITHIN GROUP (ORDER BY l.L_LINENUMBER)
       ) AS doc
FROM COURSE_DB.TPCH.ORDERS o
JOIN COURSE_DB.TPCH.CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
JOIN COURSE_DB.TPCH.LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
WHERE o.O_ORDERDATE >= '1998-07-01'
GROUP BY o.O_ORDERKEY, o.O_ORDERDATE, o.O_ORDERSTATUS,
         c.C_CUSTKEY, c.C_NAME, c.C_MKTSEGMENT, c.C_PHONE;

SELECT doc FROM ORDER_DOCS LIMIT 3;
</sql>
<p>Other ways to get VARIANT data: <code>PARSE_JSON('...')</code> turns a string into a VARIANT (use <code>TRY_PARSE_JSON</code> if some strings may be invalid), and loading JSON files with <code>COPY INTO</code> a single VARIANT column.</p>
`
    },
    {
      title: "Reading fields: paths and casting",
      body: `
<p>Use a colon to step into a VARIANT column, then dots or brackets for deeper levels:</p>
<sql>
SELECT doc:orderKey::NUMBER            AS order_key,
       doc:orderDate::DATE             AS order_date,
       doc:customer.name::STRING       AS customer_name,
       doc:customer['segment']::STRING AS segment,
       doc:lines[0].shipMode::STRING   AS first_line_ship_mode,
       ARRAY_SIZE(doc:lines)           AS line_count
FROM ORDER_DOCS
LIMIT 10;
</sql>
<p>Rules that cause most semi-structured bugs:</p>
<ul>
<li><b>Key names are case-sensitive.</b> <code>doc:OrderKey</code> returns NULL because the key is <code>orderKey</code>. The column name (<code>doc</code>) is not case-sensitive, but the path is.</li>
<li><b>Always cast.</b> Without <code>::STRING</code> you get a VARIANT, and strings show up wrapped in double quotes. Comparisons and joins on uncast VARIANTs behave in surprising ways.</li>
<li><b>Missing keys return NULL</b>, not an error. A typo in a path silently returns NULL for every row. Test your paths.</li>
<li>JSON <code>null</code> is different from SQL NULL. <code>doc:x</code> can be a VARIANT holding JSON null. <code>IS_NULL_VALUE(doc:x)</code> tells them apart, and the <code>STRIP_NULL_VALUES</code> file format option removes them on load.</li>
</ul>
`
    },
    {
      title: "FLATTEN: arrays into rows",
      body: `
<p>To query each line item as its own row, use <code>LATERAL FLATTEN</code>. It returns one row per array element, with columns like <code>VALUE</code>, <code>INDEX</code>, <code>KEY</code> and <code>PATH</code>.</p>
<sql>
SELECT d.order_key,
       f.INDEX                    AS array_position,
       f.VALUE:line::NUMBER       AS line_number,
       f.VALUE:partKey::NUMBER    AS part_key,
       f.VALUE:qty::NUMBER        AS qty,
       f.VALUE:price::NUMBER(12,2) * (1 - f.VALUE:discount::NUMBER(4,2)) AS net
FROM ORDER_DOCS d,
     LATERAL FLATTEN(INPUT => d.doc:lines) f
WHERE d.order_key = (SELECT MIN(order_key) FROM ORDER_DOCS);
</sql>
<p>Two FLATTEN options you'll need:</p>
<ul>
<li><code>OUTER => TRUE</code> keeps the parent row even when the array is empty or missing, like a LEFT JOIN. Without it, documents with no lines vanish from the result.</li>
<li><code>RECURSIVE => TRUE</code> walks every nested level. Great for discovering the structure of unknown JSON.</li>
</ul>
<sql>
-- Discover every path in the documents and how often it appears
SELECT f.PATH, TYPEOF(f.VALUE) AS type, COUNT(*) AS occurrences
FROM ORDER_DOCS d,
     LATERAL FLATTEN(INPUT => d.doc, RECURSIVE => TRUE) f
GROUP BY 1, 2
ORDER BY 1;
</sql>
`
    },
    {
      title: "Design choices: keep JSON or extract columns?",
      body: `
<p>A common staff-level question: should you store raw JSON or extract it into typed columns? Usually both, at different layers.</p>
<table>
<tr><th>Keep as VARIANT when</th><th>Extract to columns when</th></tr>
<tr><td>It's the raw landing layer and you want to replay history</td><td>Fields are used in filters, joins and clustering</td></tr>
<tr><td>The schema changes often and you don't control it</td><td>You need masking policies on specific fields</td></tr>
<tr><td>Fields are rarely queried</td><td>Downstream users expect typed, documented columns</td></tr>
</table>
<p>Things that degrade VARIANT performance: keys that vary per document (Snowflake can't columnarize them well), mixed types for the same key (a number in one row, a string in the next), and arrays you constantly FLATTEN. If a query FLATTENs the same big array every time, materialize the flattened rows in a table or dynamic table.</p>
<sql>
-- Typical pattern: raw VARIANT in, typed columns out
CREATE OR REPLACE TABLE ORDER_LINES_TYPED AS
SELECT d.doc:orderKey::NUMBER       AS order_key,
       d.doc:orderDate::DATE        AS order_date,
       d.doc:customer.id::NUMBER    AS cust_key,
       f.VALUE:line::NUMBER         AS line_number,
       f.VALUE:partKey::NUMBER      AS part_key,
       f.VALUE:qty::NUMBER(12,2)    AS qty,
       f.VALUE:price::NUMBER(12,2)  AS price,
       f.VALUE:discount::NUMBER(4,2) AS discount
FROM ORDER_DOCS d, LATERAL FLATTEN(INPUT => d.doc:lines) f;
</sql>
`
    }
  ],
  quiz: [
    {
      q: "<code>SELECT doc:Customer.name FROM ORDER_DOCS</code> returns NULL for every row. The JSON key is <code>customer</code>. Why?",
      options: [
        "VARIANT columns can't be nested more than one level",
        "JSON path keys are case-sensitive, so Customer doesn't match customer",
        "You must use GET_PATH for nested keys",
        "The column needs to be cast to OBJECT first"
      ],
      answer: 1,
      why: "<p>Element names in a path are case-sensitive. A missing key returns NULL instead of failing, which is why typos are easy to miss. Column names follow normal identifier rules and aren't case-sensitive unless quoted.</p>"
    },
    {
      q: "What does <code>LATERAL FLATTEN(INPUT => doc:lines)</code> produce?",
      options: [
        "One row per document with lines joined into a string",
        "One row per element of the lines array, alongside the parent row's columns",
        "A new table",
        "An OBJECT with numbered keys"
      ],
      answer: 1,
      why: "<p>FLATTEN is a table function that explodes an array (or object) into rows. LATERAL lets it reference columns from the row on its left, so each output row pairs a parent document with one element.</p>"
    },
    {
      q: "Some orders have an empty lines array. You still want them in the result with NULL line columns. What do you add?",
      options: ["RECURSIVE => TRUE", "OUTER => TRUE", "MODE => 'ARRAY'", "A WHERE lines IS NOT NULL filter"],
      answer: 1,
      why: "<p>OUTER => TRUE behaves like a LEFT JOIN: rows with empty or missing arrays produce one output row with NULL VALUE. Without it they disappear.</p>"
    },
    {
      q: "Why should you cast VARIANT fields, for example <code>doc:status::STRING</code>?",
      options: [
        "Casting is required to make queries run at all",
        "Without casting, strings stay as VARIANT (shown in quotes) and comparisons and joins can behave unexpectedly",
        "Casting makes the column case-insensitive",
        "Casting compresses the data"
      ],
      answer: 1,
      why: "<p>A VARIANT holding a string displays as <code>\"F\"</code> with quotes. Comparing VARIANT to VARCHAR works in many cases but types, sorting and join behaviour are easier to reason about once cast. It's also needed to get proper column types in CTAS.</p>"
    },
    {
      q: "Which function safely converts strings to VARIANT, returning NULL instead of failing on invalid JSON?",
      options: ["PARSE_JSON", "TRY_PARSE_JSON", "TO_VARIANT", "OBJECT_CONSTRUCT"],
      answer: 1,
      why: "<p>The TRY_ variants (TRY_PARSE_JSON, TRY_CAST, TRY_TO_NUMBER and so on) return NULL on bad input. Use them in pipelines so one bad record doesn't fail the whole batch, then count the NULLs as a quality check.</p>"
    },
    {
      q: "When is it most worth extracting a JSON field into its own typed column?",
      options: [
        "When the field is used in filters or joins and needs masking",
        "When the field is never queried",
        "When the schema changes every day",
        "Never; VARIANT is always faster"
      ],
      answer: 0,
      why: "<p>Typed columns give you reliable pruning, clustering, masking policies and clear documentation. Fields that are rarely used or highly volatile are fine left in VARIANT.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Build one JSON document",
      prompt: "<p>Return customer 1 as a single JSON object with keys <code>id</code>, <code>name</code>, <code>nation</code> and <code>balance</code>.</p>",
      answer: `SELECT OBJECT_CONSTRUCT(
         'id',      c.C_CUSTKEY,
         'name',    c.C_NAME,
         'nation',  n.N_NAME,
         'balance', c.C_ACCTBAL) AS customer_json
FROM COURSE_DB.TPCH.CUSTOMER c
JOIN COURSE_DB.TPCH.NATION n ON n.N_NATIONKEY = c.C_NATIONKEY
WHERE c.C_CUSTKEY = 1;`,
      why: "<p>OBJECT_CONSTRUCT takes alternating keys and values. Keys with NULL values are left out by default; use <code>OBJECT_CONSTRUCT_KEEP_NULL</code> if you want them present as JSON null. <code>OBJECT_CONSTRUCT(*)</code> builds an object from every column of the row.</p>"
    },
    {
      level: "Easy",
      title: "Read nested fields",
      prompt: "<p>From <code>ORDER_DOCS</code>, return order key, customer name, segment and number of lines for the 5 orders with the most lines.</p>",
      answer: `SELECT doc:orderKey::NUMBER       AS order_key,
       doc:customer.name::STRING  AS customer_name,
       doc:customer.segment::STRING AS segment,
       ARRAY_SIZE(doc:lines)      AS line_count
FROM COURSE_DB.LANDING.ORDER_DOCS
ORDER BY line_count DESC, order_key
LIMIT 5;`,
      why: "<p>Dot notation walks into nested objects. ARRAY_SIZE counts elements without flattening, which is much cheaper than FLATTEN plus COUNT. TPC-H orders have between 1 and 7 lines, so you'll see 7 at the top.</p>"
    },
    {
      level: "Medium",
      title: "Revenue by ship mode from JSON",
      hint: "FLATTEN the lines array, cast price and discount, then aggregate.",
      prompt: "<p>Using only <code>ORDER_DOCS</code>, compute net revenue per ship mode. Then check your answer against the same calculation on the relational LINEITEM table for the same orders.</p>",
      answer: `-- From JSON
SELECT f.VALUE:shipMode::STRING AS ship_mode,
       SUM(f.VALUE:price::NUMBER(12,2) * (1 - f.VALUE:discount::NUMBER(4,2))) AS net_revenue
FROM COURSE_DB.LANDING.ORDER_DOCS d,
     LATERAL FLATTEN(INPUT => d.doc:lines) f
GROUP BY ship_mode
ORDER BY ship_mode;

-- From relational tables, same orders
SELECT l.L_SHIPMODE, SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS net_revenue
FROM COURSE_DB.TPCH.LINEITEM l
JOIN COURSE_DB.TPCH.ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY
WHERE o.O_ORDERDATE >= '1998-07-01'
GROUP BY 1
ORDER BY 1;`,
      why: "<p>Both should match to the cent. If they don't, the usual culprit is casting: casting price to an integer, or forgetting to cast and letting a FLOAT sneak in. Reconciling the semi-structured path against a trusted source is exactly how you test a JSON pipeline.</p>"
    },
    {
      level: "Medium",
      title: "Handle bad JSON",
      hint: "TRY_PARSE_JSON returns NULL on invalid input.",
      prompt: "<p>Create a table of raw strings where some are valid JSON and some aren't. Load it into a VARIANT table without failing, and produce a count of good and bad rows.</p>",
      answer: `CREATE OR REPLACE TEMPORARY TABLE raw_events (payload STRING);
INSERT INTO raw_events VALUES
  ('{"orderKey": 1, "status": "O"}'),
  ('{"orderKey": 2, "status": "F"}'),
  ('{"orderKey": 3, "status": '),          -- truncated
  ('not json at all'),
  (NULL);

CREATE OR REPLACE TEMPORARY TABLE events AS
SELECT payload,
       TRY_PARSE_JSON(payload) AS doc
FROM raw_events;

SELECT COUNT_IF(doc IS NOT NULL)                         AS good,
       COUNT_IF(doc IS NULL AND payload IS NOT NULL)     AS bad,
       COUNT_IF(payload IS NULL)                         AS empty
FROM events;`,
      why: "<p>PARSE_JSON would fail the whole CTAS on the first broken row. TRY_PARSE_JSON returns NULL, so you can separate parse failures (payload present, doc NULL) from genuinely empty input. In production you'd send the bad rows to a quarantine table with the raw text so someone can fix the producer.</p>"
    },
    {
      level: "Hard",
      title: "Detect schema drift",
      hint: "FLATTEN RECURSIVE over every document, group by PATH and TYPEOF, and compare against an expected list.",
      prompt: "<p>Producers sometimes add keys or change a key's type. Write a query over <code>ORDER_DOCS</code> that lists every path with its type(s), flags any path that appears with more than one type, and flags paths not in this expected list: <code>orderKey, orderDate, status, customer.id, customer.name, customer.segment, customer.phone, lines</code> and the line fields. First insert a drifted document to test it.</p>",
      answer: `-- A drifted document: qty as a string, and a new key
INSERT INTO COURSE_DB.LANDING.ORDER_DOCS
SELECT -1, PARSE_JSON('{"orderKey": -1, "orderDate": "1998-08-01", "status": "O",
  "customer": {"id": 1, "name": "x", "segment": "BUILDING", "phone": "1", "tier": "gold"},
  "lines": [{"line": 1, "partKey": 1, "qty": "5", "price": 10, "discount": 0, "shipMode": "AIR"}]}');

WITH paths AS (
  SELECT REGEXP_REPLACE(f.PATH, '\\\\[[0-9]+\\\\]', '[]') AS path,   -- lines[3].qty -> lines[].qty
         TYPEOF(f.VALUE) AS value_type,
         COUNT(*)        AS occurrences
  FROM COURSE_DB.LANDING.ORDER_DOCS d,
       LATERAL FLATTEN(INPUT => d.doc, RECURSIVE => TRUE) f
  GROUP BY 1, 2
),
expected AS (
  SELECT VALUE::STRING AS path
  FROM TABLE(FLATTEN(INPUT => ARRAY_CONSTRUCT(
    'orderKey', 'orderDate', 'status', 'customer', 'customer.id', 'customer.name',
    'customer.segment', 'customer.phone', 'lines', 'lines[]',
    'lines[].line', 'lines[].partKey', 'lines[].qty', 'lines[].price',
    'lines[].discount', 'lines[].shipMode')))
)
SELECT p.path,
       LISTAGG(p.value_type, ', ') WITHIN GROUP (ORDER BY p.value_type) AS types_seen,
       SUM(p.occurrences)                                                AS occurrences,
       COUNT(*) > 1                                                      AS type_conflict,
       MAX(e.path) IS NULL                                               AS unexpected_path
FROM paths p
LEFT JOIN expected e ON e.path = p.path
GROUP BY p.path
HAVING type_conflict OR unexpected_path
ORDER BY p.path;`,
      why: "<p>RECURSIVE FLATTEN emits a row for every node in every document with its full path (like <code>lines[2].qty</code>). Replacing the array index with <code>[]</code> collapses all array elements into one logical path. Grouping by path and TYPEOF shows each type a path has held. A path with two types (<code>lines[].qty</code> as INTEGER and VARCHAR) is a conflict, and a path missing from the expected list (<code>customer.tier</code>) is new. Note that integers and decimals may show as INTEGER and DECIMAL for the same key, which you may choose to treat as compatible. Run this on each new batch and alert on any rows. That's a schema contract check in about 30 lines of SQL.</p>"
    }
  ]
});
