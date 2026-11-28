import type { ReactNode } from "react";
import { INK, INK_ON_DARK, isDark, RETRO_EXPRESSIONS, RetroFace, type RetroExpression } from "./retroFace";

/* Pets: cartoon cat and dog heads on a 40×40 grid, in two styles that share every silhouette.
   - "cute"  (set F): natural coats, glossy dot eyes, pink noses.
   - "retro" (set G): flat muted retro palette with the shared retro hand-drawn eyes and brows.
   The fluffy cream doodle (and its apricot twin) is modelled on a reference photo. */

export type PetStyle = "cute" | "retro";
type Ctx = { retro: boolean; expr: RetroExpression; id: string };

const FEAT = "#2a211d";
const PINK = "#f08fa0";
const BLUSH = "#ff8a9e";
const RETRO_TONGUE = "#ec7a6a";

/* ---------- shared features ---------- */

function DotEyes({ y = 21.5, gap = 9.6, r = 2.1 }: { y?: number; gap?: number; r?: number }) {
  return (
    <>
      {[20 - gap / 2, 20 + gap / 2].map((x) => (
        <g key={x}>
          <circle cx={x} cy={y} r={r} fill={FEAT} />
          <circle cx={x + r * 0.35} cy={y - r * 0.4} r={r * 0.36} fill="#fff" />
        </g>
      ))}
    </>
  );
}

function HappyEyes({ y = 21.8, gap = 9.6 }: { y?: number; gap?: number }) {
  return (
    <>
      {[20 - gap / 2, 20 + gap / 2].map((x) => (
        <path key={x} d={`M${x - 2} ${y + 0.6}q2-2.6 4 0`} fill="none" stroke={FEAT} strokeWidth="1.3" strokeLinecap="round" />
      ))}
    </>
  );
}

function Blush({ y = 25.6, gap = 15 }: { y?: number; gap?: number }) {
  return (
    <>
      <ellipse cx={20 - gap / 2} cy={y} rx="1.8" ry="1.1" fill={BLUSH} opacity="0.5" />
      <ellipse cx={20 + gap / 2} cy={y} rx="1.8" ry="1.1" fill={BLUSH} opacity="0.5" />
    </>
  );
}

/* Eyes for either style. In "cute" the pet's own eyes (default: dot eyes plus blush) are drawn;
   in "retro" the shared retro brows/eyes/blush take their place. */
function PetEyes({ ctx, fur, y = 21.4, gap = 9.6, cute }: { ctx: Ctx; fur: string; y?: number; gap?: number; cute?: ReactNode }) {
  if (ctx.retro) {
    return <RetroFace x={20} y={y + 0.66} gap={gap / 1.15} size={0.85} expression={ctx.expr} ink={isDark(fur) ? INK_ON_DARK : INK} eyesOnly />;
  }
  return (
    <>
      {cute ?? (
        <>
          <Blush />
          <DotEyes y={y} gap={gap} />
        </>
      )}
    </>
  );
}

/* Line colour for features drawn on `fur`. */
const ink = (ctx: Ctx, fur: string, cuteColor = FEAT) => (ctx.retro ? (isDark(fur) ? INK_ON_DARK : INK) : cuteColor);

/* ---------- cats ---------- */

const CAT_HEAD = { cx: 20, cy: 22.5, rx: 12.8, ry: 10.6 };
const CAT_EARS = "M8.6 17.5L10 5.5l8 7zM31.4 17.5L30 5.5l-8 7z";
const CAT_INNER_L = "M10.8 14.6l.7-6 4.4 4z";
const CAT_INNER_R = "M29.2 14.6l-.7-6-4.4 4z";

function CatEars({ fur, inner }: { fur: string; inner: string }) {
  return (
    <>
      <path d={CAT_EARS} fill={fur} stroke={fur} strokeWidth="1.6" strokeLinejoin="round" />
      <path d={`${CAT_INNER_L}${CAT_INNER_R}`} fill={inner} stroke={inner} strokeWidth="0.8" strokeLinejoin="round" />
    </>
  );
}

