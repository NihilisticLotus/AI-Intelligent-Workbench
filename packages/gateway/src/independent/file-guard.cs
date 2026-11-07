// 可信文本文件宿主：路径逐段核对并固定目录句柄，文件共享模式覆盖读取 / 校验 / 写入全程。
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public sealed class AicFileGuard : IDisposable {
    const uint Read = 0x80000000, Write = 0x40000000, Attributes = 0x80;
    const uint Reparse = 0x00200000, BackupSemantics = 0x02000000;
    const int Limit = 512 * 1024;
    readonly string root;
    readonly string protectedRoot;
    readonly List<SafeFileHandle> roots = new List<SafeFileHandle>();
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveTypeW(string root);

    public sealed class Blob { public byte[] Bytes; public string Hash, FileId; }
    public sealed class Hit { public string Path, TextBase64; public int Line; public bool TextTruncated; }
    public sealed class SearchResult { public List<Hit> Matches = new List<Hit>(); public int ScannedFiles, ScannedBytes, Skipped; public bool Truncated; }
    static Exception Error(string reason) { return new InvalidOperationException("aic_" + reason); }
    static void WinError(int? error = null) {
        int code = error ?? Marshal.GetLastWin32Error();
        throw Error(code == 2 || code == 3 ? "not_found" : code == 32 || code == 33 ? "busy" : code == 80 || code == 183 ? "conflict" : code == 5 ? "forbidden" : "io_error");
    }
    static bool Blocked(string part) {
        string value = part.ToLowerInvariant();
        return new HashSet<string> { ".git", ".aic-data", ".claude", ".codex", ".codebuddy", ".workbuddy", ".zcode", ".ssh", ".aws", ".azure", "auth.json", "credentials.json", "credentials", ".npmrc", ".netrc", ".pypirc" }.Contains(value)
            || value == ".env" || value.StartsWith(".env.") || value.EndsWith(".pem") || value.EndsWith(".key") || value.EndsWith(".pfx") || value.EndsWith(".p12");
    }
    static void Component(string part) {
        if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.Length > 200 || part.TrimEnd('.', ' ') != part
            || part.IndexOfAny(new char[] { '<', '>', ':', '"', '/', '\\', '|', '?', '*', '\0' }) >= 0
            || Regex.IsMatch(part, "[\\x00-\\x1f\\x7f]") || Regex.IsMatch(part, "^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\\.|$)", RegexOptions.IgnoreCase) || Blocked(part)) throw Error("forbidden");
    }
    static string Final(SafeFileHandle handle) {
        StringBuilder result = new StringBuilder(32768);
        uint size = GetFinalPathNameByHandleW(handle, result, (uint)result.Capacity, 0);
        if (size == 0 || size >= result.Capacity) throw Error("forbidden");
        string value = result.ToString();
        if (!value.StartsWith("\\\\?\\") || value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) throw Error("forbidden");
        return value.Substring(4).TrimEnd('\\');
    }
    static SafeFileHandle Open(string path, bool directory, bool write, bool create) {
        SafeFileHandle handle = CreateFileW(path, directory ? Attributes : Read | (write ? Write : 0), create ? 0U : 1U,
            IntPtr.Zero, create ? 1U : 3U, Reparse | BackupSemantics, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); WinError(error); }
        try {
            Info info;
            if (GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out info)) throw Error("forbidden");
            if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && info.Links != 1)
                || !String.Equals(Final(handle), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw Error("forbidden");
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    public AicFileGuard(string workspace, string privateRoot) {
        try {
            if (!Regex.IsMatch(workspace, "^[a-zA-Z]:\\\\") || workspace.IndexOf('/') >= 0) throw Error("forbidden");
            root = Path.GetFullPath(workspace).TrimEnd('\\');
            protectedRoot = Path.GetFullPath(privateRoot).TrimEnd('\\');
            if (String.Equals(root, protectedRoot, StringComparison.OrdinalIgnoreCase) || root.StartsWith(protectedRoot + "\\", StringComparison.OrdinalIgnoreCase)) throw Error("forbidden");
            string drive = Path.GetPathRoot(root); uint kind = GetDriveTypeW(drive);
            if (root.Length <= 3 || (kind != 2 && kind != 3)) throw Error("forbidden");
            string current = drive;
            roots.Add(Open(current, true, false, false));
            foreach (string part in root.Substring(drive.Length).Split('\\')) { Component(part); current = Path.Combine(current, part); roots.Add(Open(current, true, false, false)); }
        } catch { Dispose(); throw; }
    }
    string Target(string relative) {
        if (relative == null || relative.Length > 1000 || relative.IndexOf('\\') >= 0) throw Error("forbidden");
        foreach (string part in relative.Split('/')) Component(part);
        string full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', '\\')));
        if (!full.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase) || String.Equals(full, protectedRoot, StringComparison.OrdinalIgnoreCase) || full.StartsWith(protectedRoot + "\\", StringComparison.OrdinalIgnoreCase)) throw Error("forbidden");
        return full;
    }
    List<SafeFileHandle> Parents(string target, bool create) {
        List<SafeFileHandle> held = new List<SafeFileHandle>();
        try {
            string parent = Path.GetDirectoryName(target), current = root;
            string suffix = parent.Substring(root.Length).TrimStart('\\');
            if (suffix.Length > 0) foreach (string part in suffix.Split('\\')) {
                current = Path.Combine(current, part);
                if (create && !Directory.Exists(current)) Directory.CreateDirectory(current);
                held.Add(Open(current, true, false, false));
            }
            return held;
        } catch { foreach (SafeFileHandle handle in held) handle.Dispose(); throw; }
    }
    static string Hash(byte[] bytes) { using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static byte[] Content(FileStream stream, int maximum) {
        if (stream.Length > Math.Min(Limit, maximum)) throw Error("too_large");
        byte[] bytes = new byte[(int)stream.Length]; int position = 0, read;
        while (position < bytes.Length && (read = stream.Read(bytes, position, bytes.Length - position)) > 0) position += read;
        if (position != bytes.Length) throw Error("io_error");
        ValidateText(bytes); return bytes;
    }
    static void ValidateText(byte[] bytes) {
        if (bytes.Length > Limit) throw Error("too_large");
        if (Array.IndexOf(bytes, (byte)0) >= 0) throw Error("binary");
        try { Utf8.GetString(bytes); } catch { throw Error("binary"); }
    }
    public Blob ReadFile(string relative) { return ReadFileWithin(relative, Limit); }
    public Blob ReadFileWithin(string relative, int maximum) {
        string target = Target(relative); List<SafeFileHandle> held = Parents(target, false);
        try { using (SafeFileHandle handle = Open(target, false, false, false)) {
            Info info; if (!GetFileInformationByHandle(handle, out info)) WinError();
            using (FileStream stream = new FileStream(handle, FileAccess.Read)) {
                byte[] bytes = Content(stream, maximum);
                return new Blob { Bytes = bytes, Hash = Hash(bytes), FileId = info.Volume.ToString("x8") + "-" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8") };
            }
        } } finally { foreach (SafeFileHandle handle in held) handle.Dispose(); }
    }
    public string WriteFile(string relative, string expectedHash, byte[] bytes, bool create, bool createParents) {
        ValidateText(bytes); string target = Target(relative); List<SafeFileHandle> held = Parents(target, create && createParents);
        try { using (SafeFileHandle handle = Open(target, false, true, create)) using (FileStream stream = new FileStream(handle, FileAccess.ReadWrite)) {
            if (!create) { byte[] old = Content(stream, Limit); if (Hash(old) != expectedHash) throw Error("conflict"); }
            stream.Position = 0;
            stream.Write(bytes, 0, bytes.Length); stream.SetLength(bytes.Length); stream.Flush(true);
            return Hash(bytes);
        } } finally { foreach (SafeFileHandle handle in held) handle.Dispose(); }
    }
    public SearchResult Search(string[] paths, string query, bool caseSensitive, int maxMatches) {
        SearchResult result = new SearchResult(); int outputBytes = 0;
        foreach (string relative in paths) {
            if (result.ScannedBytes >= 16 * 1024 * 1024 || result.ScannedFiles >= 2000) { result.Truncated = true; break; }
            Blob blob; try { blob = ReadFileWithin(relative, 16 * 1024 * 1024 - result.ScannedBytes); } catch { result.Skipped++; continue; }
            result.ScannedFiles++; result.ScannedBytes += blob.Bytes.Length;
            string text = Utf8.GetString(blob.Bytes); if (text.Length > 0 && text[0] == '\uFEFF') text = text.Substring(1);
            string[] lines = Regex.Split(text, "\\r\\n|\\r|\\n");
            for (int i = 0; i < lines.Length; i++) {
                int position = lines[i].IndexOf(query, caseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase);
                if (position < 0) continue;
                if (result.Matches.Count >= maxMatches) { result.Truncated = true; return result; }
                int start = Math.Max(0, position - 200);
                if (start > 0 && Char.IsLowSurrogate(lines[i][start])) start--;
                string part = lines[i].Substring(start, Math.Min(1000, lines[i].Length - start));
                if (part.Length > 0 && Char.IsHighSurrogate(part[part.Length - 1])) part = part.Substring(0, part.Length - 1);
                byte[] encoded = Utf8.GetBytes(part);
                if (outputBytes + encoded.Length > 64 * 1024) { result.Truncated = true; return result; }
                outputBytes += encoded.Length;
                result.Matches.Add(new Hit { Path = relative, Line = i + 1, TextBase64 = Convert.ToBase64String(encoded), TextTruncated = part.Length != lines[i].Length });
            }
        }
        return result;
    }
    public void Dispose() { foreach (SafeFileHandle handle in roots) handle.Dispose(); roots.Clear(); }
}
