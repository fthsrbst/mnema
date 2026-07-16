---
name: map-project
description: Build or refresh an evidence-backed Mnema project map for a new or existing repository. Use when starting work in a repo, onboarding another agent, documenting architecture/modules/components, recording project decisions and problem solutions, repairing a stale project map, or preparing project graph context and handoff documentation.
---

# Map a Project

Create a compact authority map that lets another agent orient itself without rediscovering the repository. Keep current state in the project map, durable atomic knowledge in memory, long-form material in RAG, and work chronology in session logs.

## 1. Resolve the canonical project

1. Call `project_list`; reuse the canonical name when the repo is already represented.
2. Call `project_get(name)` before changing an existing map. Treat list fields such as `modules`, `decisions`, and `next_steps` as full replacements.
3. Use one project map for one product/system even when it has several working-tree paths. Record private/public/OS paths in `paths`; do not create duplicate project maps for repository aliases.
4. Do not model people, professional profiles, machines, learning collections, clients, or environments as projects. Use `profile_get/profile_update`, machine tools, global memory, or the `learning` RAG namespace instead.

## 2. Gather evidence before writing

Inspect the current worktree and verify:

- repository remote, branch, dirty state, package manifests, lockfiles, and runtime requirements;
- `AGENTS.md`/`CLAUDE.md`, README, ADRs, operations docs, and deployment configuration;
- actual entry points, module boundaries, dependency direction, persistence/sync paths, and external services;
- commands by running the relevant help/build/test command where safe;
- current focus from live task/issue/runtime evidence, not from code shape alone.

For serious architecture work, call `prompt_get("senior-software-architect")` before mapping. State unknowns explicitly; never invent ownership, runtime proof, or completion status.

## 3. Write the project map

Call `project_update` with the fields that evidence supports:

- `summary`: one paragraph describing the product and its users.
- `status`: `active`, `paused`, `done`, or `idea` based on current evidence.
- `stack`: only technologies actually used.
- `repo` and `paths`: canonical remote plus known checkout/deployment aliases.
- `current_focus`: the single active outcome, not a history dump.
- `next_steps`: concrete, ordered, verifiable actions.
- `architecture`: 3–5 sentences covering layers, data flow, authority, and boundaries.
- `modules`: the complete module list. For each module provide `name`, repo-relative `path`, one-sentence `purpose`, `key_files`, and `depends_on` using other module names.
- `entry_points`: role to repo-relative file mappings.
- `commands`: named commands that were verified or are directly authoritative from manifests.
- `conventions`: non-obvious written invariants; omit generic coding advice.
- `data_model`: main entities/tables, ownership, lifecycle, and important relations.
- `notes`: risks, operational constraints, and unresolved gaps that do not fit elsewhere.

Preserve unchanged fields from the prior `project_get` response. Do not overwrite a rich map with a partial module list.

## 4. Partition durable project knowledge

- Add a lasting architecture/product decision with `project_add_decision` using `YYYY-MM: decision — reason; consequence`.
- Save one hard-won problem solution with `memory_save(type="howto", project=<canonical>)`: symptom, root cause, fix, and verification.
- Save an atomic durable decision/preference/fact with `memory_save`; keep it short enough to scan.
- Store architecture, runbooks, migration plans, security reviews, and troubleshooting guides with `rag_add` using the stable URI `<project>/<category>/<slug>` and an appropriate `kind`.
- Reuse the same URI to update a document. Do not create `v2`/`final` duplicates unless lifecycle history is intentional.
- Add typed memory edges with `memory_relation_add` only when evidence supports `supports`, `contradicts`, `supersedes`, `caused_by`, `derived_from`, or `applies_to`.

Use the project field consistently so Mnema's graph links the project to memories, documents, sessions, tags, and typed relations. Do not create decorative or guessed graph edges.

## 5. Verify the map as an agent handoff

1. Call `project_get` and confirm the returned map contains the intended full module list and current focus.
2. Call `graph_neighbors(kind="project", key=<canonical>)`; verify linked project evidence appears.
3. Search one decision and one solution through `memory_search` or `rag_search` using language a future agent would use.
4. Run `integrity_check` before strict-project migration or release work; resolve unknown project references and lifecycle conflicts.
5. End material work with `session_log`, then refresh `current_focus`, `next_steps`, and any changed code-map fields.

Do not claim the project is mapped merely because `project_update` succeeded. The map is usable only when a fresh agent can locate the right files, understand authority and dependencies, retrieve key decisions/solutions, and identify the next verified action.
