import { useId, type ReactNode } from "react";
import { PET_COUNT, renderPet } from "./historyAvatarPets";
import { useHistoryIconStyle, type HistoryIconStyle } from "../../lib/historyIcons";
import { INK, INK_ON_DARK, isDark, RETRO_EXPRESSIONS, RetroFace, type FaceSpot } from "./retroFace";

/* Decorative icons for History entries. Each entry gets a stable icon picked by hashing
   its key, so the same conversation always shows the same icon in chat and canvas.
   Purely visual: aria-hidden, no meaning attached. */

/** The icon sets offered in Settings (see lib/historyIcons.ts). */
export type HistoryAvatarSet = Exclude<HistoryIconStyle, "off">;

/* FNV-1a: cheap, stable string hash. */
export function historyAvatarIndex(seed: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % count;
}

function mix(hex: string, target: number, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const value = (n >> shift) & 0xff;
    return Math.round(value + (target - value) * amount);
  };
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}
const lighten = (hex: string, amount: number) => mix(hex, 255, amount);
const darken = (hex: string, amount: number) => mix(hex, 0, amount);

function polygon(cx: number, cy: number, radii: number[], rotation = -90): string {
  return radii
    .map((radius, i) => {
      const angle = ((rotation + (360 / radii.length) * i) * Math.PI) / 180;
      return `${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`;
    })
    .join(" ");
}

function roundStar(cx: number, cy: number, radius: number) {
  return polygon(cx, cy, [radius, radius * 0.5, radius, radius * 0.5, radius, radius * 0.5, radius, radius * 0.5, radius, radius * 0.5]);
}

/* ---------- Retro Blobs and Retro Data: flat shapes with a retro face ---------- */

type Paint = { body: string; light: string; dark: string };
/* A shape with a face: `draw` paints the body in `color`, the face sits at `face`. */
type Pal = { color: string; draw: (paint: Paint) => ReactNode; face: FaceSpot };

const BLOBS: Pal[] = [
  {
    color: "#e8803a",
    face: { y: 19 },
    draw: ({ body }) => <path d="M20 6c8.5 0 14 5.8 14 14.2C34 28.8 28.4 34 20 34S6 28.8 6 20.2C6 11.8 11.5 6 20 6z" fill={body} />,
  },
  {
    color: "#f4c75a",
    face: { y: 24 },
    draw: ({ body }) => <path d="M20 4.5c1.2 0 13 12 13 20.5a13 13 0 0 1-26 0c0-8.5 11.8-20.5 13-20.5z" fill={body} />,
  },
  {
    color: "#9dbe8c",
    face: { y: 24 },
    draw: ({ body }) => <path d="M17 8.2c1.4-2.4 4.6-2.4 6 0l11.4 19.6c1.4 2.4-.3 5.2-3 5.2H8.6c-2.7 0-4.4-2.8-3-5.2z" fill={body} />,
  },
  {
    color: "#7fb2b8",
    face: { y: 19.5, gap: 7 },
    draw: ({ body }) => <rect x="5" y="11" width="30" height="18" rx="9" fill={body} />,
  },
  {
    color: "#cfdcd6",
    face: { y: 18 },
    draw: ({ body }) => <rect x="7" y="7" width="26" height="26" rx="8" fill={body} />,
  },
  {
    color: "#f09a5b",
    face: { y: 22.5 },
    draw: ({ body }) => <path d="M12.5 31a7 7 0 0 1-1.7-13.8A9.6 9.6 0 0 1 29 14.6 8.3 8.3 0 0 1 28.6 31z" fill={body} />,
  },
  {
    color: "#e9b949",
    face: { y: 21, gap: 5.6, size: 0.85 },
    draw: ({ body }) => (
      <polygon
        points={polygon(20, 21.5, [15, 7.2, 15, 7.2, 15, 7.2, 15, 7.2, 15, 7.2])}
        fill={body}
        stroke={body}
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
    ),
  },
  {
    color: "#86ab78",
    face: { y: 19 },
    draw: ({ body }) => (
      <path
        d="M8.5 32V19a11.5 11.5 0 0 1 23 0v13l-3.8-2.8-3.8 2.8-3.9-2.8-3.8 2.8-3.9-2.8z"
        fill={body}
        stroke={body}
        strokeWidth="2"
        strokeLinejoin="round"
      />
    ),
  },
  {
    color: "#6c9fa6",
    face: { y: 21.5 },
    draw: ({ body }) => <path d="M20 5c7 0 12 10 12 17.5S26.6 34 20 34 8 30 8 22.5 13 5 20 5z" fill={body} />,
  },
  {
    color: "#b9cbc4",
    face: { y: 20 },
    draw: ({ body }) => (
      <polygon points={polygon(20, 20, [13, 13, 13, 13, 13, 13], -90)} fill={body} stroke={body} strokeWidth="4" strokeLinejoin="round" />
    ),
  },
];

