using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Newtonsoft.Json.Linq;

namespace EmailProcess.Plugin
{
    public sealed class ProcessApi : IPlugin
    {
        public const string WriteMarker = "rfd.ProcessServiceWrite";
        public static readonly string[] WriteActions = { "rfd_RecordEmailProcessEvent", "rfd_LinkEmailProcessCase", "rfd_RecordCaseLifecycle" };
        private readonly Policy policy;
        public ProcessApi() : this(null, null) { }
        public ProcessApi(string unsecure, string secure) { policy = Policy.Load(secure); }

        public void Execute(IServiceProvider provider)
        {
            var context = (IPluginExecutionContext)provider.GetService(typeof(IPluginExecutionContext));
            var factory = (IOrganizationServiceFactory)provider.GetService(typeof(IOrganizationServiceFactory));
            var trace = (ITracingService)provider.GetService(typeof(ITracingService));
            try
            {
                if (context.Stage != 30 || context.UserId != context.InitiatingUserId)
                    throw new ContractException("CallerContextRequired");
                var command = Json.Read<Command>(context.InputParameters.Contains("RequestJson") ? context.InputParameters["RequestJson"] as string : null);
                if (command.SchemaVersion != 1) throw new ContractException("UnsupportedSchemaVersion");
                var store = new Store(factory.CreateOrganizationService(context.InitiatingUserId));
                object result;
                if (WriteActions.Contains(context.MessageName))
                {
                    if (!context.IsInTransaction) throw new ContractException("TransactionalMainOperationRequired");
                    var trustedObserver = Trust.Observer(context.ParentContext, policy, command.CaseId, context.InitiatingUserId);
                    Producer producer;
                    if (trustedObserver && context.MessageName == "rfd_RecordCaseLifecycle")
                        producer = new Producer { ProducerId = "case-observer", Authority = "case-observer" };
                    else producer = policy.Authorize(command.ProducerId, context.InitiatingUserId, role => store.InRole(context.InitiatingUserId, role));
                    command.ProducerId = producer.ProducerId;
                    result = new Writer(store, context, producer, policy).Execute(context.MessageName, command, trustedObserver);
                }
                else result = new Reader(store, context.OrganizationId, context.InitiatingUserId, policy).Execute(context.MessageName, command);
                context.OutputParameters["ResponseJson"] = Json.Write(result);
            }
            catch (ContractException error)
            {
                trace?.Trace("EmailProcess rejected {0}; correlation {1}", error.Message, context.CorrelationId);
                throw new InvalidPluginExecutionException(error.Message);
            }
        }
    }

    public sealed class Writer
    {
        private readonly Store store;
        private readonly IPluginExecutionContext context;
        private readonly Producer producer;
        private readonly Policy policy;
        private List<Entity> definitions;
        private List<Entity> stages;
        private List<Entity> links;
        private List<Entity> transitions;
        private Entity definition;
        private Entity process;

        public Writer(Store store, IPluginExecutionContext context, Producer producer, Policy policy)
        { this.store = store; this.context = context; this.producer = producer; this.policy = policy; }

