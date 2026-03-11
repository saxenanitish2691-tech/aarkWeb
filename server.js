const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const tls = require("tls");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const HTML_FILE = path.join(ROOT_DIR, "abc.html");
const DATA_DIR = path.join(ROOT_DIR, "data");
const LEADS_FILE = path.join(DATA_DIR, "submissions.jsonl");
const BROCHURE_DIR = path.join(ROOT_DIR, "brochures");
const BROCHURE_MANIFEST_FILE = path.join(BROCHURE_DIR, "manifest.json");

loadEnv(path.join(ROOT_DIR, ".env"));

const OWNER_EMAIL = process.env.OWNER_EMAIL || "saxena.nitish2691@gmail.com";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || OWNER_EMAIL;
const NOTIFY_EMAILS = Array.from(
  new Set(
    [OWNER_EMAIL, SMTP_FROM, process.env.NOTIFY_EMAILS || ""]
      .join(",")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )
);

let propertiesCache = [];
let propertiesCacheMtime = 0;

ensureDir(DATA_DIR);
ensureDir(BROCHURE_DIR);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = requestUrl;

    if (req.method === "GET" && (pathname === "/" || pathname === "/abc.html")) {
      return serveFile(res, HTML_FILE, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        smtpConfigured: Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS),
        ownerEmail: OWNER_EMAIL,
      });
    }

    if (req.method === "GET" && pathname.startsWith("/api/brochure/")) {
      const propId = pathname.split("/").pop();
      return handleBrochureDownload(res, propId);
    }

    if (req.method === "POST" && pathname === "/api/leads") {
      const payload = await readJsonBody(req);
      return handleSubmission(res, "lead", payload);
    }

    if (req.method === "POST" && pathname === "/api/contact") {
      const payload = await readJsonBody(req);
      return handleSubmission(res, "contact", payload);
    }

    if (req.method === "POST" && pathname === "/api/careers") {
      const payload = await readJsonBody(req);
      return handleSubmission(res, "career", payload);
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error("Request failed:", error);
    sendJson(res, 500, { ok: false, error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

async function handleSubmission(res, kind, payload) {
  const cleanPayload = sanitizePayload(payload);
  const validationError = validatePayload(kind, cleanPayload);

  if (validationError) {
    return sendJson(res, 400, { ok: false, error: validationError });
  }

  const submission = {
    kind,
    createdAt: new Date().toISOString(),
    ...cleanPayload,
  };

  appendJsonLine(LEADS_FILE, submission);

  let mailed = false;
  let mailWarning = "";

  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    try {
      await sendNotificationEmail(submission);
      mailed = true;
    } catch (error) {
      console.error("Email send failed:", error);
      mailWarning = "Submission saved locally but email notification failed.";
    }
  } else {
    mailWarning = "SMTP is not configured. Submission saved locally only.";
  }

  sendJson(res, 200, { ok: true, mailed, warning: mailWarning });
}

async function handleBrochureDownload(res, propId) {
  const property = getAllProperties().find((item) => String(item.id) === String(propId));

  if (!property) {
    return sendJson(res, 404, { ok: false, error: "Property not found" });
  }

  const storedBrochure = getStoredBrochure(property);
  if (storedBrochure) {
    return serveFile(res, storedBrochure.filePath, "application/pdf", {
      "Content-Disposition": `attachment; filename="${storedBrochure.downloadName}"`,
      "Cache-Control": "no-store",
    });
  }

  const pdfBuffer = buildBrochurePdf(property);
  const fileName = slugify(property.title || `property-${propId}`) + ".pdf";

  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Content-Length": pdfBuffer.length,
    "Cache-Control": "no-store",
  });
  res.end(pdfBuffer);
}

