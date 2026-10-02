using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace EmailProcess.Plugin
{
    public sealed class Cursor
    {
        public string Scope { get; set; }
        public int Page { get; set; }
        public string Cookie { get; set; }
        public int UpperRevision { get; set; }
        public DateTime ExpiresAtUtc { get; set; }
        public DateTime FenceUtc { get; set; }
    }

    public sealed class CursorCodec
    {
        private readonly byte[] key;
        public CursorCodec(string encodedKey)
        {
            try { key = Convert.FromBase64String(encodedKey ?? ""); }
            catch (FormatException) { throw new ContractException("CursorSigningConfigurationRequired"); }
            if (key.Length < 32) throw new ContractException("CursorSigningConfigurationRequired");
        }
        public string Encode(Cursor cursor)
        {
            var json = Encoding.UTF8.GetBytes(Json.Write(cursor));
            using (var hmac = new HMACSHA256(key)) return Convert.ToBase64String(json) + "." + Convert.ToBase64String(hmac.ComputeHash(json));
        }
        public Cursor Decode(string value, string scope)
        {
            try
            {
                if (value.Length > 16000) throw new ContractException("InvalidCursor");
                var pieces = value.Split('.');
                if (pieces.Length != 2) throw new ContractException("InvalidCursor");
                var json = Convert.FromBase64String(pieces[0]);
                var mac = Convert.FromBase64String(pieces[1]);
                using (var hmac = new HMACSHA256(key))
                {
                    var expected = hmac.ComputeHash(json);
                    if (mac.Length != expected.Length) throw new ContractException("InvalidCursor");
                    var difference = 0;
                    for (var i = 0; i < mac.Length; i++) difference |= mac[i] ^ expected[i];
                    if (difference != 0) throw new ContractException("InvalidCursor");
                }
                var cursor = Json.Read<Cursor>(Encoding.UTF8.GetString(json));
                if (cursor.Scope != scope || cursor.ExpiresAtUtc <= DateTime.UtcNow || cursor.Page < 1)
                    throw new ContractException("CursorExpiredOrScopeMismatch");
                return cursor;
            }
            catch (FormatException) { throw new ContractException("InvalidCursor"); }
        }
    }

    public sealed class Reader
    {
        private readonly Store store;
        private readonly Guid organization;
        private readonly Guid caller;
        private readonly Policy policy;
        public Reader(Store store, Guid organization, Guid caller, Policy policy)
        { this.store = store; this.organization = organization; this.caller = caller; this.policy = policy; }

        public object Execute(string action, Command c)
        {
            if (c.PageSize < 1 || c.PageSize > 100) throw new ContractException("PageSizeOutOfRange");
            switch (action)
            {
                case "rfd_GetEmailProcessState": return State(c);
                case "rfd_GetEmailProcessEvents": return Events(c);
                case "rfd_ListEmailProcesses": return List(c);
                case "rfd_GetProcessDefinitions": return Definitions(c);
                default: throw new ContractException("UnknownAction");
            }
        }
        private Entity Process(Command c)
        {
            if (!c.ProcessId.HasValue || c.ProcessId == Guid.Empty) throw new ContractException("ProcessIdRequired");
            return store.Get(Tables.Process, c.ProcessId.Value, Tables.ProcessColumns);
        }
        private object State(Command c)
        {
            if (c.Cursor != null) throw new ContractException("CursorNotSupportedForState");
            var p = Process(c);
            var defs = store.Children(Tables.StageDefinition, "rfd_definition", Store.Ref(p, "rfd_definition").Value, 200, Tables.StageDefinitionColumns);
            var stages = store.Children(Tables.Stage, "rfd_process", p.Id, 500, Tables.StageColumns);
            var cases = store.Children(Tables.Case, "rfd_process", p.Id, 100, Tables.CaseColumns);
            // A read is not a transaction snapshot: detect concurrent writes rather than return mixed revisions.
            var after = store.Get(Tables.Process, p.Id, "rfd_revision");
            if (Store.Int(p, "rfd_revision") != Store.Int(after, "rfd_revision")) throw new ContractException("ReadChangedRetry");
            return new { schemaVersion = 1, process = Project(p), revision = Store.Int(p, "rfd_revision"),
                stageExecutions = stages.Select(e => new {
                    stageExecutionId = e.Id, stageDefinitionId = Store.Ref(e, "rfd_stagedefinition"),
                    stageCode = Store.Text(defs.Single(d => d.Id == Store.Ref(e, "rfd_stagedefinition")), "rfd_code"),
                    branch = Store.Text(e, "rfd_branch"), attempt = Store.Int(e, "rfd_attempt"), state = Store.Text(e, "rfd_state"),
                    startedAtUtc = Utc(Store.Date(e, "rfd_startedat")), endedAtUtc = Utc(Store.Date(e, "rfd_endedat")),
                    durationMs = e.GetAttributeValue<decimal?>("rfd_durationms"), durationProvenance = Store.Text(e, "rfd_durationprovenance"),
                    caseId = Store.Ref(e, "rfd_case"), sourceVersion = Store.Text(e, "rfd_sourceversion"),
                    sourceExecutionId = Store.Text(e, "rfd_sourceexecutionid"), producerId = Store.Text(e, "rfd_producerid"),
                    operation = Store.Text(e, "rfd_operation"), parentExecutionId = Store.Ref(e, "rfd_parentexecution"),
                    workflowId = Store.Ref(e, "rfd_workflow") }).ToArray(),
                caseLinks = cases.Select(e => new {
                    caseId = Store.Ref(e, "rfd_case"), relationshipRole = Store.Text(e, "rfd_role"),
                    blocksCompletion = Store.Bool(e, "rfd_blockscompletion"), state = Store.Int(e, "rfd_casestate"),
                    status = Store.Int(e, "rfd_casestatus"), merged = Store.Bool(e, "rfd_merged"),
                    sourceVersion = Store.Text(e, "rfd_caseversion"), reconciliationRequired = Store.Bool(e, "rfd_reconciliationrequired") }).ToArray() };
        }
        private static DateTime? Utc(DateTime? value) => value.HasValue ? DateTime.SpecifyKind(value.Value, DateTimeKind.Utc) : (DateTime?)null;
        private static object Project(Entity p) => new {
            processId = p.Id, definitionId = Store.Ref(p, "rfd_definition"), state = Store.Text(p, "rfd_state"),
            receivedAtUtc = Utc(Store.Date(p, "rfd_receivedat")), lastEventAtUtc = Utc(Store.Date(p, "rfd_lasteventat")),
            revision = Store.Int(p, "rfd_revision"), coverage = Store.Text(p, "rfd_coverage"), health = Store.Text(p, "rfd_health"),
            reconciliationRequired = Store.Bool(p, "rfd_reconciliationrequired"), parentProcessId = Store.Ref(p, "rfd_parentprocess"),
            contactId = Store.Ref(p, "rfd_contact"), emailId = Store.Ref(p, "rfd_email"), primaryCaseId = Store.Ref(p, "rfd_primarycase"),
            weakCorrelation = Store.Bool(p, "rfd_weakcorrelation") };

        private Cursor Begin(string action, Command c, int upper = 0)
        {
            var scope = Keys.Hash("cursor-v1", Keys.Id(organization), Keys.Id(caller), action, c.ProcessId?.ToString("D") ?? "",
                c.DefinitionId?.ToString("D") ?? "", c.State ?? "", c.PageSize.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return c.Cursor == null ? new Cursor { Scope = scope, Page = 1, UpperRevision = upper, FenceUtc = DateTime.UtcNow,
                ExpiresAtUtc = DateTime.UtcNow.AddMinutes(15) } : new CursorCodec(policy.CursorSigningKey).Decode(c.Cursor, scope);
        }
        private EntityCollection Page(QueryExpression query, Command c, Cursor cursor)
        {
            query.PageInfo = new PagingInfo { Count = c.PageSize, PageNumber = cursor.Page, PagingCookie = cursor.Cookie, ReturnTotalRecordCount = false };
            return store.Service.RetrieveMultiple(query);
        }
        private string Next(EntityCollection rows, Cursor cursor)
        {
            if (!rows.MoreRecords) return null;
            if (string.IsNullOrEmpty(rows.PagingCookie)) throw new ContractException("PagingCookieRequired");
            cursor.Cookie = rows.PagingCookie; cursor.Page++;
            return new CursorCodec(policy.CursorSigningKey).Encode(cursor);
        }
        private object Events(Command c)
        {
            var process = Process(c);
            var cursor = Begin("events", c, Store.Int(process, "rfd_revision"));
            var query = new QueryExpression(Tables.Event) { ColumnSet = new ColumnSet(Tables.EventColumns.Where(x =>
                x != "rfd_payloaddigest" && x != "rfd_sourceeventkey" && x != "rfd_payloadjson").ToArray()) };
            query.Criteria.AddCondition("rfd_process", ConditionOperator.Equal, process.Id);
            query.Criteria.AddCondition("rfd_revision", ConditionOperator.LessEqual, cursor.UpperRevision);
            query.AddOrder("rfd_revision", OrderType.Ascending); query.AddOrder(Tables.Event + "id", OrderType.Ascending);
            var rows = Page(query, c, cursor);
            return new { schemaVersion = 1, processId = process.Id, upperRevision = cursor.UpperRevision,
                nextCursor = Next(rows, cursor), coverage = Store.Text(process, "rfd_coverage"),
                events = rows.Entities.Select(e => new {
                    eventId = e.Id, processId = Store.Ref(e, "rfd_process"), stageExecutionId = Store.Ref(e, "rfd_stageexecution"),
                    eventType = Store.Text(e, "rfd_eventtype"), stageCode = Store.Text(e, "rfd_stagecode"), outcome = Store.Text(e, "rfd_outcome"),
                    occurredAtUtc = Utc(Store.Date(e, "rfd_occurredat")), recordedAtUtc = Utc(Store.Date(e, "rfd_recordedat")),
                    revision = Store.Int(e, "rfd_revision"), producerId = Store.Text(e, "rfd_producerid"),
                    caseId = Store.Ref(e, "rfd_case"), contactId = Store.Ref(e, "rfd_contact"), emailId = Store.Ref(e, "rfd_email"),
                    taskId = Store.Ref(e, "rfd_task"), noteId = Store.GuidText(e, "rfd_noteid"), sourceVersion = Store.Text(e, "rfd_sourceversion"),
                    sourceExecutionId = Store.Text(e, "rfd_sourceexecutionid"),
                    holdingId = Store.Ref(e, "rfd_holding"), workflowId = Store.Ref(e, "rfd_workflow"),
                    durationMs = e.GetAttributeValue<decimal?>("rfd_durationms"), usage = e.GetAttributeValue<int?>("rfd_usage"),
                    errorCode = Store.Text(e, "rfd_errorcode") }).ToArray() };
        }
        private object List(Command c)
        {
            if (c.State != null && !new[] { "received", "processing", "waiting-review", "completed", "failed", "cancelled", "needs-reconciliation" }.Contains(c.State))
                throw new ContractException("InvalidStateFilter");
            var cursor = Begin("list", c);
            var query = new QueryExpression(Tables.Process) { ColumnSet = new ColumnSet(Tables.ProcessColumns) };
            query.Criteria.AddCondition("createdon", ConditionOperator.LessEqual, cursor.FenceUtc);
            if (c.State != null) query.Criteria.AddCondition("rfd_state", ConditionOperator.Equal, c.State);
            if (c.DefinitionId.HasValue) query.Criteria.AddCondition("rfd_definition", ConditionOperator.Equal, c.DefinitionId.Value);
            query.AddOrder("createdon", OrderType.Descending); query.AddOrder(Tables.Process + "id", OrderType.Ascending);
            var rows = Page(query, c, cursor);
            return new { schemaVersion = 1, processes = rows.Entities.Select(Project).ToArray(), nextCursor = Next(rows, cursor),
                consistency = "live-projections", counts = new { scope = "returned-page",
                    byState = rows.Entities.GroupBy(e => Store.Text(e, "rfd_state") ?? "unknown").ToDictionary(g => g.Key, g => g.Count()) } };
        }
        private object Definitions(Command c)
        {
            var cursor = Begin("definitions", c);
            var query = new QueryExpression(Tables.Definition) { ColumnSet = new ColumnSet(Tables.DefinitionColumns) };
            if (c.DefinitionId.HasValue) query.Criteria.AddCondition(Tables.Definition + "id", ConditionOperator.Equal, c.DefinitionId.Value);
            else query.Criteria.AddCondition("rfd_state", ConditionOperator.Equal, "published");
            query.AddOrder("rfd_code", OrderType.Ascending); query.AddOrder("rfd_version", OrderType.Ascending);
            query.AddOrder(Tables.Definition + "id", OrderType.Ascending);
            if (c.PageSize > 10) c.PageSize = 10;
            var rows = Page(query, c, cursor);
            var definitions = rows.Entities.Select(d => new {
                definitionId = d.Id, code = Store.Text(d, "rfd_code"), name = Store.Text(d, "rfd_name"), version = Store.Int(d, "rfd_version"),
                state = Store.Text(d, "rfd_state"), coverageVersion = Store.Text(d, "rfd_coverageversion"),
                allowCaseFreeCompletion = Store.Bool(d, "rfd_allowcasefreecompletion"),
                stages = store.Children(Tables.StageDefinition, "rfd_definition", d.Id, 200, Tables.StageDefinitionColumns).Select(s => new {
                    stageDefinitionId = s.Id, code = Store.Text(s, "rfd_code"), label = Store.Text(s, "rfd_name"), phase = Store.Text(s, "rfd_phase"),
                    lane = Store.Text(s, "rfd_lane"), nodeKind = Store.Text(s, "rfd_nodekind"), displayOrder = Store.Int(s, "rfd_displayorder"),
                    required = Store.Bool(s, "rfd_required"), coverage = Store.Text(s, "rfd_coverage"), completionAuthority = Store.Text(s, "rfd_completionauthority"),
                    allowCaseFreeCompletion = Store.Bool(s, "rfd_allowcasefreecompletion"), requiresCase = Store.Bool(s, "rfd_requirescase") }).ToArray(),
                transitions = store.Children(Tables.Transition, "rfd_definition", d.Id, 500, Tables.TransitionColumns).Select(t => new {
                    transitionId = t.Id, code = Store.Text(t, "rfd_code"), fromStageId = Store.Ref(t, "rfd_fromstage"), toStageId = Store.Ref(t, "rfd_tostage"),
                    label = Store.Text(t, "rfd_name"), branchCode = Store.Text(t, "rfd_branchcode"), eventCode = Store.Text(t, "rfd_eventcode"),
                    displayOrder = Store.Int(t, "rfd_displayorder"), required = Store.Bool(t, "rfd_required") }).ToArray() }).ToArray();
            return new { schemaVersion = 1, definitions, nextCursor = Next(rows, cursor) };
        }
    }
}