        public Receipt Execute(string action, Command c, bool trustedObserver)
        {
            Validate(c, action);
            if (c.ErrorCode != null && !producer.ErrorCodes.Contains(c.ErrorCode)) throw new ContractException("ErrorCodeNotAllowlisted");
            var intake = action == "rfd_RecordEmailProcessEvent" && c.EventType == "received";
            var weak = intake && string.IsNullOrWhiteSpace(c.InternetMessageId);
            if (weak && string.IsNullOrWhiteSpace(c.SourceLocator)) throw new ContractException("WeakCorrelationRequiresSourceLocator");
            var ingestKey = !intake ? null : weak ? Keys.Hash("weak-v1", Keys.Id(context.OrganizationId), "help-inbox",
                c.ProducerId, c.SourceExecutionId, c.SourceLocator, Keys.Id(c.EventId)) : Keys.Ingest(context.OrganizationId, c.InternetMessageId);
            if (intake)
            {
                if (!producer.CanReceive) throw new ContractException("IntakeNotAuthorized");
                process = store.Find(Tables.Process, "rfd_ingestkey", ingestKey, Tables.ProcessColumns.Concat(
                    new[] { "rfd_internetmessageid", "rfd_sourcelocator" }).ToArray());
                if (process != null)
                {
                    if (c.ProcessId.HasValue && c.ProcessId != process.Id) throw new ContractException("CorrelationConflict");
                    if ((!weak && Store.Text(process, "rfd_internetmessageid") != c.InternetMessageId.Trim()) ||
                        (!string.IsNullOrEmpty(c.SourceLocator) && Store.Text(process, "rfd_sourcelocator") != c.SourceLocator))
                        throw new ContractException("CorrelationAnomaly");
                }
            }
            else
            {
                if (!c.ProcessId.HasValue || c.ProcessId == Guid.Empty) throw new ContractException("ProcessIdRequired");
                process = store.Get(Tables.Process, c.ProcessId.Value, Tables.ProcessColumns);
            }
            var processId = process?.Id ?? c.ProcessId ?? Guid.NewGuid();
            if (action == "rfd_RecordCaseLifecycle")
            {
                if (!c.CaseId.HasValue) throw new ContractException("CaseIdRequired");
                var historical = trustedObserver && Trust.Captured(Trust.ObserverContext(context.ParentContext, policy, c.CaseId,
                    context.InitiatingUserId), out _, out _);
                if (historical) Trust.VerifyCapturedCase(context.ParentContext, policy, c, context.InitiatingUserId);
                else
                {
                    if (!trustedObserver && !producer.CanLinkCases) throw new ContractException("CaseReconciliationNotAuthorized");
                    // External callers can request only a current-state read, never assert historical state.
                    if (c.CaseState.HasValue || c.CaseStatus.HasValue || c.Merged.HasValue || c.PreviousCaseState.HasValue ||
                        c.PreviousCaseStatus.HasValue || c.SourceVersion != null) throw new ContractException("HistoricalCaseClaimsDenied");
                    CaptureCurrentCase(c, true);
                    c.ReconciliationRequired = true;
                }
                c.ProducerId = "case-observer";
                c.Operation = "case-lifecycle";
                c.SourceExecutionId = Keys.Id(c.CaseId.Value);
                c.EventType = "case-reconciled";
                if (historical) c.EventType = CaseEvent(c);
                c.EventId = Keys.StableGuid("case-event-v1", Keys.Id(processId), Keys.Id(c.CaseId.Value), c.SourceVersion, c.EventType);
            }
            var eventKey = Keys.Event(processId, c);
            var digest = Digest(c, processId);
            var byId = store.Find(Tables.Event, Tables.Event + "id", c.EventId, Tables.EventColumns);
            var bySource = store.Find(Tables.Event, "rfd_sourceeventkey", eventKey, Tables.EventColumns);
            if (byId != null && bySource != null && byId.Id != bySource.Id) throw new ContractException("EventIdentityConflict");
            var duplicate = byId ?? bySource;
            if (duplicate != null)
            {
                if (Store.Ref(duplicate, "rfd_process") != processId) throw new ContractException("EventScopeConflict");
                Reducer.CheckDigest(Store.Text(duplicate, "rfd_payloaddigest"), digest);
                return Receipt(duplicate, "AlreadyRecorded");
            }
            context.SharedVariables[ProcessApi.WriteMarker] = processId;
            if (process == null)
            {
                if (!c.DefinitionId.HasValue) throw new ContractException("DefinitionIdRequired");
                definition = store.Get(Tables.Definition, c.DefinitionId.Value, Tables.DefinitionColumns);
                if (Store.Text(definition, "rfd_state") != "published") throw new ContractException("PublishedDefinitionRequired");
                ValidateReferences(c, null);
                process = New(Tables.Process, processId, Keys.Id(processId));
                process["rfd_ingestkey"] = ingestKey;
                process["rfd_definition"] = definition.ToEntityReference();
                process["rfd_state"] = "received"; process["rfd_revision"] = 0;
                process["rfd_receivedat"] = c.OccurredAtUtc.UtcDateTime;
                process["rfd_lasteventat"] = c.OccurredAtUtc.UtcDateTime;
                process["rfd_coverage"] = "partial"; process["rfd_health"] = "current";
                if (!weak) process["rfd_internetmessageid"] = c.InternetMessageId.Trim();
                else
                {
                    process["rfd_weakcorrelation"] = true; process["rfd_correlationreason"] = "missing-internetmessageid";
                    process["rfd_reconciliationrequired"] = true;
                }
                Optional(process, "rfd_sourcelocator", c.SourceLocator);
                Optional(process, "rfd_actualfrom", c.ActualFrom); Optional(process, "rfd_replyto", c.ReplyTo);
                Lookup(process, "rfd_email", "email", c.EmailId);
                Lookup(process, "rfd_parentprocess", Tables.Process, c.ParentProcessId);
                Optional(process, "rfd_batchid", c.BatchId?.ToString("D")); Optional(process, "rfd_draftid", c.DraftId?.ToString("D"));
                store.Create(process);
                process = store.Get(Tables.Process, process.Id, Tables.ProcessColumns);
            }
            definition = definition ?? store.Get(Tables.Definition, Store.Ref(process, "rfd_definition").Value, Tables.DefinitionColumns);
            if (c.DefinitionId.HasValue && c.DefinitionId != definition.Id) throw new ContractException("DefinitionVersionConflict");
            definitions = store.Children(Tables.StageDefinition, "rfd_definition", definition.Id, 200, Tables.StageDefinitionColumns);
            transitions = store.Children(Tables.Transition, "rfd_definition", definition.Id, 500, Tables.TransitionColumns);
            stages = store.Children(Tables.Stage, "rfd_process", process.Id, 500, Tables.StageColumns);
            links = store.Children(Tables.Case, "rfd_process", process.Id, 100, Tables.CaseColumns);
            ValidateReferences(c, process);
            Guid? executionId = null;
            Entity newLink = null;
            if (action == "rfd_LinkEmailProcessCase")
            {
                if (!producer.CanLinkCases) throw new ContractException("CaseLinkNotAuthorized");
                newLink = LinkCase(c);
                executionId = Review(c, Store.CaseFact(newLink));
            }
            else if (action == "rfd_RecordCaseLifecycle") executionId = ApplyCase(c);
            else if (!intake) executionId = ApplyExecution(c);
            else executionId = ReceiveExecution(c);
            var resolvedContact = ValidateCustomerBinding(action, c, executionId);
            var revision = checked(Store.Int(process, "rfd_revision") + 1);
            var @event = New(Tables.Event, c.EventId, c.EventType);
            @event["rfd_process"] = process.ToEntityReference();
            Lookup(@event, "rfd_stageexecution", Tables.Stage, executionId);
            @event["rfd_sourceeventkey"] = eventKey; @event["rfd_payloaddigest"] = digest;
            @event["rfd_eventtype"] = c.EventType; Optional(@event, "rfd_stagecode", c.StageCode); Optional(@event, "rfd_outcome", c.Outcome);
            @event["rfd_occurredat"] = c.OccurredAtUtc.UtcDateTime; @event["rfd_recordedat"] = DateTime.UtcNow;
            @event["rfd_revision"] = revision; @event["rfd_schemaversion"] = 1;
            @event["rfd_producerid"] = c.ProducerId; @event["rfd_actor"] = new EntityReference("systemuser", context.InitiatingUserId);
            Optional(@event, "rfd_errorcode", c.ErrorCode); Optional(@event, "rfd_durationms", c.DurationMs); Optional(@event, "rfd_usage", c.Usage);
            Optional(@event, "rfd_sourceexecutionid", c.SourceExecutionId); Optional(@event, "rfd_sourceversion", c.SourceVersion);
            Lookup(@event, "rfd_case", "incident", c.CaseId); Lookup(@event, "rfd_contact", "contact", c.ContactId);
            Lookup(@event, "rfd_email", "email", c.EmailId); Lookup(@event, "rfd_task", "task", c.TaskId);
            Optional(@event, "rfd_noteid", c.NoteId?.ToString("D"));
            Lookup(@event, "rfd_holding", "rfd_financialaccount", c.HoldingId); Lookup(@event, "rfd_workflow", "workflow", c.WorkflowId);
            var replay = JObject.Parse(Json.Write(c));
            foreach (var field in new[] { "internetMessageId", "sourceLocator", "actualFrom", "replyTo", "cursor" }) replay.Remove(field);
            replay["processId"] = process.Id;
            @event["rfd_payloadjson"] = replay.ToString(Newtonsoft.Json.Formatting.None);
            Own(@event); store.Create(@event);
            if (newLink != null)
            {
                newLink["rfd_sourceevent"] = @event.ToEntityReference();
                Own(newLink); store.Create(newLink);
            }
            var requiredIds = new HashSet<Guid>(definitions.Where(d => Store.Bool(d, "rfd_required")).Select(d => d.Id));
            var missingBranch = false;
            foreach (var edge in transitions.Where(t => Store.Bool(t, "rfd_required")))
            {
                var branch = Store.Text(edge, "rfd_branchcode");
                if (stages.Any(s => Store.Ref(s, "rfd_stagedefinition") == Store.Ref(edge, "rfd_fromstage") &&
                    Store.Text(s, "rfd_state") == "succeeded" && (string.IsNullOrEmpty(branch) || Store.Text(s, "rfd_branch") == branch)))
                {
                    requiredIds.Add(Store.Ref(edge, "rfd_tostage").Value);
                    if (!string.IsNullOrEmpty(branch) && !stages.Where(s => Store.Ref(s, "rfd_stagedefinition") == Store.Ref(edge, "rfd_tostage") &&
                        Store.Text(s, "rfd_branch") == branch).GroupBy(s => Store.Ref(s, "rfd_case"))
                        .Any(g => Store.Text(g.OrderByDescending(s => Store.Int(s, "rfd_attempt")).First(), "rfd_state") == "succeeded"))
                        missingBranch = true;
                }
            }
            var required = definitions.Where(d => requiredIds.Contains(d.Id)).Select(d => Store.Text(d, "rfd_code"));
            var requiresCase = definitions.Any(d => Store.Bool(d, "rfd_requirescase") &&
                stages.Any(s => Store.Ref(s, "rfd_stagedefinition") == d.Id && Store.Text(s, "rfd_state") != "skipped"));
            var explicitCaseFreeRoute = definitions.Any(d => Store.Bool(d, "rfd_allowcasefreecompletion") &&
                stages.Any(s => Store.Ref(s, "rfd_stagedefinition") == d.Id && Store.Text(s, "rfd_state") == "succeeded"));
            var state = Reducer.Process(required, stages.Select(e => Store.Execution(e, StageCode(e))),
                links.Select(Store.CaseFact), Store.Bool(definition, "rfd_allowcasefreecompletion") && explicitCaseFreeRoute && !requiresCase,
                Store.Bool(process, "rfd_reconciliationrequired"));
            if (state == "completed" && missingBranch) state = "processing";
            var update = new Entity(Tables.Process, process.Id);
            update["rfd_state"] = state; update["rfd_revision"] = revision;
            if (resolvedContact.HasValue) update["rfd_contact"] = new EntityReference("contact", resolvedContact.Value);
            update["rfd_lasteventat"] = new[] { Store.Date(process, "rfd_lasteventat") ?? DateTime.MinValue, c.OccurredAtUtc.UtcDateTime }.Max();
            if (state == "needs-reconciliation") { update["rfd_health"] = "partial"; update["rfd_reconciliationrequired"] = true; }
            store.Update(process, update);
            return Receipt(@event, "Applied");
        }

