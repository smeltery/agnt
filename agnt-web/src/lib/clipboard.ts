// Tiny Clipboard wrapper. The async API is the only way to write text in a
// modern HTTPS context (which agnt-web requires anyway). Falls through to the
// legacy `document.execCommand("copy")` path for non-secure dev origins so
// "localhost over plain http" still works for hacking.

export async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // permission denied / non-secure context — fall through
    }
  }
  return legacyCopy(value);
}

function legacyCopy(value: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
