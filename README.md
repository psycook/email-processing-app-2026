# Gravity Bank Email Automation Studio

A React/TypeScript Power Apps Code App for observing, evaluating and managing
the retail-finance shared-mailbox process. Responsive light, dark and system
themes use the Gravity Bank brand.

For coding-agent onboarding and the current development baseline, read
[`handoff.md`](handoff.md) before making changes.

## Local use

Run `npm run dev -- --host 127.0.0.1 --port 3000 --strictPort`.

- Synthetic preview: http://127.0.0.1:3000/?preview=true
- Live local development: use the Local Play URL printed by the Power Apps
  Vite plugin. Do not open a standalone localhost page and expect authenticated
  connectors to work outside the Power Apps player.
- Production output: `npm run build`. Existing lint: `npm run lint`.
- Focused composition/evidence regression tests: `npm run test:studio` (Node 24).

## Process-tracking implementation v0.2.0

Stages 1-3 were approved for implementation. The new process canvas, fixtures,
validated read gateway, C# plug-in/API source, guarded schema tooling and offline
workflow adapters are in this working tree. Stage 4 is not implemented.

v0.2.1 simplifies the dashboard and Process Studio diagram into a
single-line React Flow business view: Shared Mailbox -> Classifier -> Agent ->
Case Management -> Outcome -> Email Response. The detailed stage list and ledger
drill-down remain available without crowding the dashboard. This v0.2.1 UI change
was published on 2 October 2026.

v0.2.2 adds data-aware node chips to that six-node view. When a ledger
snapshot is available, each node shows execution counts and latest activity; the
Classifier and Agent nodes also surface the selected route/handler. In
configuration-only mode the nodes clearly state that no live execution is present.
This v0.2.2 UI change was published on 2 October 2026.

v0.2.3 adds an Expand map action that opens the six-node React Flow map in
an almost full-screen closeable modal with a dark blurred transparent backdrop.
This v0.2.3 UI change was published on 2 October 2026.

Seven Dataverse tables, seven Active alternate keys and 18 configuration rows
have been provisioned in RetailFinanceDemo. Generated solution XML is under
`solutions\RetailFinanceDemo`; runtime tracking tables remain empty.

The v0.2.0 app shell and process UI were published on 2 October 2026. **Stage 3
is still not end-to-end complete.** The approved completion route is deterministic
flow orchestration: customer lookup, case mutation and process linkage move into
reviewed flow/tool actions that call the plug-in Custom APIs, while the saved
Card Servicing agent can return recommendations only. Plug-in/API registration,
identity/role configuration, source-guarded flow binding, native integration
proofs and flow cutover remain release gates. Do not substitute prompt-based
logging, generic MCP writes or inferred Case links. The intended custom Case
Management Workflow also requires identification or replacement with an approved
owned orchestration.

See `docs\process-implementation-status.txt`, `server\api-contract.txt`,
`server\runtime-prerequisites.txt` and `docs\process-flow-integration.txt`
for exact completed work, commands and blockers. Preview uses local fixtures;
`?legacyProcess=true` restores the original process renderer. No live pilot
messages have been performed for v0.2.0.

## Environment and publication

Environment: `b17908ad-6b6b-eefb-98bc-79cc7e20ab08`.
Dataverse: https://smc-diamond-service.crm.dynamics.com/

Code Apps are enabled in this environment and the Studio is published.
The hosted version is v0.2.3, published on 2 October 2026, with the simplified
six-node process flow, execution-aware node chips and expandable full-screen map,
compact case-category panel and dismissible footer note,
aligned inbound email rows and clearer chart spacing. Both From and Reply-To
remain set to the selected customer alias while preserving simple HTML paragraphs
in sends, previews and exports. Alphabetical customer/holding selectors, natural
subjects, fuller AI instructions, redesigned Evaluation panels, bundled branding,
Help-only monitoring, readable connections and aligned pipeline cards/captions
are preserved.
App ID: `a9b487ae-7eee-4f6f-ba71-ed18e50c021c`.
Launch: https://apps.powerapps.com/play/e/b17908ad-6b6b-eefb-98bc-79cc7e20ab08/app/a9b487ae-7eee-4f6f-ba71-ed18e50c021c?tenantId=fc547a7e-3617-4e9c-a506-83fa37eb5247
After approval for an update, build with `npm run build` and publish with
`npx power-apps push`.

## Inbound panel formatting v0.1.7 (published)

The Overview's Latest inbound email rows now use fixed status/content/metadata
columns instead of distributing free space between the three items. Sender
and subject text share a consistent left edge, long values ellipsize with full
text available on hover, and timestamps/attachment icons remain right-aligned.
The daily chart has a separate divider and spacing; the panel header wraps at
narrow widths. Message contents, sorting, counts and navigation are unchanged.

## Case category layout v0.1.8 (published)

The Request mix card now sizes to its content instead of stretching to the
height of the adjacent email panel. Category labels and explicit case counts
sit above slim bars, with a loaded-case summary and clearer spacing.