function CatMouth({ line, nose, whiskers = true }: { line: string; nose: string; whiskers?: boolean }) {
  return (
    <>
      <path d="M18.8 25.1h2.4l-1.2 1.3z" fill={nose} stroke={nose} strokeWidth="0.9" strokeLinejoin="round" />
      <path d="M17.6 26.8q1.2 1.3 2.4 0q1.2 1.3 2.4 0" fill="none" stroke={line} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      {whiskers && (
        <g stroke={line} strokeOpacity="0.4" strokeWidth="0.7" strokeLinecap="round">
          <path d="M6.5 24.6l4.2.6M6.8 27.4l4-.5M33.5 24.6l-4.2.6M33.2 27.4l-4-.5" />
        </g>
      )}
    </>
  );
}

function OrangeTabby({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro
    ? { fur: "#e8803a", inner: "#f5b98a", stripe: "#c4632a", muzzle: "#f5c9a0" }
    : { fur: "#f2a24e", inner: "#f6b3bf", stripe: "#c9732a", muzzle: "#fbe3c4" };
  return (
    <>
      <CatEars fur={c.fur} inner={c.inner} />
      <ellipse {...CAT_HEAD} fill={c.fur} />
      <g stroke={c.stripe} strokeWidth="1.3" strokeLinecap="round">
        <path d="M20 12.6v3.2M16.6 13.2l.6 2.8M23.4 13.2l-.6 2.8" />
      </g>
      <ellipse cx="20" cy="27" rx="5" ry="3.6" fill={c.muzzle} />
      <PetEyes ctx={ctx} fur={c.fur} y={21.5} />
      <CatMouth line={ink(ctx, c.muzzle)} nose={ctx.retro ? INK : PINK} />
    </>
  );
}

function BlueGrayCat({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro ? { fur: "#7fb2b8", inner: "#c7dfe1", muzzle: "#c7dfe1" } : { fur: "#9fabbb", inner: "#f6b3bf", muzzle: "#d9dfe7" };
  return (
    <>
      <CatEars fur={c.fur} inner={c.inner} />
      <ellipse {...CAT_HEAD} fill={c.fur} />
      <ellipse cx="20" cy="27" rx="5" ry="3.6" fill={c.muzzle} />
      <PetEyes
        ctx={ctx}
        fur={c.fur}
        y={21.5}
        cute={
          <>
            <Blush />
            <HappyEyes />
          </>
        }
      />
      <CatMouth line={ink(ctx, c.muzzle)} nose={ctx.retro ? INK : PINK} />
    </>
  );
}

function BlackCat({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro ? { fur: "#4c6f74", inner: "#7fa3a6" } : { fur: "#2f2b35", inner: "#6b4a5a" };
  return (
    <>
      <CatEars fur={c.fur} inner={c.inner} />
      <ellipse {...CAT_HEAD} fill={c.fur} />
      <PetEyes
        ctx={ctx}
        fur={c.fur}
        y={21.5}
        cute={[15.2, 24.8].map((x) => (
          <g key={x}>
            <ellipse cx={x} cy="21.5" rx="2.5" ry="2.6" fill="#f3d35a" />
            <ellipse cx={x} cy="21.5" rx="0.8" ry="2" fill={FEAT} />
            <circle cx={x + 0.9} cy="20.6" r="0.6" fill="#fff" />
          </g>
        ))}
      />
      <CatMouth line={ctx.retro ? INK_ON_DARK : "#d8d2dc"} nose={ctx.retro ? INK_ON_DARK : PINK} />
    </>
  );
}

function CalicoCat({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro
    ? { fur: "#cfdcd6", orange: "#e8803a", dark: "#3d3a3a", innerL: "#f5b98a", innerR: "#6b6666" }
    : { fur: "#fbf5ec", orange: "#ef9a48", dark: "#3a3238", innerL: "#f6b3bf", innerR: "#8a5a6a" };
  return (
    <>
      <defs>
        <clipPath id={ctx.id}>
          <ellipse {...CAT_HEAD} />
          <path d={CAT_EARS} />
        </clipPath>
      </defs>
      <path d={CAT_EARS} fill={c.fur} stroke={c.fur} strokeWidth="1.6" strokeLinejoin="round" />
      <ellipse {...CAT_HEAD} fill={c.fur} />
      <g clipPath={`url(#${ctx.id})`}>
        <path d="M3 3h15.5l.5 9.5c-3 1-5.2 3.2-6.2 6.4-2.6 1.2-6 1-9.8 0z" fill={c.orange} />
        <path d="M37 3H23.5l-.8 9.2c3 1.4 5.2 3.4 6.2 6.4 2.4 1 5.2.8 8.1-.2z" fill={c.dark} />
      </g>
      <path d={CAT_INNER_L} fill={c.innerL} stroke={c.innerL} strokeWidth="0.8" strokeLinejoin="round" />
      <path d={CAT_INNER_R} fill={c.innerR} stroke={c.innerR} strokeWidth="0.8" strokeLinejoin="round" />
      {!ctx.retro && <ellipse {...CAT_HEAD} fill="none" stroke="#e4d9cb" strokeWidth="0.6" />}
      <PetEyes ctx={ctx} fur={c.fur} y={21.5} />
      <CatMouth line={ink(ctx, c.fur)} nose={ctx.retro ? INK : PINK} />
    </>
  );
}

function SiameseCat({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro ? { fur: "#f4e3bd", point: "#5d8a90", inner: "#8fb3b7" } : { fur: "#f3e6d3", point: "#6e4f3e", inner: "#a5776a" };
  return (
    <>
      <CatEars fur={c.point} inner={c.inner} />
      <ellipse {...CAT_HEAD} fill={c.fur} />
      <ellipse cx="20" cy="25.6" rx="6.4" ry="5.2" fill={c.point} opacity={ctx.retro ? 1 : 0.85} />
      <PetEyes
        ctx={ctx}
        fur={c.fur}
        y={21.4}
        cute={[15.2, 24.8].map((x) => (
          <g key={x}>
            <circle cx={x} cy="21.3" r="2.3" fill="#5aa6e6" />
            <circle cx={x} cy="21.4" r="1.1" fill={FEAT} />
            <circle cx={x + 0.8} cy="20.5" r="0.55" fill="#fff" />
          </g>
        ))}
      />
      <CatMouth line={ctx.retro ? INK_ON_DARK : "#f3e6d3"} nose={ctx.retro ? INK : "#3a2a24"} />
    </>
  );
}

function WhiteCat({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro ? { fur: "#e9efe8", inner: "#f5b98a", outline: "#c9d6cf" } : { fur: "#fdfbf8", inner: "#f6b3bf", outline: "#ddd3c6" };
  return (
    <>
      <path d={CAT_EARS} fill={c.fur} stroke={c.fur} strokeWidth="1.6" strokeLinejoin="round" />
      <path d={CAT_EARS} fill="none" stroke={c.outline} strokeWidth="0.6" strokeLinejoin="round" />
      <ellipse {...CAT_HEAD} fill={c.fur} stroke={c.outline} strokeWidth="0.6" />
      <path d={`${CAT_INNER_L}${CAT_INNER_R}`} fill={c.inner} stroke={c.inner} strokeWidth="0.8" strokeLinejoin="round" />
      <PetEyes
        ctx={ctx}
        fur={c.fur}
        y={21.4}
        cute={
          <>
            <Blush />
            {/* odd eyes: one blue, one amber */}
            <circle cx="15.2" cy="21.4" r="2.2" fill="#5aa6e6" />
            <circle cx="24.8" cy="21.4" r="2.2" fill="#e8b23c" />
            <circle cx="15.2" cy="21.5" r="1.1" fill={FEAT} />
            <circle cx="24.8" cy="21.5" r="1.1" fill={FEAT} />
            <circle cx="16" cy="20.6" r="0.55" fill="#fff" />
            <circle cx="25.6" cy="20.6" r="0.55" fill="#fff" />
          </>
        }
      />
      <CatMouth line={ink(ctx, c.fur)} nose={ctx.retro ? INK : PINK} />
    </>
  );
}

/* ---------- dogs ---------- */

function DogNose({ ctx, y = 25.4, rx = 2.5, ry = 1.85 }: { ctx: Ctx; y?: number; rx?: number; ry?: number }) {
  return (
    <>
      <ellipse cx="20" cy={y} rx={rx} ry={ry} fill={ctx.retro ? INK : FEAT} />
      {!ctx.retro && <ellipse cx="19.2" cy={y - ry * 0.45} rx={rx * 0.35} ry={ry * 0.28} fill="#fff" opacity="0.7" />}
    </>
  );
}

function DogMouth({ ctx, y = 27.4, tongue = false, line }: { ctx: Ctx; y?: number; tongue?: boolean; line: string }) {
  return (
    <>
      {tongue && <path d={`M18.6 ${y + 0.6}h2.8v1.6a1.4 1.4 0 0 1-2.8 0z`} fill={ctx.retro ? RETRO_TONGUE : PINK} />}
      <path
        d={`M20 ${y - 0.6}v1.1M17.7 ${y + 0.5}q1.15 1.1 2.3 0q1.15 1.1 2.3 0`}
        fill="none"
        stroke={line}
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

/* A cloud of circles around an ellipse: the doodle's curly coat. */
function Fluff({ cx, cy, rx, ry, bumps, r, fill }: { cx: number; cy: number; rx: number; ry: number; bumps: number; r: number; fill: string }) {
  return (
    <g fill={fill}>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} />
      {Array.from({ length: bumps }, (_, k) => {
        const a = (Math.PI * 2 * k) / bumps;
        return <circle key={k} cx={cx + rx * Math.cos(a)} cy={cy + ry * Math.sin(a)} r={r} />;
      })}
    </g>
  );
}

function Doodle({ ctx, coat, ear, muzzle, tongue = false }: { ctx: Ctx; coat: string; ear: string; muzzle: string; tongue?: boolean }) {
  return (
    <>
      {/* floppy fluffy ears */}
      <Fluff cx={8.2} cy={25} rx={3.4} ry={6.2} bumps={9} r={2.3} fill={ear} />
      <Fluff cx={31.8} cy={25} rx={3.4} ry={6.2} bumps={9} r={2.3} fill={ear} />
      {/* head and top tuft */}
      <Fluff cx={20} cy={21.5} rx={10} ry={9.6} bumps={14} r={2.8} fill={coat} />
      <circle cx="16.6" cy="10.4" r="2.6" fill={coat} />
      <circle cx="20.4" cy="9.2" r="2.9" fill={coat} />
      <circle cx="23.8" cy="10.8" r="2.4" fill={coat} />
      <Fluff cx={20} cy={26.8} rx={5} ry={3.6} bumps={10} r={1.6} fill={muzzle} />
      <PetEyes
        ctx={ctx}
        fur={coat}
        y={20.8}
        gap={9.4}
        cute={
          <>
            <Blush y={25} gap={16} />
            <DotEyes y={20.8} gap={9.4} r={2.25} />
          </>
        }
      />
      <DogNose ctx={ctx} y={24.9} rx={2.7} ry={2} />
      <DogMouth ctx={ctx} y={27.6} tongue={tongue} line={ink(ctx, muzzle)} />
    </>
  );
}

function CreamDoodle({ ctx }: { ctx: Ctx }) {
  return ctx.retro ? (
    <Doodle ctx={ctx} coat="#f4c75a" ear="#e29a3a" muzzle="#f9e2a6" />
  ) : (
    <Doodle ctx={ctx} coat="#f3dcb2" ear="#e2b67e" muzzle="#fbf0dc" />
  );
}

function ApricotDoodle({ ctx }: { ctx: Ctx }) {
  return ctx.retro ? (
    <Doodle ctx={ctx} coat="#f09a5b" ear="#d26f2c" muzzle="#f8cba3" tongue />
  ) : (
    <Doodle ctx={ctx} coat="#e9b67c" ear="#c98a4c" muzzle="#f7dcb6" tongue />
  );
}

function Shiba({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro ? { fur: "#9dbe8c", inner: "#cfe0c4", cream: "#f4ecd6" } : { fur: "#ea9a4a", inner: "#f7cfa3", cream: "#fdf3e6" };
  return (
    <>
      <path d="M8.5 17L9.8 6.5l7.6 6.5zM31.5 17L30.2 6.5l-7.6 6.5z" fill={c.fur} stroke={c.fur} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10.6 14.4l.8-5.2 4 3.6zM29.4 14.4l-.8-5.2-4 3.6z" fill={c.inner} />
      <ellipse cx="20" cy="22.5" rx="12.4" ry="10.8" fill={c.fur} />
      <path d="M7.9 24c2 6 6.6 9.2 12.1 9.2s10.1-3.2 12.1-9.2c-2.6 1.6-5.6 1.6-7.8 0-1.2 1.4-2.6 2-4.3 2s-3.1-.6-4.3-2c-2.2 1.6-5.2 1.6-7.8 0z" fill={c.cream} />
      {!ctx.retro && (
        <>
          <circle cx="15.4" cy="17.6" r="0.9" fill={c.cream} />
          <circle cx="24.6" cy="17.6" r="0.9" fill={c.cream} />
        </>
      )}
      <PetEyes
        ctx={ctx}
        fur={c.fur}
        y={21.2}
        gap={9.4}
        cute={
          <>
            <Blush y={26} gap={16} />
            <DotEyes y={21.2} gap={9.4} r={1.9} />
          </>
        }
      />
      <DogNose ctx={ctx} y={25.4} rx={2.1} ry={1.5} />
      <DogMouth ctx={ctx} y={27.6} line={ink(ctx, c.cream)} />
    </>
  );
}

function Beagle({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro
    ? { head: "#cfdcd6", cap: "#e8803a", patch: "#f5b98a", ear: "#c4632a" }
    : { head: "#fbf4ea", cap: "#c4813f", patch: "#e6b787", ear: "#b06c35" };
  return (
    <>
      <ellipse cx="20" cy="22" rx="11.4" ry="11.4" fill={c.head} />
      <path d="M12.5 14.8c2-4.4 13-4.4 15 0-2 2-4.2 2.6-7.5 2.6s-5.5-.6-7.5-2.6z" fill={c.cap} />
      <ellipse cx="24.8" cy="21.2" rx="3.6" ry="3.2" fill={c.patch} />
      {/* long floppy ears */}
      <path d="M10.6 13.2c-5.2.6-7 9.2-5.4 15.2.9 3.2 3.8 3.6 5.3 1.4 1.6-3.2 2.2-10.2.1-16.6z" fill={c.ear} />
      <path d="M29.4 13.2c5.2.6 7 9.2 5.4 15.2-.9 3.2-3.8 3.6-5.3 1.4-1.6-3.2-2.2-10.2-.1-16.6z" fill={c.ear} />
      <PetEyes
        ctx={ctx}
        fur={c.head}
        y={21.2}
        cute={
          <>
            <Blush y={26} gap={15} />
            <DotEyes y={21.2} gap={9.6} r={2} />
          </>
        }
      />
      <DogNose ctx={ctx} y={25.4} />
      <DogMouth ctx={ctx} y={27.6} tongue line={ink(ctx, c.head)} />
    </>
  );
}

function Pug({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro ? { fur: "#f4c75a", ear: "#3d3a3a", mask: "#3d3a3a" } : { fur: "#ead0a4", ear: "#3b302b", mask: "#3d322d" };
  return (
    <>
      <ellipse cx="20" cy="22" rx="12" ry="11" fill={c.fur} />
      <path d="M8.4 15.6l6.4-4.4.2 6.4zM31.6 15.6l-6.4-4.4-.2 6.4z" fill={c.ear} stroke={c.ear} strokeWidth="1.2" strokeLinejoin="round" />
      {!ctx.retro && (
        <g stroke="#c9a874" strokeWidth="0.9" strokeLinecap="round" fill="none">
          <path d="M17 14.6q3-1.2 6 0M17.8 16.4q2.2-.8 4.4 0" />
        </g>
      )}
      <ellipse cx="20" cy="26.4" rx="6.6" ry="5.4" fill={c.mask} />
      <PetEyes ctx={ctx} fur={c.fur} y={20.6} gap={10.4} cute={<DotEyes y={20.6} gap={10.4} r={2.4} />} />
      <ellipse cx="20" cy="24.6" rx="2.2" ry="1.5" fill={ctx.retro ? INK_ON_DARK : "#15100e"} />
      <DogMouth ctx={ctx} y={27.6} tongue line={ctx.retro ? INK_ON_DARK : "#a08a7c"} />
    </>
  );
}

function Corgi({ ctx }: { ctx: Ctx }) {
  const c = ctx.retro ? { fur: "#e8803a", inner: "#f5b98a", blaze: "#f4ecd6" } : { fur: "#eb9447", inner: "#f7c2a6", blaze: "#fdf3e6" };
  return (
    <>
      <path d="M8 18.5L8.6 3.8l9.2 8.4zM32 18.5L31.4 3.8l-9.2 8.4z" fill={c.fur} stroke={c.fur} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10.2 15.4l.4-8.4 5 4.6zM29.8 15.4l-.4-8.4-5 4.6z" fill={c.inner} />
      <ellipse cx="20" cy="22.5" rx="12.2" ry="10.8" fill={c.fur} />
      <path d="M18.4 11.9c.6 3 .8 6-.2 8.8-2.6 1-4.8 3-5.6 6 1.4 4 4.2 6.2 7.4 6.2s6-2.2 7.4-6.2c-.8-3-3-5-5.6-6-1-2.8-.8-5.8-.2-8.8z" fill={c.blaze} />
      <PetEyes
        ctx={ctx}
        fur={c.fur}
        y={21.4}
        gap={10}
        cute={
          <>
            <Blush y={26} gap={16} />
            <DotEyes y={21.4} gap={10} r={2} />
          </>
        }
      />
      <DogNose ctx={ctx} y={25.3} rx={2.3} ry={1.7} />
      <DogMouth ctx={ctx} y={27.6} line={ink(ctx, c.blaze)} />
    </>
  );
}

/* Interleaved dog / cat so neighbouring entries differ. */
const PETS: ((ctx: Ctx) => ReactNode)[] = [
  (ctx) => <CreamDoodle ctx={ctx} />,
  (ctx) => <OrangeTabby ctx={ctx} />,
  (ctx) => <Shiba ctx={ctx} />,
  (ctx) => <BlueGrayCat ctx={ctx} />,
  (ctx) => <Beagle ctx={ctx} />,
  (ctx) => <BlackCat ctx={ctx} />,
  (ctx) => <Pug ctx={ctx} />,
  (ctx) => <CalicoCat ctx={ctx} />,
  (ctx) => <Corgi ctx={ctx} />,
  (ctx) => <SiameseCat ctx={ctx} />,
  (ctx) => <ApricotDoodle ctx={ctx} />,
  (ctx) => <WhiteCat ctx={ctx} />,
];

export const PET_COUNT = PETS.length;

export function renderPet(index: number, style: PetStyle, id: string): ReactNode {
  return PETS[index]({ retro: style === "retro", expr: RETRO_EXPRESSIONS[index % RETRO_EXPRESSIONS.length], id });
}