        private Guid? ValidateCustomerBinding(string action, Command c, Guid? executionId)
        {
            if (!c.ContactId.HasValue) return null;
            if (action != "rfd_RecordEmailProcessEvent" || c.EventType != "completed" || producer.Authority != "tool" ||
                !producer.CanResolveCustomer || !producer.CustomerResolutionStageCodes.Contains(c.StageCode))
                throw new ContractException("CustomerResolutionCapabilityRequired");
            var stage = definitions.SingleOrDefault(d => Store.Text(d, "rfd_code") == c.StageCode);
            if (stage == null || Store.Text(stage, "rfd_phase") != "identify" || Store.Text(stage, "rfd_completionauthority") != "tool")
                throw new ContractException("CustomerResolutionIdentifyToolRequired");
            var execution = stages.SingleOrDefault(s => s.Id == executionId);
            if (execution == null || Store.Text(execution, "rfd_state") != "succeeded")
                throw new ContractException("SuccessfulCustomerLookupRequired");
            var latestVersion = Store.Text(execution, "rfd_sourceversion");
            if (!string.IsNullOrEmpty(c.SourceVersion) && !string.IsNullOrEmpty(latestVersion) &&
                Keys.Version(c.SourceVersion) < Keys.Version(latestVersion))
                throw new ContractException("StaleCustomerResolution");
            var existing = Store.Ref(process, "rfd_contact");
            if (existing.HasValue && existing != c.ContactId) throw new ContractException("ProcessContactConflict");
            return c.ContactId;
        }

