window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "tasks",
  num: "09",
  track: "Pipelines and CDC",
  title: "Tasks, task graphs and alerts",
  summary: "Schedule SQL with tasks, pair them with streams for incremental pipelines, chain them into task graphs, and monitor failures with task history and alerts.",
  minutes: 55,
  level: "Intermediate to advanced",
  lessons: [
    {
      title: "Task basics",
      body: `
<p>A <b>task</b> runs one SQL statement (or a call to a stored procedure, or a Snowflake Scripting block) on a schedule or after another task. Tasks are how you orchestrate inside Snowflake without an external scheduler.</p>
<sql>
USE ROLE ACCOUNTADMIN;
GRANT EXECUTE TASK ON ACCOUNT TO ROLE SYSADMIN;            -- needed to run tasks at all
GRANT EXECUTE MANAGED TASK ON ACCOUNT TO ROLE SYSADMIN;    -- needed for serverless tasks
USE ROLE SYSADMIN;
USE SCHEMA COURSE_DB.CDC;

CREATE OR REPLACE TABLE DAILY_REVENUE (snapshot_at TIMESTAMP_LTZ, order_year NUMBER, revenue NUMBER(18,2));

-- Warehouse task, CRON schedule: 06:00 UTC every day
CREATE OR REPLACE TASK SNAPSHOT_REVENUE
  WAREHOUSE = COURSE_WH
  SCHEDULE = 'USING CRON 0 6 * * * UTC'
AS
INSERT INTO DAILY_REVENUE
SELECT CURRENT_TIMESTAMP(), YEAR(O_ORDERDATE), SUM(O_TOTALPRICE)
FROM COURSE_DB.TPCH.ORDERS
GROUP BY 2;

-- Tasks are created SUSPENDED
SHOW TASKS LIKE 'SNAPSHOT_REVENUE';
ALTER TASK SNAPSHOT_REVENUE RESUME;

-- Run it once now, without waiting for the schedule
EXECUTE TASK SNAPSHOT_REVENUE;
</sql>
<p>Schedules can be an interval (<code>SCHEDULE = '5 MINUTE'</code>) or CRON with a time zone. Use CRON when the time of day matters and an interval when only the frequency does.</p>
<p><b>Warehouse vs serverless.</b> Leave out <code>WAREHOUSE</code> and the task is serverless: Snowflake picks and sizes the compute, and you pay serverless rates. Serverless suits short, frequent tasks, because you don't pay a 60-second warehouse minimum each run. Set a starting size with <code>USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE</code>. You can also cap it with <code>SERVERLESS_TASK_MAX_STATEMENT_SIZE</code>. Use a warehouse when tasks are long, heavy or can share an already-running warehouse.</p>
`
    },
    {
      title: "Streams plus tasks: incremental pipelines",
      body: `
<p>The classic incremental pattern is a stream on a source and a task that consumes it. The <code>WHEN</code> clause stops the task from starting compute when there's nothing to do. The check runs in cloud services, so a skipped run costs (almost) nothing.</p>
<sql>
CREATE OR REPLACE TASK ORDERS_SYNC_TASK
  WAREHOUSE = COURSE_WH
  SCHEDULE = '5 MINUTE'
  WHEN SYSTEM$STREAM_HAS_DATA('COURSE_DB.CDC.ORDERS_SYNC')
AS
MERGE INTO COURSE_DB.CDC.ORDERS_TGT t
USING (
  SELECT * FROM COURSE_DB.CDC.ORDERS_SYNC
  WHERE NOT (METADATA$ACTION = 'DELETE' AND METADATA$ISUPDATE)
) s
ON t.O_ORDERKEY = s.O_ORDERKEY
WHEN MATCHED AND s.METADATA$ACTION = 'DELETE' THEN DELETE
WHEN MATCHED THEN UPDATE SET t.O_ORDERSTATUS = s.O_ORDERSTATUS, t.O_TOTALPRICE = s.O_TOTALPRICE
WHEN NOT MATCHED AND s.METADATA$ACTION = 'INSERT' THEN INSERT
  (O_ORDERKEY, O_CUSTKEY, O_ORDERSTATUS, O_TOTALPRICE, O_ORDERDATE)
  VALUES (s.O_ORDERKEY, s.O_CUSTKEY, s.O_ORDERSTATUS, s.O_TOTALPRICE, s.O_ORDERDATE);

ALTER TASK ORDERS_SYNC_TASK RESUME;
</sql>
<p><b>Triggered tasks</b> go one step further: leave out <code>SCHEDULE</code> and keep the <code>WHEN SYSTEM$STREAM_HAS_DATA(...)</code> condition, and the task runs when the stream has new data rather than on a clock. Good for low-latency pipelines where data arrives unpredictably.</p>
<p>Tasks don't overlap by default. If a run is still going when the next one is due, the next one is skipped. <code>ALLOW_OVERLAPPING_EXECUTION = TRUE</code> changes that on a root task, but overlapping MERGEs into the same table is rarely what you want.</p>
`
    },
    {
      title: "Task graphs",
      body: `
<p>Chain tasks with <code>AFTER</code> to build a task graph (a DAG). Only the root task has a schedule. A child runs when all of its predecessors finish successfully.</p>
<sql>
-- Root: refresh staging
CREATE OR REPLACE TASK T_ROOT
  WAREHOUSE = COURSE_WH
  SCHEDULE = 'USING CRON 0 2 * * * UTC'
AS
CREATE OR REPLACE TABLE COURSE_DB.CDC.STG_ORDERS AS
SELECT * FROM COURSE_DB.TPCH.ORDERS WHERE O_ORDERDATE >= '1998-01-01';

-- Two children run in parallel after the root
CREATE OR REPLACE TASK T_REV_BY_DAY WAREHOUSE = COURSE_WH AFTER T_ROOT AS
CREATE OR REPLACE TABLE COURSE_DB.CDC.REV_BY_DAY AS
SELECT O_ORDERDATE, SUM(O_TOTALPRICE) AS revenue FROM COURSE_DB.CDC.STG_ORDERS GROUP BY 1;

CREATE OR REPLACE TASK T_REV_BY_PRIORITY WAREHOUSE = COURSE_WH AFTER T_ROOT AS
CREATE OR REPLACE TABLE COURSE_DB.CDC.REV_BY_PRIORITY AS
SELECT O_ORDERPRIORITY, SUM(O_TOTALPRICE) AS revenue FROM COURSE_DB.CDC.STG_ORDERS GROUP BY 1;

-- A join task waits for both
CREATE OR REPLACE TASK T_PUBLISH WAREHOUSE = COURSE_WH AFTER T_REV_BY_DAY, T_REV_BY_PRIORITY AS
INSERT INTO COURSE_DB.CDC.DAILY_REVENUE
SELECT CURRENT_TIMESTAMP(), 1998, SUM(revenue) FROM COURSE_DB.CDC.REV_BY_DAY;

-- Finalizer: always runs at the end, even if something failed. Good for cleanup and notifications.
CREATE OR REPLACE TASK T_FINALIZE WAREHOUSE = COURSE_WH FINALIZE = T_ROOT AS
DROP TABLE IF EXISTS COURSE_DB.CDC.STG_ORDERS;

-- Resume all children, then the root, in one call
SELECT SYSTEM$TASK_DEPENDENTS_ENABLE('COURSE_DB.CDC.T_ROOT');
</sql>
<p>Rules you'll trip over:</p>
<ul>
<li>To change a task in a graph, suspend the root first. Modifying a child while the root is running isn't allowed.</li>
<li>Every task in a graph must have the same owner and live in the same database.</li>
<li>Tasks can pass values with <code>SYSTEM$SET_RETURN_VALUE</code> and read a predecessor's with <code>SYSTEM$GET_PREDECESSOR_RETURN_VALUE</code>. Graph-wide settings can go in the root's <code>CONFIG</code> and be read with <code>SYSTEM$GET_TASK_GRAPH_CONFIG</code>.</li>
<li>Snowsight shows each graph visually under Monitoring → Task History, with each run's status per task.</li>
</ul>
`
    },
    {
      title: "Monitoring and alerts",
      body: `
<p>Task runs are recorded in <code>INFORMATION_SCHEMA.TASK_HISTORY()</code> (last 7 days, no lag) and <code>SNOWFLAKE.ACCOUNT_USAGE.TASK_HISTORY</code> (1 year, up to 45 minutes of lag).</p>
<sql>
SELECT NAME, STATE, SCHEDULED_TIME, COMPLETED_TIME,
       DATEDIFF(second, QUERY_START_TIME, COMPLETED_TIME) AS seconds,
       ERROR_CODE, ERROR_MESSAGE
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.TASK_HISTORY(
       SCHEDULED_TIME_RANGE_START => DATEADD(hour, -24, CURRENT_TIMESTAMP())))
ORDER BY SCHEDULED_TIME DESC;
</sql>
<p>Settings that make tasks safer to run unattended:</p>
<table>
<tr><th>Parameter</th><th>Effect</th></tr>
<tr><td><code>SUSPEND_TASK_AFTER_NUM_FAILURES</code></td><td>Suspends the task after n failures in a row (default 10), so a broken task doesn't burn credits forever</td></tr>
<tr><td><code>TASK_AUTO_RETRY_ATTEMPTS</code></td><td>On a root task, retries a failed graph run automatically</td></tr>
<tr><td><code>USER_TASK_TIMEOUT_MS</code></td><td>Maximum run time per task (default 60 minutes)</td></tr>
<tr><td><code>ERROR_INTEGRATION</code></td><td>Sends failure notifications to a notification integration (SNS, Event Grid, Pub/Sub)</td></tr>
</table>
<p><b>Alerts</b> are a related object: on a schedule they evaluate a condition (any query that returns rows) and, if it's true, run an action, such as sending an email.</p>
<sql>
USE ROLE ACCOUNTADMIN;
CREATE NOTIFICATION INTEGRATION IF NOT EXISTS EMAIL_INT
  TYPE = EMAIL ENABLED = TRUE ALLOWED_RECIPIENTS = ('data-oncall@example.com');
GRANT USAGE ON INTEGRATION EMAIL_INT TO ROLE SYSADMIN;
GRANT EXECUTE ALERT ON ACCOUNT TO ROLE SYSADMIN;
USE ROLE SYSADMIN;

CREATE OR REPLACE ALERT COURSE_DB.CDC.TASK_FAILURES
  WAREHOUSE = COURSE_WH
  SCHEDULE = '15 MINUTE'
IF (EXISTS (
  SELECT 1
  FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.TASK_HISTORY(
         SCHEDULED_TIME_RANGE_START => SNOWFLAKE.ALERT.LAST_SUCCESSFUL_SCHEDULED_TIME()))
  WHERE STATE = 'FAILED'))
THEN
  CALL SYSTEM$SEND_EMAIL('EMAIL_INT', 'data-oncall@example.com',
       'Snowflake task failure', 'At least one task failed since the last check.');

ALTER ALERT COURSE_DB.CDC.TASK_FAILURES RESUME;
</sql>
<p><code>LAST_SUCCESSFUL_SCHEDULED_TIME()</code> makes each check cover exactly the window since the last good check, so nothing is missed or reported twice.</p>
`
    }
  ],
  quiz: [
    {
      q: "You just created a task with a 5-minute schedule. Fifteen minutes later it still hasn't run. Most likely reason?",
      options: [
        "The warehouse is too small",
        "Tasks are created suspended and need ALTER TASK ... RESUME",
        "Schedules shorter than 1 hour aren't supported",
        "The task needs a stream"
      ],
      answer: 1,
      why: "<p>Every new task starts suspended. Resume it (and its dependents in a graph). Also check that the owning role has EXECUTE TASK on the account.</p>"
    },
    {
      q: "What does <code>WHEN SYSTEM$STREAM_HAS_DATA('s')</code> save you?",
      options: [
        "Storage costs on the stream",
        "Warehouse credits, because the task skips runs when the stream is empty without starting compute",
        "The need to resume the task",
        "Stream staleness"
      ],
      answer: 1,
      why: "<p>The WHEN condition is evaluated in cloud services. If it's false, the run is skipped and no warehouse starts. Without it, a 5-minute task would resume the warehouse 288 times a day, each with a 60-second minimum. (It doesn't prevent staleness, since the stream isn't consumed on skipped runs, but an empty stream doesn't need consuming.)</p>"
    },
    {
      q: "In a task graph, which task has a SCHEDULE?",
      options: ["Every task", "Only the root task", "Only the leaf tasks", "Only the finalizer"],
      answer: 1,
      why: "<p>The root task holds the schedule. Children are defined with AFTER and run when all their predecessors succeed. The finalizer runs once at the end of every graph run, success or failure.</p>"
    },
    {
      q: "When is a serverless task usually a better choice than a warehouse task?",
      options: [
        "Long, heavy transformations that need an XL warehouse",
        "Short, frequent tasks where the 60-second warehouse minimum would dominate cost",
        "Tasks that need a CRON schedule",
        "Tasks that read from shares"
      ],
      answer: 1,
      why: "<p>Serverless tasks bill for the compute actually used and Snowflake sizes it automatically. For a 5-second MERGE every few minutes, paying for 60 seconds of a warehouse each time is mostly waste, unless that warehouse is already running for other work.</p>"
    },
    {
      q: "You need to change the SQL of a child task in a running graph. What must you do first?",
      options: [
        "Drop the graph",
        "Suspend the root task",
        "Suspend every child task",
        "Nothing, edits apply immediately"
      ],
      answer: 1,
      why: "<p>Suspend the root, make the change, then resume (SYSTEM$TASK_DEPENDENTS_ENABLE on the root resumes everything). This prevents a run from starting while the graph is half-edited.</p>"
    },
    {
      q: "A task has failed 10 times in a row and stopped running. Which parameter caused that?",
      options: ["USER_TASK_TIMEOUT_MS", "SUSPEND_TASK_AFTER_NUM_FAILURES", "TASK_AUTO_RETRY_ATTEMPTS", "ALLOW_OVERLAPPING_EXECUTION"],
      answer: 1,
      why: "<p>SUSPEND_TASK_AFTER_NUM_FAILURES (default 10) suspends a task after that many consecutive failures. It protects your credits, but it also means a silent pipeline stop. Pair it with an alert.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Schedule a snapshot",
      prompt: "<p>Create a serverless task that runs every hour and inserts the current count of open orders (status 'O') from <code>COURSE_DB.TPCH.ORDERS</code> into a table <code>OPEN_ORDER_COUNTS</code>. Resume it and run it once.</p>",
      answer: `CREATE OR REPLACE TABLE COURSE_DB.CDC.OPEN_ORDER_COUNTS (taken_at TIMESTAMP_LTZ, open_orders NUMBER);

CREATE OR REPLACE TASK COURSE_DB.CDC.COUNT_OPEN_ORDERS
  SCHEDULE = '60 MINUTE'
  USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
AS
INSERT INTO COURSE_DB.CDC.OPEN_ORDER_COUNTS
SELECT CURRENT_TIMESTAMP(), COUNT(*) FROM COURSE_DB.TPCH.ORDERS WHERE O_ORDERSTATUS = 'O';

ALTER TASK COURSE_DB.CDC.COUNT_OPEN_ORDERS RESUME;
EXECUTE TASK COURSE_DB.CDC.COUNT_OPEN_ORDERS;

SELECT * FROM COURSE_DB.CDC.OPEN_ORDER_COUNTS;`,
      why: "<p>No WAREHOUSE parameter means serverless. EXECUTE TASK queues a run immediately; give it a few seconds, then check the table or TASK_HISTORY. Your role needs EXECUTE MANAGED TASK on the account for serverless tasks.</p>"
    },
    {
      level: "Easy",
      title: "Read task history",
      prompt: "<p>Show every run of tasks in COURSE_DB from the last 24 hours with state, duration in seconds and any error message, most recent first.</p>",
      answer: `SELECT NAME,
       STATE,
       SCHEDULED_TIME,
       DATEDIFF(second, QUERY_START_TIME, COMPLETED_TIME) AS seconds,
       ERROR_MESSAGE
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.TASK_HISTORY(
       SCHEDULED_TIME_RANGE_START => DATEADD(hour, -24, CURRENT_TIMESTAMP()),
       RESULT_LIMIT => 1000))
ORDER BY SCHEDULED_TIME DESC;`,
      why: "<p>The INFORMATION_SCHEMA table function is real-time and covers 7 days. STATE values include SCHEDULED, EXECUTING, SUCCEEDED, FAILED, SKIPPED and CANCELLED. SKIPPED usually means the WHEN condition was false or the previous run was still going. RESULT_LIMIT defaults to 100, so raise it for busy accounts.</p>"
    },
    {
      level: "Medium",
      title: "Stream-driven task with a failure guard",
      hint: "Combine WHEN SYSTEM$STREAM_HAS_DATA, SUSPEND_TASK_AFTER_NUM_FAILURES and a log insert inside a Scripting block.",
      prompt: "<p>Build a task that every 2 minutes applies changes from a stream on <code>COURSE_DB.CDC.ORDERS_SRC</code> into <code>ORDERS_TGT</code>, only when there's data, logs how many rows it merged into a run log table, and suspends itself after 3 consecutive failures.</p>",
      answer: `CREATE OR REPLACE STREAM COURSE_DB.CDC.ORDERS_TASK_STREAM ON TABLE COURSE_DB.CDC.ORDERS_SRC;
CREATE TABLE IF NOT EXISTS COURSE_DB.CDC.RUN_LOG (
  task_name STRING, run_at TIMESTAMP_LTZ, rows_inserted NUMBER, rows_updated NUMBER, rows_deleted NUMBER);

CREATE OR REPLACE TASK COURSE_DB.CDC.APPLY_ORDERS
  WAREHOUSE = COURSE_WH
  SCHEDULE = '2 MINUTE'
  SUSPEND_TASK_AFTER_NUM_FAILURES = 3
  WHEN SYSTEM$STREAM_HAS_DATA('COURSE_DB.CDC.ORDERS_TASK_STREAM')
AS
BEGIN
  MERGE INTO COURSE_DB.CDC.ORDERS_TGT t
  USING (SELECT * FROM COURSE_DB.CDC.ORDERS_TASK_STREAM
         WHERE NOT (METADATA$ACTION = 'DELETE' AND METADATA$ISUPDATE)) s
  ON t.O_ORDERKEY = s.O_ORDERKEY
  WHEN MATCHED AND s.METADATA$ACTION = 'DELETE' THEN DELETE
  WHEN MATCHED THEN UPDATE SET t.O_ORDERSTATUS = s.O_ORDERSTATUS, t.O_TOTALPRICE = s.O_TOTALPRICE
  WHEN NOT MATCHED AND s.METADATA$ACTION = 'INSERT' THEN INSERT
    (O_ORDERKEY, O_CUSTKEY, O_ORDERSTATUS, O_TOTALPRICE, O_ORDERDATE)
    VALUES (s.O_ORDERKEY, s.O_CUSTKEY, s.O_ORDERSTATUS, s.O_TOTALPRICE, s.O_ORDERDATE);

  INSERT INTO COURSE_DB.CDC.RUN_LOG
  SELECT 'APPLY_ORDERS', CURRENT_TIMESTAMP(), $1, $2, $3
  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
END;

ALTER TASK COURSE_DB.CDC.APPLY_ORDERS RESUME;`,
      why: "<p>A task body can be a Snowflake Scripting block, so you can run several statements. MERGE returns one row with the number of rows inserted, updated and deleted, and <code>RESULT_SCAN(LAST_QUERY_ID())</code> reads that row right after. Logging row counts per run gives you a cheap volume monitor: a sudden zero or a 10x spike is worth an alert. The WHEN clause keeps idle runs free, and the failure limit stops a broken MERGE from retrying forever.</p>"
    },
    {
      level: "Medium",
      title: "Build a small task graph",
      prompt: "<p>Build a graph: root task builds <code>STG_LINEITEM_1998</code> from LINEITEM (ship date in 1998); two children compute revenue by ship mode and by return flag; a final task records completion in <code>RUN_LOG</code>. Resume everything with one call and trigger a run.</p>",
      answer: `USE SCHEMA COURSE_DB.CDC;

CREATE OR REPLACE TASK G_ROOT WAREHOUSE = COURSE_WH SCHEDULE = 'USING CRON 30 3 * * * UTC' AS
CREATE OR REPLACE TRANSIENT TABLE STG_LINEITEM_1998 AS
SELECT * FROM COURSE_DB.TPCH.LINEITEM WHERE L_SHIPDATE >= '1998-01-01' AND L_SHIPDATE < '1999-01-01';

CREATE OR REPLACE TASK G_BY_MODE WAREHOUSE = COURSE_WH AFTER G_ROOT AS
CREATE OR REPLACE TABLE REV_BY_MODE AS
SELECT L_SHIPMODE, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) AS revenue FROM STG_LINEITEM_1998 GROUP BY 1;

CREATE OR REPLACE TASK G_BY_FLAG WAREHOUSE = COURSE_WH AFTER G_ROOT AS
CREATE OR REPLACE TABLE REV_BY_FLAG AS
SELECT L_RETURNFLAG, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) AS revenue FROM STG_LINEITEM_1998 GROUP BY 1;

CREATE OR REPLACE TASK G_DONE WAREHOUSE = COURSE_WH AFTER G_BY_MODE, G_BY_FLAG AS
INSERT INTO RUN_LOG (task_name, run_at) VALUES ('G_GRAPH_COMPLETE', CURRENT_TIMESTAMP());

SELECT SYSTEM$TASK_DEPENDENTS_ENABLE('COURSE_DB.CDC.G_ROOT');
EXECUTE TASK G_ROOT;`,
      why: "<p>G_BY_MODE and G_BY_FLAG both depend only on the root, so they run in parallel. G_DONE lists both in AFTER, so it waits for both to succeed. If either fails, G_DONE doesn't run. If you need something to happen regardless (cleanup, a failure email), that's what a finalizer task is for. <code>SYSTEM$TASK_DEPENDENTS_ENABLE</code> resumes the root and every descendant in one go. EXECUTE TASK on the root runs the entire graph.</p>"
    },
    {
      level: "Hard",
      title: "Make a task graph restartable",
      hint: "Look at EXECUTE TASK ... RETRY LAST and think about which steps are idempotent.",
      prompt: "<p>The nightly graph above failed at <code>G_BY_FLAG</code> because of a bad deploy. You've fixed the SQL. How do you rerun only the failed part, and what must be true about each task for that to be safe? Rewrite any task that isn't safe.</p>",
      answer: `-- Rerun from the failed task onward, skipping tasks that already succeeded
ALTER TASK COURSE_DB.CDC.G_ROOT SUSPEND;
CREATE OR REPLACE TASK COURSE_DB.CDC.G_BY_FLAG WAREHOUSE = COURSE_WH AFTER COURSE_DB.CDC.G_ROOT AS
CREATE OR REPLACE TABLE COURSE_DB.CDC.REV_BY_FLAG AS
SELECT L_RETURNFLAG, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) AS revenue
FROM COURSE_DB.CDC.STG_LINEITEM_1998 GROUP BY 1;
SELECT SYSTEM$TASK_DEPENDENTS_ENABLE('COURSE_DB.CDC.G_ROOT');

EXECUTE TASK COURSE_DB.CDC.G_ROOT RETRY LAST;

-- G_DONE is not idempotent: a retry after a partial success would log twice.
-- Make it idempotent by keying the log on the graph run.
CREATE OR REPLACE TASK COURSE_DB.CDC.G_DONE WAREHOUSE = COURSE_WH
  AFTER COURSE_DB.CDC.G_BY_MODE, COURSE_DB.CDC.G_BY_FLAG AS
MERGE INTO COURSE_DB.CDC.RUN_LOG t
USING (SELECT 'G_GRAPH_COMPLETE:' || SYSTEM$TASK_RUNTIME_INFO('CURRENT_TASK_GRAPH_RUN_GROUP_ID') AS task_name) s
ON t.task_name = s.task_name
WHEN NOT MATCHED THEN INSERT (task_name, run_at) VALUES (s.task_name, CURRENT_TIMESTAMP());`,
      why: "<p><code>EXECUTE TASK root RETRY LAST</code> reruns the most recent failed graph run starting from the failed tasks, without rerunning the ones that succeeded. That only works if each task is safe to run more than once with the same result. <code>CREATE OR REPLACE TABLE ... AS SELECT</code> is idempotent: rerunning it rebuilds the same table. A plain INSERT isn't. Keying the log row on the graph run ID (from <code>SYSTEM$TASK_RUNTIME_INFO</code>) and using MERGE makes the last step idempotent too. Designing every step to be rerunnable is the single most useful habit in pipeline work: it turns incidents into \"fix and retry\" instead of \"fix, clean up and pray\". Note: the root must be suspended to edit a child, which is why the sequence suspends it first. RETRY LAST has conditions (for example, it only applies to a recent failed run, and a graph whose definition changed may be refused). If it's refused, just run <code>EXECUTE TASK</code> on the root for a full rerun. Because every step is idempotent, that's safe too, only a bit slower.</p>"
    }
  ]
});
