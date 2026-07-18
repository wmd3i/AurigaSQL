import { AurigaMascotIcon } from "./AurigaMascotIcon";
import { cn } from "../../lib/cn";

export function HomeHero(props: { compact?: boolean; variant?: "default" | "top" }) {
  const top = props.variant === "top";

  return (
    <div
      className={cn(
        "text-center transition-all duration-300 ease-out",
        props.compact ? "translate-y-[-4px]" : "translate-y-0",
      )}
    >
      <div
        className={cn(
          "mx-auto flex items-center justify-center rounded-full bg-accent-soft shadow-[0_14px_34px_rgba(20,126,116,0.12)] transition-all duration-300 ease-out",
          props.compact ? "mb-0 h-14 w-14" : top ? "mb-3 h-16 w-16" : "mb-5 h-20 w-20",
        )}
      >
        <AurigaMascotIcon
          className={cn(
            "transition-all duration-300 ease-out",
            props.compact ? "h-11 w-11" : top ? "h-12 w-12" : "h-16 w-16",
          )}
        />
      </div>
      <div className="relative">
        <h1
          className={cn(
            "relative z-10 overflow-hidden font-semibold tracking-tight text-ink transition-all duration-300 ease-out",
            top ? "text-3xl sm:text-4xl" : "text-4xl sm:text-5xl",
            props.compact ? "max-h-0 pb-0 opacity-0" : "max-h-24 pb-2 opacity-100",
          )}
        >
          Hi, I&apos;m <span className="text-accent">Auriga</span>
          <span className="text-ink">SQL</span>
        </h1>
        <p
          className={cn(
            "relative z-0 mx-auto max-w-xl overflow-hidden leading-7 text-muted transition-all duration-300 ease-out",
            top ? "text-[14px]" : "text-[16px]",
            props.compact ? "mt-0 max-h-0 opacity-0" : "mt-1 max-h-10 opacity-100",
          )}
        >
          Ask your data. Shape the answer.
        </p>
      </div>
    </div>
  );
}
