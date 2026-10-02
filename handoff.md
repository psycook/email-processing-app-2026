# Gravity Bank Email Automation Studio - coding-agent handoff

Last updated: 2 October 2026.

## Start here

This is an existing, published Power Apps Code App, not a new scaffold.
Read this file, `README.md`, `package.json`, `power.config.json` and the files
relevant to the requested change before editing. Preserve existing behaviour
unless the user explicitly asks to change it. Stages 1-3 of process tracking
were approved for implementation; respect the remaining gates below. Stage 4
is not approved and must not be provisioned.

The published app is **v0.2.3**, deployed on 2 October 2026 with the simplified
six-node React Flow process view, execution-aware node chips, expandable full-screen map, compact case-category panel/dismissible note
and the earlier inbound email formatting fix. Stage 3 service activation is still not
complete: plug-in/API registration, producer policy, flow cutover and pilot proof
remain gated. GitHub remains at v0.1.6 (`8ce7531`); all later source changes are
uncommitted. Both From and Reply-To still use the selected Contact email.
`c2ef997` was v0.1.5 and the initial import `f0a1d05` was v0.1.4. Workflow updates
are owned by the user. Check Git status before assuming a later working tree
is published.

**v0.2.1** simplifies the process view after user feedback: the dashboard
and Process Studio diagram now show one readable React Flow business path
`Shared Mailbox -> Classifier -> Agent -> Case Management -> Outcome -> Email
Response`, with no swimlanes. The stage list and ledger details remain available
for evidence/drill-down. v0.2.1 was deployed with `npx power-apps push`.

**v0.2.2** adds execution-aware chips inside those six nodes. With a ledger
snapshot, nodes show execution counts and latest activity; Classifier/Agent also
show the selected route or handler. Configuration-only nodes explicitly say no
live executions are present. v0.2.2 was deployed with `npx power-apps push`.

**v0.2.3** adds an Expand map action to the process canvas. It opens the
same six-node React Flow map in an almost full-screen closeable modal with a dark
transparent blurred backdrop. v0.2.3 was deployed with `npx power-apps push`.

- Repository: https://github.com/psycook/email-processing-app-2026
- Original local folder:
  `C:\LocalDevelopment\PowerPlatform\CodeApps\email-process-visualisation`
- App: Gravity Bank Email Automation Studio
- Environment: `smc-diamond-service`
- Environment ID: `b17908ad-6b6b-eefb-98bc-79cc7e20ab08`
- App ID: `a9b487ae-7eee-4f6f-ba71-ed18e50c021c`
- Dataverse URL: https://smc-diamond-service.crm.dynamics.com/
- Dataverse solution/publisher: `RetailFinanceDemo` / `rfd`
- Launch URL: see `README.md`.

The repository contains demo tenant, app, environment and connection-reference
identifiers, but these are not authentication credentials. Never commit tokens,
private keys, local auth files, live record exports or captured mailbox content.
Repository access does not grant access to the Power Platform environment.

## Run and validate

Use Node.js 24 and npm. The Python rename helper tests use Python 3; they do not
require a live Dataverse connection.
The examples below use PowerShell. `test:studio` currently contains a Windows
path; on another OS invoke Node's native test runner with the platform-appropriate
path to `scripts\studio.test.ts`.

From the project root:

```powershell
npm ci
npm run test:studio
npm run build
npm run lint
python -m unittest discover -s scripts -p "test_rename_financial_accounts.py"
npm run dev -- --host 127.0.0.1 --port 3000 --strictPort
```

- Synthetic preview: `http://127.0.0.1:3000/?preview=true`.
- Live local development: open the **Local Play** URL printed by the Power Apps
  Vite plugin. A standalone localhost page is not an authenticated player.
- Default mode without `?preview=true` is live. Use explicit preview for UI work.
- `npm run preview` serves the production build; it does not grant connector
  authentication.
- Generated services and `.power\schemas` are versioned because the source
  imports them. Do not ignore or remove these directories.
- `node_modules`, `dist`, Python caches and live data exports are not versioned.
- Run `npm ci` on a fresh clone. During normal edits, only restore dependencies
  when needed; no new test framework is required.

