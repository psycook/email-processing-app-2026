using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace EmailProcess.Plugin
{
    public static class Trust
    {
        public static IPluginExecutionContext ObserverContext(IPluginExecutionContext parent, Policy policy, Guid? caseId, Guid actor)
        {
            for (var current = parent; current != null; current = current.ParentContext)
                if (current.MessageName == "Update" && current.PrimaryEntityName == "incident" && current.Stage == 40 &&
                    current.Mode == 1 && current.InitiatingUserId == actor && current.UserId == actor &&
                    current.OwningExtension != null && policy.ObserverStepIds.Contains(current.OwningExtension.Id) &&
                    current.InputParameters.Contains("Target") && current.InputParameters["Target"] is Entity target &&
                    target.LogicalName == "incident" && target.Id == caseId) return current;
            return null;
        }
        public static bool Observer(IPluginExecutionContext parent, Policy policy, Guid? caseId, Guid actor)
            => ObserverContext(parent, policy, caseId, actor) != null;

        public static bool Captured(IPluginExecutionContext observer, out Entity pre, out Entity post)
        {
            pre = observer.PreEntityImages.Contains("PreImage") ? observer.PreEntityImages["PreImage"] : null;
            post = observer.PostEntityImages.Contains("PostImage") ? observer.PostEntityImages["PostImage"] : null;
            return pre != null && post != null && pre.Contains("statecode") && pre.Contains("statuscode") &&
                post.Contains("statecode") && post.Contains("statuscode") && post.Contains("versionnumber") && post.Contains("merged");
        }
        public static void VerifyCapturedCase(IPluginExecutionContext parent, Policy policy, Command c, Guid actor)
        {
            var observer = ObserverContext(parent, policy, c.CaseId, actor);
            if (observer == null || !Captured(observer, out var pre, out var post)) throw new ContractException("CapturedCaseImagesRequired");
            if (c.CaseState != post.GetAttributeValue<OptionSetValue>("statecode").Value ||
                c.CaseStatus != post.GetAttributeValue<OptionSetValue>("statuscode").Value ||
                c.PreviousCaseState != pre.GetAttributeValue<OptionSetValue>("statecode").Value ||
                c.PreviousCaseStatus != pre.GetAttributeValue<OptionSetValue>("statuscode").Value ||
                c.SourceVersion != post["versionnumber"].ToString() || c.Merged != post.GetAttributeValue<bool>("merged") ||
                c.OccurredAtUtc.UtcDateTime != DateTime.SpecifyKind(observer.OperationCreatedOn, DateTimeKind.Utc))
                throw new ContractException("CapturedCaseContextMismatch");
        }
        public static Guid? WriteScope(IPluginExecutionContext parent, Guid actor)
        {
            for (var current = parent; current != null; current = current.ParentContext)
                if (current.Stage == 30 && current.IsInTransaction && current.UserId == actor && current.InitiatingUserId == actor &&
                    ProcessApi.WriteActions.Contains(current.MessageName) &&
                    current.SharedVariables.Contains(ProcessApi.WriteMarker) && current.SharedVariables[ProcessApi.WriteMarker] is Guid process)
                    return process;
            return null;
        }
    }

    public sealed class TableGuard : IPlugin
    {
        private readonly Policy policy;
        public TableGuard() : this(null, null) { }
        public TableGuard(string unsecure, string secure) { policy = Policy.Load(secure); }
        public void Execute(IServiceProvider provider)
        {
            var c = (IPluginExecutionContext)provider.GetService(typeof(IPluginExecutionContext));
            var factory = (IOrganizationServiceFactory)provider.GetService(typeof(IOrganizationServiceFactory));
            var store = new Store(factory.CreateOrganizationService(c.InitiatingUserId));
            try
            {
                if (c.Stage != 20 || c.UserId != c.InitiatingUserId) throw new ContractException("GuardRegistrationInvalid");
                if (Tables.Runtime.Contains(c.PrimaryEntityName)) GuardRuntime(c, store);
                else if (Tables.Configuration.Contains(c.PrimaryEntityName)) GuardDefinition(c, store);
                else throw new ContractException("GuardTableNotAllowed");
            }
            catch (ContractException error) { throw new InvalidPluginExecutionException(error.Message); }
        }
        private static void GuardRuntime(IPluginExecutionContext c, Store store)
        {
            if ((c.PrimaryEntityName == Tables.Event && c.MessageName != "Create") || c.MessageName == "Delete")
                throw new ContractException("AppendOnlyLedger");
            if (c.MessageName != "Create" && c.MessageName != "Update") throw new ContractException("DirectMutationDenied");
            var scope = Trust.WriteScope(c.ParentContext, c.InitiatingUserId);
            if (!scope.HasValue || !c.InputParameters.Contains("Target") || !(c.InputParameters["Target"] is Entity target))
                throw new ContractException("TrustedProcessApiRequired");
            if (target.LogicalName != c.PrimaryEntityName) throw new ContractException("TargetMismatch");
            if (target.LogicalName == Tables.Process)
            {
                if (target.Id != scope) throw new ContractException("WriteScopeMismatch");
                if (c.MessageName == "Update" && target.Contains("rfd_definition")) throw new ContractException("DefinitionImmutable");
                if (c.MessageName == "Create" && (string.IsNullOrEmpty(Store.Text(target, "rfd_ingestkey")) ||
                    Store.Text(target, "rfd_ingestkey").Length != 64)) throw new ContractException("IngestKeyRequired");
            }
            else
            {
                var process = c.MessageName == "Create" ? Store.Ref(target, "rfd_process") :
                    Store.Ref(store.Get(target.LogicalName, target.Id, "rfd_process"), "rfd_process");
                if (process != scope || (target.Contains("rfd_process") && Store.Ref(target, "rfd_process") != scope))
                    throw new ContractException("WriteScopeMismatch");
                if (c.MessageName == "Create" && (target.LogicalName == Tables.Stage || target.LogicalName == Tables.Event))
                {
                    var key = Store.Text(target, target.LogicalName == Tables.Stage ? "rfd_sourceoperationkey" : "rfd_sourceeventkey");
                    if (key == null || key.Length != 64) throw new ContractException("SourceKeyRequired");
                }
            }
            if (c.MessageName == "Update" && target.Contains("ownerid")) throw new ContractException("OwnershipPolicyImmutable");
        }
        private void GuardDefinition(IPluginExecutionContext c, Store store)
        {
            if (!policy.DefinitionAdministratorUserIds.Contains(c.InitiatingUserId)) throw new ContractException("DefinitionAdministratorRequired");
            if (!new[] { "Create", "Update", "Delete" }.Contains(c.MessageName)) throw new ContractException("DefinitionMutationDenied");
            var target = c.InputParameters.Contains("Target") ? c.InputParameters["Target"] : null;
            var entity = target as Entity;
            var reference = target as EntityReference;
            var id = entity?.Id ?? reference?.Id ?? Guid.Empty;
            Entity prior = c.MessageName == "Create" ? null : store.Get(c.PrimaryEntityName, id,
                c.PrimaryEntityName == Tables.Definition ? Tables.DefinitionColumns : new[] { "rfd_definition", "rfd_code" });
            if (c.MessageName != "Delete")
            {
                var code = entity.Contains("rfd_code") ? Store.Text(entity, "rfd_code") : prior == null ? null : Store.Text(prior, "rfd_code");
                if (string.IsNullOrWhiteSpace(code) || code.Length > 80 || code.Any(ch => !(char.IsLetterOrDigit(ch) || "-_.".Contains(ch))))
                    throw new ContractException("DefinitionCodeRequired");
                if (c.PrimaryEntityName == Tables.Definition)
                {
                    var version = entity.Contains("rfd_version") ? Store.Int(entity, "rfd_version") : prior == null ? 0 : Store.Int(prior, "rfd_version");
                    if (version < 1) throw new ContractException("PositiveDefinitionVersionRequired");
                }
            }
            if (c.PrimaryEntityName == Tables.Definition)
            {
                if (prior != null && (Store.Text(prior, "rfd_state") != "draft" ||
                    store.Find(Tables.Process, "rfd_definition", id, Tables.Process + "id") != null))
                    throw new ContractException("PublishedOrUsedDefinitionImmutable");
                if (c.MessageName == "Create" && Store.Text(entity, "rfd_state") != "draft") throw new ContractException("CreateDraftFirst");
                if (entity?.Contains("rfd_state") == true && !new[] { "draft", "published" }.Contains(Store.Text(entity, "rfd_state")))
                    throw new ContractException("InvalidDefinitionState");
                if (entity != null && Store.Text(entity, "rfd_state") == "published") ValidatePublication(store, id);
            }
            else
            {
                var oldDefinition = prior == null ? null : Store.Ref(prior, "rfd_definition");
                var newDefinition = entity != null && entity.Contains("rfd_definition") ? Store.Ref(entity, "rfd_definition") : oldDefinition;
                foreach (var definitionId in new[] { oldDefinition, newDefinition }.Where(d => d.HasValue).Distinct())
                {
                    var definition = store.Get(Tables.Definition, definitionId.Value, "rfd_state");
                    if (Store.Text(definition, "rfd_state") != "draft") throw new ContractException("PublishedOrUsedDefinitionImmutable");
                }
                if (!newDefinition.HasValue) throw new ContractException("DefinitionRequired");
            }
        }
        private static void ValidatePublication(Store store, Guid id)
        {
            var stages = store.Children(Tables.StageDefinition, "rfd_definition", id, 200, Tables.StageDefinitionColumns);
            if (stages.Count == 0 || !stages.Any(s => Store.Bool(s, "rfd_required"))) throw new ContractException("RequiredStagesMissing");
            if (stages.Count(s => Store.Text(s, "rfd_completionauthority") == "case-observer") > 1)
                throw new ContractException("SingleCaseReviewStageRequired");
            if (stages.Count(s => Store.Text(s, "rfd_completionauthority") == "intake") > 1)
                throw new ContractException("SingleIntakeStageRequired");
            foreach (var stage in stages)
            {
                if (!new[] { "workflow", "tool", "intake", "case-observer" }.Contains(Store.Text(stage, "rfd_completionauthority")))
                    throw new ContractException("CompletionAuthorityRequired");
                if (Store.Bool(stage, "rfd_allowcasefreecompletion") &&
                    (Store.Bool(stage, "rfd_requirescase") || Store.Text(stage, "rfd_completionauthority") == "intake" ||
                     Store.Text(stage, "rfd_completionauthority") == "case-observer"))
                    throw new ContractException("InvalidCaseFreeRoutePolicy");
            }
            var edges = store.Children(Tables.Transition, "rfd_definition", id, 500, Tables.TransitionColumns);
            foreach (var edge in edges)
                if (!stages.Any(s => s.Id == Store.Ref(edge, "rfd_fromstage")) || !stages.Any(s => s.Id == Store.Ref(edge, "rfd_tostage")))
                    throw new ContractException("TransitionDefinitionMismatch");
        }
    }

    public sealed class CaseLifecycleObserver : IPlugin
    {
        private readonly Policy policy;
        public CaseLifecycleObserver() : this(null, null) { }
        public CaseLifecycleObserver(string unsecure, string secure) { policy = Policy.Load(secure); }
        public void Execute(IServiceProvider provider)
        {
            var context = (IPluginExecutionContext)provider.GetService(typeof(IPluginExecutionContext));
            var trace = (ITracingService)provider.GetService(typeof(ITracingService));
            if (context.Mode != 1 || context.Stage != 40 || context.MessageName != "Update" ||
                context.PrimaryEntityName != "incident" || context.UserId != context.InitiatingUserId)
                throw new InvalidPluginExecutionException("ObserverMustBeAsyncPostOperationCallingUser");
            if (context.OwningExtension == null || !policy.ObserverStepIds.Contains(context.OwningExtension.Id))
                throw new InvalidPluginExecutionException("ObserverStepNotConfigured");
            var captured = Trust.Captured(context, out var pre, out var post);
            if (!captured)
            {
                trace?.Trace("RECONCILIATION_REQUIRED: case {0}, correlation {1}, missing captured images/version; no historical claim emitted.",
                    context.PrimaryEntityId, context.CorrelationId);
            }
            int? oldState = captured ? pre.GetAttributeValue<OptionSetValue>("statecode").Value : (int?)null;
            int? oldStatus = captured ? pre.GetAttributeValue<OptionSetValue>("statuscode").Value : (int?)null;
            int? newState = captured ? post.GetAttributeValue<OptionSetValue>("statecode").Value : (int?)null;
            int? newStatus = captured ? post.GetAttributeValue<OptionSetValue>("statuscode").Value : (int?)null;
            if (captured && oldState == newState && oldStatus == newStatus && pre.GetAttributeValue<bool>("merged") == post.GetAttributeValue<bool>("merged")) return;
            var factory = (IOrganizationServiceFactory)provider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.InitiatingUserId);
            var query = new QueryExpression(Tables.Case) { ColumnSet = new ColumnSet("rfd_process"), TopCount = 51 };
            query.Criteria.AddCondition("rfd_case", ConditionOperator.Equal, context.PrimaryEntityId);
            query.AddOrder(Tables.Case + "id", OrderType.Ascending);
            try
            {
                var rows = service.RetrieveMultiple(query).Entities;
                var overflow = rows.Count > 50;
                foreach (var link in rows.Take(50))
                {
                    var c = new Command { SchemaVersion = 1, ProducerId = "case-observer", ProcessId = Store.Ref(link, "rfd_process"),
                        CaseId = context.PrimaryEntityId, CaseState = newState, CaseStatus = newStatus,
                        PreviousCaseState = oldState, PreviousCaseStatus = oldStatus,
                        Merged = captured ? post.GetAttributeValue<bool>("merged") : (bool?)null,
                        SourceVersion = captured ? post["versionnumber"].ToString() : null,
                        OccurredAtUtc = new DateTimeOffset(DateTime.SpecifyKind(context.OperationCreatedOn, DateTimeKind.Utc)),
                        ReconciliationRequired = overflow || !captured };
                    service.Execute(new OrganizationRequest("rfd_RecordCaseLifecycle") { ["RequestJson"] = Json.Write(c) });
                }
                if (overflow)
                {
                    trace?.Trace("RECONCILIATION_REQUIRED: case {0}, version {1}, fanout exceeds 50; use authorized paged reconciliation worker.",
                        context.PrimaryEntityId, captured ? post["versionnumber"] : "unknown");
                    throw new InvalidPluginExecutionException(OperationStatus.Retry, 0, "CaseFanOutRequiresPagedReconciliation");
                }
            }
            catch (System.ServiceModel.FaultException<OrganizationServiceFault>)
            {
                // The failed API transaction has ended. Stop this asynchronous job; never reuse it for more calls.
                trace?.Trace("RECONCILIATION_REQUIRED: case {0}, version {1}, correlation {2}; native async retry requested.",
                    context.PrimaryEntityId, captured ? post["versionnumber"] : "unknown", context.CorrelationId);
                throw new InvalidPluginExecutionException(OperationStatus.Retry, 0, "CaseTelemetryFailedRetryWholeJob");
            }
            catch (TimeoutException)
            {
                trace?.Trace("RECONCILIATION_REQUIRED: case {0}, timeout; native async retry requested.", context.PrimaryEntityId);
                throw new InvalidPluginExecutionException(OperationStatus.Retry, 0, "CaseTelemetryTimeoutRetryWholeJob");
            }
        }
    }
}