        private void Own(Entity row)
        {
            var owner = process?.GetAttributeValue<EntityReference>("ownerid");
            if (owner != null) row["ownerid"] = owner;
        }
        private string StageCode(Entity e) => Store.Text(definitions.Single(d => d.Id == Store.Ref(e, "rfd_stagedefinition")), "rfd_code");
        private static Entity New(string table, Guid id, string name) => new Entity(table, id) { ["rfd_name"] = name };
        private static void Optional(Entity entity, string name, object value) { if (value != null) entity[name] = value; }
        private static void Lookup(Entity e, string name, string table, Guid? id) { if (id.HasValue) e[name] = new EntityReference(table, id.Value); }
        private static Receipt Receipt(Entity e, string status) => new Receipt { ProcessId = Store.Ref(e, "rfd_process").Value,
            EventId = e.Id, Revision = Store.Int(e, "rfd_revision"), Status = status };
        private static string Digest(Command c, Guid processId)
        {
            var payload = JObject.Parse(Json.Write(c));
            payload.Remove("eventId"); payload.Remove("cursor"); payload.Remove("pageSize"); payload.Remove("reconciliationRequired");
            payload["processId"] = Keys.Id(processId);
            if (c.InternetMessageId != null) payload["internetMessageId"] = c.InternetMessageId.Trim();
            return Keys.Hash("payload-v1", payload.ToString(Newtonsoft.Json.Formatting.None));
        }

