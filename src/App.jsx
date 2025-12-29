import { useEffect, useMemo, useState } from "react";
import "./App.css";

const FHIR_BASE = "https://hapi.fhir.org/baseR4";

/** ---------- tiny helpers ---------- */
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function getHumanName(nameArr) {
  const a = safeArr(nameArr);
  if (!a.length) return "Unnamed";
  const n = a[0] || {};
  const given = safeArr(n.given).join(" ");
  const family = n.family || "";
  return `${given} ${family}`.trim() || "Unnamed";
}

function getFirstTelecom(telecomArr, system) {
  const a = safeArr(telecomArr);
  const match = a.find((t) => t?.system === system && t?.value);
  return match?.value || "";
}

function fmtDate(iso) {
  if (!iso) return "—";
  // handles YYYY-MM-DD or full ISO
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function pickObsDate(obs) {
  return (
    obs?.effectiveDateTime ||
    obs?.effectivePeriod?.end ||
    obs?.effectivePeriod?.start ||
    obs?.issued ||
    null
  );
}

function getCodingCodeDisplay(codeObj) {
  const coding = safeArr(codeObj?.coding);
  const c =
    coding.find((x) => (x?.system || "").toLowerCase().includes("loinc")) ||
    coding[0] ||
    null;

  return {
    code: c?.code || "",
    display: c?.display || codeObj?.text || "",
    system: c?.system || "",
  };
}

function getObsValueText(obs) {
  if (obs?.valueQuantity?.value != null) {
    const v = obs.valueQuantity.value;
    const u = obs.valueQuantity.unit || obs.valueQuantity.code || "";
    return `${v}${u ? " " + u : ""}`;
  }
  if (obs?.valueString) return obs.valueString;
  if (obs?.valueCodeableConcept?.text) return obs.valueCodeableConcept.text;
  const cd = safeArr(obs?.valueCodeableConcept?.coding)[0];
  if (cd?.display) return cd.display;
  if (obs?.valueBoolean != null) return obs.valueBoolean ? "Yes" : "No";
  if (obs?.valueInteger != null) return String(obs.valueInteger);
  return "—";
}

/** ---------- vitals extraction (LOINC codes) ---------- */
const LOINC = {
  HR: "8867-4", // Heart rate
  RR: "9279-1", // Respiratory rate
  TEMP: "8310-5", // Body temperature
  SPO2: "59408-5", // Oxygen saturation
  BP_PANEL: "85354-9", // Blood pressure panel
  SBP: "8480-6",
  DBP: "8462-4",
};

function extractLatestVitals(observations) {
  // Expect observations sorted newest-first (we’ll do that in the query).
  let hr = null,
    rr = null,
    temp = null,
    spo2 = null,
    sbp = null,
    dbp = null;

  for (const obs of observations) {
    const { code } = getCodingCodeDisplay(obs?.code);

    // BP can arrive as a panel with components
    if (code === LOINC.BP_PANEL) {
      const comps = safeArr(obs?.component);
      const s = comps.find((c) => getCodingCodeDisplay(c?.code).code === LOINC.SBP);
      const d = comps.find((c) => getCodingCodeDisplay(c?.code).code === LOINC.DBP);
      if (!sbp && s?.valueQuantity?.value != null) sbp = { obs, value: getObsValueText({ valueQuantity: s.valueQuantity }) };
      if (!dbp && d?.valueQuantity?.value != null) dbp = { obs, value: getObsValueText({ valueQuantity: d.valueQuantity }) };
    }

    // Sometimes SBP/DBP arrive as separate Observations
    if (code === LOINC.SBP && !sbp) sbp = { obs, value: getObsValueText(obs) };
    if (code === LOINC.DBP && !dbp) dbp = { obs, value: getObsValueText(obs) };

    if (code === LOINC.HR && !hr) hr = { obs, value: getObsValueText(obs) };
    if (code === LOINC.RR && !rr) rr = { obs, value: getObsValueText(obs) };
    if (code === LOINC.TEMP && !temp) temp = { obs, value: getObsValueText(obs) };
    if (code === LOINC.SPO2 && !spo2) spo2 = { obs, value: getObsValueText(obs) };

    if (hr && rr && temp && spo2 && sbp && dbp) break;
  }

  return { hr, rr, temp, spo2, sbp, dbp };
}

/** ---------- UI styles (NHS-ish: calm, clean, clinical) ---------- */
const ui = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(1200px 600px at 20% -10%, rgba(0,94,184,0.16), transparent 60%), radial-gradient(1000px 600px at 100% 0%, rgba(0,140,255,0.10), transparent 55%), linear-gradient(180deg, rgba(245,249,255,1), rgba(250,251,252,1))",
    color: "#0b1b2b",
  },
  shell: { maxWidth: 1240, margin: "0 auto", padding: 20 },
  topBar: {
    borderRadius: 18,
    padding: "14px 16px",
    background: "linear-gradient(90deg, rgba(0,94,184,1), rgba(0,140,255,0.92))",
    color: "white",
    boxShadow: "0 10px 30px rgba(0,30,80,0.18)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  titleWrap: { display: "flex", alignItems: "center", gap: 12 },
  badge: {
    background: "rgba(255,255,255,0.18)",
    border: "1px solid rgba(255,255,255,0.25)",
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.2,
  },
  card: {
    background: "white",
    border: "1px solid rgba(10, 30, 60, 0.10)",
    borderRadius: 18,
    boxShadow: "0 8px 22px rgba(10, 30, 60, 0.06)",
  },
  subtle: { color: "rgba(11,27,43,0.72)" },
  grid: { display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 14, marginTop: 14, alignItems: "start" },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(10,30,60,0.16)",
    background: "rgba(250,252,255,1)",
    color: "inherit",
    outline: "none",
  },
  label: { display: "block", fontSize: 12, fontWeight: 700, color: "rgba(11,27,43,0.70)", marginBottom: 6 },
  btn: (disabled) => ({
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(10,30,60,0.16)",
    background: disabled ? "rgba(10,30,60,0.06)" : "rgba(0,94,184,1)",
    color: disabled ? "rgba(11,27,43,0.55)" : "white",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 800,
    letterSpacing: 0.2,
    boxShadow: disabled ? "none" : "0 10px 18px rgba(0,94,184,0.18)",
  }),
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid rgba(10,30,60,0.12)",
    background: "rgba(250,252,255,1)",
    fontSize: 12,
    fontWeight: 800,
  },
};

