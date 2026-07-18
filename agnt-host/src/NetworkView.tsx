import type { AppStatus, NetworkInterface, View } from "./host-types";

export function NetworkView({
  networks,
  status,
  setView,
  onSelectNetwork,
}: {
  networks: NetworkInterface[];
  status: AppStatus;
  setView: (view: View) => void;
  onSelectNetwork: (ip: string) => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: "var(--bg-surface)",
        borderRadius: "7px",
        border: "1px solid var(--border-color)",
        padding: "12px",
        overflow: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
          Choose Network
        </div>
        <button
          onClick={() => setView("dashboard")}
          style={{
            fontSize: "10px",
            color: "var(--text-secondary)",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          Back
        </button>
      </div>
      <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginBottom: "10px" }}>
        Select the network your phone is connected to.
      </div>
      {networks.length === 0 ? (
        <div style={{ textAlign: "center", padding: "20px", color: "var(--text-secondary)", fontSize: "11px" }}>
          No networks detected. Connect to Wi-Fi or Ethernet.
        </div>
      ) : (
        networks.map((nic, i) => (
          <div
            key={i}
            onClick={() => onSelectNetwork(nic.address)}
            style={{
              padding: "8px 10px",
              marginBottom: "4px",
              background: status.network === nic.address ? "var(--bg-elevated)" : "transparent",
              borderRadius: "5px",
              border: status.network === nic.address ? "1px solid var(--accent-blue)" : "1px solid transparent",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              transition: "all 0.1s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ fontSize: "11px", color: "var(--text-primary)", fontWeight: 500 }}>
                {nic.name}
              </div>
              {nic.is_private && (
                <span
                  style={{
                    fontSize: "9px",
                    padding: "1px 5px",
                    background: "#35C75920",
                    color: "#35C759",
                    borderRadius: "3px",
                    fontWeight: 600,
                  }}
                >
                  RECOMMENDED
                </span>
              )}
              <span
                style={{
                  fontSize: "9px",
                  padding: "1px 5px",
                  background: "var(--bg-primary)",
                  color: "var(--text-secondary)",
                  borderRadius: "3px",
                }}
              >
                {nic.kind}
              </span>
            </div>
            <span
              style={{
                fontSize: "11px",
                fontFamily: "monospace",
                color: status.network === nic.address ? "var(--accent-blue)" : "var(--text-secondary)",
              }}
            >
              {nic.address}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