const DATA: Pal[] = [
  {
    // database
    color: "#7fb2b8",
    face: { y: 26.5, size: 0.9 },
    draw: ({ body, light, dark }) => (
      <>
        <path d="M8 11c0-3.3 5.4-5 12-5s12 1.7 12 5v18c0 3.3-5.4 5-12 5s-12-1.7-12-5z" fill={body} />
        <ellipse cx="20" cy="11" rx="12" ry="5" fill={light} />
        <path d="M8 17.5c0 3.3 5.4 5 12 5s12-1.7 12-5" fill="none" stroke={dark} strokeOpacity="0.35" strokeWidth="1.2" />
      </>
    ),
  },
  {
    // table
    color: "#9dbe8c",
    face: { y: 23.5, gap: 9.4, size: 0.85 },
    draw: ({ body, dark }) => (
      <>
        <rect x="6" y="7" width="28" height="26" rx="6" fill={body} />
        <path d="M6 13a6 6 0 0 1 6-6h16a6 6 0 0 1 6 6z" fill={dark} opacity="0.35" />
        <path d="M15.3 7v26M24.7 7v26M6 20h28" stroke="#fff" strokeOpacity="0.28" strokeWidth="1.1" />
      </>
    ),
  },
  {
    // bar chart
    color: "#f4c75a",
    face: { y: 15, gap: 4, size: 0.62 },
    draw: ({ body, light, dark }) => (
      <>
        <rect x="5.5" y="20" width="8" height="13" rx="3" fill={light} />
        <rect x="16" y="7" width="8" height="26" rx="3.5" fill={body} />
        <rect x="26.5" y="15" width="8" height="18" rx="3" fill={dark} opacity="0.85" />
      </>
    ),
  },
  {
    // pie chart
    color: "#e8803a",
    face: { x: 16.5, y: 24, gap: 6, size: 0.85 },
    draw: ({ body, light }) => (
      <>
        <circle cx="20" cy="21" r="13.5" fill={body} />
        <path d="M20 21V7.5A13.5 13.5 0 0 1 33.5 21z" fill={light} transform="translate(1.2 -1.2)" />
      </>
    ),
  },
  {
    // key
    color: "#cfdcd6",
    face: { x: 14, y: 19, gap: 5.2, size: 0.8 },
    draw: ({ body, dark }) => (
      <>
        <path d="M21 17.5h12.5v4h-2.5v4h-3.5v-4H21z" fill={dark} />
        <circle cx="14" cy="19.5" r="9.5" fill={body} />
      </>
    ),
  },
  {
    // magnifier
    color: "#86ab78",
    face: { x: 17.5, y: 17.5, gap: 5.4, size: 0.78 },
    draw: ({ body, light }) => (
      <>
        <path d="M25.5 25.5l7.5 7.5" stroke={body} strokeWidth="5.5" strokeLinecap="round" />
        <circle cx="17.5" cy="17.5" r="11.5" fill={body} />
        <circle cx="17.5" cy="17.5" r="8" fill={light} />
      </>
    ),
  },
  {
    // document
    color: "#e9b949",
    face: { y: 23, size: 0.9 },
    draw: ({ body, light }) => (
      <>
        <path d="M11 5h13l8 8v19a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z" fill={body} />
        <path d="M24 5v5a3 3 0 0 0 3 3h5z" fill={light} />
      </>
    ),
  },
  {
    // funnel
    color: "#f09a5b",
    face: { y: 13.5, gap: 6.4, size: 0.8 },
    draw: ({ body }) => (
      <path d="M7.5 8.5h25l-9.5 12v9.5l-6 3.5V20.5z" fill={body} stroke={body} strokeWidth="3" strokeLinejoin="round" />
    ),
  },
  {
    // cube
    color: "#6c9fa6",
    face: { x: 13.5, y: 22.5, gap: 5, size: 0.7 },
    draw: ({ body, light, dark }) => (
      <>
        <path d="M20 5l13 7-13 7-13-7z" fill={light} strokeLinejoin="round" stroke={light} strokeWidth="1.5" />
        <path d="M7 12l13 7v16l-13-7z" fill={body} strokeLinejoin="round" stroke={body} strokeWidth="1.5" />
        <path d="M33 12l-13 7v16l13-7z" fill={dark} strokeLinejoin="round" stroke={dark} strokeWidth="1.5" />
      </>
    ),
  },
  {
    // speech bubble
    color: "#b9cbc4",
    face: { y: 17.5 },
    draw: ({ body }) => (
      <path d="M11 6.5h18a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H18l-6.5 5.5v-5.5H11a6 6 0 0 1-6-6v-10a6 6 0 0 1 6-6z" fill={body} />
    ),
  },
];

