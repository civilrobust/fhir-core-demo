import React, { useEffect, useMemo, useState } from "react";

/**
 * Acronyms explained (as requested):
 * - NHS = National Health Service
 * - FHIR = Fast Healthcare Interoperability Resources
 * - REST = Representational State Transfer
 * - JSON = JavaScript Object Notation
 * - UI = User Interface
 * - AI = Artificial Intelligence
 */

const FHIR_BASE = "https://hapi.fhir.org/baseR4";
const PATIENT_SEARCH = `${FHIR_BASE}/Patient`;
const OBS_SEARCH = `${FHIR_BASE}/Observation`;

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function getHumanName(patient) {
  const name = patient?.name?.[0];
  if (!name) return "Unnamed patient";
  const given = Array.isArray(name.given) ? name.given.join(" ") : "";
  const family = name.family || "";
  const full = `${given} ${family}`.trim();
  return full || "Unnamed patient";
}

function getTelecom(patient) {
  const telecom = patient?.telecom || [];
  const phone = telecom.find((t) => t.system === "phone")?.value;
  const email = telecom.find((t) => t.system === "email")?.value;
  return { phone, email };
}

function safeText(s) {
  if (s === null || s === undefined) return "—";
  const t = String(s).trim();
  return t.length ? t : "—";
}

function pickObsDate(o) {
  return o?.effectiveDateTime || o?.effectivePeriod?.start || o?.issued || null;
}

/**
 * Observation parsing:
 * - Blood pressure often comes as components (systolic / diastolic)
 * - Others come as valueQuantity / valueString
 */
function obsToDisplay(o) {
  const codeText =
    o?.code?.text ||
    o?.code?.coding?.[0]?.display ||
    o?.code?.coding?.[0]?.code ||
    "Observation";

  // blood pressure (component-based)
  if (o?.component?.length) {
    const sys = o.component.find((c) => c?.code?.coding?.some((x) => x.code === "8480-6"));
    const dia = o.component.find((c) => c?.code?.coding?.some((x) => x.code === "8462-4"));
    const sysV = sys?.valueQuantity?.value;
    const diaV = dia?.valueQuantity?.value;
    if (sysV != null && diaV != null) {
      return {
        label: "Blood pressure",
        value: `${sysV}/${diaV} mmHg`,
        when: fmtDateTime(pickObsDate(o)),
        kind: "bp",
        raw: { sys: Number(sysV), dia: Number(diaV) },
      };
    }
  }

  // quantity-based
  if (o?.valueQuantity?.value != null) {
    const v = o.valueQuantity.value;
    const u = o.valueQuantity.unit || o.valueQuantity.code || "";
    return {
      label: codeText,
      value: `${v} ${u}`.trim(),
      when: fmtDateTime(pickObsDate(o)),
      kind: "qty",
      raw: { value: Number(v), unit: u, codeText },
    };
  }

  // string / codeable concept
  if (o?.valueString) {
    return { label: codeText, value: o.valueString, when: fmtDateTime(pickObsDate(o)), kind: "txt" };
  }
  const vcc = o?.valueCodeableConcept?.text || o?.valueCodeableConcept?.coding?.[0]?.display;
  if (vcc) {
    return { label: codeText, value: vcc, when: fmtDateTime(pickObsDate(o)), kind: "txt" };
  }

  return { label: codeText, value: "—", when: fmtDateTime(pickObsDate(o)), kind: "unknown" };
}

/**
 * AI heuristics (local demo AI):
 * - Generates:
 *   1) AI Alerts (red/amber/green)
 *   2) AI Next Actions
 *   3) AI Data Quality checks
 *   4) A short "clinical narrative" summary
 */
