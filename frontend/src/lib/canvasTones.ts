export const CANVAS_TONES = [
  { id: "slate", label: "Slate", dot: "#8e98a8", border: "rgba(142,152,168,0.88)", glow: "rgba(142,152,168,0.22)", fill: "rgba(248,249,250,0.92)" },
  { id: "green", label: "Green", dot: "#23a579", border: "rgba(35,165,121,0.92)", glow: "rgba(35,165,121,0.22)", fill: "rgba(241,250,246,0.92)" },
  { id: "amber", label: "Amber", dot: "#d6a104", border: "rgba(214,161,4,0.92)", glow: "rgba(214,161,4,0.22)", fill: "rgba(255,250,235,0.92)" },
  { id: "blue", label: "Blue", dot: "#438af3", border: "rgba(67,138,243,0.92)", glow: "rgba(67,138,243,0.22)", fill: "rgba(241,247,255,0.92)" },
  { id: "rose", label: "Rose", dot: "#ff6aa3", border: "rgba(255,106,163,0.95)", glow: "rgba(112,76,255,0.20)", fill: "rgba(255,246,250,0.94)" },
] as const;

export type CanvasToneId = (typeof CANVAS_TONES)[number]["id"];

export function getCanvasTone(id: CanvasToneId | undefined) {
  return CANVAS_TONES.find((item) => item.id === id);
}
