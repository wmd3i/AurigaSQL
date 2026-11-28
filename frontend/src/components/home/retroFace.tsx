import type { ReactNode } from "react";

/* Retro hand-drawn faces shared by the history avatar sets: tall bean eyes, thin brows,
   a one-stroke hook nose and simple one-line mouths. */

/* Where a face sits on a shape: centre x/y, eye gap and scale, in the shape's 40×40 grid. */
export type FaceSpot = { x?: number; y: number; gap?: number; size?: number };

type RetroEyes = "bean" | "white" | "glance" | "ring" | "closed";
type RetroBrows = "none" | "flat" | "worried" | "angry" | "quirk";
type RetroMouth = "smirk" | "smile" | "bigSmile" | "o" | "frown" | "flat" | "wavy" | "grin";
export type RetroExpression = { eyes: RetroEyes; brows: RetroBrows; mouth: RetroMouth; nose?: boolean; blush?: boolean };

/* One expression per slot, so neighbouring entries rarely share a face. */
export const RETRO_EXPRESSIONS: RetroExpression[] = [
  { eyes: "white", brows: "none", mouth: "smirk", nose: true },
  { eyes: "closed", brows: "none", mouth: "smile" },
  { eyes: "bean", brows: "flat", mouth: "smile", blush: true },
  { eyes: "ring", brows: "none", mouth: "wavy", nose: true },
  { eyes: "white", brows: "flat", mouth: "o", nose: true },
  { eyes: "glance", brows: "quirk", mouth: "flat", nose: true },
  { eyes: "bean", brows: "worried", mouth: "frown" },
  { eyes: "white", brows: "angry", mouth: "flat", nose: true },
  { eyes: "closed", brows: "none", mouth: "grin", blush: true },
  { eyes: "bean", brows: "none", mouth: "bigSmile", nose: true },
];

export const INK = "#1d1a1a";
export const INK_ON_DARK = "#fbf4ea";
const BLUSH = "#f0855a";

export function isDark(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}

