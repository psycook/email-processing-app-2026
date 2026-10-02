using System;
using System.Collections.Generic;
using System.Linq;
using System.ServiceModel;
using System.IO;
using EmailProcess.Plugin;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;
using Moq;
using Newtonsoft.Json.Linq;
using Xunit;

namespace EmailProcess.Plugin.Tests
{
    public sealed class FakeDataverse : IOrganizationService
    {
        public readonly Dictionary<string, Dictionary<Guid, Entity>> Tables = new Dictionary<string, Dictionary<Guid, Entity>>();
        public readonly List<UpdateRequest> Updates = new List<UpdateRequest>();
        public bool FailNextUpdate;
        private long version;
        private static readonly JObject Manifest = JObject.Parse(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "process-contract.json")));
        private static void ValidateColumns(string table, IEnumerable<string> columns)
        {
            var metadata = Manifest["tables"].SingleOrDefault(t => (string)t["logicalName"] == table);
            if (metadata == null) return;
            var allowed = new HashSet<string>(metadata["columns"].Select(c => (string)c["name"])) {
                (string)metadata["primaryId"], "ownerid", "createdon", "modifiedon", "versionnumber"
            };
            foreach (var column in columns)
                if (!allowed.Contains(column)) throw new InvalidOperationException("Column not in canonical manifest: " + table + "." + column);
        }
        public Entity Seed(Entity row)
        {
            ValidateColumns(row.LogicalName, row.Attributes.Keys);
            if (!Tables.ContainsKey(row.LogicalName)) Tables[row.LogicalName] = new Dictionary<Guid, Entity>();
            row.RowVersion = (++version).ToString();
            row[row.LogicalName + "id"] = row.Id;
            Tables[row.LogicalName][row.Id] = Clone(row);
            return row;
        }
        public Guid Create(Entity entity)
        {
            if (Tables.TryGetValue(entity.LogicalName, out var rows) && rows.ContainsKey(entity.Id)) throw Fault("Duplicate primary ID");
            return Seed(entity).Id;
        }
        public Entity Retrieve(string name, Guid id, ColumnSet columns)
        {
            ValidateColumns(name, columns.Columns);
            if (!Tables.TryGetValue(name, out var rows) || !rows.TryGetValue(id, out var row)) throw Fault("Missing row or access denied");
            return Clone(row);
        }
        public EntityCollection RetrieveMultiple(QueryBase query)
        {
            if (!(query is QueryExpression expression)) throw new NotSupportedException("Only QueryExpression supported in test fake");
            ValidateColumns(expression.EntityName, expression.ColumnSet.Columns.Concat(expression.Criteria.Conditions.Select(c => c.AttributeName)));
            if (expression.LinkEntities.Count != 0) throw new NotSupportedException("Linked queries need explicit role fake");
            IEnumerable<Entity> rows = Tables.TryGetValue(expression.EntityName, out var table) ? table.Values : Enumerable.Empty<Entity>();
            foreach (var condition in expression.Criteria.Conditions)
            {
                if (condition.Operator != ConditionOperator.Equal) throw new NotSupportedException("Only equality supported in writer fake");
                rows = rows.Where(e => Equals(Value(e, condition.AttributeName), condition.Values[0]));
            }
            if (expression.TopCount.HasValue) rows = rows.Take(expression.TopCount.Value);
            return new EntityCollection(rows.Select(Clone).ToList());
        }
        private static object Value(Entity e, string column)
        {
            if (!e.Contains(column)) return null;
            return e[column] is EntityReference reference ? reference.Id : e[column];
        }
        public OrganizationResponse Execute(OrganizationRequest request)
        {
            if (!(request is UpdateRequest update)) throw new NotSupportedException("Only UpdateRequest supported in writer fake");
            Updates.Add(update);
            if (FailNextUpdate) { FailNextUpdate = false; throw Fault("Forced concurrency fault"); }
            var target = update.Target;
            var prior = Retrieve(target.LogicalName, target.Id, new ColumnSet());
            if (update.ConcurrencyBehavior != ConcurrencyBehavior.IfRowVersionMatches || update.Target.RowVersion != prior.RowVersion)
                throw Fault("Concurrency mismatch");
            foreach (var pair in target.Attributes) prior[pair.Key] = pair.Value;
            Seed(prior);
            return new UpdateResponse();
        }
        public void Update(Entity e) => throw new NotSupportedException("Unconditional Update must not be used");
        public void Delete(string name, Guid id) => throw new NotSupportedException();
        public void Associate(string name, Guid id, Relationship relationship, EntityReferenceCollection related) => throw new NotSupportedException();
        public void Disassociate(string name, Guid id, Relationship relationship, EntityReferenceCollection related) => throw new NotSupportedException();
        private static Entity Clone(Entity row)
        {
            var clone = new Entity(row.LogicalName, row.Id) { RowVersion = row.RowVersion };
            foreach (var pair in row.Attributes) clone[pair.Key] = pair.Value;
            return clone;
        }
        private static FaultException<OrganizationServiceFault> Fault(string text) => new FaultException<OrganizationServiceFault>(
            new OrganizationServiceFault { Message = text }, text);
    }

    public sealed class WriterTests
    {
        private readonly FakeDataverse fake = new FakeDataverse();
        private readonly Guid actor = Guid.NewGuid();
        private readonly Guid organization = Guid.NewGuid();
        private readonly Guid definitionId = Guid.NewGuid();
        private readonly Guid contactId = Guid.NewGuid();
        private readonly Producer producer;
        private readonly Mock<IPluginExecutionContext> context = new Mock<IPluginExecutionContext>();
        public WriterTests()
        {
            producer = new Producer { ProducerId = "flow", Authority = "tool", CanReceive = true, CanLinkCases = true,
                CanResolveCustomer = true, CustomerResolutionStageCodes = new[] { "tool" }, StageCodes = new[] { "tool" } };
            context.SetupGet(c => c.OrganizationId).Returns(organization);
            context.SetupGet(c => c.InitiatingUserId).Returns(actor);
            context.SetupGet(c => c.SharedVariables).Returns(new ParameterCollection());
            fake.Seed(new Entity(Tables.Definition, definitionId) { ["rfd_state"] = "published", ["rfd_allowcasefreecompletion"] = true });
            fake.Seed(new Entity(Tables.StageDefinition, Guid.NewGuid()) { ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId),
                ["rfd_code"] = "tool", ["rfd_required"] = true, ["rfd_phase"] = "identify",
                ["rfd_completionauthority"] = "tool", ["rfd_allowcasefreecompletion"] = true });
            fake.Seed(new Entity("contact", contactId));
        }
        private Writer Writer() => new Writer(new Store(fake), context.Object, producer, new Policy());
        private Command Intake() => new Command { SchemaVersion = 1, EventId = Guid.NewGuid(), DefinitionId = definitionId,
            ProducerId = "flow", SourceExecutionId = "run1", Operation = "receive", EventType = "received",
            OccurredAtUtc = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero), InternetMessageId = "<source@example>",
            SourceLocator = "immutable-source", ActualFrom = "private@example", ReplyTo = "reply@example" };
        [Fact]
        public void DuplicateIntakeAndSourceEventAreIdempotentWithoutInflatingRevisions()
        {
            var command = Intake();
            var first = Writer().Execute("rfd_RecordEmailProcessEvent", command, false);
            var second = Writer().Execute("rfd_RecordEmailProcessEvent", command, false);
            Assert.Equal(first.ProcessId, second.ProcessId); Assert.Equal("AlreadyRecorded", second.Status);
            Assert.Single(fake.Tables[Tables.Process]); Assert.Single(fake.Tables[Tables.Event]);
            command.EventId = Guid.NewGuid();
            Assert.Equal(first.EventId, Writer().Execute("rfd_RecordEmailProcessEvent", command, false).EventId);
            command.ActualFrom = "changed@example";
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", command, false));
        }
        [Fact]
        public void RequiredIntakeNodeGetsOneDeterministicReceiptExecutionAndUnblocksEntry()
        {
            var intakeDefinition = Guid.NewGuid();
            var toolDefinition = fake.Tables[Tables.StageDefinition].Values.Single().Id;
            fake.Seed(new Entity(Tables.StageDefinition, intakeDefinition) {
                ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId), ["rfd_code"] = "intake",
                ["rfd_required"] = true, ["rfd_completionauthority"] = "intake" });
            fake.Seed(new Entity(Tables.Transition, Guid.NewGuid()) {
                ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId),
                ["rfd_fromstage"] = new EntityReference(Tables.StageDefinition, intakeDefinition),
                ["rfd_tostage"] = new EntityReference(Tables.StageDefinition, toolDefinition), ["rfd_required"] = true });
            var intake = Intake();
            var receipt = Writer().Execute("rfd_RecordEmailProcessEvent", intake, false);
            Assert.Equal("AlreadyRecorded", Writer().Execute("rfd_RecordEmailProcessEvent", intake, false).Status);
            var execution = fake.Tables[Tables.Stage].Values.Single();
            Assert.Equal(Keys.Hash("intake-v1", Keys.Id(receipt.ProcessId)), Store.Text(execution, "rfd_sourceoperationkey"));
            Assert.Equal(Keys.StableGuid("intake-v1", Keys.Id(receipt.ProcessId)), execution.Id);
            Assert.Equal("succeeded", Store.Text(execution, "rfd_state"));
            Writer().Execute("rfd_RecordEmailProcessEvent", new Command { SchemaVersion = 1, ProcessId = receipt.ProcessId,
                EventId = Guid.NewGuid(), StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 1,
                ProducerId = "flow", SourceExecutionId = "run1", Operation = "tool", EventType = "completed",
                OccurredAtUtc = DateTimeOffset.UtcNow }, false);
            Assert.Equal("completed", Store.Text(fake.Tables[Tables.Process][receipt.ProcessId], "rfd_state"));
        }
        [Fact]
        public void DifferentMessagesNeverMergeAndPrivateMetadataStaysOutOfLedger()
        {
            var a = Intake(); var first = Writer().Execute("rfd_RecordEmailProcessEvent", a, false);
            var b = Intake(); b.InternetMessageId = "<reply@example>";
            var second = Writer().Execute("rfd_RecordEmailProcessEvent", b, false);
            Assert.NotEqual(first.ProcessId, second.ProcessId);
            var payload = fake.Tables[Tables.Event][first.EventId].GetAttributeValue<string>("rfd_payloadjson");
            Assert.DoesNotContain("private@example", payload); Assert.DoesNotContain("reply@example", payload);
            Assert.DoesNotContain("source@example", payload); Assert.DoesNotContain("immutable-source", payload);
        }
        [Fact]
        public void TypedHoldingAndWorkflowReferencesRequireRealReadableRows()
        {
            var command = Intake();
            command.HoldingId = Guid.NewGuid(); command.WorkflowId = Guid.NewGuid();
            Assert.Throws<FaultException<OrganizationServiceFault>>(() => Writer().Execute("rfd_RecordEmailProcessEvent", command, false));
            fake.Seed(new Entity("rfd_financialaccount", command.HoldingId.Value));
            fake.Seed(new Entity("workflow", command.WorkflowId.Value));
            var result = Writer().Execute("rfd_RecordEmailProcessEvent", command, false);
            var @event = fake.Tables[Tables.Event][result.EventId];
            Assert.Equal(command.HoldingId, Store.Ref(@event, "rfd_holding"));
            Assert.Equal(command.WorkflowId, Store.Ref(@event, "rfd_workflow"));
        }
        [Fact]
        public void NoteReferenceUsesValidatedGuidTextNotUnsupportedAnnotationLookup()
        {
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            var caseId = LinkOpenCase(process);
            var command = new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(),
                StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 2, ProducerId = "flow",
                SourceExecutionId = "run1", Operation = "note", EventType = "completed", OccurredAtUtc = DateTimeOffset.UtcNow,
                CaseId = caseId, NoteId = Guid.NewGuid() };
            Assert.Throws<FaultException<OrganizationServiceFault>>(() => Writer().Execute("rfd_RecordEmailProcessEvent", command, false));
            fake.Seed(new Entity("annotation", command.NoteId.Value) { ["objectid"] = new EntityReference("incident", Guid.NewGuid()) });
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", command, false));
            fake.Tables["annotation"][command.NoteId.Value]["objectid"] = new EntityReference("incident", caseId);
            var receipt = Writer().Execute("rfd_RecordEmailProcessEvent", command, false);
            var row = fake.Tables[Tables.Event][receipt.EventId];
            Assert.False(row.Contains("rfd_note"));
            Assert.IsType<string>(row["rfd_noteid"]);
            Assert.Equal(command.NoteId, Store.GuidText(row, "rfd_noteid"));
        }
        [Fact]
        public void ActualToolContactLookupAfterIntakeEnablesValidatedCaseLink()
        {
            var intake = Intake(); intake.ContactId = null;
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", intake, false).ProcessId;
            Assert.Null(Store.Ref(fake.Tables[Tables.Process][process], "rfd_contact"));
            Writer().Execute("rfd_RecordEmailProcessEvent", new Command {
                SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(), StageExecutionId = Guid.NewGuid(),
                StageCode = "tool", Attempt = 1, ProducerId = "flow", SourceExecutionId = "run1", Operation = "contact-lookup",
                EventType = "completed", OccurredAtUtc = DateTimeOffset.UtcNow, ContactId = contactId }, false);
            Assert.Equal(contactId, Store.Ref(fake.Tables[Tables.Process][process], "rfd_contact"));
            var linked = LinkOpenCase(process);
            Assert.Equal(linked, Store.Ref(fake.Tables[Tables.Case].Values.Single(), "rfd_case"));
        }
        [Theory]
        [InlineData("capability")]
        [InlineData("stage-allowlist")]
        [InlineData("phase")]
        [InlineData("authority")]
        public void CustomerResolutionRequiresSeparateCapabilityAndIdentifyTool(string denial)
        {
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            if (denial == "capability") producer.CanResolveCustomer = false;
            if (denial == "stage-allowlist") producer.CustomerResolutionStageCodes = new[] { "other-stage" };
            if (denial == "phase") fake.Tables[Tables.StageDefinition].Values.Single()["rfd_phase"] = "act";
            if (denial == "authority") producer.Authority = "workflow";
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", ContactLookup(process, contactId), false));
            Assert.Null(Store.Ref(fake.Tables[Tables.Process][process], "rfd_contact"));
            Assert.DoesNotContain(fake.Tables[Tables.Event].Values, e => Store.Ref(e, "rfd_contact").HasValue);
        }
        [Fact]
        public void ContactBindingIsImmutableIdempotentAndRequiresReadableRecord()
        {
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            var missing = ContactLookup(process, Guid.NewGuid());
            Assert.Throws<FaultException<OrganizationServiceFault>>(() => Writer().Execute("rfd_RecordEmailProcessEvent", missing, false));
            var request = ContactLookup(process, contactId);
            var receipt = Writer().Execute("rfd_RecordEmailProcessEvent", request, false);
            Assert.Equal("AlreadyRecorded", Writer().Execute("rfd_RecordEmailProcessEvent", request, false).Status);
            Assert.Equal(contactId, Store.Ref(fake.Tables[Tables.Event][receipt.EventId], "rfd_contact"));
            var other = Guid.NewGuid(); fake.Seed(new Entity("contact", other));
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", ContactLookup(process, other), false));
            Assert.Equal(contactId, Store.Ref(fake.Tables[Tables.Process][process], "rfd_contact"));
            var same = Writer().Execute("rfd_RecordEmailProcessEvent", ContactLookup(process, contactId), false);
            Assert.Equal("Applied", same.Status);
            Assert.Equal(contactId, Store.Ref(fake.Tables[Tables.Process][process], "rfd_contact"));
        }
        [Fact]
        public void IntakeAndUnsuccessfulExecutionCannotBindContactFromHeaders()
        {
            var intake = Intake(); intake.ContactId = contactId;
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", intake, false));
            intake.ContactId = null;
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", intake, false).ProcessId;
            var request = ContactLookup(process, contactId); request.EventType = "started";
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", request, false));
            Assert.Null(Store.Ref(fake.Tables[Tables.Process][process], "rfd_contact"));
        }
        [Fact]
        public void MissingMessageIdUsesExplicitWeakIdentityNotEmptyStrongHash()
        {
            var c = Intake(); c.InternetMessageId = null;
            var first = Writer().Execute("rfd_RecordEmailProcessEvent", c, false);
            Assert.Equal("AlreadyRecorded", Writer().Execute("rfd_RecordEmailProcessEvent", c, false).Status);
            Assert.True(fake.Tables[Tables.Process][first.ProcessId].GetAttributeValue<bool>("rfd_weakcorrelation"));
            Assert.Equal("needs-reconciliation", fake.Tables[Tables.Process][first.ProcessId].GetAttributeValue<string>("rfd_state"));
            c.EventId = Guid.NewGuid();
            Assert.NotEqual(first.ProcessId, Writer().Execute("rfd_RecordEmailProcessEvent", c, false).ProcessId);
        }
        [Fact]
        public void ExecutionCompletesAndLateStartDoesNotRegress()
        {
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            var c = new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(), StageExecutionId = Guid.NewGuid(),
                StageCode = "tool", Attempt = 1, ProducerId = "flow", SourceExecutionId = "run1", Operation = "tool",
                EventType = "completed", OccurredAtUtc = DateTimeOffset.UtcNow, SourceVersion = "2" };
            Writer().Execute("rfd_RecordEmailProcessEvent", c, false);
            c.EventId = Guid.NewGuid(); c.EventType = "started"; c.SourceVersion = "1";
            Writer().Execute("rfd_RecordEmailProcessEvent", c, false);
            Assert.Equal("completed", fake.Tables[Tables.Process][process].GetAttributeValue<string>("rfd_state"));
            Assert.Equal("succeeded", fake.Tables[Tables.Stage][c.StageExecutionId.Value].GetAttributeValue<string>("rfd_state"));
            Assert.All(fake.Updates, u => { Assert.Equal(ConcurrencyBehavior.IfRowVersionMatches, u.ConcurrencyBehavior); Assert.NotEmpty(u.Target.RowVersion); });
        }
        [Fact]
        public void TwoNativeRunsShareIntakeButReceiveDistinctServerOrdinalsAndIdempotentRetries()
        {
            var intakeOne = Intake();
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", intakeOne, false).ProcessId;
            var first = new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(),
                StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 1, ProducerId = "flow",
                SourceExecutionId = "native-run-one", Operation = "host-call", EventType = "completed",
                OccurredAtUtc = DateTimeOffset.UtcNow, SourceVersion = "2" };
            Writer().Execute("rfd_RecordEmailProcessEvent", first, false);
            var intakeTwo = Intake(); intakeTwo.SourceExecutionId = "native-run-two";
            Assert.Equal(process, Writer().Execute("rfd_RecordEmailProcessEvent", intakeTwo, false).ProcessId);
            var second = new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(),
                StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 1, ProducerId = "flow",
                SourceExecutionId = "native-run-two", Operation = "host-call", EventType = "started",
                OccurredAtUtc = DateTimeOffset.UtcNow, SourceVersion = "1" };
            var started = Writer().Execute("rfd_RecordEmailProcessEvent", second, false);
            Assert.Equal("AlreadyRecorded", Writer().Execute("rfd_RecordEmailProcessEvent", second, false).Status);
            Assert.Equal(started.Revision, Store.Int(fake.Tables[Tables.Process][process], "rfd_revision"));
            Assert.Equal("processing", Store.Text(fake.Tables[Tables.Process][process], "rfd_state"));
            second.EventId = Guid.NewGuid(); second.EventType = "completed"; second.SourceVersion = "2";
            var completed = Writer().Execute("rfd_RecordEmailProcessEvent", second, false);
            Assert.Equal("AlreadyRecorded", Writer().Execute("rfd_RecordEmailProcessEvent", second, false).Status);
            Assert.Equal(completed.Revision, Store.Int(fake.Tables[Tables.Process][process], "rfd_revision"));
            Assert.Equal(1, Store.Int(fake.Tables[Tables.Stage][first.StageExecutionId.Value], "rfd_attempt"));
            Assert.Equal(2, Store.Int(fake.Tables[Tables.Stage][second.StageExecutionId.Value], "rfd_attempt"));
            Assert.Equal(2, fake.Tables[Tables.Stage].Count);
            var snapshot = JObject.Parse(Json.Write(new Reader(new Store(fake), organization, actor, new Policy())
                .Execute("rfd_GetEmailProcessState", new Command { ProcessId = process })));
            Assert.Equal(new[] { 1, 2 }, snapshot["stageExecutions"].Select(e => (int)e["attempt"]).OrderBy(x => x).ToArray());
            Assert.Equal(1, second.Attempt);
            Assert.Equal(1, (int)JObject.Parse(Store.Text(fake.Tables[Tables.Event][completed.EventId], "rfd_payloadjson"))["attempt"]);
            first.EventId = Guid.NewGuid(); first.EventType = "started"; first.SourceVersion = "1";
            Writer().Execute("rfd_RecordEmailProcessEvent", first, false);
            Assert.Equal("succeeded", Store.Text(fake.Tables[Tables.Stage][first.StageExecutionId.Value], "rfd_state"));
            Assert.Equal("completed", Store.Text(fake.Tables[Tables.Process][process], "rfd_state"));
        }
        [Fact]
        public void SameNativeRunAndSourceAttemptCannotBecomeAnotherAttemptByChangingGuids()
        {
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            var request = new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(),
                StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 1, ProducerId = "flow",
                SourceExecutionId = "native-run", Operation = "host-call", EventType = "completed", OccurredAtUtc = DateTimeOffset.UtcNow };
            Writer().Execute("rfd_RecordEmailProcessEvent", request, false);
            request.EventId = Guid.NewGuid(); request.StageExecutionId = Guid.NewGuid();
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", request, false));
            request.EventType = "started";
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", request, false));
            Assert.Single(fake.Tables[Tables.Stage]);
            request.Attempt = 2;
            Writer().Execute("rfd_RecordEmailProcessEvent", request, false);
            Assert.Equal(2, fake.Tables[Tables.Stage].Count);
            Assert.Equal(2, Store.Int(fake.Tables[Tables.Stage][request.StageExecutionId.Value], "rfd_attempt"));
        }
        [Theory]
        [InlineData(false, false, "processing")]
        [InlineData(true, false, "completed")]
        [InlineData(true, true, "processing")]
        public void CaseFreeCompletionRequiresExplicitRouteAndNoCaseRequiredBranch(bool terminal, bool requiresCase, string expected)
        {
            var definition = fake.Tables[Tables.StageDefinition].Values.Single();
            definition["rfd_allowcasefreecompletion"] = terminal; definition["rfd_requirescase"] = requiresCase;
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            Writer().Execute("rfd_RecordEmailProcessEvent", new Command { SchemaVersion = 1, ProcessId = process,
                EventId = Guid.NewGuid(), StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 1,
                ProducerId = "flow", SourceExecutionId = "run1", Operation = "tool", EventType = "completed",
                OccurredAtUtc = DateTimeOffset.UtcNow }, false);
            Assert.Equal(expected, Store.Text(fake.Tables[Tables.Process][process], "rfd_state"));
        }
        [Fact]
        public void FailedDataverseUpdatePropagatesWithoutReusingTransaction()
        {
            fake.FailNextUpdate = true;
            Assert.Throws<FaultException<OrganizationServiceFault>>(() => Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false));
            Assert.Single(fake.Updates);
        }
        [Fact]
        public void CaseLinkRejectsUnrelatedContactAndSnapshotsRealClosedState()
        {
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            Writer().Execute("rfd_RecordEmailProcessEvent", ContactLookup(process, contactId), false);
            var caseId = Guid.NewGuid();
            fake.Seed(new Entity("incident", caseId) { ["customerid"] = new EntityReference("contact", Guid.NewGuid()),
                ["statecode"] = new OptionSetValue(1), ["statuscode"] = new OptionSetValue(5), ["merged"] = false, ["versionnumber"] = 40L });
            var c = new Command { SchemaVersion = 1, ProcessId = process, CaseId = caseId, EventId = Guid.NewGuid(),
                ProducerId = "flow", SourceExecutionId = "run1", Operation = "link", RelationshipRole = "created",
                OccurredAtUtc = DateTimeOffset.UtcNow };
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_LinkEmailProcessCase", c, false));
            fake.Tables["incident"][caseId]["customerid"] = new EntityReference("contact", contactId);
            fake.Seed(new Entity(Tables.StageDefinition, Guid.NewGuid()) { ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId),
                ["rfd_code"] = "human-review", ["rfd_required"] = false, ["rfd_completionauthority"] = "case-observer" });
            Writer().Execute("rfd_LinkEmailProcessCase", c, false);
            var link = fake.Tables[Tables.Case].Values.Single();
            Assert.Equal(1, link.GetAttributeValue<int>("rfd_casestate"));
            Assert.Equal("succeeded", fake.Tables[Tables.Stage].Values.Single(e => Store.Ref(e, "rfd_case") == caseId).GetAttributeValue<string>("rfd_state"));
            var retry = Json.Read<Command>(Json.Write(c));
            retry.CaseState = null; retry.CaseStatus = null; retry.Merged = null; retry.SourceVersion = null;
            Assert.Equal("AlreadyRecorded", Writer().Execute("rfd_LinkEmailProcessCase", retry, false).Status);
        }
        [Fact]
        public void TwoCasesCloseReopenAndLateDeliveryPreserveReviewAttempts()
        {
            fake.Seed(new Entity(Tables.StageDefinition, Guid.NewGuid()) { ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId),
                ["rfd_code"] = "human-review", ["rfd_required"] = false, ["rfd_completionauthority"] = "case-observer" });
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            Writer().Execute("rfd_RecordEmailProcessEvent", new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(),
                StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 1, ProducerId = "flow", SourceExecutionId = "run1",
                Operation = "tool", EventType = "completed", OccurredAtUtc = DateTimeOffset.UtcNow }, false);
            var first = LinkOpenCase(process); var second = LinkOpenCase(process);
            var policy = new Policy { ObserverStepIds = new[] { Guid.NewGuid() } };
            Lifecycle(process, first, 0, 1, "100", policy);
            Assert.Equal("waiting-review", fake.Tables[Tables.Process][process].GetAttributeValue<string>("rfd_state"));
            Lifecycle(process, second, 0, 1, "101", policy);
            Assert.Equal("completed", fake.Tables[Tables.Process][process].GetAttributeValue<string>("rfd_state"));
            Lifecycle(process, first, 1, 0, "200", policy);
            Assert.Equal("waiting-review", fake.Tables[Tables.Process][process].GetAttributeValue<string>("rfd_state"));
            Lifecycle(process, first, 0, 1, "150", policy);
            Assert.Equal("waiting-review", fake.Tables[Tables.Process][process].GetAttributeValue<string>("rfd_state"));
            var firstReviews = fake.Tables[Tables.Stage].Values.Where(e => Store.Ref(e, "rfd_case") == first).OrderBy(e => Store.Int(e, "rfd_attempt")).ToArray();
            Assert.Equal(2, firstReviews.Length);
            Assert.Equal("succeeded", Store.Text(firstReviews[0], "rfd_state"));
            Assert.Equal("waiting", Store.Text(firstReviews[1], "rfd_state"));
        }
        [Fact]
        public void SelectedRequiredBranchPreventsEarlyCompletion()
        {
            var routeId = fake.Tables[Tables.StageDefinition].Values.Single().Id;
            fake.Tables[Tables.StageDefinition][routeId]["rfd_phase"] = "route";
            var targetId = Guid.NewGuid();
            producer.StageCodes = new[] { "tool", "handling" };
            fake.Seed(new Entity(Tables.StageDefinition, targetId) {
                ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId),
                ["rfd_code"] = "handling", ["rfd_required"] = false, ["rfd_completionauthority"] = "tool" });
            fake.Seed(new Entity(Tables.Transition, Guid.NewGuid()) {
                ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId),
                ["rfd_fromstage"] = new EntityReference(Tables.StageDefinition, routeId),
                ["rfd_tostage"] = new EntityReference(Tables.StageDefinition, targetId),
                ["rfd_required"] = true, ["rfd_branchcode"] = "Card Servicing" });
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            var route = new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(),
                StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 1, ProducerId = "flow",
                SourceExecutionId = "run1", Operation = "route", EventType = "completed", OccurredAtUtc = DateTimeOffset.UtcNow };
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", route, false));
            route.Branch = "Card Servicing";
            Writer().Execute("rfd_RecordEmailProcessEvent", route, false);
            Assert.Equal("processing", Store.Text(fake.Tables[Tables.Process][process], "rfd_state"));
            var handler = new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(),
                StageExecutionId = Guid.NewGuid(), StageCode = "handling", Attempt = 1, ProducerId = "flow",
                SourceExecutionId = "run1", Operation = "handle", EventType = "completed", OccurredAtUtc = DateTimeOffset.UtcNow,
                Branch = "unselected" };
            Assert.Throws<ContractException>(() => Writer().Execute("rfd_RecordEmailProcessEvent", handler, false));
            handler.Branch = "Card Servicing";
            Writer().Execute("rfd_RecordEmailProcessEvent", handler, false);
            Assert.Equal("completed", Store.Text(fake.Tables[Tables.Process][process], "rfd_state"));
        }
        [Fact]
        public void OptionalCaseLinkMetadataDoesNotTurnHostCompletionIntoRoutingChoice()
        {
            var host = fake.Tables[Tables.StageDefinition].Values.Single();
            host["rfd_phase"] = "act"; host["rfd_nodekind"] = "subprocess";
            var review = Guid.NewGuid();
            fake.Seed(new Entity(Tables.StageDefinition, review) {
                ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId),
                ["rfd_code"] = "reviewcase", ["rfd_phase"] = "review", ["rfd_completionauthority"] = "case-observer" });
            fake.Seed(new Entity(Tables.Transition, Guid.NewGuid()) {
                ["rfd_definition"] = new EntityReference(Tables.Definition, definitionId),
                ["rfd_fromstage"] = host.ToEntityReference(), ["rfd_tostage"] = new EntityReference(Tables.StageDefinition, review),
                ["rfd_required"] = false, ["rfd_branchcode"] = "case-linked", ["rfd_eventcode"] = "case-linked" });
            var process = Writer().Execute("rfd_RecordEmailProcessEvent", Intake(), false).ProcessId;
            var command = new Command { SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(),
                StageExecutionId = Guid.NewGuid(), StageCode = "tool", Attempt = 1, ProducerId = "flow",
                SourceExecutionId = "run1", Operation = "host-call", EventType = "completed", Branch = "card-servicing",
                OccurredAtUtc = DateTimeOffset.UtcNow };
            Assert.Equal("Applied", Writer().Execute("rfd_RecordEmailProcessEvent", command, false).Status);
            Assert.Equal("succeeded", Store.Text(fake.Tables[Tables.Stage][command.StageExecutionId.Value], "rfd_state"));
            Assert.False(fake.Tables.ContainsKey(Tables.Case));
        }
        private Guid LinkOpenCase(Guid process)
        {
            if (!Store.Ref(fake.Tables[Tables.Process][process], "rfd_contact").HasValue)
                Writer().Execute("rfd_RecordEmailProcessEvent", ContactLookup(process, contactId), false);
            var caseId = Guid.NewGuid();
            fake.Seed(new Entity("incident", caseId) { ["customerid"] = new EntityReference("contact", contactId),
                ["statecode"] = new OptionSetValue(0), ["statuscode"] = new OptionSetValue(1), ["merged"] = false });
            Writer().Execute("rfd_LinkEmailProcessCase", new Command { SchemaVersion = 1, ProcessId = process, CaseId = caseId,
                EventId = Guid.NewGuid(), ProducerId = "flow", SourceExecutionId = "run1", Operation = "link",
                RelationshipRole = "created", OccurredAtUtc = DateTimeOffset.UtcNow }, false);
            return caseId;
        }
        private Command ContactLookup(Guid process, Guid contact) => new Command {
            SchemaVersion = 1, ProcessId = process, EventId = Guid.NewGuid(), StageExecutionId = Guid.NewGuid(),
            StageCode = "tool", Attempt = fake.Tables.TryGetValue(Tables.Stage, out var rows) ?
                rows.Values.Where(e => Store.Ref(e, "rfd_process") == process && !Store.Ref(e, "rfd_case").HasValue)
                    .Select(e => Store.Int(e, "rfd_attempt")).DefaultIfEmpty(0).Max() + 1 : 1,
            ProducerId = "flow", SourceExecutionId = "run1", Operation = "contact-lookup",
            EventType = "completed", OccurredAtUtc = DateTimeOffset.UtcNow, ContactId = contact
        };
        private void Lifecycle(Guid process, Guid caseId, int before, int after, string version, Policy policy)
        {
            var time = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddSeconds(long.Parse(version));
            var pre = new Entity("incident", caseId) { ["statecode"] = new OptionSetValue(before),
                ["statuscode"] = new OptionSetValue(before == 1 ? 5 : 1), ["merged"] = false };
            var post = new Entity("incident", caseId) { ["statecode"] = new OptionSetValue(after),
                ["statuscode"] = new OptionSetValue(after == 1 ? 5 : 1), ["merged"] = false, ["versionnumber"] = long.Parse(version) };
            var parent = new Mock<IPluginExecutionContext>();
            parent.SetupGet(c => c.MessageName).Returns("Update"); parent.SetupGet(c => c.PrimaryEntityName).Returns("incident");
            parent.SetupGet(c => c.Stage).Returns(40); parent.SetupGet(c => c.Mode).Returns(1);
            parent.SetupGet(c => c.UserId).Returns(actor); parent.SetupGet(c => c.InitiatingUserId).Returns(actor);
            parent.SetupGet(c => c.OwningExtension).Returns(new EntityReference("sdkmessageprocessingstep", policy.ObserverStepIds[0]));
            parent.SetupGet(c => c.InputParameters).Returns(new ParameterCollection { ["Target"] = new Entity("incident", caseId) });
            parent.SetupGet(c => c.PreEntityImages).Returns(new EntityImageCollection { ["PreImage"] = pre });
            parent.SetupGet(c => c.PostEntityImages).Returns(new EntityImageCollection { ["PostImage"] = post });
            parent.SetupGet(c => c.OperationCreatedOn).Returns(time);
            context.SetupGet(c => c.ParentContext).Returns(parent.Object);
            var command = new Command { SchemaVersion = 1, ProducerId = "case-observer", ProcessId = process, CaseId = caseId,
                CaseState = after, CaseStatus = after == 1 ? 5 : 1, PreviousCaseState = before, PreviousCaseStatus = before == 1 ? 5 : 1,
                Merged = false, SourceVersion = version, OccurredAtUtc = new DateTimeOffset(time) };
            new Writer(new Store(fake), context.Object, producer, policy).Execute("rfd_RecordCaseLifecycle", command, true);
        }
    }
}