### Publishing

Publishing updates the existing live demo app. Obtain explicit approval for
each deployment, confirm `power.config.json` still targets the intended
environment/app, and then run:

```powershell
npm run build
npx power-apps push
```

Stop on build or deployment failure. Do not force retries, switch tenants or
replace the app ID to get past a failure. Authentication is interactive when
required; never embed credentials.

For a new app version, keep `package.json`, `package-lock.json` and
`APP_VERSION` in `src\types.ts` aligned. Record successful publication in this
handoff and the README; do not describe an unpushed change as live.

## Architecture map

| Area | Main files | Responsibilities |
| --- | --- | --- |
| App shell | `src\App.tsx`, `src\ui\studioContext.ts`, `src\ui\Sidebar.tsx`, `src\ui\Topbar.tsx` | Page routing, selected customer/holding, navigation, theme and global search |
| State and operations | `src\hooks\useStudio.ts` | Polling, drafts, campaigns, guarded sends, local verdicts and review actions |
| Live data boundary | `src\services\studioGateway.ts` | Generated connector calls, paging, caches, health, validation, send and case writes |
| AI transport | `src\services\inlineAgent.ts` | Inline agent execution, conversation polling and timeout handling |
| AI instructions | `src\lib\emailGeneration.ts` | Shared natural-email prompt for single drafts and campaigns |
| Composition | `src\lib\studioEngine.ts`, `src\lib\emailDrafts.ts` | Templates, draft construction, attachment validation/generation and costs |
| Labels and sorting | `src\lib\holdingLabels.ts`, `src\lib\customerOptions.ts` | Natural holding labels and non-mutating alphabetical options |
| Evaluation evidence | `src\lib\evaluationEvidence.ts`, `src\ui\EvaluationResults.tsx` | Candidate/legacy matching, evidence presentation, manual verdicts and exports |
| Email export/display | `src\ui\eml.ts`, `src\ui\mailRender.ts` | EML output and safe message rendering |
| Outgoing HTML | `src\lib\emailBody.ts`, `src\lib\outlookMessage.ts`, `src\ui\OutgoingEmailBody.tsx` | Escaped paragraphs shared by Outlook payloads, previews and EML HTML alternatives |
| Preview | `src\services\previewData.ts` | Explicitly synthetic, local fixtures |
| Types/configuration | `src\types.ts`, `power.config.json` | Data contracts, defaults, environment/app/connector references |
| Generated code | `src\generated`, `.power\schemas` | Power Platform models, services and SDK metadata |
| Styling | `src\App.css`, `src\index.css` | Responsive layouts and existing Gravity Bank `--cp-*` design tokens |
| Regression tests | `scripts\studio.test.ts` | Native Node tests for sorting, subjects/exports, prompt boundaries and evidence matching |

Pages cover Overview, Process, Communications, Evaluation, Campaigns, Customers,
Human Review, Business Value and Settings. Retain the existing branding and
light/dark/system themes; do not replace the theme when making a local UI change.

## Live integrations and boundaries

The app uses generated Power Platform services for Dataverse, Office 365 Outlook
and the Agents (`agentnode`) connector. No direct browser Graph/Azure calls or
embedded credentials should be introduced.

Dataverse sources:
`contact`, `product`, `rfd_financialaccount`, `incident`, `task`, `annotation`,
`email`, and `workflow`.

- Monitor incoming mail only in `help@diax47618638.onmicrosoft.com`.
- `demo.customer@diax47618638.onmicrosoft.com` supplies outbound customer aliases;
  its Inbox must not be polled or made a monitoring health dependency.
- Reference reads cache for 60 seconds; dynamic reads for 10 seconds.
- Polling is non-overlapping and pauses while the tab is hidden.
- Help Inbox reads are a sample of up to 250 messages, filtered to a rolling
  24-hour window. They are not total mailbox throughput.
- Source failures, retained stale data and result caps must remain visible.
- Workflow configuration is not workflow run history or execution telemetry.

## Safety and behavioural invariants

