import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Puzzle, FolderUp, FolderDown, Download, Trash2, RefreshCw, CheckCircle2, AlertTriangle, Copy, Pencil, Save, X, Info,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

// Chrome extension түгээх: админ folder-оор оруулна → хэрэглэгч «Folder болгож хадгалах» (Chrome-ийн
// File System Access) эсвэл ZIP-ээр татаж chrome://extensions → Developer mode → «Load unpacked».

type Ext = {
  id: number; name: string; version: string; description: string; manifest_version: number; note: string;
  folder_name: string; file_count: number; size_bytes: number; icon: string | null;
  uploaded_by: string; uploaded_at: string | null; download_count: number;
};
type Picked = {
  files: File[]; folder: string; name: string; version: string; description: string;
  mv: number | null; size: number; skipped: number;
};

const MAX_FILES = 3000;
const MAX_TOTAL = 80 * 1024 * 1024;
const JUNK = new Set([".git", ".svn", ".hg", "__macosx", ".ds_store", "thumbs.db", "desktop.ini"]);

const fmtSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
const pad = (n: number) => String(n).padStart(2, "0");
const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const relPath = (f: File) => (f as any).webkitRelativePath || f.name;
const isJunk = (path: string) => {
  const parts = path.split("/");
  return parts.some((p) => JUNK.has(p.toLowerCase())) || parts[parts.length - 1].startsWith("._");
};
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** «1.10.2» vs «1.9» — Chrome-ийн хувилбарын дугаар (цэгээр тусгаарласан тоо). */
const cmpVer = (a: string, b: string) => {
  const x = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0), y = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
};
const canSaveFolder = () => typeof window !== "undefined" && "showDirectoryPicker" in window;
const errDetail = async (e: any, fallback: string) => {
  try { const t = await e?.response?.data?.text?.(); return JSON.parse(t ?? "").detail ?? fallback; }
  catch { return typeof e?.response?.data?.detail === "string" ? e.response.data.detail : fallback; }
};

/** Сонгосон folder-оос manifest.json-ийг (хамгийн дээд байрлалынх) олж урьдчилан харуулна. */
async function inspectFolder(list: FileList): Promise<Picked> {
  const all = Array.from(list);
  const kept = all.filter((f) => !isJunk(relPath(f)));
  const depth = (f: File) => relPath(f).split("/").length;
  const manifest = kept.filter((f) => relPath(f).split("/").pop()?.toLowerCase() === "manifest.json").sort((a, b) => depth(a) - depth(b))[0];
  if (!manifest) throw new Error("manifest.json олдсонгүй — extension-ий үндсэн folder-ыг (manifest.json байгаа) сонгоно уу. Build хийдэг бол dist folder.");
  const prefix = relPath(manifest).slice(0, -"manifest.json".length);
  const files = kept.filter((f) => relPath(f).startsWith(prefix));
  let m: any;
  try { m = JSON.parse((await manifest.text()).replace(/^﻿/, "")); } catch { throw new Error("manifest.json-ийг уншиж чадсангүй (JSON алдаатай)."); }
  const msg = async (v: unknown) => {
    const s = String(v ?? "").trim();
    const k = s.match(/^__MSG_(\w+)__$/)?.[1];
    if (!k) return s;
    const f = files.find((x) => relPath(x) === `${prefix}_locales/${m.default_locale || "en"}/messages.json`);
    try {
      const msgs = JSON.parse((await f!.text()).replace(/^﻿/, ""));
      const hit = Object.entries(msgs).find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1] as any;
      return hit?.message || s;
    } catch { return s; }
  };
  const parts = prefix.split("/").filter(Boolean);
  return {
    files, folder: parts[parts.length - 1] || "extension", name: await msg(m.name), version: String(m.version ?? ""),
    description: await msg(m.description), mv: typeof m.manifest_version === "number" ? m.manifest_version : null,
    size: files.reduce((s, f) => s + f.size, 0), skipped: all.length - kept.length,
  };
}

