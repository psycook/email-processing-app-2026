using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace EmailProcess.Plugin
{
    public static class Keys
    {
        public static string Hash(params string[] components)
        {
            using (var buffer = new MemoryStream())
            using (var sha = SHA256.Create())
            {
                foreach (var component in components)
                {
                    if (component == null) throw new ContractException("NullKeyComponent");
                    var bytes = Encoding.UTF8.GetBytes(component);
                    var n = bytes.Length;
                    buffer.WriteByte((byte)(n >> 24)); buffer.WriteByte((byte)(n >> 16));
                    buffer.WriteByte((byte)(n >> 8)); buffer.WriteByte((byte)n);
                    buffer.Write(bytes, 0, bytes.Length);
                }
                return string.Concat(sha.ComputeHash(buffer.ToArray()).Select(b => b.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        public static string Id(Guid id) => id.ToString("D").ToLowerInvariant();
        public static string Ingest(Guid organization, string internetMessageId)
        {
            if (string.IsNullOrWhiteSpace(internetMessageId)) throw new ContractException("InternetMessageIdRequired");
            if (internetMessageId.Length > 2000) throw new ContractException("InternetMessageIdTooLong");
            return Hash("v1", Id(organization), "help-inbox", internetMessageId.Trim());
        }
        public static string Operation(Guid process, Command c) => Hash("operation-v1", Id(process), c.ProducerId,
            c.SourceExecutionId, c.Operation, c.StageCode, c.Branch ?? "", c.CaseId?.ToString("D") ?? "", c.Attempt.ToString(CultureInfo.InvariantCulture));
        public static string Event(Guid process, Command c) => Hash("event-v1", Id(process), c.ProducerId,
            c.SourceExecutionId, c.Operation, c.StageCode ?? "", c.Branch ?? "", c.CaseId?.ToString("D") ?? "",
            c.Attempt.ToString(CultureInfo.InvariantCulture), c.EventType, c.SourceVersion ?? "");
        public static Guid StableGuid(params string[] parts) => new Guid(Hash(parts).Substring(0, 32));
        public static long Version(string value)
        {
            if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var version) || version < 0)
                throw new ContractException("NumericSourceVersionRequired");
            return version;
        }
    }

    public sealed class Execution
    {
        public Guid Id { get; set; }
        public string StageCode { get; set; }
        public string Branch { get; set; }
        public int Attempt { get; set; }
        public string State { get; set; }
        public DateTime? StartedAt { get; set; }
        public DateTime? EndedAt { get; set; }
        public string SourceVersion { get; set; }
        public Guid? CaseId { get; set; }
    }

    public sealed class CaseFact
    {
        public Guid CaseId { get; set; }
        public bool BlocksCompletion { get; set; }
        public int State { get; set; }
        public int Status { get; set; }
        public bool Merged { get; set; }
        public string Version { get; set; }
        public bool ReconciliationRequired { get; set; }
    }

    public static class Reducer
    {
        private static readonly string[] Terminal = { "succeeded", "failed", "skipped", "cancelled" };
        public static bool IsTerminal(string state) => Terminal.Contains(state);

        public static void Apply(Execution execution, string eventType, DateTime occurred, string version)
        {
            var state = eventType == "started" ? "running" : eventType == "completed" ? "succeeded" :
                eventType == "waiting" ? "waiting" : eventType;
            if (!new[] { "running", "waiting", "succeeded", "failed", "skipped", "cancelled" }.Contains(state))
                throw new ContractException("InvalidExecutionEvent");
            if (!string.IsNullOrEmpty(version) && !string.IsNullOrEmpty(execution.SourceVersion) &&
                Keys.Version(version) < Keys.Version(execution.SourceVersion)) return;
            if (IsTerminal(execution.State))
            {
                if (!IsTerminal(state)) return;
                if (execution.State != state) throw new ContractException("TerminalOutcomeConflictNewAttemptRequired");
                return;
            }
            if (state == "running" && execution.State == "waiting") return;
            execution.State = state;
            if (state == "running" && !execution.StartedAt.HasValue) execution.StartedAt = occurred;
            if (IsTerminal(state)) execution.EndedAt = occurred;
            if (!string.IsNullOrEmpty(version)) execution.SourceVersion = version;
        }

        public static bool ApplyCase(CaseFact current, CaseFact next)
        {
            if (!string.IsNullOrEmpty(current.Version))
            {
                var comparison = Keys.Version(next.Version).CompareTo(Keys.Version(current.Version));
                if (comparison < 0) return false;
                if (comparison == 0)
                {
                    if (current.State != next.State || current.Status != next.Status || current.Merged != next.Merged)
                        throw new ContractException("CaseVersionConflict");
                    current.ReconciliationRequired |= next.ReconciliationRequired;
                    return false;
                }
            }
            current.State = next.State; current.Status = next.Status; current.Version = next.Version;
            current.Merged = next.Merged; current.ReconciliationRequired |= next.ReconciliationRequired;
            return true;
        }

        public static string Process(IEnumerable<string> requiredStageCodes, IEnumerable<Execution> executions,
            IEnumerable<CaseFact> cases, bool allowCaseFree, bool reconciliation)
        {
            var all = executions.ToList();
            var latest = all.GroupBy(e => (e.StageCode ?? "") + "\u001f" + (e.Branch ?? "") + "\u001f" + e.CaseId)
                .Select(g => g.OrderByDescending(e => e.Attempt).First()).ToList();
            var links = cases.ToList();
            if (reconciliation || links.Any(c => c.ReconciliationRequired)) return "needs-reconciliation";
            if (links.Any(c => c.BlocksCompletion && c.Merged)) return "needs-reconciliation";
            if (links.Any(c => c.BlocksCompletion && c.State == 2)) return "cancelled";
            if (latest.Any(e => e.State == "failed")) return "failed";
            if (latest.Any(e => e.State == "cancelled")) return "cancelled";
            if (links.Any(c => c.BlocksCompletion && c.State == 0) || latest.Any(e => e.State == "waiting")) return "waiting-review";
            var required = requiredStageCodes.ToList();
            var requiredDone = required.Count > 0 && required.All(code => latest.Any(e => e.StageCode == code) &&
                latest.Where(e => e.StageCode == code).All(e => e.State == "succeeded"));
            var allDone = latest.Count > 0 && latest.All(e => e.State == "succeeded" || e.State == "skipped");
            if (requiredDone && allDone && (allowCaseFree || links.Any(c => c.BlocksCompletion)) &&
                links.Where(c => c.BlocksCompletion).All(c => c.State == 1)) return "completed";
            return all.Count == 0 && links.Count == 0 ? "received" : "processing";
        }

        public static void CheckDigest(string stored, string incoming)
        {
            if (!string.Equals(stored, incoming, StringComparison.Ordinal)) throw new ContractException("IdempotencyConflict");
        }
    }
}
