# Gravity Bank Email Automation Studio - coding-agent handoff

Last updated: 1 October 2026.

## Start here

This is an existing, published Power Apps Code App, not a new scaffold.
Read this file, `README.md`, `package.json`, `power.config.json` and the files
relevant to the requested change before editing. Preserve existing behaviour
unless the user explicitly asks to change it. Do not automatically implement
the instrumentation proposal.

The published baseline is **v0.1.4**. The local source and build were used for
that deployment. The initial Git import was prepared after publication.
No further app changes were requested as part of putting this project in Git.

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
4. Alias sending requires session-only confirmation after an administrator has
   inspected the received From header. Do not alter tenant send-from-alias
   settings or substitute the primary mailbox.
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

## Instrumentation: proposed, not implemented

Read `docs\email-process-instrumentation-plan.txt` as a proposal, not completed
work or permission to provision anything.

It proposes two Dataverse tables (`rfd_emailprocess` and
`rfd_emailprocessevent`), a shared Custom API writer, GUID trace/span identities,
and adapters at real workflow, agent/tool and review boundaries. Application
Insights is optional later. No tables, writer API, producer wiring, retention
jobs or durable execution ledger have been implemented by this app work.

**Important design conflict:** the proposal predates the user's natural-subject
decision and suggests a subject marker. Do not reintroduce that marker as an
automatic "fix". Reconcile transport correlation with the current UX requirement
and obtain an explicit implementation decision first.

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

There is no approved next feature beyond this baseline. Inspect the latest
request and Git status before editing; preserve changes from other agents.
Keep the README and this handoff current when actual behaviour or publication
changes. Do not describe planned instrumentation or possible evidence as live
measured capability.