function getAllProperties() {
  const stats = fs.statSync(HTML_FILE);
  if (propertiesCache.length && stats.mtimeMs === propertiesCacheMtime) {
    return propertiesCache;
  }

  const html = fs.readFileSync(HTML_FILE, "utf8");
  const start = html.indexOf("const properties = [");
  const end = html.indexOf("const services = [");

  if (start === -1 || end === -1) {
    throw new Error("Could not extract property data from abc.html");
  }

  const snippet = html.slice(start, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}
    globalThis.__allProps = [...properties, ...internationalProperties];`,
    sandbox
  );

  propertiesCache = JSON.parse(JSON.stringify(sandbox.__allProps || []));
  propertiesCacheMtime = stats.mtimeMs;
  return propertiesCache;
}

function getStoredBrochure(property) {
  const manifest = readBrochureManifest();
  const manifestEntry =
    manifest[String(property.id)] ||
    manifest[property.title] ||
    manifest[slugify(property.title)];

  if (!manifestEntry) {
    return null;
  }

  const relativePath = typeof manifestEntry === "string" ? manifestEntry : manifestEntry.file;
  if (!relativePath) {
    return null;
  }

  const resolvedPath = path.resolve(BROCHURE_DIR, relativePath);
  if (!resolvedPath.startsWith(BROCHURE_DIR) || !fs.existsSync(resolvedPath)) {
    return null;
  }

  return {
    filePath: resolvedPath,
    downloadName: (typeof manifestEntry === "object" && manifestEntry.downloadName) || path.basename(resolvedPath),
  };
}

function readBrochureManifest() {
  if (!fs.existsSync(BROCHURE_MANIFEST_FILE)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(BROCHURE_MANIFEST_FILE, "utf8"));
  } catch (error) {
    console.error("Could not read brochure manifest:", error);
    return {};
  }
}

function buildBrochurePdf(property) {
  const lines = [
    "Aark Realty Property Brochure",
    "",
    `Property: ${safeText(property.title)}`,
    `Location: ${safeText(property.location)}`,
    `City: ${safeText(property.city)}`,
    `Country: ${safeText(property.country || "India")}`,
    `Type: ${safeText(property.type)}`,
    `Status: ${safeText(property.status)}`,
    `Price: ${formatPrice(property)}`,
    `Area: ${safeText(String(property.area || "N/A"))} sq.ft`,
    `Bedrooms: ${safeText(String(property.bedrooms ?? "N/A"))}`,
    `Bathrooms: ${safeText(String(property.bathrooms ?? "N/A"))}`,
    "",
    "Description:",
    safeText(property.description || ""),
    "",
    "Highlights:",
    ...(Array.isArray(property.highlights) && property.highlights.length
      ? property.highlights.map((item) => `- ${safeText(item)}`)
      : ["- N/A"]),
    "",
    "Amenities:",
    ...(Array.isArray(property.amenities) && property.amenities.length
      ? property.amenities.map((item) => `- ${safeText(item)}`)
      : ["- N/A"]),
    "",
    "Contact:",
    "Aark Realty",
    "Phone: +91 9818897217",
    "Email: info@aarkrealty.com",
  ];

  return createSimplePdf(lines);
}

function createSimplePdf(lines) {
  const objects = [];
  let currentY = 780;
  const textCommands = [];

  for (const line of lines) {
    if (currentY < 60) {
      break;
    }
    const escaped = escapePdfText(line);
    textCommands.push(`BT /F1 12 Tf 50 ${currentY} Td (${escaped}) Tj ET`);
    currentY -= line === "" ? 12 : 18;
  }

  const contentStream = textCommands.join("\n");

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  objects.push(`<< /Length ${Buffer.byteLength(contentStream, "utf8")} >>\nstream\n${contentStream}\nendstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

async function sendNotificationEmail(submission) {
  const subjectMap = {
    lead: "New property enquiry",
    contact: "New contact form enquiry",
    career: "New career application",
  };

  const bodyLines = [
    `A new ${submission.kind} submission was received.`,
    "",
    `Date: ${submission.createdAt}`,
    `Name: ${submission.name || "N/A"}`,
    `Email: ${submission.email || "N/A"}`,
    `Phone: ${submission.phone || "N/A"}`,
    `Lead Type: ${submission.lead_type || "N/A"}`,
    `Property ID: ${submission.property_id || "N/A"}`,
    `Property Title: ${submission.property_title || "N/A"}`,
    `Subject: ${submission.subject || "N/A"}`,
    `Position: ${submission.position || "N/A"}`,
    `Experience: ${submission.experience || "N/A"}`,
    `Current Company: ${submission.currentCompany || "N/A"}`,
    `Resume URL: ${submission.resumeUrl || "N/A"}`,
    "",
    "Message:",
    submission.message || submission.coverLetter || "N/A",
  ];

  for (const recipient of NOTIFY_EMAILS) {
    await sendEmail({
      host: SMTP_HOST,
      port: SMTP_PORT,
      user: SMTP_USER,
      pass: SMTP_PASS,
      from: SMTP_FROM,
      to: recipient,
      subject: subjectMap[submission.kind] || "New website submission",
      text: bodyLines.join("\r\n"),
    });
  }
}

function sendEmail({ host, port, user, pass, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
      },
      () => {
        runSmtpConversation(socket, { user, pass, from, to, subject, text })
          .then(resolve)
          .catch(reject);
      }
    );

    socket.setEncoding("utf8");
    socket.on("error", reject);
  });
}

