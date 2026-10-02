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

## Environment and publication

Environment: `b17908ad-6b6b-eefb-98bc-79cc7e20ab08`.
Dataverse: https://smc-diamond-service.crm.dynamics.com/

Code Apps are enabled in this environment and the Studio is published.
The hosted version is v0.1.5, published on 2 October 2026, adding simple HTML
paragraphs to sends, previews and exports. Alphabetical customer/holding
selectors, natural subjects, fuller AI instructions, redesigned Evaluation
panels, bundled branding, Help-only monitoring,
readable connections and aligned pipeline cards/captions are preserved.
App ID: `a9b487ae-7eee-4f6f-ba71-ed18e50c021c`.
Launch: https://apps.powerapps.com/play/e/b17908ad-6b6b-eefb-98bc-79cc7e20ab08/app/a9b487ae-7eee-4f6f-ba71-ed18e50c021c?tenantId=fc547a7e-3617-4e9c-a506-83fa37eb5247
After approval for an update, build with `npm run build` and publish with
`npx power-apps push`.

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
alias confirmation. References cache for 60 seconds; dynamic reads for
10 seconds. Polling is non-overlapping and pauses while the tab is hidden.
Mailbox results are Help Inbox samples within a rolling 24-hour window, capped
at 250 messages. A truncation notice is shown only when the cap is reached.
Source errors and stale/capped results are disclosed, not rendered as success.

Sending is restricted to the selected active Contact's actual demo alias and
the Help mailbox. `SendEmailV2` can canonicalise aliases: an administrator must
verify the received From header for this connector before enabling the
session-only checkbox. This app does not change `SendFromAliasEnabled`.
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
preserves aliases. No fallback to another API, Reply-To substitution or mailbox
identity changes have been introduced.

References:
- [Exchange alias setting](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-organizationconfig#-sendfromaliasenabled)
- [Shared-mailbox alias limitations](https://techcommunity.microsoft.com/blog/exchange/sending-from-email-aliases-%e2%80%93-public-preview/3070501)

Queues, drafts, reviewer verdicts and preview reviews are memory-only. Keep the
tab open for a campaign and export reports before reloading. This is not a
durable background job service; in-flight sends cannot be recalled.

## Instrumentation proposal

See `docs\email-process-instrumentation-plan.txt` for the proposed two-table
Dataverse ledger, shared writer API, message/operation correlation, producer
hooks, reliability/privacy policy and rollout. This is a plan, not implemented
instrumentation. Application Insights is an optional later diagnostic layer.

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
