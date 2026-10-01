import type { EmailDraft, GeneratorInput, GeneratorOutput, StudioSettings } from '../types'

export function makeDraft(input: GeneratorInput, output: GeneratorOutput, source: EmailDraft['source'], settings: StudioSettings, runId: string): EmailDraft {
  return {
    id: crypto.randomUUID(), runId, customerId: input.customer.id, holdingId: input.holding?.id,
    from: input.customer.email, to: settings.helpMailbox,
    subject: output.subject.trim(), body: output.body,
    category: input.category, complexity: input.complexity, attachments: [],
    source, expectedOutcome: output.expectedOutcome, state: 'draft',
  }
}
