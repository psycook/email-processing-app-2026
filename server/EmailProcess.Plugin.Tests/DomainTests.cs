using System;
using System.Linq;
using EmailProcess.Plugin;
using Microsoft.Xrm.Sdk;
using Moq;
using Xunit;

namespace EmailProcess.Plugin.Tests
{
    public sealed class DomainTests
    {
        [Fact]
        public void LengthPrefixIsUtf8BigEndianAndUnambiguous()
        {
            Assert.Equal("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Keys.Hash());
            Assert.NotEqual(Keys.Hash("ab", "c"), Keys.Hash("a", "bc"));
            using (var sha = System.Security.Cryptography.SHA256.Create())
                Assert.Equal(string.Concat(sha.ComputeHash(new byte[] { 0, 0, 0, 2, 0xc3, 0xa9 }).Select(b => b.ToString("x2"))), Keys.Hash("é"));
        }
        [Fact]
        public void IngestPreservesCaseBracketsOrganizationAndTrimsOnlyEdges()
        {
            var organization = Guid.Parse("00000000-0000-0000-0000-000000000001");
            Assert.Equal(Keys.Ingest(organization, "<A@b>"), Keys.Ingest(organization, " \r\n<A@b> \t"));
            Assert.NotEqual(Keys.Ingest(organization, "<A@b>"), Keys.Ingest(organization, "<a@b>"));
            Assert.NotEqual(Keys.Ingest(organization, "<A@b>"), Keys.Ingest(organization, "A@b"));
            Assert.NotEqual(Keys.Ingest(organization, "<A@b>"), Keys.Ingest(Guid.NewGuid(), "<A@b>"));
            Assert.Throws<ContractException>(() => Keys.Ingest(organization, " "));
            Assert.Throws<ContractException>(() => Keys.Ingest(organization, new string('a', 2001)));
        }
        [Fact]
        public void EventAndOperationIdentitiesAreStableAndAttemptScoped()
        {
            var c = new Command { ProducerId = "flow", SourceExecutionId = "run1", Operation = "classify", StageCode = "classify",
                Branch = "route", Attempt = 1, EventType = "started" };
            var process = Guid.NewGuid();
            var operation = Keys.Operation(process, c); var source = Keys.Event(process, c);
            c.EventId = Guid.NewGuid();
            Assert.Equal(source, Keys.Event(process, c));
            c.EventType = "completed";
            Assert.Equal(operation, Keys.Operation(process, c)); Assert.NotEqual(source, Keys.Event(process, c));
            c.Attempt = 2; Assert.NotEqual(operation, Keys.Operation(process, c));
        }
        [Fact]
        public void DuplicatePayloadIsAcceptedButChangedFactsConflict()
        {
            Reducer.CheckDigest("same", "same");
            Assert.Throws<ContractException>(() => Reducer.CheckDigest("same", "different"));
        }
        [Fact]
        public void LateStartAndOldSourceCannotRegressTerminalOutcome()
        {
            var execution = new Execution();
            Reducer.Apply(execution, "completed", DateTime.UtcNow, "20");
            Reducer.Apply(execution, "started", DateTime.UtcNow.AddMinutes(-1), "10");
            Assert.Equal("succeeded", execution.State); Assert.Equal("20", execution.SourceVersion);
            Reducer.Apply(execution, "started", DateTime.UtcNow, "21");
            Assert.Equal("succeeded", execution.State);
            Assert.Throws<ContractException>(() => Reducer.Apply(execution, "failed", DateTime.UtcNow, "22"));
        }
        [Fact]
        public void MultipleCasesRequireEveryBlockingCaseAndBranches()
        {
            var execution = new Execution { StageCode = "tool", State = "succeeded", Attempt = 1 };
            var cases = new[] { new CaseFact { State = 1, BlocksCompletion = true }, new CaseFact { State = 0, BlocksCompletion = true } };
            Assert.Equal("waiting-review", Reducer.Process(new[] { "tool" }, new[] { execution }, cases, false, false));
            cases[1].State = 1;
            Assert.Equal("completed", Reducer.Process(new[] { "tool" }, new[] { execution }, cases, false, false));
            Assert.Equal("processing", Reducer.Process(new[] { "tool", "routing" }, new[] { execution }, cases, false, false));
            cases[1].State = 2;
            Assert.Equal("cancelled", Reducer.Process(new[] { "tool" }, new[] { execution }, cases, false, false));
            cases[1].Merged = true;
            Assert.Equal("needs-reconciliation", Reducer.Process(new[] { "tool" }, new[] { execution }, cases, false, false));
        }
        [Fact]
        public void ReopenSurvivesOlderClosureAndVersionConflictsFail()
        {
            var fact = new CaseFact { State = 1, Status = 5, Version = "20" };
            Assert.True(Reducer.ApplyCase(fact, new CaseFact { State = 0, Status = 1, Version = "30" }));
            Assert.False(Reducer.ApplyCase(fact, new CaseFact { State = 1, Status = 5, Version = "20" }));
            Assert.Equal(0, fact.State);
            Assert.Throws<ContractException>(() => Reducer.ApplyCase(fact, new CaseFact { State = 1, Status = 5, Version = "30" }));
        }
        [Fact]
        public void ReplayHasSameOutcomeAndDistinctRetryReplacesFailedAttempt()
        {
            Func<Execution> replay = () => {
                var result = new Execution { StageCode = "tool", Attempt = 1 };
                Reducer.Apply(result, "started", new DateTime(2026, 1, 1), "1");
                Reducer.Apply(result, "completed", new DateTime(2026, 1, 1).AddSeconds(2), "2");
                Reducer.Apply(result, "started", new DateTime(2026, 1, 1), "1");
                return result;
            };
            Assert.Equal(Json.Write(replay()), Json.Write(replay()));
            var failed = new Execution { StageCode = "tool", Attempt = 1, State = "failed" };
            var retry = new Execution { StageCode = "tool", Attempt = 2, State = "succeeded" };
            Assert.Equal("completed", Reducer.Process(new[] { "tool" }, new[] { failed, retry }, Array.Empty<CaseFact>(), true, false));
        }
        [Fact]
        public void ProducerRequiresBothExplicitIdentityAndAllowedRole()
        {
            var user = Guid.NewGuid(); var role = Guid.NewGuid();
            var policy = new Policy { Producers = new[] { new Producer { ProducerId = "flow", Authority = "workflow", UserIds = new[] { user }, RoleIds = new[] { role } } } };
            Assert.Throws<ContractException>(() => policy.Authorize("flow", Guid.NewGuid(), _ => true));
            Assert.Throws<ContractException>(() => policy.Authorize("flow", user, _ => false));
            Assert.Throws<ContractException>(() => policy.Authorize("browser", user, _ => true));
            Assert.Equal("flow", policy.Authorize("flow", user, r => r == role).ProducerId);
        }
        [Fact]
        public void CallerCannotForgeTrustedParentBySupplyingSharedFlag()
        {
            var actor = Guid.NewGuid();
            var browser = new Mock<IPluginExecutionContext>();
            browser.SetupGet(c => c.Stage).Returns(30);
            browser.SetupGet(c => c.UserId).Returns(actor); browser.SetupGet(c => c.InitiatingUserId).Returns(actor);
            browser.SetupGet(c => c.IsInTransaction).Returns(true);
            browser.SetupGet(c => c.MessageName).Returns("rfd_GetEmailProcessState");
            browser.SetupGet(c => c.OwningExtension).Returns(new EntityReference("plugintype", Guid.NewGuid()));
            browser.SetupGet(c => c.SharedVariables).Returns(new ParameterCollection { [ProcessApi.WriteMarker] = Guid.NewGuid() });
            Assert.Null(Trust.WriteScope(browser.Object, actor));
        }
        [Fact]
        public void CursorsRejectTamperingScopeChangesAndExpiry()
        {
            var codec = new CursorCodec(Convert.ToBase64String(Enumerable.Range(0, 32).Select(i => (byte)i).ToArray()));
            var encoded = codec.Encode(new Cursor { Scope = "caller-a/query-a", Page = 2, UpperRevision = 10, ExpiresAtUtc = DateTime.UtcNow.AddMinutes(1) });
            Assert.Equal(10, codec.Decode(encoded, "caller-a/query-a").UpperRevision);
            Assert.Throws<ContractException>(() => codec.Decode(encoded, "caller-b/query-a"));
            Assert.Throws<ContractException>(() => codec.Decode("A" + encoded.Substring(1), "caller-a/query-a"));
            var expired = codec.Encode(new Cursor { Scope = "x", Page = 1, ExpiresAtUtc = DateTime.UtcNow.AddSeconds(-1) });
            Assert.Throws<ContractException>(() => codec.Decode(expired, "x"));
        }
        [Fact]
        public void EnvelopeRejectsUnknownFieldsAndUnsupportedArbitraryPayloads()
        {
            Assert.Throws<ContractException>(() => Json.Read<Command>("{\"schemaVersion\":1,\"emailBody\":\"private\"}"));
            Assert.Throws<ContractException>(() => Json.Read<Command>(new string('a', 32769)));
        }
    }
}
