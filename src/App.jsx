import React, { useEffect, useMemo, useState } from "react";

/**
 * FHIR = Fast Healthcare Interoperability Resources
 * HL7 = Health Level Seven
 *
 * Demo server (public): HAPI FHIR R4
 */
const FHIR_BASE = "https://hapi.fhir.org/baseR4";

function safeText(x) {
  return typeof x === "string" ? x : "";
}

function pickPatientName(patient) {
  const n = patient?.name?.[0];
  if (!n) return "Unnamed patient";
  if (n.text) return n.text;
  const given = Array.isArray(n.given) ? n.given.join(" ") : "";
  const family = n.family ? String(n.family) : "";
  return `${given} ${family}`.trim() || "Unnamed patient";
}

function pickPhone(patient) {
  const t = (patient?.telecom || []).find((x) => x?.system === "phone");
  return t?.value ? String(t.value) : "—";
}

function pickIdentifier(patient) {
  const id = patient?.identifier?.[0]?.value;
  return id ? String(id) : "—";
}

function pickGender(patient) {
  return patient?.gender ? String(patient.gender) : "—";
}

function pickBirthDate(patient) {
  return patient?.birthDate ? String(patient.birthDate) : "—";
}

function formatWhen(obs) {
  const dt =
    obs?.effectiveDateTime ||
    obs?.effectivePeriod?.start ||
    obs?.issued ||
    "";
  if (!dt) return "—";
  // keep it simple + readable
  try {
    const d = new Date(dt);
    if (Number.isNaN(d.getTime())) return String(dt);
    return d.toLocaleString();
  } catch {
    return String(dt);
  }
}

function getObsDisplay(obs) {
  const code = obs?.code;
  const text =
    code?.text ||
    code?.coding?.[0]?.display ||
    code?.coding?.[0]?.code ||
    "Observation";
  return String(text);
}

function getObsValueText(obs) {
  // blood pressure often arrives as components
  const comps = obs?.component;
  if (Array.isArray(comps) && comps.length) {
    const sys = comps.find((c) =>
      (c?.code?.coding || []).some((k) => k?.code === "8480-6") // Systolic
    );
    const dia = comps.find((c) =>
      (c?.code?.coding || []).some((k) => k?.code === "8462-4") // Diastolic
    );
    const sysV = sys?.valueQuantity?.value;
    const diaV = dia?.valueQuantity?.value;
    const unit =
      sys?.valueQuantity?.unit ||
      dia?.valueQuantity?.unit ||
      "mmHg";
    if (sysV != null && diaV != null) return `${sysV}/${diaV} ${unit}`;
  }

  const vq = obs?.valueQuantity;
  if (vq?.value != null) {
    const unit = vq.unit || vq.code || "";
    return `${vq.value}${unit ? " " + unit : ""}`.trim();
  }

  if (obs?.valueString) return String(obs.valueString);
  if (obs?.valueCodeableConcept?.text) return String(obs.valueCodeableConcept.text);

  return "—";
}

/**
 * Try to recognise common vital signs / labs.
 * We use a mix of well-known LOINC codes + fallback text matching (demo-friendly).
 */
function classifyObservation(obs) {
  const coding = obs?.code?.coding || [];
  const codes = new Set(coding.map((c) => String(c.code || "")));

  const text = (getObsDisplay(obs) + " " + (coding?.[0]?.display || "")).toLowerCase();

  // Blood pressure panel
  if (codes.has("85354-9") || codes.has("55284-4") || text.includes("blood pressure")) return "bp";

  // Heart rate
  if (codes.has("8867-4") || text.includes("heart rate") || text.includes("pulse")) return "hr";

  // Temperature
  if (codes.has("8310-5") || text.includes("temperature") || text.includes("temp")) return "temp";

  // Oxygen saturation
  if (codes.has("59408-5") || text.includes("oxygen saturation") || text.includes("spo2")) return "spo2";

  // Haemoglobin
  if (codes.has("718-7") || text.includes("hemoglobin") || text.includes("haemoglobin")) return "hgb";

  // Weight
  if (codes.has("29463-7") || codes.has("3141-9") || text.includes("weight")) return "wt";

  return "other";
}

function pickLatestByType(observations) {
  // Observations are fetched sorted newest-first; we pick first seen per type.
  const latest = {};
  for (const obs of observations) {
    const t = classifyObservation(obs);
    if (!latest[t]) latest[t] = obs;
  }
  return latest;
}