export function RetroFace({
  x = 20,
  y,
  gap: spotGap = 6.4,
  size = 1,
  expression,
  ink = INK,
  eyesOnly = false,
}: FaceSpot & { expression: RetroExpression; ink?: string; /** Blush, brows and eyes only: for faces that draw their own nose and mouth. */ eyesOnly?: boolean }) {
  /* Retro faces fill more of the head than the face spots were sized for. */
  const s = size * 1.3;
  const gap = spotGap * 1.15;
  const ey = y - 0.6 * s;
  const { eyes, brows, mouth, nose, blush } = expression;
  const line = { fill: "none", stroke: ink, strokeWidth: 1.05 * s, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  const eye = (cx: number) => {
    switch (eyes) {
      case "bean":
        return <ellipse key={cx} cx={cx} cy={ey} rx={1.05 * s} ry={1.9 * s} fill={ink} />;
      case "white":
        return (
          <g key={cx}>
            <ellipse cx={cx} cy={ey} rx={1.85 * s} ry={2.3 * s} fill="#fff" />
            <ellipse cx={cx + 0.45 * s} cy={ey + 0.2 * s} rx={0.9 * s} ry={1.55 * s} fill={INK} />
          </g>
        );
      case "glance":
        return (
          <g key={cx}>
            <ellipse cx={cx} cy={ey} rx={2 * s} ry={1.5 * s} fill="#fff" />
            <ellipse cx={cx + 1 * s} cy={ey} rx={0.85 * s} ry={1.25 * s} fill={INK} />
          </g>
        );
      case "ring":
        return (
          <g key={cx}>
            <circle cx={cx} cy={ey} r={2 * s} fill="#fff" stroke={INK} strokeWidth={0.9 * s} />
            <circle cx={cx} cy={ey} r={0.8 * s} fill={INK} />
          </g>
        );
      case "closed":
        return <path key={cx} d={`M${cx - 1.7 * s} ${ey + 0.5 * s}q${1.7 * s} ${-2.2 * s} ${3.4 * s} 0`} {...line} />;
    }
  };

  const by = ey - 3.2 * s;
  /* side: -1 for the left eye, 1 for the right; "inner" is the end nearest the nose. */
  const brow = (cx: number, side: -1 | 1) => {
    const outer = cx + side * 1.3 * s;
    const inner = cx - side * 1.3 * s;
    switch (brows) {
      case "none":
        return null;
      case "flat":
        return <path key={`b${cx}`} d={`M${cx - 1.3 * s} ${by + 0.3 * s}q${1.3 * s} ${-0.8 * s} ${2.6 * s} 0`} {...line} />;
      case "worried":
        return <path key={`b${cx}`} d={`M${outer} ${by + 0.5 * s}L${inner} ${by - 0.4 * s}`} {...line} />;
      case "angry":
        return <path key={`b${cx}`} d={`M${outer} ${by - 0.3 * s}L${inner} ${by + 0.8 * s}`} {...line} />;
      case "quirk":
        return side === -1 ? (
          <path key={`b${cx}`} d={`M${cx - 1.4 * s} ${by + 0.7 * s}h${2.8 * s}`} {...line} />
        ) : (
          <path key={`b${cx}`} d={`M${cx - 1.3 * s} ${by}q${1.3 * s} ${-1.4 * s} ${2.6 * s} 0`} {...line} />
        );
    }
  };

  const my = ey + (nose ? 4.5 : 3.7) * s;
  let mouthEl: ReactNode;
  switch (mouth) {
    case "smirk":
      mouthEl = <path d={`M${x - 1.4 * s} ${my}q${1.6 * s} ${1.2 * s} ${3 * s} ${-0.7 * s}`} {...line} />;
      break;
    case "smile":
      mouthEl = <path d={`M${x - 1.3 * s} ${my - 0.2 * s}q${1.3 * s} ${1.4 * s} ${2.6 * s} 0`} {...line} />;
      break;
    case "bigSmile":
      mouthEl = <path d={`M${x - 2.4 * s} ${my - 0.5 * s}q${2.4 * s} ${2.6 * s} ${4.8 * s} 0`} {...line} />;
      break;
    case "o":
      mouthEl = <ellipse cx={x} cy={my + 0.3 * s} rx={0.75 * s} ry={1.05 * s} {...line} />;
      break;
    case "frown":
      mouthEl = <path d={`M${x - 1.5 * s} ${my + 0.6 * s}q${1.5 * s} ${-1.3 * s} ${3 * s} 0`} {...line} />;
      break;
    case "flat":
      mouthEl = <path d={`M${x - 1.2 * s} ${my + 0.1 * s}h${2.4 * s}`} {...line} />;
      break;
    case "wavy":
      mouthEl = <path d={`M${x - 2.6 * s} ${my}q${1.3 * s} ${0.9 * s} ${2.6 * s} 0t${2.6 * s} 0`} {...line} />;
      break;
    case "grin":
      mouthEl = (
        <g>
          <path d={`M${x - 2.2 * s} ${my - 0.7 * s}h${4.4 * s}q0 ${2.9 * s} ${-2.2 * s} ${2.9 * s}t${-2.2 * s} ${-2.9 * s}z`} fill={ink} />
          <rect x={x - 1.7 * s} y={my - 0.7 * s} width={3.4 * s} height={0.85 * s} rx={0.2 * s} fill={ink === INK ? "#fff" : INK} />
        </g>
      );
      break;
  }

  const L = x - gap / 2;
  const R = x + gap / 2;
  return (
    <g>
      {blush && (
        <>
          <ellipse cx={L - 0.7 * s} cy={ey + 2.8 * s} rx={1.4 * s} ry={1.1 * s} fill={BLUSH} opacity="0.8" />
          <ellipse cx={R + 0.7 * s} cy={ey + 2.8 * s} rx={1.4 * s} ry={1.1 * s} fill={BLUSH} opacity="0.8" />
        </>
      )}
      {brow(L, -1)}
      {brow(R, 1)}
      {eye(L)}
      {eye(R)}
      {nose && !eyesOnly && (
        <path
          d={`M${x + 0.25 * s} ${ey + 1.3 * s}c${-1 * s} ${0.6 * s} ${-1 * s} ${1.5 * s} ${0.1 * s} ${1.6 * s}`}
          {...line}
          strokeWidth={0.9 * s}
        />
      )}
      {!eyesOnly && mouthEl}
    </g>
  );
}

