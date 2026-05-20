/**
 * Бичиг баримт — Зөвхөн админ ашиглана.
 * Бүлэг үүсгэх/засах/устгах + файл оруулах/татах/устгах.
 * Файлын icon дарахад хэн хэзээ оруулсан мэдээлэл харагдана.
 * Устгасан мэдээлэл Үйлдлийн бүртгэлд автомат бичигдэнэ.
 */
import { useEffect, useState, useMemo, useRef } from "react";
import {
  FileText, Plus, Pencil, Trash2, X, Check, AlertCircle, CheckCircle,
  Folder, Upload, Download, Info, Loader2, Search, FileArchive, FileImage,
  FileSpreadsheet, FileCode, File as FileIcon, FileAudio, FileVideo,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

interface Group {
  id: number;
  name: string;
  sort_order: number;
  file_count: number;
  created_at: string;
  created_by_username: string;
}

interface DocFile {
  id: number;
  group_id: number;
  display_name: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  uploaded_at: string;
  uploaded_by_username: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fileTypeIcon(filename: string, mime: string): React.ElementType {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/") || ["png","jpg","jpeg","gif","webp","svg","bmp","heic"].includes(ext)) return FileImage;
  if (m.startsWith("video/") || ["mp4","mov","avi","mkv","webm"].includes(ext)) return FileVideo;
  if (m.startsWith("audio/") || ["mp3","wav","ogg","flac","m4a"].includes(ext)) return FileAudio;
  if (["xls","xlsx","csv","ods"].includes(ext)) return FileSpreadsheet;
  if (["zip","rar","7z","tar","gz"].includes(ext)) return FileArchive;
  if (["js","ts","tsx","jsx","py","go","rs","java","c","cpp","html","css","json","xml","yml","yaml","sh"].includes(ext)) return FileCode;
  if (["pdf","doc","docx","txt","rtf"].includes(ext)) return FileText;
  return FileIcon;
}

function fmtSize(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Toast({ toast }: { toast: { msg: string; ok: boolean } | null }) {
  if (!toast) return null;
  return (
    <div className={`fixed top-4 right-4 z-[120] flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
      toast.ok ? "bg-emerald-500 text-white" : "bg-red-500 text-white"
    }`}>
      {toast.ok ? <CheckCircle size={15}/> : <AlertCircle size={15}/>}
      {toast.msg}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Documents() {
  const [groups, setGroups]         = useState<Group[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [files, setFiles]           = useState<DocFile[]>([]);
  const [loadingG, setLoadingG]     = useState(false);
  const [loadingF, setLoadingF]     = useState(false);
  const [search, setSearch]         = useState("");
  const [toast, setToast]           = useState<{ msg: string; ok: boolean } | null>(null);

  // Group CRUD state
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupForm, setGroupForm] = useState<{ id: number | null; name: string }>({ id: null, name: "" });
  const [savingGroup, setSavingGroup] = useState(false);
  const [confirmDelGroup, setConfirmDelGroup] = useState<Group | null>(null);

  // File upload state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading]   = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // File info popover + delete confirm
  const [infoFor, setInfoFor]       = useState<DocFile | null>(null);
  const [confirmDelFile, setConfirmDelFile] = useState<DocFile | null>(null);

  function notify(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 2500);
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async function loadGroups() {
    setLoadingG(true);
    try {
      const r = await api.get("/documents/groups");
      setGroups(r.data);
      if (selectedId == null && r.data.length > 0) {
        setSelectedId(r.data[0].id);
      }
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Бүлгүүдийг ачаалахад алдаа гарлаа", false);
    } finally {
      setLoadingG(false);
    }
  }

  async function loadFiles(gid: number) {
    setLoadingF(true);
    try {
      const r = await api.get(`/documents/groups/${gid}/files`);
      setFiles(r.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Файлуудыг ачаалахад алдаа гарлаа", false);
      setFiles([]);
    } finally {
      setLoadingF(false);
    }
  }

  useEffect(() => { loadGroups(); }, []);
  useEffect(() => {
    if (selectedId != null) loadFiles(selectedId);
    else setFiles([]);
  }, [selectedId]);

  // ── Group CRUD ─────────────────────────────────────────────────────────────

  function openCreateGroup() {
    setGroupForm({ id: null, name: "" });
    setGroupModalOpen(true);
  }
  function openEditGroup(g: Group) {
    setGroupForm({ id: g.id, name: g.name });
    setGroupModalOpen(true);
  }

  async function saveGroup() {
    const name = groupForm.name.trim();
    if (!name) { notify("Бүлгийн нэр оруулна уу", false); return; }
    setSavingGroup(true);
    try {
      if (groupForm.id == null) {
        const r = await api.post("/documents/groups", { name });
        setGroups(prev => [...prev, r.data].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id));
        setSelectedId(r.data.id);
        notify("Бүлэг үүсгэлээ ✓");
      } else {
        const r = await api.patch(`/documents/groups/${groupForm.id}`, { name });
        setGroups(prev => prev.map(g => g.id === groupForm.id ? r.data : g));
        notify("Засагдлаа ✓");
      }
      setGroupModalOpen(false);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSavingGroup(false);
    }
  }

  async function doDeleteGroup() {
    if (!confirmDelGroup) return;
    try {
      await api.delete(`/documents/groups/${confirmDelGroup.id}`);
      const newGroups = groups.filter(g => g.id !== confirmDelGroup.id);
      setGroups(newGroups);
      if (selectedId === confirmDelGroup.id) {
        setSelectedId(newGroups[0]?.id ?? null);
      }
      setConfirmDelGroup(null);
      notify("Бүлэг устгагдлаа");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Устгахад алдаа", false);
    }
  }

  // ── File upload ────────────────────────────────────────────────────────────

  function openUpload() {
    setUploadName("");
    setUploadFile(null);
    setUploadOpen(true);
    setTimeout(() => fileInputRef.current?.click(), 50);
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadFile(f);
    if (!uploadName.trim()) {
      // Auto-fill display name from file name (extension хасах)
      const n = f.name.replace(/\.[^.]+$/, "");
      setUploadName(n);
    }
  }

  async function submitUpload() {
    if (selectedId == null) { notify("Бүлэг сонгоно уу", false); return; }
    if (!uploadFile) { notify("Файл сонгоно уу", false); return; }
    const name = uploadName.trim() || uploadFile.name;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("display_name", name);
      fd.append("upload", uploadFile);
      const r = await api.post(`/documents/groups/${selectedId}/files`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setFiles(prev => [r.data, ...prev]);
      setGroups(prev => prev.map(g => g.id === selectedId ? { ...g, file_count: g.file_count + 1 } : g));
      setUploadOpen(false);
      setUploadName("");
      setUploadFile(null);
      notify("Файл хадгалагдлаа ✓");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Хадгалахад алдаа", false);
    } finally {
      setUploading(false);
    }
  }

  // ── File download ──────────────────────────────────────────────────────────

  async function downloadFile(f: DocFile) {
    try {
      const r = await api.get(`/documents/files/${f.id}/download`, { responseType: "blob" });
      const url = window.URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.original_filename || f.display_name || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 500);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Татахад алдаа", false);
    }
  }

  // ── File delete ────────────────────────────────────────────────────────────

  async function doDeleteFile() {
    if (!confirmDelFile) return;
    try {
      await api.delete(`/documents/files/${confirmDelFile.id}`);
      setFiles(prev => prev.filter(f => f.id !== confirmDelFile.id));
      setGroups(prev => prev.map(g => g.id === confirmDelFile.group_id
        ? { ...g, file_count: Math.max(0, g.file_count - 1) }
        : g));
      setConfirmDelFile(null);
      notify("Файл устгагдлаа · Үйлдлийн бүртгэлд бичигдсэн");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Устгахад алдаа", false);
    }
  }

  // ── Computed ───────────────────────────────────────────────────────────────

  const selectedGroup = useMemo(
    () => groups.find(g => g.id === selectedId) ?? null,
    [groups, selectedId]
  );

  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter(f =>
      f.display_name.toLowerCase().includes(q) ||
      f.original_filename.toLowerCase().includes(q)
    );
  }, [files, search]);

  return (
    <div className="space-y-4">
      <Toast toast={toast}/>

      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-100 to-blue-100">
            <FileText size={20} className="text-indigo-600"/>
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Бичиг баримт</h1>
            <p className="text-xs text-gray-400">Журам, гэрээ, KPI гэх мэт бичиг баримтыг бүлэглэн хадгална</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* ── Groups panel (left) ────────────────────────────────── */}
        <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden flex flex-col">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <div className="flex items-center gap-2">
              <Folder size={14} className="text-gray-400"/>
              <h2 className="text-sm font-semibold text-gray-900">Бүлгүүд</h2>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500 tabular-nums">{groups.length}</span>
            </div>
            <button onClick={openCreateGroup}
              className="flex items-center gap-1 rounded-lg bg-[#0071E3] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 transition-colors">
              <Plus size={12}/> Шинэ
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {loadingG && (
              <div className="p-6 text-center text-xs text-gray-400">
                <Loader2 size={14} className="inline animate-spin mr-1.5"/> Ачааллаж...
              </div>
            )}
            {!loadingG && groups.length === 0 && (
              <div className="px-4 py-8 text-center">
                <Folder size={28} className="mx-auto text-gray-300 mb-2"/>
                <p className="text-xs text-gray-500">Бүлэг байхгүй.</p>
                <button onClick={openCreateGroup}
                  className="mt-3 text-xs text-[#0071E3] hover:underline">+ Шинэ бүлэг үүсгэх</button>
              </div>
            )}
            {!loadingG && groups.map(g => {
              const active = selectedId === g.id;
              return (
                <div key={g.id}
                  className={`group flex items-center gap-2 border-b border-gray-50 px-3 py-2.5 transition-colors cursor-pointer ${
                    active ? "bg-blue-50/70 border-l-4 border-l-[#0071E3]" : "hover:bg-gray-50 border-l-4 border-l-transparent"
                  }`}
                  onClick={() => setSelectedId(g.id)}>
                  <Folder size={14} className={active ? "text-[#0071E3]" : "text-gray-400"}/>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${active ? "text-blue-900" : "text-gray-800"}`}>{g.name}</p>
                    <p className="text-[10px] text-gray-400">{g.file_count} файл</p>
                  </div>
                  <div className={`flex shrink-0 gap-0.5 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
                    <button onClick={e => { e.stopPropagation(); openEditGroup(g); }}
                      title="Засах"
                      className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-blue-100 hover:text-blue-600">
                      <Pencil size={11}/>
                    </button>
                    <button onClick={e => { e.stopPropagation(); setConfirmDelGroup(g); }}
                      title={g.file_count > 0 ? "Дотор файл байна" : "Устгах"}
                      disabled={g.file_count > 0}
                      className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-red-100 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                      <Trash2 size={11}/>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Files panel (right) ────────────────────────────────── */}
        <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden flex flex-col">
          {!selectedGroup ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center">
              <Folder size={32} className="text-gray-300"/>
              <p className="text-sm text-gray-500">Зүүн талаас бүлэг сонгоно уу</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Folder size={15} className="text-indigo-500 shrink-0"/>
                  <h2 className="text-sm font-semibold text-gray-900 truncate">{selectedGroup.name}</h2>
                  <span className="rounded-full bg-indigo-50 border border-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                    {files.length} файл
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"/>
                    <input value={search} onChange={e => setSearch(e.target.value)}
                      placeholder="Файл хайх..."
                      className="w-44 rounded-lg border border-gray-200 bg-gray-50 pl-7 pr-3 py-1.5 text-xs focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15"/>
                  </div>
                  <button onClick={openUpload}
                    className="flex items-center gap-1 rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 transition-colors">
                    <Upload size={12}/> Файл нэмэх
                  </button>
                </div>
              </div>

              <div className="max-h-[65vh] overflow-y-auto">
                {loadingF && (
                  <div className="p-12 text-center text-sm text-gray-400">
                    <Loader2 size={14} className="inline animate-spin mr-1.5"/> Ачааллаж...
                  </div>
                )}
                {!loadingF && filteredFiles.length === 0 && (
                  <div className="px-4 py-12 text-center">
                    <FileText size={32} className="mx-auto text-gray-300 mb-2"/>
                    <p className="text-sm text-gray-500">
                      {search ? "Хайлтанд тохирох файл алга" : "Файл байхгүй"}
                    </p>
                    {!search && (
                      <button onClick={openUpload} className="mt-3 text-xs text-[#0071E3] hover:underline">+ Эхний файл оруулах</button>
                    )}
                  </div>
                )}
                {!loadingF && filteredFiles.map(f => {
                  const Icon = fileTypeIcon(f.original_filename, f.mime_type);
                  return (
                    <div key={f.id}
                      className="flex items-center gap-3 border-b border-gray-50 px-4 py-2.5 hover:bg-blue-50/30 transition-colors">
                      {/* File icon (click to download) */}
                      <button onClick={() => downloadFile(f)} title="Татах"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors">
                        <Icon size={16}/>
                      </button>
                      {/* Name + meta */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{f.display_name}</p>
                        <p className="text-[10px] text-gray-400 truncate">
                          {f.original_filename} · {fmtSize(f.file_size)}
                        </p>
                      </div>
                      {/* Info icon */}
                      <button onClick={() => setInfoFor(f)} title="Дэлгэрэнгүй"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors">
                        <Info size={13}/>
                      </button>
                      {/* Download */}
                      <button onClick={() => downloadFile(f)} title="Татах"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-blue-100 hover:text-blue-600 transition-colors">
                        <Download size={13}/>
                      </button>
                      {/* Delete */}
                      <button onClick={() => setConfirmDelFile(f)} title="Устгах"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-red-100 hover:text-red-600 transition-colors">
                        <Trash2 size={13}/>
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Group modal (create / edit) ─────────────────────────── */}
      {groupModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setGroupModalOpen(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Folder size={15} className="text-indigo-600"/>
                {groupForm.id == null ? "Шинэ бүлэг" : "Бүлэг засах"}
              </h2>
              <button onClick={() => setGroupModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X size={16}/>
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-700">Нэр</label>
                <input value={groupForm.name}
                  onChange={e => setGroupForm(f => ({ ...f, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") saveGroup(); }}
                  placeholder="Жишээ нь: Журам, Гэрээ, KPI..."
                  autoFocus
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15"/>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
              <button onClick={() => setGroupModalOpen(false)} className="rounded-xl px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">
                Болих
              </button>
              <button onClick={saveGroup} disabled={savingGroup || !groupForm.name.trim()}
                className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:bg-gray-200 disabled:text-gray-400">
                {savingGroup ? <Loader2 size={13} className="animate-spin"/> : <Check size={13}/>}
                {groupForm.id == null ? "Үүсгэх" : "Хадгалах"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Upload modal ───────────────────────────────────────── */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setUploadOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Upload size={15} className="text-[#0071E3]"/> Файл оруулах
              </h2>
              <button onClick={() => setUploadOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X size={16}/>
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <p className="text-xs text-gray-500">
                Бүлэг: <span className="font-semibold text-gray-700">{selectedGroup?.name}</span>
              </p>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-700">Файлын нэр</label>
                <input value={uploadName}
                  onChange={e => setUploadName(e.target.value)}
                  placeholder="Жишээ нь: 2026 оны цагдмал гэрээ..."
                  autoFocus
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15"/>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-700">Файл</label>
                <input ref={fileInputRef} type="file" onChange={onFileChosen} className="hidden"/>
                {!uploadFile ? (
                  <button onClick={() => fileInputRef.current?.click()}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-3 py-6 text-sm font-medium text-gray-500 hover:border-[#0071E3] hover:bg-blue-50/30 hover:text-[#0071E3] transition-all">
                    <Upload size={14}/> Дурын файл сонгох
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileIcon size={14} className="text-emerald-600 shrink-0"/>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-emerald-900 truncate">{uploadFile.name}</p>
                        <p className="text-[10px] text-emerald-700">{fmtSize(uploadFile.size)}</p>
                      </div>
                    </div>
                    <button onClick={() => { setUploadFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                      className="rounded p-1 text-emerald-600 hover:bg-emerald-100">
                      <X size={13}/>
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
              <button onClick={() => setUploadOpen(false)} className="rounded-xl px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">
                Болих
              </button>
              <button onClick={submitUpload} disabled={uploading || !uploadFile}
                className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:bg-gray-200 disabled:text-gray-400">
                {uploading ? <Loader2 size={13} className="animate-spin"/> : <Upload size={13}/>}
                {uploading ? "Хадгалж байна..." : "Оруулах"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── File info popover (modal) ─────────────────────────── */}
      {infoFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setInfoFor(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Info size={15} className="text-blue-600"/> Файлын мэдээлэл
              </h2>
              <button onClick={() => setInfoFor(null)} className="text-gray-400 hover:text-gray-600">
                <X size={16}/>
              </button>
            </div>
            <div className="space-y-2 px-5 py-4 text-sm">
              <InfoRow label="Нэр"           value={infoFor.display_name}/>
              <InfoRow label="Анхны файл"    value={infoFor.original_filename} mono/>
              <InfoRow label="Хэмжээ"        value={fmtSize(infoFor.file_size)} mono/>
              <InfoRow label="Файлын төрөл"  value={infoFor.mime_type || "—"} mono/>
              <div className="my-2 border-t border-gray-100"/>
              <InfoRow label="Хэн оруулсан"  value={infoFor.uploaded_by_username || "—"} bold/>
              <InfoRow label="Хэзээ оруулсан" value={fmtDateTime(infoFor.uploaded_at)} mono/>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
              <button onClick={() => downloadFile(infoFor)}
                className="flex items-center gap-1.5 rounded-xl bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100">
                <Download size={13}/> Татах
              </button>
              <button onClick={() => setInfoFor(null)} className="rounded-xl bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200">
                Хаах
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete group confirm ────────────────────────────── */}
      {confirmDelGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDelGroup(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100">
                <Trash2 size={18} className="text-red-600"/>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-900">Бүлэг устгах уу?</h3>
                <p className="text-xs text-gray-500 mt-0.5">"{confirmDelGroup.name}" — буцаах боломжгүй</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelGroup(null)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                Болих
              </button>
              <button onClick={doDeleteGroup} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600">
                Устгах
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete file confirm ─────────────────────────────── */}
      {confirmDelFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDelFile(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100">
                <Trash2 size={18} className="text-red-600"/>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-900">Файл устгах уу?</h3>
                <p className="text-xs text-gray-500 mt-0.5">"{confirmDelFile.display_name}"</p>
                <p className="text-[11px] text-amber-600 mt-1">⚠ Устгал нь Үйлдлийн бүртгэлд хадгалагдана</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelFile(null)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                Болих
              </button>
              <button onClick={doDeleteFile} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600">
                Устгах
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono, bold }: { label: string; value: string; mono?: boolean; bold?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-gray-500 shrink-0">{label}:</span>
      <span className={`text-sm text-gray-800 text-right break-all ${mono ? "font-mono text-xs" : ""} ${bold ? "font-semibold" : ""}`}>{value}</span>
    </div>
  );
}
