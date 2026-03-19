/**
 * LocaleSwitcher — Accessible locale/language switcher
 *
 * - Updates cookie persistence
 * - Updates React i18n context
 * - Sets html[lang] attribute
 * - Preserves current route (no full reload)
 * - Accessible: uses native <select> with label (keyboard + screen reader safe)
 */

import { SUPPORTED_LOCALES, LOCALE_METADATA, type Locale } from "@/lib/i18n/config";
import { useLocale } from "@/hooks/use-translations";
import { cn } from "@/lib/utils";
import { Globe } from "lucide-react";

interface LocaleSwitcherProps {
  className?: string;
  showLabel?: boolean;
  variant?: "minimal" | "full";
}

export function LocaleSwitcher({
  className,
  showLabel = false,
  variant = "minimal",
}: LocaleSwitcherProps) {
  const { locale, setLocale } = useLocale();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLocale = e.target.value as Locale;
    setLocale(newLocale);
  };

  if (variant === "full") {
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        {showLabel && (
          <label
            htmlFor="locale-switcher"
            className="text-xs font-medium text-muted-foreground"
          >
            Language
          </label>
        )}
        <div className="relative inline-flex items-center">
          <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <select
            id="locale-switcher"
            value={locale}
            onChange={handleChange}
            aria-label="Select language"
            data-testid="select-locale"
            className={cn(
              "appearance-none pl-7 pr-6 py-1.5 text-sm rounded-md border border-border",
              "bg-background text-foreground",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
              "cursor-pointer hover:border-muted-foreground/60 transition-colors"
            )}
          >
            {SUPPORTED_LOCALES.map(loc => {
              const meta = LOCALE_METADATA[loc];
              return (
                <option key={loc} value={loc} data-testid={`option-locale-${loc}`}>
                  {meta.flag} {meta.nativeName}
                </option>
              );
            })}
          </select>
          <span className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground text-xs">
            ▾
          </span>
        </div>
      </div>
    );
  }

  // Minimal variant: compact inline switcher
  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <Globe className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/60 pointer-events-none" />
      <select
        id="locale-switcher-minimal"
        value={locale}
        onChange={handleChange}
        aria-label="Select language"
        data-testid="select-locale-minimal"
        className={cn(
          "appearance-none pl-5 pr-3 py-1 text-xs rounded border border-transparent",
          "bg-transparent text-muted-foreground",
          "focus:outline-none focus:ring-1 focus:ring-ring",
          "cursor-pointer hover:text-foreground hover:border-border transition-colors"
        )}
      >
        {SUPPORTED_LOCALES.map(loc => {
          const meta = LOCALE_METADATA[loc];
          return (
            <option key={loc} value={loc} data-testid={`option-locale-minimal-${loc}`}>
              {meta.flag} {meta.code.toUpperCase()}
            </option>
          );
        })}
      </select>
    </div>
  );
}
