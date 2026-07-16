# ADR-002: Preserve original language; normalize non-destructively

Status: accepted
Date: 2026-07-14

## Context

Using only English may make some agent instructions more consistent, but automatic translation can lose technical names, user wording, legal nuance, and exact evidence. Token savings also depend on the model tokenizer and cannot be assumed.

## Decision

Original memory and document text remains the source of truth. Schemas, identifiers, relation types, tool contracts, and operational metadata use English. A future normalization pipeline may add an optional English canonical summary or search aliases, but must store language and normalizer provenance and must never overwrite original text.

## Consequences

- Turkish and other language evidence remains auditable.
- Cross-language retrieval can improve without destructive migration.
- Normalization adds storage and model cost and must be justified by evaluation.
