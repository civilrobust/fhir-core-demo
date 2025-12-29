import { useEffect, useMemo, useState } from "react";
import "./App.css";

const FHIR_BASE = "https://hapi.fhir.org/baseR4";

function getHumanName(nameArr) {
  if (!Array.isArray(nameArr) || nameArr.length === 0) return "Unnamed";
  const n = nameArr[0];
  const given = Array.isArray(n.given) ? n.given.join(" ") : "";
  const family = n.family || "";
  return `${given} ${family}`.trim() || "Unnamed";
}

function getFirstTelecom(telecomArr, system) {
  if (!Array.isArray(telecomArr)) return "";
  const match = telecomArr.find((t) => t?.system === system && t?.value);
  return match?.value || "";
}

export default function App() {
  const [q, setQ] = useState("smith");
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [bundle, setBundle] = useState(null);

  const patients = useMemo(() => {
    const entries = bundle?.entry || [];
    return entries
      .map((e) => e.resource)
      .filter((r) => r && r.resourceType === "Patient");
  }, [bundle]);

  async function searchPatients() {
    setLoading(true);
    setError("");
    setBundle(null);

    try {
      const url = new URL(`${FHIR_BASE}/Patient`);
      url.searchParams.set("_count", String(count));
      if (q.trim()) url.searchParams.set("name", q.trim());

      const res = await fetch(url.toString(), {
        headers: { Accept: "application/fhir+json" },
      });

      if (!res.ok) {
        throw new Error(`FHIR request failed (${res.status})`);
      }

      const data = await res.json();
      if (data?.resourceType !== "Bundle") {
        throw new Error("Unexpected response (not a FHIR Bundle).");
      }
      setBundle(data);
    } catch (e) {
      setError(e?.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    searchPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 20 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ margin: 0 }}>FHIR Demo (React + Vite)</h1>
        <span style={{ opacity: 0.7 }}>
          Public test server: <code>{FHIR_BASE}</code>
        </span>
      </header>

      <p style={{ marginTop: 8, opacity: 0.8 }}>
        This pulls <code>Patient</code> resources using a FHIR REST call and renders a
        minimal “patient list” UI.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 140px 140px",
          gap: 10,
          alignItems: "center",
          marginTop: 16,
          padding: 12,
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 12,
        }}
      >
        <div>
          <label style={{ display: "block", fontSize: 12, opacity: 0.7 }}>
            Name contains
          </label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. smith"
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(255,255,255,0.06)",
              color: "inherit",
            }}
          />
        </div>

        <div>
          <label style={{ display: "block", fontSize: 12, opacity: 0.7 }}>
            Count
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(255,255,255,0.06)",
              color: "inherit",
            }}
          />
        </div>

        <button
          onClick={searchPatients}
          disabled={loading}
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.18)",
            background: loading ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.12)",
            color: "inherit",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Loading…" : "Search"}
        </button>
      </div>

      {error && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(255,80,80,0.35)",
            background: "rgba(255,80,80,0.10)",
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      <section style={{ marginTop: 18 }}>
        <h2 style={{ marginBottom: 8 }}>Results</h2>

        <div
          style={{
            display: "grid",
            gap: 10,
          }}
        >
          {patients.map((p) => {
            const name = getHumanName(p.name);
            const gender = p.gender || "unknown";
            const dob = p.birthDate || "—";
            const nhsLikeId =
              (p.identifier || []).find((id) => (id?.system || "").toLowerCase().includes("nhs"))?.value ||
              (p.identifier || [])[0]?.value ||
              "—";
            const phone = getFirstTelecom(p.telecom, "phone");
            const email = getFirstTelecom(p.telecom, "email");

            return (
              <div
                key={p.id}
                style={{
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{name}</div>
                    <div style={{ opacity: 0.75, marginTop: 2 }}>
                      <code>Patient/{p.id}</code>
                    </div>
                  </div>

                  <div style={{ textAlign: "right", opacity: 0.8 }}>
                    <div>
                      {gender} • {dob}
                    </div>
                    <div style={{ marginTop: 2 }}>
                      <span style={{ opacity: 0.7 }}>Identifier:</span> {nhsLikeId}
                    </div>
                  </div>
                </div>

                {(phone || email) && (
                  <div style={{ marginTop: 10, opacity: 0.85 }}>
                    {phone && (
                      <span style={{ marginRight: 12 }}>
                        📞 <span style={{ opacity: 0.7 }}>Phone:</span> {phone}
                      </span>
                    )}
                    {email && (
                      <span>
                        ✉️ <span style={{ opacity: 0.7 }}>Email:</span> {email}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {!loading && patients.length === 0 && !error && (
            <div style={{ opacity: 0.75 }}>No patients returned.</div>
          )}
        </div>
      </section>

      <footer style={{ marginTop: 24, opacity: 0.65, fontSize: 12 }}>
        Next: we’ll add “patient details” (Observations / vitals) + an AI summary panel.
      </footer>
    </div>
  );
}