1. Preview never invokes live connectors, sends email, runs AI or writes
   Dataverse. Do not disguise live failures with preview fixtures.
2. AI only generates draft content. Its inline definition is independently
   authored and tool-free. Do not invoke the production classifier or servicing
   agents as a replacement for the generator.
3. Sending is a separate, explicitly reviewed operation. It is restricted to the
   selected active Contact's actual demo alias and the Help mailbox.
4. Sending requires session-only confirmation that the demo workflow is
   configured for the customer Reply-To field. Both outgoing From and Reply-To
   must match the selected active Contact's live email. Do not alter Exchange
   settings or substitute the primary mailbox. Confirm actual Reply-To receipt
   during the pilot; this checkbox does not authenticate the customer.
5. `SendEmailV2` acknowledgement is acceptance, not delivery. It returns no
   message ID. Post-submission errors are uncertain outcomes; do not retry them
   automatically or imply non-delivery.
6. Campaigns require review, support pause/resume/cancel, and hold uncertain
   sends for reconciliation. Their queues are not durable background jobs.
7. Case review supports active status/priority updates and notes. Case
   resolution belongs in the supported model-driven experience, not a guessed
   state update. The app reports partial writes rather than claiming a
   transaction across separate operations.
8. Drafts, queues and reviewer verdicts live in memory. Export before reloading
   or closing. Only theme and cost preferences are persisted locally.
9. Costs and savings are editable estimates, not measured invoices or realised
   benefits. Missing telemetry is unknown, not zero or success.

## Recent work and current behaviour

### Baseline and AI repair

v0.1.3 provided aligned pipeline cards, bundled branding, readable connections
and Help-only monitoring. The subsequent AI adapter repair retained that
version number when deployed. The adapter accepts the connector's alternate
`result` text field, waits for a conversation when necessary and validates the
final `subject` / `body` / `expectedOutcome` object. Fenced JSON text is accepted;
templates are never substituted and labelled as AI.

The user confirmed the deployed AI fix worked on 1 October 2026. That is user
feedback, not a claim that all live generation or sending paths were exercised
by automated tests. Preserve this working transport while editing prompts.

### Account names

331 live financial-account display names were renamed on 1 October 2026.
Only `rfd_name` was targeted; protected account/card references and relationships
were preserved. Names now use Gravity branding and existing ending digits when
available, instead of `Diamond ... - DEMO-CUST-...` display labels.

`holdingLabels.ts` also makes the customer-facing labels natural. Internal
record references remain in the data model; do not delete them or invent
replacement bank/card numbers to improve presentation.

### v0.1.4, published 1 October 2026

- Customer and holding options sort by displayed name, case-insensitively.
  Customer search suggestions are alphabetical too. Sorting does not mutate
  the source snapshot or change campaign customer selection.
- Evaluation's Configure panel shows addresses for the next draft's selected
  customer. The existing draft retains its actual From/To until regenerated.
- New single and campaign drafts have natural subjects with **no `GB-STUDIO`
  suffix**, hidden body marker or replacement transport identifier. Internal
  draft/run IDs remain session/report metadata. Sending, confirmation and EML
  export use the same subject. Old drafts are not rewritten.
- The shared AI prompt requests 3-5 developed paragraphs: approximately
  180-280 words for simple, 250-400 for multi-intent, and 200-320 for ambiguous
  requests. These are prompt targets, not hard word-count guarantees.
  Everyday fictional motivations are allowed, but financial facts, identifiers
  and balances must not be invented.
- Outcome review separates submission, Help Inbox evidence, cases, expected
  behaviour and the reviewer's saved assessment. Unsaved edits are labelled
  and are not included in the saved report export.

### Correlation limitations after natural subjects

For new drafts, same-sender/exact-subject Inbox matches and same-customer/
exact-title case matches are **candidates**, never confirmed correlation.
The window is one minute before through fifteen minutes after connector
acknowledgement. Duplicate candidates remain ambiguous. Delayed results,
renamed cases and uncertain sends without a timestamp require manual inspection.

