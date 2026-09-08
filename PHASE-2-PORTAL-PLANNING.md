# Soro Operations Platform — Phase 2 Planning

Last updated: September 1, 2026

## Product direction

- Build a native Soro application with three role-based experiences: Employee, VA, and eventually Client.
- Use one shared operational platform and database rather than three disconnected systems.
- Optimize every role for a self-explanatory interface, minimal clicks, clear next actions, and mobile accessibility where appropriate.
- Build the foundation around secure private data, least-privilege access, configurable workflows, and complete audit history.

## Native applicant intake

- Do not use Google Forms or Google Drive links for new applications.
- Use a native, autosaving, mobile-friendly Soro application.
- Store direct uploads privately and link them to the VA profile.
- Support phone and QR-assisted video upload, with a Loom link as a fallback.
- Retain date of birth for now, but make the field configurable so it can later be optional, hidden, or removed without redesigning the form.

## Employee roles and access

Initial staff roles:

- System Owner
- Delegated Administrator
- Sales
- Talent Operations

Access model:

- Each role receives sensible default permissions.
- Administrators may add employee-specific grants or restrictions.
- Each employee profile shows an easy-to-understand effective-access summary.
- All permission and record changes are audited.

First employee-management rollout (August 2026): the Admin Panel can assign Administrator, Talent Management, or Sales Associate. “Administrator” maps to the Delegated Administrator access above; the reserved System Owner account is not assignable from this screen. Employee-specific permission overrides remain deferred until the broader permissions workspace is implemented.

## Responsibility split

### Talent Operations

- Application review and vetting
- Screening coordination and scheduling logistics
- Onboarding
- Quality checks
- Ongoing VA support
- Permanent edit rights for VA profiles across every candidate and placement status
- Maintaining verified skills, structured experience, training, certificates, development, and support information

### Sales

- Client relationship ownership
- Matching and placement outcome ownership
- Attending the first client–VA interview
- Managing an assigned VA caseload
- Working by specialty tags and capacity

## Candidate ownership

Each candidate record has three separate ownership fields:

- Talent Review Owner
- Sales Owner
- Talent Support Owner

When Talent Operations manually marks a VA as Bench Ready, the VA enters a Sales-visible open claim queue. The working label for this queue is **Available VA Bench**.

Implementation status (September 1, 2026): live in production. The release adds the Available Talent navigation view, Sales self-claiming, Administrator and Talent Management assignment controls, stale-claim collision protection, organization-scoped audit history, and per-Sales capacity settings.

Sales employees may claim an available VA. Once claimed, the VA leaves the open queue and appears in that salesperson's caseload as the Sales Owner. The claim experience must:

- Enforce the salesperson's configurable caseload capacity.
- Support filtering and recommendations by specialty tags.
- Prevent conflicting simultaneous claims.
- Record every claim and reassignment in the activity log.
- Allow Talent Operations and Administrators to override or reassign ownership when necessary.

The system may recommend suitable available VAs or Sales owners using specialty and capacity, but assignments remain human-controlled initially. Full automation may be added later.

Initial Sales caseload default: 40 active claims per Sales employee. Administrators may configure an individual limit. The count includes Bench Ready, Shortlisted, Interviewing, and Client Review records, and capacity is released at Placement Confirmed, Onboarding, Active, or a terminal outcome. This remains subject to later refinement by support intensity.

## VA profile development and experience

- Model employment and placement experience as structured entries rather than free-form résumé text alone.
- Structured entries should include role, organization or client, dates, responsibilities, tools, relevant skills, evidence, source, and verification status where appropriate.
- The system may calculate elapsed placement tenure from confirmed start and end dates.
- Time in a placement must never automatically create or verify a new skill.
- New skills, proficiency changes, verified experience, training, and certificates require Talent Operations confirmation before influencing verified-profile information or matching.
- Talent-confirmed updates should feed candidate search and matching while retaining their source, verifier, date, and audit history.

## Protected VA Growth & Support

Create a protected area on the VA record for ongoing care and development. It may include:

- Benefits enrollment, eligibility, status, and history, including health-related benefits
- Education assistance
- Specialized support and family support
- Support requests and follow-up
- Development records
- Restricted internal notes

The standard health-benefit allowance begins automatically when a placement becomes Active. The benefit record should preserve its effective date, status, allowance configuration, relevant vendor or plan reference, and history.

### Future flexible benefit credits

Plan for a configurable benefit-credit program in which active VAs may earn credits through tenure or service tiers. Final earning rules, tier thresholds, caps, budgets, expiration rules, and eligible uses remain to be defined.

