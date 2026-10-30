# ohol-stream

## Delegation

The main agent runs on an expensive model. Save it for planning, judgment, and review.

- Hand searches and codebase reading to the `explore` subagent. Ask it for conclusions with file paths, not file dumps.
- Hand well-specified implementation work to the `worker` subagent: name the files, the exact change, and how to verify it. Use `general` for open-ended multi-step tasks.
- Run independent subagent tasks in parallel.
- Do it yourself when it's a one-liner, when it needs taste or careful judgment, or when a subagent has failed at it twice.
- Review what a subagent changed (read the diff) before reporting it done.
