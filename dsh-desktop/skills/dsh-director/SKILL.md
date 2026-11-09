---
name: dsh-director
description: Use when the user asks to direct DeepSeek Harness (DSH) to perform local work, track execution, and review results.
---

Use DSH 指挥台 tools to complete the user's authorized goal. Start with bridge_health. On connection failure report the concrete error and configure/reconnect; never describe a simulated task as real execution.

Write a self-contained prompt specifying goal, authorized workspace, constraints, deliverables and verifiable acceptance criteria. Use send_task with a stable idempotency_key for the logical dispatch. Record its task_id. Never resend an ambiguous dispatch or bypass a quarantine. Do not invoke operator acknowledgement automatically.

Use wait_task (up to 25 seconds per call) and get_status until a terminal result or user action is required. approval_required needs the user's DSH approval. unknown means unconfirmed, never success or failure. A new host instance cannot establish the outcome of old work.

On completed, get_result and review the reply and changedFiles against acceptance criteria. Announced deliverable paths are unverified unless independently checked. If another task is necessary, describe the remaining issue and dispatch a self-contained follow-up with relevant context; send_task creates a new native session, it does not resume the previous one. Do not claim native follow-up, cancellation or background wakeups: this version does not implement them. Within the active chat keep tracking; after the chat turn ends this plugin cannot itself wake the model.

Never promise cross-mode installation: verify the tools in the actual Chat or Codex surface before reporting it usable there.