Potential approved uses include:

- Education assistance
- Family or plus-one health support
- Counseling or therapy support
- Other approved growth and support needs

Implement this as an auditable **Benefit Credit Ledger** that separately records:

- Credits earned
- Current available balance
- Requests submitted
- Approval or denial and authorized approver
- Amount allocated or spent
- Expiration, reversal, or adjustment where applicable

All monetary values, eligibility rules, approval limits, program categories, and budgets must be configurable. The platform must not make opaque automated benefit judgments; rules and decisions should be understandable, reviewable, and attributable to an authorized person or clearly defined policy.

This area is strictly separated from Sales access by default. Sales must never see health, counseling or therapy, family circumstances, detailed assistance requests, or related administration records through general VA-profile permissions, search, matching, exports, reports, or activity feeds. Only narrowly authorized Talent Operations, Administrators, the System Owner, and other future support roles may access the minimum information necessary to administer the relevant program.

Soro should not store health diagnoses, counseling or therapy session notes, or provider clinical records. Those records remain with the outside vendor or provider. Soro stores only the minimum program-administration information required for eligibility, authorization, payment, status, and follow-up.

The VA portal should eventually provide self-service visibility into the VA's own selected benefits, eligible support, requests, and progress, without exposing restricted internal notes or staff-only deliberations.

All access and changes to Growth & Support information require enhanced audit logging and must follow the eventual retention, consent, and privacy rules.

## Dreams & Growth Pathway

The Dream Pathway begins when a VA enters an Active client placement, not while the VA is on the Available VA Bench. Every active VA receives a quarterly Growth & Support review. Dreams, needs, goals, and circumstances may change; each review should preserve the current discussion, progress, and a specific next step.

### Coordinated check-in cadence

Do not create a separate quarterly meeting when the review can be incorporated into an existing VA check-in. Use one coordinated check-in cadence for each active VA:

- The regular meeting cadence may be weekly or another configurable interval based on the VA, placement, or program.
- The quarterly Dream Pathway and Benefits review becomes an agenda section of the nearest appropriate regular check-in.
- Approximately two weeks before the quarterly due date, notify the assigned Talent Operations owner and the VA.
- Surface preparation prompts and the quarterly agenda in the normal upcoming-meeting workflow.
- Record one combined meeting outcome with clearly separated ordinary check-in results, quarterly review results, owners, due dates, and next actions.
- If a separate confidential conversation is required, link it to the cadence without copying sensitive details into the broad meeting record.

The VA profile should prominently show:

- Configured meeting cadence
- Next scheduled touchpoint
- Next quarterly-review due date
- Quarterly-review completion history
- Current preparation requirements and next actions

Each active VA has a person-centered growth pathway containing:

- Their recorded dream or long-term goal
- Milestones and practical action steps
- Eligible support programs and benefits
- Quarterly check-in templates, dates, owners, outcomes, and reminders
- Progress status and a clear visual pathway
- A next action recorded at every quarterly review

The VA portal should show the VA their own dream or goals, approved benefits and support, benefit-credit activity and balance, quarterly review information, completed and upcoming steps, progress, and next actions. Authorized Talent Operations users maintain the pathway during active placement and preserve its history afterward. Sales access is excluded unless a future field is deliberately classified as safe and relevant for matching.

Sensitive health, counseling, family, or assistance matters must use restricted notes or an alternate confidential workflow. They must not be included in broadly visible check-in notes, summaries, agendas, notifications, or activity feeds.

## Candidate workflow

1. New Application
2. Needs Review
3. Needs More Info
4. Bench Ready / Available VA Bench
5. Claimed / Assigned Sales Caseload
6. Shortlisted
7. Client Review
8. Interviewing
9. Placement Confirmed / Talent Handoff
10. Onboarding
11. Active

Additional outcomes:

- Unavailable
- Declined
- Archived

Stage history must retain the previous stage, new stage, actor, date, reason, and relevant notes.

## Client creation through active placement

Implementation status (September 7, 2026): the connected Client workflow was deployed in release `3b6758d`, including migrations 036–039. The Sales lifecycle tracker below is approved for production release; migration 040 has been applied and its read-only execution and service-only access verified against the production database.

Use one Client record and one hiring-request identifier from intake through placement so employees never have to reselect or re-enter the Client and role at each step:

1. Sales creates the company, primary contact, assigned Sales owner, optional Client Portal invitation, and first hiring request in one guided submission.
2. The Client Hub shows the company, contact, portal-access state, hiring requests, activity, and the next operational action.
3. Sales opens the same request in Available Talent, claims or selects candidates, builds the shortlist, and sends client-safe profiles for review.
4. A Client Administrator records candidate responses and the final selection. A Client Reviewer may review the same safe material but cannot make the final decision.
5. Sales schedules requested interviews through the shared Microsoft 365 interview calendar, records outcomes, and prepares the selected candidate's placement terms.
6. Administrators or Talent Management confirm the placement, complete the required onboarding checklist, and activate the placement on or after the start date.

Sales tracker approved release (September 7, 2026): retain the original lifecycle demo unchanged and local. The Sales dashboard now has a compact implementation showing each owned hiring request's stage, candidate/interview progress, Sales owner, responsible team, last activity, target start, recorded attention flag, and one next-action button. Stage counts, search, stage and attention filters, and Sales Management owner filtering reuse the existing Client Hub, shortlist, interview, placement, and onboarding workflows. No new forms or mutation permissions are introduced.

The tracker reads one service-only aggregate RPC through an authenticated Netlify endpoint. Sales is restricted to owned Clients; Administrators and Sales Management use organization-wide scope. Billing-only Client access does not count as candidate-review access. Interview-outcome reminders use recorded interview end times, and passed target-start dates use the Central Time calendar date. No inactivity deadline is invented. Production verification of migration 040 confirmed successful execution and denied direct anonymous/authenticated RPC access while allowing service-role access. The private review page `work/sales-lifecycle-tracker-approval/index.html` uses labeled sample data and no live writes, and is excluded from deployment.

Access boundaries:

- Sales can create and update only Clients assigned to that Sales account. Sales cannot search or open another salesperson's Client record.
- Sales Management and Administrators retain organization-wide Client access and ownership controls.
- Talent Management can view Client profiles but cannot edit Client business/contact records. Talent Management can confirm prepared placements and manage onboarding.
- Client Portal views exclude Talent contact information, source documents, internal notes, internal rates, calendar-sync failures, and internal handoff details.
- Client Billing does not receive candidate-review or placement-decision access.
- Placement confirmation is atomic: capacity, Client, hiring request, shortlist, Talent stage, placement, and onboarding records either advance together or do not advance.
- Soro records interview changes before attempting Microsoft 365 synchronization. Failed calendar delivery remains visibly retryable to authorized employees and never rolls back the durable Soro workflow.

## Mandatory activity history

Employee, VA, client, and placement records must include a chronological activity log. Relevant actions must record:

- Actor or responsible system process
- Timestamp
- Previous and new field or status values
- Ownership claims, assignments, overrides, and reassignments
- Notes and note visibility
- Permission and access changes
- File uploads, downloads, replacements, removals, and access events where appropriate
- Relevant automated and integration actions

Activity history should be readable by authorized staff, tamper-resistant, searchable, and retained according to the eventual data-retention policy.

## Dashboards and operations

- Provide role-specific dashboards rather than one generic dashboard.
- Lead with items requiring attention, overdue work, next actions, and ownership.
- Favor one-click or minimal-click progression for frequent operations.
- Add Sales goals and structured scorecards.
- Preserve reports in a dated archive so performance can be compared across time periods.
- Include a Campaign & Source Manager with active/inactive status; inactive sources remain attached to historical applicants and reporting.

## Next rollout — Secure access and Talent File experience

Status: Live as of August 21, 2026. The server-only database permissions were applied successfully, Netlify published the rollout, the unauthenticated employee-portal gate was verified, and the production Talent File assets and protected deletion endpoint were confirmed available.

Initial visual-direction reference: `planning/talent-file-concept-v1.png`. The implemented tab set expands the original two-tab concept as documented below.

### Portal access hardening

- Preserve the convenient remembered-session behavior on a user's own browser.
- Replace the brief sign-in-screen flash with a neutral **Checking secure access…** state while the existing session is validated.
- Do not reveal the application shell until Supabase confirms both a valid authenticated user and an active `platform_users` record with an authorized Soro role.
- If the session is valid but the Soro access record is missing, inactive, or unauthorized, sign the user out and show a clear **This account does not have access to Soro Ops** message.
- Keep database Row Level Security as the authoritative data boundary; the stricter screen gate is an additional defense and a clearer user experience.
- Verify the flow in a remembered authorized session, a signed-out browser, an inactive employee account, and an authenticated account without a Soro role.

### Admin-only permanent deletion