export default function ChromeExtensions() {
  const { baseRole, role } = useAuthStore();
  const isAdmin = (baseRole ?? role) === "admin";
  const [items, setItems] = useState<Ext[]>([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickErr, setPickErr] = useState("");
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);              // `${id}:folder` | `${id}:zip` | `${id}:del`
  const [editNote, setEditNote] = useState<{ id: number; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const show = (ok: boolean, msg: string) => { setFlash({ ok, msg }); if (ok) setTimeout(() => setFlash((f) => (f?.msg === msg ? null : f)), 8000); };
  const load = () => {
    setLoading(true);
    api.get("/extensions/list").then((r) => setItems(Array.isArray(r.data) ? r.data : []))
      .catch(() => show(false, "Жагсаалт ачаалахад алдаа гарлаа."))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const onPick = async (list: FileList | null) => {
    setPicked(null); setPickErr("");
    if (!list?.length) return;
    try {
      const p = await inspectFolder(list);
      if (p.files.length > MAX_FILES) throw new Error(`Файл хэт олон (${p.files.length}) — build хийсэн (dist) folder-оо сонгоно уу.`);
      if (p.size > MAX_TOTAL) throw new Error(`Хэт том (${fmtSize(p.size)} > 80 МБ) — build хийсэн (dist) folder-оо сонгоно уу.`);
      setPicked(p);
    } catch (e: any) { setPickErr(e?.message ?? "Folder-ыг уншиж чадсангүй."); }
  };

  const upload = async () => {
    if (!picked) return;
    const fd = new FormData();
    for (const f of picked.files) { fd.append("files", f, f.name); fd.append("paths", relPath(f)); }
    if (note.trim()) fd.append("note", note.trim());
    setProgress(0);
    try {
      const r = await api.post("/extensions/upload", fd, {
        timeout: 600000,
        onUploadProgress: (e) => setProgress(e.total ? Math.round((e.loaded / e.total) * 100) : null),
      });
      const x: Ext = r.data.extension;
      const extra = [r.data.replaced ? `өмнөх ${r.data.previous_version} хувилбарыг солив` : "", ...(r.data.warnings ?? [])].filter(Boolean);
      show(true, `«${x.name}» ${x.version} оруулагдлаа${extra.length ? ` — ${extra.join(" ")}` : ""}`);
      setPicked(null); setNote("");
      if (inputRef.current) inputRef.current.value = "";
      load();
    } catch (e: any) {
      show(false, e?.response?.data?.detail ?? "Оруулахад алдаа гарлаа.");
    } finally { setProgress(null); }
  };

  /** Chrome: хадгалах газраа сонгоход «<folder>» folder үүсгээд файлуудыг шууд бичнэ (zip задлах шаардлагагүй). */
  const saveFolder = async (x: Ext) => {
    let parent: any;
    try {
      parent = await (window as any).showDirectoryPicker({ id: "chrome-extensions", mode: "readwrite", startIn: "documents" });
    } catch (e: any) { if (e?.name !== "AbortError") show(false, `Folder сонгож чадсангүй: ${e?.message ?? e}`); return; }
    setBusy(`${x.id}:folder`);
    try {
      const r = await api.get(`/extensions/${x.id}/files`, { timeout: 300000 });
      const folder: string = r.data.folder;
      const inPlace = parent.name === folder;                       // тэр folder-ыг өөрийг нь сонгосон бол дээр нь шинэчилнэ
      const dir = inPlace ? parent : await parent.getDirectoryHandle(folder, { create: true });
      for (const f of r.data.files as { path: string; data: string }[]) {
        const parts = f.path.split("/");
        let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
        await w.write(b64ToBytes(f.data));
        await w.close();
      }
      show(true, `«${x.name}» ${x.version} → «${inPlace ? folder : `${parent.name}/${folder}`}» folder-т хадгалагдлаа (${r.data.files.length} файл). `
        + "chrome://extensions → «Load unpacked» → энэ folder-ыг сонгоно. Өмнө нь суулгасан бол ↻ Reload дарахад хангалттай.");
      setItems((xs) => xs.map((e) => (e.id === x.id ? { ...e, download_count: e.download_count + 1 } : e)));
    } catch (e: any) {
      show(false, e?.response?.data?.detail ?? `Хадгалж чадсангүй: ${e?.message ?? e}`);
    } finally { setBusy(null); }
  };

  const downloadZip = async (x: Ext) => {
    setBusy(`${x.id}:zip`);
    try {
      const r = await api.get(`/extensions/${x.id}/download`, { responseType: "blob", timeout: 300000 });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url; a.download = `${x.folder_name}-${x.version}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setItems((xs) => xs.map((e) => (e.id === x.id ? { ...e, download_count: e.download_count + 1 } : e)));
      show(true, `ZIP татагдлаа — задлаад (Extract All) гарсан «${x.folder_name}-${x.version}» folder-ыг «Load unpacked»-аар сонгоно.`);
    } catch (e: any) {
      show(false, await errDetail(e, "Татахад алдаа гарлаа."));
    } finally { setBusy(null); }
  };

  const remove = async (x: Ext) => {
    if (!confirm(`«${x.name}» (v${x.version}) extension-ийг устгах уу? Хэрэглэгчдийн суулгасан extension хэвээр үлдэнэ, зөвхөн эндээс татах боломжгүй болно.`)) return;
    setBusy(`${x.id}:del`);
    try { await api.delete(`/extensions/${x.id}`); setItems((xs) => xs.filter((e) => e.id !== x.id)); show(true, `«${x.name}» устгагдлаа.`); }
    catch (e: any) { show(false, e?.response?.data?.detail ?? "Устгахад алдаа гарлаа."); }
    finally { setBusy(null); }
  };

  const saveNote = async () => {
    if (!editNote) return;
    try {
      const r = await api.patch(`/extensions/${editNote.id}`, { note: editNote.text });
      setItems((xs) => xs.map((e) => (e.id === editNote.id ? r.data : e)));
      setEditNote(null);
    } catch (e: any) { show(false, e?.response?.data?.detail ?? "Тайлбар хадгалахад алдаа гарлаа."); }
  };

  const copyUrl = async () => {
    try { await navigator.clipboard.writeText("chrome://extensions"); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { show(false, "Хуулж чадсангүй — chrome://extensions гэж гараар бичнэ үү."); }
  };

  const existing = picked ? items.find((e) => e.name.trim().toLowerCase() === picked.name.trim().toLowerCase()) : undefined;
  const mobile = typeof navigator !== "undefined" && /Android|iPhone|iPad/i.test(navigator.userAgent);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      <div>
        <div className="flex items-center gap-2 text-2xl font-semibold text-gray-900"><Puzzle size={22} className="text-[#0071E3]" /> Chrome extension</div>
        <div className="mt-1 text-sm text-gray-500">Дотоод extension-уудыг эндээс татаж компьютерийн Chrome-доо суулгана.</div>
      </div>

      {mobile && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-800">
          <Info size={16} className="mt-0.5 shrink-0" /> Chrome extension зөвхөн компьютерийн Chrome хөтөч дээр ажиллана — компьютерээсээ нээнэ үү.
        </div>
      )}
      {flash && (
        <div className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13px] ${flash.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
          {flash.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
          <span className="flex-1">{flash.msg}</span>
          <button onClick={() => setFlash(null)} className="text-current opacity-60 hover:opacity-100"><X size={15} /></button>
        </div>
      )}

      {/* ── Оруулах (админ) ── */}
      {isAdmin && (
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-5">
          <div className="text-sm font-semibold text-gray-900">Extension оруулах</div>
          <div className="mt-0.5 text-[12.5px] text-gray-500">
            manifest.json агуулсан folder-ыг бүхэлд нь сонгоно. Ижил нэртэй extension байвал шинэ хувилбараар солигдоно.
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-blue-200 bg-blue-50/60 px-4 py-2.5 text-[13px] font-semibold text-[#0071E3] hover:bg-blue-50">
              <FolderUp size={16} /> Folder сонгох
              <input ref={inputRef} type="file" multiple className="hidden"
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(e) => onPick(e.target.files)} />
            </label>
            {picked && <span className="text-[12.5px] text-gray-500">{picked.files.length} файл · {fmtSize(picked.size)}{picked.skipped ? ` · ${picked.skipped} илүүц файл (.git г.м.) алгасна` : ""}</span>}
          </div>
          {pickErr && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{pickErr}</div>}
          {picked && (
            <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50/70 p-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[15px] font-bold text-gray-900">{picked.name || "(нэргүй)"}</span>
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">v{picked.version || "?"}</span>
                <span className="text-[12px] text-gray-500">folder: {picked.folder}</span>
              </div>
              {picked.description && <div className="mt-1 text-[12.5px] text-gray-600">{picked.description}</div>}
              {existing && (
                <div className={`mt-1.5 text-[12.5px] font-medium ${cmpVer(picked.version, existing.version) <= 0 ? "text-amber-700" : "text-violet-700"}`}>
                  Солигдоно: одоогийн v{existing.version} → шинэ v{picked.version}
                  {cmpVer(picked.version, existing.version) < 0 && " — анхаар, бага хувилбар"}
                  {cmpVer(picked.version, existing.version) === 0 && " — хувилбарын дугаар ижил"}
                </div>
              )}
              {picked.mv !== 3 && (
                <div className="mt-1.5 flex items-center gap-1 text-[12.5px] text-amber-700">
                  <AlertTriangle size={13} /> Manifest V{picked.mv ?? "?"} — Chrome-ийн шинэ хувилбарууд зөвхөн Manifest V3-ыг ачаална.
                </div>
              )}
              {(!picked.name || !picked.version) && (
                <div className="mt-1.5 text-[12.5px] text-red-700">manifest.json-д name, version заавал байх ёстой.</div>
              )}
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000}
                placeholder="Тайлбар (заавал биш) — юунд хэрэглэх, хэн суулгах г.м."
                className="mt-2.5 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-blue-400" />
              <div className="mt-2 flex items-center gap-3">
                <button onClick={upload} disabled={progress !== null || !picked.name || !picked.version}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#0071E3] px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  {progress !== null ? <RefreshCw size={14} className="animate-spin" /> : <FolderUp size={14} />}
                  {progress !== null ? `Оруулж байна… ${progress}%` : existing ? "Шинэ хувилбар оруулах" : "Оруулах"}
                </button>
                <button onClick={() => { setPicked(null); setNote(""); if (inputRef.current) inputRef.current.value = ""; }}
                  disabled={progress !== null} className="text-[12.5px] text-gray-500 hover:text-gray-800">Болих</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Жагсаалт ── */}
      <div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400"><RefreshCw size={14} className="animate-spin" /> Ачаалж байна…</div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
            Одоогоор extension оруулаагүй байна.{isAdmin ? " Дээрээс folder-оо сонгож оруулна уу." : ""}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {items.map((x) => (
              <div key={x.id} className="flex flex-col rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-gray-50 ring-1 ring-gray-100">
                    {x.icon ? <img src={x.icon} alt="" className="h-10 w-10 object-contain" /> : <Puzzle size={22} className="text-gray-400" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[15px] font-bold text-gray-900">{x.name}</span>
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">v{x.version}</span>
                      {x.manifest_version !== 3 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">MV{x.manifest_version || "?"}</span>}
                    </div>
                    {x.description && <div className="mt-0.5 text-[12.5px] text-gray-600">{x.description}</div>}
                    <div className="mt-1 text-[11.5px] text-gray-400">
                      {x.file_count} файл · {fmtSize(x.size_bytes)} · {when(x.uploaded_at)} · {x.uploaded_by} · {x.download_count} удаа татсан
                    </div>
                  </div>
                  {isAdmin && (
                    <div className="flex shrink-0 gap-0.5">
                      <button onClick={() => setEditNote({ id: x.id, text: x.note })} className="rounded-lg p-1.5 text-gray-400 hover:bg-blue-50 hover:text-[#0071E3]" title="Тайлбар засах"><Pencil size={14} /></button>
                      <button onClick={() => remove(x)} disabled={busy === `${x.id}:del`} className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Устгах"><Trash2 size={14} /></button>
                    </div>
                  )}
                </div>
                {editNote?.id === x.id ? (
                  <div className="mt-2.5">
                    <textarea value={editNote.text} onChange={(e) => setEditNote({ id: x.id, text: e.target.value })} rows={2} maxLength={2000}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-blue-400" placeholder="Тайлбар…" />
                    <div className="mt-1 flex gap-2">
                      <button onClick={saveNote} className="inline-flex items-center gap-1 rounded-lg bg-[#0071E3] px-3 py-1.5 text-[12px] font-semibold text-white"><Save size={12} /> Хадгалах</button>
                      <button onClick={() => setEditNote(null)} className="text-[12px] text-gray-500">Болих</button>
                    </div>
                  </div>
                ) : x.note ? (
                  <div className="mt-2.5 whitespace-pre-wrap rounded-lg bg-gray-50 px-3 py-2 text-[12.5px] text-gray-700">{x.note}</div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {canSaveFolder() && (
                    <button onClick={() => saveFolder(x)} disabled={!!busy}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-3.5 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                      title="Хадгалах газраа сонгоход extension-ий folder шууд үүснэ (zip задлах шаардлагагүй)">
                      {busy === `${x.id}:folder` ? <RefreshCw size={13} className="animate-spin" /> : <FolderDown size={13} />} Folder болгож хадгалах
                    </button>
                  )}
                  <button onClick={() => downloadZip(x)} disabled={!!busy}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                    {busy === `${x.id}:zip` ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />} ZIP татах
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Суулгах заавар ── */}
      <div className="rounded-2xl border border-blue-100 bg-blue-50/50 p-4 sm:p-5">
        <div className="text-sm font-semibold text-gray-900">Chrome-д суулгах</div>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] text-gray-700">
          <li><b>Folder болгож хадгалах</b> дарж хадгалах газраа (жишээ нь Documents) сонгоно — extension-ий folder тэнд үүснэ.
            ZIP татсан бол файл дээр баруун товшоод <b>Extract All</b> (задлах) хийнэ.</li>
          <li>Chrome-ийн хаягийн мөрөнд <code className="rounded bg-white px-1.5 py-0.5 text-[12px] ring-1 ring-blue-100">chrome://extensions</code> гэж бичээд Enter
            <button onClick={copyUrl} className="ml-1.5 inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 text-[11.5px] font-semibold text-[#0071E3] ring-1 ring-blue-100 hover:bg-blue-50">
              {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}{copied ? "Хуулсан" : "Хуулах"}
            </button>
          </li>
          <li>Баруун дээд буланд <b>Developer mode</b> (Хөгжүүлэгчийн горим)-ыг асаана.</li>
          <li><b>Load unpacked</b> (Задлагдаагүйг ачаалах) дарж, хадгалсан folder-оо — дотор нь <b>manifest.json</b> байгаа folder-ыг — сонгоно.</li>
          <li>Шинэ хувилбар гарвал: дахин ижил газар хадгалаад chrome://extensions дээр тухайн extension-ий <b>↻ Reload</b> товчийг дарна.</li>
        </ol>
      </div>
    </motion.div>
  );
}
