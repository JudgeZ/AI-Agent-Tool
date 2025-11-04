# Secrets Directory

This folder stores local secret material that is mounted into the production
docker-compose stack. The compose definition expects the following files to
exist before the stack is started:

- `prod/orchestrator_postgres_url.txt`
- `prod/orchestrator_rabbitmq_url.txt`
- `prod/langfuse_secret_key.txt`
- `prod/local_secrets_passphrase.txt`
- `prod/postgres_password.txt`

Each file should contain a single line with the secret value (no trailing
whitespace). For example:

```
# prod/postgres_password.txt
change-me-please
```

The repository intentionally does **not** ship real secrets. Copy these files
from a secure location (or generate new credentials) before running the
production compose stack.

