import React, { useEffect, useMemo, useRef, useState } from "react";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

const FHIR_BASE_DEFAULT = "https://hapi.fhir.org/baseR4";

/* ---------- tiny helpers ---------- */
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit" });
};
const fmtDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};
const safe = (v, fallback = "—") => (v === null || v === undefined || v === "" ? fallback : v);

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/fhir+json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function getPatientDisplayName(p) {
  const name = p?.name?.[0];
  if (!name) return "Unnamed patient";
  const given = (name.given || []).join(" ");
  const family = name.family || "";
  const full = `${given} ${family}`.trim();
  return full || "Unnamed patient";
}
function getPatientPhone(p) {
  const telecom = p?.telecom || [];
  const phone = telecom.find((t) => t.system === "phone")?.value;
  return phone || "—";
}
function getPatientDOB(p) {
  return p?.birthDate || "—";
}
function getPatientGender(p) {
  return p?.gender || "unknown";
}
function getPatientIdentifier(p) {
  const id = p?.identifier?.[0]?.value;
  return id || "—";
}

function getRefId(ref) {
  // "Patient/123" -> "123"
  if (!ref) return null;
  const parts = String(ref).split("/");
  return parts.length === 2 ? parts[1] : parts[0];
}

/* ---------- vital parsing (FHIR Observation) ---------- */
/**
 * We target common LOINC (Logical Observation Identifiers Names and Codes) codes:
 * - Heart rate: 8867-4
 * - Body temperature: 8310-5
 * - Oxygen saturation: 59408-5
 * - Blood pressure panel: 55284-4 (components: systolic 8480-6, diastolic 8462-4)
 */
const LOINC = {
  HR: "8867-4",
  TEMP: "8310-5",
  SPO2: "59408-5",
  BP_PANEL: "55284-4",
  BP_SYS: "8480-6",
  BP_DIA: "8462-4",
};

function codeHas(obs, loinc) {
  const coding = obs?.code?.coding || [];
  return coding.some((c) => c.code === loinc);
}

function obsEffectiveDate(obs) {
  return (
    obs?.effectiveDateTime ||
    obs?.effectiveInstant ||
    obs?.issued ||
    obs?.effectivePeriod?.start ||
    null
  );
}

function numericValueFromObs(obs) {
  const q = obs?.valueQuantity;
  if (q && typeof q.value === "number") return q.value;
  if (q && typeof q.value === "string" && q.value.trim() !== "") return Number(q.value);
  return null;
}

function extractBP(obs) {
  // Either panel with components or direct systolic/diastolic observations.
  if (codeHas(obs, LOINC.BP_PANEL) && Array.isArray(obs.component)) {
    let sys = null;
    let dia = null;
    for (const c of obs.component) {
      const coding = c?.code?.coding || [];
      const isSys = coding.some((x) => x.code === LOINC.BP_SYS);
      const isDia = coding.some((x) => x.code === LOINC.BP_DIA);
      if (isSys) sys = c?.valueQuantity?.value ?? sys;
      if (isDia) dia = c?.valueQuantity?.value ?? dia;
    }
    return { sys: typeof sys === "number" ? sys : null, dia: typeof dia === "number" ? dia : null };
  }
  if (codeHas(obs, LOINC.BP_SYS)) return { sys: numericValueFromObs(obs), dia: null };
  if (codeHas(obs, LOINC.BP_DIA)) return { sys: null, dia: numericValueFromObs(obs) };
  return { sys: null, dia: null };
}

function pickUnit(obs) {
  return obs?.valueQuantity?.unit || obs?.valueQuantity?.code || "";
}

function firstCodingDisplay(codeable) {
  const c = codeable?.coding?.[0];
  return c?.display || codeable?.text || "—";
}

