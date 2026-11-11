# Snowflake Field Course

An interactive, self-paced Snowflake course that goes from your first query to staff data engineer topics. Every example runs against the `SNOWFLAKE_SAMPLE_DATA` database (mostly `TPCH_SF1`, with bigger scale factors for performance work), so you can follow along in any Snowflake account, including a free trial.

## What's inside

18 modules, 76 lessons, 122 quiz questions and 100 practice problems (easy, medium and hard). Every practice problem has a hint, a reveal-answer button with the SQL, and an explanation of why and how it works.

| Track | Modules |
| --- | --- |
| Foundations | Setup and the sample data, how Snowflake is built, SQL on TPC-H |
| Building in Snowflake | Database objects, loading and unloading, semi-structured data, Time Travel and cloning |
| Pipelines and CDC | Streams and CDC, tasks and alerts, dynamic tables |
| Performance and Operations | Warehouses and cost control, query tuning, the query profile, account monitoring |
| Security and Governance | Users, roles and access control, masking / row access / tags, administration |
| Staff Engineer | Platform design, CI/CD with clones, cost governance, data quality, Iceberg, Snowpark, capstone |

## Running it

It's a static site with no build step. Open `index.html` in a browser, or serve the folder:

```bash
cd snowflake-course
python3 -m http.server 8000
# then open http://localhost:8000
```

It also works on GitHub Pages: point Pages at this branch and the `snowflake-course` folder.

Progress (lessons read, quiz answers, solved problems) is saved in your browser's local storage.

## Before you start

Module 01 creates a small warehouse (`COURSE_WH`) and copies the TPC-H tables into a database you own (`COURSE_DB`), because the shared sample data is read-only. Later modules build on that sandbox. Some features need Enterprise edition (multi-cluster warehouses, masking and row access policies, search optimization, query acceleration, more than 1 day of Time Travel); those modules say so. Admin modules use `ACCOUNTADMIN`, so a trial account is the easiest place to run everything.

Drop `COURSE_DB`, `CAPSTONE`, `PRACTICE_DB`, `SALES_DB` and the course warehouses when you're done to stop storage and compute charges.

## Editing content

Each module is one file in `content/`. A module has `lessons` (HTML, with SQL inside `<sql>...</sql>` blocks), `quiz` items (`options` plus the index of the right `answer` and a `why`), and `practice` items (`level`, `prompt`, optional `hint`, `answer` SQL and `why`). Quiz options are shuffled on screen, so the right answer can sit at any index in the file.
