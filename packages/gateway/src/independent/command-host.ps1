# 独立命令的 Windows 作业宿主。只加载内置 .NET，不加载用户 PowerShell 配置。
# 先将宿主自身放入作业，再启动命令；作业处理进程收尾，不提供文件或网络隔离。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class AicCommandHost {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    // 仅结束当前可信宿主；内核关闭作业句柄并收尾子孙进程。
    // PowerShell 的托管退出回调可能等待仍在执行的管线，不能把已完成命令拖成超时。
    public static void Exit(uint code) {
        if (!TerminateProcess(GetCurrentProcess(), code)) Environment.Exit((int)code);
    }
    // 不把作业句柄交给命令；保留到宿主退出，由内核关闭最后句柄并收尾作业。
    static IntPtr job;
    static readonly object outputLock = new object();

    static void Frame(string json) {
        lock (outputLock) { Console.Out.WriteLine(json); Console.Out.Flush(); }
    }

    static async Task CopyOutput(Stream stream, string kind) {
        var buffer = new byte[8192]; int count;
        while ((count = await stream.ReadAsync(buffer, 0, buffer.Length)) > 0) {
            Frame("{\"type\":\"" + kind + "\",\"data\":\"" + Convert.ToBase64String(buffer, 0, count) + "\"}");
        }
    }

    public static void Attach() {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE，不允许普通子进程脱离。
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
            !AssignProcessToJobObject(job, GetCurrentProcess())) {
            CloseHandle(job);
            throw new InvalidOperationException();
        }
    }

    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    public static void Run(string program, string[] args, string cwd) {
        // Gateway 保持输入管道打开。Gateway 崩溃或主动结束管道后，作业随宿主退出。
        Task.Run((Action)(() => {
            try { while (Console.In.ReadLine() != null) {} } catch {}
            Exit(125);
        }));
        var arguments = new StringBuilder();
        foreach (string arg in args) {
            if (arguments.Length > 0) arguments.Append(' ');
            arguments.Append(Quote(arg));
        }
        var process = new Process();
        process.StartInfo = new ProcessStartInfo {
            FileName = program, Arguments = arguments.ToString(), WorkingDirectory = cwd,
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        if (!process.Start()) throw new InvalidOperationException();
        Frame("{\"type\":\"started\"}");
        process.StandardInput.Close();
        var output = CopyOutput(process.StandardOutput.BaseStream, "stdout");
        var error = CopyOutput(process.StandardError.BaseStream, "stderr");
        process.WaitForExit();
        // 仍持有输出管道的后台进程也属于本次命令，交由 Gateway 的时限或取消收尾。
        Task.WaitAll(output, error);
        Frame("{\"type\":\"exit\",\"exitCode\":" + process.ExitCode + "}");
        // 子命令已退出，两路输出已读完，最终帧也已 Flush，才终止宿主自身。
        Exit(0);
    }
}
'@
    [AicCommandHost]::Attach()
    $line = [Console]::ReadLine()
    if ($null -eq $line) { [AicCommandHost]::Exit(125) }
    $request = ConvertFrom-Json -InputObject $line
    [AicCommandHost]::Run([string]$request.program, [string[]]$request.args, [string]$request.cwd)
} catch {
    [Console]::Out.WriteLine('{"type":"host_error"}')
    if ('AicCommandHost' -as [type]) { [AicCommandHost]::Exit(125) }
    [Environment]::Exit(125)
}