- Keep **Archive** as the normal, reversible action for Talent and client records.
- Add **Permanently delete** as an Administrator-only destructive action. Talent Operations and Sales may archive records when otherwise permitted, but they may not permanently delete them.
- Place permanent deletion in a clearly separated danger area rather than beside routine edit actions.
- Before deletion, show the record name and counts of connected files, contacts, applications, tasks, placements, and other dependent records that will be affected.
- Offer **Archive instead** prominently in the warning so an Administrator can choose the safer reversible action.
- Require two deliberate checks:
  1. A recent authenticated Administrator session; request reauthentication when the security window has expired.
  2. Entry of the exact Talent or client name, followed by a clearly labeled **Permanently delete** confirmation.
- The confirmation must state that deletion cannot be undone and that associated private files may also be removed.
- Block permanent deletion when an active placement, unresolved payment or invoice, legal/retention hold, or another protected dependency requires the record to remain. Explain the blocking item and keep Archive available.
- Execute eligible deletion through an Administrator-authorized server-side operation, not a direct browser cascade. Remove dependent database records and private storage objects as one controlled workflow, and report partial failures without claiming success.
- Retain only a minimal non-PII deletion event where policy permits: actor, timestamp, record type, internal reference, reason, and deletion result. Final retention requirements remain subject to Soro's legal and privacy decisions.

Suggested first warning copy:

> **Delete this profile permanently?**
> Archiving keeps this record available for recovery. Permanent deletion removes the profile and eligible connected files and cannot be undone.

Suggested actions: **Archive instead**, **Cancel**, and **Continue to permanent deletion**.

### Talent File visual treatment

- Keep the existing Profile Details area in its current home-page location and preserve the current summary-card structure.
- Treat the profile header and content area as one restrained digital Manila personnel folder using warm ivory/kraft tones, light paper depth, Soro navy outlines, and small orange accents.
- Use this folder-tab order:
  1. **Profile** — the default home sheet containing the existing profile details, screening results, skills, and experience.
  2. **Benefits** — the protected Growth & Support area, benefit enrollment, eligibility, requests, credit-ledger activity, and approved support records.
  3. **Attendance** — scheduled work, Start Day activity, check-outs, recorded workdays, and attendance exceptions.
  4. **Client** — shown only after a Talent has a client placement; contains the current or most recent client assignment, placement schedule, appropriately permissioned pay information, client notes, and placement tasks.
  5. **Documents** — always the last tab; contains private application files, résumé, assessments, equipment and internet proofs, interviews, agreements, and later uploads.
- Selecting a tab should change the file content in place while keeping the Talent identity header visible and providing a clear one-click return to the home profile.
- Enforce Benefits access separately from general profile access. It is available only to the System Owner, Administrators, Talent Operations, and specifically authorized support roles. It remains hidden from Sales by default.
- Present the headshot as a polished Polaroid-style card with a restrained one-to-two-degree rotation, a single silver paperclip, a subtle paper shadow, and the current upload/replace action attached to the photo area.
- Keep the paper metaphor elegant and functional: no torn edges, tape, handwriting, scrapbook decoration, or unnecessary animation.
- On mobile, straighten and reduce the Polaroid, keep both tabs keyboard-accessible and horizontally usable, and prevent the folder treatment from hiding actions or private-access labels.

### Rollout acceptance checks

- An unrelated visitor always receives the sign-in experience and cannot see the application shell or protected data.
- A remembered authorized session opens without an unnecessary sign-in prompt.
- An authenticated but unauthorized account is denied before the application shell is shown.
- Only an Administrator can reach permanent deletion, and the action cannot complete without both security checks.
- Archive remains available and reversible for eligible users.
- A blocked deletion explains the protected dependency and removes no records or files.
- All available tabs open within the Talent File without moving the Profile Details area on the Profile sheet.
- Client appears only when at least one placement is connected to the Talent, and Documents remains the final tab in every state.
- Benefits never appears to a Sales user and cannot be fetched through a direct client query.
- The Talent File remains readable, keyboard-accessible, and usable on desktop and mobile.

## Payroll & payouts — first preparation build

The Admin Panel uses one **Payroll & Payouts** section with two deliberately separate lanes:

- **Employee Payroll** prepares a Wise-ready staff batch for Soro's Philippines-based internal contractors, separately from placed Talent. Administrators create a period, enter optional manual amounts and notes, review exceptions, approve the locked snapshot, export it, and record the external provider reference after reconciliation. Soro does not calculate withholding. U.S. employees are excluded from this lane because taxes, withholding, deductions, and net pay are completed in QuickBooks.
- **Talent Payouts** prepares placement-based payment batches for Philippines-based contract Talent. Current placement records establish the eligible population, but payout amounts remain manual. Talent Management may verify recipient details and record review notes; only an Administrator may approve the locked batch, export the preparation file, or record the Wise release reference. Soro does not withhold taxes in this lane.

