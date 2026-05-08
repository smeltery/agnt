import { useNoticesStore } from "../../state/notices-store";

export function NoticeStack() {
  const notices = useNoticesStore((state) => state.notices);
  const dismiss = useNoticesStore((state) => state.dismiss);
  if (notices.length === 0) return null;
  return (
    <div className="agnt-notice-stack" role="region" aria-label="Notifications">
      {notices.map((notice) => (
        <div key={notice.id} className={"agnt-notice agnt-notice-" + notice.severity}>
          <div className="agnt-notice-text">
            {notice.title && <strong>{notice.title}</strong>}
            {notice.message && <span>{notice.message}</span>}
          </div>
          <button type="button" className="agnt-notice-close" onClick={() => dismiss(notice.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
