window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "admin",
  num: "17",
  track: "Security and Governance",
  title: "Snowflake administration",
  summary: "Parameters and how they cascade, secure data sharing and reader accounts, replication and failover, organizations, encryption, and the account hardening checklist.",
  minutes: 60,
  level: "Advanced",
  lessons: [
    {
      title: "Parameters and how they cascade",
      body: `
<p>Snowflake behaviour is controlled by <b>parameters</b> at three kinds of level: account, object (warehouse, database, schema, table, user) and session. Lower levels override higher ones, and a session setting overrides the user default.</p>
<sql>
USE ROLE ACCOUNTADMIN;

SHOW PARAMETERS IN ACCOUNT;                        -- everything, with the level each is set at
SHOW PARAMETERS LIKE 'TIMEZONE' IN ACCOUNT;
SHOW PARAMETERS LIKE 'STATEMENT_TIMEOUT%' IN WAREHOUSE COURSE_WH;
SHOW PARAMETERS LIKE '%' IN USER SVC_LOADER;

-- Typical account-level settings an admin decides on
ALTER ACCOUNT SET TIMEZONE = 'UTC';
ALTER ACCOUNT SET STATEMENT_TIMEOUT_IN_SECONDS = 14400;     -- 4 hours, instead of 2 days
ALTER ACCOUNT SET DATA_RETENTION_TIME_IN_DAYS = 7;
ALTER ACCOUNT SET MIN_DATA_RETENTION_TIME_IN_DAYS = 1;       -- nobody can go below 1 day
ALTER ACCOUNT SET PREVENT_UNLOAD_TO_INLINE_URL = TRUE;       -- block COPY INTO 's3://...' without a stage
ALTER ACCOUNT SET REQUIRE_STORAGE_INTEGRATION_FOR_STAGE_CREATION = TRUE;
ALTER ACCOUNT SET REQUIRE_STORAGE_INTEGRATION_FOR_STAGE_OPERATION = TRUE;
</sql>
<p>Some parameters are account-only (like <code>MIN_DATA_RETENTION_TIME_IN_DAYS</code>). The last three above are data exfiltration controls: they stop someone from unloading data to their own bucket with inline credentials. They're on most security checklists.</p>
<table>
<tr><th>Parameter</th><th>Typical level</th><th>Why it matters</th></tr>
<tr><td>STATEMENT_TIMEOUT_IN_SECONDS</td><td>Account, warehouse, user</td><td>Stops runaway queries</td></tr>
<tr><td>DATA_RETENTION_TIME_IN_DAYS</td><td>Account, database, schema, table</td><td>Time Travel window and storage cost</td></tr>
<tr><td>TIMEZONE</td><td>Account, user, session</td><td>How TIMESTAMP_LTZ displays; consistent reports</td></tr>
<tr><td>QUERY_TAG</td><td>User, session</td><td>Cost attribution</td></tr>
<tr><td>ABORT_DETACHED_QUERY</td><td>Account, user, session</td><td>Whether queries keep running after a client disconnects</td></tr>
<tr><td>NETWORK_POLICY</td><td>Account, user</td><td>Allowed source IPs</td></tr>
</table>
`
    },
    {
      title: "Secure data sharing",
      body: `
<p>A <b>share</b> gives another Snowflake account read access to your objects without copying anything. The consumer queries your micro-partitions directly and pays for their own compute. You pay for storage, as you already do. It's how SNOWFLAKE_SAMPLE_DATA reaches you.</p>
<sql>
USE ROLE ACCOUNTADMIN;
CREATE SHARE IF NOT EXISTS TPCH_PARTNER_SHARE COMMENT = 'Order summaries for partner analytics';

-- Shares can contain tables, secure views, secure UDFs, dynamic tables, and more
CREATE SCHEMA IF NOT EXISTS COURSE_DB.SHARED;
CREATE OR REPLACE SECURE VIEW COURSE_DB.SHARED.ORDER_SUMMARY AS
SELECT DATE_TRUNC('month', O_ORDERDATE) AS month,
       O_ORDERSTATUS,
       COUNT(*)          AS orders,
       SUM(O_TOTALPRICE) AS total_value
FROM COURSE_DB.TPCH.ORDERS
GROUP BY 1, 2;

GRANT USAGE ON DATABASE COURSE_DB            TO SHARE TPCH_PARTNER_SHARE;
GRANT USAGE ON SCHEMA COURSE_DB.SHARED       TO SHARE TPCH_PARTNER_SHARE;
GRANT SELECT ON VIEW COURSE_DB.SHARED.ORDER_SUMMARY TO SHARE TPCH_PARTNER_SHARE;

ALTER SHARE TPCH_PARTNER_SHARE ADD ACCOUNTS = PARTNERORG.PARTNERACCOUNT;
SHOW SHARES;
</sql>
<p>On the consumer side:</p>
<sql>
CREATE DATABASE PARTNER_TPCH FROM SHARE PROVIDERORG.PROVIDERACCOUNT.TPCH_PARTNER_SHARE;
GRANT IMPORTED PRIVILEGES ON DATABASE PARTNER_TPCH TO ROLE ANALYST;
</sql>
<p>Things to know:</p>
<ul>
<li>Views in a share must be secure views. Data in shares is always read-only for the consumer.</li>
<li>Direct sharing only works within the same cloud region. Across regions or clouds, replicate the data to an account in the consumer's region first, or publish a <b>listing</b> with Cross-Cloud Auto-Fulfillment, which handles replication for you.</li>
<li>For consumers without a Snowflake account, create a <b>reader account</b>, which you manage and whose compute you pay for.</li>
<li>To share different rows with different consumers through one share, filter a secure view on <code>CURRENT_ACCOUNT()</code> against an entitlements table.</li>
<li>Listings (private or on the Snowflake Marketplace) add metadata, usage analytics, and auto-fulfillment on top of shares. They're now the recommended way to share.</li>
</ul>
`
    },
    {
      title: "Replication, failover and business continuity",
      body: `
<p>Snowflake replicates data between accounts in the same organization, across regions and clouds. Modern setups use <b>replication groups</b> and <b>failover groups</b>, which replicate a set of objects together on a schedule with point-in-time consistency.</p>
<table>
<tr><th>Group type</th><th>What it does</th><th>Edition</th></tr>
<tr><td>Replication group</td><td>Read-only copies of databases (and shares) in other accounts</td><td>Standard and above</td></tr>
<tr><td>Failover group</td><td>Replication of databases plus account objects (users, roles, grants, warehouses, integrations, network policies...) that can be promoted to primary</td><td>Business Critical and above</td></tr>
</table>
<sql>
-- In the primary account
CREATE FAILOVER GROUP PROD_FG
  OBJECT_TYPES = USERS, ROLES, WAREHOUSES, RESOURCE MONITORS, DATABASES, INTEGRATIONS, NETWORK POLICIES
  ALLOWED_DATABASES = COURSE_DB
  ALLOWED_ACCOUNTS = MYORG.DR_ACCOUNT
  REPLICATION_SCHEDULE = '10 MINUTE';

-- In the secondary (DR) account
CREATE FAILOVER GROUP PROD_FG AS REPLICA OF MYORG.PRIMARY_ACCOUNT.PROD_FG;
ALTER FAILOVER GROUP PROD_FG REFRESH;            -- manual refresh

-- During a disaster, run in the secondary account
ALTER FAILOVER GROUP PROD_FG PRIMARY;
</sql>
<p>Your recovery point objective (how much data you can lose) is roughly the replication schedule. Your recovery time objective depends on how quickly clients reconnect, which is where <b>client redirect</b> comes in: a connection URL at the organization level that you point at whichever account is primary, so tools reconnect without config changes.</p>
<p>Replication costs data transfer plus compute for refreshes, and the secondary stores a full copy. Monitor with <code>REPLICATION_GROUP_REFRESH_HISTORY</code>. Test failover regularly; an untested DR plan is a guess.</p>
`
    },
    {
      title: "Organizations, encryption and connectivity",
      body: `
<p><b>Organizations</b> group a company's Snowflake accounts. ORGADMIN (or the organization account in newer setups) creates accounts, sees usage across them through <code>SNOWFLAKE.ORGANIZATION_USAGE</code>, and enables replication between them. A common pattern is separate accounts for production, non-production and sandbox, rather than separate databases in one account, because account-level objects like network policies and integrations then stay isolated.</p>
<sql>
USE ROLE ORGADMIN;
SHOW ACCOUNTS;
SHOW REGIONS;
</sql>
<p><b>Encryption</b> is always on. Data is encrypted at rest with AES-256 in a hierarchical key model, keys are rotated automatically every 30 days, and you can turn on periodic rekeying (Enterprise) so data encrypted with old keys is re-encrypted yearly. <b>Tri-Secret Secure</b> (Business Critical) combines a Snowflake-managed key with your own key in your cloud KMS, so revoking your key makes the data unreadable.</p>
<p><b>Private connectivity</b> (Business Critical): AWS PrivateLink, Azure Private Link and GCP Private Service Connect let clients reach Snowflake without crossing the public internet, and network policies can then block public access entirely.</p>
<h3>Account hardening checklist</h3>
<ul>
<li>At least two ACCOUNTADMIN users, all with MFA, none used for daily work.</li>
<li>SSO for people, key-pair or OAuth for services, and <code>TYPE = SERVICE</code> on service users.</li>
<li>An account-level network policy, plus stricter per-user policies for service accounts.</li>
<li>Storage integrations required for stages, and inline URL unloads blocked.</li>
<li>A minimum Time Travel retention so nobody can set it to 0 silently.</li>
<li>Statement timeouts and resource monitors on every warehouse.</li>
<li>Sensitive data tagged and masked, access history reviewed.</li>
<li>Trust Center scanners enabled (where available) to check the account against CIS benchmarks automatically.</li>
</ul>
`
    }
  ],
  quiz: [
    {
      q: "A warehouse has STATEMENT_TIMEOUT_IN_SECONDS = 3600 and the user running a query has it set to 600. Which applies?",
      options: [
        "3600, the warehouse wins",
        "600, the lower of the two",
        "The account value",
        "Whichever was set most recently"
      ],
      answer: 1,
      why: "<p>For STATEMENT_TIMEOUT_IN_SECONDS specifically, when it's set on both the warehouse and the session/user, the lowest value applies. That's an exception to the usual \"most specific wins\" rule, and a favourite exam question.</p>"
    },
    {
      q: "What does a share consumer pay for when querying shared data?",
      options: [
        "Storage and compute",
        "Only compute on their own warehouses",
        "Nothing",
        "Data transfer fees per row"
      ],
      answer: 1,
      why: "<p>The provider keeps paying for storage. The consumer pays for the warehouse that runs their queries. A reader account is the exception, because the provider pays its compute.</p>"
    },
    {
      q: "Why must views in a share be secure views?",
      options: [
        "Regular views can't be queried remotely",
        "So consumers can't see the view definition or use optimizations that could expose underlying data",
        "Secure views are faster",
        "Shares only support materialized views"
      ],
      answer: 1,
      why: "<p>The consumer is outside your account. Secure views hide your SQL and prevent optimizer tricks that might leak rows the view filters out.</p>"
    },
    {
      q: "A consumer is in a different cloud region. How can you share with them?",
      options: [
        "Direct share works across all regions",
        "Replicate to an account in their region and share from there, or use a listing with auto-fulfillment",
        "Export to CSV and email it",
        "It's impossible"
      ],
      answer: 1,
      why: "<p>Direct shares are region-local. Listings with Cross-Cloud Auto-Fulfillment automate replication to the consumer's region.</p>"
    },
    {
      q: "Which needs Business Critical edition?",
      options: [
        "Database replication to another region",
        "Failover groups that can promote a secondary to primary",
        "Secure data sharing",
        "Zero-copy cloning"
      ],
      answer: 1,
      why: "<p>Failover and failback need Business Critical. Plain database replication for read-only copies is available on lower editions.</p>"
    },
    {
      q: "What do PREVENT_UNLOAD_TO_INLINE_URL and REQUIRE_STORAGE_INTEGRATION_FOR_STAGE_CREATION protect against?",
      options: [
        "Slow unloads",
        "Users unloading data to arbitrary cloud locations with their own credentials",
        "Snowpipe failures",
        "Fail-safe data loss"
      ],
      answer: 1,
      why: "<p>Without them, anyone who can run COPY can write table data to a bucket they control. Forcing stages through admin-approved storage integrations closes that path.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Find where a parameter is set",
      prompt: "<p>Find the effective value of <code>DATA_RETENTION_TIME_IN_DAYS</code> for <code>COURSE_DB.TPCH.ORDERS</code> and the level it comes from. Then set it to 3 days on the TPCH schema only and check again.</p>",
      answer: `SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN TABLE COURSE_DB.TPCH.ORDERS;

ALTER SCHEMA COURSE_DB.TPCH SET DATA_RETENTION_TIME_IN_DAYS = 3;

SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN TABLE COURSE_DB.TPCH.ORDERS;`,
      why: "<p>The <code>level</code> column says where the value comes from. Before the change it's probably ACCOUNT (or blank, meaning default). After, it's SCHEMA. A value set directly on the table would override the schema. On Standard edition, anything above 1 is rejected for this parameter.</p>"
    },
    {
      level: "Easy",
      title: "List what you share",
      prompt: "<p>Show every outbound share in your account, what objects each contains, and which accounts consume it.</p>",
      answer: `SHOW SHARES;
SELECT "name", "kind", "database_name", "to", "owner"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "kind" = 'OUTBOUND';

-- Objects in a given share
SHOW GRANTS TO SHARE TPCH_PARTNER_SHARE;`,
      why: "<p>SHOW SHARES returns both inbound (shared with you, like SFC_SAMPLES.SAMPLE_DATA) and outbound shares. The <code>to</code> column lists consumer accounts. SHOW GRANTS TO SHARE lists each object exposed, which is what you review in a data sharing audit.</p>"
    },
    {
      level: "Medium",
      title: "One share, many consumers",
      hint: "Secure view filtering on CURRENT_ACCOUNT() against an entitlements table, which you also share or keep private.",
      prompt: "<p>Share TPC-H orders with several partner accounts, each seeing only orders from customers in their nation. Build the entitlement table, the secure view and the share. Then test what a specific consumer would see without having their account.</p>",
      answer: `USE ROLE ACCOUNTADMIN;
CREATE SCHEMA IF NOT EXISTS COURSE_DB.SHARED;

CREATE OR REPLACE TABLE COURSE_DB.SHARED.PARTNER_ENTITLEMENTS (
  consumer_account STRING,   -- value of CURRENT_ACCOUNT() in the consumer account
  nation_key NUMBER);
INSERT INTO COURSE_DB.SHARED.PARTNER_ENTITLEMENTS VALUES
  ('PARTNER_DE_LOCATOR', 7),   -- GERMANY
  ('PARTNER_JP_LOCATOR', 12);  -- JAPAN

CREATE OR REPLACE SECURE VIEW COURSE_DB.SHARED.PARTNER_ORDERS AS
SELECT o.O_ORDERKEY, o.O_ORDERDATE, o.O_ORDERSTATUS, o.O_TOTALPRICE, c.C_NATIONKEY
FROM COURSE_DB.TPCH.ORDERS o
JOIN COURSE_DB.TPCH.CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
JOIN COURSE_DB.SHARED.PARTNER_ENTITLEMENTS e
  ON e.nation_key = c.C_NATIONKEY
 AND e.consumer_account = CURRENT_ACCOUNT();

CREATE SHARE IF NOT EXISTS PARTNER_ORDERS_SHARE;
GRANT USAGE ON DATABASE COURSE_DB TO SHARE PARTNER_ORDERS_SHARE;
GRANT USAGE ON SCHEMA COURSE_DB.SHARED TO SHARE PARTNER_ORDERS_SHARE;
GRANT SELECT ON VIEW COURSE_DB.SHARED.PARTNER_ORDERS TO SHARE PARTNER_ORDERS_SHARE;
-- ALTER SHARE PARTNER_ORDERS_SHARE ADD ACCOUNTS = ORG.PARTNER_DE, ORG.PARTNER_JP;

-- Test as if you were a consumer, from the provider account
ALTER SESSION SET SIMULATED_DATA_SHARING_CONSUMER = 'PARTNER_DE_LOCATOR';
SELECT C_NATIONKEY, COUNT(*) FROM COURSE_DB.SHARED.PARTNER_ORDERS GROUP BY 1;
ALTER SESSION UNSET SIMULATED_DATA_SHARING_CONSUMER;`,
      why: "<p>Inside a shared secure view, CURRENT_ACCOUNT() returns the consumer's account locator, so the join to the entitlement table filters each consumer down to their nations. The entitlement table itself is not granted to the share, so consumers can't see who else gets what. SIMULATED_DATA_SHARING_CONSUMER lets the provider test exactly what each consumer will see. Adding or removing a nation for a partner is just a row change, no new shares or views. In production the entitlement table would probably use CURRENT_ACCOUNT_NAME() or an organization-qualified name instead of a locator.</p>"
    },
    {
      level: "Medium",
      title: "Lock down data exfiltration",
      prompt: "<p>Write the account-level settings and a quick check that would stop a user with SELECT on sensitive tables from unloading them to a personal S3 bucket.</p>",
      answer: `USE ROLE ACCOUNTADMIN;
ALTER ACCOUNT SET PREVENT_UNLOAD_TO_INLINE_URL = TRUE;
ALTER ACCOUNT SET REQUIRE_STORAGE_INTEGRATION_FOR_STAGE_CREATION = TRUE;
ALTER ACCOUNT SET REQUIRE_STORAGE_INTEGRATION_FOR_STAGE_OPERATION = TRUE;
ALTER ACCOUNT SET PREVENT_UNLOAD_TO_INTERNAL_STAGES = FALSE;   -- set TRUE if even internal unloads must be blocked

-- Who can create stages or integrations?
SELECT GRANTEE_NAME, PRIVILEGE, GRANTED_ON, NAME
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
WHERE DELETED_ON IS NULL
  AND PRIVILEGE IN ('CREATE STAGE', 'CREATE INTEGRATION')
ORDER BY PRIVILEGE, GRANTEE_NAME;

-- Which storage integrations exist and where can they write?
SHOW INTEGRATIONS;
-- then DESC INTEGRATION <name>; and review STORAGE_ALLOWED_LOCATIONS`,
      why: "<p>Inline URLs (<code>COPY INTO 's3://bucket/...' CREDENTIALS = (...)</code>) are the easiest exfiltration route; blocking them forces all external I/O through stages. Requiring storage integrations for stage creation and operation means every external location must be approved by whoever controls integrations, normally ACCOUNTADMIN only. Then review who holds CREATE STAGE and CREATE INTEGRATION, and what locations each integration allows. Network policies, private connectivity and egress rules on your own cloud buckets complete the picture.</p>"
    },
    {
      level: "Hard",
      title: "Plan a DR setup",
      prompt: "<p>Your production account in AWS us-east-1 runs dbt, Snowpipe and BI. Leadership wants a recovery point of 15 minutes and recovery time under an hour if the region goes down. You're on Business Critical. Outline the setup and write the key SQL, including what does and doesn't replicate, and how clients reconnect.</p>",
      answer: `-- 0. Organization: enable replication for both accounts (ORGADMIN)
USE ROLE ORGADMIN;
SELECT SYSTEM$GLOBAL_ACCOUNT_SET_PARAMETER('MYORG.PROD_USE1', 'ENABLE_ACCOUNT_DATABASE_REPLICATION', 'true');
SELECT SYSTEM$GLOBAL_ACCOUNT_SET_PARAMETER('MYORG.PROD_USW2', 'ENABLE_ACCOUNT_DATABASE_REPLICATION', 'true');

-- 1. Primary: one failover group for account objects + databases, refreshed every 10 minutes
USE ROLE ACCOUNTADMIN;
CREATE FAILOVER GROUP PROD_FG
  OBJECT_TYPES = USERS, ROLES, WAREHOUSES, RESOURCE MONITORS, NETWORK POLICIES,
                 INTEGRATIONS, ACCOUNT PARAMETERS, DATABASES, SHARES
  ALLOWED_INTEGRATION_TYPES = SECURITY INTEGRATIONS, API INTEGRATIONS, STORAGE INTEGRATIONS
  ALLOWED_DATABASES = RAW, ANALYTICS
  ALLOWED_SHARES = PARTNER_ORDERS_SHARE
  ALLOWED_ACCOUNTS = MYORG.PROD_USW2
  REPLICATION_SCHEDULE = '10 MINUTE';

-- 2. Secondary (us-west-2)
CREATE FAILOVER GROUP PROD_FG AS REPLICA OF MYORG.PROD_USE1.PROD_FG;

-- 3. Client redirect: one URL for all tools
CREATE CONNECTION PROD_CONN;                                     -- on primary
ALTER CONNECTION PROD_CONN ENABLE FAILOVER TO ACCOUNTS MYORG.PROD_USW2;
CREATE CONNECTION PROD_CONN AS REPLICA OF MYORG.PROD_USE1.PROD_CONN;   -- on secondary
-- tools connect to myorg-prod_conn.snowflakecomputing.com

-- 4. Failover, run in the secondary during an outage
ALTER FAILOVER GROUP PROD_FG PRIMARY;
ALTER CONNECTION PROD_CONN PRIMARY;

-- 5. Monitor lag continuously
SELECT PHASE_NAME, START_TIME, END_TIME, TOTAL_BYTES
FROM TABLE(INFORMATION_SCHEMA.REPLICATION_GROUP_REFRESH_HISTORY('PROD_FG'))
ORDER BY START_TIME DESC LIMIT 10;`,
      why: "<p><b>RPO:</b> a 10-minute schedule leaves headroom for refresh duration within a 15-minute target; alert if a refresh takes longer or fails. <b>RTO:</b> promotion is a single statement; client redirect means BI tools, dbt and apps reconnect through the same URL, which is what makes an hour realistic. <b>What replicates:</b> databases (tables, views, streams, tasks, dynamic tables, policies, tags), plus users, roles, grants, warehouses, network policies, chosen integrations and parameters. <b>What to plan for separately:</b> Snowpipe auto-ingest needs event notifications from a bucket the secondary can read, so set up bucket replication or a cross-region bucket and test it; tasks in secondary databases are suspended until promotion; external stages need storage reachable from the new region; and anything outside Snowflake (Airflow, dbt Cloud) needs its own DR. Most importantly, run a failover drill every quarter. The first real failover should not be the first one.</p>"
    }
  ]
});