export default function App() {
  const [q, setQ] = useState("smith");
  const [count, setCount] = useState(10);

  const [loadingPatients, setLoadingPatients] = useState(false);
  const [errorPatients, setErrorPatients] = useState("");
  const [bundle, setBundle] = useState(null);

  const [selectedPatientId, setSelectedPatientId] = useState("");

  const [loadingObs, setLoadingObs] = useState(false);
  const [errorObs, setErrorObs] = useState("");
  const [obsBundle, setObsBundle] = useState(null);

  const patients = useMemo(() => {
    const entries = bundle?.entry || [];
    return entries.map((e) => e.resource).filter((r) => r?.resourceType === "Patient");
  }, [bundle]);

  const selectedPatient = useMemo(() => {
    return patients.find((p) => p.id === selectedPatientId) || null;
  }, [patients, selectedPatientId]);

  const observations = useMemo(() => {
    const entries = obsBundle?.entry || [];
    const obs = entries.map((e) => e.resource).filter((r) => r?.resourceType === "Observation");

    // Sort newest-first by effective/issued
    obs.sort((a, b) => {
      const da = new Date(pickObsDate(a) || 0).getTime();
      const db = new Date(pickObsDate(b) || 0).getTime();
      return db - da;
    });

    return obs;
  }, [obsBundle]);

  const vitals = useMemo(() => extractLatestVitals(observations), [observations]);

  async function searchPatients() {
    setLoadingPatients(true);
    setErrorPatients("");
    setBundle(null);

    try {
      const url = new URL(`${FHIR_BASE}/Patient`);
      url.searchParams.set("_count", String(count));
      if (q.trim()) url.searchParams.set("name", q.trim());

      const res = await fetch(url.toString(), { headers: { Accept: "application/fhir+json" } });
      if (!res.ok) throw new Error(`FHIR Patient search failed (${res.status})`);

      const data = await res.json();
      if (data?.resourceType !== "Bundle") throw new Error("Unexpected Patient response (not a FHIR Bundle).");

      setBundle(data);

      const first = (data.entry || []).map((e) => e.resource).find((r) => r?.resourceType === "Patient");
      setSelectedPatientId(first?.id || "");
    } catch (e) {
      setErrorPatients(e?.message || "Unknown patient error");
    } finally {
      setLoadingPatients(false);
    }
  }

  async function fetchObservationsForPatient(patientId) {
    if (!patientId) return;

    setLoadingObs(true);
    setErrorObs("");
    setObsBundle(null);

    try {
      const url = new URL(`${FHIR_BASE}/Observation`);
      // Most servers accept either subject=Patient/{id} or patient={id}; we’ll use subject.
      url.searchParams.set("subject", `Patient/${patientId}`);
      url.searchParams.set("_count", "80");
      url.searchParams.set("_sort", "-date");

      const res = await fetch(url.toString(), { headers: { Accept: "application/fhir+json" } });
      if (!res.ok) throw new Error(`FHIR Observation search failed (${res.status})`);

      const data = await res.json();
      if (data?.resourceType !== "Bundle") throw new Error("Unexpected Observation response (not a FHIR Bundle).");

      setObsBundle(data);
    } catch (e) {
      setErrorObs(e?.message || "Unknown observation error");
    } finally {
      setLoadingObs(false);
    }
  }

  // initial load
  useEffect(() => {
    searchPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load observations when selection changes
  useEffect(() => {
    if (selectedPatientId) fetchObservationsForPatient(selectedPatientId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatientId]);

  return (
    <div style={ui.page}>
      <div style={ui.shell}>
        <div style={ui.topBar}>
          <div style={ui.titleWrap}>
            <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 0.2 }}>Clinical FHIR Integration Demo</div>
            <div style={ui.badge}>React + Vite</div>
            <div style={ui.badge}>FHIR R4 (Release 4)</div>
          </div>
          <div style={{ fontSize: 12, opacity: 0.92 }}>
            Test server: <span style={{ fontWeight: 900 }}>{FHIR_BASE}</span>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          <div style={{ ...ui.card, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 950, marginBottom: 4 }}>Patient search</div>
                <div style={ui.subtle}>
                  Live FHIR REST calls returning FHIR JSON Bundles, rendered into a clinical-style interface.
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={ui.pill}>✅ Public demo data</span>
                <span style={ui.pill}>🔌 Standards-based integration</span>
                <span style={ui.pill}>☁️ Deployed on Cloudflare Pages</span>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 140px 140px",
                gap: 10,
                alignItems: "end",
                marginTop: 12,
              }}
            >
              <div>
                <label style={ui.label}>Name contains</label>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. smith" style={ui.input} />
              </div>

              <div>
                <label style={ui.label}>Count</label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  style={ui.input}
                />
              </div>

              <button onClick={searchPatients} disabled={loadingPatients} style={ui.btn(loadingPatients)}>
                {loadingPatients ? "Loading…" : "Search"}
              </button>
            </div>

            {errorPatients && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid rgba(220,50,50,0.25)",
                  background: "rgba(220,50,50,0.06)",
                }}
              >
                <strong>Patient error:</strong> {errorPatients}
              </div>
            )}
          </div>

          <div style={ui.grid}>
            {/* LEFT: results */}
            <section style={{ ...ui.card, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 16, letterSpacing: 0.2 }}>Results</h2>
                <div style={{ fontSize: 12, color: "rgba(11,27,43,0.65)" }}>
                  {patients.length ? `${patients.length} patients` : "—"}
                </div>
              </div>

              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {patients.map((p) => {
                  const isSelected = p.id === selectedPatientId;
                  const name = getHumanName(p.name);
                  const gender = p.gender || "unknown";
                  const dob = p.birthDate || "—";
                  const phone = getFirstTelecom(p.telecom, "phone");
                  const email = getFirstTelecom(p.telecom, "email");

                  const identifier =
                    (p.identifier || []).find((id) => (id?.system || "").toLowerCase().includes("nhs"))?.value ||
                    (p.identifier || [])[0]?.value ||
                    "—";

                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedPatientId(p.id)}
                      style={{
                        textAlign: "left",
                        width: "100%",
                        padding: 12,
                        borderRadius: 16,
                        border: isSelected ? "1px solid rgba(0,94,184,0.35)" : "1px solid rgba(10,30,60,0.10)",
                        background: isSelected ? "rgba(0,94,184,0.06)" : "white",
                        cursor: "pointer",
                        boxShadow: isSelected ? "0 10px 20px rgba(0,94,184,0.08)" : "none",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <div>
                          <div style={{ fontSize: 16, fontWeight: 900 }}>{name}</div>
                          <div style={{ marginTop: 2, fontSize: 12, color: "rgba(11,27,43,0.70)" }}>
                            <code>Patient/{p.id}</code>
                          </div>
                        </div>

                        <div style={{ textAlign: "right", fontSize: 12, color: "rgba(11,27,43,0.72)" }}>
                          <div style={{ fontWeight: 900 }}>
                            {gender} • {dob}
                          </div>
                          <div style={{ marginTop: 2 }}>
                            <span style={{ opacity: 0.75 }}>Identifier:</span> {identifier}
                          </div>
                        </div>
                      </div>

                      {(phone || email) && (
                        <div style={{ marginTop: 10, fontSize: 12, color: "rgba(11,27,43,0.75)" }}>
                          {phone && (
                            <span style={{ marginRight: 12 }}>
                              📞 <span style={{ opacity: 0.75 }}>Phone:</span> {phone}
                            </span>
                          )}
                          {email && (
                            <span>
                              ✉️ <span style={{ opacity: 0.75 }}>Email:</span> {email}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}

                {!loadingPatients && patients.length === 0 && !errorPatients && (
                  <div style={{ opacity: 0.75 }}>No patients returned.</div>
                )}
              </div>
            </section>

            {/* RIGHT: patient details + observations */}
            <aside style={{ position: "sticky", top: 16, alignSelf: "start" }}>
              <div style={{ ...ui.card, padding: 14 }}>
                <h2 style={{ margin: 0, fontSize: 16, letterSpacing: 0.2 }}>Patient details</h2>

                {!selectedPatient && (
                  <div style={{ marginTop: 10, color: "rgba(11,27,43,0.75)" }}>Select a patient to view details.</div>
                )}

                {selectedPatient && (
                  <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 950 }}>{getHumanName(selectedPatient.name)}</div>
                      <div style={{ fontSize: 12, color: "rgba(11,27,43,0.70)", marginTop: 2 }}>
                        <code>Patient/{selectedPatient.id}</code>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ ...ui.pill, justifyContent: "space-between" }}>
                        <span style={{ opacity: 0.75 }}>Gender</span>
                        <span>{selectedPatient.gender || "unknown"}</span>
                      </div>
                      <div style={{ ...ui.pill, justifyContent: "space-between" }}>
                        <span style={{ opacity: 0.75 }}>Date of birth</span>
                        <span>{selectedPatient.birthDate || "—"}</span>
                      </div>
                    </div>

                    {/* Observations section */}
                    <div
                      style={{
                        marginTop: 2,
                        padding: 12,
                        borderRadius: 16,
                        border: "1px solid rgba(10,30,60,0.10)",
                        background:
                          "linear-gradient(180deg, rgba(250,252,255,1), rgba(245,249,255,1))",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                        <div style={{ fontSize: 14, fontWeight: 950 }}>Observations (vitals / labs)</div>
                        <div style={{ fontSize: 12, color: "rgba(11,27,43,0.65)" }}>
                          {loadingObs ? "Loading…" : `${observations.length} items`}
                        </div>
                      </div>

                      {errorObs && (
                        <div style={{ marginTop: 10, padding: 10, borderRadius: 12, background: "rgba(220,50,50,0.06)", border: "1px solid rgba(220,50,50,0.20)" }}>
                          <strong>Observation error:</strong> {errorObs}
                        </div>
                      )}

                      {!errorObs && (
                        <>
                          {/* Latest vitals */}
                          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <VitalCard label="Blood pressure" value={vitals.sbp && vitals.dbp ? `${vitals.sbp.value} / ${vitals.dbp.value}` : "—"} when={fmtDate(pickObsDate(vitals.sbp?.obs || vitals.dbp?.obs))} />
                            <VitalCard label="Heart rate" value={vitals.hr?.value || "—"} when={fmtDate(pickObsDate(vitals.hr?.obs))} />
                            <VitalCard label="Temperature" value={vitals.temp?.value || "—"} when={fmtDate(pickObsDate(vitals.temp?.obs))} />
                            <VitalCard label="Oxygen saturation" value={vitals.spo2?.value || "—"} when={fmtDate(pickObsDate(vitals.spo2?.obs))} />
                          </div>

                          {/* Mini timeline */}
                          <div style={{ marginTop: 12 }}>
                            <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(11,27,43,0.70)", marginBottom: 6 }}>
                              Recent timeline
                            </div>

                            <div style={{ display: "grid", gap: 8 }}>
                              {observations.slice(0, 8).map((o) => {
                                const cd = getCodingCodeDisplay(o.code);
                                const dt = fmtDate(pickObsDate(o));
                                const val = getObsValueText(o);

                                // If BP panel, show SBP/DBP
                                let lineVal = val;
                                if (cd.code === LOINC.BP_PANEL) {
                                  const comps = safeArr(o.component);
                                  const s = comps.find((c) => getCodingCodeDisplay(c?.code).code === LOINC.SBP);
                                  const d = comps.find((c) => getCodingCodeDisplay(c?.code).code === LOINC.DBP);
                                  const sv = s?.valueQuantity ? getObsValueText({ valueQuantity: s.valueQuantity }) : null;
                                  const dv = d?.valueQuantity ? getObsValueText({ valueQuantity: d.valueQuantity }) : null;
                                  if (sv || dv) lineVal = `${sv || "—"} / ${dv || "—"}`;
                                }

                                const label = cd.display || o.code?.text || "Observation";
                                return (
                                  <div
                                    key={o.id}
                                    style={{
                                      padding: 10,
                                      borderRadius: 14,
                                      background: "white",
                                      border: "1px solid rgba(10,30,60,0.10)",
                                      display: "flex",
                                      justifyContent: "space-between",
                                      gap: 10,
                                      alignItems: "baseline",
                                    }}
                                  >
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ fontSize: 12, fontWeight: 950, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        {label}
                                      </div>
                                      <div style={{ fontSize: 11, color: "rgba(11,27,43,0.62)", marginTop: 2 }}>
                                        {dt}
                                      </div>
                                    </div>
                                    <div style={{ fontSize: 12, fontWeight: 950 }}>{lineVal}</div>
                                  </div>
                                );
                              })}

                              {!loadingObs && observations.length === 0 && (
                                <div style={{ marginTop: 6, color: "rgba(11,27,43,0.72)", fontSize: 12 }}>
                                  No Observations returned for this patient (that’s normal on public test data sometimes).
                                </div>
                              )}
                            </div>
                          </div>

                          <div style={{ marginTop: 12, fontSize: 12, color: "rgba(11,27,43,0.70)" }}>
                            Next upgrade: add an <strong>AI summary</strong> button that produces a short clinical narrative from these Observations.
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          </div>

          <div style={{ marginTop: 10, textAlign: "center", fontSize: 12, color: "rgba(11,27,43,0.65)" }}>
            Built for demo purposes using public test FHIR data. No real patient data.
          </div>
        </div>
      </div>
    </div>
  );
}

function VitalCard({ label, value, when }) {
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 14,
        border: "1px solid rgba(10,30,60,0.10)",
        background: "white",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 900, color: "rgba(11,27,43,0.70)" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 950, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 11, color: "rgba(11,27,43,0.60)", marginTop: 4 }}>{when}</div>
    </div>
  );
}