function ShapeWithFace({ pal, index }: { pal: Pal; index: number }) {
  const { color } = pal;
  return (
    <>
      {pal.draw({ body: color, light: lighten(color, 0.35), dark: darken(color, 0.18) })}
      <RetroFace {...pal.face} expression={RETRO_EXPRESSIONS[index % RETRO_EXPRESSIONS.length]} ink={isDark(color) ? INK_ON_DARK : INK} />
    </>
  );
}

/* ---------- Star Sketch: the 12 zodiac constellations as a pencil star chart ---------- */

/* Thin lines, a tiny star at every vertex, one ink colour (currentColor) so it follows the
   theme. Points are in any units; they are fitted into the icon box. */
type Zodiac = { stars: [number, number][]; edges: [number, number][] };

const ZODIAC: Zodiac[] = [
  // Aries
  { stars: [[277, 146], [385, 134], [434, 245], [440, 290], [431, 305]], edges: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  // Taurus
  {
    stars: [[678, 117], [740, 187], [750, 207], [757, 231], [742, 224], [727, 213], [638, 156], [785, 260], [840, 289], [846, 299]],
    edges: [[0, 1], [1, 2], [2, 3], [6, 5], [5, 4], [4, 3], [3, 7], [7, 8], [8, 9]],
  },
  // Gemini
  {
    stars: [
      [1049, 134], [1100, 153], [1141, 116], [1021, 173], [1042, 186], [1066, 178], [1021, 211], [1078, 239], [1078, 294],
      [1163, 332], [1116, 253], [1180, 296], [1163, 205], [1199, 256], [1213, 231], [1232, 230], [1250, 217],
    ],
    edges: [[0, 1], [1, 2], [1, 5], [5, 4], [4, 3], [4, 6], [4, 7], [7, 8], [8, 9], [7, 10], [10, 11], [1, 12], [12, 13], [12, 14], [14, 15], [15, 16]],
  },
  // Cancer
  { stars: [[1493, 89], [1497, 178], [1493, 217], [1451, 293], [1543, 286], [1567, 330]], edges: [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]] },
  // Leo
  {
    stars: [[452, 458], [466, 477], [416, 493], [419, 529], [442, 553], [447, 598], [316, 592], [245, 605], [313, 540]],
    edges: [[1, 0], [0, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 3]],
  },
  // Virgo
  {
    stars: [[726, 418], [745, 492], [708, 511], [650, 518], [776, 535], [812, 553], [733, 567], [714, 604], [707, 667], [810, 620], [770, 630], [767, 655], [757, 673]],
    edges: [[0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [2, 6], [6, 5], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12]],
  },
  // Libra
  {
    stars: [[1100, 445], [1017, 506], [1106, 511], [1188, 506], [1067, 582], [1080, 640], [1205, 600], [1203, 612], [1220, 620]],
    edges: [[0, 1], [0, 3], [1, 2], [2, 3], [1, 4], [4, 5], [3, 6], [6, 7], [7, 8]],
  },
  // Scorpio
  {
    stars: [[1549, 428], [1565, 450], [1575, 478], [1533, 482], [1510, 510], [1500, 563], [1510, 600], [1515, 632], [1487, 643], [1448, 655], [1427, 636], [1426, 624], [1437, 606], [1450, 608]],
    edges: [[0, 3], [1, 3], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13]],
  },
  // Sagittarius (the teapot)
  {
    stars: [[6, 24], [13, 21], [18, 15], [23, 20], [21, 28], [13, 29], [27, 12], [32, 22], [30, 30]],
    edges: [[0, 1], [1, 2], [2, 3], [1, 5], [5, 4], [4, 3], [3, 1], [2, 6], [3, 7], [4, 8]],
  },
  // Capricorn
  {
    stars: [[6, 12], [10, 15], [17, 25], [22, 28], [28, 25], [34, 14], [31, 13], [24, 17], [16, 17]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 1]],
  },
  // Aquarius
  {
    stars: [[6, 10], [12, 14], [18, 12], [22, 18], [20, 24], [26, 28], [32, 26], [16, 30], [28, 8]],
    edges: [[8, 2], [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [4, 7]],
  },
  // Pisces
  {
    stars: [[8, 6], [10, 10], [13, 16], [16, 22], [20, 33], [24, 28], [28, 24], [31, 21], [35, 19], [34, 15], [30, 16]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 7]],
  },
];