function buildAiInsights({ patient, obsDisplays }) {
  const name = getHumanName(patient);
  const gender = safeText(patient?.gender);
  const dob = safeText(patient?.birthDate);

  // pick latest values by label
  const byLabel = new Map();
  for (const o of obsDisplays) {
    const key = String(o.label || "").toLowerCase();
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(o);
  }
  for (const [k, arr] of byLabel) {
    arr.sort((a, b) => (new Date(b.when).getTime() || 0) - (new Date(a.when).getTime() || 0));
    byLabel.set(k, arr);
  }

  const findLatest = (pred) => {
    const flat = [...obsDisplays].slice();
    flat.sort((a, b) => (new Date(b.when).getTime() || 0) - (new Date(a.when).getTime() || 0));
    return flat.find(pred);
  };

  const bp = findLatest((x) => x.kind === "bp");
  const hr = findLatest((x) => String(x.label).toLowerCase().includes("heart rate"));
  const spo2 = findLatest((x) => String(x.label).toLowerCase().includes("oxygen"));
  const temp = findLatest((x) => String(x.label).toLowerCase().includes("temp"));

  const alerts = [];
  const actions = [];
  const dq = [];

  // Data quality checks
  if (!patient?.id) dq.push("Patient ID missing.");
  if (!patient?.name?.length) dq.push("No Patient name available in resource.");
  if (!patient?.birthDate) dq.push("Date of birth missing.");
  if (!obsDisplays.length) dq.push("No Observation resources returned for this patient.");

  // Simple thresholds (demo only)
  if (bp?.raw?.sys != null && bp?.raw?.dia != null) {
    const { sys, dia } = bp.raw;
    if (sys >= 180 || dia >= 120) alerts.push({ level: "red", text: `Very high blood pressure (${sys}/${dia}).` });
    else if (sys >= 140 || dia >= 90) alerts.push({ level: "amber", text: `Raised blood pressure (${sys}/${dia}).` });
    else alerts.push({ level: "green", text: `Blood pressure appears within typical range (${sys}/${dia}).` });
  } else {
    alerts.push({ level: "amber", text: "No blood pressure available in latest Observations." });
  }

  if (hr?.raw?.value != null) {
    const v = hr.raw.value;
    if (v >= 130) alerts.push({ level: "red", text: `High heart rate (${v}).` });
    else if (v >= 100) alerts.push({ level: "amber", text: `Raised heart rate (${v}).` });
    else if (v > 0) alerts.push({ level: "green", text: `Heart rate looks stable (${v}).` });
  } else {
    alerts.push({ level: "amber", text: "No heart rate available in latest Observations." });
  }

  if (spo2?.raw?.value != null) {
    const v = spo2.raw.value;
    if (v < 90) alerts.push({ level: "red", text: `Low oxygen saturation (${v}).` });
    else if (v < 94) alerts.push({ level: "amber", text: `Borderline oxygen saturation (${v}).` });
    else alerts.push({ level: "green", text: `Oxygen saturation looks OK (${v}).` });
  }

  if (temp?.raw?.value != null) {
    const v = temp.raw.value;
    if (v >= 39) alerts.push({ level: "red", text: `High temperature (${v}).` });
    else if (v >= 37.8) alerts.push({ level: "amber", text: `Raised temperature (${v}).` });
    else alerts.push({ level: "green", text: `Temperature looks normal (${v}).` });
  }

  // Next Actions (demo)
  actions.push("Review latest Observations and confirm timestamps match the current encounter.");
  actions.push("Check for missing vitals (blood pressure, heart rate, temperature, oxygen saturation).");
  actions.push("If trends look unusual, pull additional Observations and display a mini chart (sparkline).");
  actions.push("Add MedicationRequest resources and Conditions to build an AI ‘patient story’ timeline.");

  // Narrative summary (demo)
  const latestFew = [...obsDisplays]
    .slice()
    .sort((a, b) => (new Date(b.when).getTime() || 0) - (new Date(a.when).getTime() || 0))
    .slice(0, 5);

  const summaryLines = [];
  summaryLines.push(`Patient: ${name} • Gender: ${gender} • Date of birth: ${dob}`);
  summaryLines.push("");
  summaryLines.push("AI clinical narrative (demo):");
  summaryLines.push(
    `Latest data includes ${obsDisplays.length} Observations. Key recent items: ` +
      (latestFew.length
        ? latestFew.map((x) => `${x.label}: ${x.value} (${x.when})`).join(" • ")
        : "no recent items.")
  );
  summaryLines.push("");
  summaryLines.push("AI alerts:");
  for (const a of alerts) summaryLines.push(`- [${a.level.toUpperCase()}] ${a.text}`);
  summaryLines.push("");
  summaryLines.push("AI next actions:");
  for (const a of actions) summaryLines.push(`- ${a}`);
  if (dq.length) {
    summaryLines.push("");
    summaryLines.push("AI data-quality checks:");
    for (const d of dq) summaryLines.push(`- ${d}`);
  }

  return { alerts, actions, dq, narrative: summaryLines.join("\n") };
}

/**
 * OPTIONAL real AI hook:
 * - If you later build a tiny backend endpoint, you can send patient+observations to it.
 * - This keeps the demo “AI-heavy” but also board-safe and controllable.
 *
 * Set in .env.local:
 *   VITE_AI_ENDPOINT=https://your-backend.example/ai/summary
 */