        private static void Validate(Command c, string action)
        {
            if (c.State != null || c.Cursor != null || c.PageSize != 50) throw new ContractException("ReadFieldsNotAllowedInWrites");
            if (new[] { c.ProcessId, c.DefinitionId, c.CaseId, c.ContactId, c.EmailId, c.TaskId, c.NoteId,
                c.ParentProcessId, c.ParentExecutionId, c.StageExecutionId, c.BatchId, c.DraftId, c.HoldingId, c.WorkflowId }.Any(id => id == Guid.Empty))
                throw new ContractException("EmptyIdentifier");
            if (c.EventId == Guid.Empty && action != "rfd_RecordCaseLifecycle") throw new ContractException("StableEventIdRequired");
            if (c.OccurredAtUtc == default || c.OccurredAtUtc.Offset != TimeSpan.Zero ||
                c.OccurredAtUtc > DateTimeOffset.UtcNow.AddMinutes(5)) throw new ContractException("OccurredAtUtcRequired");
            foreach (var v in new[] { c.ProducerId, c.SourceExecutionId, c.Operation })
                if (string.IsNullOrWhiteSpace(v) && action != "rfd_RecordCaseLifecycle") throw new ContractException("StableSourceIdentityRequired");
            foreach (var v in new[] { c.ProducerId, c.Operation, c.StageCode, c.SourceVersion, c.ErrorCode, c.Outcome, c.RelationshipRole })
                if (v != null && (v.Length > 80 || v.Any(ch => !(char.IsLetterOrDigit(ch) || "-_.:/".Contains(ch)))))
                    throw new ContractException("InvalidCode");
            if (c.Branch != null && (c.Branch.Length > 80 || c.Branch.Any(char.IsControl)))
                throw new ContractException("InvalidBranchCode");
            if (c.SourceExecutionId?.Length > 200 || c.InternetMessageId?.Length > 2000 || c.SourceLocator?.Length > 2000 ||
                c.ActualFrom?.Length > 320 || c.ReplyTo?.Length > 320 ||
                c.DurationMs < 0 || c.DurationMs > 31536000000m || c.Usage < 0 || c.Attempt < 0) throw new ContractException("ValueOutOfRange");
            if (action == "rfd_LinkEmailProcessCase") c.EventType = "case-linked";
            if (action == "rfd_RecordEmailProcessEvent" && !new[] { "received", "started", "waiting", "completed", "failed", "skipped", "cancelled" }.Contains(c.EventType))
                throw new ContractException("EventTypeNotAllowed");
            if (action != "rfd_RecordCaseLifecycle" && (c.CaseState.HasValue || c.CaseStatus.HasValue ||
                c.PreviousCaseState.HasValue || c.PreviousCaseStatus.HasValue || c.Merged.HasValue || c.ReconciliationRequired))
                throw new ContractException("CaseClaimsReservedForObserver");
            if (c.EventType != "received" && (c.InternetMessageId != null || c.SourceLocator != null || c.ActualFrom != null || c.ReplyTo != null))
                throw new ContractException("IntakeMetadataOnly");
            if (c.EventType == "received" && (c.StageExecutionId.HasValue || c.ParentExecutionId.HasValue || c.StageCode != null || c.CaseId.HasValue))
                throw new ContractException("IntakeExecutionDerivedByServer");
            if (c.ContactId.HasValue && (action != "rfd_RecordEmailProcessEvent" || c.EventType != "completed"))
                throw new ContractException("CustomerBindingRequiresIdentifyExecution");
            if (action != "rfd_RecordEmailProcessEvent" && (c.StageExecutionId.HasValue || c.ParentExecutionId.HasValue || c.StageCode != null))
                throw new ContractException("CaseExecutionDerivedByServer");
            var expected = c.EventType == "completed" ? "succeeded" : c.EventType == "started" ? "running" : c.EventType;
            if (c.Outcome != null && c.Outcome != expected) throw new ContractException("OutcomeMismatch");
            if (!string.IsNullOrEmpty(c.SourceVersion)) Keys.Version(c.SourceVersion);
        }

        private void ValidateReferences(Command c, Entity existing)
        {
            foreach (var reference in new[] { Tuple.Create("contact", c.ContactId), Tuple.Create("email", c.EmailId),
                Tuple.Create("task", c.TaskId), Tuple.Create(Tables.Process, c.ParentProcessId),
                Tuple.Create("rfd_financialaccount", c.HoldingId), Tuple.Create("workflow", c.WorkflowId) })
                if (reference.Item2.HasValue) store.Get(reference.Item1, reference.Item2.Value, reference.Item1 + "id");
            if (c.NoteId.HasValue)
            {
                if (!c.CaseId.HasValue) throw new ContractException("NoteCaseReferenceRequired");
                var note = store.Get("annotation", c.NoteId.Value, "annotationid", "objectid");
                var regarding = note.GetAttributeValue<EntityReference>("objectid");
                if (regarding?.LogicalName != "incident" || regarding.Id != c.CaseId)
                    throw new ContractException("NoteRegardingCaseMismatch");
            }
            if (c.CaseId.HasValue && existing != null)
            {
                var incident = store.Get("incident", c.CaseId.Value, "customerid");
                var contact = Store.Ref(existing, "rfd_contact");
                var alreadyLinked = links?.Any(l => Store.Ref(l, "rfd_case") == c.CaseId) == true;
                if (!alreadyLinked && (!contact.HasValue || Store.Ref(incident, "customerid") != contact))
                    throw new ContractException("UnrelatedCase");
            }
        }

