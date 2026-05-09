// Lightweight loading + empty-state primitives. These are deliberately
// dumb: pure presentational React, no store reads, no imperative effects.
// Pages compose them when they know they need a placeholder.

import type { ReactNode } from "react";

/** A single shimmer row sized to fill a sidebar thread slot. Use the count
 *  prop to render N of them while waiting for `thread/list` to land. */
export function SidebarSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="agnt-sidebar-list" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <li key={index} className="agnt-skeleton-row">
          <div
            className={
              "agnt-skeleton agnt-skeleton-line " +
              (index % 3 === 0
                ? "agnt-skeleton-line-medium"
                : index % 3 === 1
                  ? "agnt-skeleton-line-full"
                  : "agnt-skeleton-line-short")
            }
          />
          <div className="agnt-skeleton agnt-skeleton-line agnt-skeleton-line-short" />
        </li>
      ))}
    </ul>
  );
}

/** Centered icon + heading + body for the "nothing here" state. The icon
 *  can be any ReactNode — typically one from `components/shared/Icon`. */
export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="agnt-empty-state" role="status">
      {icon && <div className="agnt-empty-state-icon" aria-hidden>{icon}</div>}
      <h2 className="agnt-empty-state-title">{title}</h2>
      {message && <p className="agnt-empty-state-message">{message}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
