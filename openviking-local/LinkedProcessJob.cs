using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class LinkedProcessJob : IDisposable
{
    private const uint Suspended = 0x4;
    private const uint NewProcessGroup = 0x200;
    private const uint KillOnClose = 0x2000;
    private const uint UseStdHandles = 0x100;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);
    private readonly CtrlHandler handler;
    private IntPtr job;
    private readonly List<Child> background = new List<Child>();

    public LinkedProcessJob()
    {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Error("CreateJobObject");
        var limits = new ExtendedLimits();
        limits.Basic.Flags = KillOnClose;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        {
            var error = Error("SetInformationJobObject");
            CloseHandle(job);
            throw error;
        }
        handler = OnConsoleControl;
        SetConsoleCtrlHandler(handler, true);
    }

    public Child Start(string executable, string[] arguments, string directory, string memoryLog)
    {
        return StartCore(executable, arguments, directory, memoryLog, false);
    }

    public Child StartWeb(string executable, string[] arguments, string directory, bool showAuthenticatedUrl)
    {
        return StartCore(executable, arguments, directory, null, true, showAuthenticatedUrl);
    }

    private Child StartCore(string executable, string[] arguments, string directory, string serviceLog, bool capture, bool showAuthenticatedUrl = false)
    {
        var startup = new StartupInfo();
        startup.Size = Marshal.SizeOf(typeof(StartupInfo));
        var command = new StringBuilder(Quote(executable));
        foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
        var output = InvalidHandle;
        var input = InvalidHandle;
        var readOutput = InvalidHandle;
        bool service = !String.IsNullOrEmpty(serviceLog);
        try
        {
            if (service || capture)
            {
                var attributes = new SecurityAttributes();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                attributes.Inherit = true;
                if (capture)
                {
                    if (!CreatePipe(out readOutput, out output, ref attributes, 0)) throw Error("Create DSH output pipe");
                    if (!SetHandleInformation(readOutput, 1, 0)) throw Error("Keep the DSH output reader private");
                }
                else
                {
                    output = CreateFile(serviceLog, 4, 3, ref attributes, 4, 0x80, IntPtr.Zero); // Append data, share read/write.
                    if (output == InvalidHandle) throw Error("Open background service log");
                }
                input = CreateFile("NUL", 0x80000000, 3, ref attributes, 3, 0x80, IntPtr.Zero);
                if (input == InvalidHandle) throw Error("Open NUL");
                startup.Flags = UseStdHandles;
                startup.Input = input;
                startup.Output = output;
                startup.Error = output;
            }
            ProcessInfo process;
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, service || capture,
                Suspended | (service ? NewProcessGroup : 0), IntPtr.Zero, directory, ref startup, out process))
                throw Error("Start " + executable);

            // Register the process before it can spawn children, including Python's venv redirector.
            try
            {
                if (!AssignProcessToJobObject(job, process.Process)) throw Error("Assign process to DSH job");
                if (ResumeThread(process.Thread) == UInt32.MaxValue) throw Error("Resume process");
            }
            catch
            {
                TerminateProcess(process.Process, 1);
                CloseHandle(process.Process);
                throw;
            }
            finally { CloseHandle(process.Thread); }

            var child = new Child(process.Process, process.Id);
            if (service) lock (background) background.Add(child);
            if (capture)
            {
                child.ReadOutput(new SafeFileHandle(readOutput, true), showAuthenticatedUrl);
                readOutput = InvalidHandle;
            }
            return child;
        }
        finally
        {
            if (output != InvalidHandle) CloseHandle(output);
            if (input != InvalidHandle) CloseHandle(input);
            if (readOutput != InvalidHandle) CloseHandle(readOutput);
        }
    }

    public bool Owns(uint pid)
    {
        var process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return false;
        try { bool member; return IsProcessInJob(process, job, out member) && member; }
        finally { CloseHandle(process); }
    }

    public void Dispose()
    {
        ShutDown(6000);
        SetConsoleCtrlHandler(handler, false);
    }

    private bool OnConsoleControl(uint signal)
    {
        if (signal != 2 && signal != 5 && signal != 6) return false; // Close, logoff, shutdown.
        ShutDown(2500);
        return true;
    }

    private void ShutDown(uint waitMs)
    {
        var owned = Interlocked.Exchange(ref job, IntPtr.Zero);
        if (owned == IntPtr.Zero) return;
        try
        {
            Child[] services;
            lock (background) services = background.ToArray();
            var timer = Stopwatch.StartNew();
            var signaled = new List<Child>();
            foreach (var child in services)
                if (!child.Exited && GenerateConsoleCtrlEvent(1, child.Id)) signaled.Add(child);
            foreach (var child in signaled)
            {
                var left = (long)waitMs - timer.ElapsedMilliseconds;
                if (left <= 0) break;
                child.Wait((uint)left);
            }
        }
        finally { CloseHandle(owned); }
    }

    private static Win32Exception Error(string operation)
    {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, operation + ": " + new Win32Exception(code).Message);
    }

    private static string Quote(string argument)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char value in argument)
        {
            if (value == '\\') { slashes++; continue; }
            result.Append('\\', value == '"' ? slashes * 2 + 1 : slashes);
            result.Append(value);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    public sealed class Child : IDisposable
    {
        private IntPtr process;
        private volatile string webUrl;
        private Task outputReader;
        internal Child(IntPtr handle, uint id) { process = handle; Id = id; }
        public uint Id { get; private set; }
        public string WebUrl { get { return webUrl; } }
        public bool Exited { get { return Wait(0); } }
        public bool Wait(uint milliseconds) { return WaitForSingleObject(process, milliseconds) == 0; }
        public int ExitCode
        {
            get { uint code; if (!GetExitCodeProcess(process, out code)) throw Error("Get exit code"); return unchecked((int)code); }
        }
        internal void ReadOutput(SafeFileHandle handle, bool showAuthenticatedUrl)
        {
            outputReader = Task.Run(() =>
            {
                using (var stream = new FileStream(handle, FileAccess.Read))
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        Uri url;
                        if (line.StartsWith("dsh web: ", StringComparison.Ordinal) &&
                            Uri.TryCreate(line.Substring(9).Trim(), UriKind.Absolute, out url) &&
                            (url.Scheme == "http" || url.Scheme == "https"))
                        {
                            webUrl = url.AbsoluteUri;
                            if (!showAuthenticatedUrl) line = "dsh web: " + url.GetLeftPart(UriPartial.Path);
                        }
                        Console.WriteLine(line);
                    }
                }
            });
        }
        public void Dispose()
        {
            if (outputReader != null)
            {
                try { outputReader.Wait(2000); } catch (AggregateException) { }
            }
            var handle = Interlocked.Exchange(ref process, IntPtr.Zero);
            if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XCount, YCount, Fill;
        public uint Flags;
        public ushort ShowWindow, Reserved2Size;
        public IntPtr Reserved2, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint Id, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }

    private delegate bool CtrlHandler(uint signal);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
    [DllImport("kernel32", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string path, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32", SetLastError = true)] private static extern bool GenerateConsoleCtrlEvent(uint signal, uint group);
    [DllImport("kernel32", SetLastError = true)] private static extern bool SetConsoleCtrlHandler(CtrlHandler handler, bool add);
    [DllImport("kernel32", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
}