        private Guid ApplyExecution(Command c)
        {
            if (!c.StageExecutionId.HasValue || c.StageExecutionId == Guid.Empty || c.Attempt < 1 || string.IsNullOrEmpty(c.StageCode))
                throw new ContractException("ExecutionIdentityRequired");
            if (!producer.StageCodes.Contains(c.StageCode)) throw new ContractException("StageNotAuthorized");
            var stageDef = definitions.SingleOrDefault(d => Store.Text(d, "rfd_code") == c.StageCode);
            if (stageDef == null) throw new ContractException("UnknownStage");
            if (c.EventType == "completed" && Store.Text(stageDef, "rfd_completionauthority") != producer.Authority)
                throw new ContractException("BusinessOutcomeAuthorityRequired");
            if (c.EventType == "skipped" && Store.Bool(stageDef, "rfd_required")) throw new ContractException("RequiredStageCannotSkip");
            var routingStage = Store.Text(stageDef, "rfd_phase") == "route" ||
                new[] { "gateway", "decision" }.Contains(Store.Text(stageDef, "rfd_nodekind"));
            var outgoingBranches = routingStage ? transitions.Where(t => Store.Ref(t, "rfd_fromstage") == stageDef.Id &&
                !string.IsNullOrEmpty(Store.Text(t, "rfd_branchcode")) && Store.Text(t, "rfd_eventcode") != "case-linked")
                .Select(t => Store.Text(t, "rfd_branchcode")).ToList() : new List<string>();
            if (c.EventType == "completed" && outgoingBranches.Count > 0 && !outgoingBranches.Contains(c.Branch))
                throw new ContractException("AllowlistedBranchSelectionRequired");
            if (c.CaseId.HasValue && !links.Any(l => Store.Ref(l, "rfd_case") == c.CaseId))
                throw new ContractException("ExplicitCaseLinkRequired");
            if (c.ParentExecutionId.HasValue && !stages.Any(s => s.Id == c.ParentExecutionId))
                throw new ContractException("ParentExecutionScopeMismatch");
            var operationKey = Keys.Operation(process.Id, c);
            var original = stages.SingleOrDefault(s => s.Id == c.StageExecutionId || Store.Text(s, "rfd_sourceoperationkey") == operationKey);
            if (original != null && (original.Id != c.StageExecutionId || Store.Text(original, "rfd_sourceoperationkey") != operationKey ||
                Store.Ref(original, "rfd_case") != c.CaseId || Store.Ref(original, "rfd_parentexecution") != c.ParentExecutionId ||
                Store.Ref(original, "rfd_workflow") != c.WorkflowId))
                throw new ContractException("ExecutionIdentityConflict");
            var executionOrdinal = original == null ? 0 : Store.Int(original, "rfd_attempt");
            if (original == null)
            {
                if (stages.Count >= 500) throw new ContractException("ExecutionLimitReached");
                // Source attempt belongs to the native run and remains part of the stable hash.
                // The projection ordinal is allocated server-side under the process RowVersion lock.
                var maximumOrdinal = stages.Where(s => Store.Ref(s, "rfd_stagedefinition") == stageDef.Id &&
                    (Store.Text(s, "rfd_branch") ?? "") == (c.Branch ?? "") && Store.Ref(s, "rfd_case") == c.CaseId)
                    .Select(s => Store.Int(s, "rfd_attempt")).DefaultIfEmpty(0).Max();
                executionOrdinal = checked(maximumOrdinal + 1);
            }
            if (original == null || c.EventType == "completed")
            {
                var inbound = transitions.Where(e => Store.Ref(e, "rfd_tostage") == stageDef.Id && Store.Bool(e, "rfd_required")).ToList();
                var applicable = inbound.Where(e => string.IsNullOrEmpty(Store.Text(e, "rfd_branchcode")) ||
                    Store.Text(e, "rfd_branchcode") == c.Branch).ToList();
                if (inbound.Count > 0 && applicable.Count == 0) throw new ContractException("BranchScopeNotAllowed");
                foreach (var edge in applicable)
                {
                    var branch = Store.Text(edge, "rfd_branchcode");
                    var predecessors = stages.Where(s => Store.Ref(s, "rfd_stagedefinition") == Store.Ref(edge, "rfd_fromstage") &&
                        (string.IsNullOrEmpty(branch) || Store.Text(s, "rfd_branch") == branch))
                        .GroupBy(s => (Store.Text(s, "rfd_branch") ?? "") + ":" + Store.Ref(s, "rfd_case"))
                        .Select(g => g.OrderByDescending(s => Store.Int(s, "rfd_attempt")).First()).ToList();
                    if (predecessors.Count == 0 || predecessors.Any(s => Store.Text(s, "rfd_state") != "succeeded"))
                        throw new ContractException("RequiredPredecessorNotSatisfied");
                }
            }
            var row = original ?? New(Tables.Stage, c.StageExecutionId.Value, c.StageCode);
            var execution = original == null ? new Execution { Id = row.Id, StageCode = c.StageCode } : Store.Execution(row, c.StageCode);
            Reducer.Apply(execution, c.EventType, c.OccurredAtUtc.UtcDateTime, c.SourceVersion);
            var write = new Entity(Tables.Stage, row.Id);
            write["rfd_state"] = execution.State; Optional(write, "rfd_startedat", execution.StartedAt);
            Optional(write, "rfd_endedat", execution.EndedAt); Optional(write, "rfd_sourceversion", execution.SourceVersion);
            if (c.DurationMs.HasValue && Reducer.IsTerminal(execution.State) && c.EventType != "started" && c.EventType != "waiting" &&
                (string.IsNullOrEmpty(c.SourceVersion) || string.IsNullOrEmpty(execution.SourceVersion) ||
                 Keys.Version(c.SourceVersion) >= Keys.Version(execution.SourceVersion)))
            { write["rfd_durationms"] = c.DurationMs.Value; write["rfd_durationprovenance"] = "producer-reported"; }
            if (original == null)
            {
                write["rfd_name"] = c.StageCode; write["rfd_process"] = process.ToEntityReference();
                write["rfd_stagedefinition"] = stageDef.ToEntityReference(); write["rfd_sourceoperationkey"] = operationKey;
                write["rfd_attempt"] = executionOrdinal; Optional(write, "rfd_branch", c.Branch);
                write["rfd_sourceexecutionid"] = c.SourceExecutionId; write["rfd_operation"] = c.Operation; write["rfd_producerid"] = c.ProducerId;
                Lookup(write, "rfd_case", "incident", c.CaseId); Lookup(write, "rfd_parentexecution", Tables.Stage, c.ParentExecutionId);
                Lookup(write, "rfd_workflow", "workflow", c.WorkflowId);
                Own(write); store.Create(write); stages.Add(write);
            }
            else
            {
                store.Update(original, write);
                foreach (var pair in write.Attributes) original[pair.Key] = pair.Value;
            }
            return row.Id;
        }