The explanation is a quieter footer below a divider. Close it with the X, or
reopen it with the header's information button. Dismissal lasts while Overview
is mounted, including data refreshes; it resets when returning to Overview or
reloading. Keyboard dismissal returns focus to the information button. Category
values, counts, ordering and relative bar scaling remain unchanged; lists over
seven categories now disclose the number omitted.

## Capabilities

- Dashboard, interactive six-stage process map, communications reader,
  customer/holding/catalogue context, open-case review and business-value model.
- Manual or contextual template drafts, a generation-only inline AI definition
  through the existing agentnode connection, and editable expected outcomes.
- Uploaded PDF/images plus locally generated, watermarked synthetic PDF/PNG
  account-context summaries. Files are signature-checked and limited to 4 MiB
  including base64 overhead, with no more than 20 attachments.
- Reviewed bulk queues: customer count, total email count, selected request
  classes, complexity, attachment type, 1-120 second pacing, pause/resume/cancel.
  Maximum 200 emails; at least one email per selected customer.
- Exact subject-token observation of Help Inbox receipt and case/note
  evidence for legacy marked drafts. New drafts use natural, unmarked subjects:
  sender/subject/time and customer/case-title/time matches are only possible
  matches for manual inspection, never exact correlation. Manual pass/fail
  scoring and JSON/EML exports. Missing evidence does not prove failure.
- Active-case priority/status changes and review notes. Closing a case is not
  implemented by incorrectly setting its state; open the model-driven case to
  use the supported resolution experience.
- Editable monthly volume, labour, handling/review time, automation rate,
  AI/connector unit costs and fixed cost assumptions. Savings and running costs
  are explicitly estimates, not measured invoices or guaranteed benefits.

## Live connectors and guardrails

All live operations use generated Power Platform services; there are no direct
Graph/Azure HTTP requests or embedded credentials.

Dataverse sources: `contact`, `product`, `rfd_financialaccount`, `incident`,
`task`, `annotation`, `email`, and the existing Help workflow.
Outlook inbound monitoring: `help@diax47618638.onmicrosoft.com` only.
`demo.customer@diax47618638.onmicrosoft.com` is the outbound customer-alias pool,
not an Inbox data source. Its mailbox membership/access is not required for
inbound monitoring. Outbound send permissions and alias preservation are
separate capabilities and remain gated.

The default is live read-only until a user deliberately confirms a send.
Preview is explicitly synthetic and makes no connector calls, AI invocations,
sends or Dataverse writes. Switching modes clears working drafts and resets
the session-only sending confirmation. References cache for 60 seconds; dynamic reads for
10 seconds. Polling is non-overlapping and pauses while the tab is hidden.
Mailbox results are Help Inbox samples within a rolling 24-hour window, capped
at 250 messages. A truncation notice is shown only when the cap is reached.
Source errors and stale/capped results are disclosed, not rendered as success.

Sending is restricted to the selected active Contact's actual demo alias and
the Help mailbox. `SendEmailV2` can canonicalise aliases. In the published
Reply-To update below, the session-only checkbox confirms that the demo workflow
has been configured to use Reply-To, rather than asserting From preservation.
This app does not change `SendFromAliasEnabled`.
There is no fallback to the shared mailbox primary sender.

The hosted app reads live Contacts, Products, Financial Accounts, Cases, Tasks,
Notes, Email Activities, Help workflow configuration and the Help Inbox.
No request is made to the demo customer Inbox. Earlier versions incorrectly
polled it and treated its failure as degraded monitoring; this was removed.
No mailbox permissions were changed. The demo tenant's send-from-alias setting
was enabled separately with explicit approval on 2 October 2026.

Automated development validation did not exercise real sends, live AI invocations
or case writes. The user confirmed the deployed AI generation repair worked on
1 October 2026. A connector
send acknowledgement means acceptance, not delivery proof. Any error after
submission is conservatively held for reconciliation and never automatically
retried. Launch approvals show the exact messages and attachments.

AI authorship uses an independently authored tool-free inline definition, not
the production classifier or servicing agents. Empty advanced configuration
uses that built-in definition; arbitrary definitions/tools/actions are rejected.
Live generation still depends on connector access and model availability. A
failed AI request is never replaced with templates labelled as AI.

## HTML delivery update v0.1.5 (published)

The plain-text editor and AI output now convert to escaped, simple HTML for
Outlook: blank lines become `<p>` elements and single newlines become `<br>`
elements. Sending no longer relies on `white-space: pre-wrap`. Formatted draft,
single-send confirmation and campaign previews use the same HTML conversion.
EML exports contain both the original plain text and the same HTML alternative,
including when attachments are present. Typed/model-generated HTML remains
literal text rather than executable markup.

The sender remains the selected active Contact's exact email alias, validated
again immediately before submission; the primary Demo Customer address is never
substituted by the app. A read-only Exchange check on 2 October 2026 found
`SendFromAliasEnabled` disabled in the demo tenant, with the customer alias
present on the shared mailbox. Following explicit user approval, this
tenant-wide prerequisite was enabled and read back as `true` on 2 October 2026.
The change was restricted to the demo tenant; no test emails were sent.

