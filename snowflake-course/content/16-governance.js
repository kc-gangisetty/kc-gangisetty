window.COURSE = window.COURSE || [];
window.COURSE.push({
  id: "governance",
  num: "16",
  track: "Security and Governance",
  title: "Data masking, row access and tags",
  summary: "Protect TPC-H customer PII with dynamic masking, conditional masking, row access policies by region, object tags with tag-based masking, classification, projection and aggregation policies, and access history.",
  minutes: 70,
  level: "Advanced",
  edition: "Most policies need Enterprise",
  lessons: [
    {
      title: "Dynamic data masking",
      body: `
<p>A <b>masking policy</b> is a schema-level object that rewrites a column's value at query time based on who is asking. The data on disk doesn't change. The same <code>SELECT C_PHONE FROM CUSTOMER</code> returns the real phone to one role and <code>***-***-1234</code> to another.</p>
<sql>
USE ROLE SYSADMIN;
CREATE SCHEMA IF NOT EXISTS COURSE_DB.GOVERNANCE;
CREATE OR REPLACE TABLE COURSE_DB.GOVERNANCE.CUSTOMER AS SELECT * FROM COURSE_DB.TPCH.CUSTOMER;

USE ROLE USERADMIN;
CREATE ROLE IF NOT EXISTS PII_READER;
CREATE ROLE IF NOT EXISTS SUPPORT_AGENT;
USE ROLE SECURITYADMIN;
GRANT ROLE PII_READER TO ROLE SYSADMIN;
GRANT ROLE SUPPORT_AGENT TO ROLE SYSADMIN;

-- A dedicated governance role usually owns policies; SYSADMIN here for simplicity
USE ROLE SYSADMIN;
CREATE OR REPLACE MASKING POLICY COURSE_DB.GOVERNANCE.MASK_PHONE
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN IS_ROLE_IN_SESSION('PII_READER')    THEN val
    WHEN IS_ROLE_IN_SESSION('SUPPORT_AGENT') THEN REGEXP_REPLACE(val, '[0-9]', '*', 1, 0) || ' (' || RIGHT(val, 4) || ')'
    ELSE '***MASKED***'
  END;

ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER
  MODIFY COLUMN C_PHONE SET MASKING POLICY COURSE_DB.GOVERNANCE.MASK_PHONE;

SELECT C_CUSTKEY, C_NAME, C_PHONE FROM COURSE_DB.GOVERNANCE.CUSTOMER LIMIT 5;
</sql>
<p>Key details:</p>
<ul>
<li>The policy's input and return types must match the column type.</li>
<li><code>IS_ROLE_IN_SESSION('X')</code> is true if X is the current role, a secondary role, or inherited by either. That's almost always what you want. <code>CURRENT_ROLE() = 'X'</code> only checks the exact primary role and breaks when people use role hierarchies or secondary roles.</li>
<li>Masking applies everywhere the column is read: queries, views on top, clones, and shares. The table owner doesn't automatically see unmasked data. A policy doesn't care who owns the table, only what the policy says.</li>
<li>One column can have only one masking policy at a time.</li>
<li>Use <code>SHA2(val)</code> instead of a fixed string when people need to join or count distinct on masked values without seeing them.</li>
</ul>
`
    },
    {
      title: "Conditional masking and policy design",
      body: `
<p>A policy can take extra columns from the same row as arguments. That's <b>conditional masking</b>: mask a value depending on something else in the row.</p>
<sql>
-- Mask account balance unless the reader is PII_READER, or the customer is in a segment
-- that's been cleared for internal analytics
CREATE OR REPLACE MASKING POLICY COURSE_DB.GOVERNANCE.MASK_BALANCE
  AS (bal NUMBER(12,2), segment STRING) RETURNS NUMBER(12,2) ->
  CASE
    WHEN IS_ROLE_IN_SESSION('PII_READER') THEN bal
    WHEN segment IN ('AUTOMOBILE', 'MACHINERY') THEN bal
    ELSE NULL
  END;

ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER
  MODIFY COLUMN C_ACCTBAL SET MASKING POLICY COURSE_DB.GOVERNANCE.MASK_BALANCE
  USING (C_ACCTBAL, C_MKTSEGMENT);
</sql>
<p>Put the authorization logic in a mapping table instead of hard-coding role names, so changing who can see what is a data change, not a policy change:</p>
<sql>
CREATE OR REPLACE TABLE COURSE_DB.GOVERNANCE.PII_ENTITLEMENTS (role_name STRING, column_tag STRING);
INSERT INTO COURSE_DB.GOVERNANCE.PII_ENTITLEMENTS VALUES ('PII_READER', 'PHONE'), ('SUPPORT_AGENT', 'PHONE');

CREATE OR REPLACE MASKING POLICY COURSE_DB.GOVERNANCE.MASK_PHONE_V2
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN EXISTS (SELECT 1 FROM COURSE_DB.GOVERNANCE.PII_ENTITLEMENTS e
                 WHERE e.column_tag = 'PHONE' AND IS_ROLE_IN_SESSION(e.role_name)) THEN val
    ELSE '***MASKED***'
  END;
</sql>
<p>Lookups in a policy run for every query against the column, so keep mapping tables small. A memoizable function is an option if the lookup gets expensive.</p>
`
    },
    {
      title: "Row access policies",
      body: `
<p>Masking hides values. <b>Row access policies</b> hide whole rows. The policy returns TRUE for rows the current user may see. Let's give regional managers only their own region's customers:</p>
<sql>
CREATE OR REPLACE TABLE COURSE_DB.GOVERNANCE.REGION_ACCESS (role_name STRING, region_name STRING);
INSERT INTO COURSE_DB.GOVERNANCE.REGION_ACCESS VALUES
  ('MGR_EUROPE', 'EUROPE'), ('MGR_ASIA', 'ASIA'), ('MGR_AMERICA', 'AMERICA');

-- Add a region column so the policy has something to check
CREATE OR REPLACE TABLE COURSE_DB.GOVERNANCE.CUSTOMER_REGION AS
SELECT c.*, r.R_NAME AS region_name
FROM COURSE_DB.TPCH.CUSTOMER c
JOIN COURSE_DB.TPCH.NATION n ON n.N_NATIONKEY = c.C_NATIONKEY
JOIN COURSE_DB.TPCH.REGION r ON r.R_REGIONKEY = n.N_REGIONKEY;

CREATE OR REPLACE ROW ACCESS POLICY COURSE_DB.GOVERNANCE.RAP_BY_REGION
  AS (region STRING) RETURNS BOOLEAN ->
  IS_ROLE_IN_SESSION('PII_READER')                              -- sees everything
  OR EXISTS (
    SELECT 1 FROM COURSE_DB.GOVERNANCE.REGION_ACCESS a
    WHERE a.region_name = region
      AND IS_ROLE_IN_SESSION(a.role_name)
  );

ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER_REGION
  ADD ROW ACCESS POLICY COURSE_DB.GOVERNANCE.RAP_BY_REGION ON (region_name);
</sql>
<p>Row access policies are evaluated before masking policies. A table can have only one row access policy, but the policy can take several columns. If you need to change one, you must drop it from the table and add the new one, or use <code>ALTER ROW ACCESS POLICY ... SET BODY</code> to change its logic in place.</p>
<div class="note"><b>Testing tip</b>Use <code>EXECUTE USING POLICY_CONTEXT(CURRENT_ROLE => 'MGR_EUROPE') AS SELECT ...</code> to simulate what a role would see, without actually granting yourself that role.</div>
`
    },
    {
      title: "Tags, tag-based masking and classification",
      body: `
<p><b>Object tags</b> are key/value labels on almost anything: databases, schemas, tables, columns, warehouses, users, roles. They power cost attribution and governance at scale.</p>
<sql>
CREATE OR REPLACE TAG COURSE_DB.GOVERNANCE.PII ALLOWED_VALUES 'PHONE', 'ADDRESS', 'NAME', 'EMAIL';
CREATE OR REPLACE TAG COURSE_DB.GOVERNANCE.COST_CENTER;

ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER MODIFY COLUMN C_ADDRESS SET TAG COURSE_DB.GOVERNANCE.PII = 'ADDRESS';
ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER MODIFY COLUMN C_NAME    SET TAG COURSE_DB.GOVERNANCE.PII = 'NAME';
ALTER WAREHOUSE COURSE_WH SET TAG COURSE_DB.GOVERNANCE.COST_CENTER = 'learning';
</sql>
<p><b>Tag-based masking</b> attaches masking policies to a tag instead of to columns. Any column with that tag gets masked automatically, including columns added next year by someone who has never heard of your policy. That's how you scale masking across thousands of tables.</p>
<sql>
CREATE OR REPLACE MASKING POLICY COURSE_DB.GOVERNANCE.MASK_PII_STRING
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN IS_ROLE_IN_SESSION('PII_READER') THEN val
    WHEN SYSTEM$GET_TAG_ON_CURRENT_COLUMN('COURSE_DB.GOVERNANCE.PII') = 'NAME' THEN LEFT(val, 1) || '*****'
    ELSE '***MASKED***'
  END;

ALTER TAG COURSE_DB.GOVERNANCE.PII SET MASKING POLICY COURSE_DB.GOVERNANCE.MASK_PII_STRING;
</sql>
<p>A tag can have one masking policy per data type. A policy assigned directly to a column overrides the tag-based one. <code>SYSTEM$GET_TAG_ON_CURRENT_COLUMN</code> lets one policy behave differently depending on the tag value.</p>
<p><b>Sensitive data classification</b> scans columns and suggests or applies tags for things like names, emails and phone numbers:</p>
<sql>
CALL SYSTEM$CLASSIFY('COURSE_DB.GOVERNANCE.CUSTOMER', {'auto_tag': false});
SELECT SYSTEM$GET_CLASSIFICATION_RESULT('COURSE_DB.GOVERNANCE.CUSTOMER');
</sql>
<p>Newer accounts can schedule classification across whole databases with classification profiles, so new tables get scanned automatically.</p>
<p>Two more policy types worth knowing: <b>projection policies</b> stop a column from appearing in query output while still allowing it in WHERE and JOIN (for example, match on email without revealing it), and <b>aggregation policies</b> force queries to aggregate over groups of at least N rows, which helps with privacy-safe sharing.</p>
`
    },
    {
      title: "Auditing with access history",
      body: `
<p><code>SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY</code> (Enterprise) records, for each query, which objects and columns were read and written, including through views. It's how you answer "who looked at customer phone numbers last month?"</p>
<sql>
SELECT ah.QUERY_START_TIME,
       ah.USER_NAME,
       obj.value:"objectName"::STRING AS object_name,
       col.value:"columnName"::STRING AS column_name
FROM SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY ah,
     LATERAL FLATTEN(INPUT => ah.BASE_OBJECTS_ACCESSED) obj,
     LATERAL FLATTEN(INPUT => obj.value:"columns") col
WHERE obj.value:"objectName"::STRING = 'COURSE_DB.GOVERNANCE.CUSTOMER'
  AND col.value:"columnName"::STRING = 'C_PHONE'
  AND ah.QUERY_START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())
ORDER BY ah.QUERY_START_TIME DESC;
</sql>
<p><code>BASE_OBJECTS_ACCESSED</code> resolves views down to the underlying tables, so a read through a view still shows up against the real table. <code>OBJECTS_MODIFIED</code> covers writes and also gives column-level lineage for INSERT ... SELECT and similar statements. <code>POLICY_REFERENCES</code> shows where every policy is applied:</p>
<sql>
SELECT POLICY_NAME, POLICY_KIND, REF_ENTITY_NAME, REF_COLUMN_NAME, TAG_NAME
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.POLICY_REFERENCES(
       REF_ENTITY_NAME => 'COURSE_DB.GOVERNANCE.CUSTOMER', REF_ENTITY_DOMAIN => 'table'));
</sql>
`
    }
  ],
  quiz: [
    {
      q: "Why use <code>IS_ROLE_IN_SESSION('PII_READER')</code> instead of <code>CURRENT_ROLE() = 'PII_READER'</code> in a masking policy?",
      options: [
        "It's faster",
        "It also matches when PII_READER is inherited through the role hierarchy or active as a secondary role",
        "CURRENT_ROLE() isn't allowed in policies",
        "It ignores the role hierarchy"
      ],
      answer: 1,
      why: "<p>CURRENT_ROLE() only returns the exact primary role. A data engineer whose role inherits PII_READER, or who has it as a secondary role, would be masked by mistake. IS_ROLE_IN_SESSION respects inheritance.</p>"
    },
    {
      q: "The owner of a table with a masking policy runs SELECT. What do they see?",
      options: [
        "Always unmasked data, because owners bypass policies",
        "Whatever the policy body returns for their session's roles",
        "An error",
        "NULL for every column"
      ],
      answer: 1,
      why: "<p>Policies apply to everyone, including table owners and ACCOUNTADMIN, unless the policy body says otherwise. That's what makes them a real control instead of a convenience.</p>"
    },
    {
      q: "Which policy type removes rows a user isn't allowed to see?",
      options: ["Masking policy", "Row access policy", "Projection policy", "Network policy"],
      answer: 1,
      why: "<p>Row access policies return a boolean per row. Masking changes values, projection blocks a column from output, and network policies restrict where users connect from.</p>"
    },
    {
      q: "What's the main benefit of tag-based masking?",
      options: [
        "It's the only masking that works on VARIANT",
        "New columns are protected automatically when they get the tag, without attaching policies column by column",
        "It doesn't need Enterprise edition",
        "It makes queries faster"
      ],
      answer: 1,
      why: "<p>Attach the policy to the tag once. Any column tagged later, perhaps by automatic classification, inherits the masking. Column-by-column assignment doesn't scale to thousands of tables.</p>"
    },
    {
      q: "A column has a masking policy assigned directly and also has a tag with a masking policy. Which applies?",
      options: [
        "The tag-based policy",
        "The directly assigned policy",
        "Both, one after the other",
        "Neither; Snowflake raises an error"
      ],
      answer: 1,
      why: "<p>A direct assignment takes precedence over tag-based masking for that column. That lets you override the general rule in special cases.</p>"
    },
    {
      q: "You want analysts to join on customer email to match records, but never see the emails. Which feature fits best?",
      options: ["Row access policy", "Projection policy", "Aggregation policy", "Secure view"],
      answer: 1,
      why: "<p>A projection policy stops the column from being selected in output while still allowing it in joins and filters. A masking policy that returns a hash is the other common answer.</p>"
    },
    {
      q: "Which view tells you which columns of which tables a user read, even through views?",
      options: ["QUERY_HISTORY", "ACCESS_HISTORY", "LOGIN_HISTORY", "TABLE_STORAGE_METRICS"],
      answer: 1,
      why: "<p>ACCESS_HISTORY records direct and base objects accessed per query, down to the column. QUERY_HISTORY has the SQL text but not resolved column lineage.</p>"
    }
  ],
  practice: [
    {
      level: "Easy",
      title: "Mask customer addresses",
      prompt: "<p>Create a masking policy that shows <code>C_ADDRESS</code> in full to PII_READER and shows <code>'REDACTED'</code> to everyone else. Apply it to <code>COURSE_DB.GOVERNANCE.CUSTOMER</code> and test it with two roles.</p>",
      answer: `USE ROLE SYSADMIN;
CREATE OR REPLACE MASKING POLICY COURSE_DB.GOVERNANCE.MASK_ADDRESS
  AS (val STRING) RETURNS STRING ->
  CASE WHEN IS_ROLE_IN_SESSION('PII_READER') THEN val ELSE 'REDACTED' END;

ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER
  MODIFY COLUMN C_ADDRESS SET MASKING POLICY COURSE_DB.GOVERNANCE.MASK_ADDRESS;

-- SYSADMIN inherits PII_READER (we granted it above), so it sees real addresses
SELECT C_CUSTKEY, C_ADDRESS FROM COURSE_DB.GOVERNANCE.CUSTOMER LIMIT 3;

-- A role without PII_READER sees REDACTED
USE ROLE TPCH_VIEWER;
-- (grant it SELECT on COURSE_DB.GOVERNANCE.CUSTOMER first, plus USAGE on the schema)
SELECT C_CUSTKEY, C_ADDRESS FROM COURSE_DB.GOVERNANCE.CUSTOMER LIMIT 3;`,
      why: "<p>Because PII_READER was granted to SYSADMIN, IS_ROLE_IN_SESSION returns true for SYSADMIN, which is a nice demo of why the function respects hierarchy. If the column already carries a tag-based policy from the lesson, the direct assignment here overrides it. If you get an error that a policy is already attached, unset it first with <code>MODIFY COLUMN C_ADDRESS UNSET MASKING POLICY</code>.</p>"
    },
    {
      level: "Easy",
      title: "Where are my policies?",
      prompt: "<p>List every masking and row access policy applied to tables in <code>COURSE_DB.GOVERNANCE</code>, with the column each is on.</p>",
      answer: `SELECT POLICY_DB || '.' || POLICY_SCHEMA || '.' || POLICY_NAME AS policy,
       POLICY_KIND,
       REF_DATABASE_NAME || '.' || REF_SCHEMA_NAME || '.' || REF_ENTITY_NAME AS table_name,
       REF_COLUMN_NAME,
       TAG_NAME,
       POLICY_STATUS
FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES
WHERE REF_DATABASE_NAME = 'COURSE_DB'
  AND REF_SCHEMA_NAME = 'GOVERNANCE'
ORDER BY table_name, REF_COLUMN_NAME;`,
      why: "<p>The ACCOUNT_USAGE view covers the whole account (with some lag), while the INFORMATION_SCHEMA table function works per object in real time. TAG_NAME is filled when a policy applies through a tag. Run this before and after any governance change, and keep it as part of your audit evidence.</p>"
    },
    {
      level: "Medium",
      title: "Regional managers see their own rows",
      hint: "Create roles MGR_EUROPE and MGR_ASIA, give them SELECT, then test with EXECUTE USING POLICY_CONTEXT or by switching roles.",
      prompt: "<p>Using the row access policy from the lesson, create the manager roles, grant them read access, and show that each sees only their region's customer count while PII_READER sees all five regions.</p>",
      answer: `USE ROLE USERADMIN;
CREATE ROLE IF NOT EXISTS MGR_EUROPE;
CREATE ROLE IF NOT EXISTS MGR_ASIA;

USE ROLE SECURITYADMIN;
GRANT ROLE MGR_EUROPE TO ROLE SYSADMIN;
GRANT ROLE MGR_ASIA   TO ROLE SYSADMIN;
GRANT USAGE ON DATABASE COURSE_DB TO ROLE MGR_EUROPE;
GRANT USAGE ON DATABASE COURSE_DB TO ROLE MGR_ASIA;
GRANT USAGE ON SCHEMA COURSE_DB.GOVERNANCE TO ROLE MGR_EUROPE;
GRANT USAGE ON SCHEMA COURSE_DB.GOVERNANCE TO ROLE MGR_ASIA;
GRANT SELECT ON TABLE COURSE_DB.GOVERNANCE.CUSTOMER_REGION TO ROLE MGR_EUROPE;
GRANT SELECT ON TABLE COURSE_DB.GOVERNANCE.CUSTOMER_REGION TO ROLE MGR_ASIA;
GRANT USAGE ON WAREHOUSE COURSE_WH TO ROLE MGR_EUROPE;
GRANT USAGE ON WAREHOUSE COURSE_WH TO ROLE MGR_ASIA;

USE ROLE MGR_EUROPE;
USE SECONDARY ROLES NONE;   -- otherwise inherited/secondary roles could widen access
SELECT region_name, COUNT(*) FROM COURSE_DB.GOVERNANCE.CUSTOMER_REGION GROUP BY 1;

USE ROLE MGR_ASIA;
USE SECONDARY ROLES NONE;
SELECT region_name, COUNT(*) FROM COURSE_DB.GOVERNANCE.CUSTOMER_REGION GROUP BY 1;

USE ROLE SYSADMIN;   -- inherits PII_READER (and both manager roles)
SELECT region_name, COUNT(*) FROM COURSE_DB.GOVERNANCE.CUSTOMER_REGION GROUP BY 1;`,
      why: "<p>Each manager sees one row (about 30,000 customers each, since TPC-H spreads customers roughly evenly across 25 nations and 5 regions). SYSADMIN sees all five because it inherits PII_READER. Note the <code>USE SECONDARY ROLES NONE</code>: if your user has secondary roles set to ALL, IS_ROLE_IN_SESSION would see every role you hold and the test would prove nothing. Testing policies with exactly the roles real users will have is half the work of governance.</p>"
    },
    {
      level: "Medium",
      title: "Mask with a hash so joins still work",
      prompt: "<p>Analysts need to count distinct customers by phone and join two tables on phone, without seeing phone numbers. Write a policy that returns a salted SHA-256 hash for non-PII roles, and show a join still works on masked values.</p>",
      answer: `CREATE OR REPLACE MASKING POLICY COURSE_DB.GOVERNANCE.HASH_PHONE
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN IS_ROLE_IN_SESSION('PII_READER') THEN val
    ELSE SHA2(CONCAT('course-salt-2026:', val), 256)
  END;

CREATE OR REPLACE TABLE COURSE_DB.GOVERNANCE.SUPPLIER_CONTACTS AS
SELECT S_SUPPKEY, S_PHONE AS phone FROM COURSE_DB.TPCH.SUPPLIER;
CREATE OR REPLACE TABLE COURSE_DB.GOVERNANCE.CUSTOMER_CONTACTS AS
SELECT C_CUSTKEY, C_PHONE AS phone FROM COURSE_DB.TPCH.CUSTOMER;

ALTER TABLE COURSE_DB.GOVERNANCE.SUPPLIER_CONTACTS MODIFY COLUMN phone SET MASKING POLICY COURSE_DB.GOVERNANCE.HASH_PHONE;
ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER_CONTACTS MODIFY COLUMN phone SET MASKING POLICY COURSE_DB.GOVERNANCE.HASH_PHONE;

-- As a non-PII role: values are hashes, but the join still matches on equal values
SELECT COUNT(*) AS shared_phone_numbers
FROM COURSE_DB.GOVERNANCE.CUSTOMER_CONTACTS c
JOIN COURSE_DB.GOVERNANCE.SUPPLIER_CONTACTS s ON s.phone = c.phone;`,
      why: "<p>The same input always gives the same hash, so equality joins, GROUP BY and COUNT(DISTINCT) still work on masked values. The salt stops someone from building a lookup table of hashes for every possible phone number, which is easy for short values like phones. Keep the salt out of the policy text in real life (a secure UDF or a value only governance admins can read), because policy definitions are visible to their owners. In TPC-H, phone numbers are generated randomly, so expect few or no matches, but the join runs and proves the mechanism.</p>"
    },
    {
      level: "Hard",
      title: "Tag-driven masking for a whole schema",
      hint: "One policy per data type attached to the tag; tag columns via classification or a script; verify with POLICY_REFERENCES.",
      prompt: "<p>Set up governance so that any column tagged <code>PII</code> in COURSE_DB is masked for non-PII readers, with different behaviour by tag value: NAME shows the first letter, PHONE shows the last 4 digits, ADDRESS fully redacted, and numeric PII (tag value BALANCE) returns NULL. Tag the CUSTOMER and SUPPLIER columns in COURSE_DB.GOVERNANCE copies, and prove it works.</p>",
      answer: `USE ROLE SYSADMIN;
CREATE OR REPLACE TABLE COURSE_DB.GOVERNANCE.SUPPLIER AS SELECT * FROM COURSE_DB.TPCH.SUPPLIER;

CREATE OR REPLACE TAG COURSE_DB.GOVERNANCE.PII
  ALLOWED_VALUES 'NAME', 'PHONE', 'ADDRESS', 'BALANCE';

-- Clear direct policies from the lesson so the tag policies can take effect
ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER MODIFY COLUMN C_PHONE   UNSET MASKING POLICY;
ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER MODIFY COLUMN C_ADDRESS UNSET MASKING POLICY;
ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER MODIFY COLUMN C_ACCTBAL UNSET MASKING POLICY;

CREATE OR REPLACE MASKING POLICY COURSE_DB.GOVERNANCE.PII_STRING
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN IS_ROLE_IN_SESSION('PII_READER') THEN val
    WHEN SYSTEM$GET_TAG_ON_CURRENT_COLUMN('COURSE_DB.GOVERNANCE.PII') = 'NAME'  THEN LEFT(val, 1) || '****'
    WHEN SYSTEM$GET_TAG_ON_CURRENT_COLUMN('COURSE_DB.GOVERNANCE.PII') = 'PHONE' THEN '***-***-' || RIGHT(val, 4)
    ELSE 'REDACTED'
  END;

CREATE OR REPLACE MASKING POLICY COURSE_DB.GOVERNANCE.PII_NUMBER
  AS (val NUMBER(12,2)) RETURNS NUMBER(12,2) ->
  CASE WHEN IS_ROLE_IN_SESSION('PII_READER') THEN val ELSE NULL END;

ALTER TAG COURSE_DB.GOVERNANCE.PII SET
  MASKING POLICY COURSE_DB.GOVERNANCE.PII_STRING,
  MASKING POLICY COURSE_DB.GOVERNANCE.PII_NUMBER;

ALTER TABLE COURSE_DB.GOVERNANCE.CUSTOMER MODIFY
  COLUMN C_NAME    SET TAG COURSE_DB.GOVERNANCE.PII = 'NAME',
  COLUMN C_PHONE   SET TAG COURSE_DB.GOVERNANCE.PII = 'PHONE',
  COLUMN C_ADDRESS SET TAG COURSE_DB.GOVERNANCE.PII = 'ADDRESS',
  COLUMN C_ACCTBAL SET TAG COURSE_DB.GOVERNANCE.PII = 'BALANCE';
ALTER TABLE COURSE_DB.GOVERNANCE.SUPPLIER MODIFY
  COLUMN S_NAME    SET TAG COURSE_DB.GOVERNANCE.PII = 'NAME',
  COLUMN S_PHONE   SET TAG COURSE_DB.GOVERNANCE.PII = 'PHONE',
  COLUMN S_ADDRESS SET TAG COURSE_DB.GOVERNANCE.PII = 'ADDRESS',
  COLUMN S_ACCTBAL SET TAG COURSE_DB.GOVERNANCE.PII = 'BALANCE';

-- Prove it: simulate a non-PII role
EXECUTE USING POLICY_CONTEXT(CURRENT_ROLE => 'TPCH_VIEWER')
AS SELECT C_NAME, C_PHONE, C_ADDRESS, C_ACCTBAL FROM COURSE_DB.GOVERNANCE.CUSTOMER LIMIT 3;

-- And list where the tag policies now apply
SELECT POLICY_NAME, REF_ENTITY_NAME, REF_COLUMN_NAME, TAG_NAME, POLICY_STATUS
FROM TABLE(COURSE_DB.INFORMATION_SCHEMA.POLICY_REFERENCES(
  REF_ENTITY_NAME => 'COURSE_DB.GOVERNANCE.CUSTOMER', REF_ENTITY_DOMAIN => 'table'));`,
      why: "<p>A tag can hold one masking policy per data type, so a string policy and a number policy on the same tag cover text and numeric PII. Inside the string policy, SYSTEM$GET_TAG_ON_CURRENT_COLUMN reads the tag value of whatever column is being masked, so one policy handles names, phones and addresses differently. Direct policies win over tag policies, so the old ones from the lesson have to be unset first; POLICY_STATUS in POLICY_REFERENCES flags conflicts. From now on, protecting a new column is one ALTER ... SET TAG, which classification can even do for you. Note that the NUMBER policy's signature must match the column type exactly (NUMBER(12,2) here), or that column won't be covered; check the column types before you rely on it.</p>"
    },
    {
      level: "Hard",
      title: "Audit PII access",
      prompt: "<p>Write a report of the last 30 days showing, per user and role, how many queries touched any column tagged PII, which columns, and the most recent access, including access through views. Use TAG_REFERENCES and ACCESS_HISTORY.</p>",
      answer: `WITH pii_columns AS (
  SELECT OBJECT_DATABASE || '.' || OBJECT_SCHEMA || '.' || OBJECT_NAME AS object_name,
         COLUMN_NAME,
         TAG_VALUE
  FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES
  WHERE TAG_NAME = 'PII'
    AND DOMAIN = 'COLUMN'
    AND OBJECT_DELETED IS NULL
),
reads AS (
  SELECT ah.QUERY_ID,
         ah.USER_NAME,
         ah.QUERY_START_TIME,
         obj.value:"objectName"::STRING AS object_name,
         col.value:"columnName"::STRING AS column_name
  FROM SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY ah,
       LATERAL FLATTEN(INPUT => ah.BASE_OBJECTS_ACCESSED) obj,
       LATERAL FLATTEN(INPUT => obj.value:"columns", OUTER => TRUE) col
  WHERE ah.QUERY_START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())
)
SELECT r.USER_NAME,
       q.ROLE_NAME,
       COUNT(DISTINCT r.QUERY_ID)                                        AS queries,
       ARRAY_AGG(DISTINCT p.object_name || '.' || p.COLUMN_NAME)         AS pii_columns_read,
       MAX(r.QUERY_START_TIME)                                           AS last_access
FROM reads r
JOIN pii_columns p
  ON p.object_name = r.object_name AND p.COLUMN_NAME = r.column_name
JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q ON q.QUERY_ID = r.QUERY_ID
GROUP BY r.USER_NAME, q.ROLE_NAME
ORDER BY queries DESC;`,
      why: "<p>TAG_REFERENCES tells you which columns are PII. ACCESS_HISTORY's BASE_OBJECTS_ACCESSED resolves every query down to the base table columns it read, so access through views, CTEs and nested views still counts against the real columns. Joining to QUERY_HISTORY adds the role used. This reports reads of PII columns, not whether the user saw unmasked values: a masked read still shows up. To narrow to unmasked access, also join each user's roles to the roles your policies allow (or record policy outcomes another way). This is the evidence auditors ask for under HIPAA, GDPR and SOC 2, and running it monthly also catches service accounts reading PII they shouldn't need.</p>"
    }
  ]
});