/* Fit a constellation into a centred square box, keeping its proportions. */
function fitZodiac(z: Zodiac, lo = 3.5, hi = 36.5): [number, number][] {
  const xs = z.stars.map(([x]) => x);
  const ys = z.stars.map(([, y]) => y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = (hi - lo) / Math.max(maxX - minX, maxY - minY);
  const offX = (hi - lo - (maxX - minX) * scale) / 2 + lo;
  const offY = (hi - lo - (maxY - minY) * scale) / 2 + lo;
  return z.stars.map(([x, y]) => [offX + (x - minX) * scale, offY + (y - minY) * scale]);
}

function StarSketch({ z }: { z: Zodiac }) {
  const stars = fitZodiac(z);
  return (
    <>
      {z.edges.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          x1={stars[a][0]}
          y1={stars[a][1]}
          x2={stars[b][0]}
          y2={stars[b][1]}
          stroke="currentColor"
          strokeOpacity="0.85"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
      ))}
      {stars.map(([x, y], i) => (
        <polygon key={i} points={roundStar(x, y, 2.2)} fill="currentColor" />
      ))}
    </>
  );
}

/* ---------- Star Seal: round star-chart medallions, after the Auriga logo ---------- */

type Constellation = { bg: string; stars: [number, number][]; edges: [number, number][]; bright: number };

/* `bright` is the gold star; -1 draws a single sparkle instead. */
const SEALS: Constellation[] = [
  { bg: "#173a5e", stars: [[20, 8], [30.5, 15], [27.5, 28], [13, 29], [9.5, 16]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]], bright: 0 },
  { bg: "#0f6f78", stars: [[7, 13], [13, 11.5], [19, 14.5], [24, 19], [25, 28.5], [33.5, 29], [34, 20.5]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]], bright: 6 },
  { bg: "#3b3f9a", stars: [[6.5, 14], [13, 26], [20, 16.5], [27, 27], [33.5, 13.5]], edges: [[0, 1], [1, 2], [2, 3], [3, 4]], bright: 2 },
  { bg: "#5b3a8a", stars: [[12, 8], [28, 9.5], [16.5, 20.5], [20, 21.5], [23.5, 22.5], [12.5, 32], [28.5, 31]], edges: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6]], bright: 1 },
  { bg: "#1d5f8f", stars: [[20, 7.5], [32, 29], [8, 28], [20, 21.5]], edges: [[0, 1], [1, 2], [2, 0], [0, 3]], bright: 3 },
  { bg: "#1f6b5a", stars: [[6, 30], [12, 22], [20, 18.5], [28, 20.5], [34, 11.5]], edges: [[0, 1], [1, 2], [2, 3], [3, 4]], bright: 4 },
  { bg: "#7a2f4f", stars: [[20, 6.5], [20, 18.5], [20, 33], [8, 15.5], [32, 21]], edges: [[0, 1], [1, 2], [3, 1], [1, 4]], bright: 1 },
  { bg: "#3d4a5c", stars: [[20, 6.5], [32.5, 20], [20, 33.5], [7.5, 20], [20, 20]], edges: [[0, 1], [1, 2], [2, 3], [3, 0]], bright: 4 },
  { bg: "#7a5420", stars: [[8, 10], [16, 18], [10, 28.5], [22, 30.5], [32, 22.5], [28.5, 10]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], bright: 5 },
  { bg: "#1c2244", stars: [[10, 10], [31, 12], [9, 30], [30, 31]], edges: [], bright: -1 },
];

const SPARKLE = "M20 8.5c.9 6.6 4.9 10.6 11.5 11.5-6.6.9-10.6 4.9-11.5 11.5-.9-6.6-4.9-10.6-11.5-11.5 6.6-.9 10.6-4.9 11.5-11.5z";
const GOLD = "#e0a84a";
const STAR_GOLD = "#f5c66a";

