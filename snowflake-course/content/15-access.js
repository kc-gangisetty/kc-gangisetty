window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "access",
  num: "15",
  track: "Security and Governance",
  title: "Users, roles and access control",
  summary: "RBAC in Snowflake: system roles, ownership, access roles versus functional roles, future grants, managed access, database roles, secondary roles, service users with key-pair auth, and network policies.",
  minutes: 65,
  level: "Advanced",
  lessons: [
    {
      title: "How Snowflake access control works",
      body: `
<p>Snowflake combines two models:</p>
<ul>
<li><b>Role-based access control (RBAC):</b> privileges are granted to roles, roles are granted to users (and to other roles). A user can do whatever their current role (plus any secondary roles) allows.</li>
<li><b>Discretionary access control:</b> every object has exactly one owner, a role. The owner has full control, including granting privileges on it to others (unless it's in a managed access schema).</li>
</ul>
<p>Privileges are granted on securable objects, and you need privileges on every level of the path. To read <code>COURSE_DB.TPCH.ORDERS</code> a role needs USAGE on the database, USAGE on the schema, and SELECT on the table. Missing any one gives you "object does not exist or not authorized", deliberately the same message, so people can't probe for object names.</p>
<p>The system-defined roles:</p>
<table>
<tr><th>Role</th><th>Purpose</th></tr>
<tr><td>ORGADMIN</td><td>Organization-level: create accounts, view org usage</td></tr>
<tr><td>ACCOUNTADMIN</td><td>Top of the account. Includes SYSADMIN and SECURITYADMIN. Billing, account parameters, resource monitors. Keep to very few people with MFA.</td></tr>
<tr><td>SECURITYADMIN</td><td>Manages grants globally (MANAGE GRANTS). Includes USERADMIN.</td></tr>
<tr><td>USERADMIN</td><td>Creates and manages users and roles</td></tr>
<tr><td>SYSADMIN</td><td>Creates warehouses, databases and other objects. Custom roles should roll up to it.</td></tr>
<tr><td>PUBLIC</td><td>Granted to everyone automatically. Anything granted to PUBLIC is visible to all users.</td></tr>
</table>
<div class="warn"><b>The most common mistake</b>Creating objects as ACCOUNTADMIN. ACCOUNTADMIN then owns them, SYSADMIN can't manage them, and everyone ends up needing ACCOUNTADMIN to do daily work. Use ACCOUNTADMIN only for account-level tasks, and set people's default role to something else.</div>
`
    },
    {
      title: "Designing roles: access roles and functional roles",
      body: `
<p>The pattern that scales is two layers of custom roles:</p>
<ul>
<li><b>Access roles</b> hold privileges on objects, such as "read the MART schema" or "write the STAGING schema". They're never granted to users directly.</li>
<li><b>Functional roles</b> represent jobs, such as ANALYST, DATA_ENGINEER or FINANCE_ANALYST. They get access roles granted to them, and they're granted to users.</li>
</ul>
<p>When a new table appears, you update one access role. When a person changes teams, you swap one functional role. Nothing else changes.</p>
<sql>
USE ROLE USERADMIN;
CREATE ROLE IF NOT EXISTS AR_COURSE_TPCH_READ;     -- access role
CREATE ROLE IF NOT EXISTS AR_COURSE_TPCH_WRITE;    -- access role
CREATE ROLE IF NOT EXISTS FR_ANALYST;              -- functional role
CREATE ROLE IF NOT EXISTS FR_DATA_ENGINEER;        -- functional role

USE ROLE SECURITYADMIN;
-- Read access
GRANT USAGE ON DATABASE COURSE_DB TO ROLE AR_COURSE_TPCH_READ;
GRANT USAGE ON SCHEMA COURSE_DB.TPCH TO ROLE AR_COURSE_TPCH_READ;
GRANT SELECT ON ALL TABLES IN SCHEMA COURSE_DB.TPCH TO ROLE AR_COURSE_TPCH_READ;
GRANT SELECT ON FUTURE TABLES IN SCHEMA COURSE_DB.TPCH TO ROLE AR_COURSE_TPCH_READ;
GRANT SELECT ON ALL VIEWS IN SCHEMA COURSE_DB.TPCH TO ROLE AR_COURSE_TPCH_READ;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA COURSE_DB.TPCH TO ROLE AR_COURSE_TPCH_READ;

-- Write access builds on read
GRANT ROLE AR_COURSE_TPCH_READ TO ROLE AR_COURSE_TPCH_WRITE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA COURSE_DB.TPCH TO ROLE AR_COURSE_TPCH_WRITE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON FUTURE TABLES IN SCHEMA COURSE_DB.TPCH TO ROLE AR_COURSE_TPCH_WRITE;
GRANT CREATE TABLE, CREATE VIEW ON SCHEMA COURSE_DB.TPCH TO ROLE AR_COURSE_TPCH_WRITE;

-- Functional roles get access roles plus a warehouse
GRANT ROLE AR_COURSE_TPCH_READ  TO ROLE FR_ANALYST;
GRANT ROLE AR_COURSE_TPCH_WRITE TO ROLE FR_DATA_ENGINEER;
GRANT USAGE ON WAREHOUSE COURSE_WH TO ROLE FR_ANALYST;
GRANT USAGE, OPERATE ON WAREHOUSE COURSE_WH TO ROLE FR_DATA_ENGINEER;

-- Roll everything up to SYSADMIN so admins can manage what these roles create
GRANT ROLE FR_ANALYST       TO ROLE SYSADMIN;
GRANT ROLE FR_DATA_ENGINEER TO ROLE SYSADMIN;
</sql>
<p><b>Future grants</b> apply to objects created later, so you don't have to re-grant after every new table. If future grants exist at both database and schema level for the same object type, the schema-level ones win and the database-level ones are ignored for that schema.</p>
<p><b>Database roles</b> are roles that live inside a database. They're ideal as access roles because they travel with the database when it's shared or replicated, and a database owner can manage them without account-level role admin rights.</p>
<sql>
USE ROLE SYSADMIN;
CREATE DATABASE ROLE IF NOT EXISTS COURSE_DB.TPCH_READER;
GRANT USAGE ON SCHEMA COURSE_DB.TPCH TO DATABASE ROLE COURSE_DB.TPCH_READER;
GRANT SELECT ON ALL TABLES IN SCHEMA COURSE_DB.TPCH TO DATABASE ROLE COURSE_DB.TPCH_READER;
GRANT DATABASE ROLE COURSE_DB.TPCH_READER TO ROLE FR_ANALYST;
</sql>
`
    },
    {
      title: "Users, service accounts and authentication",
      body: `
<sql>
USE ROLE USERADMIN;

-- A human user
CREATE USER IF NOT EXISTS JANE_DOE
  TYPE = PERSON
  LOGIN_NAME = 'jane.doe@example.com'
  EMAIL = 'jane.doe@example.com'
  DEFAULT_ROLE = FR_ANALYST
  DEFAULT_WAREHOUSE = COURSE_WH
  DEFAULT_SECONDARY_ROLES = ('ALL')
  MUST_CHANGE_PASSWORD = TRUE
  PASSWORD = 'Use-a-real-temporary-password-1';

-- A service account for a pipeline tool: no password, key-pair only
CREATE USER IF NOT EXISTS SVC_ETL
  TYPE = SERVICE
  DEFAULT_ROLE = FR_DATA_ENGINEER
  DEFAULT_WAREHOUSE = COURSE_WH
  RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...'   -- public key only; the private key stays with the tool
  COMMENT = 'Airflow loader. Owner: data-platform';

USE ROLE SECURITYADMIN;
GRANT ROLE FR_ANALYST       TO USER JANE_DOE;
GRANT ROLE FR_DATA_ENGINEER TO USER SVC_ETL;
</sql>
<p><code>TYPE = SERVICE</code> users can't log in with a password or use MFA prompts; they use key-pair, OAuth or programmatic tokens. Snowflake is phasing out single-factor password sign-in for people, so human users should use SSO (SAML through Okta, Entra ID and others) or passwords with MFA. Key-pair auth supports two public keys at once (<code>RSA_PUBLIC_KEY</code> and <code>RSA_PUBLIC_KEY_2</code>) so you can rotate keys without downtime.</p>
<p>Other controls:</p>
<ul>
<li><b>Network policies</b> restrict which IP addresses (or private endpoints) can connect, at account or user level. Modern setups define <b>network rules</b> and reference them from the policy.</li>
<li><b>Authentication policies</b> control which methods (password, SAML, key-pair, OAuth) and clients a user or account may use, and can require MFA.</li>
<li><b>Password policies</b> set length, complexity, age and lockout rules.</li>
<li><b>Session policies</b> set idle timeouts.</li>
</ul>
<sql>
USE ROLE ACCOUNTADMIN;   -- network rules need a schema to live in; policies need SECURITYADMIN or above
CREATE NETWORK RULE IF NOT EXISTS COURSE_DB.PUBLIC.ETL_EGRESS_IPS
  MODE = INGRESS TYPE = IPV4 VALUE_LIST = ('203.0.113.10', '203.0.113.11');
CREATE NETWORK POLICY IF NOT EXISTS ETL_ONLY
  ALLOWED_NETWORK_RULE_LIST = ('COURSE_DB.PUBLIC.ETL_EGRESS_IPS');
ALTER USER SVC_ETL SET NETWORK_POLICY = ETL_ONLY;
</sql>
`
    },
    {
      title: "Managed access, secondary roles and auditing grants",
      body: `
<p><b>Managed access schemas</b> stop object owners from granting access themselves. Only the schema owner or a role with MANAGE GRANTS can grant. Use them for production schemas so access decisions go through one process.</p>
<p><b>Secondary roles</b> let a user's session combine privileges from all their granted roles for reading data, while the primary role still owns anything they create. <code>USE SECONDARY ROLES ALL;</code> ends a lot of "switch role, run query, switch back" friction. CREATE privileges come only from the primary role.</p>
<p><b>Auditing grants</b>:</p>
<sql>
SHOW GRANTS TO ROLE FR_ANALYST;          -- what this role can do (direct grants only)
SHOW GRANTS OF ROLE FR_ANALYST;          -- who has this role
SHOW GRANTS ON TABLE COURSE_DB.TPCH.ORDERS;
SHOW FUTURE GRANTS IN SCHEMA COURSE_DB.TPCH;

-- Account-wide, queryable history (ACCOUNT_USAGE, up to 2 hours latency)
SELECT GRANTEE_NAME, PRIVILEGE, GRANTED_ON, NAME, GRANTED_BY, CREATED_ON
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
WHERE DELETED_ON IS NULL
  AND GRANTEE_NAME = 'FR_ANALYST';

-- Who has ACCOUNTADMIN?
SELECT GRANTEE_NAME AS user_name, CREATED_ON
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS
WHERE ROLE = 'ACCOUNTADMIN' AND DELETED_ON IS NULL;
</sql>
<p>SHOW GRANTS TO ROLE only lists direct grants. To see everything a role can effectively do, you have to walk the role hierarchy, which is a nice recursive CTE (see the hard practice problem).</p>
`
    }
  ],
  quiz: [
    {
      q: "A role has SELECT on COURSE_DB.TPCH.ORDERS but queries fail with \"does not exist or not authorized\". What's most likely missing?",
      options: [
        "OWNERSHIP on the table",
        "USAGE on the database and/or schema",
        "MONITOR on the warehouse",
        "The ACCOUNTADMIN role"
      ],
      answer: 1,
      why: "<p>Every level of the path needs a privilege: USAGE on the database, USAGE on the schema, then SELECT on the table. Snowflake returns the same message whether the object is missing or you lack access.</p>"
    },
    {
      q: "Why should custom roles be granted to SYSADMIN?",
      options: [
        "It's required for the role to work",
        "So that SYSADMIN (and roles above it) can manage objects owned by those custom roles",
        "So users get SYSADMIN automatically",
        "To give the custom roles warehouse access"
      ],
      answer: 1,
      why: "<p>Privileges flow up the hierarchy. If a custom role isn't under SYSADMIN, objects it owns are invisible to SYSADMIN, creating orphaned objects that only ACCOUNTADMIN or the role itself can manage.</p>"
    },
    {
      q: "In the access-role/functional-role model, which roles are granted to users?",
      options: ["Access roles", "Functional roles", "Both equally", "Neither; privileges go directly to users"],
      answer: 1,
      why: "<p>Users get functional roles that describe their job. Access roles bundle object privileges and are granted to functional roles. Snowflake doesn't support granting object privileges directly to users at all.</p>"
    },
    {
      q: "Future grants exist on tables at both the database level and the schema level for schema S. A new table is created in S. Which future grants apply?",
      options: [
        "Both sets",
        "Only the schema-level future grants",
        "Only the database-level future grants",
        "Neither; they conflict"
      ],
      answer: 1,
      why: "<p>Schema-level future grants take precedence and database-level ones are ignored for that object type in that schema. Forgetting this is a common cause of \"why didn't my role get access to the new table?\"</p>"
    },
    {
      q: "What's the right authentication setup for an ETL tool's Snowflake user?",
      options: [
        "TYPE = PERSON with a long password",
        "TYPE = SERVICE with key-pair authentication and a network policy",
        "Share an analyst's credentials",
        "TYPE = SERVICE with MFA prompts"
      ],
      answer: 1,
      why: "<p>Service users can't use passwords or interactive MFA. Key-pair (or OAuth/programmatic tokens) plus a network policy limiting source IPs is the standard, and RSA_PUBLIC_KEY_2 allows zero-downtime rotation.</p>"
    },
    {
      q: "With <code>USE SECONDARY ROLES ALL</code>, which role owns a table the user creates?",
      options: ["The secondary role with the most privileges", "The primary role", "PUBLIC", "SYSADMIN"],
      answer: 1,
      why: "<p>Secondary roles add privileges for queries and DML, but CREATE statements use the primary role, and it becomes the owner.</p>"
    },
    {
      q: "What does a MANAGED ACCESS schema change?",
      options: [
        "Tables in it can't be queried",
        "Only the schema owner or a role with MANAGE GRANTS can grant privileges on its objects",
        "All tables become secure views",
        "Grants are automatically revoked after 30 days"
      ],
      answer: 1,
      why: "<p>Object owners lose the ability to grant on their own objects, centralizing access decisions. They still own the objects and can modify them.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Read-only analyst",
      prompt: "<p>Create a role <code>TPCH_VIEWER</code> that can query every current and future table in <code>COURSE_DB.TPCH</code> and use <code>COURSE_WH</code>. Grant it to yourself and test it.</p>",
      answer: `USE ROLE USERADMIN;
CREATE ROLE IF NOT EXISTS TPCH_VIEWER;

USE ROLE SECURITYADMIN;
GRANT USAGE ON DATABASE COURSE_DB                     TO ROLE TPCH_VIEWER;
GRANT USAGE ON SCHEMA COURSE_DB.TPCH                  TO ROLE TPCH_VIEWER;
GRANT SELECT ON ALL TABLES IN SCHEMA COURSE_DB.TPCH    TO ROLE TPCH_VIEWER;
GRANT SELECT ON FUTURE TABLES IN SCHEMA COURSE_DB.TPCH TO ROLE TPCH_VIEWER;
GRANT USAGE ON WAREHOUSE COURSE_WH                    TO ROLE TPCH_VIEWER;
GRANT ROLE TPCH_VIEWER TO ROLE SYSADMIN;
GRANT ROLE TPCH_VIEWER TO USER <your_user_name>;

USE ROLE TPCH_VIEWER;
SELECT COUNT(*) FROM COURSE_DB.TPCH.ORDERS;      -- works
DELETE FROM COURSE_DB.TPCH.REGION;               -- fails: insufficient privileges`,
      why: "<p>The four layers are database USAGE, schema USAGE, table SELECT and warehouse USAGE. ALL covers existing tables and FUTURE covers tables created later. Granting the role to SYSADMIN keeps the hierarchy tidy. Replace <code>&lt;your_user_name&gt;</code> with the result of <code>SELECT CURRENT_USER();</code>. Testing a negative case (the DELETE) is as important as the positive one.</p>"
    },
    {
      level: "Easy",
      title: "Who can see this table?",
      prompt: "<p>List every role that has any privilege on <code>COURSE_DB.TPCH.CUSTOMER</code>, and every user that has ACCOUNTADMIN.</p>",
      answer: `SHOW GRANTS ON TABLE COURSE_DB.TPCH.CUSTOMER;

SELECT GRANTEE_NAME AS user_name, CREATED_ON, GRANTED_BY
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS
WHERE ROLE = 'ACCOUNTADMIN'
  AND DELETED_ON IS NULL;`,
      why: "<p>SHOW GRANTS ON shows direct grants on the object (including OWNERSHIP). Remember roles above those in the hierarchy also get access, so the full answer includes their parents. For ACCOUNTADMIN, the recommendation is at least two people (so you're never locked out) and as few as possible beyond that, all with MFA.</p>"
    },
    {
      level: "Medium",
      title: "A service account done properly",
      hint: "TYPE = SERVICE, key pair, network policy, default role and warehouse, and a role that can only write to one schema.",
      prompt: "<p>Create a service user <code>SVC_LOADER</code> for a tool that loads into <code>COURSE_DB.LANDING</code>. It should only be able to read and write that schema, use one small warehouse, authenticate with a key pair, and connect only from <code>198.51.100.0/24</code>. Show how you'd rotate its key later.</p>",
      answer: `USE ROLE SYSADMIN;
CREATE WAREHOUSE IF NOT EXISTS LOADER_WH WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 INITIALLY_SUSPENDED = TRUE;

USE ROLE USERADMIN;
CREATE ROLE IF NOT EXISTS FR_LOADER;

USE ROLE SECURITYADMIN;
GRANT USAGE ON DATABASE COURSE_DB TO ROLE FR_LOADER;
GRANT USAGE ON SCHEMA COURSE_DB.LANDING TO ROLE FR_LOADER;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA COURSE_DB.LANDING TO ROLE FR_LOADER;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON FUTURE TABLES IN SCHEMA COURSE_DB.LANDING TO ROLE FR_LOADER;
GRANT READ, WRITE ON ALL STAGES IN SCHEMA COURSE_DB.LANDING TO ROLE FR_LOADER;
GRANT USAGE ON ALL FILE FORMATS IN SCHEMA COURSE_DB.LANDING TO ROLE FR_LOADER;
GRANT USAGE ON WAREHOUSE LOADER_WH TO ROLE FR_LOADER;
GRANT ROLE FR_LOADER TO ROLE SYSADMIN;

USE ROLE ACCOUNTADMIN;   -- owns the schema for the rule (via SYSADMIN) and can create policies
CREATE NETWORK RULE IF NOT EXISTS COURSE_DB.PUBLIC.LOADER_IPS
  MODE = INGRESS TYPE = IPV4 VALUE_LIST = ('198.51.100.0/24');
CREATE NETWORK POLICY IF NOT EXISTS LOADER_ONLY
  ALLOWED_NETWORK_RULE_LIST = ('COURSE_DB.PUBLIC.LOADER_IPS');

USE ROLE USERADMIN;
CREATE USER IF NOT EXISTS SVC_LOADER
  TYPE = SERVICE
  DEFAULT_ROLE = FR_LOADER
  DEFAULT_WAREHOUSE = LOADER_WH
  RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...key1...'
  COMMENT = 'Loads files into COURSE_DB.LANDING. Owner: data-platform';

USE ROLE SECURITYADMIN;
ALTER USER SVC_LOADER SET NETWORK_POLICY = LOADER_ONLY;
GRANT ROLE FR_LOADER TO USER SVC_LOADER;

-- Rotation, later: add the new key, switch the tool over, then remove the old one
ALTER USER SVC_LOADER SET RSA_PUBLIC_KEY_2 = 'MIIBIjANBgkqh...key2...';
-- ... deploy the new private key to the tool and confirm logins use it ...
ALTER USER SVC_LOADER UNSET RSA_PUBLIC_KEY;
DESC USER SVC_LOADER;   -- RSA_PUBLIC_KEY_FP / RSA_PUBLIC_KEY_2_FP show which keys are set`,
      why: "<p>Least privilege end to end: the role can touch one schema and one tiny warehouse, nothing else. The service user has no password at all, so there's nothing to phish or leak in a config file; only the holder of the private key can log in, and only from the allowed network range. Two key slots make rotation a no-downtime, three-step process. The network rule lives in a schema; many teams keep these in a dedicated security database owned by SECURITYADMIN.</p>"
    },
    {
      level: "Medium",
      title: "Fix orphaned ownership",
      prompt: "<p>Someone created <code>COURSE_DB.TPCH.TEMP_ANALYSIS</code> while using ACCOUNTADMIN. Now SYSADMIN can't drop it. Find every table in COURSE_DB owned by ACCOUNTADMIN and move ownership to SYSADMIN without losing existing grants.</p>",
      answer: `USE ROLE ACCOUNTADMIN;

-- Find them
SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, TABLE_OWNER
FROM COURSE_DB.INFORMATION_SCHEMA.TABLES
WHERE TABLE_OWNER = 'ACCOUNTADMIN';

-- Transfer one
GRANT OWNERSHIP ON TABLE COURSE_DB.TPCH.TEMP_ANALYSIS TO ROLE SYSADMIN COPY CURRENT GRANTS;

-- Or all tables in a schema at once
GRANT OWNERSHIP ON ALL TABLES IN SCHEMA COURSE_DB.TPCH TO ROLE SYSADMIN COPY CURRENT GRANTS;`,
      why: "<p>Ownership transfer requires the current owner (or a role above it, or one with MANAGE GRANTS). <code>COPY CURRENT GRANTS</code> keeps existing privileges; without it, Snowflake revokes them during the transfer and things break for readers. The bulk form fixes a whole schema at once, but check first that nothing in that schema is intentionally owned by another role, because ALL TABLES really means all. Then fix the cause: set users' DEFAULT_ROLE to something other than ACCOUNTADMIN.</p>"
    },
    {
      level: "Hard",
      title: "Effective privileges through the hierarchy",
      hint: "Recursive CTE over GRANTS_TO_ROLES where GRANTED_ON = 'ROLE' to expand the hierarchy, then join to object privileges.",
      prompt: "<p>Write a query that returns every effective SELECT privilege a functional role has on tables, including those it gets through nested roles, and the path of roles it came through.</p>",
      answer: `WITH RECURSIVE role_tree (role_name, path) AS (
  -- start with the role we care about
  SELECT 'FR_ANALYST'::STRING, 'FR_ANALYST'::STRING
  UNION ALL
  -- walk down: roles granted TO the current role
  SELECT g.NAME, rt.path || ' > ' || g.NAME
  FROM role_tree rt
  JOIN SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES g
    ON g.GRANTEE_NAME = rt.role_name
   AND g.GRANTED_ON   = 'ROLE'
   AND g.PRIVILEGE    = 'USAGE'
   AND g.DELETED_ON IS NULL
)
SELECT g.TABLE_CATALOG || '.' || g.TABLE_SCHEMA || '.' || g.NAME AS object_name,
       g.PRIVILEGE,
       rt.role_name AS granted_to_role,
       rt.path      AS via
FROM role_tree rt
JOIN SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES g
  ON g.GRANTEE_NAME = rt.role_name
 AND g.GRANTED_ON  IN ('TABLE', 'VIEW')
 AND g.PRIVILEGE   IN ('SELECT', 'OWNERSHIP')
 AND g.DELETED_ON IS NULL
ORDER BY object_name, via;`,
      why: "<p>In GRANTS_TO_ROLES, a role-to-role grant appears with GRANTED_ON = 'ROLE', NAME = the child role and GRANTEE_NAME = the parent, with privilege USAGE. Starting from FR_ANALYST and repeatedly following those edges finds every role it inherits. Joining the expanded set back to object grants gives effective table privileges, and the path shows exactly why access exists, which is the first question in any access review. Database roles appear with GRANTED_ON = 'DATABASE_ROLE' and would need a similar branch. Remember this view lags by up to 2 hours, and that future grants only become real grants when objects are created.</p>"
    },
    {
      level: "Hard",
      title: "Design RBAC for a new platform",
      prompt: "<p>Design roles for a platform with databases RAW, ANALYTICS and SANDBOX, and teams: data engineering (build everything in RAW and ANALYTICS), analysts (read ANALYTICS, build in SANDBOX), finance (read only the ANALYTICS.FINANCE schema), and a BI tool (read ANALYTICS). Write the role DDL and grants for the ANALYTICS read path using database roles, and explain the structure.</p>",
      answer: `-- Access roles as DATABASE ROLES inside each database
USE ROLE SYSADMIN;
CREATE DATABASE IF NOT EXISTS ANALYTICS;
CREATE SCHEMA IF NOT EXISTS ANALYTICS.CORE   WITH MANAGED ACCESS;
CREATE SCHEMA IF NOT EXISTS ANALYTICS.FINANCE WITH MANAGED ACCESS;

CREATE DATABASE ROLE IF NOT EXISTS ANALYTICS.READ_ALL;
CREATE DATABASE ROLE IF NOT EXISTS ANALYTICS.READ_FINANCE;
CREATE DATABASE ROLE IF NOT EXISTS ANALYTICS.WRITE_ALL;

GRANT USAGE ON DATABASE ANALYTICS TO DATABASE ROLE ANALYTICS.READ_FINANCE;
GRANT USAGE ON SCHEMA ANALYTICS.FINANCE TO DATABASE ROLE ANALYTICS.READ_FINANCE;
GRANT SELECT ON ALL TABLES IN SCHEMA ANALYTICS.FINANCE TO DATABASE ROLE ANALYTICS.READ_FINANCE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA ANALYTICS.FINANCE TO DATABASE ROLE ANALYTICS.READ_FINANCE;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA ANALYTICS.FINANCE TO DATABASE ROLE ANALYTICS.READ_FINANCE;

-- READ_ALL = READ_FINANCE + every other schema
GRANT DATABASE ROLE ANALYTICS.READ_FINANCE TO DATABASE ROLE ANALYTICS.READ_ALL;
GRANT USAGE ON SCHEMA ANALYTICS.CORE TO DATABASE ROLE ANALYTICS.READ_ALL;
GRANT SELECT ON FUTURE TABLES IN SCHEMA ANALYTICS.CORE TO DATABASE ROLE ANALYTICS.READ_ALL;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA ANALYTICS.CORE TO DATABASE ROLE ANALYTICS.READ_ALL;

GRANT DATABASE ROLE ANALYTICS.READ_ALL TO DATABASE ROLE ANALYTICS.WRITE_ALL;
GRANT CREATE TABLE, CREATE VIEW, CREATE DYNAMIC TABLE ON SCHEMA ANALYTICS.CORE TO DATABASE ROLE ANALYTICS.WRITE_ALL;

-- Functional (account) roles
USE ROLE USERADMIN;
CREATE ROLE IF NOT EXISTS FR_DATA_ENGINEER;
CREATE ROLE IF NOT EXISTS FR_ANALYST;
CREATE ROLE IF NOT EXISTS FR_FINANCE;
CREATE ROLE IF NOT EXISTS FR_BI_SERVICE;

USE ROLE SECURITYADMIN;
GRANT DATABASE ROLE ANALYTICS.WRITE_ALL    TO ROLE FR_DATA_ENGINEER;
GRANT DATABASE ROLE ANALYTICS.READ_ALL     TO ROLE FR_ANALYST;
GRANT DATABASE ROLE ANALYTICS.READ_ALL     TO ROLE FR_BI_SERVICE;
GRANT DATABASE ROLE ANALYTICS.READ_FINANCE TO ROLE FR_FINANCE;

GRANT ROLE FR_DATA_ENGINEER TO ROLE SYSADMIN;
GRANT ROLE FR_ANALYST       TO ROLE SYSADMIN;
GRANT ROLE FR_FINANCE       TO ROLE SYSADMIN;
GRANT ROLE FR_BI_SERVICE    TO ROLE SYSADMIN;`,
      why: "<p>Database roles act as access roles: they live in the database, are managed by its owner, and survive replication and cloning, which keeps environments consistent. They're layered (READ_FINANCE inside READ_ALL inside WRITE_ALL), so each privilege is granted once. Functional roles map to people and services and only ever receive database roles plus warehouse usage. Managed access on the schemas means a data engineer who owns a new table can't quietly grant it to someone else. The BI tool gets its own functional role even though it matches analysts today, because its access will diverge, and you'll want to audit it separately. Analysts' SANDBOX write access would follow the same pattern with a SANDBOX.WRITE_ALL database role. In real life, generate all of this from config with Terraform or a similar tool rather than typing it.</p>"
    }
  ]
});