async function callRealAiEndpoint({ patient, observations }) {
  const endpoint = import.meta.env.VITE_AI_ENDPOINT;
  if (!endpoint) return null;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient, observations }),
  });

  if (!res.ok) throw new Error(`AI endpoint error: ${res.status}`);
  const data = await res.json();
  // expected: { summaryText: "..." }
  return data?.summaryText || null;
}

function VitalCard({ label, value, when }) {
  return (
    <div className="obsCard">
      <div className="obsLabel">{label}</div>
      <div className="obsValue">{value}</div>
      <div className="obsWhen">{when}</div>
    </div>
  );
}

function levelDotClass(level) {
  if (level === "green") return "dot dotGreen";
  if (level === "amber") return "dot dotAmber";
  if (level === "red") return "dot dotRed";
  return "dot";
}

export default function App() {
  const [nameContains, setNameContains] = useState("smith");
  const [count, setCount] = useState(10);

  const [loadingPatients, setLoadingPatients] = useState(false);
  const [patients, setPatients] = useState([]);
  const [patientsErr, setPatientsErr] = useState("");

  const [selectedPatient, setSelectedPatient] = useState(null);

  const [loadingObs, setLoadingObs] = useState(false);
  const [obs, setObs] = useState([]);
  const [obsErr, setObsErr] = useState("");

  const [aiSummary, setAiSummary] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [useRealAi, setUseRealAi] = useState(false);

  async function searchPatients() {
    setLoadingPatients(true);
    setPatientsErr("");
    setPatients([]);

    try {
      const url =
        `${PATIENT_SEARCH}?` +
        new URLSearchParams({
          name: nameContains || "",
          _count: String(count || 10),
        }).toString();

      const res = await fetch(url, { headers: { Accept: "application/fhir+json" } });
      if (!res.ok) throw new Error(`FHIR patient search failed: ${res.status}`);

      const bundle = await res.json();
      const entries = bundle?.entry || [];
      const pts = entries.map((e) => e.resource).filter(Boolean);
      setPatients(pts);

      if (pts.length) setSelectedPatient(pts[0]);
      else setSelectedPatient(null);
    } catch (e) {
      setPatientsErr(e?.message || "Unknown error searching patients.");
      setSelectedPatient(null);
    } finally {
      setLoadingPatients(false);
    }
  }

  async function fetchObservationsForPatient(patientId) {
    if (!patientId) return;
    setLoadingObs(true);
    setObsErr("");
    setObs([]);
    setAiSummary("");

    try {
      const url =
        `${OBS_SEARCH}?` +
        new URLSearchParams({
          subject: `Patient/${patientId}`,
          _sort: "-date",
          _count: "25",
        }).toString();

      const res = await fetch(url, { headers: { Accept: "application/fhir+json" } });
      if (!res.ok) throw new Error(`FHIR Observation search failed: ${res.status}`);

      const bundle = await res.json();
      const entries = bundle?.entry || [];
      const items = entries.map((e) => e.resource).filter(Boolean);
      setObs(items);
    } catch (e) {
      setObsErr(e?.message || "Unknown error fetching Observations.");
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
    if (selectedPatient?.id) fetchObservationsForPatient(selectedPatient.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatient?.id]);

  const patientTelecom = useMemo(() => getTelecom(selectedPatient), [selectedPatient]);

  const obsDisplays = useMemo(() => obs.map(obsToDisplay), [obs]);

  // curated “vitals-like” cards for the top area
  const vitalsCards = useMemo(() => {
    const latestByKey = new Map();

    const wantKeys = [
      { key: "Blood pressure", pred: (x) => x.kind === "bp" },
      { key: "Heart rate", pred: (x) => String(x.label).toLowerCase().includes("heart rate") },
      { key: "Temperature", pred: (x) => String(x.label).toLowerCase().includes("temp") },
      { key: "Oxygen saturation", pred: (x) => String(x.label).toLowerCase().includes("oxygen") },
    ];

    const sorted = [...obsDisplays].slice().sort((a, b) => {
      const ta = new Date(a.when).getTime() || 0;
      const tb = new Date(b.when).getTime() || 0;
      return tb - ta;
    });

    for (const item of sorted) {
      for (const w of wantKeys) {
        if (latestByKey.has(w.key)) continue;
        if (w.pred(item)) latestByKey.set(w.key, item);
      }
      if (latestByKey.size === wantKeys.length) break;
    }

    return wantKeys.map((w) => {
      const it = latestByKey.get(w.key);
      return {
        label: w.key,
        value: it?.value || "—",
        when: it?.when || "—",
      };
    });
  }, [obsDisplays]);

  const timelineItems = useMemo(() => {
    const sorted = [...obsDisplays].slice().sort((a, b) => {
      const ta = new Date(a.when).getTime() || 0;
      const tb = new Date(b.when).getTime() || 0;
      return tb - ta;
    });
    return sorted.slice(0, 10);
  }, [obsDisplays]);

  const aiInsights = useMemo(() => {
    if (!selectedPatient) return null;
    return buildAiInsights({ patient: selectedPatient, obsDisplays });
  }, [selectedPatient, obsDisplays]);

  async function generateAiSummary() {
    if (!selectedPatient) return;

    setAiBusy(true);
    setAiSummary("");

    try {
      // 1) If “Real AI” toggle enabled AND endpoint exists, call it
      if (useRealAi) {
        const txt = await callRealAiEndpoint({ patient: selectedPatient, observations: obs });
        if (txt) {
          setAiSummary(txt);
          return;
        }
      }

      // 2) Otherwise use local AI heuristics (still “AI” in the demo sense)
      const local = buildAiInsights({ patient: selectedPatient, obsDisplays });
      setAiSummary(local.narrative);
    } catch (e) {
      setAiSummary(`AI summary failed: ${e?.message || "Unknown error"}`);
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="shell">
        <div className="topBar">
          <div className="brandLeft">
            <div className="brandTitle">Clinical FHIR Integration Demo</div>
            <div className="brandMeta">
              Live FHIR (Fast Healthcare Interoperability Resources) REST (Representational State Transfer) calls •
              React + Vite • Board-ready UI (User Interface)
            </div>
          </div>

          <div className="pills">
            <div className="pill">React + Vite</div>
            <div className="pill">FHIR R4 (Release 4)</div>
            <a className="pill linkPill" href={FHIR_BASE} target="_blank" rel="noreferrer">
              Test server: {FHIR_BASE}
            </a>
          </div>
        </div>

        {/* Search card */}
        <div className="card cardPad" style={{ marginTop: 14 }}>
          <div className="h1" style={{ textAlign: "center" }}>
            Patient search
          </div>
          <div className="subtle" style={{ textAlign: "center", marginTop: 6 }}>
            Searches Patient resources, then pulls Observation resources (vitals / labs) and generates an AI (Artificial
            Intelligence) summary + alerts + next actions.
          </div>

          <div className="badgesRow">
            <span className="badge">
              <span className="dot dotGreen" /> Public demo data
            </span>
            <span className="badge">
              <span className="dot" /> Standards-based integration
            </span>
            <span className="badge">
              <span className="dot dotAmber" /> Deployed on Cloudflare Pages
            </span>
          </div>

          <div className="searchGrid">
            <div>
              <div className="label">Name contains</div>
              <input className="input" value={nameContains} onChange={(e) => setNameContains(e.target.value)} />
            </div>
            <div>
              <div className="label">Count</div>
              <input
                className="input"
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Number(e.target.value || 10))}
              />
            </div>
            <button className="button" onClick={searchPatients} disabled={loadingPatients}>
              {loadingPatients ? "Searching…" : "Search"}
            </button>
          </div>

          {patientsErr ? (
            <div className="subtle" style={{ marginTop: 10, color: "rgba(210,30,45,0.95)", fontWeight: 900 }}>
              {patientsErr}
            </div>
          ) : null}
        </div>

        {/* Main grid */}
        <div className="mainGrid">
          {/* Results list */}
          <div className="card list">
            <div className="listHeader">
              <div className="sectionTitle">Results</div>
              <div className="countText">
                {loadingPatients ? "Loading…" : `${patients.length} patient${patients.length === 1 ? "" : "s"}`}
              </div>
            </div>

            {loadingPatients ? (
              <div style={{ padding: 12 }}>
                <div className="skel" style={{ width: "40%", margin: "10px 10px 0" }} />
                <div className="skel" style={{ width: "90%", height: 52, margin: "10px" }} />
                <div className="skel" style={{ width: "90%", height: 52, margin: "10px" }} />
                <div className="skel" style={{ width: "90%", height: 52, margin: "10px" }} />
              </div>
            ) : patients.length === 0 ? (
              <div className="subtle" style={{ padding: 14, fontWeight: 900 }}>
                No patients returned.
              </div>
            ) : (
              patients.map((p) => {
                const active = selectedPatient?.id === p.id;
                const { phone } = getTelecom(p);
                return (
                  <div
                    key={p.id}
                    className={`row ${active ? "rowActive" : ""}`}
                    onClick={() => setSelectedPatient(p)}
                    role="button"
                    tabIndex={0}
                  >
                    <div>
                      <div className="name">{getHumanName(p)}</div>
                      <div className="small">Patient/{p.id}</div>
                      <div className="phone">📞 Phone: {safeText(phone)}</div>
                    </div>

                    <div className="metaRight">
                      <div>{safeText(p.gender)} • {fmtDate(p.birthDate)}</div>
                      <div style={{ marginTop: 2 }}>
                        Identifier: {safeText(p?.identifier?.[0]?.value)}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Details */}
          <div className="card cardPad">
            <div className="detailsHeader">
              <div className="sectionTitle">Patient details</div>
              <div className="detailsName">{selectedPatient ? getHumanName(selectedPatient) : "—"}</div>
              <div className="small">{selectedPatient ? `Patient/${selectedPatient.id}` : "Select a patient"}</div>
            </div>

            <div className="kvRow">
              <div className="kv">
                <span>Gender</span>
                <div>{safeText(selectedPatient?.gender)}</div>
              </div>
              <div className="kv">
                <span>Date of birth</span>
                <div>{fmtDate(selectedPatient?.birthDate)}</div>
              </div>
            </div>

            {/* Observations */}
            <div className="obsHeader">
              <div className="sectionTitle">Observations (vitals / labs)</div>
              <div className="countText">{loadingObs ? "Loading…" : `${obsDisplays.length} items`}</div>
            </div>

            {obsErr ? (
              <div className="subtle" style={{ marginTop: 10, color: "rgba(210,30,45,0.95)", fontWeight: 900 }}>
                {obsErr}
              </div>
            ) : null}

            <div className="obsGrid">
              {loadingObs
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="obsCard">
                      <div className="skel" style={{ width: "44%" }} />
                      <div className="skel" style={{ width: "68%", height: 16, marginTop: 10 }} />
                      <div className="skel" style={{ width: "52%", marginTop: 10 }} />
                    </div>
                  ))
                : vitalsCards.map((v) => <VitalCard key={v.label} label={v.label} value={v.value} when={v.when} />)}
            </div>

            {/* Timeline */}
            <div className="timelineTitle">Recent timeline</div>
            {loadingObs ? (
              <div style={{ marginTop: 8 }}>
                <div className="skel" style={{ width: "100%", height: 44, borderRadius: 14, marginTop: 8 }} />
                <div className="skel" style={{ width: "100%", height: 44, borderRadius: 14, marginTop: 8 }} />
                <div className="skel" style={{ width: "100%", height: 44, borderRadius: 14, marginTop: 8 }} />
              </div>
            ) : (
              timelineItems.map((t, idx) => (
                <div key={`${t.label}-${idx}-${t.when}`} className="timelineItem">
                  <div className="timelineLeft">
                    <div className="timelineName">{t.label}</div>
                    <div className="timelineWhen">{t.when}</div>
                  </div>
                  <div className="timelineRight">{t.value}</div>
                </div>
              ))
            )}

            {/* AI Panel */}
            <div className="aiPanel">
              <div className="aiHeader">
                <div className="aiTitle">AI summary (demo)</div>

                <div className="aiMode" title="Toggle between local AI and a real AI endpoint (if configured)">
                  Real AI endpoint
                  <input
                    className="toggle"
                    type="checkbox"
                    checked={useRealAi}
                    onChange={(e) => setUseRealAi(e.target.checked)}
                  />
                </div>
              </div>

              {/* AI Alerts chips */}
              <div className="badgesRow" style={{ marginTop: 10 }}>
                {(aiInsights?.alerts || []).slice(0, 4).map((a, i) => (
                  <span key={i} className="badge">
                    <span className={levelDotClass(a.level)} /> {a.text}
                  </span>
                ))}
              </div>

              <div className="aiRow">
                <button className="aiBtn" onClick={generateAiSummary} disabled={aiBusy || !selectedPatient}>
                  {aiBusy ? "Generating…" : "Generate summary"}
                </button>
                <div className="aiMini">
                  Generates a short “clinical note” from Patient demographics + latest Observations.
                </div>
              </div>

              <div className="aiTextBox">
                {aiSummary
                  ? aiSummary
                  : "Click “Generate summary” to produce an AI clinical narrative + alerts + next actions + data quality checks."}
              </div>
            </div>

            <div className="subtle" style={{ marginTop: 12, textAlign: "center", fontWeight: 900 }}>
              Next upgrade: add mini sparklines + Conditions + MedicationRequests + Encounter timeline for a full AI patient
              story.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