Legacy subject tokens still support their original token-matching path.
Neither a match nor a case proves business completion. Preview does not
fabricate evidence that a test ran. Reports include source health and limits.

### v0.1.5: HTML delivery and alias prerequisite (published 2 October 2026)

The user reported "Demo Customer" as the Outlook sender label and collapsed
paragraphs. The app was already submitting the Contact alias in `From`;
it was wrapping escaped plain text in a `white-space: pre-wrap` div for delivery.

The published app now renders explicit escaped paragraph/line-break HTML for
connector sends, formatted draft preview, single/campaign send confirmation
and campaign review. EML uses multipart/alternative (plain + HTML), nested
inside multipart/mixed when there are attachments. The AI/editor contract stays
plain text, and the AI prompt explicitly requests blank-line paragraph breaks.
No untrusted HTML is interpreted as markup and no send permissions were relaxed.

A read-only Exchange check confirmed `SendFromAliasEnabled=false` for the demo
tenant and that Adam Linton's alias exists on Demo Customer (a shared mailbox
with 101 addresses). Following explicit approval on 2 October, the setting was
enabled and read back as `true` in tenant
`fc547a7e-3617-4e9c-a506-83fa37eb5247`. It applies tenant-wide, not just to
this app. No mailbox permissions were changed and no test emails were sent.
See the linked Microsoft references in README for alias behaviour/limitations.

The screenshot's display name is not proof of the actual delivered From address.
The browser could not open the Help mailbox (MailboxUnavailable/access denied);
the existing message's raw headers were not inspected. Shared/delegated alias
support is client-dependent, so no end-to-end alias correction is claimed.
Do not switch to an undocumented Graph/connector send route. Reply-To does not
repair the actual delivered From; the user later approved it as a separate
demo-routing field (see v0.1.6 below). Any live diagnostic send needs an exact
message preview and approval.

The local 19-test regression set adds HTML newline/escaping cases, exact alias
payload preservation for single and batch drafts, and MIME alternatives with
and without attachments. Preview checks cover matching formatted HTML in
draft/confirmation views, mobile wrapping and preserved preview send guards.

### v0.1.6: explicit customer Reply-To (published 2 October 2026)

The user approved setting BOTH From and Reply-To to the customer Contact email,
and will update the workflow themselves. Do not modify the flow as part of this
app change. No BCC, alternate transport or Exchange change was introduced.

`EmailDraft.replyTo` is explicit and immutable. `makeDraft` populates it for
templates and AI, single and batch drafts. `validateDraftAddresses` rejects
missing, multi-address or mismatched values. The gateway still rereads the
active Contact immediately before dispatch and verifies the requested From.
The connector payload then sets both fields; safe HTML is unchanged.
New drafts are required for old session objects missing Reply-To.

Previews, approvals, EML and JSON include Reply-To. `MailItem.replyTo` comes
from the connector; Communications shows it without overwriting actual From.
Natural-subject evidence can use exact Reply-To only when received From is
the configured demo mailbox; it remains a candidate, not trusted identity.

`replyToWorkflowConfirmed` replaces `aliasSendingConfirmed` in session settings.
It starts false, is not persisted, resets on mode change and gates single and
batch sending. Its meaning is workflow readiness for this artificial demo path,
not a claim that delivery or customer authentication has been verified.

For the user's flow: restrict the override to demo mode and the authenticated
approved sender, validate exactly one eligible customer Reply-To address, retain
actual From and an explicit identity-source label, and route invalid/missing/
ambiguous values to review. Normal external email must not inherit this override.
Reply-To is not identity verification or permission for financial actions.
Inspect the actual Help trigger/read payload to prove Reply-To survives delivery
before relying on it. No pilot messages were sent by this app-development task.

The 23 native regression tests cover identical From/Reply-To payloads and
exports, rejection of invalid/mismatched reply addresses, and constrained
candidate matching without rewriting the received sender. Preview checks cover
single/batch approval addresses, HTML retention, JSON/EML exports, mobile
wrapping, received Reply-To display and session-only readiness confirmation.

### v0.1.7: latest inbound email formatting (published 2 October 2026)