The two lanes produce two separate Wise batches: one for internal Philippines-based Soro staff and another for placed Philippines-based Talent. They have separate tables, permissions, states, exports, and histories. Shared financial-operation controls provide server-calculated totals, organization scoping, replay protection, immutable approved snapshots, and auditable actions. Editing an included Talent's amount, recipient email, or inclusion state invalidates any prior verification.

Each employee profile stores an explicit payment route: **Philippines contractor — Wise**, **U.S. employee — QuickBooks**, or **Needs setup**. Existing Philippines and U.S. records receive a one-time country-based initialization during migration; any other existing record remains **Needs setup**. Future employee records default to **Needs setup** until an Administrator deliberately selects a route. Wise-routed staff also require a valid payout-recipient email. Payroll creation never dynamically infers or changes the route from an address after that initial migration.

This first build never sends money and does not use attendance or time-off records to calculate compensation. Soro's operating rule is that Philippines-based Talent use the contractor payout lane, while any U.S. worker requiring payroll withholding is configured as an employee in QuickBooks. The platform does not infer legal worker classification from country alone. The exact QuickBooks import format, Wise account-template mapping, employee cadence and gross-pay source, contractor agreements and classification compliance, currency and exchange-rate rules, approval separation, correction handling, and retention policy remain explicit validation items before production activation.

## Guiding interaction rule

Continue planning one consequential decision at a time. After tangents, return to the unresolved decision sequence rather than restarting or losing earlier conclusions.

## Important unresolved decisions

### Support follow-up view — approved build September 8, 2026

Add an internal Needs Attention view alongside All tickets in Help & Support. Show unresolved unassigned tickets and open/in-progress tickets awaiting a public Soro reply, oldest waiting first, with reason, elapsed waiting time, team and owner. Admin/Founder oversees every authorized team; teams retain their existing scope and assignment controls. Staff members' own tickets in another queue remain requester-only, not part of their staff attention view.

Only public Soro replies answer a requester. Private notes, reads and reassignment do not reset the response clock; repeated requester messages retain the first unanswered time. Waiting-on-client tickets can still need an owner but are not awaiting Soro. No response deadlines, business-hours promises, timed escalation or new automatic emails are approved in this step. Payroll remains paused. The user approved this addition for production deployment on September 8, 2026.

### Client launch preparation — September 7, 2026

The marketing-meeting preparation is the current priority; payroll remains paused. The current user decision is one active Client matching/interview/placement process per Talent at a time. The historical multiple-Client question below is not permission to broaden that restriction.

Approved for production release on September 7, 2026:

- A company-scoped Client Dashboard replaces static overview placeholders with pending reviews/decisions, shared hiring requests, upcoming/ongoing interviews, and current assigned Talent. It reuses the existing request, interview/placement, Talent Profile, Account Settings and Help routes.
- Client Billing receives account/contact access only; Client Reviewers cannot make final candidate decisions. Internal discovery requests, rates, private applicant details, private files, and calendar diagnostics remain excluded.
- Client Administrators can pass directly from initial Candidate Review with an explicit inline confirmation. Migration 042 retains the existing final-decision transaction, optimistic timestamps, calendar cancellation restrictions, append-only audit and one-active-process constraints. Selecting an unresponded candidate remains prohibited.
- Migrations 041/042 were applied successfully before releasing the new assets. Production function checksums match the reviewed source, with execution restricted to the existing service role. All 675 local tests passed; live invitation and calendar rehearsal remain separate launch gates.

Remaining launch gates: verify a controlled real Client invitation, first password setup, fresh login, reset/resend and changed-email handling; verify Microsoft 365 create/reschedule/cancel and Teams joining using controlled recipients; confirm a reliable candidate-notification delivery process (the portal badge alone is not an email notification); rehearse Client isolation and the full selection-to-placement handoff. No test invitations, calendar events, credentials or Client records were created by this build or release preparation.

Private review: `work/client-dashboard-approval/index.html` on local port 4189. These fixture files must not be included in deployment.

1. Soro's legal and commercial relationship to placed VAs: employer/payor, managed staffing provider, recruitment/placement partner, or a hybrid.
2. Whether a VA may serve multiple clients simultaneously.
3. Client portal scope for the first release versus later phases.
4. Exact rating, matching, and post-placement health framework.
5. Authentication, database, file-storage, and hosting providers.
6. Data retention, privacy, and country-specific compliance rules.
