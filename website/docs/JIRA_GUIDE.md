# Running SyncSafe in Jira (Agile + Scrum)

Run the project in a **Scrum space** in Jira Cloud. The full backlog (5 epics and 20 user stories, 97 story
points) is ready to import from `jira/syncsafe-jira-import.csv`, so you can skip typing and go straight to
sprint planning. Jira's free plan covers up to 10 users, which is enough for a student team.

> **Words have changed in Jira.** Newer Jira Cloud screens say **space** instead of *project*,
> **work item** instead of *issue*, and **work type** instead of *issue type*. Older tutorials use the old words;
> they mean the same thing. Menu labels can also move slightly between Jira updates.

## How Scrum maps onto Jira

| Scrum concept | Where it lives in Jira |
| --- | --- |
| Product backlog | **Backlog** view of the space (everything not in a sprint) |
| Epic | Work type **Epic**; stories point to it through the **Parent** field |
| User story | Work type **Story** with description, acceptance criteria, story points |
| Sprint backlog | A sprint created in the Backlog view, with stories dragged into it |
| Sprint goal, dates | Set when you **Start sprint** |
| Task breakdown | **Subtasks** inside a story |
| Daily stand-up | The **Board** (To Do → In Progress → In Review → Done) |
| Bug | Work type **Bug**, linked to the story it breaks |
| Burndown chart, velocity | **Reports** (Sprint burndown, Velocity) |
| Sprint review / retrospective | **Complete sprint**, then the sprint report and a retro page |
| Definition of Done | A checklist in each story (or a shared page linked from the space) |

---

## Step 1 — Create the Jira site and Scrum space

