import type { EmailDraft, GeneratorInput, GeneratorOutput, StudioSettings } from '../types'

export function makeDraft(input: GeneratorInput, output: GeneratorOutput, source: EmailDraft['source'], settings: StudioSettings, runId: string): EmailDraft {
  return {
    id: crypto.randomUUID(), runId, customerId: input.customer.id, holdingId: input.holding?.id,
    from: input.customer.email, replyTo: input.customer.email, to: settings.helpMailbox,
    subject: output.subject.trim(), body: output.body,
    category: input.category, complexity: input.complexity, attachments: [],
    source, expectedOutcome: output.expectedOutcome, state: 'draft',
  }
}

export function validateDraftAddresses(draft: Pick<EmailDraft, 'from' | 'replyTo'>): void {
  if (typeof draft.replyTo !== 'string' || !/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(draft.replyTo)
    || draft.replyTo !== draft.from) {
    throw new Error('From and Reply-To must be the same single customer email address. Create a new draft if its sender details have changed.')
  }
}