function StarSeal({ c, id }: { c: Constellation; id: string }) {
  const k = 0.68;
  const fit = ([x, y]: [number, number]): [number, number] => [20 + (x - 20) * k, 20 + (y - 20) * k];
  const stars = c.stars.map(fit);
  return (
    <>
      <defs>
        <radialGradient id={id} cx="40%" cy="35%" r="75%">
          <stop offset="0%" stopColor={lighten(c.bg, 0.15)} />
          <stop offset="100%" stopColor={darken(c.bg, 0.4)} />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="18.5" fill={`url(#${id})`} />
      <circle cx="20" cy="20" r="16.6" fill="none" stroke={GOLD} strokeWidth="1.1" />
      <g fill="none" stroke="#fff" strokeOpacity="0.14" strokeWidth="0.8">
        <ellipse cx="20" cy="20" rx="16.6" ry="5.5" />
        <ellipse cx="20" cy="20" rx="5.5" ry="16.6" />
        <line x1="3.4" y1="20" x2="36.6" y2="20" />
      </g>
      {c.edges.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          x1={stars[a][0]}
          y1={stars[a][1]}
          x2={stars[b][0]}
          y2={stars[b][1]}
          stroke="#fff"
          strokeOpacity="0.6"
          strokeWidth="1"
          strokeLinecap="round"
        />
      ))}
      {stars.map(([x, y], i) =>
        i === c.bright ? <circle key={i} cx={x} cy={y} r="2.3" fill={STAR_GOLD} /> : <circle key={i} cx={x} cy={y} r="1.4" fill="#fff" />,
      )}
      {c.bright === -1 && <path d={SPARKLE} fill={STAR_GOLD} transform="translate(20 20) scale(0.7) translate(-20 -20)" />}
    </>
  );
}

/* ---------- the component ---------- */

export const HISTORY_AVATAR_COUNTS: Record<HistoryAvatarSet, number> = {
  retroPets: PET_COUNT,
  pets: PET_COUNT,
  starSketch: ZODIAC.length,
  starSeal: SEALS.length,
  retroData: DATA.length,
  retroBlobs: BLOBS.length,
};

/* Badges and line drawings fill the full box; heads and shapes get a tighter crop so
   they read at the same size. */
const VIEW_BOX: Record<HistoryAvatarSet, string> = {
  retroPets: "2 2 36 36",
  pets: "2 2 36 36",
  starSketch: "0 0 40 40",
  starSeal: "0 0 40 40",
  retroData: "3 3 34 34",
  retroBlobs: "3 3 34 34",
};

/** The icon beside a History entry. Without `set` it uses the set chosen in Settings and
 *  renders nothing when icons are turned off. */
export function HistoryAvatar(props: {
  seed: string;
  set?: HistoryAvatarSet;
  /** Force a specific icon (used by the Settings preview); defaults to the seed's hash. */
  index?: number;
  className?: string;
}) {
  const preference = useHistoryIconStyle();
  const set = props.set ?? (preference === "off" ? null : preference);
  return set ? <AvatarSvg {...props} set={set} /> : null;
}

/** Stand-in for an entry still being created: its final key (and so its icon) is not known yet,
 *  so show a neutral disc instead of an icon that would change when the entry lands. */
export function HistoryAvatarPlaceholder({ className }: { className?: string }) {
  return useHistoryIconStyle() === "off" ? null : <span aria-hidden="true" className={className} />;
}

function AvatarSvg({ seed, set, index, className }: { seed: string; set: HistoryAvatarSet; index?: number; className?: string }) {
  const id = `ha-${useId().replace(/:/g, "")}`;
  const i = index ?? historyAvatarIndex(seed, HISTORY_AVATAR_COUNTS[set]);

  let content: ReactNode;
  switch (set) {
    case "retroPets":
    case "pets":
      content = renderPet(i, set === "pets" ? "cute" : "retro", id);
      break;
    case "starSketch":
      content = <StarSketch z={ZODIAC[i]} />;
      break;
    case "starSeal":
      content = <StarSeal c={SEALS[i]} id={id} />;
      break;
    case "retroData":
      content = <ShapeWithFace pal={DATA[i]} index={i} />;
      break;
    case "retroBlobs":
      content = <ShapeWithFace pal={BLOBS[i]} index={i} />;
      break;
  }

  return (
    <svg viewBox={VIEW_BOX[set]} aria-hidden="true" focusable="false" className={className}>
      {content}
    </svg>
  );
}