The Outlook display name alone does not prove which address was delivered.
Inspect the actual received `From` header. Shared/delegated alias support has
client limitations; enabling the setting is not a guarantee that this connector
preserves aliases. No alternate sending API or mailbox identity changes have
been introduced. The later Reply-To update below adds explicit demo routing
metadata without replacing the real From address.

## Reply-To update v0.1.6 (published)

Single and campaign drafts now set both `From` and `ReplyTo` to the selected
Contact's `emailaddress1`. The Reply-To field is immutable on an existing draft;
it must be one address, identical to From, and the gateway still rechecks From
against the active Contact's current email immediately before sending. Missing,
different or multiple Reply-To values stop sending/export. The AI does not
choose any address. No BCC is added, so this creates no extra email copy.

Both fields appear in Configure, the draft, single/batch approvals and exported
EML/JSON. Received Reply-To is retained and searchable in Communications, alongside
the actual received From. The app never overwrites received From with Reply-To.

Settings now requires a session-only acknowledgement: "I have configured the
demo workflow to use the customer Reply-To address". This replaces the old
From-preservation checkbox, starts off, resets on mode change, and does not
modify or verify the flow. Preview still cannot send; each live send or batch
still requires review. Confirm receipt during the pilot; the connector's actual
delivered Reply-To has not yet been verified.

**Workflow changes are owned by the user and are not implemented here.** Read
the received `replyTo` field (or get the email if it is absent on the trigger),
validate exactly one eligible demo customer address, and pass it separately as
the demo effective customer email. Restrict overrides to demo mode and the
authenticated approved sender; preserve actual From for provenance. Missing,
invalid or ambiguous metadata needs an exception/review path, not guessed
customer matching. Reply-To is caller-controlled routing metadata, never proof
of identity or authority to perform a financial action. Normal non-demo mail
should continue using its normal identity rules.

The Evaluation panel can show a candidate Inbox match where received From is
the configured Demo Customer mailbox and one exact Reply-To equals the draft's
customer alias, subject and time window. This is only an inspection lead, not
authentication or proof the workflow resolved the right customer. Legacy-token
matching is unchanged; other senders cannot match by Reply-To alone.

References:
- [Exchange alias setting](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-organizationconfig#-sendfromaliasenabled)
- [Shared-mailbox alias limitations](https://techcommunity.microsoft.com/blog/exchange/sending-from-email-aliases-%e2%80%93-public-preview/3070501)

Queues, drafts, reviewer verdicts and preview reviews are memory-only. Keep the
tab open for a campaign and export reports before reloading. This is not a
durable background job service; in-flight sends cannot be recalled.

## Instrumentation plan and implementation status

See `docs\email-process-instrumentation-plan.txt` for the revised 2 October plan,
split into four independently approvable stages: professional process UI;
Dataverse schema and correlation; plug-in-backed Custom APIs and producer
wiring; optional event-bus/browser push. Stages 1-3 are approved: UI/service code
and schema are implemented to the readiness boundaries documented above;
runtime wiring and release are not complete. Stage 4/outbox is not approved.
The earlier subject-marker proposal is superseded:
canonical tracing starts at intake, without restoring technical subject tags.
Application Insights remains an optional diagnostic layer, not the process ledger.

## Evaluation usability update v0.1.4 (published)

Customer and holding dropdowns, including customer search suggestions, sort
alphabetically by their displayed names without changing connector paging or
campaign customer selection. The Configure
address summary reflects the selected customer for the next draft; the editor
continues to show the existing draft's actual sender and recipient.

New single and campaign emails have no appended `GB-STUDIO` subject suffix,
hidden body marker or replacement transport identifier. Internal draft/run IDs
stay in session metadata and JSON exports, not customer text. Preview, send
confirmation, Outlook sends and EML exports all use the same natural subject.
Old drafts are not rewritten.

The shared AI instructions target 180-280 words for simple requests, 250-400 for
multi-intent and 200-320 for ambiguous requests, with 3-5 developed paragraphs.
These are generation instructions, not a hard word-count guarantee. Financial
facts and identifiers still come only from the supplied context.

Outcome review separates submission, Help Inbox observations, possible cases,
expected behaviour and the reviewer's assessment. Possible matches use the same
sender/exact subject (mail) or customer/exact title (cases), from one minute
before to fifteen minutes after connector acknowledgement. Duplicate matches
remain ambiguous. Delayed results, renamed cases and uncertain sends without
a timestamp need manual inspection. Legacy subject tokens retain their old
matching path. None of these observations proves business completion.

Save each assessment before exporting: exports include saved verdicts only,
along with source-health/capping information. Unsaved edits are labelled.
Assessments and queues remain tab-local; this update does not implement the
proposed persistent instrumentation ledger or change send permissions.

## Underlying template

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
