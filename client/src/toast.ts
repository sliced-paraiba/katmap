export type ToastKind = "error" | "success" | "info";

let hideTimeout: ReturnType<typeof setTimeout> | null = null;
let actionToastVisible = false;

function toastContainer(): HTMLElement {
  let el = document.getElementById("toast-container");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-container";
    document.body.appendChild(el);
  }
  return el;
}

export function showToast(message: string, kind: ToastKind = "info") {
  if (actionToastVisible) return;
  if (hideTimeout) clearTimeout(hideTimeout);

  const el = toastContainer();
  el.textContent = message;
  el.className = `toast toast-${kind} toast-visible`;

  const duration = kind === "error" ? 5000 : 2000;
  hideTimeout = setTimeout(() => hideToast(), duration);
}

export function showActionToast(options: {
  message: string;
  kind?: ToastKind;
  actionLabel: string;
  onAction: () => void;
}) {
  actionToastVisible = true;
  if (hideTimeout) clearTimeout(hideTimeout);

  const el = toastContainer();
  const kind = options.kind ?? "info";
  el.className = `toast toast-${kind} toast-update toast-visible`;
  el.replaceChildren(
    Object.assign(document.createElement("span"), { textContent: options.message }),
    Object.assign(document.createElement("button"), {
      type: "button",
      className: "toast-reload-btn",
      textContent: options.actionLabel,
      onclick: options.onAction,
    }),
  );
}

export function hideToast() {
  const el = document.getElementById("toast-container");
  el?.classList.remove("toast-visible");
}