        private Guid? ReceiveExecution(Command c)
        {
            var intake = definitions.SingleOrDefault(d => Store.Text(d, "rfd_completionauthority") == "intake");
            if (intake == null) return null;
            var previous = stages.SingleOrDefault(s => Store.Ref(s, "rfd_stagedefinition") == intake.Id);
            if (previous != null) return previous.Id;
            if (stages.Count >= 500) throw new ContractException("ExecutionLimitReached");
            var id = Keys.StableGuid("intake-v1", Keys.Id(process.Id));
            var row = New(Tables.Stage, id, Store.Text(intake, "rfd_code"));
            row["rfd_process"] = process.ToEntityReference(); row["rfd_stagedefinition"] = intake.ToEntityReference();
            row["rfd_sourceoperationkey"] = Keys.Hash("intake-v1", Keys.Id(process.Id));
            row["rfd_attempt"] = 1; row["rfd_state"] = "succeeded"; row["rfd_startedat"] = c.OccurredAtUtc.UtcDateTime;
            row["rfd_endedat"] = c.OccurredAtUtc.UtcDateTime; row["rfd_sourceexecutionid"] = c.SourceExecutionId;
            row["rfd_producerid"] = c.ProducerId; row["rfd_operation"] = c.Operation;
            Lookup(row, "rfd_workflow", "workflow", c.WorkflowId);
            Own(row); store.Create(row); stages.Add(row);
            return id;
        }

