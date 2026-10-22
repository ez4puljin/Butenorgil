/**
 * html5-qrcode-оор камер асаах — BarcodeDetector-гүй хөтчүүдэд (iPhone Safari/Chrome, Firefox).
 *
 * iPhone-д өмнө нь камер гарахгүй байсан шалтгаанууд (2026-10-22):
 *  - эхлээд getUserMedia-аар нэг stream нээж, хаагаад, дахин deviceId-аар нээдэг байсан —
 *    iOS хоёр дахь нээлтэд ихэвчлэн хар дэлгэц / NotReadableError өгдөг;
 *  - aspectRatio: 1.4 хязгаарлалтыг iOS камер хангаж чаддаггүй (OverconstrainedError);
 *  - qrbox нь тогтмол px — нарийн дэлгэцэнд контейнерээс том болбол сан алдаа шиддэг.
 * Тиймээс facingMode: "environment"-аар НЭГ удаа нээж, qrbox-ийг контейнерийн хэмжээгээр бодно.
 */
export async function startHtml5Scanner(boxId: string, onCode: (code: string) => void) {
  const { Html5Qrcode } = await import("html5-qrcode");
  const qr = new Html5Qrcode(boxId, false);
  await qr.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: (w: number, h: number) => ({
        width: Math.max(50, Math.floor(Math.min(300, w * 0.85))),
        height: Math.max(50, Math.floor(Math.min(200, h * 0.6))),
      }),
    },
    (decoded: string) => onCode(decoded),
    () => {},
  );
  return qr;
}

/** Камер огт нээгдэх боломжгүй бол шалтгааныг хүнд ойлгомжтойгоор буцаана. */
export function cameraBlockedReason(): string {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "Камер зөвхөн HTTPS хаягаар ажиллана. Хаягийг https://… болгож нээнэ үү.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    return ios
      ? "Энэ хөтөч камер нээхийг зөвшөөрөхгүй байна. Safari-гаар нээж, Тохиргоо → Safari → Камер → «Зөвшөөрөх» болгоно уу."
      : "Камерын API байхгүй байна.";
  }
  return "";
}
