window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "loading",
  num: "05",
  track: "Building in Snowflake",
  title: "Loading and unloading data",
  summary: "Stages, file formats, COPY INTO in both directions, error handling, schema inference and Snowpipe. You unload TPC-H to files and load it back, so you can practise without any outside data.",
  minutes: 60,
  level: "Intermediate",
  lessons: [
    {
      title: "Stages: where files live",
      body: `
<p>Snowflake loads from and unloads to <b>stages</b>, which are locations for files. There are four kinds:</p>
<table>
<tr><th>Stage</th><th>Reference</th><th>Notes</th></tr>
<tr><td>User stage</td><td><code>@~</code></td><td>One per user, private to them. Fine for quick personal work.</td></tr>
<tr><td>Table stage</td><td><code>@%ORDERS</code></td><td>One per table. Can only load into that table. No file format options.</td></tr>
<tr><td>Named internal stage</td><td><code>@my_stage</code></td><td>A schema object stored inside Snowflake. Can be granted to roles. The usual choice for internal files.</td></tr>
<tr><td>External stage</td><td><code>@my_s3_stage</code></td><td>Points at S3, Azure Blob/ADLS or GCS. Uses a storage integration for credentials.</td></tr>
</table>
<sql>
USE ROLE SYSADMIN;
USE WAREHOUSE COURSE_WH;
CREATE SCHEMA IF NOT EXISTS COURSE_DB.LANDING;
USE SCHEMA COURSE_DB.LANDING;

CREATE OR REPLACE STAGE TPCH_FILES
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'Internal stage for TPC-H practice files';

LIST @TPCH_FILES;
</sql>
<p>For external stages, never put cloud keys in the stage definition. Use a <b>storage integration</b>, which holds a cloud IAM role (AWS) or service principal (Azure) that Snowflake assumes. An ACCOUNTADMIN creates it once and grants USAGE to the roles that need it.</p>
<sql>
-- AWS example (needs ACCOUNTADMIN and an IAM role set up on the AWS side)
CREATE STORAGE INTEGRATION S3_INT
  TYPE = EXTERNAL_STAGE
  STORAGE_PROVIDER = 'S3'
  ENABLED = TRUE
  STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/snowflake-loader'
  STORAGE_ALLOWED_LOCATIONS = ('s3://my-company-landing/tpch/');

DESC INTEGRATION S3_INT;   -- gives you the external ID and user ARN to trust in AWS

CREATE STAGE TPCH_S3 URL = 's3://my-company-landing/tpch/' STORAGE_INTEGRATION = S3_INT;
</sql>
<p>To move files between your laptop and an internal stage, use <code>PUT</code> and <code>GET</code> from SnowSQL or the Snowflake CLI, or upload through Snowsight's stage browser. Worksheets can't run PUT.</p>
`
    },
    {
      title: "File formats and unloading",
      body: `
<p>A <b>file format</b> object describes how to read or write files: type, delimiter, header, compression, null handling and so on. Define it once and reuse it everywhere.</p>
<sql>
CREATE OR REPLACE FILE FORMAT CSV_FMT
  TYPE = CSV
  FIELD_DELIMITER = '|'
  SKIP_HEADER = 1
  FIELD_OPTIONALLY_ENCLOSED_BY = '"'
  NULL_IF = ('', 'NULL')
  EMPTY_FIELD_AS_NULL = TRUE
  COMPRESSION = GZIP;

CREATE OR REPLACE FILE FORMAT PARQUET_FMT TYPE = PARQUET;
</sql>
<p><b>Unloading</b> is <code>COPY INTO @stage FROM (query)</code>. It's how you export data for other systems. Let's write ORDERS out as both CSV and Parquet so we have files to load later:</p>
<sql>
COPY INTO @TPCH_FILES/orders/csv/orders_
FROM (SELECT * FROM COURSE_DB.TPCH.ORDERS)
FILE_FORMAT = (FORMAT_NAME = 'CSV_FMT')
HEADER = TRUE
MAX_FILE_SIZE = 50000000          -- about 50 MB per file
OVERWRITE = TRUE;

COPY INTO @TPCH_FILES/orders/parquet/orders_
FROM (SELECT * FROM COURSE_DB.TPCH.ORDERS)
FILE_FORMAT = (FORMAT_NAME = 'PARQUET_FMT')
HEADER = TRUE
OVERWRITE = TRUE;

LIST @TPCH_FILES/orders/;
</sql>
<p>Snowflake splits the output into many files in parallel, which is what you want. Each warehouse thread writes its own file. Add <code>PARTITION BY</code> to write folders by a key, for example <code>PARTITION BY ('year=' || YEAR(O_ORDERDATE))</code>, which is handy for data lakes.</p>
<p>You can also query staged files directly before loading. Columns come through as <code>$1, $2, ...</code>, and metadata columns tell you where each row came from:</p>
<sql>
SELECT METADATA$FILENAME, METADATA$FILE_ROW_NUMBER, $1, $2, $5
FROM @TPCH_FILES/orders/csv/ (FILE_FORMAT => 'CSV_FMT')
LIMIT 10;
</sql>
`
    },
    {
      title: "COPY INTO a table",
      body: `
<p><code>COPY INTO table</code> is the bulk loader. It runs on your warehouse and loads files in parallel.</p>
<sql>
CREATE OR REPLACE TABLE ORDERS_LANDED LIKE COURSE_DB.TPCH.ORDERS;

COPY INTO ORDERS_LANDED
FROM @TPCH_FILES/orders/csv/
FILE_FORMAT = (FORMAT_NAME = 'CSV_FMT')
ON_ERROR = 'ABORT_STATEMENT';

SELECT COUNT(*) FROM ORDERS_LANDED;   -- 1,500,000
</sql>
<p>Key options you'll be asked about:</p>
<table>
<tr><th>Option</th><th>What it does</th></tr>
<tr><td><code>ON_ERROR</code></td><td>ABORT_STATEMENT (default for COPY), CONTINUE, SKIP_FILE, SKIP_FILE_n or SKIP_FILE_n%</td></tr>
<tr><td><code>VALIDATION_MODE</code></td><td>RETURN_ERRORS or RETURN_n_ROWS: check files without loading anything</td></tr>
<tr><td><code>FORCE</code></td><td>Reload files even if they were loaded before (creates duplicates)</td></tr>
<tr><td><code>PURGE</code></td><td>Delete files from the stage after a successful load</td></tr>
<tr><td><code>MATCH_BY_COLUMN_NAME</code></td><td>Map Parquet/Avro/ORC/CSV-with-header columns to table columns by name</td></tr>
<tr><td><code>PATTERN</code></td><td>Regex to pick which files to load</td></tr>
</table>
<p><b>Load metadata</b> is what stops double loading. Snowflake remembers which files (by name and checksum) were loaded into each table for 64 days. Running the same COPY twice loads 0 rows the second time. That makes COPY safe to retry, which is a property you want in every pipeline.</p>
<p>You can transform during the load with a SELECT over the stage. Useful for reordering columns, casting, or adding the source file name:</p>
<sql>
CREATE OR REPLACE TABLE ORDERS_AUDITED (
  order_key NUMBER, cust_key NUMBER, total NUMBER(12,2), order_date DATE,
  source_file STRING, loaded_at TIMESTAMP_LTZ);

COPY INTO ORDERS_AUDITED
FROM (
  SELECT $1, $2, $4, $5, METADATA$FILENAME, CURRENT_TIMESTAMP()
  FROM @TPCH_FILES/orders/csv/
)
FILE_FORMAT = (FORMAT_NAME = 'CSV_FMT');
</sql>
<p>For Parquet, Snowflake can work out the schema for you:</p>
<sql>
CREATE OR REPLACE TABLE ORDERS_FROM_PARQUET
  USING TEMPLATE (
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT(*))
    FROM TABLE(INFER_SCHEMA(LOCATION => '@TPCH_FILES/orders/parquet/',
                            FILE_FORMAT => 'PARQUET_FMT')));

COPY INTO ORDERS_FROM_PARQUET
FROM @TPCH_FILES/orders/parquet/
FILE_FORMAT = (FORMAT_NAME = 'PARQUET_FMT')
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE;
</sql>
<div class="tip"><b>File sizing</b>Aim for compressed files of roughly 100 to 250 MB. Thousands of tiny files waste time on per-file overhead. One giant file can't be split across threads (unless it's an uncompressed or splittable format), so it loads slowly.</div>
`
    },
    {
      title: "Continuous loading with Snowpipe",
      body: `
<p>COPY on a schedule works, but for files that arrive all day you want <b>Snowpipe</b>. A pipe wraps a COPY statement. When new files land, Snowpipe loads them using serverless compute, usually within a minute, and you pay per file and compute used instead of keeping a warehouse running.</p>
<sql>
CREATE OR REPLACE PIPE ORDERS_PIPE
  AUTO_INGEST = TRUE            -- driven by cloud storage event notifications
AS
COPY INTO ORDERS_LANDED
FROM @TPCH_S3/orders/
FILE_FORMAT = (FORMAT_NAME = 'CSV_FMT');

SHOW PIPES;                                         -- notification_channel = SQS ARN to wire up on S3
SELECT SYSTEM$PIPE_STATUS('ORDERS_PIPE');
ALTER PIPE ORDERS_PIPE REFRESH;                     -- queue files already sitting in the stage (last 7 days)
</sql>
<p>Auto-ingest needs an external stage plus event notifications (S3 events to SQS, Azure Event Grid, or GCS Pub/Sub). For internal stages, you call the Snowpipe REST API to tell it which files to load.</p>
<p>Snowpipe keeps its own load metadata for 14 days, separate from COPY's 64 days. If you mix manual COPY and Snowpipe on the same table, files can get loaded twice. Pick one.</p>
<p><b>Snowpipe Streaming</b> is different again: rows are written straight into tables over an SDK or the Kafka connector, with no files at all. Latency drops to seconds. Use it for event streams.</p>
<sql>
-- Monitor what was loaded, from either COPY or Snowpipe
SELECT FILE_NAME, LAST_LOAD_TIME, ROW_COUNT, ROW_PARSED, STATUS, FIRST_ERROR_MESSAGE
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.COPY_HISTORY(
       TABLE_NAME => 'COURSE_DB.LANDING.ORDERS_LANDED',
       START_TIME => DATEADD(hour, -24, CURRENT_TIMESTAMP())))
ORDER BY LAST_LOAD_TIME DESC;
</sql>
`
    }
  ],
  quiz: [
    {
      q: "You run the same <code>COPY INTO ORDERS_LANDED FROM @stage</code> twice with no changes to the files. What happens the second time?",
      options: [
        "All rows are loaded again, doubling the table",
        "Zero rows are loaded because load metadata marks the files as already loaded",
        "The statement fails with a duplicate key error",
        "Snowflake truncates the table and reloads"
      ],
      answer: 1,
      why: "<p>COPY tracks loaded files per table for 64 days. Already-loaded files are skipped, which makes retries safe. Use <code>FORCE = TRUE</code> only if you really want to reload (and accept duplicates).</p>"
    },
    {
      q: "What's the safe way to give Snowflake access to an S3 bucket?",
      options: [
        "Put AWS access keys in the CREATE STAGE statement",
        "Make the bucket public",
        "Create a storage integration that uses an IAM role, and reference it from the stage",
        "Copy the files into a user stage first"
      ],
      answer: 2,
      why: "<p>Storage integrations keep credentials out of SQL and out of the hands of the people creating stages. Snowflake assumes an IAM role you trust, and <code>STORAGE_ALLOWED_LOCATIONS</code> limits which paths the integration can reach.</p>"
    },
    {
      q: "Which option checks files for errors without loading any rows?",
      options: ["ON_ERROR = CONTINUE", "VALIDATION_MODE = RETURN_ERRORS", "PURGE = TRUE", "FORCE = FALSE"],
      answer: 1,
      why: "<p>VALIDATION_MODE runs the parse and returns errors (or the first n rows) without inserting anything. It's a good pre-flight check for a new file feed. Note that it doesn't support COPY statements that transform data with a SELECT.</p>"
    },
    {
      q: "Which statement about Snowpipe is correct?",
      options: [
        "It needs a running user-managed warehouse",
        "It uses serverless compute and is billed separately from warehouses",
        "It only works with internal stages",
        "It loads each file as soon as COPY metadata expires"
      ],
      answer: 1,
      why: "<p>Snowpipe runs on Snowflake-managed compute. Auto-ingest works off cloud storage events on external stages. For internal stages you trigger it through the REST API.</p>"
    },
    {
      q: "Roughly what compressed file size gives the best load parallelism?",
      options: ["1 to 5 MB", "100 to 250 MB", "5 to 10 GB", "File size doesn't matter"],
      answer: 1,
      why: "<p>Each file is a unit of work. Tiny files add per-file overhead; huge files limit parallelism. Snowflake's guidance is roughly 100 to 250 MB compressed.</p>"
    },
    {
      q: "In a query over staged CSV files, what does <code>METADATA$FILENAME</code> return?",
      options: [
        "The name of the target table",
        "The path of the file the row came from",
        "The file format name",
        "The stage owner"
      ],
      answer: 1,
      why: "<p>It's the path of the source file relative to the stage. Storing it in a column (along with <code>METADATA$FILE_ROW_NUMBER</code>) makes it easy to trace a bad row back to the file that produced it.</p>"
    },
    {
      q: "Which feature loads rows into Snowflake with no files involved, at seconds of latency?",
      options: ["Snowpipe with AUTO_INGEST", "Snowpipe Streaming", "External tables", "COPY with PURGE"],
      answer: 1,
      why: "<p>Snowpipe Streaming writes rows directly through a client SDK or the Kafka connector. Regular Snowpipe still works on files.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Unload customers to a stage",
      prompt: "<p>Create a named internal stage <code>COURSE_DB.LANDING.EXPORTS</code> and unload all AUTOMOBILE-segment customers to it as gzip CSV with a header. Then list the files.</p>",
      answer: `CREATE OR REPLACE STAGE COURSE_DB.LANDING.EXPORTS;

COPY INTO @COURSE_DB.LANDING.EXPORTS/customers/auto_
FROM (SELECT * FROM COURSE_DB.TPCH.CUSTOMER WHERE C_MKTSEGMENT = 'AUTOMOBILE')
FILE_FORMAT = (TYPE = CSV COMPRESSION = GZIP FIELD_OPTIONALLY_ENCLOSED_BY = '"')
HEADER = TRUE
OVERWRITE = TRUE;

LIST @COURSE_DB.LANDING.EXPORTS/customers/;`,
      why: "<p>The path after the stage name acts as a folder plus a file name prefix. Snowflake adds a suffix per file (like <code>_0_0_0.csv.gz</code>). The result of COPY tells you rows unloaded and file count. Enclosing fields in double quotes protects you from commas inside text like addresses and comments.</p>"
    },
    {
      level: "Easy",
      title: "Peek before you load",
      prompt: "<p>Without creating a table, return the first 5 rows and the source file name from the files you just unloaded. Treat the first line as a header.</p>",
      answer: `SELECT METADATA$FILENAME AS file, $1 AS custkey, $2 AS name, $7 AS segment
FROM @COURSE_DB.LANDING.EXPORTS/customers/
     (FILE_FORMAT => 'COURSE_DB.LANDING.CSV_FMT')
LIMIT 5;

-- CSV_FMT uses '|' as the delimiter, so for these comma files use an inline-defined format:
CREATE OR REPLACE FILE FORMAT COURSE_DB.LANDING.CSV_COMMA
  TYPE = CSV SKIP_HEADER = 1 FIELD_OPTIONALLY_ENCLOSED_BY = '"';

SELECT METADATA$FILENAME AS file, $1 AS custkey, $2 AS name, $7 AS segment
FROM @COURSE_DB.LANDING.EXPORTS/customers/ (FILE_FORMAT => 'COURSE_DB.LANDING.CSV_COMMA')
LIMIT 5;`,
      why: "<p>Querying a stage is a great way to inspect a new feed. The file format must match how the file was written: our unload used commas, so the pipe-delimited CSV_FMT would return each whole line in <code>$1</code>. That's a realistic mistake, which is why it's shown here. Positional columns follow the file's column order: C_MKTSEGMENT is the 7th column of CUSTOMER.</p>"
    },
    {
      level: "Medium",
      title: "Load with bad rows",
      hint: "Build a tiny file by unloading a query that produces a non-numeric value in a numeric column, then load with VALIDATION_MODE and ON_ERROR.",
      prompt: "<p>Create a CSV in the stage where one row has <code>'oops'</code> in the order key column. Show the errors with <code>VALIDATION_MODE</code>, then load the good rows while skipping the bad one, and finally query the rejected rows with <code>VALIDATE</code>.</p>",
      answer: `-- Build a test file: 4 good rows and 1 bad one
COPY INTO @COURSE_DB.LANDING.EXPORTS/bad/test_
FROM (
  SELECT TO_VARCHAR(O_ORDERKEY) AS k, O_CUSTKEY, O_TOTALPRICE FROM COURSE_DB.TPCH.ORDERS WHERE O_ORDERKEY <= 4
  UNION ALL
  SELECT 'oops', 1, 10.00
)
FILE_FORMAT = (TYPE = CSV) HEADER = FALSE SINGLE = TRUE OVERWRITE = TRUE;

CREATE OR REPLACE TABLE COURSE_DB.LANDING.SMALL_ORDERS (
  order_key NUMBER, cust_key NUMBER, total NUMBER(12,2));

-- 1. Dry run
COPY INTO COURSE_DB.LANDING.SMALL_ORDERS
FROM @COURSE_DB.LANDING.EXPORTS/bad/
FILE_FORMAT = (TYPE = CSV)
VALIDATION_MODE = RETURN_ERRORS;

-- 2. Real load, keep going past bad rows
COPY INTO COURSE_DB.LANDING.SMALL_ORDERS
FROM @COURSE_DB.LANDING.EXPORTS/bad/
FILE_FORMAT = (TYPE = CSV)
ON_ERROR = CONTINUE;

-- 3. See what was rejected by that load
SELECT * FROM TABLE(VALIDATE(COURSE_DB.LANDING.SMALL_ORDERS, JOB_ID => '_last'));`,
      why: "<p>The dry run returns the error \"Numeric value 'oops' is not recognized\" with file, line and column, and loads nothing. <code>ON_ERROR = CONTINUE</code> loads the four good rows and reports one error. <code>VALIDATE</code> with <code>'_last'</code> returns the rejected rows from the most recent COPY in your session, so you can route them to a quarantine table. In production, choose ON_ERROR deliberately: ABORT_STATEMENT is safest for financial data, CONTINUE plus a reject check suits high-volume event data.</p>"
    },
    {
      level: "Medium",
      title: "Parquet with schema inference",
      prompt: "<p>Unload PART to Parquet, create a table from the inferred schema, and load it by column name. Confirm the row count is 200,000.</p>",
      answer: `COPY INTO @COURSE_DB.LANDING.EXPORTS/part/part_
FROM COURSE_DB.TPCH.PART
FILE_FORMAT = (TYPE = PARQUET)
HEADER = TRUE OVERWRITE = TRUE;

CREATE OR REPLACE TABLE COURSE_DB.LANDING.PART_PQ
USING TEMPLATE (
  SELECT ARRAY_AGG(OBJECT_CONSTRUCT(*)) WITHIN GROUP (ORDER BY ORDER_ID)
  FROM TABLE(INFER_SCHEMA(
    LOCATION    => '@COURSE_DB.LANDING.EXPORTS/part/',
    FILE_FORMAT => 'COURSE_DB.LANDING.PARQUET_FMT')));

COPY INTO COURSE_DB.LANDING.PART_PQ
FROM @COURSE_DB.LANDING.EXPORTS/part/
FILE_FORMAT = (FORMAT_NAME = 'COURSE_DB.LANDING.PARQUET_FMT')
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE;

SELECT COUNT(*) FROM COURSE_DB.LANDING.PART_PQ;`,
      why: "<p><code>HEADER = TRUE</code> on a Parquet unload keeps the real column names in the file; without it you get generic names like <code>_COL_0</code>. INFER_SCHEMA reads the Parquet metadata and returns one row per column. <code>ORDER BY ORDER_ID</code> keeps the columns in file order. USING TEMPLATE turns that into a CREATE TABLE, and MATCH_BY_COLUMN_NAME lines up columns by name so file column order doesn't matter, which protects you when an upstream system reorders columns.</p>"
    },
    {
      level: "Hard",
      title: "An idempotent daily load",
      hint: "Think about what happens when the job reruns, when a file is corrected and re-sent with the same name, and when you need to know which file a row came from.",
      prompt: "<p>Design a daily load of order files that land in <code>@TPCH_FILES/daily/YYYY-MM-DD/</code>. Requirements: safe to rerun, a corrected file re-sent with the same name must replace the earlier rows from that file, and every row must be traceable to its file. Write the SQL.</p>",
      answer: `-- Curated target keeps lineage columns
CREATE TABLE IF NOT EXISTS COURSE_DB.LANDING.ORDERS_DAILY (
  O_ORDERKEY NUMBER, O_CUSTKEY NUMBER, O_ORDERSTATUS STRING, O_TOTALPRICE NUMBER(12,2),
  O_ORDERDATE DATE, source_file STRING, loaded_at TIMESTAMP_LTZ);

-- Transient batch table: only holds what this run's COPY picked up
CREATE TRANSIENT TABLE IF NOT EXISTS COURSE_DB.LANDING.ORDERS_DAILY_BATCH
  LIKE COURSE_DB.LANDING.ORDERS_DAILY;

TRUNCATE TABLE COURSE_DB.LANDING.ORDERS_DAILY_BATCH;

-- 1. COPY skips files it already loaded (same name AND same checksum).
--    A corrected file re-sent under the same name has a new checksum, so it loads again.
COPY INTO COURSE_DB.LANDING.ORDERS_DAILY_BATCH
FROM (
  SELECT $1, $2, $3, $4, $5, METADATA$FILENAME, CURRENT_TIMESTAMP()
  FROM @COURSE_DB.LANDING.TPCH_FILES/daily/1998-08-02/
)
FILE_FORMAT = (FORMAT_NAME = 'COURSE_DB.LANDING.CSV_FMT')
ON_ERROR = ABORT_STATEMENT;

-- 2. Swap in the new rows for every file that was (re)loaded, atomically
BEGIN TRANSACTION;

DELETE FROM COURSE_DB.LANDING.ORDERS_DAILY
WHERE source_file IN (SELECT DISTINCT source_file FROM COURSE_DB.LANDING.ORDERS_DAILY_BATCH);

INSERT INTO COURSE_DB.LANDING.ORDERS_DAILY
SELECT * FROM COURSE_DB.LANDING.ORDERS_DAILY_BATCH;

COMMIT;`,
      why: "<p>Rerun safety comes from COPY's load metadata: files already loaded with the same checksum are skipped, so a rerun puts nothing into the batch table and the swap does nothing. A corrected file sent under the same name has a different checksum, so COPY treats it as new and loads it into the batch. The swap step then deletes every earlier row from that file name and inserts the new ones, so the old version doesn't linger. Storing <code>METADATA$FILENAME</code> on every row gives you traceability and is also the key the swap uses. The DELETE and INSERT sit in one transaction so readers never see the half-done state. In practice you'd often MERGE by business key instead of by file, which is the next module's topic. The folder date is a literal here; a stored procedure or task would build that path for each run.</p>"
    },
    {
      level: "Hard",
      title: "Diagnose a slow load",
      prompt: "<p>A team loads one 40 GB gzip CSV file every night on a LARGE warehouse and it takes 50 minutes. Moving to 2XLARGE didn't help. Explain why, and write the SQL you'd use to fix it if you control the upstream export, assuming the upstream is another Snowflake account.</p>",
      answer: `-- Upstream: unload in many right-sized files instead of one giant file
COPY INTO @EXPORT_STAGE/orders/dt=2026-11-11/part_
FROM (SELECT * FROM SOURCE_DB.SALES.ORDERS WHERE O_ORDERDATE = '2026-11-11')
FILE_FORMAT = (TYPE = CSV COMPRESSION = GZIP FIELD_OPTIONALLY_ENCLOSED_BY = '"')
HEADER = TRUE
MAX_FILE_SIZE = 200000000;   -- ~200 MB per file, SINGLE = FALSE (default)

-- Or better: Parquet, which is columnar and typed
COPY INTO @EXPORT_STAGE/orders/dt=2026-11-11/
FROM (SELECT * FROM SOURCE_DB.SALES.ORDERS WHERE O_ORDERDATE = '2026-11-11')
FILE_FORMAT = (TYPE = PARQUET) HEADER = TRUE;

-- Downstream load is unchanged, it now parallelises across files
COPY INTO LANDING.ORDERS FROM @EXPORT_STAGE/orders/dt=2026-11-11/
FILE_FORMAT = (TYPE = CSV SKIP_HEADER = 1 FIELD_OPTIONALLY_ENCLOSED_BY = '"');`,
      why: "<p>A single gzip file can't be split, so only one thread reads it no matter how many cores the warehouse has. Going from LARGE to 2XLARGE quadruples the cost and changes nothing. Splitting into about 200 files of 200 MB lets every thread work at once, and often a smaller warehouse finishes faster than the old LARGE did. If the producer is another Snowflake account, the best fix is to skip files entirely and use a data share (module 17). Zero copies, zero load jobs.</p>"
    }
  ]
});
