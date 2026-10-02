using System;
using System.IO;
using System.Linq;
using EmailProcess.Plugin;
using Newtonsoft.Json.Linq;
using Xunit;

namespace EmailProcess.Plugin.Tests
{
    public sealed class RegistrationTests
    {
        [Fact]
        public void RegistrationMatchesActualPluginTypesAndCanonicalActions()
        {
            JObject Read(string name) => JObject.Parse(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, name)));
            var registration = Read("registration.json"); var contract = Read("process-contract.json");
            Assert.Equal(typeof(ProcessApi).FullName, (string)registration["types"]["api"]);
            Assert.Equal(typeof(TableGuard).FullName, (string)registration["types"]["guard"]);
            Assert.Equal(typeof(CaseLifecycleObserver).FullName, (string)registration["types"]["observer"]);
            Assert.Equal(contract["api"]["actions"].Select(x => (string)x).OrderBy(x => x),
                registration["customApis"].Select(x => (string)x["uniquename"]).OrderBy(x => x));
            Assert.Equal(10, (int)registration["customApiDefaults"]["requestParameters"][0]["type"]);
            Assert.Equal(10, (int)registration["customApiDefaults"]["responseProperties"][0]["type"]);
            Assert.False((bool)registration["customApiDefaults"]["isfunction"]);
            Assert.Equal(0, (int)registration["customApiDefaults"]["allowedcustomprocessingsteptype"]);
            Assert.Equal("disabled", (string)registration["observer"]["initialState"]);
            Assert.Equal(1, (int)registration["observer"]["mode"]);
            Assert.Equal(contract["tables"].Select(t => (string)t["logicalName"]).OrderBy(x => x),
                registration["guardGroups"].SelectMany(g => g["tables"]).Select(x => (string)x).OrderBy(x => x));
        }
    }
}
