# Model Routing

- **Policy**: choose the smallest/cheapest model that passes eval gates for the capability (plan, edit, test triage, etc.).
- **Overrides**: per-agent and per-task overrides allowed via agent profiles.
- **Caching**: prompt + retrieval cache keyed by model, prompt hash, context fingerprints.
