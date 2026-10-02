using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;

namespace EmailProcess.Plugin
{
    public static class Tables
    {
        public const string Definition = "rfd_processdefinition";
        public const string StageDefinition = "rfd_processstagedefinition";
        public const string Transition = "rfd_processtransition";
        public const string Process = "rfd_emailprocess";
        public const string Stage = "rfd_emailprocessstage";
        public const string Event = "rfd_emailprocessevent";
        public const string Case = "rfd_emailprocesscase";
        public static readonly string[] Runtime = { Process, Stage, Event, Case };
        public static readonly string[] Configuration = { Definition, StageDefinition, Transition };
        public static readonly string[] ProcessColumns = { "rfd_definition", "rfd_state", "rfd_receivedat", "rfd_lasteventat", "rfd_revision",
            "rfd_coverage", "rfd_health", "rfd_reconciliationrequired", "rfd_parentprocess", "rfd_contact", "rfd_email", "rfd_primarycase", "rfd_weakcorrelation", "modifiedon", "ownerid" };
        public static readonly string[] StageColumns = { "rfd_process", "rfd_stagedefinition", "rfd_sourceoperationkey", "rfd_state", "rfd_branch",
            "rfd_attempt", "rfd_startedat", "rfd_endedat", "rfd_sourceversion", "rfd_case", "rfd_durationms", "rfd_durationprovenance",
            "rfd_sourceexecutionid", "rfd_operation", "rfd_producerid", "rfd_parentexecution", "rfd_workflow", "ownerid" };
        public static readonly string[] CaseColumns = { "rfd_process", "rfd_case", "rfd_role", "rfd_blockscompletion", "rfd_linkedat",
            "rfd_casestate", "rfd_casestatus", "rfd_caseversion", "rfd_merged", "rfd_reconciliationrequired", "ownerid" };
        public static readonly string[] EventColumns = { "rfd_process", "rfd_stageexecution", "rfd_eventtype", "rfd_stagecode", "rfd_outcome",
            "rfd_occurredat", "rfd_recordedat", "rfd_revision", "rfd_schemaversion", "rfd_producerid", "rfd_actor", "rfd_errorcode",
            "rfd_durationms", "rfd_usage", "rfd_case", "rfd_contact", "rfd_task", "rfd_noteid", "rfd_email", "rfd_sourceversion",
            "rfd_sourceexecutionid", "rfd_payloadjson", "rfd_payloaddigest", "rfd_sourceeventkey", "rfd_holding", "rfd_workflow" };
        public static readonly string[] DefinitionColumns = { "rfd_name", "rfd_code", "rfd_version", "rfd_state", "rfd_coverageversion", "rfd_allowcasefreecompletion" };
        public static readonly string[] StageDefinitionColumns = { "rfd_name", "rfd_definition", "rfd_code", "rfd_phase", "rfd_lane", "rfd_nodekind",
            "rfd_displayorder", "rfd_required", "rfd_coverage", "rfd_completionauthority", "rfd_allowcasefreecompletion", "rfd_requirescase" };
        public static readonly string[] TransitionColumns = { "rfd_name", "rfd_definition", "rfd_code", "rfd_fromstage", "rfd_tostage",
            "rfd_branchcode", "rfd_eventcode", "rfd_displayorder", "rfd_required" };
    }

    public sealed class Store
    {
        public IOrganizationService Service { get; }
        public Store(IOrganizationService service) { Service = service; }
        public Entity Get(string table, Guid id, params string[] columns) => Service.Retrieve(table, id, new ColumnSet(columns));
        public Entity Find(string table, string column, object value, params string[] columns)
        {
            var query = new QueryExpression(table) { ColumnSet = new ColumnSet(columns), TopCount = 2 };
            query.Criteria.AddCondition(column, ConditionOperator.Equal, value);
            var rows = Service.RetrieveMultiple(query).Entities;
            if (rows.Count > 1) throw new ContractException("UniqueKeyNotActive");
            return rows.SingleOrDefault();
        }
        public List<Entity> Children(string table, string lookup, Guid id, int limit, params string[] columns)
        {
            var query = new QueryExpression(table) { ColumnSet = new ColumnSet(columns), TopCount = limit + 1 };
            query.Criteria.AddCondition(lookup, ConditionOperator.Equal, id);
            query.AddOrder(table + "id", OrderType.Ascending);
            var rows = Service.RetrieveMultiple(query).Entities.ToList();
            if (rows.Count > limit) throw new ContractException("AggregateBoundExceededReconciliationRequired");
            return rows;
        }
        public void Update(Entity original, Entity changes)
        {
            if (string.IsNullOrEmpty(original.RowVersion)) throw new ContractException("RowVersionUnavailable");
            changes.RowVersion = original.RowVersion;
            Service.Execute(new UpdateRequest { Target = changes, ConcurrencyBehavior = ConcurrencyBehavior.IfRowVersionMatches });
        }
        public void Create(Entity row) => Service.Create(row);
        public bool InRole(Guid actor, Guid role)
        {
            var direct = new QueryExpression("systemuserroles") { ColumnSet = new ColumnSet("roleid"), TopCount = 1 };
            direct.Criteria.AddCondition("systemuserid", ConditionOperator.Equal, actor);
            direct.Criteria.AddCondition("roleid", ConditionOperator.Equal, role);
            if (Service.RetrieveMultiple(direct).Entities.Count > 0) return true;
            var teams = new QueryExpression("teamroles") { ColumnSet = new ColumnSet("roleid"), TopCount = 1 };
            teams.Criteria.AddCondition("roleid", ConditionOperator.Equal, role);
            var membership = teams.AddLink("teammembership", "teamid", "teamid");
            membership.LinkCriteria.AddCondition("systemuserid", ConditionOperator.Equal, actor);
            return Service.RetrieveMultiple(teams).Entities.Count > 0;
        }
        public static Guid? Ref(Entity e, string name) => e.GetAttributeValue<EntityReference>(name)?.Id;
        public static string Text(Entity e, string name) => e.GetAttributeValue<string>(name);
        public static Guid? GuidText(Entity e, string name) => Guid.TryParse(Text(e, name), out var id) ? id : (Guid?)null;
        public static int Int(Entity e, string name) => e.GetAttributeValue<int>(name);
        public static bool Bool(Entity e, string name) => e.GetAttributeValue<bool>(name);
        public static DateTime? Date(Entity e, string name) => e.Contains(name) ? e.GetAttributeValue<DateTime>(name) : (DateTime?)null;
        public static CaseFact CaseFact(Entity e) => new CaseFact { CaseId = Ref(e, "rfd_case").Value,
            BlocksCompletion = Bool(e, "rfd_blockscompletion"), State = Int(e, "rfd_casestate"), Status = Int(e, "rfd_casestatus"),
            Merged = Bool(e, "rfd_merged"), Version = Text(e, "rfd_caseversion"), ReconciliationRequired = Bool(e, "rfd_reconciliationrequired") };
        public static Execution Execution(Entity e, string code) => new Execution { Id = e.Id, StageCode = code, Branch = Text(e, "rfd_branch"),
            Attempt = Int(e, "rfd_attempt"), State = Text(e, "rfd_state"), StartedAt = Date(e, "rfd_startedat"), EndedAt = Date(e, "rfd_endedat"),
            SourceVersion = Text(e, "rfd_sourceversion"), CaseId = Ref(e, "rfd_case") };
    }
}
