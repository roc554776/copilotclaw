# system instructions

All agents must follow these instructions.

## Intent-First Governance

This is the supreme principle of this project. All subsequent technical rules, patterns, and implementation details are subordinate to this governance. If any conflict arises, Intent always prevails.

Intent is the only non-derivable asset. While a Mechanism can be reconstructed, the Intent—the sovereign "Why"—is the sole judge of whether a change is progress or degradation. We prioritize Intent because its loss marks the irreversible end of purposeful evolution.

Intent (the logical foundation and intentional constraints behind design decisions) is the most perishable and valuable artifact in a codebase. When Intent is lost, future contributors — human or AI — cannot distinguish intentional constraints from accidental ones, and well-intentioned changes silently become degradations.

### Maintain the Intent → Contract → Mechanism hierarchy

Work flows in one direction: from Intent (user needs, business goals, and intentional design constraints given by the human) → Contract (the strict requirements and external boundaries to fulfill the Intent) → Mechanism (the internal design, architecture, and code implementation). Never let the details of a Mechanism silently alter the Contract or Intent. If a constraint in the Mechanism forces a change to the Contract, explicitly confirm with the human before proceeding.

### Recognize the fractal nature of the hierarchy

This hierarchy is recursive and applies at every level of abstraction. It is a universal structure for organizing thought and action: what is considered a Mechanism at a macro level acts as the Intent and Contract for the micro level below it. Regardless of the scale—from business strategy to a single line of code—the principle remains identical: lower-level implementation details must never silently dictate or alter the higher-level purpose.

### Reframing the Hierarchy (Mapping across Scopes)

To maintain clarity, recognize how these categories manifest across different scopes of the project. The "Intent" of one layer serves as the "North Star" for the layers beneath it.

| Scope | Intent (The "Why") | Contract (The "What") | Mechanism (The "How") |
| :--- | :--- | :--- | :--- |
| **Business & Product** | Raw user needs (e.g., "I want to register"), market goals, or problem statements. | Product requirements, user stories, and acceptance criteria. | Service design, platform choice, and high-level workflows. |
| **System & Architecture** | Architectural drivers, compliance needs, or scalability constraints. | API specifications, data schemas, and integration contracts. | Component boundaries, infrastructure, and technology stacks. |
| **Development & Code** | Design patterns, logic rationale, and handling of specific edge cases. | Interface definitions, function signatures, and type systems. | Algorithms, local variables, and actual code implementation. |

### Isolate Intent and prevent upstream contamination

Keep Intent as a distinct, standalone description — never let it blend into Mechanism-level details. Treat any pressure from the Mechanism to reshape the original purpose or constraints as a signal to stop and re-confirm with the human rather than silently accommodating.

### Build context from facts, not assumptions

Construct understanding from actual code, documentation, and investigation — not speculation. When facts are insufficient, investigate further or ask the human. Behave as a seasoned senior engineer: verify before deciding, and never proceed on uncertain premises.

### Record Intent when intentional constraints change

When a change introduces, modifies, or removes a design constraint or policy, explicitly document its Intent (the logical necessity and reasons behind the choice) in the relevant documentation. This includes adding new features or capabilities — if a feature embodies a new design decision or constraint, its Intent must be documented even if no existing documentation was modified. A change to the Mechanism alone is not complete if its Intent is absent from the corresponding documentation.

## Document-First Workflow

Always update documentation (raw-requirements, requirements, proposals) before making code changes. Code changes without preceding documentation updates are not acceptable.

### Raw Requirements のタイムスタンプ

raw requirements に新しいブロックを追加するときは、そのブロックにタイムスタンプ（ISO 8601 日付）を付与すること。理由: 衝突する要望が存在するときに、どの要望がより新しいのかを明確にするため。

形式例:
```markdown
<!-- 2026-03-26 -->
- 新しい要望の内容
```

## Codebase Reference

- `docs/CODEMAPS/` contains token-lean architecture maps. Read before exploring unfamiliar areas of the codebase. Update after every completed task that changes structure, routes, files, or dependencies.
- `CONTRIBUTING.md` contains development rules including testing constraints.

## Documentation

- Unless otherwise specified, create document files at `{{repo_root}}/tmp/scratchpad/{{subpath}}/*.md`. `{{subpath}}` is mandatory.
- Unless otherwise specified, use `{{repo_root}}/tmp/{{subpath}}/` for host-side temporary directories, not `/tmp` or similar. `{{subpath}}` is mandatory.
- Numbering such as Step 0:, Step 1:, Phase 1:, 1. is not allowed. (Numbering is not allowed regardless of whether it is Step or not.) Numbering chapters is also not allowed. Just Step: is fine, and no numbering is fine. Numbering makes subsequent editing cumbersome. Of course, sequential labels like A, B, C are also not allowed. Instead of giving numbers, give names. For example, for tasks, use Task: {{task-name}}.

### Specifications and Design Documents

Do not forget the following regarding specifications and design documents:
- Instead of writing code directly, describe interfaces and expected behaviors and properties.
- When expected behaviors and properties are too complex to express unambiguously in natural language, use flowcharts, pseudocode (as commonly found in academic papers), or mathematical expressions for precise representation.
- Write in a way that distinguishes the current state from tasks and problems to be solved in the future.
- When a task is completed or a problem to be solved has been resolved, do not append it as completed. Instead, update the various descriptions regarding the current state so that the latest state is described.

### Links to Git-excluded Files

Git-managed files must not contain references to Git-excluded paths (e.g., `tmp/`) that serve as links to those files. The rule's purpose is to prevent Git-tracked content from depending on untracked resources that would be unavailable later.

**Key exceptions and nuances:**
- Code or scripts that **create** temporary files in Git-excluded directories (e.g., writing to `tmp/`) may naturally reference those paths — such references must NOT be removed
- **Explanatory text** about Git-excluded directories (e.g., "`tmp/` is Git-excluded") naturally requires using the path string — this is permitted
- **Mechanical search-and-delete of Git-excluded path references is strictly prohibited** — context and meaning must always be considered before removing any reference
- The rule applies to **all** Git-excluded files and directories, not just `tmp/`

## Temporary Directory Conventions

Unless specifically instructed otherwise, follow the rules below for temporary directories.

- **Host execution** (any of the following — never use `/tmp`):
  - `{{repo_root}}/tmp/{{subpath}}`
- **Docker container execution**: Use `/tmp/{{subpath}}`
- `{{subpath}}` is mandatory.
- This applies to all temporary file usage, including shell command output destinations
- A common violation is using `/tmp` on the host as a shell stdout redirect target
