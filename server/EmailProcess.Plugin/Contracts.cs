using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace EmailProcess.Plugin
{
    public sealed class Command
    {
        public int SchemaVersion { get; set; }
        public Guid EventId { get; set; }
        public Guid? ProcessId { get; set; }
        public Guid? DefinitionId { get; set; }
        public string ProducerId { get; set; }
        public string InternetMessageId { get; set; }
        public string SourceLocator { get; set; }
        public string ActualFrom { get; set; }
        public string ReplyTo { get; set; }
        public Guid? ContactId { get; set; }
        public Guid? EmailId { get; set; }
        public Guid? TaskId { get; set; }
        public Guid? NoteId { get; set; }
        public Guid? HoldingId { get; set; }
        public Guid? WorkflowId { get; set; }
        public Guid? ParentProcessId { get; set; }
        public Guid? BatchId { get; set; }
        public Guid? DraftId { get; set; }
        public Guid? StageExecutionId { get; set; }
        public Guid? ParentExecutionId { get; set; }
        public string StageCode { get; set; }
        public int Attempt { get; set; }
        public string Branch { get; set; }
        public string Operation { get; set; }
        public string SourceExecutionId { get; set; }
        public string SourceVersion { get; set; }
        public string EventType { get; set; }
        public DateTimeOffset OccurredAtUtc { get; set; }
        public string Outcome { get; set; }
        public string ErrorCode { get; set; }
        public decimal? DurationMs { get; set; }
        public int? Usage { get; set; }
        public Guid? CaseId { get; set; }
        public bool BlocksCompletion { get; set; } = true;
        public string RelationshipRole { get; set; }
        public int? CaseState { get; set; }
        public int? CaseStatus { get; set; }
        public bool? Merged { get; set; }
        public int? PreviousCaseState { get; set; }
        public int? PreviousCaseStatus { get; set; }
        public bool ReconciliationRequired { get; set; }
        public string State { get; set; }
        public int PageSize { get; set; } = 50;
        public string Cursor { get; set; }
    }

    public sealed class Receipt
    {
        public int SchemaVersion { get; set; } = 1;
        public Guid ProcessId { get; set; }
        public Guid EventId { get; set; }
        public string Status { get; set; }
        public int Revision { get; set; }
    }

    public static class Json
    {
        private static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            MissingMemberHandling = MissingMemberHandling.Error,
            DateParseHandling = DateParseHandling.None,
            NullValueHandling = NullValueHandling.Ignore,
            TypeNameHandling = TypeNameHandling.None,
            Culture = System.Globalization.CultureInfo.InvariantCulture,
            MaxDepth = 12
        };

        public static string Write(object value) => JsonConvert.SerializeObject(value, Formatting.None, Settings);
        public static T Read<T>(string json)
        {
            if (string.IsNullOrWhiteSpace(json) || json.Length > 32768) throw new ContractException("InvalidEnvelope");
            try { return JsonConvert.DeserializeObject<T>(json, Settings) ?? throw new ContractException("InvalidEnvelope"); }
            catch (JsonException) { throw new ContractException("InvalidEnvelope"); }
        }
    }

    public sealed class ContractException : Exception
    {
        public ContractException(string code) : base(code) { }
    }

    public sealed class Producer
    {
        public string ProducerId { get; set; }
        public string Authority { get; set; }
        public Guid[] UserIds { get; set; } = Array.Empty<Guid>();
        public Guid[] RoleIds { get; set; } = Array.Empty<Guid>();
        public string[] StageCodes { get; set; } = Array.Empty<string>();
        public string[] ErrorCodes { get; set; } = Array.Empty<string>();
        public bool CanReceive { get; set; }
        public bool CanLinkCases { get; set; }
        public bool CanResolveCustomer { get; set; }
        public string[] CustomerResolutionStageCodes { get; set; } = Array.Empty<string>();
    }

    public sealed class Policy
    {
        public Producer[] Producers { get; set; } = Array.Empty<Producer>();
        public Guid[] ObserverStepIds { get; set; } = Array.Empty<Guid>();
        public Guid[] DefinitionAdministratorUserIds { get; set; } = Array.Empty<Guid>();
        public string CursorSigningKey { get; set; }

        public static Policy Load(string secure)
        {
            if (!string.IsNullOrWhiteSpace(secure)) return Json.Read<Policy>(secure);
            using (var stream = typeof(Policy).Assembly.GetManifestResourceStream("EmailProcess.Policy.json"))
            using (var reader = new StreamReader(stream)) return Json.Read<Policy>(reader.ReadToEnd());
        }

        public Producer Authorize(string producerId, Guid actor, Func<Guid, bool> inRole)
        {
            var producer = Producers.SingleOrDefault(p => p.ProducerId == producerId);
            if (producer == null || !producer.UserIds.Contains(actor) ||
                producer.RoleIds.Length == 0 || !producer.RoleIds.Any(inRole))
                throw new ContractException("ProducerNotAuthorized");
            if (producer.Authority != "workflow" && producer.Authority != "tool" && producer.Authority != "intake")
                throw new ContractException("InvalidProducerAuthority");
            return producer;
        }
    }
}
