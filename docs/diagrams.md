# Diagrams

GitHub renders these Mermaid diagrams in place. [process.md](process.md) explains each step in prose, and [stages.md](stages.md) lists what the tool checks at each one.

## 1. From request to shipped and documented

```mermaid
flowchart TD
    request(["The user's request"]) --> intake["Intake: words recorded verbatim"]
    intake --> kind{"Kind of run"}
    kind -->|"feature"| note["Design note, about 400 lines, UI and UX section when there is UI"]
    kind -->|"fast, hotfix, follow-ups, docs"| spec["Short written spec"]
    note --> dreview["Design review, no commits, to consensus"]
    dreview --> decisions["Decision log: every unsettled choice, with what was rejected"]
    spec --> decisions
    decisions --> lanes["Lanes: one builder each, own workspace, own files"]
    lanes --> checks["Checks in order: typecheck, unit and build side by side, then integration, then e2e one file at a time"]
    checks --> mutation["Each new test fails with its fix removed"]
    mutation --> integrate["Integration: stack the lanes, resolve docs conflicts"]
    integrate --> scan["Pre-push scan of the range"]
    scan --> push["Push to a ci/* branch, never forced"]
    push --> ci["CI: wait until every job has finished"]
    ci --> creview["Code review rounds to consensus"]
    creview --> rebase["Rebase onto main: coverage kept where patch-ids match"]
    rebase -->|"a diff changed"| creview
    rebase --> deploy["Deploy: backup, health, load check, HTTP checks"]
    deploy --> notify["Notification: what shipped"]
    notify --> cleanup["Cleanup: branches, workspaces, databases, review folder"]
    cleanup --> play["Live play of the deployed build"]
    play -->|"bug fixes"| hotfix["Hotfix run"]
    hotfix --> lanes
    play -->|"needs owner"| decisions
    creview -->|"P3 findings"| backlog["Follow-up backlog"]
    play -->|"P3 and deferred"| backlog
    backlog -->|"batched into lanes with no shared file"| lanes
    cleanup --> docs["Guide pass with new screenshots, once a run of features has shipped"]
    docs --> done(["Shipped, played and documented"])
```

## 2. A stage's states

Every stage moves through the same states in the ledger. The GitHub status follows: `success` for passed or skipped, `failure` for failed, `pending` for anything in between.

```mermaid
stateDiagram-v2
    [*] --> none
    none --> inprogress: first record
    inprogress --> passed: every check holds, sign-offs in
    inprogress --> failed: a check refused
    failed --> inprogress: fixed and rerun
    passed --> stale: rebase gives new commit ids
    stale --> inprogress: rerun on the new commits
    passed --> [*]
    inprogress: in progress (noted, in-review, running, ready, blocked)
```

### Design

```mermaid
stateDiagram-v2
    [*] --> noted: note passes its checks
    [*] --> failed: too long, no UI and UX section, a section missing, an em dash
    failed --> noted: note fixed
    noted --> inreview: design review started
    inreview --> passed: reviewers reach consensus
    noted --> passed: the user skips the review
    passed --> failed: note edited after consensus
    failed --> passed: another round reaches consensus, rerun with --re-review
```

### Build lane

```mermaid
stateDiagram-v2
    [*] --> added: workspace, owned files, brief checked
    added --> committed: commits follow the rules and stay in the lane's files
    committed --> checked: every check passed, in order, on the lane's tip
    checked --> mutated: each code-and-test commit fails with its fix removed
    mutated --> reported: report file recorded
    reported --> passed: build sign-off recorded
    committed --> added: a commit broke a rule, fix and record again
    checked --> committed: new commits, checks run again
```

### CI

```mermaid
stateDiagram-v2
    [*] --> running: a run exists for the exact commit
    running --> running: the run says completed but a job still runs
    running --> passed: run and every job completed, all green
    running --> failed: a job failed
    passed --> stale: rebase
```

### Deploy

```mermaid
stateDiagram-v2
    [*] --> blocked: deploy check finds a gap
    blocked --> ready: review, CI on the exact commit, scan and docs all hold
    ready --> passed: recorded with backup, health, load and HTTP checks, notification sent
    ready --> failed: a check failed or the deploy failed, notification sent
    failed --> ready: fixed and checked again
```

## 3. The review round loop

```mermaid
flowchart TD
    start["Commit the work, run the checks, record exact results"] --> request["Round 1 request: the user's words, the choices to check, the verification, a matrix to sweep"]
    request --> review["Each reviewer reviews alone"]
    review --> confer["Confer: each reviewer agrees or disagrees with every other finding, with evidence"]
    confer --> verify["The owner verifies every finding against the code"]
    verify --> disposition{"Disposition"}
    disposition -->|"adopted"| fix["Fix as new commits, never folded into pushed ones"]
    disposition -->|"declined"| reason["Reason recorded"]
    disposition -->|"product question"| decide["The user decides, or the decision log in guess mode"]
    disposition -->|"P3"| backlog["Follow-up backlog, not another round"]
    fix --> recheck["Rerun the checks on the new tip"]
    decide --> fix
    reason --> next
    recheck --> next["Next round: one line per disposition, regressions in the fixes"]
    next --> agree{"Every reviewer says consensus on the same tip?"}
    agree -->|"no"| verify
    agree -->|"yes"| done["Record consensus: the review status turns green"]
```

