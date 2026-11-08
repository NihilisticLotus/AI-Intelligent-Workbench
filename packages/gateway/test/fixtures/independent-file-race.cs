// 仅测试夹具：用实际宿主私有方法建立屏障，并以独立原生句柄尝试竞态。
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class AicFileRace {
    public static string Mode, Ready, Resume, Outside;
    public static List<string> Results = new List<string>();
    static readonly List<SafeFileHandle> opens = new List<SafeFileHandle>();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr security, uint d, uint f, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int kind, IntPtr data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern SafeFileHandle OpenFileById(SafeFileHandle hint, IntPtr id, uint access, uint share, IntPtr security, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateHardLinkW(string alias, string target, IntPtr security);
    [DllImport("ntdll.dll")] static extern uint NtSetInformationFile(SafeFileHandle h, IntPtr io, IntPtr data, uint length, int kind);
    static SafeFileHandle Open(string name, uint access) {
        var h = CreateFileW(name, access, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); throw new Exception("夹具句柄打开失败"); } opens.Add(h); return h;
    }
    static string Link(SafeFileHandle h, string destination, int kind) {
        byte[] name = Encoding.Unicode.GetBytes("\\??\\" + destination); int root = IntPtr.Size == 8 ? 8 : 4, offset = root + IntPtr.Size + 4;
        IntPtr data = Marshal.AllocHGlobal(offset + name.Length), io = Marshal.AllocHGlobal(IntPtr.Size * 2);
        try {
            for (int i = 0; i < offset; i++) Marshal.WriteByte(data, i, 0);
            if (kind == 72) Marshal.WriteInt32(data, 0, 3); // 扩展类同时尝试 replace / POSIX 标志。
            Marshal.WriteInt32(data, root + IntPtr.Size, name.Length); Marshal.Copy(name, 0, IntPtr.Add(data, offset), name.Length);
            return NtSetInformationFile(h, io, data, (uint)(offset + name.Length), kind).ToString("x8");
        } finally { Marshal.FreeHGlobal(data); Marshal.FreeHGlobal(io); }
    }
    public static void Before(SafeFileHandle stage, string name) {
        if (Mode == "prealias") {
            if (!CreateHardLinkW(Outside, name, IntPtr.Zero)) throw new Exception("夹具屏障前建链接失败");
        }
        if (Mode != "handles") return;
        // 阳性对照：相同低权限路径在未设 pending 的普通文件确实可以新增链接。
        string control = Outside + ".control"; File.WriteAllText(control, "对照");
        var h = Open(control, 0x100); Results.Add("control=" + Link(h, Outside + ".control-alias", 11));
        string controlEx = Outside + ".control-ex"; File.WriteAllText(controlEx, "扩展对照");
        Results.Add("controlEx=" + Link(h, controlEx, 72));
        var controlId = ById(h); if (controlId.IsInvalid) throw new Exception("夹具文件 ID 阳性打开失败:" + Marshal.GetLastWin32Error());
        Results.Add("controlId=" + Link(controlId, Outside + ".control-id", 11)); controlId.Dispose();
        Open(name, 0x100); Open(name, 0x80); Open(name, 0); // 与暂存创建并发，但都发生在 pending 屏障之前。
        var byId = ById(stage); if (byId.IsInvalid) { Results.Add("preid=denied:" + Marshal.GetLastWin32Error()); byId.Dispose(); } else { Results.Add("preid=opened"); opens.Add(byId); }
    }
    static SafeFileHandle ById(SafeFileHandle stage) {
        IntPtr id = Marshal.AllocHGlobal(24), info = Marshal.AllocHGlobal(24);
        var volume = CreateFileW("\\\\.\\" + Path.GetPathRoot(Outside).TrimEnd('\\'), 0, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
        try {
            if (volume.IsInvalid) throw new Exception("夹具体积句柄打开失败:" + Marshal.GetLastWin32Error());
            if (!GetFileInformationByHandleEx(stage, 18, info, 24)) throw new Exception("夹具身份读取失败");
            for (int i = 0; i < 24; i++) Marshal.WriteByte(id, i, 0);
            Marshal.WriteInt32(id, 24); Marshal.WriteInt32(id, 4, 2);
            for (int i = 0; i < 16; i++) Marshal.WriteByte(id, 8 + i, Marshal.ReadByte(info, 8 + i));
            return OpenFileById(volume, id, 0x100, 7, IntPtr.Zero, 0x00200000);
        } finally { volume.Dispose(); Marshal.FreeHGlobal(id); Marshal.FreeHGlobal(info); }
    }
    public static void Protected(SafeFileHandle stage, string name) {
        if (Mode != "handles" && Mode != "kill") return;
        if (Mode == "handles") {
            for (int i = 1; i < opens.Count; i++) {
                Results.Add("preopened=" + Link(opens[i], Outside + ".pre" + i, 11));
                File.WriteAllText(Outside + ".ex" + i, "外部原文");
                Results.Add("extended=" + Link(opens[i], Outside + ".ex" + i, 72));
            }
            var byId = ById(stage);
            if (byId.IsInvalid) { Results.Add("byid=denied:" + Marshal.GetLastWin32Error()); byId.Dispose(); }
            else { opens.Add(byId); Results.Add("byid=" + Link(byId, Outside + ".byid", 11)); }
        }
        Pause("protected", name);
    }
    public static void Pause(string phase, string name) {
        if (Mode != phase && !(Mode == "handles" && phase == "protected") && !(Mode == "kill" && phase == "partial")) return;
        if (Mode == "kill" && phase == "protected") return;
        if (File.Exists(Resume)) File.Delete(Resume);
        File.WriteAllText(Ready, phase + "\n" + name, new UTF8Encoding(false));
        DateTime deadline = DateTime.UtcNow.AddSeconds(40);
        while (!File.Exists(Resume)) { if (DateTime.UtcNow > deadline) throw new Exception("夹具等待超时"); System.Threading.Thread.Sleep(10); }
        File.Delete(Ready);
    }
    public static void Close() { foreach (var h in opens) h.Dispose(); opens.Clear(); }
}