1. Go to <https://www.atlassian.com/software/jira/free> and sign up with your university email.
2. Choose a site name (for example `syncsafe-team.atlassian.net`).
3. Create a space: **Create space** → template **Scrum** → name **SyncSafe**, key **SYNC**.
4. When asked for the space type, pick **company-managed** if you plan to import the CSV.
   (Atlassian has a known issue where CSV import does not link stories to epics in team-managed spaces;
   in that case you set each story's Parent by hand after importing, which takes about two minutes.)
5. Invite teammates: **Space settings → Access/People → Add people**. Agree who is Product Owner and
   Scrum Master and write it in the space summary.

## Step 2 — Import the backlog (fast path)

You need to be the site admin (whoever created the site is).

1. Download `jira/syncsafe-jira-import.csv` from the project folder.
2. Open **Settings (gear icon) → System → External system import → CSV**.
   If Jira shows a newer import screen, choose the option to switch to the old experience.
3. Choose the file, leave encoding UTF-8, **Next**.
4. Import into the existing space **SyncSafe (SYNC)**, **Next**.
5. Map the columns:

   | CSV column | Jira field |
   | --- | --- |
   | Work item ID | Work item ID (also shown as Issue ID) |
   | Work type | Work type (Issue type) |
   | Summary | Summary |
   | Description | Description |
   | Priority | Priority |
   | Labels | Labels |
   | Story Points | Story Points (or **Story point estimate** in team-managed spaces) |
   | Parent | Parent |

6. **Begin import**. You should get 25 work items: SYNC-1 to SYNC-5 are epics, SYNC-6 to SYNC-25 are stories.
7. Check one story: its Parent should show the right epic, and its label (for example `sprint-2`) tells
   you which sprint the proposal planned it for.

The epics are listed first in the file on purpose: Jira must create a parent before its children.

## Step 3 — Create a user story by hand (how to add more)

Use this whenever the team discovers new work (a new feature, a spike, technical debt).

1. Open **Backlog** → **+ Create** (or press **C**).
2. **Work type:** Story. **Summary:** short and specific, for example *"Show last sync time on the status pill"*.
3. **Description**, using this template:

   ```
   As a <type of user>,
   I want <goal>,
   so that <reason>.

   Acceptance criteria:
   - Given <context>, when <action>, then <result>
   - ...

   Notes / design:
   - ...
   ```

4. **Parent:** choose the epic (for example *Sync*).
5. **Story points:** use the Fibonacci scale 1, 2, 3, 5, 8, 13. Anything over 13 is too big; split it.
6. **Priority**, **Labels** (optional), **Assignee** (leave empty until sprint planning).
7. **Create**. The story lands at the bottom of the backlog; the Product Owner drags it to its priority position.

**Writing good stories (INVEST):** Independent, Negotiable, Valuable, Estimable, Small, Testable.
Example of a good acceptance criterion: *"Given 500 changes in the outbox, when the device reconnects, then
the outbox is empty within 5 seconds."* It is testable and has a number.

**Subtasks:** open a story → **Add subtask** (for example *"API endpoint"*, *"UI badge"*, *"Unit tests"*).
Developers move subtasks on the board; the story is Done when every subtask is Done and the Definition of Done holds.

## Step 4 — Estimate (backlog refinement)

1. In the Backlog, open each story near the top.
2. Discuss it as a team, then each person picks a number at the same time (planning poker; free apps exist,
   or just hold up fingers).
3. Agree on a number and type it into **Story points**.
4. Split stories bigger than 8–13 points into smaller ones.

## Step 5 — Plan and start a sprint

1. In the Backlog, click **Create sprint**. It appears as *SYNC Sprint 1*.
2. Drag stories from the backlog into it, top first, until the total story points match what the team can do
   in two weeks (the sprint header shows the total). For Sprint 0 use the stories labelled `sprint-0`.
3. Click **Start sprint**: set duration **2 weeks**, start date, and a **sprint goal**, for example
   *"A user can create and edit records offline and they survive a reload."*
4. Assign each story to a developer.

## Step 6 — Daily work on the board

1. Open **Board**. Columns: **To Do → In Progress → In Review → Done**. To add *In Review*:
   **Board settings (… menu) → Columns** (company-managed) or **… → Manage workflow/columns** (team-managed).
2. Drag a card to **In Progress** when you start it. Keep one or two cards per person in progress at a time.
3. **Link code to Jira:** put the work item key in branch names and commit messages, for example
   branch `SYNC-15-outbox-queue` and commit `SYNC-15 add outbox entry in same transaction`.
   With the free **GitHub for Jira** app installed, the story shows its commits and pull requests.
4. Move to **In Review** when the pull request is open; **Done** only when it meets the Definition of Done:

   - [ ] Code reviewed and merged through a pull request
   - [ ] Unit tests written and CI passing
   - [ ] Works with the network turned off, where the story involves data
   - [ ] Acceptance criteria verified by the Product Owner
   - [ ] Documentation and diagrams updated

5. **Stand-up:** with the board on screen, each person answers: what I finished, what I am doing next,
   what is blocking me. Mark blocked cards with a **Flag** (right-click → *Add flag*).

## Step 7 — Log bugs

1. **+ Create** → Work type **Bug**.
2. Summary: what is wrong, for example *"Conflict badge does not clear after resolving on another device"*.
3. Description: steps to reproduce, expected result, actual result, browser, screenshot.
4. **Link** it to the story (**Link work item → is caused by / relates to**), set Priority, and add it to the
   current sprint if it blocks the sprint goal; otherwise leave it in the backlog.
5. Record it in the defect log in `docs/TESTING.md` with the Jira key.

## Step 8 — Sprint review, retrospective and reports

1. **Sprint review:** demo the finished stories live (use the test cases in `docs/TESTING.md`).
2. **Complete sprint** (Backlog or Board, top right). Unfinished stories move to the backlog or the next sprint.
3. **Reports → Sprint burndown** (or *Burndown chart*): take a screenshot for the sprint report.
4. **Reports → Velocity**: completed points per sprint; use the average to plan the next sprint.
5. **Retrospective:** three questions: what went well, what did not, what we will change. Turn each
   "we will change" into a work item (Task) so it is actually done next sprint.

### Sprint report template (one per sprint)

| Item | Sprint N |
| --- | --- |
| Sprint goal | |
| Dates | |
| Committed points / completed points | |
| Stories completed (keys) | |
| Stories carried over (keys + reason) | |
| Demo highlights | |
| Burndown chart | (screenshot) |
| Bugs found / fixed | |
| Retrospective: went well | |
| Retrospective: to improve | |
| Action items for next sprint (keys) | |

## Planned sprints (from the proposal)

| Sprint | Weeks | Goal | Stories | Points |
| --- | --- | --- | --- | --- |
| 0 | 1–2 | Setup and requirements | US1, US2 | 5 |
| 1 | 3–4 | Online foundation | US3, US4, US5 | 13 |
| 2 | 5–6 | Offline storage | US6, US7, US8, US9 | 20 |
| 3 | 7–8 | Sync engine | US10, US11, US12, US13 | 24 |
| 4 | 9–10 | Conflict resolution | US14, US15, US16, US17 | 19 |
| 5 | 11–12 | Hardening and release | US18, US19, US20 | 16 |

## Version 2 backlog (sprints 6–9)

Your board already has the 5 epics and 20 stories of version 1. Version 2 adds **6 epics and 26 stories
(119 points)** in `jira/syncsafe-v2-backlog.csv`. Import it the same way as Step 2 — it only contains new
items, so nothing is duplicated.

1. Jira → your SyncSafe space → **⋯ → Import work items** (or *Settings → System → External system import → CSV*).
2. Choose `jira/syncsafe-v2-backlog.csv`, map the columns exactly as in Step 2
   (Work item ID, Work type, Summary, Description, Priority, Labels, Story Points, Parent).
3. After the import, filter the backlog by label `sprint-6` … `sprint-9` and drag each group into a new sprint.

| Sprint | Goal | Stories (row IDs in the CSV) |
| --- | --- | --- |
| 6 | Scale + secure sessions | 201 PostgreSQL, 202 WebSockets, 203 LISTEN/NOTIFY, 206 refresh tokens, 207 remote sign-out |
| 7 | Team roles + field data | 204 clean-up, 205 monitoring, 208 roles, 209 teams, 212 photos, 213 GPS + map, 216 assignment |
| 8 | Workflow + smart merge | 210 device encryption, 211 HTTPS, 214 custom fields, 215 voice, 217 notifications, 218 reports, 219 history, 221 rules, 222 CRDT notes |
| 9 | Delivery | 220 partial sync, 223 suggestions, 224 GitHub Actions, 225 signed APK, 226 languages |

**Link GitHub to Jira:** install the free **GitHub for Jira** app (Jira → Apps → Explore more apps), connect
your GitHub account, and select the `syncsafe` repository. Put the Jira key in branch names and commit messages
(`SS-214 custom form fields`) and the commits, pull requests and builds appear on the story (docs/GITHUB.md §6).

## Sources

- [Import data from a CSV file (Atlassian)](https://support.atlassian.com/jira-cloud-administration/docs/import-data-from-a-csv-file/)
- [Keep parent-child relationships during CSV import (Atlassian)](https://support.atlassian.com/jira/kb/keep-issue-parent-child-mapping-during-csv-import-to-jira-cloud/)
