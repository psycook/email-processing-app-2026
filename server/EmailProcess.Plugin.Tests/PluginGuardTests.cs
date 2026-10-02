using System;
using EmailProcess.Plugin;
using Microsoft.Xrm.Sdk;
using Moq;
using Xunit;

namespace EmailProcess.Plugin.Tests
{
    public sealed class PluginGuardTests
    {
        [Theory]
        [InlineData("Create", Tables.Event)]
        [InlineData("Update", Tables.Event)]
        [InlineData("Delete", Tables.Event)]
        [InlineData("Create", Tables.Process)]
        [InlineData("Update", Tables.Stage)]
        [InlineData("Upsert", Tables.Case)]
        [InlineData("Assign", Tables.Process)]
        public void DirectRuntimeMutationDenied(string message, string table)
        {
            var actor = Guid.NewGuid();
            var context = new Mock<IPluginExecutionContext>();
            context.SetupGet(c => c.Stage).Returns(20);
            context.SetupGet(c => c.UserId).Returns(actor); context.SetupGet(c => c.InitiatingUserId).Returns(actor);
            context.SetupGet(c => c.MessageName).Returns(message); context.SetupGet(c => c.PrimaryEntityName).Returns(table);
            context.SetupGet(c => c.InputParameters).Returns(new ParameterCollection { ["Target"] = new Entity(table, Guid.NewGuid()) });
            var services = Provider(context.Object, actor, out _);
            Assert.Throws<InvalidPluginExecutionException>(() => new TableGuard().Execute(services));
        }
        [Fact]
        public void ApiRejectsBrowserOutcomeAndRequiresCallerIdentity()
        {
            var actor = Guid.NewGuid();
            var context = new Mock<IPluginExecutionContext>();
            context.SetupGet(c => c.Stage).Returns(30); context.SetupGet(c => c.IsInTransaction).Returns(true);
            context.SetupGet(c => c.UserId).Returns(actor); context.SetupGet(c => c.InitiatingUserId).Returns(actor);
            context.SetupGet(c => c.MessageName).Returns("rfd_RecordEmailProcessEvent");
            context.SetupGet(c => c.InputParameters).Returns(new ParameterCollection { ["RequestJson"] =
                "{\"schemaVersion\":1,\"producerId\":\"browser\",\"eventType\":\"completed\"}" });
            var provider = Provider(context.Object, actor, out var factory);
            var error = Assert.Throws<InvalidPluginExecutionException>(() => new ProcessApi().Execute(provider));
            Assert.Contains("ProducerNotAuthorized", error.Message);
            factory.Verify(f => f.CreateOrganizationService(actor), Times.Once);
            factory.Verify(f => f.CreateOrganizationService(null), Times.Never);
        }
        [Fact]
        public void ApiRefusesNontransactionalWrites()
        {
            var actor = Guid.NewGuid();
            var context = new Mock<IPluginExecutionContext>();
            context.SetupGet(c => c.Stage).Returns(30); context.SetupGet(c => c.UserId).Returns(actor);
            context.SetupGet(c => c.InitiatingUserId).Returns(actor);
            context.SetupGet(c => c.MessageName).Returns("rfd_RecordEmailProcessEvent");
            context.SetupGet(c => c.InputParameters).Returns(new ParameterCollection { ["RequestJson"] = "{\"schemaVersion\":1}" });
            var provider = Provider(context.Object, actor, out _);
            Assert.Contains("TransactionalMainOperationRequired", Assert.Throws<InvalidPluginExecutionException>(() =>
                new ProcessApi().Execute(provider)).Message);
        }
        private static IServiceProvider Provider(IPluginExecutionContext context, Guid actor, out Mock<IOrganizationServiceFactory> factory)
        {
            factory = new Mock<IOrganizationServiceFactory>(MockBehavior.Strict);
            factory.Setup(f => f.CreateOrganizationService(actor)).Returns(new FakeDataverse());
            var services = new Mock<IServiceProvider>();
            services.Setup(s => s.GetService(typeof(IPluginExecutionContext))).Returns(context);
            services.Setup(s => s.GetService(typeof(IOrganizationServiceFactory))).Returns(factory.Object);
            services.Setup(s => s.GetService(typeof(ITracingService))).Returns(Mock.Of<ITracingService>());
            return services.Object;
        }
    }
}
