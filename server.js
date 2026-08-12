require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const dashboardClients = new Set();

const BASEROW_URL = (process.env.BASEROW_URL || "").replace(/\/$/, "");
const BASEROW_TABLE_ID = process.env.BASEROW_TABLE_ID;
const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
const INCIDENTS_WEBHOOK_SECRET = process.env.INCIDENTS_WEBHOOK_SECRET;

if (!BASEROW_URL || !BASEROW_TABLE_ID || !BASEROW_TOKEN) {
  console.error(
    "Fehler: BASEROW_URL, BASEROW_TABLE_ID oder BASEROW_TOKEN fehlt in der .env."
  );
  process.exit(1);
}

app.use(express.json());

// Dashboard: Dateiname innerhalb der Anwendung bleibt unverändert
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "stoerungsmeldung-dashboard.html"));
});

app.get("/stoerungsmeldung-dashboard.html", (req, res) => {
  res.sendFile(path.join(__dirname, "stoerungsmeldung-dashboard.html"));
});

// Formular: Dateiname innerhalb der Anwendung bleibt unverändert
app.get("/formular", (req, res) => {
  res.sendFile(path.join(__dirname, "stoerungsmeldung-frontend.html"));
});

app.get("/stoerungsmeldung-frontend.html", (req, res) => {
  res.sendFile(path.join(__dirname, "stoerungsmeldung-frontend.html"));
});

// SSE-Verbindung für geöffnete Dashboards
app.get("/api/incidents/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  res.write(
    `event: connected\ndata: ${JSON.stringify({
      connectedAt: new Date().toISOString(),
    })}\n\n`
  );

  dashboardClients.add(res);

  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    dashboardClients.delete(res);
  });
});

// n8n ruft diesen Endpunkt nach erfolgreichem Incident-Insert auf
app.post("/api/incidents/changed", (req, res) => {
  if (
    INCIDENTS_WEBHOOK_SECRET &&
    req.query.token !== INCIDENTS_WEBHOOK_SECRET
  ) {
    return res.sendStatus(401);
  }

  const event = `event: incidents-changed\ndata: ${JSON.stringify({
    changedAt: new Date().toISOString(),
    event: "incident-created",
    source: "n8n",
  })}\n\n`;

  for (const client of dashboardClients) {
    client.write(event);
  }

  return res.sendStatus(204);
});

function isTrue(value) {
  return value === true || value === "true" || value === "Ja";
}

function getPriority(urgentManual, aiUrgency) {
  const aiLevel = String(aiUrgency || "").trim().toLowerCase();

  if (urgentManual || aiLevel === "hoch") {
    return "urgent";
  }

  if (aiLevel === "mittel") {
    return "review";
  }

  return "normal";
}

function mapIncident(row) {
  const urgent =
    isTrue(row.urgent) ||
    isTrue(row["Dringende Störung"]) ||
    isTrue(row["Dringend"]);

  const aiUrgency =
    row.aiUrgency || row["KI-Dringlichkeit"] || row["KI Dringlichkeit"] || null;

  return {
    id: row.id ? `INC-${row.id}` : null,
    objectNumber: row.objectNumber || row["Objektnummer"] || null,
    reporterName: row.reporterName || row["Name"] || row["Melder"] || null,
    title: row.title || row["Überschrift"] || row["Titel"] || null,
    description: row.description || row["Beschreibung"] || null,
    incidentType: row.incidentType || row["Störungstyp"] || null,
    incidentDate: row.incidentDate || row["Ereignisdatum"] || null,
    incidentTime: row.incidentTime || row["Ereigniszeit"] || null,
    submittedAt:
      row.submittedAt || row["Eingegangen am"] || row["submitted_at"] || null,
    objectName: row.objectName || row["Objektname"] || row["Objekt"] || null,
    city: row.city || row["Stadt"] || row["Ort"] || null,
    urgent,
    aiUrgency,
    priority: getPriority(urgent, aiUrgency),
    originalText: row.originalText || row["Originaltext"] || null,
  };
}

// API-Endpunkt für das Dashboard
app.get("/api/incidents", async (req, res) => {
  try {
    const baserowEndpoint =
      `${BASEROW_URL}/api/database/rows/table/` +
      `${BASEROW_TABLE_ID}/` +
      `?user_field_names=true&size=200`;

    const response = await fetch(baserowEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Token ${BASEROW_TOKEN}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Baserow-Fehler:", response.status, errorText);
      return res.status(response.status).json({
        status: "error",
        message: "Baserow konnte die Meldungen nicht liefern.",
      });
    }

    const data = await response.json();
    const incidents = Array.isArray(data.results)
      ? data.results.map(mapIncident)
      : [];

    res.json(incidents);
  } catch (error) {
    console.error("Server-Fehler:", error);
    res.status(500).json({
      status: "error",
      message: "Incident Reports konnten nicht geladen werden.",
    });
  }
});

// Objektsuche für das Formular
app.get("/api/objects", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();

    if (query.length < 2) {
      return res.json([]);
    }

    const baserowEndpoint =
      `${BASEROW_URL}/api/database/rows/table/${BASEROW_TABLE_ID}/` +
      `?user_field_names=true&size=200`;

    const response = await fetch(baserowEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Token ${BASEROW_TOKEN}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Baserow-Fehler bei Objektsuche:", response.status, errorText);
      return res.status(response.status).json({
        status: "error",
        message: "Baserow konnte die Objekte nicht liefern.",
      });
    }

    const data = await response.json();
    const rows = Array.isArray(data.results) ? data.results : [];

    const objects = rows
      .map((row) => ({
        objectNumber: row.objectNumber || row["Objektnummer"] || null,
        objectName: row.objectName || row["Objektname"] || row["Objekt"] || null,
        city: row.city || row["Stadt"] || null,
      }))
      .filter((obj) => obj.objectNumber);

    res.json(objects);
  } catch (error) {
    console.error("Server-Fehler bei Objektsuche:", error);
    res.status(500).json({
      status: "error",
      message: "Objekte konnten nicht geladen werden.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard läuft auf http://localhost:${PORT}`);
  console.log(`Formular läuft auf http://localhost:${PORT}/formular`);
});
