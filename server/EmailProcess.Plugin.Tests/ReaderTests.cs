using System;
using System.Linq;
using EmailProcess.Plugin;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Moq;
using Newtonsoft.Json.Linq;
using Xunit;

namespace EmailProcess.Plugin.Tests
{
    public sealed class ReaderTests
    {
        [Fact]
        public void EventPagesFreezeUpperRevisionAndOmitSensitiveColumns()
        {
            var organization = Guid.NewGuid(); var actor = Guid.NewGuid(); var processId = Guid.NewGuid();
            var service = new Mock<IOrganizationService>(MockBehavior.Strict);
            var revision = 10;
            service.Setup(s => s.Retrieve(Tables.Process, processId, It.IsAny<ColumnSet>())).Returns(() =>
                new Entity(Tables.Process, processId) { ["rfd_revision"] = revision, ["rfd_coverage"] = "partial" });
            var queryCount = 0;
            service.Setup(s => s.RetrieveMultiple(It.IsAny<QueryBase>())).Returns<QueryBase>(q => {
                var query = Assert.IsType<QueryExpression>(q);
                Assert.Equal(Tables.Event, query.EntityName);
                Assert.False(query.ColumnSet.AllColumns);
                Assert.DoesNotContain("rfd_payloadjson", query.ColumnSet.Columns);
                Assert.DoesNotContain("rfd_internetmessageid", query.ColumnSet.Columns);
                Assert.Equal(10, query.Criteria.Conditions.Single(c => c.AttributeName == "rfd_revision").Values[0]);
                Assert.Equal(processId, query.Criteria.Conditions.Single(c => c.AttributeName == "rfd_process").Values[0]);
                Assert.Equal(2, query.PageInfo.Count);
                queryCount++;
                var rows = new EntityCollection { MoreRecords = queryCount == 1, PagingCookie = queryCount == 1 ? "<cookie />" : null };
                rows.Entities.Add(new Entity(Tables.Event, Guid.NewGuid()) { ["rfd_process"] = new EntityReference(Tables.Process, processId),
                    ["rfd_revision"] = queryCount, ["rfd_eventtype"] = "started", ["rfd_payloadjson"] = "PRIVATE-NOT-RETURNED" });
                return rows;
            });
            var policy = new Policy { CursorSigningKey = Convert.ToBase64String(Enumerable.Range(1, 32).Select(x => (byte)x).ToArray()) };
            var reader = new Reader(new Store(service.Object), organization, actor, policy);
            var first = JObject.Parse(Json.Write(reader.Execute("rfd_GetEmailProcessEvents", new Command {
                SchemaVersion = 1, ProcessId = processId, PageSize = 2 })));
            Assert.Equal(10, (int)first["upperRevision"]); Assert.DoesNotContain("PRIVATE", first.ToString());
            revision = 11;
            var next = new Command { SchemaVersion = 1, ProcessId = processId, PageSize = 2, Cursor = (string)first["nextCursor"] };
            var second = JObject.Parse(Json.Write(reader.Execute("rfd_GetEmailProcessEvents", next)));
            Assert.Equal(10, (int)second["upperRevision"]); Assert.Null(second["nextCursor"]);
            Assert.Throws<ContractException>(() => new Reader(new Store(service.Object), organization, Guid.NewGuid(), policy)
                .Execute("rfd_GetEmailProcessEvents", next));
            service.Verify(s => s.RetrieveMultiple(It.IsAny<QueryBase>()), Times.Exactly(2));
        }
        [Fact]
        public void StateDetectsConcurrentProjectionChangeInsteadOfReturningMixedSnapshot()
        {
            var process = Guid.NewGuid(); var definition = Guid.NewGuid();
            var service = new Mock<IOrganizationService>(MockBehavior.Strict);
            service.SetupSequence(s => s.Retrieve(Tables.Process, process, It.IsAny<ColumnSet>()))
                .Returns(new Entity(Tables.Process, process) { ["rfd_revision"] = 1, ["rfd_definition"] = new EntityReference(Tables.Definition, definition) })
                .Returns(new Entity(Tables.Process, process) { ["rfd_revision"] = 2 });
            service.Setup(s => s.RetrieveMultiple(It.IsAny<QueryBase>())).Returns(new EntityCollection());
            var error = Assert.Throws<ContractException>(() => new Reader(new Store(service.Object), Guid.NewGuid(), Guid.NewGuid(), new Policy())
                .Execute("rfd_GetEmailProcessState", new Command { ProcessId = process }));
            Assert.Equal("ReadChangedRetry", error.Message);
        }
        [Fact]
        public void ReadBoundsAndUnknownActionsFailBeforeAnyQueries()
        {
            var service = new Mock<IOrganizationService>(MockBehavior.Strict);
            var reader = new Reader(new Store(service.Object), Guid.NewGuid(), Guid.NewGuid(), new Policy());
            Assert.Throws<ContractException>(() => reader.Execute("rfd_ListEmailProcesses", new Command { PageSize = 101 }));
            Assert.Throws<ContractException>(() => reader.Execute("RetrieveAnything", new Command()));
            Assert.Throws<ContractException>(() => reader.Execute("rfd_ListEmailProcesses", new Command { State = "not-a-state" }));
            service.VerifyNoOtherCalls();
        }
    }
}
