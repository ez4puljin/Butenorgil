/**
 * Server config storage. localStorage нь primary (sync, APK WebView-д ажиллана).
 * Capacitor Preferences нь хоёрдогч (apк-д reinstall хийсэн үед мэдээлэл хадгалахад хэрэгтэй).
 */

const KEY = "server_base_url";

export function getServerUrlSync(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export async function setServerUrl(url: string): Promise<void> {
  try { localStorage.setItem(KEY, url); } catch {}
  // Background: Preferences-т хуулна (reinstall survival)
  try {
    const mod: any = await import("@capacitor/preferences");
    await mod.Preferences.set({ key: KEY, value: url });
  } catch { /* fine */ }
}

export async function getServerUrl(): Promise<string | null> {
  const local = getServerUrlSync();
  if (local) return local;
  try {
    const mod: any = await import("@capacitor/preferences");
    const { value } = await mod.Preferences.get({ key: KEY });
    if (value) {
      try { localStorage.setItem(KEY, value); } catch {}
      return value;
    }
  } catch { /* fine */ }
  return null;
}

export async function clearServerUrl(): Promise<void> {
  try { localStorage.removeItem(KEY); } catch {}
  try {
    const mod: any = await import("@capacitor/preferences");
    await mod.Preferences.remove({ key: KEY });
  } catch {}
}

/**
 * Capacitor native app мөн үү?
 */
export function isNativeApp(): boolean {
  try {
    const cap: any = (window as any).Capacitor;
    return !!cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Preferences-аас localStorage-т async хуулна (эхлэх үед background-д).
 * Зүй ёсны URL байвал return хийнэ.
 */
export async function bootstrapServerUrlIntoLocalStorage(): Promise<string | null> {
  // localStorage-т аль хэдийн байвал тэрийг шууд буцаана
  const local = getServerUrlSync();
  if (local) return local;
  // Preferences-ээс унших (survive reinstall)
  try {
    const mod: any = await import("@capacitor/preferences");
    const { value } = await mod.Preferences.get({ key: KEY });
    if (value) {
      try { localStorage.setItem(KEY, value); } catch {}
      return value;
    }
  } catch { /* fine */ }
  return null;
}