function aiSummaryFrom(patient, latest) {
  const name = pickPatientName(patient);
  const gender = pickGender(patient);
  const dob = pickBirthDate(patient);

  const lines = [];
  lines.push(`Patient: ${name} (gender: ${gender}, date of birth: ${dob})`);

  const vitals = [];
  if (latest.bp) vitals.push(`Blood pressure: ${getObsValueText(latest.bp)} (${formatWhen(latest.bp)})`);
  if (latest.hr) vitals.push(`Heart rate: ${getObsValueText(latest.hr)} (${formatWhen(latest.hr)})`);
  if (latest.temp) vitals.push(`Temperature: ${getObsValueText(latest.temp)} (${formatWhen(latest.temp)})`);
  if (latest.spo2) vitals.push(`Oxygen saturation: ${getObsValueText(latest.spo2)} (${formatWhen(latest.spo2)})`);
  if (latest.hgb) vitals.push(`Haemoglobin: ${getObsValueText(latest.hgb)} (${formatWhen(latest.hgb)})`);
  if (latest.wt) vitals.push(`Weight: ${getObsValueText(latest.wt)} (${formatWhen(latest.wt)})`);

  if (vitals.length) {
    lines.push("");
    lines.push("Latest observations:");
    for (const v of vitals) lines.push(`• ${v}`);
  } else {
    lines.push("");
    lines.push("Latest observations: none returned by the demo server for this patient.");
  }

  // Very simple “flags” (purely demo logic)
  const flags = [];

  // temp > 37.8
  if (latest.temp?.valueQuantity?.value != null) {
    const t = Number(latest.temp.valueQuantity.value);
    if (!Number.isNaN(t) && t >= 37.8) flags.push("Raised temperature recorded.");
  }
  // spo2 < 94
  if (latest.spo2?.valueQuantity?.value != null) {
    const s = Number(latest.spo2.valueQuantity.value);
    if (!Number.isNaN(s) && s < 94) flags.push("Low oxygen saturation recorded.");
  }
  // HR > 100
  if (latest.hr?.valueQuantity?.value != null) {
    const h = Number(latest.hr.valueQuantity.value);
    if (!Number.isNaN(h) && h > 100) flags.push("Raised heart rate recorded.");
  }

  if (flags.length) {
    lines.push("");
    lines.push("Attention flags:");
    for (const f of flags) lines.push(`• ${f}`);
  }

  lines.push("");
  lines.push("Summary generated locally for demo purposes (no external AI call).");

  return lines.join("\n");
}

