---
name: diagnose-memory-pressure
description: Diagnose macOS memory pressure by attributing resident memory to processes, detached development services, and tmux pane trees. Use when memory pressure is warning or critical, swap is high, the machine is slow, or agent fanout is blocked by resource safeguards.
---

# Diagnose memory pressure

## Quick start

Run the read-only report:

```sh
memory-pressure-report
```

Use `--top COUNT` to change the number of rows in ranked sections.

## Read the report

1. Start with the kernel pressure level: `1` is normal, `2` warning, and `4` critical.
2. Use **Largest processes** to spot individual outliers.
3. Use **Executable families** to find workloads split across many workers, tabs, or sessions.
4. Use **Detached Overmind service trees** to connect workers to a development service and working directory.
5. Use **Default tmux pane trees** to attribute descendants to an interactive session.

RSS is resident set size. It is more useful for current attribution than virtual memory size. Swap can stay high after an incident, so high swap alone does not prove that a process is still growing.

## Cleanup workflow

The report does not stop anything.

1. Confirm the exact parent service, working directory, age, and descendant RSS.
2. Check whether a live agent or human still owns the work. Use `agent-find` for topic or path searches when relevant.
3. Ask before stopping processes. Never infer permission from age alone.
4. Use the project's normal parent-service shutdown command. Do not kill individual workers while their supervisor is running.
5. Run `memory-pressure-report` again and verify the kernel pressure level rather than assuming RSS reclaimed enough headroom.

At warning pressure, reduce existing workloads before starting new fanout. At critical pressure, avoid adding work and prioritize identifying a runaway process.

## Limits

- Pressure and swap summaries are macOS-specific.
- Process aggregation is a point-in-time RSS snapshot, not a leak detector.
- Shared memory can make summed RSS overstate physical use, but the ranking remains useful for finding owners.
- The script reports detached Overmind sockets separately because they do not appear in the default tmux server.

Co-authored-by: AI Simoom Farrier (pi-0.84.3/openai/gpt-5.6-sol) @+simoom-farrier