Overview's `.comm-row` used flex `space-between` without a growing text column,
which left sender/subject text floating at different horizontal positions.
The row now uses a three-column grid with a shrinkable content column; metadata
is inline-flex so timestamps and attachment icons remain together. Full sender
and subject values are available in hover titles; received time uses a semantic
time element. The recent-mail card can shrink and its header can wrap.

The chart has spacing and a divider above it. No mail data, sorting, counts,
sender identity, chart calculations or navigation behaviours changed. Preview
layout checks covered 320/390/768/1100/1600px in both themes, long strings and
attachment rows; each row's text starts 12px after its status dot without
overlap or horizontal overflow.

### v0.1.8: case-category layout and dismissible note (published 2 October 2026)

`src\ui\CaseCategoryCard.tsx` now owns the Request mix panel and its note
visibility. The card uses `align-self: start` to avoid matching the much taller
email panel. Counts and category labels sit above thin bars; the summary
explicitly describes loaded case records. Original labels (including "Not set"),
counts, sorted order and maximum-relative bar scaling are preserved.

The informational note is a compact footer. Its X dismisses it and returns
keyboard focus to the header's About case categories button, which can reopen
it. Local component state survives snapshot refreshes but resets on remount;
nothing is written to browser storage or Dataverse. No system health/error
warnings were made dismissible. The original seven-category display cap is
unchanged, with an explicit notice when additional categories are omitted.

Preview covered one "Not set" case, multiple/long category labels, an empty
snapshot, and over-seven categories; keyboard dismissal/reopening and data
refresh behaviour; and 320/390/768/1440px light/dark layouts. The previously
published inbound email alignment fix remains intact in the working tree.

## Process tracking implementation and release blockers

Read `docs\process-implementation-status.txt` first, then the approved
`docs\email-process-instrumentation-plan.txt`. Do not equate implemented source
and provisioned schema with a released end-to-end telemetry system.

The proposal was revised on 2 October into four independent approval stages:
professional BPMN-inspired UI; seven-table Dataverse definition/runtime model;
C# Custom APIs, producer adapters and case lifecycle observation; optional
outbox/Service Bus/Web PubSub with a published-host CSP/auth feasibility gate.
Each stage has scope, dependencies, acceptance and rollback. Stages 1-3 were
approved for implementation at 13:30 on 2 October. Stage 4 remains unapproved.

The primary ProcessId/TraceId is a full GUID allocated at Help intake, with a
mailbox-scoped hash of InternetMessageId as the unique ingestion key. Reply-To
is customer-routing metadata, never a process key or authenticated identity.
The previous subject-marker recommendation is withdrawn. Exact pre-send linkage
is a separately gated transport capability; current candidate matching is not
promoted to exact correlation.

Stage 1: src/process and ProcessCanvas implement the React Flow experience,
nine synthetic walkthroughs, read-model adapter, native record links, accessible
list/details and legacy rollback. App preview injects no live gateway. Stage
snapshots do not invent recorded timestamps; immutable historical definitions
are carried with selected process state. Incomplete/stale data remains labelled.

Stage 2: all seven tables, 109 declared columns, 26 relationships and seven
Active keys are provisioned in RetailFinanceDemo. Eighteen configuration rows
publish help-email version 1, ID 49afef0f-20c9-51f8-b51e-78c0cc0c0b78. The four
runtime tables remain empty. solutions/RetailFinanceDemo holds actual exported/
unpacked metadata, not hand-authored XML. The unsupported annotation lookup
was replaced by validated rfd_noteid String(36). Provisioning recovery used table
shells plus columns; repeat apply is no-op. Role/FLS grants and user-visibility
integration tests remain release gates.

Stage 3: server/EmailProcess.Plugin contains the net48 writer/read APIs, reducer,
guards and async case observer. Native workflow request attempts have separate
source identity and server-owned canonical ordinals. Actual Contact binding
requires an authorized identify-phase tool event with the explicit capability;
headers or agent prose cannot bind it. Default producer policy denies everyone;
the package/APIs/guards/observer have NOT been registered or activated.

