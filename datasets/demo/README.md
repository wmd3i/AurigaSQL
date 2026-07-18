# AurigaSQL Demo Data

This directory contains the demo databases bundled with AurigaSQL. They are
checked into ordinary Git so a clean clone can run the Web demo and desktop
packaging flow without an extra data download step.

## Contents

- `manifest.json`: Product-facing list of demo data sources.
- `demo_questions.json`: Example questions shown in the AurigaSQL UI.
- `build-report.json`: Row-count and size summary produced when the demo set was
  built.
- `bird/databases/*.sqlite`: Six SQLite demo databases derived from BIRD.
- `bird_interact/databases/*.sqlite`: Six SQLite demo databases derived from
  BIRD-Interact Lite PostgreSQL data.
- `bird_interact/knowledge/*`: Public schema, knowledge, and column-meaning
  metadata used by the product agent.

## Sources And License

The BIRD demo databases are derived from the BIRD SQL development data published
by the BIRD team:

https://huggingface.co/datasets/birdsql/bird_sql_dev_20251106

The BIRD-Interact demo databases and public knowledge metadata are derived from
BIRD-Interact data published by the BIRD team:

https://huggingface.co/datasets/birdsql/bird-interact-full

Both dataset cards list the dataset license as CC BY-SA 4.0. The repository's
software license does not replace those dataset license terms. Keep this notice
with redistributed demo data, and preserve upstream attribution to the BIRD team.

## Transformations

The AurigaSQL demo package is a product subset, not a benchmark release. The
current demo set keeps selected databases and public knowledge metadata, converts
BIRD-Interact demo databases from PostgreSQL into SQLite for local product use,
and writes a product manifest plus example questions.

The bundled demo data is intended for UI, packaging, and product smoke testing.
It must not contain benchmark ground-truth SQL, executable test cases, secrets,
or real user connection information.