function runSmtpConversation(socket, message) {
  const steps = [
    { expect: 220, send: `EHLO localhost` },
    { expect: 250, send: `AUTH LOGIN` },
    { expect: 334, send: Buffer.from(message.user).toString("base64") },
    { expect: 334, send: Buffer.from(message.pass).toString("base64") },
    { expect: 235, send: `MAIL FROM:<${message.from}>` },
    { expect: 250, send: `RCPT TO:<${message.to}>` },
    { expect: 250, send: `DATA` },
    { expect: 354, send: buildMimeMessage(message) + "\r\n." },
    { expect: 250, send: `QUIT` },
    { expect: 221, send: null },
  ];

  let stepIndex = 0;
  let buffer = "";
  let settled = false;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("SMTP timeout"));
      }
    }, 20000);

    function finishWithError(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    }

    function finishSuccessfully() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.end();
      resolve();
    }

    function processLine(line) {
      if (!line) {
        return;
      }

      const match = line.match(/^(\d{3})([\s-])(.*)$/);
      if (!match) {
        return;
      }

      const code = Number(match[1]);
      const separator = match[2];
      const currentStep = steps[stepIndex];

      if (!currentStep) {
        return finishSuccessfully();
      }

      if (String(code).startsWith("4") || String(code).startsWith("5")) {
        return finishWithError(new Error(`SMTP error: ${line}`));
      }

      if (separator === "-") {
        return;
      }

      if (code !== currentStep.expect) {
        return finishWithError(new Error(`Unexpected SMTP response. Expected ${currentStep.expect}, got ${line}`));
      }

      if (currentStep.send === null) {
        return finishSuccessfully();
      }

      socket.write(currentStep.send + "\r\n");
      stepIndex += 1;
    }

    socket.on("data", (chunk) => {
      buffer += chunk;

      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        if (settled) {
          return;
        }
      }
    });

    socket.on("error", finishWithError);
    socket.on("end", () => {
      if (!settled && stepIndex < steps.length - 1) {
        finishWithError(new Error("SMTP connection closed before completion"));
      }
    });
  });
}

function buildMimeMessage({ from, to, subject, text }) {
  const normalizedText = text
    .replace(/\r?\n/g, "\r\n")
    .replace(/^\./gm, "..");

  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    normalizedText,
  ].join("\r\n");
}

function sanitizePayload(payload) {
  const clean = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (typeof value === "string") {
      clean[key] = value.trim().slice(0, 5000);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function validatePayload(kind, payload) {
  if (!payload.name) {
    return "Name is required.";
  }

  if (kind !== "lead" && !payload.email) {
    return "Email is required.";
  }

  if (!payload.phone) {
    return "Phone is required.";
  }

  if (kind === "contact" && !payload.message) {
    return "Message is required.";
  }

  if (kind === "career") {
    if (!payload.position || !payload.experience || !payload.resumeUrl) {
      return "Position, experience, and resume URL are required.";
    }
  }

  return "";
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON payload"));
      }
    });

    req.on("error", reject);
  });
}

function serveFile(res, filePath, contentType, extraHeaders = {}) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      return sendJson(res, 500, { ok: false, error: "Could not read file" });
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      ...extraHeaders,
    });
    res.end(content);
  });
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function appendJsonLine(filePath, data) {
  fs.appendFileSync(filePath, JSON.stringify(data) + "\n", "utf8");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function slugify(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "brochure";
}

function safeText(value) {
  return String(value || "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfText(value) {
  return safeText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function formatPrice(property) {
  if (property.currency === "AED" && property.priceAED) {
    return `AED ${Number(property.priceAED).toLocaleString("en-US")}`;
  }
  if (property.currency === "SGD" && property.priceSGD) {
    return `SGD ${Number(property.priceSGD).toLocaleString("en-US")}`;
  }
  if (property.price) {
    return `INR ${Number(property.price).toLocaleString("en-IN")}`;
  }
  return "On request";
}