const ui = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #eef5ff 0%, #ffffff 55%)",
    padding: 28,
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
    color: "#0b1b2b",
  },
  shell: {
    maxWidth: 1200,
    margin: "0 auto",
  },
  topBar: {
    borderRadius: 14,
    padding: "14px 16px",
    background: "linear-gradient(90deg, #0b63ce 0%, #1479e6 60%, #0b63ce 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    boxShadow: "0 10px 30px rgba(11, 99, 206, 0.25)",
  },
  titleRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  title: { fontSize: 16, fontWeight: 900, letterSpacing: 0.2 },
  chip: {
    background: "rgba(255,255,255,0.18)",
    border: "1px solid rgba(255,255,255,0.28)",
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
  },
  card: {
    background: "rgba(255,255,255,0.9)",
    border: "1px solid rgba(11, 27, 43, 0.10)",
    borderRadius: 16,
    boxShadow: "0 12px 28px rgba(11, 27, 43, 0.10)",
  },
  section: { marginTop: 16, padding: 18 },
  h2: { margin: 0, fontSize: 22, fontWeight: 900 },
  subtle: { opacity: 0.75, fontSize: 13, marginTop: 6 },
  pills: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(11, 27, 43, 0.12)",
    background: "white",
    fontSize: 12,
    fontWeight: 700,
  },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 },
  inputsRow: {
    display: "grid",
    gridTemplateColumns: "1.2fr 0.4fr 0.4fr",
    gap: 12,
    alignItems: "end",
    marginTop: 12,
  },
  label: { fontSize: 12, fontWeight: 800, opacity: 0.75, marginBottom: 6 },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(11, 27, 43, 0.16)",
    outline: "none",
    fontSize: 13,
    background: "white",
  },
  button: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(11, 99, 206, 0.25)",
    background: "#0b63ce",
    color: "white",
    fontWeight: 900,
    cursor: "pointer",
    boxShadow: "0 12px 20px rgba(11, 99, 206, 0.25)",
  },
  layout: { display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 14, marginTop: 14 },
  listHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 10,
  },
  listTitle: { fontWeight: 900 },
  smallCount: { fontSize: 12, opacity: 0.65 },
  patientCard: (active) => ({
    borderRadius: 14,
    border: active ? "1px solid rgba(11, 99, 206, 0.55)" : "1px solid rgba(11, 27, 43, 0.10)",
    background: active ? "rgba(11, 99, 206, 0.06)" : "white",
    padding: 14,
    marginBottom: 10,
    cursor: "pointer",
    boxShadow: active ? "0 10px 22px rgba(11, 99, 206, 0.12)" : "none",
  }),
  rowBetween: { display: "flex", justifyContent: "space-between", gap: 10 },
  patientName: { fontSize: 16, fontWeight: 900 },
  meta: { fontSize: 12, opacity: 0.7, marginTop: 2 },
  rightMeta: { textAlign: "right", fontSize: 12, opacity: 0.8 },
  vitalsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 },
  vitalCard: {
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(11, 27, 43, 0.10)",
    background: "white",
  },
  vitalLabel: { fontSize: 11, fontWeight: 900, opacity: 0.7 },
  vitalValue: { fontSize: 18, fontWeight: 950, marginTop: 4 },
  vitalWhen: { fontSize: 11, opacity: 0.6, marginTop: 4 },
  timeline: {
    marginTop: 10,
    borderRadius: 14,
    border: "1px solid rgba(11, 27, 43, 0.10)",
    background: "white",
    overflow: "hidden",
  },
  tlItem: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 12px",
    borderTop: "1px solid rgba(11, 27, 43, 0.06)",
  },
  tlLeft: { fontSize: 12, fontWeight: 800 },
  tlSub: { fontSize: 11, opacity: 0.6, marginTop: 2 },
  tlRight: { fontSize: 12, fontWeight: 900, whiteSpace: "nowrap" },
  aiBox: {
    marginTop: 12,
    borderRadius: 14,
    border: "1px solid rgba(11, 27, 43, 0.10)",
    background: "white",
    padding: 12,
  },
  aiText: {
    marginTop: 10,
    whiteSpace: "pre-wrap",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.45,
    borderRadius: 12,
    border: "1px solid rgba(11, 27, 43, 0.10)",
    padding: 10,
    background: "rgba(11,99,206,0.03)",
    maxHeight: 220,
    overflow: "auto",
  },
};

