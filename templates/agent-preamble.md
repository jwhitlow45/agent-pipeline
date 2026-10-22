# Shared preamble for every agent

Every brief points here first. Replace the angle-bracket parts for your project, and keep this file outside the repository when it names local paths.

## Your task
You own one slice of the work, given in your brief. Other agents build other slices at the same time in their own workspaces, and the coordinator integrates everyone's commits afterwards.

## Hard rules
- Work only inside your workspace (given in your brief). Never edit the main repository or another agent's workspace.
- Edit only the files your brief says you own. You may read anything. If you must change a file you do not own, keep the change minimal and list it in your report.
- Do not add dependencies. If you need one, stop and say so in your report.
- Comments explain why, not what. Do not narrate obvious code.
- Never use em dashes anywhere: code, comments, UI strings, test names, commit messages. Avoid semicolons in prose. Plain American English.
- Never write a local path (a home folder, a temp folder, a machine name) into a committed file. Refer to screenshots by a relative folder name.
- Anything that can take noticeable time shows that it is loading, and every slow path ends in a result or a plain error.

## Checks
- Run independent checks in parallel: start `<typecheck>`, `<unit tests>` and `<build>` together, each writing its own log, then read every log in full. Integration tests and e2e share the database, so they run after, one after the other.
- Run only the e2e files your change touches, plus `<always-run files>`. Name them in your report. The integration step runs every e2e file on the stacked tip.
- When an e2e file fails, start diagnosing it at once while the rest run. Wait for the run to finish before rerunning anything, so you see every failure.
- Each new test must fail with its fix removed. Check it, and say how in your report.
- Code that juggles retries, cancels, timeouts and late answers gets one randomized test that runs many event sequences and checks the invariants that must always hold. Name the invariants in your report.
- Use only the ports and databases your brief gives you. Stop every process you started before you finish.

## Commits
- Commit with jj in your workspace: `jj commit -m "type(scope): description" <paths>`. Conventional, lowercase after the colon, one line, no body, no trailers. One commit per item or per coherent step.
- Put feature list and guide changes in your lane's last commit, never mixed into a code commit.
- Never push, never move bookmarks, never run git commands that write, never send notifications.

## Questions
When a real product choice is the owner's, do not stop to ask. Take the sensible default, say so in your report with the options you rejected, and keep working. The coordinator decides and logs it.

## Report
Write your full report to `<scratch folder>/reports/<task>.md`: commits (change ID and message), what you built mapped to the brief, the exact check commands with pass and fail counts, deviations with reasons, files outside your ownership, open questions. Then send the coordinator at most about ten lines: the change IDs, the check results in one line, anything blocking, questions, and the report's path.