scripts/instrument_email_flow.py can prepare the exact current Help topology
using ETag/hash guards, including six switch choices and mock-response. Both
original Terminate(Failed) actions and business inputs remain unchanged. Current
definition deliberately disables no-case completion: host invocation success
does not prove a successful banking outcome. No live flow has been changed.

Actual tool inventory located customer/case logic in query-or-update-card
InlineAgentSkill using generic Dataverse MCP InvokeMCP. The inspected
InvokeAgent binding has agentId/prompt only, with no verified typed process
context or deterministic interception hook. The approved Stage 3 completion route
is deterministic flow orchestration: move customer lookup, case mutation and
process linkage into reviewed flow-owned or approved tool-service actions that
call the plug-in APIs, while the saved agent returns recommendations only. Do
not add prompt-based logging, invent a context parameter, correlate by customer/
subject, or claim case linking is live. The automatic saved-agent/MCP patch
remains refused. Structural inventory and the approved orchestration handoff are
in flow-templates without raw instructions or customer payloads.

The intended custom Case Management Workflow is still unidentified; either find
that owned flow or create an approved deterministic orchestration. Do not activate
the inactive managed case-management agent flow by name. No Azure resources, CSP
relaxation, Git push or pilot sends occurred. The v0.2.0 app UI was deployed
with `npx power-apps push`; the process APIs/plug-ins/flows were not activated.
Preserve all existing v0.1.7/v0.1.8 UI changes in this working tree.

Development commands:
```powershell
npm run test:studio
npm run build
npm run lint
python scripts\generate_process_bindings.py
python scripts\process_build_manifest.py --check
python -m unittest discover -s scripts -p "process_*test.py"
python -m unittest discover -s scripts -p "test_instrument_email_flow.py"
python -m unittest discover -s scripts -p "test_register_process_apis.py"
dotnet test server\EmailProcess.Plugin.Tests\EmailProcess.Plugin.Tests.csproj -c Release
```

Review fixed two read-model bugs: health=partial now maps to stale with explicit
reconciliation diagnostics; refresh adopts a fresh event cursor even after an
older paging session is exhausted. The process poll respects the app's
polling/pollSeconds settings. Native runtime, privilege and end-to-end pilot
proofs remain necessary before publication.

## Maintenance script: not a startup step

`scripts\rename_financial_accounts.py` is an environment-specific maintenance
utility. Its live execution depends on local resources outside this repository:

- An initialized `auth.py` and environment configuration.
- The approved financial-account schema JSON.
- Access through the official Microsoft Power Platform Dataverse Python SDK.

The script has original-machine defaults plus `--auth-scripts-dir` and
`--schema` overrides. It checks the expected environment, solution, publisher
and admin identity. Do not remove those checks to make another environment work.
Its unit tests use an in-memory fake and do not need credentials.

Preparing a plan reads live records; applying it changes live data. Run neither
as part of installing/building the app. Any future rename needs fresh
authorization and a reviewed plan digest. The record-level plan
`docs\financial-account-name-changes.json` is deliberately ignored, not missing
source code. Auth files, local schemas containing data and exports should not
be copied into Git to make the maintenance script self-contained.

## Validation and continuing work

The v0.1.4 baseline passed the existing TypeScript/Vite build, ESLint and
13 native Node regression tests. The rename utility's 22 Python tests passed
during the earlier rename work. Preview exercises covered single and campaign
drafts, natural subjects, EML/report content, independent sender selection,
saved assessments, the disabled preview-send guard, and desktop/mobile
light/dark layouts. These do not establish live delivery or workflow completion.

For further edits, run the smallest relevant tests plus build/lint for code
changes. For layout changes, inspect the preview at desktop and mobile widths.
No real sends, case writes or financial-account changes should be used as
casual smoke tests.

HTML delivery is published and the approved alias prerequisite is enabled.
The Reply-To update is published; the user owns flow changes. Inspect
the latest request and Git status before editing; preserve changes from other agents.
Keep the README and this handoff current when actual behaviour or publication
changes. Do not describe planned instrumentation or possible evidence as live
measured capability.
