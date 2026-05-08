export function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="agnt-loading-screen">
      <div className="agnt-spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
