# Security policy

## Scope

AUDR is a specification, a JSON Schema, and the tooling that renders them. The
realistic security concerns are narrow, and worth stating precisely so reports
go to the right place.

**In scope for this repository:**

- A defect in `audr.schema.json` that causes a conformant validator to accept a
  record it must reject, or to crash. A malformed schema is a denial-of-service
  vector against every sink that loads it: a misplaced keyword can make a
  validator raise on a record rather than reject it cleanly.
- Guidance in the specification that leads implementers to store credentials or
  personal data in a record.
- A supply-chain issue in the build or CI tooling.

**Not in scope here:** vulnerabilities in a product that implements AUDR. Report
those to that product's vendor. If you believe the specification *caused* the
vulnerability, that is in scope and we want to hear it.

## Reporting

Report privately through
[GitHub's private vulnerability reporting](https://github.com/openaudr/audr/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

We will acknowledge within three business days and give an assessment within ten.
If we disagree that a report is a vulnerability we will say so and explain why,
and you are free to disclose.

## Data handling guidance for implementers

The specification is deliberately restrictive about what a record may carry.
These are not suggestions:

- **`resource.key_name` is a label, never key material.** No secret, no prefix,
  no hash, no substring. A record is a durable financial artifact that is copied,
  exported, and retained — a credential in one is a credential in every backup
  of it.
- **`attribution.user_id` is pseudonymous.** Never an email address, never a
  name. Rating uses `account_id`; `user_id` exists for attribution within an
  account, and a pseudonymous identifier does that job.
- **`attribution.labels` MUST NOT contain PII.** Labels are free-form, which
  makes them the most likely place for personal data to leak into a billing
  pipeline. Treat the constraint as load-bearing.
- **Records carry no prompt or completion content.** AUDR meters operations; it
  does not record what was said. There is no field for conversation content, and
  an `x_*` extension is not a licence to add one.
