import type { ReactNode } from "react";

/**
 * The body of one Settings page (below the shared "Settings" heading and tabs rendered by
 * `src/app/(dashboard)/settings/layout.tsx`): an `h2` title, a short description, then content.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby="settings-section-title" className="flex flex-col gap-5">
      <div>
        <h2 id="settings-section-title" className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