export default function App() {
  const [query, setQuery] = useState("smith");
  const [count, setCount] = useState(10);

  const [loadingPatients, setLoadingPatients] = useState(false);
  const [patients, setPatients] = useState([]);
  const [errorPatients, setErrorPatients] = useState("");

  const [selectedPatient, setSelectedPatient] = useState(null);
  const [loadingObs, setLoadingObs] = useState(false);
  const [observations, setObservations] = useState([]);
  const [errorObs, setErrorObs] = useState("");

  const [aiSummary, setAiSummary] = useState("");

  async function searchPatients() {
    setLoadingPatients(true);
    setErrorPatients("");
    setAiSummary("");
    try {
      const url = `${FHIR_BASE}/Patient?name=${encodeURIComponent(query)}&_count=${encodeURIComponent(
        String(count || 10)
      )}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Patient search failed (${res.status})`);
      const bundle = await res.json();
      const list = (bundle?.entry || []).map((e) => e.resource).filter(Boolean);
      setPatients(list);

      if (list.length) {
        setSelectedPatient(list[0]);
      } else {
        setSelectedPatient(null);
        setObservations([]);
      }
    } catch (e) {
      setErrorPatients(e?.message || "Failed to search patients.");
      setPatients([]);
      setSelectedPatient(null);
      setObservations([]);
    } finally {
      setLoadingPatients(false);
    }
  }

  async function fetchObservationsForPatient(patient) {
    if (!patient?.id) return;
    setLoadingObs(true);
    setErrorObs("");
    setAiSummary("");
    try {
      // Try patient= first (common); if empty, fallback to subject=Patient/{id}
      const url1 = `${FHIR_BASE}/Observation?patient=${encodeURIComponent(
        patient.id
      )}&_sort=-date&_count=50`;
      const res1 = await fetch(url1);
      if (!res1.ok) throw new Error(`Observation fetch failed (${res1.status})`);
      const bundle1 = await res1.json();
      let obs = (bundle1?.entry || []).map((e) => e.resource).filter(Boolean);

      if (!obs.length) {
        const url2 = `${FHIR_BASE}/Observation?subject=Patient/${encodeURIComponent(
          patient.id
        )}&_sort=-date&_count=50`;
        const res2 = await fetch(url2);
        if (res2.ok) {
          const bundle2 = await res2.json();
          obs = (bundle2?.entry || []).map((e) => e.resource).filter(Boolean);
        }
      }

      setObservations(obs);
    } catch (e) {
      setErrorObs(e?.message || "Failed to fetch observations.");
      setObservations([]);
    } finally {
      setLoadingObs(false);
    }
  }

  useEffect(() => {
    // initial load
    searchPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // load observations when selection changes
    if (selectedPatient?.id) fetchObservationsForPatient(selectedPatient);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatient?.id]);

  const latest = useMemo(() => pickLatestByType(observations), [observations]);

  function VitalCard({ label, obs }) {
    return (
      <div style={ui.vitalCard}>
        <div style={ui.vitalLabel}>{label}</div>
        <div style={ui.vitalValue}>{obs ? getObsValueText(obs) : "—"}</div>
        <div style={ui.vitalWhen}>{obs ? formatWhen(obs) : "—"}</div>
      </div>
    );
  }

  function onSelect(p) {
    setSelectedPatient(p);
  }

  function onGenerateSummary() {
    if (!selectedPatient) return;
    const text = aiSummaryFrom(selectedPatient, latest);
    setAiSummary(text);
  }

  return (
    <div style={ui.page}>
      <div style={ui.shell}>
        <div style={ui.topBar}>
          <div style={ui.titleRow}>
            <div style={ui.title}>Clinical FHIR Integration Demo</div>
            <span style={ui.chip}>React + Vite</span>
            <span style={ui.chip}>FHIR R4 (Release 4)</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.95, fontWeight: 800 }}>
            Test server:{" "}
            <span style={{ textDecoration: "underline" }}>
              {FHIR_BASE}
            </span>
          </div>
        </div>

        <section style={{ ...ui.card, ...ui.section }}>
          <div style={{ textAlign: "center" }}>
            <h2 style={ui.h2}>Patient search</h2>
            <div style={ui.subtle}>
              Live FHIR REST calls returning FHIR JSON bundles, rendered into a clinical-style interface.
            </div>

            <div style={ui.pills}>
              <span style={ui.pill}>✅ Public demo data</span>
              <span style={ui.pill}>📎 Standards-based integration</span>
              <span style={ui.pill}>☁️ Deployed on Cloudflare Pages</span>
            </div>
          </div>

          <div style={ui.inputsRow}>
            <div>
              <div style={ui.label}>Name contains</div>
              <input
                style={ui.input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. smith"
              />
            </div>

            <div>
              <div style={ui.label}>Count</div>
              <input
                style={ui.input}
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Number(e.target.value || 10))}
              />
            </div>

            <div>
              <div style={ui.label}>&nbsp;</div>
              <button style={ui.button} onClick={searchPatients} disabled={loadingPatients}>
                {loadingPatients ? "Searching…" : "Search"}
              </button>
            </div>
          </div>

          {(errorPatients || errorObs) && (
            <div style={{ marginTop: 12, color: "#8a0000", fontWeight: 800 }}>
              {safeText(errorPatients || errorObs)}
            </div>
          )}

          <div style={ui.layout}>
            {/* LEFT: Results */}
            <div style={{ ...ui.card, padding: 14 }}>
              <div style={ui.listHeader}>
                <div style={ui.listTitle}>Results</div>
                <div style={ui.smallCount}>
                  {patients.length} patient{patients.length === 1 ? "" : "s"}
                </div>
              </div>

              {patients.map((p) => {
                const active = selectedPatient?.id === p.id;
                return (
                  <div key={p.id} style={ui.patientCard(active)} onClick={() => onSelect(p)}>
                    <div style={ui.rowBetween}>
                      <div>
                        <div style={ui.patientName}>{pickPatientName(p)}</div>
                        <div style={ui.meta}>Patient/{p.id}</div>
                        <div style={{ ...ui.meta, marginTop: 6 }}>📞 Phone: {pickPhone(p)}</div>
                      </div>

                      <div style={ui.rightMeta}>
                        <div style={{ fontWeight: 900 }}>
                          {p.gender || "unknown"} • {p.birthDate || "—"}
                        </div>
                        <div style={{ marginTop: 4, opacity: 0.7 }}>
                          Identifier: {pickIdentifier(p)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {!loadingPatients && patients.length === 0 && (
                <div style={{ opacity: 0.75 }}>No patients returned.</div>
              )}
            </div>

            {/* RIGHT: Patient details */}
            <div style={{ ...ui.card, padding: 14 }}>
              <div style={{ textAlign: "center", fontWeight: 900 }}>Patient details</div>

              {!selectedPatient ? (
                <div style={{ marginTop: 12, opacity: 0.75, textAlign: "center" }}>
                  Select a patient from the results.
                </div>
              ) : (
                <>
                  <div style={{ textAlign: "center", marginTop: 8 }}>
                    <div style={{ fontSize: 18, fontWeight: 950 }}>
                      {pickPatientName(selectedPatient)}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                      Patient/{selectedPatient.id}
                    </div>
                  </div>

                  <div style={ui.grid2}>
                    <div style={ui.pill}>
                      <span style={{ opacity: 0.7 }}>Gender</span>
                      <span style={{ fontWeight: 950 }}>{pickGender(selectedPatient)}</span>
                    </div>
                    <div style={ui.pill}>
                      <span style={{ opacity: 0.7 }}>Date of birth</span>
                      <span style={{ fontWeight: 950 }}>{pickBirthDate(selectedPatient)}</span>
                    </div>
                  </div>

                  <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between" }}>
                    <div style={{ fontWeight: 900 }}>Observations (vitals / labs)</div>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>
                      {loadingObs ? "Loading…" : `${observations.length} items`}
                    </div>
                  </div>

                  <div style={ui.vitalsGrid}>
                    <VitalCard label="Blood pressure" obs={latest.bp} />
                    <VitalCard label="Heart rate" obs={latest.hr} />
                    <VitalCard label="Temperature" obs={latest.temp} />
                    <VitalCard label="Oxygen saturation" obs={latest.spo2} />
                  </div>

                  <div style={{ marginTop: 12, fontWeight: 900, textAlign: "center" }}>
                    Recent timeline
                  </div>

                  <div style={ui.timeline}>
                    {observations.slice(0, 8).map((o) => (
                      <div key={o.id} style={ui.tlItem}>
                        <div style={{ minWidth: 0 }}>
                          <div style={ui.tlLeft}>{getObsDisplay(o)}</div>
                          <div style={ui.tlSub}>{formatWhen(o)}</div>
                        </div>
                        <div style={ui.tlRight}>{getObsValueText(o)}</div>
                      </div>
                    ))}

                    {observations.length === 0 && (
                      <div style={{ padding: 12, opacity: 0.75 }}>
                        No observations returned for this patient.
                      </div>
                    )}
                  </div>

                  {/* AI Summary Panel */}
                  <div style={ui.aiBox}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <div style={{ fontWeight: 950 }}>AI summary (demo)</div>
                      <button
                        style={{
                          ...ui.button,
                          padding: "8px 12px",
                          borderRadius: 10,
                          boxShadow: "0 10px 16px rgba(11, 99, 206, 0.18)",
                        }}
                        onClick={onGenerateSummary}
                        disabled={!selectedPatient}
                      >
                        Generate summary
                      </button>
                    </div>

                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
                      Generates a short “clinical note” from patient demographics + latest observations.
                    </div>

                    {aiSummary ? (
                      <div style={ui.aiText}>{aiSummary}</div>
                    ) : (
                      <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
                        Click <b>Generate summary</b> to produce a narrative.
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        <footer style={{ marginTop: 14, opacity: 0.65, fontSize: 12, textAlign: "center" }}>
          Tip: after you <b>git push</b>, Cloudflare Pages will rebuild automatically if this repo is connected.
        </footer>
      </div>
    </div>
  );
}
