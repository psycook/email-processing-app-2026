// Generated from config/process-tracking-schema.json; no runtime records.
import type { ProcessDefinition } from '../process/types'
export const PROCESS_INVENTORY: ProcessDefinition = {
  "schemaVersion": 1,
  "definitionId": "help-email-prepared-inventory-v1",
  "code": "help-email",
  "name": "Help email - observed classification and Card Servicing routing",
  "version": "1",
  "coverageVersion": "help-observed-v1-uninstrumented",
  "mode": "configuration",
  "description": "Prepared process definition from the inspected Help workflow. Card/default branches retain their original Failed termination; empty switch cases reach Mock_Response. Tool and case overlays are not proof of execution.",
  "lanes": [
    {
      "id": "email",
      "label": "Email channel",
      "order": 0
    },
    {
      "id": "help-flow",
      "label": "Workflow orchestration",
      "order": 1
    },
    {
      "id": "saved-agent",
      "label": "Agents / tools",
      "order": 2
    },
    {
      "id": "instrumentation-overlay",
      "label": "Planned tool observation",
      "order": 3
    },
    {
      "id": "case-management",
      "label": "Case handling",
      "order": 4
    }
  ],
  "stages": [
    {
      "schemaVersion": 1,
      "stageCode": "intake",
      "label": "Help email received",
      "description": "Observed configuration only. Successful host invocation is not proof of a financial action.",
      "laneId": "email",
      "phase": "intake",
      "kind": "start",
      "order": 0,
      "coverage": "uninstrumented",
      "optional": false,
      "opaque": false,
      "evidence": "inventory"
    },
    {
      "schemaVersion": 1,
      "stageCode": "classify",
      "label": "Classify_Email",
      "description": "Observed configuration only. Successful host invocation is not proof of a financial action.",
      "laneId": "help-flow",
      "phase": "classify",
      "kind": "task",
      "order": 10,
      "coverage": "uninstrumented",
      "optional": false,
      "opaque": false,
      "evidence": "inventory"
    },
    {
      "schemaVersion": 1,
      "stageCode": "route",
      "label": "Switch on classification",
      "description": "Observed configuration only. Successful host invocation is not proof of a financial action.",
      "laneId": "help-flow",
      "phase": "route",
      "kind": "gateway",
      "order": 20,
      "coverage": "uninstrumented",
      "optional": false,
      "opaque": false,
      "evidence": "inventory"
    },
    {
      "schemaVersion": 1,
      "stageCode": "card-servicing",
      "label": "Card Servicing saved agent - host invocation only",
      "description": "Observed configuration only. Successful host invocation is not proof of a financial action.",
      "laneId": "saved-agent",
      "phase": "act",
      "kind": "subprocess",
      "order": 30,
      "coverage": "uninstrumented",
      "optional": true,
      "opaque": true,
      "evidence": "inventory"
    },
    {
      "schemaVersion": 1,
      "stageCode": "contact-lookup",
      "label": "Customer resolution - planned tool-observation overlay",
      "description": "Planned, uninstrumented tool boundary; no customer lookup is inferred.",
      "laneId": "instrumentation-overlay",
      "phase": "identify",
      "kind": "task",
      "order": 35,
      "coverage": "unknown",
      "optional": true,
      "opaque": false,
      "evidence": "inventory"
    },
    {
      "schemaVersion": 1,
      "stageCode": "spam",
      "label": "SPAM / default",
      "description": "Observed configuration only. Successful host invocation is not proof of a financial action.",
      "laneId": "help-flow",
      "phase": "route",
      "kind": "task",
      "order": 40,
      "coverage": "uninstrumented",
      "optional": true,
      "opaque": false,
      "evidence": "inventory"
    },
    {
      "schemaVersion": 1,
      "stageCode": "mock-response",
      "label": "Mock_Response_Agent",
      "description": "Observed configuration only. Successful host invocation is not proof of a financial action.",
      "laneId": "help-flow",
      "phase": "act",
      "kind": "subprocess",
      "order": 45,
      "coverage": "uninstrumented",
      "optional": true,
      "opaque": true,
      "evidence": "inventory"
    },
    {
      "schemaVersion": 1,
      "stageCode": "reviewcase",
      "label": "Case review and lifecycle",
      "description": "Conditional lifecycle observation from explicitly linked cases.",
      "laneId": "case-management",
      "phase": "review",
      "kind": "wait",
      "order": 50,
      "coverage": "unknown",
      "optional": true,
      "opaque": false,
      "evidence": "lifecycle"
    }
  ],
  "transitions": [
    {
      "schemaVersion": 1,
      "transitionCode": "received",
      "fromStageCode": "intake",
      "toStageCode": "classify",
      "label": "Received for classification",
      "branchCode": "",
      "optional": false,
      "kind": "sequence"
    },
    {
      "schemaVersion": 1,
      "transitionCode": "classified",
      "fromStageCode": "classify",
      "toStageCode": "route",
      "label": "Classification observed",
      "branchCode": "",
      "optional": false,
      "kind": "sequence"
    },
    {
      "schemaVersion": 1,
      "transitionCode": "card-route",
      "fromStageCode": "route",
      "toStageCode": "card-servicing",
      "label": "Card Servicing",
      "branchCode": "card-servicing",
      "optional": false,
      "kind": "sequence"
    },
    {
      "schemaVersion": 1,
      "transitionCode": "default-spam",
      "fromStageCode": "route",
      "toStageCode": "spam",
      "label": "SPAM / default",
      "branchCode": "spam",
      "optional": false,
      "kind": "sequence"
    },
    {
      "schemaVersion": 1,
      "transitionCode": "payment-direct-debits-route",
      "fromStageCode": "route",
      "toStageCode": "mock-response",
      "label": "Payment & direct debits - empty case reaches mock response",
      "branchCode": "payment-direct-debits",
      "optional": false,
      "kind": "sequence"
    },
    {
      "schemaVersion": 1,
      "transitionCode": "disputes-fraud-route",
      "fromStageCode": "route",
      "toStageCode": "mock-response",
      "label": "Disputes & fraud - empty case reaches mock response",
      "branchCode": "disputes-fraud",
      "optional": false,
      "kind": "sequence"
    },
    {
      "schemaVersion": 1,
      "transitionCode": "details-documents-route",
      "fromStageCode": "route",
      "toStageCode": "mock-response",
      "label": "Details & Documents - empty case reaches mock response",
      "branchCode": "details-documents",
      "optional": false,
      "kind": "sequence"
    },
    {
      "schemaVersion": 1,
      "transitionCode": "complaints-route",
      "fromStageCode": "route",
      "toStageCode": "mock-response",
      "label": "Complaints - empty case reaches mock response",
      "branchCode": "complaints",
      "optional": false,
      "kind": "sequence"
    },
    {
      "schemaVersion": 1,
      "transitionCode": "explicit-case-link",
      "fromStageCode": "card-servicing",
      "toStageCode": "reviewcase",
      "label": "Only if an actual blocking case is explicitly linked",
      "branchCode": "case-linked",
      "optional": true,
      "kind": "sequence"
    }
  ],
  "sources": [
    {
      "name": "Prepared workflow inventory",
      "health": "available",
      "message": "Configuration only; the live process API must supply observed instances."
    }
  ]
}