/* ---------- mini sparkline (SVG) ---------- */
function Sparkline({ values = [], height = 28, width = 92 }) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length < 2) return <div className="sparkEmpty">—</div>;

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;

  const pts = clean.map((v, i) => {
    const x = (i / (clean.length - 1)) * (width - 4) + 2;
    const y = height - ((v - min) / span) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/* ---------- triage + completeness ---------- */
function computeTriage(latest, rules) {
  // latest: { bpSys, bpDia, hr, temp, spo2 } (numbers or null)
  // rules: thresholds
  const reasons = [];
  let level = "GREEN";

  const bump = (to) => {
    const order = { GREEN: 0, AMBER: 1, RED: 2 };
    if (order[to] > order[level]) level = to;
  };

  if (typeof latest?.bpSys === "number") {
    if (latest.bpSys >= rules.bpRedSys) {
      bump("RED");
      reasons.push(`Systolic blood pressure ≥ ${rules.bpRedSys} mmHg.`);
    } else if (latest.bpSys >= rules.bpAmberSys) {
      bump("AMBER");
      reasons.push(`Systolic blood pressure ≥ ${rules.bpAmberSys} mmHg.`);
    }
  }
  if (typeof latest?.bpDia === "number") {
    if (latest.bpDia >= rules.bpRedDia) {
      bump("RED");
      reasons.push(`Diastolic blood pressure ≥ ${rules.bpRedDia} mmHg.`);
    } else if (latest.bpDia >= rules.bpAmberDia) {
      bump("AMBER");
      reasons.push(`Diastolic blood pressure ≥ ${rules.bpAmberDia} mmHg.`);
    }
  }

  if (typeof latest?.hr === "number") {
    if (latest.hr >= rules.hrRed) {
      bump("RED");
      reasons.push(`Heart rate ≥ ${rules.hrRed} bpm (beats per minute).`);
    } else if (latest.hr >= rules.hrAmber) {
      bump("AMBER");
      reasons.push(`Heart rate ≥ ${rules.hrAmber} bpm (beats per minute).`);
    }
  }

  if (typeof latest?.temp === "number") {
    if (latest.temp >= rules.tempRed) {
      bump("RED");
      reasons.push(`Temperature ≥ ${rules.tempRed} °C.`);
    } else if (latest.temp >= rules.tempAmber) {
      bump("AMBER");
      reasons.push(`Temperature ≥ ${rules.tempAmber} °C.`);
    }
  }

  if (typeof latest?.spo2 === "number") {
    if (latest.spo2 <= rules.spo2Red) {
      bump("RED");
      reasons.push(`Oxygen saturation ≤ ${rules.spo2Red}%.`);
    } else if (latest.spo2 <= rules.spo2Amber) {
      bump("AMBER");
      reasons.push(`Oxygen saturation ≤ ${rules.spo2Amber}%.`);
    }
  }

  if (reasons.length === 0) reasons.push("No RED/AMBER triggers found in latest vitals window (demo rule).");
  return { level, reasons };
}

function computeCompleteness(latest, wanted = ["bpSys", "hr", "temp", "spo2"]) {
  const missing = [];
  for (const k of wanted) {
    if (!(typeof latest?.[k] === "number" && Number.isFinite(latest[k]))) missing.push(k);
  }
  return missing;
}

function missingLabel(k) {
  if (k === "bpSys") return "Blood pressure";
  if (k === "hr") return "Heart rate";
  if (k === "temp") return "Temperature";
  if (k === "spo2") return "Oxygen saturation";
  return k;
}

/* ---------- concurrency limiter ---------- */
async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(limit).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- PDF export (NO popups) ---------- */
async function exportAiNoteToPdf(noteEl, filename = "AI_note.pdf") {
  if (!noteEl) return;

  const canvas = await html2canvas(noteEl, {
    scale: 2,
    backgroundColor: "#ffffff",
    useCORS: true,
    logging: false,
  });

  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF("p", "mm", "a4");

  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  // Fit image to page width; keep aspect ratio.
  const imgProps = pdf.getImageProperties(imgData);
  const imgW = pageW;
  const imgH = (imgProps.height * imgW) / imgProps.width;

  let y = 0;
  if (imgH <= pageH) {
    pdf.addImage(imgData, "PNG", 0, 0, imgW, imgH);
  } else {
    // Multi-page slicing
    let remaining = imgH;
    let offset = 0;
    while (remaining > 0) {
      pdf.addImage(imgData, "PNG", 0, -offset, imgW, imgH);
      remaining -= pageH;
      offset += pageH;
      if (remaining > 0) pdf.addPage();
    }
  }

  pdf.save(filename);
}

/* ---------- App ---------- */
export default function App() {
  const [fhirBase, setFhirBase] = useState(FHIR_BASE_DEFAULT);
  const [nameQuery, setNameQuery] = useState("smith");
  const [count, setCount] = useState(10);

  const [loading, setLoading] = useState(false);
  const [patients, setPatients] = useState([]);
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [error, setError] = useState("");

  // views
  const [view, setView] = useState("worklist"); // "worklist" | "patient" | "governance"
  const [worklistFilter, setWorklistFilter] = useState("ALL"); // ALL | RED | AMBER | GREEN | MISSING
  const [sortMode, setSortMode] = useState("RISK"); // RISK | NAME | RECENT

  // governance + audit
  const [modelVersion] = useState("demo-rules-v1.3");
  const [modelReviewed] = useState("2025-12-29");
  const [audit, setAudit] = useState([]);

  // rule thresholds (configurable)
  const [rules, setRules] = useState({
    bpRedSys: 180,
    bpRedDia: 120,
    bpAmberSys: 140,
    bpAmberDia: 90,
    hrRed: 130,
    hrAmber: 100,
    spo2Red: 90,
    spo2Amber: 94,
    tempRed: 39,
    tempAmber: 37.8,
    completenessHours: 24,
  });

  // caches
  const [obsByPatient, setObsByPatient] = useState({}); // patientId -> parsed vitals data
  const [encByPatient, setEncByPatient] = useState({});
  const [condByPatient, setCondByPatient] = useState({});
  const [medByPatient, setMedByPatient] = useState({});
  const [snapshotByPatient, setSnapshotByPatient] = useState({}); // worklist preview
  const [aiNote, setAiNote] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [expandedWhy, setExpandedWhy] = useState({}); // story item id -> bool

  const aiNoteRef = useRef(null);

  function addAudit(action, details = "") {
    const ts = new Date().toISOString();
    setAudit((prev) => [
      { ts, actor: "demo.clinician", action, details },
      ...prev.slice(0, 24),
    ]);
  }

  /* ---------- search patients ---------- */
  async function searchPatients() {
    setLoading(true);
    setError("");
    try {
      // Patient?name=smith&_count=10
      const url = `${fhirBase}/Patient?name=${encodeURIComponent(nameQuery)}&_count=${encodeURIComponent(
        count
      )}`;
      const data = await fetchJSON(url);
      const entries = data?.entry || [];
      const list = entries
        .map((e) => e.resource)
        .filter((r) => r && r.resourceType === "Patient");
      setPatients(list);
      const firstId = list?.[0]?.id || null;
      setSelectedPatientId((prev) => prev || firstId);
      addAudit("Patient search", `name contains "${nameQuery}", count ${count}`);
    } catch (e) {
      setError(`Search failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    searchPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- FHIR fetches ---------- */
  async function fetchVitals(patientId) {
    // vital signs only; enough for triage + completeness + sparklines
    const url = `${fhirBase}/Observation?patient=${encodeURIComponent(
      patientId
    )}&category=vital-signs&_sort=-date&_count=200`;
    const data = await fetchJSON(url);
    const obs = (data?.entry || []).map((e) => e.resource).filter(Boolean);

    // Build series (most recent first -> reverse for sparkline)
    const series = { bpSys: [], bpDia: [], hr: [], temp: [], spo2: [] };
    const when = { bpSys: null, bpDia: null, hr: null, temp: null, spo2: null };
    const units = { hr: "", temp: "", spo2: "", bp: "mmHg" };

    for (const o of obs) {
      const dt = obsEffectiveDate(o);
      // BP panel
      if (codeHas(o, LOINC.BP_PANEL) || codeHas(o, LOINC.BP_SYS) || codeHas(o, LOINC.BP_DIA)) {
        const bp = extractBP(o);
        if (typeof bp.sys === "number") {
          series.bpSys.push(bp.sys);
          if (!when.bpSys) when.bpSys = dt;
        }
        if (typeof bp.dia === "number") {
          series.bpDia.push(bp.dia);
          if (!when.bpDia) when.bpDia = dt;
        }
      }

      if (codeHas(o, LOINC.HR)) {
        const v = numericValueFromObs(o);
        if (typeof v === "number") {
          series.hr.push(v);
          if (!when.hr) when.hr = dt;
          if (!units.hr) units.hr = pickUnit(o);
        }
      }
      if (codeHas(o, LOINC.TEMP)) {
        const v = numericValueFromObs(o);
        if (typeof v === "number") {
          series.temp.push(v);
          if (!when.temp) when.temp = dt;
          if (!units.temp) units.temp = pickUnit(o);
        }
      }
      if (codeHas(o, LOINC.SPO2)) {
        const v = numericValueFromObs(o);
        if (typeof v === "number") {
          series.spo2.push(v);
          if (!when.spo2) when.spo2 = dt;
          if (!units.spo2) units.spo2 = pickUnit(o);
        }
      }
    }

    // latest values (first pushed are newest because sorted -date)
    const latest = {
      bpSys: series.bpSys[0] ?? null,
      bpDia: series.bpDia[0] ?? null,
      hr: series.hr[0] ?? null,
      temp: series.temp[0] ?? null,
      spo2: series.spo2[0] ?? null,
    };

    // Reverse series for sparkline (oldest -> newest), keep last 12 points.
    const spark = {
      bpSys: series.bpSys.slice(0, 24).reverse().slice(-12),
      hr: series.hr.slice(0, 24).reverse().slice(-12),
      temp: series.temp.slice(0, 24).reverse().slice(-12),
      spo2: series.spo2.slice(0, 24).reverse().slice(-12),
    };

    return { latest, when, units, spark, rawCount: obs.length };
  }

  async function fetchEncounters(patientId) {
    const url = `${fhirBase}/Encounter?patient=${encodeURIComponent(patientId)}&_sort=-date&_count=30`;
    const data = await fetchJSON(url);
    const enc = (data?.entry || []).map((e) => e.resource).filter(Boolean);
    return enc;
  }

  async function fetchConditions(patientId) {
    const url = `${fhirBase}/Condition?patient=${encodeURIComponent(patientId)}&_sort=-recorded-date&_count=30`;
    const data = await fetchJSON(url);
    const cond = (data?.entry || []).map((e) => e.resource).filter(Boolean);
    return cond;
  }

  async function fetchMedicationRequests(patientId) {
    const url = `${fhirBase}/MedicationRequest?patient=${encodeURIComponent(patientId)}&_sort=-authoredon&_count=30`;
    const data = await fetchJSON(url);
    const meds = (data?.entry || []).map((e) => e.resource).filter(Boolean);
    return meds;
  }

  /* ---------- load selected patient full story ---------- */
  useEffect(() => {
    if (!selectedPatientId) return;

    (async () => {
      try {
        const pid = selectedPatientId;

        // Load in parallel
        const [v, enc, cond, meds] = await Promise.all([
          fetchVitals(pid),
          fetchEncounters(pid),
          fetchConditions(pid),
          fetchMedicationRequests(pid),
        ]);

        setObsByPatient((prev) => ({ ...prev, [pid]: v }));
        setEncByPatient((prev) => ({ ...prev, [pid]: enc }));
        setCondByPatient((prev) => ({ ...prev, [pid]: cond }));
        setMedByPatient((prev) => ({ ...prev, [pid]: meds }));

        addAudit("Loaded patient story data", `Patient/${pid} vitals+encounters+conditions+medications`);
      } catch (e) {
        // keep UI alive
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatientId, fhirBase]);

  /* ---------- Worklist snapshots (make the list look intelligent) ---------- */
  useEffect(() => {
    if (!patients?.length) return;

    let cancelled = false;

    (async () => {
      // Build snapshots for visible list (limited concurrency)
      const list = patients.map((p) => p.id).filter(Boolean);

      await mapLimit(
        list,
        3,
        async (pid) => {
          if (cancelled) return;

          // Don’t refetch if we already have a snapshot
          if (snapshotByPatient[pid]) return;

          try {
            const [v, enc, cond, meds] = await Promise.all([
              fetchVitals(pid),
              fetchEncounters(pid),
              fetchConditions(pid),
              fetchMedicationRequests(pid),
            ]);

            const triage = computeTriage(v.latest, rules);
            const missing = computeCompleteness(v.latest);
            const lastEnc = enc?.[0]?.period?.start || enc?.[0]?.period?.end || enc?.[0]?.meta?.lastUpdated || null;

            const snap = {
              triage: triage.level,
              triageReasons: triage.reasons,
              missing,
              lastEncounter: lastEnc,
              counts: { conditions: (cond || []).length, meds: (meds || []).length, encounters: (enc || []).length },
              vitalsLatest: v.latest,
              vitalsWhen: v.when,
              spark: v.spark,
            };

            setSnapshotByPatient((prev) => ({ ...prev, [pid]: snap }));
          } catch (e) {
            setSnapshotByPatient((prev) => ({
              ...prev,
              [pid]: { triage: "UNKNOWN", triageReasons: ["Unable to fetch preview."], missing: ["bpSys", "hr", "temp", "spo2"] },
            }));
          }
        }
      );
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patients, fhirBase]);

  /* ---------- derived: selected patient objects ---------- */
  const selectedPatient = useMemo(() => patients.find((p) => p.id === selectedPatientId) || null, [
    patients,
    selectedPatientId,
  ]);

  const selectedVitals = obsByPatient[selectedPatientId] || null;
  const selectedEnc = encByPatient[selectedPatientId] || [];
  const selectedCond = condByPatient[selectedPatientId] || [];
  const selectedMeds = medByPatient[selectedPatientId] || [];

  const selectedTriage = useMemo(() => {
    if (!selectedVitals) return { level: "UNKNOWN", reasons: ["Loading vitals…"] };
    return computeTriage(selectedVitals.latest, rules);
  }, [selectedVitals, rules]);

  const selectedMissing = useMemo(() => {
    if (!selectedVitals) return ["bpSys", "hr", "temp", "spo2"];
    return computeCompleteness(selectedVitals.latest);
  }, [selectedVitals]);

  /* ---------- story timeline (Encounter + Condition + MedicationRequest + key Observations summary) ---------- */
  const storyItems = useMemo(() => {
    const items = [];

    // Encounters
    for (const e of selectedEnc || []) {
      const when = e?.period?.start || e?.period?.end || e?.meta?.lastUpdated;
      items.push({
        id: `enc-${e.id}`,
        kind: "Encounter",
        title: firstCodingDisplay(e?.type?.[0]) || "Encounter",
        when,
        triage: "GREEN",
        why: ["Episode of care anchor used to group events (demo)."],
      });
    }

    // Conditions
    for (const c of selectedCond || []) {
      const when = c?.recordedDate || c?.onsetDateTime || c?.meta?.lastUpdated;
      const title = firstCodingDisplay(c?.code) || "Condition";
      items.push({
        id: `cond-${c.id}`,
        kind: "Condition",
        title,
        when,
        triage: "AMBER",
        why: ["Active conditions contribute to clinical context (demo)."],
      });
    }

    // MedicationRequest
    for (const m of selectedMeds || []) {
      const when = m?.authoredOn || m?.meta?.lastUpdated;
      const title = firstCodingDisplay(m?.medicationCodeableConcept) || "Medication request";
      items.push({
        id: `med-${m.id}`,
        kind: "MedicationRequest",
        title,
        when,
        triage: "GREEN",
        why: ["Current medication requests add to the longitudinal story (demo)."],
      });
    }

    // Vital summary entry
    if (selectedVitals?.latest) {
      const when =
        selectedVitals.when.bpSys ||
        selectedVitals.when.hr ||
        selectedVitals.when.temp ||
        selectedVitals.when.spo2 ||
        null;

      const tri = computeTriage(selectedVitals.latest, rules);
      const parts = [];
      if (typeof selectedVitals.latest.bpSys === "number" && typeof selectedVitals.latest.bpDia === "number")
        parts.push(`BP ${selectedVitals.latest.bpSys}/${selectedVitals.latest.bpDia} mmHg`);
      if (typeof selectedVitals.latest.hr === "number") parts.push(`HR ${selectedVitals.latest.hr} bpm`);
      if (typeof selectedVitals.latest.temp === "number") parts.push(`Temp ${selectedVitals.latest.temp} °C`);
      if (typeof selectedVitals.latest.spo2 === "number") parts.push(`SpO₂ ${selectedVitals.latest.spo2}%`);

      items.push({
        id: `vitals-latest`,
        kind: "Observation",
        title: parts.length ? parts.join(" · ") : "Latest vitals",
        when,
        triage: tri.level,
        why: tri.reasons,
      });
    }

    // Sort newest first
    items.sort((a, b) => (new Date(b.when || 0)).getTime() - (new Date(a.when || 0)).getTime());
    return items.slice(0, 14);
  }, [selectedEnc, selectedCond, selectedMeds, selectedVitals, rules]);

  /* ---------- Worklist KPIs ---------- */
  const worklistStats = useMemo(() => {
    const snaps = patients
      .map((p) => snapshotByPatient[p.id])
      .filter(Boolean);

    const counts = { RED: 0, AMBER: 0, GREEN: 0, UNKNOWN: 0, MISSING: 0 };
    for (const s of snaps) {
      const t = s?.triage || "UNKNOWN";
      counts[t] = (counts[t] || 0) + 1;
      if (Array.isArray(s?.missing) && s.missing.length) counts.MISSING += 1;
    }
    return counts;
  }, [patients, snapshotByPatient]);

  const filteredWorklist = useMemo(() => {
    const list = patients.map((p) => {
      const snap = snapshotByPatient[p.id] || null;
      return { p, snap };
    });

    const filtered = list.filter(({ snap }) => {
      if (worklistFilter === "ALL") return true;
      if (worklistFilter === "MISSING") return (snap?.missing || []).length > 0;
      return (snap?.triage || "UNKNOWN") === worklistFilter;
    });

    const score = (snap) => {
      const order = { RED: 3, AMBER: 2, GREEN: 1, UNKNOWN: 0 };
      const base = order[snap?.triage || "UNKNOWN"] || 0;
      const miss = (snap?.missing || []).length ? 0.2 : 0;
      return base + miss;
    };

    filtered.sort((a, b) => {
      if (sortMode === "NAME") return getPatientDisplayName(a.p).localeCompare(getPatientDisplayName(b.p));
      if (sortMode === "RECENT") {
        const ad = new Date(a.snap?.lastEncounter || 0).getTime();
        const bd = new Date(b.snap?.lastEncounter || 0).getTime();
        return bd - ad;
      }
      // default RISK
      return score(b.snap) - score(a.snap);
    });

    return filtered;
  }, [patients, snapshotByPatient, worklistFilter, sortMode]);

  /* ---------- AI summary note (demo “AI heavy”) ---------- */
  async function generateAiSummary() {
    if (!selectedPatientId) return;
    setAiBusy(true);
    try {
      // This is a demo “AI note” generator (rule-driven).
      // In the next upgrade we swap this for an actual model + governance service.
      const name = getPatientDisplayName(selectedPatient);
      const pid = selectedPatientId;

      const tri = selectedTriage;
      const miss = selectedMissing;

      const lastEnc = selectedEnc?.[0]?.period?.start || selectedEnc?.[0]?.meta?.lastUpdated || null;

      const noteLines = [];
      noteLines.push(`AI clinical assistant note (demo)`);
      noteLines.push(`Patient: ${name} (Patient/${pid})`);
      noteLines.push(`Generated: ${fmtDateTime(new Date().toISOString())}`);
      noteLines.push("");
      noteLines.push(`Triage: ${tri.level}`);
      for (const r of tri.reasons) noteLines.push(`- ${r}`);
      noteLines.push("");

      noteLines.push(`Episode-of-care (Encounter) check (demo):`);
      noteLines.push(`- Most recent encounter: ${fmtDateTime(lastEnc)}`);
      noteLines.push(`- Validation: timestamps are within the same care window: DEMO CHECK (upgrade to real episode logic).`);
      noteLines.push("");

      noteLines.push(`Data completeness check (last ${rules.completenessHours} hours):`);
      if (miss.length === 0) {
        noteLines.push(`- Complete: all key vitals present.`);
      } else {
        noteLines.push(`- Missing: ${miss.map(missingLabel).join(", ")}.`);
        noteLines.push(`- Action: trigger “data completeness” flag for clinical review.`);
      }
      noteLines.push("");

      noteLines.push(`Top active problems (Conditions) (demo):`);
      if (!selectedCond?.length) noteLines.push(`- None returned by server.`);
      else selectedCond.slice(0, 5).forEach((c) => noteLines.push(`- ${firstCodingDisplay(c?.code)}`));
      noteLines.push("");

      noteLines.push(`Current medications (MedicationRequest) (demo):`);
      if (!selectedMeds?.length) noteLines.push(`- None returned by server.`);
      else selectedMeds.slice(0, 5).forEach((m) => noteLines.push(`- ${firstCodingDisplay(m?.medicationCodeableConcept)}`));
      noteLines.push("");

      noteLines.push(`AI next actions (demo):`);
      noteLines.push(`- Validate timestamps align to an episode of care (Encounter).`);
      noteLines.push(`- Check missing vitals and raise a data completeness flag.`);
      noteLines.push(`- Surface Conditions + MedicationRequests in one timeline view.`);
      noteLines.push(`- Provide rule-based triage suggestions and export this note to PDF (Portable Document Format).`);

      setAiNote(noteLines.join("\n"));
      addAudit("Generated AI note", `Patient/${pid} triage ${tri.level}`);
    } finally {
      setAiBusy(false);
    }
  }

  /* ---------- UI components ---------- */
  function TriagePill({ level }) {
    const cls =
      level === "RED" ? "pillRed" : level === "AMBER" ? "pillAmber" : level === "GREEN" ? "pillGreen" : "pillUnknown";
    return <span className={`triagePill ${cls}`}>{level}</span>;
  }

  function WorklistRow({ p, snap }) {
    const active = p.id === selectedPatientId;
    const name = getPatientDisplayName(p);
    const phone = getPatientPhone(p);
    const gender = getPatientGender(p);
    const dob = getPatientDOB(p);

    const tri = snap?.triage || "UNKNOWN";
    const missing = snap?.missing || [];
    const lastEnc = snap?.lastEncounter || null;

    return (
      <div
        className={`wRow ${active ? "wRowActive" : ""}`}
        onClick={() => {
          setSelectedPatientId(p.id);
          setView("worklist");
          addAudit("Selected patient from worklist", `Patient/${p.id}`);
        }}
        role="button"
        tabIndex={0}
      >
        <div className="wLeft">
          <div className="wTitle">
            <div className="wName">{name}</div>
            <div className="wBadges">
              <TriagePill level={tri} />
              {missing.length > 0 ? <span className="flagMissing">Missing data</span> : <span className="flagOk">Complete</span>}
            </div>
          </div>

          <div className="wSub">
            <span className="wMeta">Patient/{p.id}</span>
            <span className="wDot">•</span>
            <span className="wMeta">{gender}</span>
            <span className="wDot">•</span>
            <span className="wMeta">{dob}</span>
          </div>

          <div className="wMiniGrid">
            <div className="miniCell">
              <div className="miniLabel">Blood pressure</div>
              <div className="miniVal">
                {typeof snap?.vitalsLatest?.bpSys === "number" ? `${snap.vitalsLatest.bpSys}/${safe(snap.vitalsLatest.bpDia, "—")}` : "—"}
                <span className="miniUnit"> mmHg</span>
              </div>
              <div className="miniSpark">
                <Sparkline values={snap?.spark?.bpSys || []} />
              </div>
            </div>

            <div className="miniCell">
              <div className="miniLabel">Heart rate</div>
              <div className="miniVal">
                {typeof snap?.vitalsLatest?.hr === "number" ? snap.vitalsLatest.hr : "—"}
                <span className="miniUnit"> bpm</span>
              </div>
              <div className="miniSpark">
                <Sparkline values={snap?.spark?.hr || []} />
              </div>
            </div>

            <div className="miniCell">
              <div className="miniLabel">Temperature</div>
              <div className="miniVal">
                {typeof snap?.vitalsLatest?.temp === "number" ? snap.vitalsLatest.temp : "—"}
                <span className="miniUnit"> °C</span>
              </div>
              <div className="miniSpark">
                <Sparkline values={snap?.spark?.temp || []} />
              </div>
            </div>

            <div className="miniCell">
              <div className="miniLabel">Oxygen saturation</div>
              <div className="miniVal">
                {typeof snap?.vitalsLatest?.spo2 === "number" ? snap.vitalsLatest.spo2 : "—"}
                <span className="miniUnit"> %</span>
              </div>
              <div className="miniSpark">
                <Sparkline values={snap?.spark?.spo2 || []} />
              </div>
            </div>
          </div>
        </div>

        <div className="wRight">
          <div className="wRightLine">
            <span className="wRightKey">Phone</span>
            <span className="wRightVal">{phone}</span>
          </div>
          <div className="wRightLine">
            <span className="wRightKey">Last encounter</span>
            <span className="wRightVal">{fmtDateTime(lastEnc)}</span>
          </div>
          <div className="wRightLine">
            <span className="wRightKey">Conditions</span>
            <span className="wRightVal">{safe(snap?.counts?.conditions, "—")}</span>
          </div>
          <div className="wRightLine">
            <span className="wRightKey">Medication</span>
            <span className="wRightVal">{safe(snap?.counts?.meds, "—")}</span>
          </div>
        </div>
      </div>
    );
  }

  function PatientDetailsPanel({ compact = false }) {
    const p = selectedPatient;
    if (!p) return (
      <div className="card cardPad">
        <div className="bigAiTitle">AI clinical assistant (demo)</div>
        <div className="subtle">Select a patient to view the clinical story.</div>
      </div>
    );

    const name = getPatientDisplayName(p);
    const pid = p.id;
    const tri = selectedTriage;
    const miss = selectedMissing;

    return (
      <div className="card cardPad">
        <div className="detailsHeader">
          <div className="sectionTitle">Patient details</div>
          <div className="detailsName">{name}</div>
          <div className="subtle">Patient/{pid}</div>
        </div>

        <div className="kvRow">
          <div className="kv"><span>Gender</span>{getPatientGender(p)}</div>
          <div className="kv"><span>Date of birth</span>{getPatientDOB(p)}</div>
        </div>

        <div className="aiCockpit">
          <div className="bigAiTitle">AI clinical assistant (demo)</div>
          <div className="aiSub">Rule-based triage + episode-of-care checks + data completeness + exportable AI note</div>

          <div className="aiAlertBlock">
            <div className="aiBlockTitle">AI alerts (high visibility)</div>

            <div className="aiAlertRow">
              <TriagePill level={tri.level} />
              <div className="aiAlertText">
                <div className="aiAlertHeadline">Triage status: {tri.level}</div>
                <div className="aiAlertSmall">{tri.reasons?.[0] || "—"}</div>
              </div>
            </div>

            <div className="aiAlertRow">
              <span className={`dotDot ${miss.length ? "dotRed" : "dotGreen"}`} />
              <div className="aiAlertText">
                <div className="aiAlertHeadline">
                  Data completeness flag: {miss.length ? "missing recent vitals" : "complete"}
                </div>
                <div className="aiAlertSmall">
                  {miss.length ? `${miss.map(missingLabel).join(", ")} in last ${rules.completenessHours} hours.` : "All key vitals present."}
                </div>
              </div>
            </div>
          </div>

          <div className="aiActionsCard">
            <div className="aiBlockTitle">AI next actions (what the system recommends)</div>
            <ul className="aiList">
              <li>Check missing vitals and trigger a data completeness flag for clinical review.</li>
              <li>Surface top active Conditions and current MedicationRequests in a single timeline view.</li>
              <li>Add rule-based triage suggestions and export an AI note to PDF (Portable Document Format).</li>
            </ul>
          </div>

          <div className="aiButtonsRow">
            <button className="aiBtnBig" onClick={generateAiSummary} disabled={aiBusy || !selectedPatientId}>
              {aiBusy ? "Generating…" : "Generate AI summary"}
            </button>

            <button
              className="aiBtnGhost"
              onClick={() => exportAiNoteToPdf(aiNoteRef.current, `AI_note_${pid}.pdf`)}
              disabled={!aiNote || aiBusy}
              title="Downloads a PDF directly (no browser popup)."
            >
              Export AI note to PDF (Portable Document Format)
            </button>
          </div>

          <div className="aiNoteBox" ref={aiNoteRef}>
            <div className="aiNoteTitle">AI note</div>
            <div className="aiNoteText">{aiNote || "Click “Generate AI summary” to produce a board-ready AI note."}</div>
          </div>

          {!compact && (
            <>
              <div className="storyHeader">
                <div className="aiBlockTitle">Patient story timeline (Encounter + Conditions + MedicationRequest + Observations)</div>
                <div className="countText">{storyItems.length} items</div>
              </div>

              <div className="storyList">
                {storyItems.map((it) => {
                  const open = !!expandedWhy[it.id];
                  return (
                    <div className="storyItem" key={it.id}>
                      <div className="storyLeft">
                        <div className="storyKind">{it.kind}</div>
                        <div className="storyTitle">{it.title}</div>
                        <div className="storyWhen">{fmtDateTime(it.when)}</div>
                      </div>
                      <div className="storyRight">
                        <TriagePill level={it.triage} />
                        <button
                          className="whyBtn"
                          onClick={() => setExpandedWhy((prev) => ({ ...prev, [it.id]: !prev[it.id] }))}
                        >
                          Explain why
                        </button>
                        {open && (
                          <div className="whyPanel">
                            {(it.why || []).slice(0, 4).map((w, i) => (
                              <div className="whyLine" key={i}>• {w}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="govCard">
            <div className="bigAiTitle">Governance & model card</div>
            <div className="govGrid">
              <div className="govItem"><div className="govKey">Model</div><div className="govVal">{modelVersion}</div></div>
              <div className="govItem"><div className="govKey">Last reviewed</div><div className="govVal">{modelReviewed}</div></div>
              <div className="govItem"><div className="govKey">Data sources</div><div className="govVal">FHIR server (Fast Healthcare Interoperability Resources) demo data</div></div>
              <div className="govItem"><div className="govKey">Clinician override</div><div className="govVal">Supported (upgrade: explicit override + reason)</div></div>
            </div>
            <div className="govNote">
              Upgrade path: replace rules with a real model + audit trail, versioning, clinician override, and monitoring.
            </div>

            <div className="auditTitle">Audit trail (demo)</div>
            <div className="auditList">
              {audit.length === 0 ? (
                <div className="subtle">No events yet.</div>
              ) : (
                audit.slice(0, 8).map((a, i) => (
                  <div className="auditRow" key={i}>
                    <div className="auditTs">{fmtDateTime(a.ts)}</div>
                    <div className="auditBody">
                      <div className="auditAction">{a.action}</div>
                      <div className="auditDetails">{a.details}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- Layout ---------- */
  return (
    <div className="page">
      <div className="shell">
        <div className="topBar">
          <div className="brandLeft">
            <div className="brandTitle">Clinical FHIR Integration Demo</div>
            <div className="brandMeta">
              FHIR (Fast Healthcare Interoperability Resources) R4 (Release 4) • React + Vite • Public server: {FHIR_BASE_DEFAULT}
            </div>
          </div>

          <div className="pills">
            <button className={`navPill ${view === "worklist" ? "navPillActive" : ""}`} onClick={() => setView("worklist")}>
              Worklist (AI)
            </button>
            <button className={`navPill ${view === "patient" ? "navPillActive" : ""}`} onClick={() => setView("patient")}>
              Patient view
            </button>
            <button className={`navPill ${view === "governance" ? "navPillActive" : ""}`} onClick={() => setView("governance")}>
              Governance & audit
            </button>

            <a className="pill linkPill" href={FHIR_BASE_DEFAULT} target="_blank" rel="noreferrer">
              Test server
            </a>
          </div>
        </div>

        <div className="card cardPad" style={{ marginTop: 14 }}>
          <div className="h1">Patient search</div>
          <div className="subtle">
            Live FHIR REST (Representational State Transfer) calls returning FHIR JSON (JavaScript Object Notation) bundles, rendered into a clinical-style interface.
          </div>

          <div className="badgesRow">
            <span className="badge"><span className="dot dotGreen" /> Public demo data</span>
            <span className="badge"><span className="dot" /> Standards-based integration</span>
            <span className="badge"><span className="dot dotAmber" /> Deployed on Cloudflare Pages</span>
          </div>

          <div className="searchGrid">
            <div>
              <div className="label">Name contains</div>
              <input className="input" value={nameQuery} onChange={(e) => setNameQuery(e.target.value)} />
            </div>

            <div>
              <div className="label">Count</div>
              <input
                className="input"
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(clamp(Number(e.target.value || 10), 1, 50))}
              />
            </div>

            <button className="button" onClick={searchPatients} disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </button>
          </div>

          {error ? <div className="errorBox">{error}</div> : null}
        </div>

        {/* MAIN */}
        {view === "governance" ? (
          <div className="mainGridSingle">
            <PatientDetailsPanel compact={false} />
          </div>
        ) : view === "patient" ? (
          <div className="mainGrid" style={{ marginTop: 14 }}>
            <div className="card list">
              <div className="listHeader">
                <div className="sectionTitle">Results</div>
                <div className="countText">{patients.length} patient(s)</div>
              </div>

              {patients.map((p) => {
                const active = p.id === selectedPatientId;
                return (
                  <div
                    className={`row ${active ? "rowActive" : ""}`}
                    key={p.id}
                    onClick={() => setSelectedPatientId(p.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div>
                      <div className="name">{getPatientDisplayName(p)}</div>
                      <div className="small">Patient/{p.id}</div>
                      <div className="phone">📞 Phone: {getPatientPhone(p)}</div>
                    </div>
                    <div className="metaRight">
                      <div>{getPatientGender(p)} • {getPatientDOB(p)}</div>
                      <div>Identifier: {getPatientIdentifier(p)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <PatientDetailsPanel compact={false} />
          </div>
        ) : (
          // WORKLIST MODE (AI cockpit)
          <div className="worklistGrid" style={{ marginTop: 14 }}>
            <div className="card cardPad">
              <div className="worklistTop">
                <div>
                  <div className="bigAiTitle">AI triage worklist</div>
                  <div className="subtle">Queue intelligence view: risk flags, missing-data flags, and quick patient preview.</div>
                </div>

                <div className="kpiRow">
                  <div className="kpi"><div className="kpiKey">RED</div><div className="kpiVal">{worklistStats.RED}</div></div>
                  <div className="kpi"><div className="kpiKey">AMBER</div><div className="kpiVal">{worklistStats.AMBER}</div></div>
                  <div className="kpi"><div className="kpiKey">GREEN</div><div className="kpiVal">{worklistStats.GREEN}</div></div>
                  <div className="kpi"><div className="kpiKey">Missing data</div><div className="kpiVal">{worklistStats.MISSING}</div></div>
                </div>
              </div>

              <div className="worklistControls">
                <div className="chipGroup">
                  {["ALL", "RED", "AMBER", "GREEN", "MISSING"].map((x) => (
                    <button
                      key={x}
                      className={`chip ${worklistFilter === x ? "chipActive" : ""}`}
                      onClick={() => setWorklistFilter(x)}
                    >
                      {x === "ALL" ? "All" : x === "MISSING" ? "Missing data" : x}
                    </button>
                  ))}
                </div>

                <div className="sortGroup">
                  <span className="sortLabel">Sort</span>
                  <select className="select" value={sortMode} onChange={(e) => setSortMode(e.target.value)}>
                    <option value="RISK">Risk</option>
                    <option value="RECENT">Most recent encounter</option>
                    <option value="NAME">Name</option>
                  </select>
                </div>
              </div>

              <div className="worklistList">
                {filteredWorklist.map(({ p, snap }) => (
                  <WorklistRow key={p.id} p={p} snap={snap} />
                ))}
              </div>
            </div>

            <div className="stickyRight">
              <PatientDetailsPanel compact={true} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
