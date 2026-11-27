/**
 * Desktop (OS) notifications, modelled on Open WebUI: off by default, turned
 * on in Settings → General, which asks the browser for permission. In-app
 * toasts for background chats don't depend on this setting.
 */

const DESKTOP_KEY = "aurigasql-desktop-notifications";

export function desktopNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getDesktopNotifications(): boolean {
  if (!desktopNotificationsSupported() || Notification.permission !== "granted") return false;
  try {
    return localStorage.getItem(DESKTOP_KEY) === "on";
  } catch {
    return false;
  }
}

/** Turns desktop notifications on or off. Returns the resulting state, which
 *  stays off when the browser permission is denied. */
export async function setDesktopNotifications(enabled: boolean): Promise<boolean> {
  let next = enabled;
  if (enabled) {
    if (!desktopNotificationsSupported()) return false;
    // A blocked site resolves to "denied" straight away without prompting.
    const permission =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    next = permission === "granted";
  }
  try {
    localStorage.setItem(DESKTOP_KEY, next ? "on" : "off");
  } catch {
    // Preference just won't persist.
  }
  return next;
}

export function showDesktopNotification(title: string, body: string, onClick: () => void) {
  if (!getDesktopNotifications()) return;
  try {
    const notification = new Notification(title, { body, tag: "aurigasql-chat" });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  } catch {
    // Some browsers (e.g. Android Chrome) only allow notifications from a service worker.
  }
}

/** One line of plain text for a notification body. */
export function notificationSnippet(text: string | null | undefined, limit = 140): string {
  if (!text) return "";
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]+/g, "")
    .replace(/[#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain;
}
