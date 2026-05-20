/**
 * Android физик "back" товчны behavior — Capacitor native app-д л ажиллана.
 *
 * Зорилго: Хэрэглэгч back товч дарахад апп шууд гарах биш, харин:
 *   1. Modal/drawer нээлттэй бол → түүнийг хаах (history.back-аар router-т
 *      handle хийгдэх — но эхлээд цонх нээлттэй эсэхийг шалгах)
 *   2. Browser history-д previous page байвал → window.history.back()
 *   3. Root page дээр байвал (history урт нь 1) → confirm dialog харуулах,
 *      зөвшөөрвөл App.exitApp() дуудаж аппыг хаана
 *
 * Web (browser/desktop)-д энэ нь огт ажиллахгүй — Capacitor байхгүй тул
 * шууд бүтнэгүй буцна.
 */
import { isNativeApp } from "./serverConfig";

let registered = false;
let lastBackPressAt = 0;

export async function registerBackButtonHandler(): Promise<void> {
  if (registered) return;
  if (!isNativeApp()) return;

  try {
    // Dynamic import — @capacitor/app зөвхөн native үед хэрэгтэй
    const mod: any = await import("@capacitor/app");
    const { App } = mod;
    if (!App || typeof App.addListener !== "function") return;

    App.addListener("backButton", ({ canGoBack }: { canGoBack: boolean }) => {
      // Эхлээд нээлттэй overlay (modal/drawer)-ыг хаах оролдлого. Бид UI level-д
      // тэдгээрийг тусдаа handle хийдэггүй тул router-history-аар л явна.
      try {
        const path = window.location.pathname;
        const histLen = window.history.length;

        // History dahь өмнөх page руу — react-router энэ event-ыг сонсож үлдсэн
        // navigation-ыг автомат гүйцэтгэнэ.
        if (canGoBack || histLen > 1) {
          window.history.back();
          return;
        }

        // Root page-д back дарагдсан → confirm dialog (2-double-tap pattern)
        // Хэрэв 2 секундын дотор 2 удаа дарвал гарна
        const now = Date.now();
        if (now - lastBackPressAt < 2000) {
          App.exitApp().catch(() => {});
          return;
        }
        lastBackPressAt = now;
        // Хэрэглэгчид зөвлөмж — toast-аар:
        try {
          showExitToast();
        } catch {
          // Fallback — alert хийхгүй (UX муу), зүгээр л дахин дарахыг хүлээнэ
        }
        // Path ашигладаггүй тул unused warning-аас зайлсхийх
        void path;
      } catch (e) {
        console.error("[backButton] error", e);
      }
    });
    registered = true;
  } catch (e) {
    console.error("[backButton] failed to register", e);
  }
}

// ── Toast helper (no React dependency — DOM түвшинд бичигдсэн) ──────────────

function showExitToast() {
  const id = "exit-toast";
  let el = document.getElementById(id);
  if (el) {
    el.remove();
  }
  el = document.createElement("div");
  el.id = id;
  el.textContent = "Гарахын тулд back товчийг дахин дарна уу";
  el.style.cssText = `
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    background: rgba(17,24,39,0.92); color: white; padding: 10px 16px;
    border-radius: 16px; font-size: 13px; font-weight: 500;
    box-shadow: 0 8px 24px rgba(0,0,0,0.2); z-index: 99999;
    pointer-events: none; opacity: 0; transition: opacity 0.18s ease;
  `;
  document.body.appendChild(el);
  // Animation in
  requestAnimationFrame(() => { if (el) el.style.opacity = "1"; });
  // Animation out
  setTimeout(() => {
    if (el) {
      el.style.opacity = "0";
      setTimeout(() => el?.remove(), 200);
    }
  }, 1800);
}