## 4. Parallel lanes and their ownership

```mermaid
flowchart LR
    subgraph coordinator["Coordinator, main workspace"]
        plan["Split by files"]
        stack["Stack the lanes, resolve feature list and guide conflicts"]
    end
    subgraph laneA["Lane A: repo-taskA workspace"]
        a1["Owns server/rules/**"]
        a2["Commits and checks on its own ports and database"]
    end
    subgraph laneB["Lane B: repo-taskB workspace"]
        b1["Owns client/layout/**"]
        b2["Commits and checks on its own ports and database"]
    end
    subgraph laneC["Lane C: repo-taskC workspace"]
        c1["Owns docs/** and FEATURES.md, last commit only"]
    end
    plan --> laneA
    plan --> laneB
    plan --> laneC
    a2 --> stack
    b2 --> stack
    c1 --> stack
    stack --> full["Full e2e once on the stacked tip, or in CI"]
```

`pipeline lane` refuses a lane whose globs match a file another open lane owns. `pipeline commits` refuses a commit that touches another open lane's file, a new file included, unless the coordinator acknowledges it with `--outside`.

## 5. The hotfix fast lane

```mermaid
flowchart TD
    bug["Live play bug or production bug"] --> fixlane["Hotfix run: spec cites the bug IDs"]
    fixlane --> small["Small fix commits, each with a test that fails without it"]
    small --> checks["Checks: touched e2e files only"]
    checks --> scan["Scan"]
    scan --> live{"Is the hole live on the server?"}
    live -->|"yes"| local["Keep the branch off the public remote, check on this machine"]
    live -->|"no"| push["Push to ci/*, CI"]
    local --> light["Light review: two reviewers, medium effort"]
    push --> light
    light --> deploy["Deploy as its own batch, notify"]
```

## 6. The live play loop

```mermaid
flowchart TD
    deployed["A deploy passed"] --> setup["Workspace on the deployed commit, own ports, own database"]
    setup --> play["Play as a lead user and two or three others, phones and desktops"]
    play --> frames["Record what each client receives, check nothing private arrives"]
    frames --> found{"Bug found?"}
    found -->|"no"| report["Report: bug table, devices, checks"]
    found -->|"yes"| classify{"Does the fix change documented behavior?"}
    classify -->|"no"| fix["Fix commit with a test, ID LPn-AREA-k, severity P0 to P3"]
    classify -->|"yes"| owner["Needs owner: recommendation to the coordinator"]
    fix --> play
    owner --> play
    report --> decide["Coordinator decides each needs-owner item and logs it"]
    decide --> hotfix["Fixes go through review and deploy as a hotfix run"]
    hotfix --> shipped["pipeline live-play done: every fix shipped, every needs-owner decided"]
```

## 7. What the gate does with a push

```mermaid
flowchart TD
    cmd["jj git push --bookmark B, or git push origin B"] --> config{"Repository has pipeline.config.json?"}
    config -->|"no"| allow["Allowed"]
    config -->|"yes"| form{"Named bookmarks, no force flags, to origin?"}
    form -->|"no"| refuse["Refused, with the reason"]
    form -->|"yes"| trunk{"B is trunk?"}
    trunk -->|"yes"| deploygate["Deploy gate on the commit"]
    trunk -->|"no"| branch{"B matches push.branches?"}
    branch -->|"no"| refuse
    branch -->|"yes"| ancestor{"Remote B is an ancestor of the new tip?"}
    ancestor -->|"no"| newname["Refused: a force push. Use ci/x-2 and forget the old bookmark"]
    ancestor -->|"yes"| scanned{"Every new commit in a passed scan?"}
    scanned -->|"no"| refuse
    scanned -->|"yes"| hole{"Part of a run fixing a live hole, public remote?"}
    hole -->|"yes"| refuse
    hole -->|"no"| allow
    deploygate --> allow
```

## 8. A deploy, step by step

```mermaid
sequenceDiagram
    participant C as Coordinator
    participant P as pipeline
    participant G as GitHub
    participant S as Server
    participant U as User
    C->>P: deploy check --run R
    P->>P: review coverage by patch-id, CI on the exact commit, scan, docs rules
    P->>G: pipeline/deploy pending, ready
    P-->>C: allowed, with the deploy command
    alt the user runs production deploys
        C->>U: the command to run
        U->>S: deploy
    else the agent may deploy
        C->>S: deploy (the gate checks the commit first)
    end
    S-->>C: backup file, health, load check, HTTP codes
    C->>P: deploy record --shipped "..." --backup --health --load --http
    P->>U: notification: Deployed, what shipped
    P->>G: pipeline/deploy success
    C->>P: cleanup --run R
```
