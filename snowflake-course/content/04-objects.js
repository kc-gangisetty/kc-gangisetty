window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "objects",
  num: "04",
  track: "Building in Snowflake",
  title: "Creating database objects",
  summary: "Databases, schemas, the three table types, constraints, views (standard, secure, materialized), sequences, UDFs and stored procedures, all built on top of the TPC-H copy.",
  minutes: 70,
  level: "Intermediate",
  lessons: [
    {
      title: "Databases and schemas",
      body: `
<p>Objects in Snowflake live in a hierarchy: account → database → schema → objects (tables, views, stages, functions and so on). Warehouses, users, roles and resource monitors sit at the account level, outside any database.</p>
<sql>
USE ROLE SYSADMIN;

CREATE DATABASE IF NOT EXISTS SALES_DB
  DATA_RETENTION_TIME_IN_DAYS = 7
  COMMENT = 'Curated sales data built from TPC-H';

-- Schemas for each layer of a pipeline
CREATE SCHEMA IF NOT EXISTS SALES_DB.RAW;
CREATE SCHEMA IF NOT EXISTS SALES_DB.STAGING;
CREATE SCHEMA IF NOT EXISTS SALES_DB.MART WITH MANAGED ACCESS;

-- Scratch space that doesn't need Fail-safe
CREATE TRANSIENT SCHEMA IF NOT EXISTS SALES_DB.SCRATCH DATA_RETENTION_TIME_IN_DAYS = 0;
</sql>
<p>Two options to understand now:</p>
<ul>
<li><b>TRANSIENT</b> databases and schemas make every table inside them transient by default. No Fail-safe, at most 1 day of Time Travel, and lower storage cost. Good for staging and scratch data you can rebuild.</li>
<li><b>WITH MANAGED ACCESS</b> means only the schema owner (or a role with MANAGE GRANTS) can grant privileges on objects in the schema. Object owners can't hand out access on their own. That's how you keep grants centralized in production schemas. Module 15 goes deeper.</li>
</ul>
<p>Every <code>CREATE</code> has three flavours. <code>CREATE</code> fails if the object exists. <code>CREATE IF NOT EXISTS</code> does nothing if it exists. <code>CREATE OR REPLACE</code> drops and recreates it, which wipes data and grants unless you use <code>COPY GRANTS</code>. Use OR REPLACE on tables carefully.</p>
`
    },
    {
      title: "Tables: types, data types and constraints",
      body: `
<table>
<tr><th>Type</th><th>Time Travel</th><th>Fail-safe</th><th>Lives until</th><th>Use for</th></tr>
<tr><td>Permanent</td><td>0 to 90 days (over 1 needs Enterprise)</td><td>7 days</td><td>Dropped</td><td>Anything you can't easily rebuild</td></tr>
<tr><td>Transient</td><td>0 or 1 day</td><td>None</td><td>Dropped</td><td>Staging, intermediate ELT tables</td></tr>
<tr><td>Temporary</td><td>0 or 1 day</td><td>None</td><td>End of session</td><td>Session-only scratch work</td></tr>
</table>
<p>Snowflake also has external, dynamic, hybrid, event and Iceberg tables. Dynamic tables get their own module, and Iceberg is covered in the staff module.</p>
<sql>
USE SCHEMA SALES_DB.STAGING;

CREATE OR REPLACE TABLE CUSTOMER_DIM (
  customer_sk   NUMBER AUTOINCREMENT START 1 INCREMENT 1,
  customer_id   NUMBER        NOT NULL,
  customer_name VARCHAR(25)   NOT NULL,
  nation        VARCHAR(25),
  segment       VARCHAR(10),
  balance       NUMBER(12,2),
  loaded_at     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT pk_customer_dim PRIMARY KEY (customer_sk),
  CONSTRAINT uq_customer_id UNIQUE (customer_id)
)
COMMENT = 'Customer dimension from TPCH CUSTOMER + NATION';

INSERT INTO CUSTOMER_DIM (customer_id, customer_name, nation, segment, balance)
SELECT c.C_CUSTKEY, c.C_NAME, n.N_NAME, c.C_MKTSEGMENT, c.C_ACCTBAL
FROM COURSE_DB.TPCH.CUSTOMER c
JOIN COURSE_DB.TPCH.NATION n ON n.N_NATIONKEY = c.C_NATIONKEY;
</sql>
<div class="warn"><b>Constraints are mostly documentation</b>Snowflake enforces NOT NULL only. PRIMARY KEY, UNIQUE and FOREIGN KEY are recorded but not checked on standard tables. You can insert duplicate customer_id values above and nothing will stop you. Data quality has to be tested in your pipeline. (Hybrid tables are the exception: they enforce primary keys.) Declaring constraints still helps BI tools and the optimizer, and you can tell Snowflake to trust them with <code>RELY</code>.</div>
<p>Data types you'll use most: <code>NUMBER(p,s)</code> (INT is an alias for NUMBER(38,0)), <code>FLOAT</code>, <code>VARCHAR</code> (max 16 MB, and the length you declare doesn't affect storage), <code>BOOLEAN</code>, <code>DATE</code>, <code>TIMESTAMP_NTZ / _LTZ / _TZ</code>, and <code>VARIANT</code>, <code>OBJECT</code>, <code>ARRAY</code> for semi-structured data.</p>
<p>Other ways to create tables:</p>
<sql>
CREATE TABLE ORDERS_EMPTY LIKE COURSE_DB.TPCH.ORDERS;     -- same columns, no data
CREATE TABLE ORDERS_1998 AS                                -- CTAS
  SELECT * FROM COURSE_DB.TPCH.ORDERS WHERE O_ORDERDATE >= '1998-01-01';
CREATE TABLE ORDERS_DEV CLONE COURSE_DB.TPCH.ORDERS;       -- zero-copy clone
</sql>
`
    },
    {
      title: "Views: standard, secure and materialized",
      body: `
<p>A view is a saved query. Snowflake has three kinds and the choice matters for both security and cost.</p>
<table>
<tr><th>Kind</th><th>Stores data?</th><th>Definition visible to users?</th><th>Use when</th></tr>
<tr><td>View</td><td>No</td><td>Yes, to anyone with access</td><td>Simplifying queries, renaming, light logic</td></tr>
<tr><td>Secure view</td><td>No</td><td>Only to the owner</td><td>Sharing data, hiding logic, row filtering. Required for data sharing.</td></tr>
<tr><td>Materialized view (Enterprise)</td><td>Yes, kept up to date automatically</td><td>Yes (or secure)</td><td>Expensive aggregations on a single table that are queried often</td></tr>
</table>
<sql>
USE SCHEMA SALES_DB.MART;

CREATE OR REPLACE VIEW ORDER_REVENUE AS
SELECT o.O_ORDERKEY, o.O_ORDERDATE, o.O_CUSTKEY,
       SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS net_revenue
FROM COURSE_DB.TPCH.ORDERS o
JOIN COURSE_DB.TPCH.LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
GROUP BY ALL;

CREATE OR REPLACE SECURE VIEW CUSTOMER_PUBLIC AS
SELECT C_CUSTKEY, C_NAME, C_MKTSEGMENT    -- no phone, address or balance
FROM COURSE_DB.TPCH.CUSTOMER;

-- Materialized views can only reference ONE table: no joins
CREATE OR REPLACE MATERIALIZED VIEW DAILY_SHIPMENTS AS
SELECT L_SHIPDATE, L_SHIPMODE, COUNT(*) AS lines, SUM(L_QUANTITY) AS qty
FROM COURSE_DB.TPCH.LINEITEM
GROUP BY L_SHIPDATE, L_SHIPMODE;
</sql>
<p>Why do secure views exist? A normal view lets the optimizer push filters through the view, and some of those optimizations can leak information about rows you're not supposed to see (for example through a clever UDF that errors on certain values). Secure views turn those optimizations off. The cost is that secure views can be slower. Don't make every view secure by default; use them when a view is a security boundary.</p>
<p>Materialized views are maintained by a serverless background service you pay for. They shine when the base table changes rarely and the view is queried constantly. For multi-table transformations, use dynamic tables instead (module 10).</p>
`
    },
    {
      title: "Sequences, UDFs and stored procedures",
      body: `
<p><b>Sequences</b> generate unique numbers. They're guaranteed unique but not gap-free.</p>
<sql>
CREATE OR REPLACE SEQUENCE SALES_DB.STAGING.ORDER_SEQ START = 1000 INCREMENT = 1;
SELECT SALES_DB.STAGING.ORDER_SEQ.NEXTVAL;
</sql>
<p><b>User-defined functions</b> package logic you want to reuse. Scalar UDFs return one value per row. Table functions (UDTFs) return a set of rows. You can write them in SQL, JavaScript, Python, Java or Scala.</p>
<sql>
-- SQL scalar UDF: the TPC-H revenue formula in one place
CREATE OR REPLACE FUNCTION SALES_DB.STAGING.NET_PRICE(price NUMBER(12,2), discount NUMBER(12,2))
RETURNS NUMBER(18,4)
AS 'price * (1 - discount)';

SELECT L_ORDERKEY, SALES_DB.STAGING.NET_PRICE(L_EXTENDEDPRICE, L_DISCOUNT)
FROM COURSE_DB.TPCH.LINEITEM LIMIT 5;

-- SQL table function: orders for one customer
CREATE OR REPLACE FUNCTION SALES_DB.STAGING.CUSTOMER_ORDERS(cust NUMBER)
RETURNS TABLE (order_key NUMBER, order_date DATE, total NUMBER(12,2))
AS $$
  SELECT O_ORDERKEY, O_ORDERDATE, O_TOTALPRICE
  FROM COURSE_DB.TPCH.ORDERS
  WHERE O_CUSTKEY = cust
$$;

SELECT * FROM TABLE(SALES_DB.STAGING.CUSTOMER_ORDERS(1));

-- Python UDF
CREATE OR REPLACE FUNCTION SALES_DB.STAGING.PHONE_COUNTRY_CODE(phone STRING)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'f'
AS $$
def f(phone):
    return phone.split('-')[0] if phone else None
$$;
</sql>
<p><b>Stored procedures</b> run procedural logic: loops, branching, dynamic SQL, error handling. Use them for admin and orchestration work, not for row-by-row data transformation. Snowflake Scripting is the SQL-native option:</p>
<sql>
CREATE OR REPLACE PROCEDURE SALES_DB.STAGING.ROW_COUNTS(schema_name STRING)
RETURNS TABLE (table_name STRING, row_count NUMBER)
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
  res RESULTSET;
BEGIN
  res := (SELECT TABLE_NAME, ROW_COUNT
          FROM COURSE_DB.INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = :schema_name
          ORDER BY ROW_COUNT DESC);
  RETURN TABLE(res);
END;
$$;

CALL SALES_DB.STAGING.ROW_COUNTS('TPCH');
</sql>
<p><code>EXECUTE AS OWNER</code> (the default) runs with the owner's privileges, so a low-privilege caller can do something specific without getting broad access. <code>EXECUTE AS CALLER</code> runs with the caller's privileges and session. Owner's rights procedures are a common way to give someone a controlled admin action, like "refresh this table", without granting them the underlying rights.</p>
<sql>
-- Get the DDL of anything, handy for code reviews and migrations
SELECT GET_DDL('VIEW', 'SALES_DB.MART.ORDER_REVENUE');
SELECT GET_DDL('SCHEMA', 'SALES_DB.STAGING');
</sql>
`
    }
  ],
  quiz: [
    {
      q: "Which constraint does Snowflake enforce on a standard table?",
      options: ["PRIMARY KEY", "UNIQUE", "FOREIGN KEY", "NOT NULL"],
      answer: 3,
      why: "<p>Only NOT NULL is enforced on standard tables. The others are metadata. Hybrid tables do enforce primary keys, but standard and transient tables don't. Plan duplicate checks in your pipeline.</p>"
    },
    {
      q: "You need a staging table that's rebuilt nightly. You want the lowest storage cost and don't need recovery beyond a day. Which table type fits?",
      options: ["Permanent with 90-day retention", "Transient", "Temporary", "Materialized view"],
      answer: 1,
      why: "<p>Transient tables skip the 7-day Fail-safe period, so you don't pay to keep old versions around. Temporary tables would vanish when the loading session ends, which breaks the next step if it runs in another session.</p>"
    },
    {
      q: "What's the main restriction on a materialized view's query?",
      options: [
        "It can only reference a single table (no joins)",
        "It can't use GROUP BY",
        "It must be secure",
        "It can only be created on transient tables"
      ],
      answer: 0,
      why: "<p>Materialized views can query only one table and don't support joins, window functions, HAVING, ORDER BY or non-deterministic functions, among other limits. If you need joins, dynamic tables are the tool.</p>"
    },
    {
      q: "What does a secure view hide that a normal view doesn't?",
      options: [
        "The column names",
        "The view's SQL definition and some internal optimizations that could leak data",
        "The rows from users with SELECT",
        "The view from SHOW VIEWS"
      ],
      answer: 1,
      why: "<p>Non-owners can't see a secure view's text (GET_DDL and SHOW return no definition), and the optimizer skips optimizations that might expose underlying data. Users with SELECT still see the rows the view returns.</p>"
    },
    {
      q: "What happens to existing grants when you run <code>CREATE OR REPLACE TABLE t ...</code>?",
      options: [
        "They're kept automatically",
        "They're lost unless you add COPY GRANTS",
        "They move to the PUBLIC role",
        "The statement fails if grants exist"
      ],
      answer: 1,
      why: "<p>OR REPLACE drops and recreates the object, and the new object starts with no grants. <code>CREATE OR REPLACE TABLE t COPY GRANTS ...</code> carries them over. Forgetting this is a classic cause of \"the dashboard broke after deploy\" incidents. Future grants (module 15) also help.</p>"
    },
    {
      q: "A stored procedure is created with EXECUTE AS OWNER by role ETL_ADMIN. A user with role ANALYST calls it. Whose privileges does it use?",
      options: ["ANALYST", "ETL_ADMIN", "ACCOUNTADMIN", "Both, whichever is higher"],
      answer: 1,
      why: "<p>Owner's rights procedures run with the owning role's privileges. ANALYST only needs USAGE on the procedure. That's the point: you give a narrow, audited capability without granting broad access. Owner's rights procedures also restrict some things, such as reading the caller's session variables.</p>"
    },
    {
      q: "Which statement about sequences is true?",
      options: [
        "Values are always consecutive with no gaps",
        "Values are unique but may have gaps",
        "Sequences reset every day",
        "Sequences only work in stored procedures"
      ],
      answer: 1,
      why: "<p>Snowflake guarantees uniqueness, not that numbers are gap-free. Concurrent sessions and rolled-back statements both create gaps. Never use a sequence as a count of rows.</p>"
    },
    {
      q: "In a MANAGED ACCESS schema, who can grant SELECT on a table to another role?",
      options: [
        "The table owner",
        "The schema owner or a role with MANAGE GRANTS",
        "Anyone with SELECT on the table",
        "Only ACCOUNTADMIN"
      ],
      answer: 1,
      why: "<p>Managed access takes grant decisions away from individual object owners and centralizes them with the schema owner (or MANAGE GRANTS, which SECURITYADMIN has). That stops developers handing out access on tables they happen to own.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Build the layered schemas",
      prompt: "<p>Create a database <code>PRACTICE_DB</code> with schemas <code>RAW</code>, <code>STAGING</code> (transient) and <code>MART</code> (managed access). Then list the schemas with their options.</p>",
      answer: `USE ROLE SYSADMIN;
CREATE DATABASE IF NOT EXISTS PRACTICE_DB;
CREATE SCHEMA IF NOT EXISTS PRACTICE_DB.RAW;
CREATE TRANSIENT SCHEMA IF NOT EXISTS PRACTICE_DB.STAGING;
CREATE SCHEMA IF NOT EXISTS PRACTICE_DB.MART WITH MANAGED ACCESS;

SHOW SCHEMAS IN DATABASE PRACTICE_DB;`,
      why: "<p>The SHOW output has an <code>options</code> column that reads TRANSIENT or MANAGED ACCESS. A transient schema makes every table created inside it transient, so you can't accidentally pay for Fail-safe on rebuildable staging data. Managed access on MART centralizes grants on the layer consumers read.</p>"
    },
    {
      level: "Easy",
      title: "A view for revenue by order",
      prompt: "<p>Create a view <code>PRACTICE_DB.MART.V_ORDER_REVENUE</code> that returns order key, order date, customer key, net revenue (from line items) and line count. Query it for order 1.</p>",
      answer: `CREATE OR REPLACE VIEW PRACTICE_DB.MART.V_ORDER_REVENUE AS
SELECT o.O_ORDERKEY,
       o.O_ORDERDATE,
       o.O_CUSTKEY,
       SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS net_revenue,
       COUNT(*)                                    AS line_count
FROM COURSE_DB.TPCH.ORDERS o
JOIN COURSE_DB.TPCH.LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
GROUP BY o.O_ORDERKEY, o.O_ORDERDATE, o.O_CUSTKEY;

SELECT * FROM PRACTICE_DB.MART.V_ORDER_REVENUE WHERE O_ORDERKEY = 1;`,
      why: "<p>The filter on the view gets pushed down into the base tables, so Snowflake doesn't compute revenue for all 1.5 million orders just to return one. That predicate pushdown is exactly the optimization a secure view gives up. Check the profile: you'll see the filter applied at the table scans.</p>"
    },
    {
      level: "Medium",
      title: "Prove constraints aren't enforced",
      hint: "Create a table with a PRIMARY KEY, insert a duplicate, then write the query that finds duplicates.",
      prompt: "<p>Create a table <code>PRACTICE_DB.STAGING.NATION_PK</code> with <code>N_NATIONKEY</code> as primary key, load NATION into it twice, and write a check query that returns any duplicated keys.</p>",
      answer: `CREATE OR REPLACE TABLE PRACTICE_DB.STAGING.NATION_PK (
  N_NATIONKEY NUMBER NOT NULL PRIMARY KEY,
  N_NAME      VARCHAR(25),
  N_REGIONKEY NUMBER
);

INSERT INTO PRACTICE_DB.STAGING.NATION_PK
SELECT N_NATIONKEY, N_NAME, N_REGIONKEY FROM COURSE_DB.TPCH.NATION;
INSERT INTO PRACTICE_DB.STAGING.NATION_PK
SELECT N_NATIONKEY, N_NAME, N_REGIONKEY FROM COURSE_DB.TPCH.NATION;   -- succeeds!

-- Data quality check: returns every duplicated key
SELECT N_NATIONKEY, COUNT(*) AS copies
FROM PRACTICE_DB.STAGING.NATION_PK
GROUP BY N_NATIONKEY
HAVING COUNT(*) > 1;`,
      why: "<p>Both inserts succeed and you end up with 50 rows. The primary key is informational. In real pipelines this check becomes a test (dbt's <code>unique</code> test is exactly this query) or a Data Metric Function that runs on a schedule. Try inserting a NULL key: that one fails, because NOT NULL is enforced.</p>"
    },
    {
      level: "Medium",
      title: "Write and use a table function",
      hint: "RETURNS TABLE(...) AS a SQL query with a parameter; call it with TABLE().",
      prompt: "<p>Create a SQL table function <code>TOP_PARTS(brand STRING, n NUMBER)</code> that returns the top n parts for a brand by retail price. Call it for <code>'Brand#13'</code> with n = 5. Then use it in a LATERAL join to get the top 2 parts for every brand that starts with <code>'Brand#1'</code>.</p>",
      answer: `CREATE OR REPLACE FUNCTION PRACTICE_DB.STAGING.TOP_PARTS(brand STRING, n NUMBER)
RETURNS TABLE (part_key NUMBER, part_name STRING, retail_price NUMBER(12,2))
AS $$
  SELECT P_PARTKEY, P_NAME, P_RETAILPRICE
  FROM COURSE_DB.TPCH.PART
  WHERE P_BRAND = brand
  QUALIFY ROW_NUMBER() OVER (ORDER BY P_RETAILPRICE DESC, P_PARTKEY) <= n
$$;

SELECT * FROM TABLE(PRACTICE_DB.STAGING.TOP_PARTS('Brand#13', 5));

SELECT b.P_BRAND, t.*
FROM (SELECT DISTINCT P_BRAND FROM COURSE_DB.TPCH.PART WHERE P_BRAND LIKE 'Brand#1%') b,
     TABLE(PRACTICE_DB.STAGING.TOP_PARTS(b.P_BRAND, 2)) t
ORDER BY b.P_BRAND, t.retail_price DESC;`,
      why: "<p>The function body is just a parameterized query. QUALIFY with ROW_NUMBER handles \"top n\", and the extra P_PARTKEY in ORDER BY makes ties deterministic. In the second query, listing the function after a comma creates an implicit lateral join: the function runs once per brand and can see that row's <code>P_BRAND</code>. That's the same mechanism FLATTEN uses in the semi-structured module.</p>"
    },
    {
      level: "Hard",
      title: "A stored procedure that snapshots tables",
      hint: "Build a query over INFORMATION_SCHEMA.TABLES, loop over it with a cursor and use EXECUTE IMMEDIATE to run CREATE TABLE ... CLONE.",
      prompt: "<p>Write a Snowflake Scripting procedure <code>SNAPSHOT_SCHEMA(src_db, src_schema, suffix)</code> that clones every table in a schema to a new table named <code>&lt;table&gt;_&lt;suffix&gt;</code> in the same schema, and returns how many tables it cloned. Make sure it doesn't clone tables that are themselves snapshots.</p>",
      answer: `CREATE OR REPLACE PROCEDURE PRACTICE_DB.STAGING.SNAPSHOT_SCHEMA(
    src_db STRING, src_schema STRING, suffix STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
  cloned INTEGER DEFAULT 0;
  stmt   STRING;
  qry    STRING;
  rs     RESULTSET;
BEGIN
  qry := 'SELECT TABLE_NAME FROM ' || :src_db || '.INFORMATION_SCHEMA.TABLES ' ||
         'WHERE TABLE_SCHEMA = ''' || :src_schema || ''' ' ||
         'AND TABLE_TYPE = ''BASE TABLE'' ' ||
         'AND NOT CONTAINS(TABLE_NAME, ''_SNAP_'')';
  rs := (EXECUTE IMMEDIATE :qry);
  LET c1 CURSOR FOR rs;
  FOR rec IN c1 DO
    stmt := 'CREATE OR REPLACE TABLE ' || :src_db || '.' || :src_schema || '.' ||
            rec.TABLE_NAME || '_SNAP_' || :suffix ||
            ' CLONE ' || :src_db || '.' || :src_schema || '.' || rec.TABLE_NAME;
    EXECUTE IMMEDIATE :stmt;
    cloned := cloned + 1;
  END FOR;
  RETURN 'Cloned ' || cloned || ' tables';
END;
$$;

CALL PRACTICE_DB.STAGING.SNAPSHOT_SCHEMA('COURSE_DB', 'TPCH', '20261111');`,
      why: "<p>Three ideas in one procedure. First, the database name is a parameter, and you can't bind a database name into a static query, so we build the INFORMATION_SCHEMA query as a string, run it with <code>EXECUTE IMMEDIATE</code> into a RESULTSET, and open a cursor over that. Doubled single quotes put a literal quote inside a string. Second, DDL like CLONE can't take bind variables for object names either, so each CLONE statement is also built as a string and run with <code>EXECUTE IMMEDIATE</code>. In real code you'd validate or quote the inputs (for example with a check against INFORMATION_SCHEMA) so nobody can inject SQL through <code>suffix</code>. Third, naming snapshots with a fixed marker (<code>_SNAP_</code>) and excluding that pattern keeps the procedure from snapshotting its own snapshots if you run it twice. Clones are zero-copy, so this is a cheap pre-deployment safety net.</p>"
    },
    {
      level: "Hard",
      title: "Pick the right object",
      prompt: "<p>For each requirement, say which object you'd build and why: (a) a partner needs to see order totals for their own customers only, through a share; (b) a dashboard runs <code>SUM(L_QUANTITY) GROUP BY L_SHIPDATE</code> on LINEITEM thousands of times a day and LINEITEM is appended to once a day; (c) a three-table join that analysts query constantly, refreshed within 15 minutes of source changes; (d) a one-off scratch result for your own investigation.</p>",
      answer: `-- (a) Secure view (required for sharing views), filtered per consumer account
CREATE SECURE VIEW SHARE_DB.PUBLIC.PARTNER_ORDERS AS
SELECT o.O_ORDERKEY, o.O_ORDERDATE, o.O_TOTALPRICE
FROM COURSE_DB.TPCH.ORDERS o
JOIN SHARE_DB.PUBLIC.PARTNER_ACCESS a          -- mapping table: customer -> account
  ON a.customer_key = o.O_CUSTKEY
WHERE a.consumer_account = CURRENT_ACCOUNT();

-- (b) Materialized view: single table, aggregate, rarely changing base
CREATE MATERIALIZED VIEW MART.SHIP_QTY_BY_DAY AS
SELECT L_SHIPDATE, SUM(L_QUANTITY) AS qty
FROM COURSE_DB.TPCH.LINEITEM GROUP BY L_SHIPDATE;

-- (c) Dynamic table with a target lag
CREATE DYNAMIC TABLE MART.ORDER_CUSTOMER_NATION
  TARGET_LAG = '15 minutes' WAREHOUSE = COURSE_WH AS
SELECT o.O_ORDERKEY, o.O_TOTALPRICE, c.C_NAME, n.N_NAME
FROM COURSE_DB.TPCH.ORDERS o
JOIN COURSE_DB.TPCH.CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
JOIN COURSE_DB.TPCH.NATION n   ON n.N_NATIONKEY = c.C_NATIONKEY;

-- (d) Temporary table: gone when your session ends, no Fail-safe cost
CREATE TEMPORARY TABLE my_scratch AS
SELECT * FROM COURSE_DB.TPCH.ORDERS WHERE O_ORDERSTATUS = 'P';`,
      why: "<p>(a) Shares can only include secure views, and filtering on <code>CURRENT_ACCOUNT()</code> against an entitlement table is the standard pattern for one share serving many consumers. (b) This is the textbook materialized view case: one table, an aggregate, heavy reads and rare writes, so maintenance cost stays low and queries hit precomputed results. The optimizer can even rewrite queries against LINEITEM to use the MV automatically. (c) MVs can't join, so a dynamic table with a 15-minute target lag gives you a declarative, incrementally refreshed join. (d) Temporary tables live only in your session, are invisible to others and have no Fail-safe. Good for throwaway work.</p>"
    }
  ]
});
