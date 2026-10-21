// Aclas Agent — дэлгүүрийн PC дээр ажиллаж ERP (bto.puljika.site)-ээс даалгавар татаад Aclas жин рүү гүйцэтгэнэ.
//
// Яагаад агент: жин зөвхөн дотоод сүлжээнд UDP 5001 (Pecr) — сервер шууд хүрэхгүй. Агент сервер рүү
// outbound HTTPS-ээр холбогдоно (порт нээх шаардлагагүй), X-Agent-Token-оор нэвтэрнэ.
// AclasSDK.dll 32-бит (Delphi) тул ЗААВАЛ x86 процесс: build.bat (csc /platform:x86).
//
// Даалгавар (backend/app/services/aclas_sync.py):
//   ping    — GetDeviceInfo
//   backup  — жингээс PLU + шошго (№label_index: 0x20 формат, 0x21 дэвсгэр) татаж серверт
//   sync    — PLU татах → /current (сервер нөөцлөөд илгээх файл буцаана) → илгээх → буцааж татаж /finish
//   restore — нөөц PLU (+шошго) илгээх → буцааж татах
//   label   — format/map hex илгээх
//
// SDK-ийн мэдэгдсэн онцлог (extentions/aclas/AclasTool.cs-тэй ижил, бодит жин дээр туршсан):
//   • IP-г big-endian uint (192.168.1.143 → 0xC0A8018F); port 5001, protocol 0
//   • callback code 0x0001 явц, 0x0000 дууссан, бусад алдаа; 0x0000-ийн дараа WaitForTask ГАЦДАГ
//   • нэг жин рүү зэрэг хоёр даалгавар бүү — агент даалгаврыг дараалан нэг нэгээр гүйцэтгэнэ
//   • Finalize заримдаа гацдаг → thread+timeout, дараа нь Environment.Exit
//   • Нэг процесс дотор SDK-аар олон даалгавар дараалан хийхэд процесс чимээгүй унадаг
//     (2026-10-21: PLU → 0x20 → 0x21 татахад) → SDK-ийн үйлдэл бүрийг ТУСДАА дэд процесст
//     (`AclasAgent.exe task …` / `info …`) хийнэ — AclasTool-той адил, унасан ч агент амьд үлдэнэ.
//
// Тохиргоо: AclasAgent.json (энэ exe-ийн хажууд, git-д оруулахгүй):
//   { "server": "https://127.0.0.1:8000", "token": "acl_...", "insecure": true, "poll_seconds": 15 }

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class AclasAgent
{
    const string SdkDir = @"C:\Program Files (x86)\Aclas LINK66\SDK";
    const uint Port = 5001, Protocol = 0;
    const uint ToScale = 0x00, FromScale = 0x01, ProcClear = 0x03;   // 3 = БҮХ PLU-г цэвэрлэнэ (файл үл харгалзана)
    const uint DtPlu = 0x0000, DtLabelFormat = 0x0020, DtLabelMap = 0x0021;
    const int TaskTimeoutMs = 120000;

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void ProgressEvent(uint errorCode, uint index, uint total, IntPtr userData);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetDllDirectory(string path);
    [DllImport("AclasSDK.dll", CallingConvention = CallingConvention.StdCall)] static extern bool AclasSDK_Initialize(IntPtr r);
    [DllImport("AclasSDK.dll", CallingConvention = CallingConvention.StdCall)] static extern void AclasSDK_Finalize();
    [DllImport("AclasSDK.dll", CallingConvention = CallingConvention.StdCall)] static extern bool AclasSDK_GetDeviceInfo(IntPtr info, uint addr, uint port, uint protocol);
    [DllImport("AclasSDK.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    static extern IntPtr AclasSDK_ExecTaskA(uint addr, uint port, uint protocol, uint procType, uint dataType, string fileName, ProgressEvent cb, IntPtr ud);
    [DllImport("AclasSDK.dll", CallingConvention = CallingConvention.StdCall)] static extern void AclasSDK_StopTask(IntPtr h);
    [DllImport("AclasSDK.dll", CallingConvention = CallingConvention.StdCall)] static extern uint AclasSDK_GetLastTaskError();

    static ProgressEvent _cb;                       // GC-д цуглуулагдахаас хамгаална
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
    static string _server, _token, _work;
    static int _poll = 15;
    static List<string> _log = new List<string>();

    static int Main(string[] args)
    {
        if (args.Length > 0 && (args[0] == "task" || args[0] == "info")) return Child(args);
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        _work = Path.Combine(dir, "work");
        Directory.CreateDirectory(_work);
        var cfgPath = Path.Combine(dir, "AclasAgent.json");
        if (!File.Exists(cfgPath)) { Console.Error.WriteLine("AclasAgent.json алга (server, token)"); return 2; }
        var cfg = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(cfgPath, Encoding.UTF8));
        _server = ((string)cfg["server"]).TrimEnd('/');
        _token = (string)cfg["token"];
        if (cfg.ContainsKey("poll_seconds")) _poll = Convert.ToInt32(cfg["poll_seconds"]);
        bool insecure = cfg.ContainsKey("insecure") && (bool)cfg["insecure"];
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        if (insecure) ServicePointManager.ServerCertificateValidationCallback = (a, b, c, d) => true;   // localhost self-signed

        Log("Агент эхэллээ → " + _server + (args.Length > 0 && args[0] == "--once" ? " (нэг удаа)" : ""));
        bool once = args.Length > 0 && args[0] == "--once";
        int errors = 0;
        while (true)
        {
            try
            {
                var r = Call("GET", "/aclas/agent/poll", null);
                if (r.ContainsKey("poll") && r["poll"] != null) _poll = Math.Max(5, Convert.ToInt32(r["poll"]));
                var job = r.ContainsKey("job") ? r["job"] as Dictionary<string, object> : null;
                errors = 0;
                if (job != null) { RunJob(job); continue; }
                if (once) break;
            }
            catch (Exception e)
            {
                Log("Сервер: " + e.Message);
                if (++errors > 40) break;              // run_agent.bat дахин асаана
            }
            Thread.Sleep(_poll * 1000);
        }
        Environment.Exit(0);
        return 0;
    }

    // ── Дэд процесс: SDK-ийн НЭГ үйлдэл ─────────────────────────────────────
    //   task <ip> <procType> <dataType> <file>  → "RESULT 0x...." мөр, exit 0 амжилттай
    //   info <ip>                               → "INFO <загвар>", exit 0 / 3
    static int Child(string[] a)
    {
        int rc = 1;
        SetDllDirectory(SdkDir);
        Directory.SetCurrentDirectory(SdkDir);          // AclasSDK.ini-г эндээс уншина
        if (!AclasSDK_Initialize(IntPtr.Zero)) { Console.WriteLine("RESULT 0xFFFC"); Console.Out.Flush(); Environment.Exit(2); }
        try
        {
            uint addr = Addr(a[1]);
            if (a[0] == "info")
            {
                IntPtr info = Marshal.AllocHGlobal(4096);
                for (int i = 0; i < 4096; i++) Marshal.WriteByte(info, i, 0);
                bool ok = AclasSDK_GetDeviceInfo(info, addr, Port, Protocol);
                byte[] b = new byte[64]; Marshal.Copy(info, b, 0, 64);
                Console.WriteLine("INFO " + Encoding.ASCII.GetString(b, 12, 16).Replace("\0", ""));
                rc = ok ? 0 : 3;
            }
            else
            {
                var done = new ManualResetEvent(false);
                uint code = 0xFFFF;
                _cb = (c, index, total, ud) => { code = c; if (c != 0x0001) done.Set(); };
                IntPtr h = AclasSDK_ExecTaskA(addr, Port, Protocol, Convert.ToUInt32(a[2]), Convert.ToUInt32(a[3]), a[4], _cb, IntPtr.Zero);
                if (h == IntPtr.Zero) { Console.WriteLine(string.Format("RESULT 0x{0:X4}", AclasSDK_GetLastTaskError())); rc = 10; }
                else if (!done.WaitOne(TaskTimeoutMs)) { AclasSDK_StopTask(h); Console.WriteLine("RESULT 0xFFFE"); rc = 11; }
                else { Console.WriteLine(string.Format("RESULT 0x{0:X4}", code)); rc = code == 0 ? 0 : 12; if (code != 0) AclasSDK_StopTask(h); }
            }
        }
        catch (Exception e) { Console.WriteLine("RESULT 0xFFFB " + e.Message); rc = 13; }
        Console.Out.Flush();
        var t = new Thread(() => AclasSDK_Finalize()) { IsBackground = true };
        t.Start(); t.Join(3000);
        Environment.Exit(rc);                            // SDK-ийн foreground thread-үүд процессыг барьдаг
        return rc;
    }

    // Өөрийгөө дэд процессоор ажиллуулна → (exit code, stdout)
    static int RunChild(string args, out string output)
    {
        var psi = new System.Diagnostics.ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, args)
        { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
        using (var p = System.Diagnostics.Process.Start(psi))
        {
            var sb = new StringBuilder();
            p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
            p.BeginOutputReadLine();
            if (!p.WaitForExit(TaskTimeoutMs + 30000)) { try { p.Kill(); } catch { } output = "RESULT 0xFFFE"; return 11; }
            p.WaitForExit();
            lock (sb) output = sb.ToString();
            return p.ExitCode;
        }
    }

    static uint ResultCode(string output, int rc)
    {
        int i = output.IndexOf("RESULT 0x");
        if (i >= 0) try { return Convert.ToUInt32(output.Substring(i + 9, 4), 16); } catch { }
        return rc == 0 ? 0u : 0xFFFA;                    // дэд процесс RESULT-гүй унасан
    }

    static void Log(string s)
    {
        string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + s;
        Console.WriteLine(line);
        lock (_log) { _log.Add(line); if (_log.Count > 200) _log.RemoveAt(0); }
        try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent.log"), line + "\r\n", Encoding.UTF8); } catch { }
    }

    static Dictionary<string, object> Call(string method, string path, object body)
    {
        var req = (HttpWebRequest)WebRequest.Create(_server + path);
        req.Method = method;
        req.Timeout = 120000;
        req.Headers["X-Agent-Token"] = _token;
        req.Accept = "application/json";
        if (body != null)
        {
            byte[] b = Encoding.UTF8.GetBytes(Json.Serialize(body));
            req.ContentType = "application/json";
            req.ContentLength = b.Length;
            using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
        }
        try
        {
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return Json.Deserialize<Dictionary<string, object>>(rd.ReadToEnd()) ?? new Dictionary<string, object>();
        }
        catch (WebException we)
        {
            string txt = "";
            if (we.Response != null) using (var rd = new StreamReader(we.Response.GetResponseStream())) txt = rd.ReadToEnd();
            throw new Exception(we.Message + " " + txt);
        }
    }

    static uint Addr(string ip)
    {
        byte[] o = IPAddress.Parse(ip).GetAddressBytes();
        return (uint)(o[0] << 24 | o[1] << 16 | o[2] << 8 | o[3]);
    }

    // Нэг SDK даалгавар (callback-аар хүлээнэ, timeout + 2 retry). Амжилттай бол 0, үгүй бол алдааны код.
    static uint Exec(string ip, uint proc, uint dt, string file)
    {
        uint last = 0xFFFF;
        for (int attempt = 1; attempt <= 3; attempt++)
        {
            string output;
            int rc = RunChild(string.Format("task {0} {1} {2} \"{3}\"", ip, proc, dt, file), out output);
            last = ResultCode(output, rc);
            if (rc == 0 && last == 0) return 0;
            Log(string.Format("  оролдлого {0}: 0x{1:X4}{2}", attempt, last, last == 0xFFFE ? " (timeout)" : last == 0xFFFA ? " (процесс унасан)" : ""));
            if (last == 0x0105) break;                   // энэ жин дэмжихгүй — давтах утгагүй
            Thread.Sleep(3000 * attempt);
        }
        return last;
    }

    static byte[] Download(string ip, uint procBase, uint dt, string name)
    {
        string f = Path.Combine(_work, name);
        if (File.Exists(f)) File.Delete(f);
        uint c = Exec(ip, FromScale + procBase, dt, f);
        if (c != 0) throw new ScaleException(string.Format("Жингээс татаж чадсангүй (dataType 0x{0:X4})", dt), c);
        return File.ReadAllBytes(f);
    }

    static void Upload(string ip, uint procBase, uint dt, byte[] data, string name)
    {
        string f = Path.Combine(_work, name);
        File.WriteAllBytes(f, data);                     // ANSI байт хэвээр (Name1 cp1251)
        uint c = Exec(ip, ToScale + procBase, dt, f);
        if (c != 0) throw new ScaleException(string.Format("Жин рүү илгээж чадсангүй (dataType 0x{0:X4})", dt), c);
    }

    class ScaleException : Exception
    {
        public uint Code;
        public ScaleException(string m, uint c) : base(m) { Code = c; }
    }

    static string B64(byte[] b) { return Convert.ToBase64String(b ?? new byte[0]); }
    static byte[] Un64(object s) { return s == null ? new byte[0] : Convert.FromBase64String((string)s); }

    static void RunJob(Dictionary<string, object> job)
    {
        int id = Convert.ToInt32(job["id"]);
        string kind = (string)job["kind"];
        var scale = (Dictionary<string, object>)job["scale"];
        var payload = job.ContainsKey("payload") ? job["payload"] as Dictionary<string, object> : null;
        string ip = (string)scale["ip"];
        uint lbl = (uint)Convert.ToInt32(scale["label_index"]) * 256;
        lock (_log) _log.Clear();
        Log(string.Format("Даалгавар #{0} {1} → {2} ({3})", id, kind, scale["name"], ip));
        var res = new Dictionary<string, object> { { "ok", true } };
        try
        {
            string iout;
            if (RunChild("info " + ip, out iout) != 0)
                throw new ScaleException("Жин холбогдоогүй (GetDeviceInfo) — асаалттай, сүлжээнд байгаа эсэхийг шалгана уу", 0xFFFD);
            int ii = iout.IndexOf("INFO ");
            res["info"] = ii >= 0 ? iout.Substring(ii + 5).Trim() : "";

            if (kind == "backup")
            {
                res["plu_b64"] = B64(Download(ip, 0, DtPlu, "backup_plu.txt"));
                try
                {
                    res["format_b64"] = B64(Download(ip, lbl, DtLabelFormat, "backup_format.hex"));
                    res["map_b64"] = B64(Download(ip, lbl, DtLabelMap, "backup_map.hex"));
                }
                catch (ScaleException e) { Log("  шошго нөөцлөгдсөнгүй: " + e.Message); }
            }
            else if (kind == "sync")
            {
                byte[] cur = Download(ip, 0, DtPlu, "sync_current.txt");
                var r = Call("POST", "/aclas/agent/jobs/" + id + "/current", new Dictionary<string, object> { { "plu_b64", B64(cur) } });
                if (r.ContainsKey("skip")) { Log("  өөрчлөлтгүй — илгээсэнгүй"); return; }
                if (r.ContainsKey("abort")) { Log("  сервер цуцлав: " + r["abort"]); return; }
                bool replace = r.ContainsKey("replace") && r["replace"] is bool && (bool)r["replace"];
                if (replace)
                {
                    // Upload нь upsert тул хуучныг устгахын тулд эхлээд БҮХ PLU-г цэвэрлэнэ (procType 3,
                    // файлын агуулгыг үл харгалздаг). Илгээх амжилтгүй бол өмнөх жагсаалтыг буцаана —
                    // жин хоосон үлдэхгүй.
                    Log("  хуучин бүртгэлийг цэвэрлэж байна");
                    uint c = Exec(ip, ProcClear, DtPlu, Path.Combine(_work, "sync_current.txt"));
                    if (c != 0) throw new ScaleException("PLU цэвэрлэж чадсангүй (юу ч өөрчлөгдөөгүй)", c);
                    try { Upload(ip, 0, DtPlu, Un64(r["upload_b64"]), "sync_upload.txt"); }
                    catch (ScaleException e)
                    {
                        Log("  илгээх амжилтгүй — өмнөх жагсаалтыг буцааж байна");
                        try { Upload(ip, 0, DtPlu, cur, "sync_rollback.txt"); Log("  өмнөх жагсаалт сэргэв"); }
                        catch (ScaleException e2) { Log("  !!! СЭРГЭЭЖ ЧАДСАНГҮЙ — жин хоосон байж магадгүй: " + e2.Message); }
                        throw new ScaleException(e.Message + " (өмнөх жагсаалтыг сэргээсэн)", e.Code);
                    }
                }
                else Upload(ip, 0, DtPlu, Un64(r["upload_b64"]), "sync_upload.txt");
                Log("  илгээлээ, буцааж шалгаж байна");
                res["verify_b64"] = B64(Download(ip, 0, DtPlu, "sync_verify.txt"));
            }
            else if (kind == "restore")
            {
                Upload(ip, 0, DtPlu, Un64(payload["plu_b64"]), "restore_plu.txt");
                if (payload.ContainsKey("format_b64"))
                {
                    uint li = (uint)Convert.ToInt32(payload["label_index"]) * 256;
                    Upload(ip, li, DtLabelFormat, Un64(payload["format_b64"]), "restore_format.hex");
                    Upload(ip, li, DtLabelMap, Un64(payload["map_b64"]), "restore_map.hex");
                }
                res["verify_b64"] = B64(Download(ip, 0, DtPlu, "restore_verify.txt"));
            }
            else if (kind == "label")
            {
                uint li = (uint)Convert.ToInt32(payload["label_index"]) * 256;
                Upload(ip, li, DtLabelFormat, Un64(payload["format_b64"]), "label_format.hex");
                Upload(ip, li, DtLabelMap, Un64(payload["map_b64"]), "label_map.hex");
            }
            Log("  амжилттай");
        }
        catch (ScaleException e)
        {
            Log("  " + e.Message + string.Format(" (0x{0:X4})", e.Code));
            res["ok"] = false; res["error"] = e.Message; res["code"] = string.Format("0x{0:X4}", e.Code);
        }
        catch (Exception e)
        {
            Log("  алдаа: " + e.Message);
            res["ok"] = false; res["error"] = e.Message;
        }
        lock (_log) res["log"] = _log.ToArray();
        try { Call("POST", "/aclas/agent/jobs/" + id + "/finish", res); }
        catch (Exception e) { Log("  үр дүн илгээж чадсангүй: " + e.Message); }
    }
}
