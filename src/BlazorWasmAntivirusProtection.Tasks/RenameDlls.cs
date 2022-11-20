namespace BlazorWasmAntivirusProtection.Tasks
{
    using Brotli;
    using Microsoft.Build.Framework;
    using Microsoft.Build.Utilities;
    using System;
    using System.Diagnostics;
    using System.IO;
    using System.IO.Compression;
    using System.Linq;
    using System.Net.Http;
    using System.Security.Cryptography;
    using System.Text;
    using System.Text.Json;

    public class RenameDlls : Task
    {
        [Required]
        public string PublishDir { get; set; }

        public string RenameDllsTo { get; set; } = "bin";
        public bool DisableRenamingDlls { get; set; }
        public bool BlazorEnableCompression { get; set; } = true;
        public string CompressionLevel { get; set; }

        public override bool Execute()
        {
//#if DEBUG
//            System.Diagnostics.Debugger.Launch();
//#endif
            if (DisableRenamingDlls)
            {
                Log.LogMessage(MessageImportance.High, $"BlazorWasmAntivirusProtection: Skipping renaming .dll files");
                return true;
            }
            Log.LogMessage(MessageImportance.High, $"BlazorWasmAntivirusProtection: Renaming .dll files to .{RenameDllsTo}");
            var frameworkDirs = Directory.GetDirectories(PublishDir, "_framework", SearchOption.AllDirectories);
            foreach(var frameworkDir in frameworkDirs)
            {
                foreach (var file in Directory.GetFiles(frameworkDir, "*.*", SearchOption.AllDirectories))
                {
                    if (file.EndsWith(".dll") || file.EndsWith(".dll.gz") || file.EndsWith(".dll.br"))
                    {
                        var newName = file.Replace(".dll", $".{RenameDllsTo}");
                        Log.LogMessage(MessageImportance.High, $"BlazorWasmAntivirusProtection: Renaming \"{file}\" to \"{newName}\"");
                        if (File.Exists(newName)) File.Delete(newName);
                        File.Move(file, newName);
                    }
                }
                var bootJsonPath = Path.Combine(frameworkDir, "blazor.boot.json");
                var bootJsonGzPath = Path.Combine(frameworkDir, "blazor.boot.json.gz");
                var bootJsonBrPath = Path.Combine(frameworkDir, "blazor.boot.json.br");
                var serviceWorkerPathAssets = Path.Combine(frameworkDir, $"..{Path.DirectorySeparatorChar}service-worker-assets.js");


                Log.LogMessage(MessageImportance.High, $"BlazorWasmAntivirusProtection: Updating \"{bootJsonPath}\"");
                var bootJson = File.ReadAllText(bootJsonPath);
                bootJson = bootJson.Replace(".dll", $".{RenameDllsTo}");
                File.WriteAllText(bootJsonPath, bootJson);

                if (File.Exists(serviceWorkerPathAssets))
                {
                    Log.LogMessage(MessageImportance.High, $"BlazorWasmAntivirusProtection: Updating \"{serviceWorkerPathAssets}\"");
                    var serviceWorkerAssets = File.ReadAllText(serviceWorkerPathAssets);
                    serviceWorkerAssets = serviceWorkerAssets.Replace(".dll", $".{RenameDllsTo}");
                    var assetsManifest = JsonSerializer.Deserialize<AssetsManifest>(serviceWorkerAssets.Replace("self.assetsManifest = ", "").Trim().TrimEnd(';'));
                    var bootJsonAssetEntry = assetsManifest.assets.First(x => x.url.EndsWith("blazor.boot.json"));
                    bootJsonAssetEntry.hash = $"sha256-{ComputeSha256Hash(bootJson)}";
                    //var bootJsonModel = JsonSerializer.Deserialize<BlazorBoot>(bootJson);
                    //foreach(var assembly in bootJsonModel.resources.assembly)
                    //{
                    //    var assemblyName = assembly.Key;
                    //    var assemblyHash = assembly.Value;
                    //    var asset = assetsManifest.assets.First(x => x.url.EndsWith(assemblyName));
                    //    asset.hash = assemblyHash;
                    //}
                    serviceWorkerAssets = $"self.assetsManifest = {JsonSerializer.Serialize(assetsManifest, new JsonSerializerOptions { WriteIndented = true })};";
                    File.WriteAllText(serviceWorkerPathAssets, serviceWorkerAssets);
                }

                if (File.Exists(bootJsonGzPath) && BlazorEnableCompression)
                {
                    Log.LogMessage(MessageImportance.High, $"BlazorWasmAntivirusProtection: Recompressing \"{bootJsonGzPath}\"");
                    GZipCompress(bootJsonPath, bootJsonGzPath);
                }
                if (File.Exists(bootJsonBrPath) && BlazorEnableCompression)
                {
                    Log.LogMessage(MessageImportance.High, $"BlazorWasmAntivirusProtection: Recompressing \"{bootJsonBrPath}\"");
                    BrotliCompress(bootJsonPath, bootJsonBrPath);
                }
            }
            
            Log.LogMessage(MessageImportance.High, $"BlazorWasmAntivirusProtection: Renaming .dll files to .{RenameDllsTo} finished");

            return true;
        }

        private void GZipCompress(string bootJsonPath, string bootJsonGzPath)
        {
            try
            {
                File.Delete(bootJsonGzPath);
                using var fileStream = File.OpenRead(bootJsonPath);
                using var stream = File.Create(bootJsonGzPath);
                using var destination = new GZipStream(stream, System.IO.Compression.CompressionLevel.Optimal);
                fileStream.CopyTo(destination);
            }
            catch (Exception ex)
            {
                Log.LogErrorFromException(ex);
            }
        }

        private void BrotliCompress(string bootJsonPath, string bootJsonBrPath)
        {
            try
            {
                File.Delete(bootJsonBrPath);
                var compressionLevel = Enum.TryParse<CompressionLevel>(CompressionLevel, out var level) ? level : System.IO.Compression.CompressionLevel.Optimal;
                using var fileStream = File.OpenRead(bootJsonPath);
                using var stream = File.Create(bootJsonBrPath);
                fileStream.CompressToBrotli(stream, compressionLevel switch
                {
                    System.IO.Compression.CompressionLevel.Optimal => 11,
                    System.IO.Compression.CompressionLevel.Fastest => 5,
                    System.IO.Compression.CompressionLevel.NoCompression=> 0,
                });
            }
            catch (Exception ex)
            {
                Log.LogErrorFromException(ex);
            }
        }

        string ComputeSha256Hash(string rawData)
        {
            using var sha256Hash = SHA256.Create();
            byte[] hash = sha256Hash.ComputeHash(Encoding.UTF8.GetBytes(rawData));
            return Convert.ToBase64String(hash);
        }
    }
}
