/**
 * Төхөөрөмжийн тогтмол ID — заалны тооллогод "аль утаснаас" уншуулсныг ялгахад.
 *
 * localStorage нь primary (sync). logout() нь localStorage.clear() дууддаг тул
 * Capacitor Preferences-т нөөцлөнө — утас гарч/орсон ч ID хэвээр (эс бөгөөс
 * нэг утас 2 өөр төхөөрөмж мэт харагдана).
 */
const KEY = "hc_device_id";
const LABEL_KEY = "hc_device_label";

function gen(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  } catch { /* fallback */ }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

export function getDeviceIdSync(): string {
  try {
    let v = localStorage.getItem(KEY);
    if (!v) { v = gen(); localStorage.setItem(KEY, v); }
    return v;
  } catch {
    return "nolocal";
  }
}

/** Preferences-ээс сэргээж (байвал) localStorage-той тааруулна. Апп нээхэд нэг удаа дуудна. */
export async function ensureDeviceId(): Promise<string> {
  let local: string | null = null;
  try { local = localStorage.getItem(KEY); } catch { /* ignore */ }
  try {
    const mod: any = await import("@capacitor/preferences");
    const { value } = await mod.Preferences.get({ key: KEY });
    if (value) {
      if (value !== local) { try { localStorage.setItem(KEY, value); } catch { /* ignore */ } }
      return value;
    }
    const id = local || getDeviceIdSync();
    await mod.Preferences.set({ key: KEY, value: id });
    return id;
  } catch {
    return local || getDeviceIdSync();
  }
}

export function getDeviceLabel(): string {
  try { return localStorage.getItem(LABEL_KEY) || ""; } catch { return ""; }
}

export async function setDeviceLabel(label: string): Promise<void> {
  try { localStorage.setItem(LABEL_KEY, label); } catch { /* ignore */ }
  try {
    const mod: any = await import("@capacitor/preferences");
    await mod.Preferences.set({ key: LABEL_KEY, value: label });
  } catch { /* ignore */ }
}

export async function restoreDeviceLabel(): Promise<string> {
  const local = getDeviceLabel();
  if (local) return local;
  try {
    const mod: any = await import("@capacitor/preferences");
    const { value } = await mod.Preferences.get({ key: LABEL_KEY });
    if (value) { try { localStorage.setItem(LABEL_KEY, value); } catch { /* ignore */ } return value; }
  } catch { /* ignore */ }
  return "";
}