        private void CaptureCurrentCase(Command c, bool setOccurred = false)
        {
            if (!c.CaseId.HasValue) throw new ContractException("CaseIdRequired");
            var incident = store.Get("incident", c.CaseId.Value, "statecode", "statuscode", "merged", "versionnumber", "modifiedon");
            c.CaseState = incident.GetAttributeValue<OptionSetValue>("statecode")?.Value;
            c.CaseStatus = incident.GetAttributeValue<OptionSetValue>("statuscode")?.Value;
            c.Merged = incident.GetAttributeValue<bool>("merged");
            c.SourceVersion = incident.RowVersion ?? (incident.Contains("versionnumber") ? incident["versionnumber"].ToString() : null);
            Keys.Version(c.SourceVersion);
            if (!c.CaseState.HasValue || !c.CaseStatus.HasValue) throw new ContractException("CaseStateUnavailable");
            if (setOccurred)
            {
                if (!incident.Contains("modifiedon")) throw new ContractException("CaseTimestampUnavailable");
                c.OccurredAtUtc = new DateTimeOffset(DateTime.SpecifyKind(incident.GetAttributeValue<DateTime>("modifiedon"), DateTimeKind.Utc));
            }
        }
        private Entity LinkCase(Command c)
        {
            if (!c.CaseId.HasValue || string.IsNullOrEmpty(c.RelationshipRole)) throw new ContractException("CaseRelationshipRequired");
            var prior = links.SingleOrDefault(l => Store.Ref(l, "rfd_case") == c.CaseId);
            if (prior != null)
            {
                if (Store.Bool(prior, "rfd_blockscompletion") != c.BlocksCompletion || Store.Text(prior, "rfd_role") != c.RelationshipRole)
                    throw new ContractException("CaseLinkConflict");
                throw new ContractException("CaseAlreadyLinkedUseLifecycleReconciliation");
            }
            if (links.Count >= 100) throw new ContractException("CaseLinkLimitReached");
            CaptureCurrentCase(c);
            var row = New(Tables.Case, Guid.NewGuid(), "case-link");
            row["rfd_process"] = process.ToEntityReference(); row["rfd_case"] = new EntityReference("incident", c.CaseId.Value);
            row["rfd_role"] = c.RelationshipRole; row["rfd_blockscompletion"] = c.BlocksCompletion;
            row["rfd_linkedat"] = c.OccurredAtUtc.UtcDateTime;
            CaseColumns(row, c); links.Add(row);
            return row;
        }
        private Guid? ApplyCase(Command c)
        {
            var link = links.SingleOrDefault(l => Store.Ref(l, "rfd_case") == c.CaseId);
            if (link == null) throw new ContractException("ExplicitCaseLinkRequired");
            if (!c.CaseState.HasValue || !c.CaseStatus.HasValue || !c.Merged.HasValue || c.CaseState < 0 || c.CaseState > 2)
                throw new ContractException("CapturedCaseStateRequired");
            var fact = Store.CaseFact(link);
            var next = new CaseFact { State = c.CaseState.Value, Status = c.CaseStatus.Value, Merged = c.Merged.Value,
                Version = c.SourceVersion, ReconciliationRequired = c.ReconciliationRequired };
            var applied = Reducer.ApplyCase(fact, next);
            if (!applied && !fact.ReconciliationRequired) return null;
            var update = new Entity(Tables.Case, link.Id);
            update["rfd_casestate"] = fact.State; update["rfd_casestatus"] = fact.Status;
            update["rfd_caseversion"] = fact.Version; update["rfd_merged"] = fact.Merged; update["rfd_reconciliationrequired"] = fact.ReconciliationRequired;
            store.Update(link, update);
            foreach (var pair in update.Attributes) link[pair.Key] = pair.Value;
            if (!applied || !Store.Bool(link, "rfd_blockscompletion")) return null;
            return Review(c, fact);
        }
        private Guid? Review(Command c, CaseFact fact)
        {
            if (!fact.BlocksCompletion) return null;
            var review = definitions.SingleOrDefault(d => Store.Text(d, "rfd_completionauthority") == "case-observer");
            if (review == null)
            {
                process["rfd_reconciliationrequired"] = true;
                return null;
            }
            var previous = stages.Where(s => Store.Ref(s, "rfd_case") == c.CaseId && Store.Ref(s, "rfd_stagedefinition") == review.Id)
                .OrderByDescending(s => Store.Int(s, "rfd_attempt")).FirstOrDefault();
            var state = fact.Merged || fact.State == 2 ? "cancelled" : fact.State == 1 ? "succeeded" : "waiting";
            if (previous != null && !Reducer.IsTerminal(Store.Text(previous, "rfd_state")))
            {
                var update = new Entity(Tables.Stage, previous.Id) { ["rfd_state"] = state, ["rfd_sourceversion"] = c.SourceVersion };
                if (fact.State != 0) update["rfd_endedat"] = c.OccurredAtUtc.UtcDateTime;
                store.Update(previous, update);
                foreach (var pair in update.Attributes) previous[pair.Key] = pair.Value;
                return previous.Id;
            }
            if (previous != null && fact.State != 0 && Store.Text(previous, "rfd_state") == state) return previous.Id;
            if (stages.Count >= 500) throw new ContractException("ExecutionLimitReached");
            var id = Keys.StableGuid("case-review-v1", Keys.Id(process.Id), Keys.Id(c.CaseId.Value), c.SourceVersion);
            var attempt = previous == null ? 1 : Store.Int(previous, "rfd_attempt") + 1;
            var row = New(Tables.Stage, id, Store.Text(review, "rfd_code"));
            row["rfd_process"] = process.ToEntityReference(); row["rfd_stagedefinition"] = review.ToEntityReference();
            row["rfd_sourceoperationkey"] = Keys.Hash("case-review-v1", Keys.Id(process.Id), Keys.Id(c.CaseId.Value), c.SourceVersion);
            row["rfd_case"] = new EntityReference("incident", c.CaseId.Value); row["rfd_attempt"] = attempt;
            row["rfd_state"] = state;
            row["rfd_sourceversion"] = c.SourceVersion; row["rfd_producerid"] = "case-observer";
            row["rfd_startedat"] = c.OccurredAtUtc.UtcDateTime;
            if (fact.State != 0) row["rfd_endedat"] = c.OccurredAtUtc.UtcDateTime;
            Own(row); store.Create(row); stages.Add(row);
            return id;
        }
        private static void CaseColumns(Entity row, Command c)
        {
            row["rfd_casestate"] = c.CaseState.Value; row["rfd_casestatus"] = c.CaseStatus.Value;
            row["rfd_caseversion"] = c.SourceVersion; row["rfd_merged"] = c.Merged.Value;
            row["rfd_reconciliationrequired"] = c.ReconciliationRequired;
        }
        private static string CaseEvent(Command c) => c.Merged == true ? "case-merged" : c.CaseState == 1 ? "case-resolved" :
            c.CaseState == 2 ? "case-cancelled" : c.PreviousCaseState != 0 ? "case-reopened" : "case-reconciled";
    }
}
