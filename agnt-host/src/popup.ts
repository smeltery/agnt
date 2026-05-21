import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";

(async () => {
  const qrArea = document.getElementById("qr-area")!;

  try {
    const payload = await invoke("get_pairing_payload");
    if (payload) {
      const canvas = document.createElement("canvas");
      await QRCode.toCanvas(canvas, String(payload), { width: 128, margin: 1 });
      qrArea.innerHTML = "";
      qrArea.appendChild(canvas);
    } else {
      await invoke("hide_pet_popup");
    }
  } catch {
    await invoke("hide_pet_popup").catch(() => {});
  }
})();
