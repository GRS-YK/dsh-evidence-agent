# Security

## Supported Versions

Security fixes are applied to the current `0.1.x` line.

## Secrets

- Never commit `.env`, `.credentials.yaml`, API keys, cookies, or DSH tokens.
- Evaluation generation requires a temporary local DSH token; pass it through
  `DSH_EVAL_TOKEN` and do not save it in reports or predictions.
- Source documents and API-returned secrets must not be copied into prompts or
  evaluation artifacts.

## Prompt Injection

Corpus documents are untrusted data. The runtime Skill explicitly prevents
document text from:

- changing the Agent's role;
- overriding system or user instructions;
- requesting secrets;
- triggering privileged commands or file operations.

## Reporting

Use GitHub private vulnerability reporting or contact the repository owner when
a report concerns:

- path traversal;
- secret disclosure;
- tool-output injection;
- citation forgery;
- an escape from the evidence-call budget.
