import { usePersistedState, usePersistedJSON } from "./usePersistedState.js";
import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import {
  ShieldCheck, FileText, Lock, Unlock, Printer, Sparkles,
  CheckCircle, UserCheck, Clipboard, Calendar, Quote,
  MousePointer2, Upload, X, File, Image, FolderOpen,
  AlertTriangle, Check, Eye, EyeOff, Key, Download, Loader2, ChevronDown, RefreshCw, Pencil,
  Save, Trash2
} from "lucide-react";

// CDN LIBRARY LOADER + API CONFIG
const OPENAI_API_ENDPOINT = "/api/chat"; // Works with both Vite proxy (local) and Vercel serverless function
const OPENAI_MODEL_OPTIONS = ["gpt-4o", "gpt-4o-mini"];
const OPENAI_MODEL_DEFAULT = "gpt-4o-mini";
const IS_LOCAL = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

/** Format ISO date (YYYY-MM-DD) to "Month Day, Year" e.g. "December 12, 2025" */
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Format array of ISO dates into smart grouped string.
 *  e.g. ["2025-12-12","2026-02-14","2026-02-15","2026-03-28"]
 *  → "December 12, 2025, February 14, 15, March 28, 2026" */
function formatTestingDates(dates) {
  const valid = (dates || []).filter(Boolean).sort();
  if (valid.length === 0) return "";
  const parsed = valid.map((iso) => {
    const d = new Date(iso + "T00:00:00");
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), iso };
  });
  const groups = [];
  let cur = null;
  for (const p of parsed) {
    if (cur && cur.y === p.y && cur.m === p.m) {
      cur.days.push(p.d);
    } else {
      cur = { y: p.y, m: p.m, days: [p.d] };
      groups.push(cur);
    }
  }
  // Build string: show year only when it changes or at end of group
  const parts = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const nextG = groups[i + 1];
    const showYear = !nextG || nextG.y !== g.y || i === groups.length - 1;
    const dayStr = g.days.join(", ");
    if (showYear) {
      parts.push(`${MONTH_NAMES[g.m]} ${dayStr}, ${g.y}`);
    } else {
      parts.push(`${MONTH_NAMES[g.m]} ${dayStr}`);
    }
  }
  return parts.join(", ");
}

/** DOMPurify — loaded from CDN for robust XSS sanitization of AI-generated HTML.
 *  Falls back to a strict regex strip if CDN fails (blocks all HTML in that case). */
import DOMPurifyLib from "dompurify";
let _DOMPurify = DOMPurifyLib;
async function ensureDOMPurify() {
  return _DOMPurify;
}

/** Load pdf.js library dynamically for client-side PDF text extraction */
let _pdfjsLib = null;
let _pdfjsLoadPromise = null;
async function ensurePdfJs() {
  if (_pdfjsLib) return _pdfjsLib;
  if (_pdfjsLoadPromise) return _pdfjsLoadPromise;
  _pdfjsLoadPromise = (async () => {
    try {
      // pdf.js loaded via dynamic ESM import — no script tag needed
      const mod = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
      _pdfjsLib = mod;
      if (_pdfjsLib.GlobalWorkerOptions) {
        _pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
      }
      return _pdfjsLib;
    } catch (e) {
      // pdf.js load failed
      _pdfjsLoadPromise = null;
      throw e;
    }
  })();
  return _pdfjsLoadPromise;
}

/** Load JSZip for client-side DOCX parsing */
let _jszip = null;
let _jszipPromise = null;
async function ensureJSZip() {
  if (_jszip) return _jszip;
  if (_jszipPromise) return _jszipPromise;
  _jszipPromise = (async () => {
    try {
      if (window.JSZip) { _jszip = window.JSZip; return _jszip; }
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
        s.onload = () => { _jszip = window.JSZip; resolve(_jszip); };
        s.onerror = () => reject(new Error("Failed to load JSZip"));
        document.head.appendChild(s);
      });
    } catch (e) {
      // JSZip load failed
      _jszipPromise = null;
      throw e;
    }
  })();
  return _jszipPromise;
}

/** Load Tesseract.js for client-side OCR */
let _tesseract = null;
let _tesseractPromise = null;
async function ensureTesseract() {
  if (_tesseract) return _tesseract;
  if (_tesseractPromise) return _tesseractPromise;
  _tesseractPromise = (async () => {
    try {
      if (window.Tesseract) { _tesseract = window.Tesseract; return _tesseract; }
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.5/tesseract.min.js";
        s.onload = () => { _tesseract = window.Tesseract; resolve(_tesseract); };
        s.onerror = () => reject(new Error("Failed to load Tesseract.js"));
        document.head.appendChild(s);
      });
    } catch (e) {
      // Tesseract load failed
      _tesseractPromise = null;
      throw e;
    }
  })();
  return _tesseractPromise;
}

/** Extract STRUCTURED data from PDF: pages → lines → items with coordinates.
 *  Returns { pages, fullText, numPages } where pages[i] = { pageNum, lines: [{y, items: [{x, text, width}]}], rawText }
 *  Also attaches .fullText for backward compat. PDF never leaves browser. */
async function parsePDFStructured(base64DataUrl, onProgress) {
  const pdfjsLib = await ensurePdfJs();
  const b64 = base64DataUrl.includes(",") ? base64DataUrl.split(",")[1] : base64DataUrl;
  if (!b64 || b64.length < 100) return { pages: [], fullText: "", numPages: 0 };
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

  const pages = [];
  for (let pg = 1; pg <= pdf.numPages; pg++) {
    onProgress?.(`Parsing page ${pg}/${pdf.numPages}...`);
    const page = await pdf.getPage(pg);
    const content = await page.getTextContent();

    // Collect all text items with positions
    const items = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      items.push({
        x: Math.round(item.transform[4] * 10) / 10,
        y: Math.round(item.transform[5] * 10) / 10,
        text: item.str,
        width: item.width || item.str.length * 5,
        height: item.height || 10,
        fontSize: Math.abs(item.transform[0]) || 10,
      });
    }

    // Group into lines by Y position (2px tolerance)
    const yBuckets = {};
    for (const item of items) {
      const yKey = Math.round(item.y / 2) * 2;
      if (!yBuckets[yKey]) yBuckets[yKey] = [];
      yBuckets[yKey].push(item);
    }

    // Sort lines top-to-bottom (PDF Y is bottom-up)
    const sortedYs = Object.keys(yBuckets).map(Number).sort((a, b) => b - a);
    const lines = sortedYs.map((y) => {
      const lineItems = yBuckets[y].sort((a, b) => a.x - b.x);
      return { y, items: lineItems };
    });

    // Build raw text per page
    const rawText = lines.map((line) => {
      let text = "";
      for (let i = 0; i < line.items.length; i++) {
        if (i > 0) {
          const gap = line.items[i].x - (line.items[i - 1].x + line.items[i - 1].width);
          text += gap > 15 ? "\t" : (gap > 3 ? "  " : "");
        }
        text += line.items[i].text;
      }
      return text;
    }).join("\n");

    pages.push({ pageNum: pg, lines, rawText });
  }

  const fullText = pages.map((p) => p.rawText).join("\n\n");
  if (fullText.length > 50) {
    onProgress?.(`PDF parsed: ${pdf.numPages} pages, ${fullText.length} chars — data stays in your browser`);
  } else {
    onProgress?.("PDF had very little extractable text. Paste scores manually in Assessment Notes.");
  }
  return { pages, fullText, numPages: pdf.numPages };
}

/** Backward-compat wrapper: returns flat text string (used by extractTextFromFile) */
async function extractPDFTextLocal(base64DataUrl, fileName, onProgress) {
  try {
    onProgress?.("Extracting text from PDF locally (private — nothing sent to server)...");
    const result = await parsePDFStructured(base64DataUrl, onProgress);
    return result.fullText || "";
  } catch (e) {
    // PDF extraction failed
    onProgress?.("PDF text extraction failed — paste scores manually in Assessment Notes.");
    return "";
  }
}

/** Parse DOCX into ordered paragraphs and structured tables using JSZip.
 *  Returns { paragraphs: [{text, style}], tables: [{rows: [[cell,...]]}], fullText } */
async function parseDocxStructured(base64DataUrl, onProgress) {
  const JSZip = await ensureJSZip();
  const b64 = base64DataUrl.includes(",") ? base64DataUrl.split(",")[1] : base64DataUrl;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  onProgress?.("Parsing DOCX structure...");
  const zip = await JSZip.loadAsync(bytes);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("No document.xml found in DOCX");

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXml, "application/xml");
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const body = xmlDoc.getElementsByTagNameNS(ns, "body")[0];
  if (!body) throw new Error("No body element in document.xml");

  const paragraphs = [];
  const tables = [];
  const fullTextParts = [];

  for (const child of body.children) {
    const tag = child.localName;
    if (tag === "p") {
      const runs = child.getElementsByTagNameNS(ns, "r");
      let text = "";
      for (const run of runs) {
        const tNodes = run.getElementsByTagNameNS(ns, "t");
        for (const t of tNodes) text += t.textContent || "";
      }
      const pPr = child.getElementsByTagNameNS(ns, "pPr")[0];
      const pStyle = pPr?.getElementsByTagNameNS(ns, "pStyle")[0];
      const style = pStyle?.getAttribute("w:val") || "";
      paragraphs.push({ text: text.trim(), style });
      if (text.trim()) fullTextParts.push(text.trim());
    }
    if (tag === "tbl") {
      const trs = child.getElementsByTagNameNS(ns, "tr");
      const tableRows = [];
      for (const tr of trs) {
        const tcs = tr.getElementsByTagNameNS(ns, "tc");
        const row = [];
        for (const tc of tcs) {
          const cellPs = tc.getElementsByTagNameNS(ns, "p");
          let cellText = "";
          for (const cp of cellPs) {
            const cRuns = cp.getElementsByTagNameNS(ns, "r");
            for (const run of cRuns) {
              const tNodes = run.getElementsByTagNameNS(ns, "t");
              for (const t of tNodes) cellText += t.textContent || "";
            }
          }
          row.push(cellText.trim());
        }
        tableRows.push(row);
      }
      tables.push({ rows: tableRows });
      for (const row of tableRows) fullTextParts.push(row.join("\t"));
    }
  }

  onProgress?.(`DOCX parsed: ${paragraphs.length} paragraphs, ${tables.length} tables`);
  return { paragraphs, tables, fullText: fullTextParts.join("\n") };
}

/** Run OCR on image using Tesseract.js. Returns { lines: [{text, bbox}], fullText } */
async function parseImageOCR(base64DataUrl, onProgress) {
  const Tesseract = await ensureTesseract();
  onProgress?.("Running OCR on image (this may take 30-60 seconds)...");
  const result = await Tesseract.recognize(base64DataUrl, "eng", {
    logger: (m) => {
      if (m.status === "recognizing text") {
        onProgress?.(`OCR progress: ${Math.round((m.progress || 0) * 100)}%`);
      }
    },
  });
  const lines = [];
  if (result.data?.lines) {
    for (const line of result.data.lines) {
      lines.push({ text: line.text.trim(), bbox: line.bbox || null, confidence: line.confidence || 0 });
    }
  }
  const fullText = lines.map((l) => l.text).join("\n");
  onProgress?.(`OCR complete: ${lines.length} lines extracted`);
  return { lines, fullText };
}

// ── PII DE-IDENTIFICATION LAYER ──
// Uses Case Info fields to automatically strip names, DOB, school from text before API calls.
// Tokens are swapped back client-side after AI response.

function buildPiiMap(meta) {
  const entries = [];
  const add = (text, token) => {
    const t = (text || "").trim();
    if (t.length < 2) return;
    entries.push({ text: t, token });
  };

  // Student name variants
  const fullName = (meta.fullName || "").trim();
  if (fullName) {
    const parts = fullName.split(/\s+/);
    const first = parts[0] || "";
    const last = parts[parts.length - 1] || "";
    // Full name first (longest match)
    add(fullName, "[STUDENT]");
    if (first && last && first !== last) {
      add(`${last}, ${first}`, "[STUDENT]");
      add(`${last},${first}`, "[STUDENT]");
      add(`${first[0]}. ${last}`, "[STUDENT]");
    }
    // Individual name parts
    if (last.length >= 2 && first !== last) add(last, "[LAST_NAME]");
    if (first.length >= 2) add(first, "[FIRST_NAME]");
  }

  // Date of birth — generate all common formats
  const dob = (meta.dob || "").trim();
  if (dob) {
    const parsed = new Date(dob + "T00:00:00");
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear(), m = parsed.getMonth(), d = parsed.getDate();
      const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      const monthsShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const mm = String(m + 1).padStart(2, "0"), dd = String(d).padStart(2, "0");
      add(`${months[m]} ${d}, ${y}`, "[DOB]");
      add(`${months[m]} ${dd}, ${y}`, "[DOB]");
      add(`${monthsShort[m]} ${d}, ${y}`, "[DOB]");
      add(`${monthsShort[m]} ${dd}, ${y}`, "[DOB]");
      add(`${months[m]} ${d} ${y}`, "[DOB]");
      add(`${mm}/${dd}/${y}`, "[DOB]");
      add(`${m + 1}/${d}/${y}`, "[DOB]");
      add(`${dd}/${mm}/${y}`, "[DOB]");
      add(`${y}-${mm}-${dd}`, "[DOB]");
      add(`${mm}-${dd}-${y}`, "[DOB]");
      add(`${d}/${m + 1}/${y}`, "[DOB]");
    }
    add(dob, "[DOB]");
  }

  // School name
  const school = (meta.school || "").trim();
  if (school && school.length >= 3) {
    add(school, "[SCHOOL]");
    // Also try without common suffixes
    const stripped = school.replace(/\s*(Public|Catholic|Elementary|Secondary|Middle|High|Junior|Senior)\s*(School|Academy)?\s*$/i, "").trim();
    if (stripped.length >= 3 && stripped !== school) add(stripped, "[SCHOOL]");
  }

  // Author name
  const author = (meta.author || "").trim();
  if (author && author.length >= 3) {
    add(author, "[AUTHOR]");
    // Without Dr. prefix
    const noDr = author.replace(/^(Dr\.?\s*|Mr\.?\s*|Mrs\.?\s*|Ms\.?\s*)/i, "").trim();
    if (noDr.length >= 3 && noDr !== author) add(noDr, "[AUTHOR]");
  }

  // Sort longest-first so "John Michael Smith" is replaced before "John"
  entries.sort((a, b) => b.text.length - a.text.length);

  // Build case-insensitive regex patterns
  return entries.map((e) => ({
    pattern: new RegExp(e.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
    token: e.token,
    original: e.text,
  }));
}

function deidentifyText(text, piiMap) {
  if (!text || !piiMap || piiMap.length === 0) return text;
  let result = text;
  for (const entry of piiMap) {
    result = result.replace(entry.pattern, entry.token);
  }
  return result;
}

function reidentifyText(text, meta) {
  if (!text || !meta) return text;
  let result = text;
  const fullName = (meta.fullName || "").trim();
  const parts = fullName.split(/\s+/);
  const first = parts[0] || "";
  const last = parts[parts.length - 1] || "";
  // Replace tokens back with real values
  if (fullName) result = result.replace(/\[STUDENT\]/g, fullName);
  if (first) {
    result = result.replace(/\[FIRST_NAME\]/g, first);
    result = result.replace(/\[firstName\]/g, first);
    result = result.replace(/\[first_name\]/gi, first);
    result = result.replace(/\[first name\]/gi, first);
  }
  if (last && last !== first) result = result.replace(/\[LAST_NAME\]/g, last);
  if (meta.dob) result = result.replace(/\[DOB\]/g, formatDate(meta.dob));
  if (meta.school) result = result.replace(/\[SCHOOL\]/g, meta.school);
  if (meta.author) result = result.replace(/\[AUTHOR\]/g, meta.author);
  // Safety net: replace any leftover neutral pronoun placeholders
  const pr = PRONOUN_MAP[meta.pronouns] || PRONOUN_MAP["he/him"];
  result = result.replace(/\[pronoun\]/gi, pr.subject);
  result = result.replace(/\[possessive\]/gi, pr.possessive);
  result = result.replace(/\[object\]/gi, pr.object);
  result = result.replace(/\[reflexive\]/gi, pr.reflexive);
  // Also catch any leftover gendered placeholder patterns from templates
  result = applyPronouns(result, meta.pronouns);
  // Safety: clean up any remaining AI-generated template placeholders
  // Remove bracketed template instructions like [specific range...], [exact percentile], etc.
  result = result.replace(/\[specific\s+range[^\]]*\]/gi, "___");
  result = result.replace(/\[exact\s+percentile[^\]]*\]/gi, "___");
  result = result.replace(/\[insert\s+[^\]]*\]/gi, "___");
  result = result.replace(/\[score[^\]]*\]/gi, "___");
  result = result.replace(/\[classification[^\]]*\]/gi, "___");
  result = result.replace(/\[percentile[^\]]*\]/gi, "___");
  result = result.replace(/\[range[^\]]*\]/gi, "___");
  return result;
}

/** Sanitize HTML to prevent XSS from AI-generated content.
 *  Uses DOMPurify when available; falls back to strict tag-stripping if not loaded. */
function sanitizeHTML(html) {
  if (_DOMPurify) {
    return _DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
        "p", "br", "span", "div", "b", "strong", "i", "em", "u", "sub", "sup",
        "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img",
      ],
      ALLOWED_ATTR: ["style", "class", "colspan", "rowspan", "src", "alt", "width", "height"],
      ALLOW_DATA_ATTR: false,
    });
  }
  // Fallback: strip ALL tags except a safe whitelist via DOM API if available
  if (typeof document !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Remove scripts, iframes, objects, embeds, links, event handlers
    doc.querySelectorAll("script, iframe, object, embed, link, style").forEach((el) => el.remove());
    doc.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith("on") || attr.value.includes("javascript:")) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return doc.body.innerHTML;
  }
  // Last resort: strip all HTML
  return html.replace(/<[^>]*>/g, "");
}

function loadScript(src) {
  return Promise.resolve(); // CDN scripts not available in artifact sandbox
}

const CDN = {};

const SS = { DRAFT: "draft", APPROVED: "approved" };

const DOC_CATEGORIES = [
  "Intake Questionnaire", "Background Information",
  "Cognitive Testing (WISC, WPPSI, WAIS)", "Academic Testing (WIAT)",
  "Memory and Learning (WRAML, CMS)", "Visual Motor Integration (Beery VMI)",
  "Adaptive Functioning (Vineland)",
  "Social Emotional Functioning (BASC, Conners, CBRS, MASC, CDI, GAD)",
  "Behavioural Observations", "Medical Reports",
  "School Reports and Report Cards", "Teacher Questionnaires",
  "Parent Questionnaires", "Previous Assessments", "Other Supporting Documents",
];

const SEC_CAT_MAP = {
  referral: ["Intake Questionnaire", "Background Information", "Previous Assessments"],
  background: ["Intake Questionnaire", "Background Information", "Medical Reports", "Previous Assessments", "Parent Questionnaires"],
  doc_review: ["Previous Assessments", "School Reports and Report Cards", "Parent Questionnaires", "Teacher Questionnaires", "Medical Reports"],
  observations: ["Behavioural Observations", "Teacher Questionnaires", "Parent Questionnaires"],
  cognitive: ["Cognitive Testing (WISC, WPPSI, WAIS)"],
  memory: ["Memory and Learning (WRAML, CMS)"],
  visual_motor: ["Visual Motor Integration (Beery VMI)"],
  social_emotional: ["Social Emotional Functioning (BASC, Conners, CBRS, MASC, CDI, GAD)", "Teacher Questionnaires", "Parent Questionnaires", "Medical Reports"],
  adaptive: ["Adaptive Functioning (Vineland)", "Teacher Questionnaires", "Parent Questionnaires"],
  academic: ["Academic Testing (WIAT)", "School Reports and Report Cards"],
  summary: DOC_CATEGORIES,
  strengths_needs: DOC_CATEGORIES,
  recommendations: DOC_CATEGORIES,
  appendix: DOC_CATEGORIES,
  appendix_tables: ["Cognitive Testing (WISC, WPPSI, WAIS)", "Academic Testing (WIAT)"],
};

// Auto-classify a document based on extracted text content and filename

/** Extract case info (name, DOB, grade, school, testing dates, pronouns) from report text.
 *  Handles Pearson Q-interactive/Q-global reports (WISC, WIAT, WRAML, Beery, BASC, Conners, Vineland)
 *  where PDF extraction produces space-separated or tab-separated fields without colons.
 *  Returns an object with only the fields that were confidently found. */
function extractCaseInfo(text) {
  if (!text || text.length < 50) return {};
  const info = {};
  const header = text.slice(0, 6000);

  // ── Student name ──
  const namePatterns = [
    // "Last, First Middle" (comma-separated, common in Pearson)
    new RegExp("(?:(?:examinee|student|child(?:'?s)?|client|patient|individual|name\\s*of\\s*(?:the\\s*)?(?:student|child|client|examinee))\\s*(?:name)?|(?:^|\\n)\\s*name)\\s*[:\\s=]+([A-Z][a-zà-ÿ]+,\\s*[A-Z][a-zà-ÿ]+(?:\\s+[A-Z][a-zà-ÿ]+)?)", "im"),
    // "First Last" (space-separated)
    new RegExp("(?:(?:examinee|student|child(?:'?s)?|client|patient|individual|name\\s*of\\s*(?:the\\s*)?(?:student|child|client|examinee))\\s*(?:name)?|(?:^|\\n)\\s*name)\\s*[:\\s=]+([A-Z][a-zà-ÿ]+\\s+[A-Z][a-zà-ÿ]+(?:\\s+[A-Z][a-zà-ÿ]+)?)", "im"),
    // Pearson header line: "Name" followed by name
    /\bName\b[\s:]+([A-Z][a-zà-ÿ]+(?:,\s*)?[A-Z][a-zà-ÿ]+(?:\s+[A-Z][a-zà-ÿ]+)?)/m,
    // "Examinee:" on its own line followed by name
    /(?:^|\n)\s*Examinee\s*[:\s]+([A-Z][a-zà-ÿ]+[\s,]+[A-Z][a-zà-ÿ]+(?:\s+[A-Z][a-zà-ÿ]+)?)/m,
    // Name of the student: ...
    /Name\s+of\s+(?:the\s+)?(?:student|child|client)\s*[:\s]+([A-Z][a-zà-ÿ]+\s+[A-Z][a-zà-ÿ]+(?:\s+[A-Z][a-zà-ÿ]+)?)/im,
  ];
  for (const re of namePatterns) {
    const m = header.match(re);
    if (m) {
      let name = m[1].trim();
      // Convert "Last, First" → "First Last"
      if (/^[A-Z][a-zà-ÿ]+,\s*[A-Z]/.test(name)) {
        const parts = name.split(/,\s*/);
        if (parts.length === 2) name = parts[1] + " " + parts[0];
      }
      // Reject if it looks like a test name or header
      if (!/WISC|WIAT|WRAML|BASC|Score|Report|Index|Test|Scale|Composite|Summary|Standard/i.test(name) && name.length >= 3) {
        info.fullName = name;
        break;
      }
    }
  }

  // ── Date of Birth ──
  const dobLabel = "(?:d\\.?o\\.?b\\.?|date\\s*of\\s*birth|birth\\s*date|born)";
  const dobPatterns = [
    // ISO: 2015-08-22
    new RegExp(dobLabel + "\\s*[:\\s=]+(\\d{4}[-/]\\d{1,2}[-/]\\d{1,2})", "i"),
    // Month Day, Year: August 22, 2015 or Aug 22 2015
    new RegExp(dobLabel + "\\s*[:\\s=]+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},?\\s+\\d{4})", "i"),
    // MM/DD/YYYY or DD/MM/YYYY
    new RegExp(dobLabel + "\\s*[:\\s=]+(\\d{1,2}[/-]\\d{1,2}[/-]\\d{4})", "i"),
    // Without label near header
    /(?:Date of Birth|DOB|D\.O\.B\.)\s+([\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i,
    // Pearson format: DOB followed by date on same line with possible tabs/spaces
    /(?:D\.?O\.?B\.?|Date\s*of\s*Birth)\s{2,}(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /(?:D\.?O\.?B\.?|Date\s*of\s*Birth)\s{2,}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4})/i,
  ];
  for (const re of dobPatterns) {
    const m = header.match(re);
    if (m) {
      const raw = m[1].trim();
      const d = new Date(raw);
      if (!isNaN(d.getTime()) && d.getFullYear() > 1970 && d.getFullYear() <= new Date().getFullYear()) {
        info.dob = d.toISOString().split("T")[0];
      }
      break;
    }
  }

  // ── Age at Testing ──
  const agePatterns = [
    /(?:age(?:\s+at\s+(?:testing|assessment|evaluation))?|chronological\s+age)\s*[:\s=]+(\d{1,2}\s*(?:years?|yrs?)[\s,]+\d{1,2}\s*(?:months?|mos?))/i,
    /(?:age(?:\s+at\s+(?:testing|assessment|evaluation))?|chronological\s+age)\s*[:\s=]+(\d{1,2};\d{1,2})/i,
    /(?:age(?:\s+at\s+(?:testing|assessment|evaluation))?|chronological\s+age)\s*[:\s=]+(\d{1,2})/i,
    /\bAge\b\s{2,}(\d{1,2}\s*(?:years?|yrs?)[\s,]+\d{1,2}\s*(?:months?|mos?))/i,
    /\bAge\b\s{2,}(\d{1,2};\d{1,2})/i,
  ];
  for (const re of agePatterns) {
    const m = header.match(re);
    if (m) {
      let raw = m[1].trim();
      // Convert "10;8" → "10 years 8 months"
      if (/^\d+;\d+$/.test(raw)) {
        const [y, mo] = raw.split(";");
        raw = `${y} years ${mo} months`;
      }
      info.ageAtTesting = raw;
      break;
    }
  }

  // ── Grade ──
  const gradePatterns = [
    /(?:grade\s*(?:level)?|current\s*grade)\s*[:\s=]+(?:grade\s*)?(\d{1,2}|[KkJjSs]K|kindergarten|pre-?k)/i,
    /\bGrade\b\s{2,}(\d{1,2})\b/,
    /\bGrade\b\s+(\d{1,2})\b/,
  ];
  for (const re of gradePatterns) {
    const m = header.match(re);
    if (m) { info.grade = m[1].trim(); break; }
  }

  // ── School ──
  const schoolPatterns = [
    /(?:school(?:\s*(?:name|\/agency|attended))?)\s*[:\s=]+(.+?)(?:\s{3,}|\t|\n|$)/i,
    /\bSchool\b[\s:]+([A-Z][A-Za-z\s.'']+(?:School|Academy|Institute|Centre|Center|Elementary|Public|Catholic|Collegiate|Secondary|High)[A-Za-z\s]*)/,
    /(?:school\s*attended)\s*[:\s=]+(.+?)(?:\s{3,}|\t|\n|$)/i,
  ];
  for (const re of schoolPatterns) {
    const m = header.match(re);
    if (m) {
      let s = m[1].trim().replace(/\s+/g, " ");
      // Trim trailing fields that got captured (like dates, examiner names)
      s = s.replace(/\s+(?:Date|Test|Exam|Age|Grade|DOB)\b.*$/i, "").trim();
      if (s.length >= 3 && s.length <= 100 && !/WISC|WIAT|WRAML|Score|Report/i.test(s)) {
        info.school = s;
        break;
      }
    }
  }

  // ── Testing dates ──
  const testDatePatterns = [
    /(?:date(?:s?\s*(?:\(s\))?)\s*of\s*(?:testing|assessment|evaluation)|test\s*date|assessment\s*date|testing\s*date)\s*[:\s=]+(.+?)(?:\n|$)/i,
    /(?:Date of Testing|Test Date|Assessment Date|Testing Date)\s+((?:\d{1,2}[/-]\d{1,2}[/-]\d{4}(?:\s*[,;&]\s*)?)+)/i,
    /(?:Date of Testing|Test Date|Assessment Date|Testing Date)\s+((?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}(?:\s*[,;&]\s*)?)+)/i,
    /(?:Date(?:s)?\s*of\s*Testing|Test\s*Date)\s{2,}(.+?)(?:\s{3,}|\t|\n|$)/i,
  ];
  for (const re of testDatePatterns) {
    const m = header.match(re);
    if (m) {
      const raw = m[1].trim();
      const parts = raw.split(/[,;&]|\band\b/).map((p) => p.trim()).filter(Boolean);
      const dates = [];
      for (const p of parts) {
        const d = new Date(p);
        if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) {
          dates.push(d.toISOString().split("T")[0]);
        }
      }
      if (dates.length > 0) { info.testingDates = dates; break; }
    }
  }

  // ── Pronouns (infer from gendered language in report body) ──
  const pronounArea = text.slice(0, 8000).toLowerCase();
  const heCount = (pronounArea.match(/\bhe\b|\bhis\b|\bhim\b/g) || []).length;
  const sheCount = (pronounArea.match(/\bshe\b|\bher\b|\bhers\b/g) || []).length;
  // Explicit gender field
  const genderM = header.match(/(?:gender|sex)\s*[:\s=]+(male|female|non.?binary|other)/i);
  if (genderM) {
    const g = genderM[1].toLowerCase();
    if (g === "male") info.pronouns = "he/him";
    else if (g === "female") info.pronouns = "she/her";
    else info.pronouns = "they/them";
  } else if (heCount > 3 && heCount > sheCount * 2) {
    info.pronouns = "he/him";
  } else if (sheCount > 3 && sheCount > heCount * 2) {
    info.pronouns = "she/her";
  }

  return info;
}

function autoClassifyDoc(text, fileName) {
  const t = ((text || "") + " " + (fileName || "")).toLowerCase();
  const cats = [];

  // Cognitive testing
  if (/\bwisc\b|wppsi|wais[\s-]|full.?scale.?iq|fsiq|verbal.?comprehension.?index|vci|visual.?spatial.?index|vsi|fluid.?reasoning.?index|fri|working.?memory.?index|wmi|processing.?speed.?index|psi|cognitive.?proficiency|general.?ability/i.test(t))
    cats.push("Cognitive Testing (WISC, WPPSI, WAIS)");

  // Academic testing
  if (/\bwiat\b|wechsler.?individual.?achievement|word.?reading|pseudoword|numerical.?operations|spelling|reading.?comprehension|math.?problem|sentence.?composition|oral.?reading.?fluency/i.test(t))
    cats.push("Academic Testing (WIAT)");

  // Memory
  if (/\bwraml\b|wide.?range.?assessment.?of.?memory|cms\b|children.?s.?memory.?scale|story.?memory|verbal.?learning|design.?memory|picture.?memory|finger.?windows|number.?letter/i.test(t))
    cats.push("Memory and Learning (WRAML, CMS)");

  // VMI
  if (/\bbeery\b|\bvmi\b|visual.?motor.?integration|motor.?coordination|visual.?perception/i.test(t))
    cats.push("Visual Motor Integration (Beery VMI)");

  // Adaptive
  if (/\bvineland\b|adaptive.?behavior|daily.?living|socialization.?domain|communication.?domain|motor.?skills.?domain|adaptive.?behavior.?composite/i.test(t))
    cats.push("Adaptive Functioning (Vineland)");

  // Social-emotional
  if (/\bbasc\b|conners\b|cbrs\b|\bmasc\b|\bcdi[\s-]|gad[\s-]7|behavior.?assessment.?system|behavioral.?symptoms.?index|externalizing|internalizing|hyperactivity.?index|attention.?deficit|emotional.?self.?control|negative.?impression|f.?index/i.test(t))
    cats.push("Social Emotional Functioning (BASC, Conners, CBRS, MASC, CDI, GAD)");

  // Behavioural observations
  if (/\bbehaviou?ral.?observation|during.?the.?assessment|observed.?to.?be|testing.?session|rapport|eye.?contact|attention.?during|fidget|cooperative|reluctant|task.?persist/i.test(t))
    cats.push("Behavioural Observations");

  // Medical
  if (/\bmedical.?report|physician|pediatrician|paediatrician|neurolog|psychiatr|diagnosis|medication|prescribed|adhd.?diagnosis|asd.?diagnosis|developmental.?history|birth.?history|medical.?history/i.test(t))
    cats.push("Medical Reports");

  // School reports
  if (/\breport.?card|iep\b|individual.?education|school.?report|academic.?achievement|grade\s+\d|learning.?plan|accommodation|special.?education|school.?board/i.test(t))
    cats.push("School Reports and Report Cards");

  // Teacher questionnaires
  if (/\bteacher.?questionnaire|teacher.?rating|teacher.?report|teacher.?completed|teacher.?form|trs[\s-]/i.test(t))
    cats.push("Teacher Questionnaires");

  // Parent questionnaires
  if (/\bparent.?questionnaire|parent.?rating|parent.?report|parent.?completed|parent.?form|prs[\s-]|caregiver/i.test(t))
    cats.push("Parent Questionnaires");

  // Intake
  if (/\bintake\b|referral.?form|referral.?question|reason.?for.?referral|presenting.?concern|background.?information.?form|consent.?form/i.test(t))
    cats.push("Intake Questionnaire");

  // Previous assessments
  if (/\bprevious.?assessment|prior.?assessment|previous.?evaluation|prior.?report|re.?assessment|last.?assessed|previously.?assessed/i.test(t))
    cats.push("Previous Assessments");

  // Background info (broad fallback — only if nothing more specific matched, or if strong signals)
  if (/\bbackground.?info|developmental.?history|family.?history|prenatal|perinatal|milestones|birth.?weight|pregnancy|siblings/i.test(t))
    cats.push("Background Information");

  // If nothing matched, mark as Other
  if (cats.length === 0) cats.push("Other Supporting Documents");

  return cats;
}

const TABS = [
  { id: "case_info", label: "Case Information" },
  { id: "documents", label: "Document Upload & Case File" },
  { id: "interpretation_note", label: "Interpretation Note" },
  { id: "referral", label: "Reasons for Referral" },
  { id: "background", label: "Background Information" },
  { id: "doc_review", label: "Review of Documents" },
  { id: "observations", label: "Behavioural Observations" },
  { id: "cognitive", label: "Cognitive / Intellectual" },
  { id: "memory", label: "Memory and Learning" },
  { id: "visual_motor", label: "Visual-Motor Integration" },
  { id: "social_emotional", label: "Social-Emotional" },
  { id: "adaptive", label: "Adaptive Functioning" },
  { id: "academic", label: "Academic Testing" },
  { id: "summary", label: "Summary & Diagnosis" },
  { id: "strengths_needs", label: "Strengths and Needs" },
  { id: "recommendations", label: "Recommendations" },
  { id: "appendix", label: "Appendix" },
  { id: "appendix_tables", label: "Appendix Tables" },
  { id: "preview", label: "Report Preview & Export" },
  { id: "prompt_reference", label: "Prompt & Style Reference" },
];

const TOOLS = [
  { id: "wisc-v", name: "Wechsler Intelligence Scale for Children-5th Edition (WISC-V)", used: false, cat: "Cognitive" },
  { id: "wppsi-iv", name: "Wechsler Preschool and Primary Scale of Intelligence-4th Edition (WPPSI-IV)", used: false, cat: "Cognitive" },
  { id: "wais-iv", name: "Wechsler Adult Intelligence Scale-4th Edition (WAIS-IV)", used: false, cat: "Cognitive" },
  { id: "wiat-iii", name: "Wechsler Individual Achievement Test-3rd Edition (WIAT-III)", used: false, cat: "Academic" },
  { id: "wiat-4", name: "Wechsler Individual Achievement Test-4th Edition (WIAT-4)", used: false, cat: "Academic" },
  { id: "wraml-3", name: "Wide Range Assessment of Memory and Learning-Third (WRAML-3)", used: false, cat: "Memory" },
  { id: "beery-6", name: "Beery-Buktenica Developmental Test of Visual-Motor Integration-6th Edition (Beery-6)", used: false, cat: "Visual-Motor" },
  { id: "basc-3-p", name: "Behavior Assessment System for Children, Third Ed., Parent Report (BASC-3)", used: false, cat: "Social-Emotional" },
  { id: "basc-3-t", name: "Behavior Assessment System for Children, Third Ed., Teacher Report (BASC-3)", used: false, cat: "Social-Emotional" },
  { id: "basc-3-s", name: "Behavior Assessment System for Children, Third Ed., Self-Report (BASC-3)", used: false, cat: "Social-Emotional" },
  { id: "conners-4-p", name: "Conners 4th Edition–Parent (Conners 4-P)", used: false, cat: "Attention/EF" },
  { id: "conners-4-t", name: "Conners 4th Edition–Teacher (Conners 4-T)", used: false, cat: "Attention/EF" },
  { id: "conners-cbrs-p", name: "Conners Comprehensive Behavior Rating Scales–Parent (Conners CBRS-P)", used: false, cat: "Social-Emotional" },
  { id: "vineland-3", name: "Vineland-3 Adaptive Behavior Scales, Parent Form", used: false, cat: "Adaptive" },
  { id: "brown-efa", name: "Brown Executive Function/Attention Scales (Brown EF/A Scales)", used: false, cat: "Attention/EF" },
  { id: "phq-9", name: "Patient Health Questionnaire-9 (PHQ-9)", used: false, cat: "Social-Emotional" },
  { id: "gad-7", name: "General Anxiety Disorder-7 (GAD-7)", used: false, cat: "Social-Emotional" },
  { id: "bai", name: "Beck Anxiety Inventory (BAI)", used: false, cat: "Social-Emotional" },
  { id: "bdi-2", name: "Beck Depression Inventory-II (BDI-2)", used: false, cat: "Social-Emotional" },
  { id: "asrs", name: "Autism Spectrum Rating Scale (ASRS)", used: false, cat: "Social-Emotional" },
  { id: "signs", name: "Scales for Identifying Gifted Students (SIGNS)", used: false, cat: "Other" },
  { id: "other", name: "Other assessments (specify in notes)", used: false, cat: "Other" },
  { id: "review-rc", name: "Review of recent report cards and questionnaires", used: false, cat: "Other" },
  { id: "interview", name: "Interview with [firstName] and parents", used: false, cat: "Other" },
  { id: "interview-student", name: "Interview with [firstName]", used: false, cat: "Other" },
];

const TOOL_CATS = ["Cognitive", "Academic", "Memory", "Visual-Motor", "Social-Emotional", "Adaptive", "Attention/EF", "Other"];

const PRONOUN_MAP = {
  "he/him":    { subject: "he",   object: "him",  possessive: "his",   reflexive: "himself"   },
  "she/her":   { subject: "she",  object: "her",  possessive: "her",   reflexive: "herself"   },
  "they/them": { subject: "they", object: "them", possessive: "their", reflexive: "themselves" },
};

const INTERP_NOTE_MINOR = `A psychoeducational assessment is conducted to better understand an individual's cognitive functioning, learning profile, and academic skills. The purpose of the assessment is to identify areas of relative strength and areas that may require support, and to inform educational planning. This assessment provides information regarding how [firstName] currently performs on standardized measures administered under structured conditions. These results represent an estimate of functioning at the time of assessment and do not capture all aspects of ability or potential, particularly under different environmental conditions, supports, or instructional approaches.\n\nStandardized tests allow comparison of an individual's performance to that of others of the same age, and when available, to Canadian normative samples. Percentile ranks reflect how an individual performed relative to peers. For example, a percentile rank of 90 indicates that the individual performed as well as or better than approximately 90 percent of same age peers. Scores falling between the 25th and 75th percentiles are generally considered to fall within the expected range. Standard scores are derived from raw scores and allow comparison across different tests. These scores typically have an average of 100, and scores between 90 and 109 are considered to fall within the expected range.\n\nIt is important to recognize that performance on standardized tests reflects functioning within a specific testing context and may be influenced by factors such as attention, motivation, emotional state, familiarity with the task, and environmental conditions. Assessment results should be considered as one source of information and interpreted in conjunction with background information, observations, and other relevant data.\n\nThe findings presented in this report are descriptive and intended to support understanding of [firstName]'s current learning and functional profile. These results do not, on their own, determine future outcomes. The results of this assessment are most relevant at the present time and should be interpreted within the context of ongoing development.\n\nPrior to the commencement of the present evaluation, the purpose of the assessment, procedures involved, and associated fees were reviewed with [firstName]'s parents, and informed consent was obtained. The limits of confidentiality were explained to [firstName]'s parents, including circumstances in which disclosure may be required by law or professional standards.\n\nAs a school psychologist, the role in this assessment is to evaluate learning, cognitive, academic, and socio emotional functioning in order to support educational understanding and planning. This assessment does not include treatment or counselling services. Recommendations provided in this report are intended to support educational planning and may be adapted by educators and other professionals based on individual needs and circumstances.`

const INTERP_NOTE_ADULT = `A psychoeducational assessment is conducted to better understand an individual's cognitive functioning, learning profile, and academic skills. The purpose of the assessment is to identify areas of relative strength and areas that may require support, and to inform educational, academic, or vocational planning. This assessment provides information regarding how [firstName] currently performs on standardized measures administered under structured conditions. These results represent an estimate of functioning at the time of assessment and do not capture all aspects of ability or potential.\n\nStandardized tests allow comparison of an individual's performance to that of others of the same age, and when available, to Canadian normative samples. Percentile ranks reflect how an individual performed relative to peers. Standard scores typically have an average of 100, and scores between 90 and 109 are considered to fall within the expected range.\n\nPerformance on standardized tests may be influenced by factors such as attention, motivation, emotional state, and environmental conditions. Assessment results should be considered as one source of information and interpreted in conjunction with background information, observations, and other relevant data. The results are most relevant at the present time and should be interpreted within the context of ongoing development.\n\nPrior to the commencement of the present evaluation, the purpose of the assessment, procedures involved, and associated fees were reviewed with [firstName], and informed consent was obtained. The limits of confidentiality were explained, including circumstances in which disclosure may be required by law or professional standards.\n\nAs a school psychologist, the role in this assessment is to evaluate learning, cognitive, academic, and socio emotional functioning in order to support educational, academic, and vocational understanding and planning. This assessment does not include treatment or counselling services. Recommendations provided in this report are intended to support understanding and planning.`

const LOGO_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAdu0lEQVR42t2ce7Ac9XXnP+f36+553qeudJFAAiEhMAKBAIMsEEj2mgQ7tnGCbxzbMXg3FccksUl2vdlka0uoki2SSjk2TlLBTjbBcWKvhVnbMfiJowsEQwSIpxQERljofSXdx7xnun+/s3/0zH3pLR7O7lRN3TvTPT3d3/6ec77n8RvhdXxsVLVDIg7gG/vi93jhfc5zMapdGHZjZHMQ6P2/OCd6tPOZ9Zs0YC1+g4jn3+FDXjdwNqodGhK3cXv1yrCY+VOsudaEgnPgFUwIxkKrHjux5nEV/4/FKPzau7rlYOfzAENDKcD/XwHUAefrL1VvDHPRxiAKwmql4TGoCqIgCKoiiojNFCPCCOrV5CDwlUiCL944INsAVFXuAfMB8CKi/88DpKpGRPy3Xm6uIJDNXiWTJEkiIoEKqAAGlPb/IijqPaphFNlsl6FWiVvGyDeN5a6b+sJN083v9rW4nyVQrwtA94DY7Y0f57qyV9aq9USMBIpAG6AUGGa9FryqIjgxJsj3hMQtcC552Bq5y1f2fmNo0aJ6x7dtBf1Z+KnXBND6TRpsWCfJt7bVbs735u4uleoJIsF0MJD0K2azKd3eBhFVRT1gst1ZMRaa9eRFK/I3Pml8eWiwuH/6zegEgn/fAKmKAlu3Ev5Eas9Fucx5zUZL1YiZzhimmVYKBqiZxSak/RdU1AGEuYyN8tCoJIdU+Ar4v/7gnMzzne/e+Cb5KXPa+IAREf2p1G8sFvPLWrWmFzCiYDyIB3y6oyigOvl/Z5t0nqoY1RRTFSuITepNXx1tJqgZyBWCT4J5cuNocs89Y/E7ENEhESciun6TBqoqbxRAwel+8PbbU0txib/NJ20CKAiabkAQ2oyhDZIoKukW0Slz89phmWKMtLEUI2BcK9bqKA5jomx3cFOccNPXxpJHRPlCtm7vfe+ZUtvwBvqp00K+Hdb9fc+U1oTZ3IPNRstjMB1zmTKfWf5nurMG4pSGRAGIEVqqNBWsAWsEz/T9VRU8aOqnAmjW3UtG+Nskbv79h+YW9r4Rfip4TQHMyaeiIKBJ04uKQSH1TNK+rllsarMm8SkI5/cELOwyFEPBiNBwykjDs73sGIuVyAod6xQREcGqCI1SwyOiYS5zXpTnDleJPr1xIv5K4vxfi8iznVu/0at9rX5KTh0VNSLo/f9aOi/IZZ5NvI+8+pQKHOl8OwzwCMZA00N3Vnjr/JD+7NFdYOzh6bGEFyuO0IJOc+IzIiTqVfAmDINcl6FRTWIx5tui/q6h3vCHr4eeOmWANm3aFKxbty757pOVzxa7C7dNlKpt3TM9tKf7+mnRSyQFZ17RsOqsDJFtM0qmTkJnndS/lRxPjSYEtmNmcqSpCmhbT2FMkOsOcQkkiXvUCF9o1g5+/aPz51dPV0/JKbJHROCH2+h3tfp2Y21/ksRgRKZYMxMoJfUvTacMdltWLcoQmI7ZHDdKIsBLZccThxPsbJBmsylllPqOn+rKigmhUXUvi/V/a234paGC7AFYr2qWn6SfklNjjwbr1knyw8fLv5PvKv5ZaaLsMNZOd7zTHbK2mdNyytyugFWLIwIjkxd/ElICAV4uOzYfSpk02/lzlJuCgFf1CDqpp6puTND/bbz/4lBf5ukZFQjwHMP8TplBW7cS7ilVn4+ymaXNVkMxYjonPN3/qJD6HKcMdFlWLc4Q2JMHZzZIO9og2bbI7Jjvsdk0Gf28ingTBEGu21CrJM5auQ+xf/XBonz/RECZU2GPiOj+ifJ7uwqF8+JGwxsVI55U5E0TgkbBKrRaMJC3XHWa4HSuW4FzuyxXDQQ411apOk1gdsTWNPHZEWCCGFECH8daHW0lmqgNM/Z9xvK9r5aTx75W0Zs3vvpqbkjEIaLrVc1pATQ8nMoSnH5KnW8r4PREcW2FrAo+PeE4VgYKhquWZAhPE5zZIC3usqyaF+CTFAwzTYnLpGKfUu/SAU3BICIQ4L3WxpuuWWl5G9irghx3J30Ltny1mvz6xo1qN4j4jZrWpk7axDrCcPhfaqtsYB9pxS1V4aimJQZaDnq7DFeenyUMXhs4M0089Wk7K47HDrTNzUyXFal/OqbZyfREOfXpXkSjXGSjPDQbfrOvud/+8EC0uVMdPZVcTF0SfyoTRqKqPmXPFL3Fp2aVtJS+guGty9rg6OtXtpT2BZ5dtLxtMMR7Tdk7yaTjsMlPsWnyiRiL2KTe8tXDrSSw5kqbtw996VD8i0MibqOqlZNwzEYEffjhicVouNWpZrx6dJYwFCO0EqWny3L58ixRKCcM5a8hUUaAXRXPowdaGBFk0nFPj6LHEphHc+qCU++CTGBNQELsV3+wN3rcnNj3DBsQdU0+UcjlsyTOGUWMn3LMhpQ5PXnDZRe+seBM+iSFhUXD6sEorSZ1HPcMlijidSab/JHsSqsOihVjXdMlQWiDONY/PyGDOmWER78/0edD+4LYYCB2LRARpvucBLqKhpWX5MlER4Kj2s7IjoNYepGKMeaUfdKequPRfTGIYI7KpFl1pyNqVTPZpeDDXGhcvfUL5gSRy4qIEshHuwvFua7V9IZ2RuNT5riW0p03rFxxdHA6wIgI3nu890cA45xDRE4JnEmfpHBmwbJ6foio4r1OMekIv6NTjJlRq5piVzs71iAQRcwvHfeM1q7FPf+8Rj7RTzQbLTWkpmUUrKTgFPOWSy/Nkckcmzn79u1j9+7dGGMwxkyCpKqICNZaJiYmePHFF0/PcSssKFhWL4gQBfWd4ltbCrhZTpyjmJ2fIQ/ExYj3frk5kTCs7q28rzvfvazVqHvaJQ2DToJzyco8mYw5KnM6AB0ePcyaNWu46aabeO655zDGTLKmVCrxB3/wByxfvpwf/OAHqdRy7rRAmp83XH1mBArqZorXo1UxRWeJyun6yYGFgjmRMPSt5FOaeIxPnWDHIRfyhhWX5chkhcRryloFp6SvFYwxqCoXLb+I/v5+7r33XlavXs0Pf/gA1loOjIzw9re/nTvuuIM9e/bw/ve/P60CtI+ReMV1nqo4ncr4O9Fscj9VYq8M5g2r5odpVdKnN5M2GMYfKQmYpcQ7T2tAPXvMsYThhg2ij99fujobZq+u1yoeFWsUfFMp5C0XX5Enk0s/HhjBChhJTS8wbWep4L1HVfnErbeSyeWpVCrc8tGPUB87yO//l9/lySefxAQhH735FgYGBkA9YWAJjKTH7Twl/Q5pA9iJZp39AiOEJi3MnVm0/PziLAbwrq32vc5kSRsoc3TtpFbAIo8er6KoPkluy2SLtJpNLxaTtJRc0bD8rVPg1BPPxu0lfryvzkTLkw+Ei+Zk+MCybhZ2hTiTivxf+9gt3LH+v7NjT41DLuK9/7SLp18up34pifnUrR8nk8lQacZ8+5UyLaedYElgIBcYBnKWywez5IL0uw/WEu7bUZmsEHRAayTK8jkRa87K8tCrLZwDa9uRslPf1OkarhMSOyZrbKMSO0ty3xEA6Xo1MoTf8u2J8wTznmqlrGKwruXJFS0XriqQyac+Z1c55le+u4fNBxoEVnCqWBHc9hKffWqML77jDG5YXERVOVx3DHzyr9l75+9A6SBPsIBEDdYY+m65g9IZFwJQjoVPPTjCaNMRti/cmqnIvKw34u/eOZ8Vc7O8NN7iP/5oH1lr6Fx6ZIRyI+Gjy3v50s8t4OqzIh7dk4I0GSR1qnkw2VUwk5tcris09Upz800L808eaWLLERBVp7cWs8WMwTttqWTzhgvfloLj2hz/zw8d4LEDDc4oBvRGhmU9EQNZy9x8wETs+c3h/RyoJogI/3NrwhMvvIKZOED2Las5w01QPPsthPkuStsf57890aCeeDJW6Mta5uQs/TlLf9ZiBbKBoTdjeeZwk08/PAJAaIX+bLrfnJylN2va+VlqlgoMFgxrFkaEkpqbzEg/dIbJ4QHnCQPEev07EZmZ2quqyBD+iX8qDRgvH63Vq5q01GbzwltWF8kUDN6nHYdXyzEP76szNx9QjT09GctDN53N28/Kc7iR0Jsx7KsmbBlpoN7xgz0t8s/cjzljCf2/fw/3vW8ha37rD5Gf/03CLfex9cAETx9skg+F2HmcQuwUK/D5awc5ryekHHsGspbnR5tMNB0ZIyQenFdaDrJGeOfCPDecXWTFnAzSduJzcoZrFkZEZrpP6gA15ajFqUZBZKqjrYOBNu45oqsxPIwFSSI3dnNXsbf/8NhYkivYYNk1RTJFM1lD7th/yymZIO1S9GcM/TnL3JylHd1xCvtrCY0EJiYmyL3jZlzPIEF1lCX9Z9FdHyFZdRPzzjqHkbjFgZrDiKCTBQ7wqnzkgh62jjZ58mCDfBDQcJ7RhseadD8jhobzzM+HbHz3WTPbNu0+W3/OcPWiiEdebRG7dBRnurNvm53LF2xQHo/vfv+SvvFNqoGZCpkqa9fiXvyOZlyit9bKdc3kjFm2ZgqcTjbd6Tz49lyLTJf+0yKLFaGRKE0PSauJXHQdnLEETVokmiprohxc/m7UBDQT3z6WTgKkQKJKJ7cRUcxRyieT0yPH0Un9WcM1i2YyaaoDrGoxtjbRbESWvwIYBj8J0PCmNK2ImxM3doc95zpp+qXXFU2m++gi0E9GhJknUok9tZrjUN3RqCfUEm1LDIF6BeLmZHQSEVCP1kqpd1Q9ohpsRXhod40tBxvkQqESp/wayFkSr5PdNytp9Hp0b40f76mzu5LM7JS0QerLGq4+O/VJdNKS9H64fDESTdw33ndO7pVO8SyYLgxFwNXcbeQdS64tku22x83KZ4MD8P4l3ZzVFVIIDeWW57ozc9RixQiomClezziQSTk8SwWKgdgrH/r+PhTIB0JXYPjYhb0UI0PTtY+rEBphby3hxvv2cLDu+MyaefzOZf04rwRGjgDpyoURj/60CUbbrXAxcS1Wq9yJqnDPtM5qZ0Js+9dHr5VWdlXfxd7n52Ss+va5H6cu03lYUlu//pwC159TmLHfT8ZaaWJ7XJh1BuCKIqThu+E82UBwPtVYN1/Yc8QJdEogLa+on83GI81tsGA4f17Atv0xUaAuU8jbWqX24PuXF/51varpjAK2Lz+Fq1Vyt81ZlKNvScarHh+c2SB1/iZeaTql5ZR6kp7odN917N6KzPAhkg5YERnhL64bZEl3RKLK/Tsr/NJ9u0m8pukAUwEhFwjXLsizdmGeRV3hMWvKnfNZOiekEKVzlAawls8BrB2eqtUHnRG6Hd+cOL81rr8QLGgpRPZU6nva9kki8KePH+Yft5cYyFlGao7//tY5XH92AT+ri3q0o8hReOVV+dW39PDMoSZPHWowLxewfbzFSM2Rsal/NCLUnWdpPuRb750ZxayRY97Z0MBgwfg91cDUyrUXzlyev7/dHJ0kezB8+3Caf5aT3+op9oWZPpcAwYmKgUYEmRLuk3FnXzVh6+EmcwsBBysJow1HZGUaizpjDUfeVTvN2em0bsZEy2Om5WFC2m+b7hulHYwazhNI2rEMTqKi2RWJRi1rkoS/vEIk3rRJA5BkEqB1G9Yle/6xNFCNk4/Um2WdYwv2ZFqx+VCOyIEEiKyQDQ35wJAJDT0ZS2iEQISWnwrfgUzryLflQsbKNBB1cvNU3XPazdAjjdYIZO0pFd00jAJTHa8dXNyf/wdUZe0sVxkA1F3yob58X+9o6XDiWxqcDECD+YBCaGi41BeMtTylpudAzU2ahgDzcpZcYCiEQqOpqTkknj2VmNGGmzQBKzAvH6QMkWO1fnVyoGa25AiNsL+W8OHv7iVRZTBn+cy1gyfqyTm1JnCJv3vlYhlXVSuz+vVGN6qVWG+JW031LTX1A8mk6DtWFPAKg4WAFXMyjDYcxdAw1nSs/fpOhvfWmJO1jDc9CwoBK+dlEYF3LipwuJ6QC4TYKzd8azdPjDToy1hGm46lPREr52WoJZ7QpDbeKXd0TNpKp7QxxdhOOSSy6XzRfT+t8I0dZR7YVTuqoph2HQrYXXuajVbL3QUqtx8lhgQ7qyOrAjKX1BtVAiOmtK1JzwXZE3YkVOGPVs/lpfEWL07EREY4WG8SSArAGXnLX64bZLAQkHjlf1w1wLbDTYb31ImscLAxte/8vOXO6+aRCwyj9ZhDdcdY003WlZxXSk1HveYYUWjGnpZXWl4ZqyVUAjN5ZYEIsUuLZ3r8Yr87WCcYHUu+8eE1vTs2bpxaRjEDIE3sewpRzpQaZWcDsa2RhNHHa8y5Ks+xdFAnMFwyN8vTHz6XL//bBFsONig102z80rkZPnJBD/05O5kPDeYD/vmms/nqCxP8eF+dww1HPjBcPJDhwxf0MNDe98yukL9YO0jTpXIhHxj6cwG/dlEvl83LUgwNTuHcnjTs/+31C7DtbgaTVU2lJ7JEVo4w047wnah589xLieYiufPYSQoE4ljlXJKqEAc2Esa21Il6LF0XZNLQYGbauxHha9tLbB9rcXZXQK3lecdZeaqxJzTCznLMpl1VdpZjlvREbBlpsLgnpDuyLO2J+Ml4zIfO7+H7P61wfm/EI3tqPDXS4OzukFiVOdnUb924tItvvVzmjzcfYlF3SE9kGGt6coFw97ZxvKZB4Yy8ZfP+BpfMzXCo7shYYXc5JvZKZlpnqwNOrendCzuNbVZaD73rmq5UGB5jVigwwhmaOMSrdByMtTAyXEECKC6dCVKHtltGGnznlQrL50T0ZwJaXvn+zgrn9IT0RZYHSlUe2F3jqnlZSrFny0iDZb0RmUB4ZG+dJw/U6c1YqrFn+3iLYmAYzAfc/0qZYpSmozcsLjK8q4b3yk8mYnojw+YDDbpDQ2SF8aajL2upJZ6L52T45stlBMgEhmbiO5PHkypbBOot5cnnG2ByFLPmsx1huAH80eekvVZTTSNqOl0A0urbyAMVKi810wGBWR8fb8T85opufvHcAk8cqFKMhKsGM8zNGMYbMUY9RZPmSo3YERgYqbYYq8c478ga5dWJJrtKTTKixEnCvnKTQ7WYA7WE/dWYA9WYC/tCthyosafUJMCTEc+8nIA6Kq2EBTmDOk+9lWBU8d6ztMuy5UCN0Yab0k4CjZay5dmad0loWo3aC3lSYbhu3ZTuOZJByNZQgpWNthQ2KKpCp6Yw8kAFFIrLMmmXoG3sv3LRINfMD3i5Br8mOa4dNLggIjTwo10trhiMuKHqmRvGbBv3nJNXRsmSN8rVDc/qBSEP7m5xVldEfwZ2lBzeK2vOO4Nao8HeSkLNGS6a380nenoYzKbmtXYpFDMWp1CNlcG80Ehg22jMxQMhu0oJXZHltr4e5rRrU6YNzlPP1KhWEu0fKJhKJf7LK67oCEOODZCg93rnfhWvIpPjcYr4NDdSAyMPlFOQzs/gEocNLGbrj/jcl58hG1ouvehCLlj6Dv7sM3fQ29dHt1G2erDGsPo976W58ymuvf5d3HXnZ1i4cCFBqcT/2T/CYH8vP6nVKXZ3Ezca9PR0s69WY+XKy3j7ooVEGUh++gLx5n9ltxjCMGAkcRwOAowxlMbHGe3uJpvJkOzfx+MK+VyWca8U8jkyS38dUJot5Zmn69QqzudzWVMer45IV+Ef2q314zbhggVm4Du7myNburPdl5UaJWesse3J0amajRVGHiijCoULQlAYfvRxvvz3X6JULjP0yx/kvEsu55vf+R4iwsMP/wsrVqzAe8/g2efywwce5IKVV3L7n/wZAwMDNOp1rr/+nQw/8hjz588HYMeOHYyOjbJt2za+/vV7+b3b/4h333ADrTjmzs9/nksvvYRcLs/Y2Bi1WpVdu3ZzySUryOfyPPvssyBw2crLGBsbo1gsUqs3+OWbP4ZzAc88VaNa8oQRPp/JBKVm8+51K2W8M7F7XIDk4xLv+8KhW9UnP86Y0LRc7MQYO9nc13R5gATCoR+VcXGO3osLLDprIZdeeikLFy4kk8nw6s6dXHXllRhjWDB/Pt3d3agqlXKZYiHPC/+2jbXXrqFYLDIwMMCSJUs4f9kynn/+ebLZLBe+5QJKpRJLFi/GxS2WnruYXbte5ZxzzuGa1W+jq6uLrq4u+nrS415x2WXEcUx3dzeBTVvaF110EZVKhSRJOHjwAK2W54Vn61THPWGEotZWK7W6Mf4u0grqCceBRTeqlSFxr/75/g8VbeFuY0xYblUTFYxIunJnxgxNogysK9K1PDsV+tvNwaMNIHjvERGccwTBkVlMZ/uJJju89yc13KAKqWwJeO6JGhNjMWFk8KpJobs7KJfLX73uP3R/qFMDO+FqHxkSpxvVLvrtM75SpXqt8+6JObm+IGezRr13+HSaLJ39VGwAh/65Qvm5RnvsLL0wa+3kBXQSyc5FiwhBEMx4f/b2Tpv6WKMxs8GZvW9nRijNAAKe31ylfDgmCqQzzGDiRhNj7eePJwyPuhyqA9LCW8947NkDT76t6qqfEPyL/bk+WwwLBqcep058emQbwuFNZUrP1BErR0iAzhzQ7Hmg2e8fa/uReZOcxHupjItjZdtjFSqHEqJA2iN66vLZgmk164+sWVd4bP165GQXD0/eFhkSp+vVrNuwLpn7G7131QZKlza0/jHnk81dmYLpyXZb8QhOE1TVRsLog5UUJAP8LBd1t5mTxMr2x6pUDyWEoaBuqiloMVjkzvZYz0nXROQolT1hY2p6nfcO3zX+885zq1f/7kKmy5SbZRKSRA3GNzH91xbpXpk7Ii15s8BBIEmUF39cpXQoIcjI5Bo0BZ/JZKXRqu8Yl4PLb7jhvFabfXpKDJpGVJUhcYqKtteyz/mN3u/Nu7X3vZl8dHk9rt1lhPG+bH+QlYwxIe7wg2U/8WQtPZp/88FxifLSI1UqIzFROH1uG4xXn40yIvBX73rXsmbaHEVPm0FHPY+NatmKyoZ0lcyhLx46yxPcoo6PZaP8uYnGlMoV33tNQXuvKJh07dObB85PHqlS3p9gs2mhvzO14RUNwhCnbtwUZNkV67oPt6PtSQN0UgvqOuam69WwHJEh2Q380YGNBz7XGJeb8Prx7mJxlX/CMKE1et6aT/BYDPJGg7PjX6pU9iWEWUmHE2SqXGtVXTFbCCaq4/9wxbq+Q5vWbwpEJDnVidrTmHhXGb592K7bMKVCD/zN+PV4+URSc7+w4O19ARcDHofBvhHgeKe88lCVib0xQc5MZu6T7ElXvaoJbGysX3HJDd0vpuQ5tTWtr+kOa9qBnOHQR+8ur6iPJb/ed13+l3MrowHSc319uNQBxys7H6xS2tXCZk3aWp+1+seLd12FXluqjn3ril+ac+PGjRvt0NDQKa9jfS1rVju27Gb4qVvkWeC3Xv7k/j9ctGTu7wbd5r+S9pnMa7ohnYkwD7serFLe2SLIpiLQtJuOXnSyAmpUxCUx1po7AT7AB057aP31tYD1aobBrNuQ2nrSSH7PZuwft4E8PZA64CjsHq4w8UoLm0sF6uT4xbSlByq4XK5gavXKk5d+oO/K229HNmw4veXir3uskQ3i122QZP16NfqEhkE2+BPXdJ8G7NTY0umBs/fBCuWXWwSZtkKmPbk6Oe+s6evEE0ogxvBZEdG1a4dP+zrfsF8smOanAhFJtKW3EfLZU2LStK7kvk0VJl5qYjoOefYa2bYf8qI+G+WkkTR2dA1OXHTO2nOaacv79JaGv+G6V0QSVQ0kks+5mE+2maQnlJQ61a7dP1yh9EKTICNIe0BcVGeyZ3Ixi/psmBNr5I7F6xY3hm/Hni44bwqDZjMpqScft1l7V2cY5CiBogOeAH7/j8q2/EJLbF6m/YRFe8fpS54EnPeumO+ylVblqUbllasu33u5YwP6WgB60zKnDpOCXPAFEm4CSm1wtA1U5ymAxWPqwwTN7V5spE6demkvw2TGuor2kgPvk8hG1rukFUXmP13x8Svie5bfI68FnDcVoBnmFsq9rQqrvfPfbQMSTHviY7438Wzj5/Y+PfLZIMeh/vwcWwwLabvAq5O0RuXVq++87sp0B5ENknpc/dVlH+h7Ki2IDb3m3+8QfgaP6UMCzWbzkshGb3WeuVY5CDwuGXmms+/e/1WaK0aGnNePOJ9cmc0UTLs8lc5D24DYJ2D0kWpS+fSFN5/x6MlWC//dAtQGyQB6tMSx3W0ww7cPy/R0Zv+Xam+LXXxD4t0qMWZQoGoCu9Vb809nf7jw7Y5gldfxl/T+L8+AFIwSgssgAAAAAElFTkSuQmCC";

const BG_STANDARD_OPENING = `The following history was gathered from the initial interview with [firstName], [possessive] parents and a review of the Parent Questionnaire and relevant documents.`;

const BG_TEMPLATE_BODY = `[firstName] lives at home with {{family members}}. {{languages}} are spoken at home.

Parents reported that [firstName] was born in {{X was born in}} after an uncomplicated pregnancy and delivery. They stated that {{Developmental milestones}} {{Vision and hearing}}.{{Other info regarding development}}

{{Information obtained during the interview}}`;

const MEM_TEMPLATE = `Selected subtests of the Wide Range Assessment of Memory and Learning, Third Edition (WRAML-3) were administered to examine [firstName]'s memory and learning abilities. The WRAML-3 is an individually administered, standardized assessment designed to evaluate a broad range of memory, learning, and cognitive functions that underlie everyday learning. Memory is a foundational skill that supports virtually all areas of academic achievement. The ability to take in new information, hold it in mind, organize it, and later retrieve it when needed is essential for following classroom instruction, learning to read, acquiring mathematical concepts, and completing written assignments. Weaknesses in memory functioning can affect a student's performance even when intellectual ability and motivation are adequate. The WRAML-3 measures how well [firstName] can encode, store, and retrieve verbal and visual information both immediately after presentation and after a delay of approximately twenty to thirty minutes. Specifically, it provides information about [firstName]'s verbal and visual immediate recall, delayed recall, recognition memory, attention and concentration, and working memory. Index scores are reported as standard scores with a mean of 100 and a standard deviation of 15. Subtest scores are reported as scaled scores with a mean of 10 and a standard deviation of 3. Qualitative descriptors are used to describe the range of performance.

The General Immediate Memory Index provides a broad estimate of [firstName]'s overall ability to take in and immediately reproduce new information across a wide range of memory tasks. This composite draws upon both verbal and visual memory channels, as well as attention and concentration, and therefore reflects the general efficiency with which [firstName] can register and recall newly presented material. It is derived from the combined scores earned on the Verbal Immediate Memory Index, the Visual Immediate Memory Index, and the Attention and Concentration Index. [firstName] obtained a standard score of [GENERAL_IMMEDIATE_MEMORY_SCORE] ([GENERAL_IMMEDIATE_MEMORY_PERCENTILE] percentile), which falls within the [GENERAL_IMMEDIATE_MEMORY_RANGE] range. This suggests that [firstName]'s overall capacity to take in and immediately recall new information across both verbal and visual modalities is [GENERAL_IMMEDIATE_MEMORY_RANGE] when compared to same age peers.

The Visual Immediate Memory Index is an estimate of how well [firstName] can learn and recall visual information shortly after it is presented. Visual memory plays an important role in many classroom activities, including remembering what was written on the board, recalling the layout of a page or diagram, and recognizing previously seen material. This index is derived from the scaled scores earned on the Picture Memory and Design Learning subtests. [firstName] obtained a standard score of [VISUAL_IMMEDIATE_MEMORY_SCORE] ([VISUAL_IMMEDIATE_MEMORY_PERCENTILE] percentile), which falls within the [VISUAL_IMMEDIATE_MEMORY_RANGE] range, suggesting that [possessive] ability to take in and immediately recall visual information is [VISUAL_IMMEDIATE_MEMORY_RANGE] relative to same age peers. On the Design Learning subtest, [firstName] was shown a stimulus card containing geometric shapes distributed across four quadrants. The card was exposed for ten seconds and then removed. After a brief delay, [firstName] was asked to recall and draw the shapes in the correct locations. This procedure was repeated across four learning trials, providing an opportunity to observe how well [firstName] benefits from repeated exposure to the same visual material. This type of task is similar to situations in which students must learn and remember spatial arrangements, such as map details or geometric configurations. [firstName] obtained a scaled score of [DESIGN_MEMORY_IMMEDIATE_SCORE] ([DESIGN_MEMORY_IMMEDIATE_PERCENTILE] percentile), which falls within the [DESIGN_MEMORY_IMMEDIATE_RANGE] range. When asked to recall the design details in the correct locations after a twenty to thirty minute delay, [firstName] obtained a scaled score of [DESIGN_MEMORY_DELAYED_SCORE] ([DESIGN_MEMORY_DELAYED_PERCENTILE] percentile), which falls within the [DESIGN_MEMORY_DELAYED_RANGE] range. This delayed score reflects how well [firstName] can consolidate and later retrieve visual spatial information from long term memory, a skill that is important for retaining learned material from one lesson to the next. On the Picture Memory subtest, [firstName] was shown a meaningful visual scene and was then asked to look at a second, similar scene. Memory of the original picture is indicated by identifying elements that were altered, added, or removed in the second picture. Unlike Design Learning, this subtest draws on memory for contextually rich and meaningful visual information, which is more similar to everyday visual experiences. [firstName] obtained a scaled score of [PICTURE_MEMORY_IMMEDIATE_SCORE] ([PICTURE_MEMORY_IMMEDIATE_PERCENTILE] percentile), which falls within the [PICTURE_MEMORY_IMMEDIATE_RANGE] range. When asked to identify elements that were changed, added, or moved after a twenty to thirty minute delay, [firstName] obtained a scaled score of [PICTURE_MEMORY_DELAYED_SCORE] ([PICTURE_MEMORY_DELAYED_PERCENTILE] percentile), which falls within the [PICTURE_MEMORY_DELAYED_RANGE] range.

The Verbal Immediate Memory Index is an estimate of how well [firstName] can learn and recall verbal information shortly after hearing it. Verbal memory is central to classroom learning because much of what is taught is delivered through spoken language. The ability to listen to a teacher's explanation, hold the key ideas in mind, and recall them accurately is essential for following instructions, participating in discussions, and learning from lectures. This index is derived from the scaled scores earned on the Story Memory and Verbal Learning subtests. [firstName] obtained a standard score of [VERBAL_IMMEDIATE_MEMORY_SCORE] ([VERBAL_IMMEDIATE_MEMORY_PERCENTILE] percentile), which falls within the [VERBAL_IMMEDIATE_MEMORY_RANGE] range, suggesting that [possessive] ability to take in and immediately recall verbally presented information is [VERBAL_IMMEDIATE_MEMORY_RANGE] relative to same age peers. The Story Memory subtest assesses the ability to process, encode, and recall meaningful material that is presented in a sequential narrative format. In the immediate portion, the examiner reads two stories one at a time, and [firstName] was asked to retell each story from memory. Because the material is organized into a meaningful narrative, this subtest reflects how well [firstName] can use contextual meaning and story structure to support recall. [firstName] obtained a scaled score of [STORY_MEMORY_IMMEDIATE_SCORE] ([STORY_MEMORY_IMMEDIATE_PERCENTILE] percentile), which falls within the [STORY_MEMORY_IMMEDIATE_RANGE] range. On the delayed recall portion, administered after a twenty to thirty minute delay, [firstName] obtained a scaled score of [STORY_MEMORY_DELAYED_SCORE] ([STORY_MEMORY_DELAYED_PERCENTILE] percentile), which falls within the [STORY_MEMORY_DELAYED_RANGE] range. This delayed score reflects [possessive] ability to consolidate and retain meaningful verbal information over time, which is important for remembering what was taught earlier in a lesson or on a previous day. The Verbal Learning subtest assesses [firstName]'s ability to learn a list of unrelated words over four learning trials. Because the words are not connected by meaning, this task places heavier demands on rote verbal learning and measures how well [firstName] benefits from repetition when the material itself provides few contextual cues to support recall. [firstName] obtained a scaled score of [VERBAL_LEARNING_IMMEDIATE_SCORE] ([VERBAL_LEARNING_IMMEDIATE_PERCENTILE] percentile), which falls within the [VERBAL_LEARNING_IMMEDIATE_RANGE] range. On the delayed recall section, administered after a twenty to thirty minute delay, [firstName] obtained a scaled score of [VERBAL_LEARNING_DELAYED_SCORE] ([VERBAL_LEARNING_DELAYED_PERCENTILE] percentile), which falls within the [VERBAL_LEARNING_DELAYED_RANGE] range, reflecting [possessive] ability to store and later retrieve rote verbal material from long term memory.

The Attention and Concentration Index provides an estimate of how well [firstName] can learn and recall attentionally demanding, relatively rote, sequential information. Attention and concentration underlie all forms of memory because information cannot be stored effectively if it is not attended to in the first place. This domain is particularly relevant to tasks that require sustained focus, such as listening to multi step directions, copying from the board, or following a sequence of classroom instructions. Both auditory and visual information are sampled within this index. It is derived from the scaled scores earned on the Finger Windows and Number Letter subtests. [firstName] obtained a standard score of [ATTENTION_CONCENTRATION_SCORE] ([ATTENTION_CONCENTRATION_PERCENTILE] percentile), which falls within the [ATTENTION_CONCENTRATION_RANGE] range, suggesting that [possessive] ability to attend to and remember sequentially presented information is [ATTENTION_CONCENTRATION_RANGE] relative to same age peers. The Finger Windows subtest assesses the ability to attend to and remember a sequence of spatial locations. The examiner points to a pattern of holes, or windows, in a card in a specified order, and [firstName] must reproduce the sequence from memory. The pattern of windows becomes progressively longer as the subtest proceeds, placing increasing demands on visual sequential memory and the ability to maintain a mental representation of a spatial sequence. [firstName] obtained a scaled score of [FINGER_WINDOWS_SCORE] ([FINGER_WINDOWS_PERCENTILE] percentile), which falls within the [FINGER_WINDOWS_RANGE] range. The Number Letter subtest requires [firstName] to listen to a random mix of numbers and letters presented verbally and repeat them back in the exact order they were given. This task assesses auditory attention, working memory, and the ability to hold and reproduce sequential auditory information, which is similar to what is required when following a series of spoken instructions in the classroom. [firstName] obtained a scaled score of [NUMBER_LETTER_SCORE] ([NUMBER_LETTER_PERCENTILE] percentile), which falls within the [NUMBER_LETTER_RANGE] range.

The General Delayed Index provides an estimate of how well [firstName] can retain and later retrieve information that was learned earlier in the assessment session. After the immediate memory subtests were administered, approximately twenty to thirty minutes were allowed to pass before [firstName] was asked to recall the same material again without any additional exposure. This delayed recall format is important because it reflects the kind of memory required for learning in school, where students must remember information from one part of a lesson to the next, or from one day to the next. This index is derived from the scores earned on the Visual Delayed and Verbal Delayed Indexes and reflects how well [firstName] can retain both visual and verbal information over time. [firstName] obtained a standard score of [GENERAL_DELAYED_SCORE] ([GENERAL_DELAYED_PERCENTILE] percentile), which falls within the [GENERAL_DELAYED_RANGE] range, suggesting that [possessive] overall ability to consolidate and retrieve previously learned material after a delay is [GENERAL_DELAYED_RANGE] relative to same age peers.

The Visual Delayed Index is an estimate of how well [firstName] can retain and retrieve visual information after a twenty to thirty minute delay. This index reflects the ability to consolidate visual material into longer term storage and access it when needed, which is relevant for tasks such as remembering diagrams, visual instructions, or the layout of previously seen material. It is derived from the subtest scaled scores of Picture Memory Delayed and Design Learning Delayed. [firstName] obtained a standard score of [VISUAL_DELAYED_MEMORY_SCORE] ([VISUAL_DELAYED_MEMORY_PERCENTILE] percentile), which falls within the [VISUAL_DELAYED_MEMORY_RANGE] range.

The Verbal Delayed Index is an estimate of how well [firstName] can store and retrieve verbal information after a twenty to thirty minute delay. This index reflects the ability to consolidate verbally presented material into longer term memory and retrieve it when needed, which is essential for retaining information from classroom instruction, remembering what was read in a passage, or recalling details from a previous lesson. It is derived from the subtest scaled scores of Story Memory Delayed and Verbal Learning Delayed. [firstName] obtained a standard score of [VERBAL_DELAYED_MEMORY_SCORE] ([VERBAL_DELAYED_MEMORY_PERCENTILE] percentile), which falls within the [VERBAL_DELAYED_MEMORY_RANGE] range.`;

const VMI_TEMPLATE = `[firstName] was administered the Beery Buktenica Developmental Test of Visual Motor Integration Sixth Edition to assess the extent to which [pronoun] can integrate both visual and motor abilities. On the Visual Motor Integration test, where [firstName] had to copy various geometric forms of increasing difficulty without erasing, [pronoun] demonstrated [VMI_RANGE] ability to integrate visual perception and fine motor requirements (at around the [VMI_PERCENTILE] percentile).`;

// ── WAIS-IV COGNITIVE TEMPLATE (ages 16+) ──
const WAIS_COG_TEMPLATE = `Cognitive Functioning

The Wechsler Adult Intelligence Scale, Fourth Edition (WAIS-IV), was administered to assess overall cognitive functioning. Cognitive ability is a foundational factor that influences how efficiently an individual can acquire new knowledge, reason through complex problems, and adapt to the demands of academic and vocational settings. The WAIS-IV provides a Full Scale IQ (FSIQ), which represents a broad estimate of overall intellectual ability, as well as four index scores that reflect specific areas of cognitive functioning: Verbal Comprehension, Perceptual Reasoning, Working Memory, and Processing Speed. Taken together, these index scores provide a profile of cognitive strengths and areas of relative weakness that can help explain patterns of performance in school, at work, and in daily life. It is important to note that the FSIQ is most meaningful when the index scores are relatively consistent with one another. When significant variability exists across indexes, the individual index scores may provide a more accurate picture of cognitive functioning than the FSIQ alone. Scores are reported as standard scores with a mean of 100 and a standard deviation of 15. Percentile ranks indicate how performance compares to same age peers.

At the present moment, [firstName] obtained a Full Scale IQ score of [FSIQ_SCORE] ([FSIQ_PERCENTILE] percentile), which falls within the [FSIQ_DESCRIPTOR] range. This score provides a broad estimate of [firstName]'s overall intellectual ability and suggests that [possessive] general cognitive functioning is [FSIQ_DESCRIPTOR] when compared to same age peers.

Verbal Comprehension

The Verbal Comprehension Index (VCI) measures the ability to reason with verbal information, form and apply verbal concepts, and draw upon acquired knowledge and language skills. This domain is central to many aspects of everyday functioning, including understanding spoken and written language, expressing ideas clearly, following verbal instructions, and engaging in classroom discussions or workplace communication. Strong verbal comprehension supports the ability to learn from reading, understand complex instructions, and communicate ideas effectively. Individuals who perform well in this area tend to benefit from language based instruction and can often explain their reasoning with ease. [firstName] obtained a VCI score of [VCI_SCORE] ([VCI_PERCENTILE] percentile), which falls within the [VCI_DESCRIPTOR] range. This suggests that [firstName]'s ability to reason using language, understand verbal concepts, and apply acquired knowledge is [VCI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [SI_SCALED] on Similarities ([SI_PERCENTILE] percentile), which measures verbal reasoning and concept formation; [VC_SCALED] on Vocabulary ([VC_PERCENTILE] percentile), which measures word knowledge and verbal expression; and [IN_SCALED] on Information ([IN_PERCENTILE] percentile), which measures breadth of general factual knowledge. This pattern suggests that verbal reasoning represents [VCI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require understanding and explaining ideas using language.

Perceptual Reasoning

The Perceptual Reasoning Index (PRI) measures the ability to reason with nonverbal, visually presented information, including analysing visual patterns, solving novel problems without relying on language, and understanding spatial relationships. This domain is important for tasks that require figuring things out without verbal instruction, such as interpreting charts and graphs, understanding mechanical or spatial concepts, assembling objects, navigating unfamiliar environments, and solving problems that have not been encountered before. Strong perceptual reasoning supports the ability to think flexibly, recognize patterns, and approach novel situations with effective problem solving strategies. [firstName] obtained a PRI score of [PRI_SCORE] ([PRI_PERCENTILE] percentile), which falls within the [PRI_DESCRIPTOR] range. This suggests that [firstName]'s ability to analyse visual information, identify patterns, and reason through novel nonverbal problems is [PRI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [BD_SCALED] on Block Design ([BD_PERCENTILE] percentile), which measures spatial analysis and construction; [MR_SCALED] on Matrix Reasoning ([MR_PERCENTILE] percentile), which measures nonverbal abstract reasoning; and [VP_SCALED] on Visual Puzzles ([VP_PERCENTILE] percentile), which measures the ability to analyse and synthesize visual information. This pattern suggests that visual reasoning represents [PRI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require solving novel problems using visual information.

Working Memory

The Working Memory Index (WMI) measures the ability to hold information in mind temporarily, manipulate it mentally, and use it to complete a task. Working memory is essential for a wide range of academic and daily activities, including following multi step instructions, performing mental arithmetic, taking notes while listening, reading comprehension, and keeping track of information during conversations or complex tasks. Weaknesses in working memory can lead to difficulty following through on instructions, losing track of what one was doing, and needing information to be repeated. Even when an individual understands the material, limited working memory can make it difficult to manage the demands of tasks that require holding several pieces of information in mind at once. [firstName] obtained a WMI score of [WMI_SCORE] ([WMI_PERCENTILE] percentile), which falls within the [WMI_DESCRIPTOR] range. This suggests that [firstName]'s ability to hold information in mind, mentally manipulate it, and use it to complete a task is [WMI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [DS_SCALED] on Digit Span ([DS_PERCENTILE] percentile), which measures auditory short-term memory and mental manipulation of number sequences; and [AR_SCALED] on Arithmetic ([AR_PERCENTILE] percentile), which measures mental computation and quantitative reasoning under timed conditions. This pattern suggests that working memory represents [WMI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require following multi step instructions or mentally manipulating information.

Processing Speed

The Processing Speed Index (PSI) measures the speed and accuracy with which an individual can scan, identify, and respond to simple visual information under timed conditions. Processing speed is not a measure of how quickly someone thinks in general, but rather how efficiently they can perform routine cognitive tasks that require sustained visual attention and consistent output. This domain is relevant to many academic and vocational activities, including completing timed tests, copying information, scanning text for specific details, and keeping pace with the flow of classroom instruction or workplace demands. Slower processing speed can mean that an individual requires more time to complete routine tasks, even when they fully understand the material. This can sometimes be mistaken for a lack of understanding or motivation, when in reality the individual simply needs more time to demonstrate what they know. [firstName] obtained a PSI score of [PSI_SCORE] ([PSI_PERCENTILE] percentile), which falls within the [PSI_DESCRIPTOR] range. This suggests that [firstName]'s speed and accuracy when performing routine visual cognitive tasks is [PSI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [SS_SCALED] on Symbol Search ([SS_PERCENTILE] percentile), which measures visual scanning speed and decision making; and [CD_SCALED] on Coding ([CD_PERCENTILE] percentile), which measures speed of transcribing simple visual information using a key. This pattern suggests that processing efficiency represents [PSI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require quick visual attention and consistent pace.

Cognitive Profile Summary

Overall, [firstName] demonstrates cognitive functioning within the [FSIQ_DESCRIPTOR] range, with variability observed across domains. Relative strengths were observed in [WAIS_STRENGTHS]. Areas of somewhat weaker performance were observed in [WAIS_WEAKER_AREAS]. This profile suggests that [firstName] may show stronger learning efficiency when tasks align with relative strengths, and may require additional time or support at times when tasks place heavier demands on relative weaker areas.`;

// ── WPPSI-IV COGNITIVE TEMPLATE (ages < 6) ──
const WPPSI_COG_TEMPLATE = `Cognitive Functioning

The Wechsler Preschool and Primary Scale of Intelligence, Fourth Edition (WPPSI-IV), was administered to assess overall cognitive functioning. Cognitive ability in early childhood provides important information about how a young child is developing the thinking skills that will support future learning. At this stage of development, cognitive abilities are still emerging and can be influenced by a wide range of factors, including language exposure, early learning experiences, temperament, and the child's comfort and engagement during testing. The WPPSI-IV provides a Full Scale IQ (FSIQ), which represents a broad estimate of overall intellectual ability, as well as five index scores that reflect specific areas of early cognitive development: Verbal Comprehension, Visual Spatial, Fluid Reasoning, Working Memory, and Processing Speed. Taken together, these index scores provide a profile of cognitive strengths and areas of relative weakness that can help identify where a young child may benefit from additional support as they transition into formal schooling. It is important to note that the FSIQ is most meaningful when the index scores are relatively consistent with one another. When significant variability exists across indexes, the individual index scores may provide a more accurate picture of cognitive functioning than the FSIQ alone. Scores are reported as standard scores with a mean of 100 and a standard deviation of 15. Percentile ranks indicate how performance compares to same age peers.

At the present moment, [firstName] obtained a Full Scale IQ score of [FSIQ_SCORE] ([FSIQ_PERCENTILE] percentile), which falls within the [FSIQ_DESCRIPTOR] range. This score provides a broad estimate of [firstName]'s overall intellectual ability and suggests that [possessive] general cognitive functioning is [FSIQ_DESCRIPTOR] when compared to same age peers.

Verbal Comprehension

The Verbal Comprehension Index (VCI) measures early verbal reasoning and understanding of language based concepts. This domain reflects how well a young child can understand words, express ideas, and use language to reason about the world. Verbal comprehension is foundational for early literacy development, following verbal instructions from caregivers and teachers, participating in group learning activities, and building the vocabulary and language skills that support reading readiness. Children who perform well in this area tend to learn effectively from spoken explanations, can express their needs and ideas with relative ease, and are typically well prepared for the language demands of formal schooling. [firstName] obtained a VCI score of [VCI_SCORE] ([VCI_PERCENTILE] percentile), which falls within the [VCI_DESCRIPTOR] range. This suggests that [firstName]'s ability to understand verbal concepts, use language to reason, and express ideas is [VCI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [RV_SCALED] on Receptive Vocabulary ([RV_PERCENTILE] percentile), which measures listening vocabulary and word knowledge; and [IN_SCALED] on Information ([IN_PERCENTILE] percentile), which measures breadth of general factual knowledge acquired from the environment. This pattern suggests that language based reasoning represents [VCI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require understanding words and explaining ideas.

Visual Spatial

The Visual Spatial Index (VSI) measures the ability to understand and organize visual information, including perceiving spatial relationships, analysing visual details, and mentally constructing designs or patterns. Visual spatial skills support a wide range of early learning activities, including recognizing shapes and letters, understanding the layout of a page, assembling puzzles, navigating physical spaces, and developing early mathematical concepts such as size, position, and quantity. Children who perform well in this area tend to notice visual details, enjoy building and constructing activities, and can often learn effectively from pictures, diagrams, and demonstrations. [firstName] obtained a VSI score of [VSI_SCORE] ([VSI_PERCENTILE] percentile), which falls within the [VSI_DESCRIPTOR] range. This suggests that [firstName]'s ability to perceive, analyse, and organize visual spatial information is [VSI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [BD_SCALED] on Block Design ([BD_PERCENTILE] percentile), which measures spatial analysis and construction using blocks; and [OA_SCALED] on Object Assembly ([OA_PERCENTILE] percentile), which measures the ability to assemble puzzle pieces into a meaningful whole. This pattern suggests that visual spatial skills represent [VSI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require noticing details and working with shapes and patterns.

Fluid Reasoning

The Fluid Reasoning Index (FRI) measures early problem solving ability when working with new information that has not been previously learned. Fluid reasoning reflects the capacity to identify patterns, understand relationships between concepts, and figure out rules or solutions without relying on previously acquired knowledge. This domain is important because it provides information about how well a young child can approach unfamiliar problems and think flexibly, which supports learning across many different areas. Children who perform well in fluid reasoning tend to pick up on new concepts quickly, notice how things are connected, and can often figure out what comes next in a pattern or sequence. [firstName] obtained a FRI score of [FRI_SCORE] ([FRI_PERCENTILE] percentile), which falls within the [FRI_DESCRIPTOR] range. This suggests that [firstName]'s ability to reason through new problems, identify patterns, and understand relationships between concepts is [FRI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [MR_SCALED] on Matrix Reasoning ([MR_PERCENTILE] percentile), which measures nonverbal abstract reasoning and pattern recognition; and [PC_SCALED] on Picture Concepts ([PC_PERCENTILE] percentile), which measures the ability to identify relationships among visual objects and form categories. This pattern suggests that early reasoning represents [FRI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require finding rules or relationships.

Working Memory

The Working Memory Index (WMI) measures the ability to hold information in mind temporarily and use it to complete a task. In early childhood, working memory supports the ability to follow multi step directions, remember what a teacher just said while carrying out an instruction, keep track of a sequence of activities, and begin to manage simple mental tasks such as counting or sorting. Weaknesses in working memory at this age can look like difficulty following directions that involve more than one step, frequently forgetting what was just said, or losing track of what they were doing in the middle of an activity. Even when a young child understands what is being asked, limited working memory can make it difficult to hold all the pieces of a task in mind long enough to complete it. [firstName] obtained a WMI score of [WMI_SCORE] ([WMI_PERCENTILE] percentile), which falls within the [WMI_DESCRIPTOR] range. This suggests that [firstName]'s ability to hold information in mind and use it to complete a task is [WMI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [PM_SCALED] on Picture Memory ([PM_PERCENTILE] percentile), which measures visual working memory by requiring recall of images after a brief exposure; and [ZL_SCALED] on Zoo Locations ([ZL_PERCENTILE] percentile), which measures spatial working memory by requiring recall of where animals were placed on a grid. This pattern suggests that working memory represents [WMI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require listening and remembering instructions.

Processing Speed

The Processing Speed Index (PSI) measures the speed and accuracy with which a young child can notice and respond to simple visual information under structured conditions. Processing speed is not a measure of how quickly a child thinks in general, but rather how efficiently they can perform simple, routine visual tasks that require sustained attention and consistent output. In early childhood, this domain is relevant to activities such as scanning a page for a specific picture, completing simple matching tasks, and keeping pace with structured group activities. Slower processing speed can mean that a young child needs more time to complete routine tasks, even when they understand the activity. This can sometimes be mistaken for a lack of interest or understanding when the child simply requires additional time to demonstrate their abilities. [firstName] obtained a PSI score of [PSI_SCORE] ([PSI_PERCENTILE] percentile), which falls within the [PSI_DESCRIPTOR] range. This suggests that [firstName]'s speed and accuracy when performing simple visual tasks is [PSI_DESCRIPTOR] relative to same age peers. Within this domain, [firstName] scored [BS_SCALED] on Bug Search ([BS_PERCENTILE] percentile), which measures visual scanning speed and matching; and [CA_SCALED] on Cancellation ([CA_PERCENTILE] percentile), which measures speed of identifying and marking target images among distractors. This pattern suggests that processing efficiency represents [PSI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require quick and steady responding.

Cognitive Profile Summary

Overall, [firstName] demonstrates cognitive functioning within the [FSIQ_DESCRIPTOR] range, with variability observed across domains. Relative strengths were observed in [WPPSI_STRENGTHS]. Areas of somewhat weaker performance were observed in [WPPSI_WEAKER_AREAS]. This profile suggests that [firstName] may show stronger learning efficiency in structured activities that align with relative strengths, and may require additional time or support at times when tasks place heavier demands on relative weaker areas.`;

const WIAT_TEMPLATE = `Academic Testing

Academic skills are tested in a highly structured and one on one testing environment that is not typical of the regular classroom. Moreover, academic skills are tested in isolation of other demands. This means that how students coordinate their individual skills for complex tasks is not determined by academic testing alone but is better accounted for by psychological examination in the areas that precede this section. [firstName]'s academic strengths and weaknesses were assessed using the Wechsler Individual Achievement Test Third Edition Canadian, an individually administered instrument that measures the achievement of students and uses Canadian norms. Standard scores have a mean of 100 and a standard deviation of 15. Percentile ranks indicate how performance compares to same age peers.

Oral Language

To assess [firstName]'s oral language skills, the Listening Comprehension subtest was administered. [firstName] obtained a standard score of [LISTENING_COMPREHENSION_SS] in Listening Comprehension, which falls in the [LISTENING_COMPREHENSION_RANGE] range ([LISTENING_COMPREHENSION_PERCENTILE] percentile). This subtest measures a student's ability to understand spoken language and receptive language. Within this domain, Receptive Vocabulary, which measures listening vocabulary, yielded a standard score of [RECEPTIVE_VOCABULARY_SS] falling within the [RECEPTIVE_VOCABULARY_RANGE] range ([RECEPTIVE_VOCABULARY_PERCENTILE] percentile). Oral Discourse Comprehension, which measures the ability to understand spoken passages, yielded a standard score of [ORAL_DISCOURSE_SS] falling within the [ORAL_DISCOURSE_RANGE] range ([ORAL_DISCOURSE_PERCENTILE] percentile). Overall, [firstName]'s Oral Language Composite, which provides a broad measure of oral language skills, yielded a standard score of [ORAL_LANGUAGE_COMPOSITE_SS] falling in the [ORAL_LANGUAGE_COMPOSITE_RANGE] range ([ORAL_LANGUAGE_COMPOSITE_PERCENTILE] percentile).

Reading

In the area of reading, the Word Reading subtest measures word recognition accuracy. [firstName] obtained a standard score of [WORD_READING_SS], which falls in the [WORD_READING_RANGE] range ([WORD_READING_PERCENTILE] percentile). The Pseudoword Decoding subtest, which measures the ability to decode unfamiliar words using phonetic strategies, yielded a standard score of [PSEUDOWORD_DECODING_SS] falling in the [PSEUDOWORD_DECODING_RANGE] range ([PSEUDOWORD_DECODING_PERCENTILE] percentile). Reading Comprehension, which measures the ability to understand and draw meaning from written passages, yielded a standard score of [READING_COMPREHENSION_SS] falling in the [READING_COMPREHENSION_RANGE] range ([READING_COMPREHENSION_PERCENTILE] percentile). Oral Reading Fluency, which measures the speed and accuracy of contextual reading aloud, yielded a standard score of [ORAL_READING_FLUENCY_SS] falling in the [ORAL_READING_FLUENCY_RANGE] range ([ORAL_READING_FLUENCY_PERCENTILE] percentile). The Basic Reading Composite, which measures fundamental reading skills including word recognition and decoding, yielded a standard score of [BASIC_READING_SS] falling in the [BASIC_READING_RANGE] range ([BASIC_READING_PERCENTILE] percentile). The Reading Comprehension and Fluency Composite, which combines reading comprehension and oral reading fluency, yielded a standard score of [READING_COMPREHENSION_FLUENCY_SS] falling in the [READING_COMPREHENSION_FLUENCY_RANGE] range ([READING_COMPREHENSION_FLUENCY_PERCENTILE] percentile). The Total Reading Composite, which provides an overall measure of reading ability combining word reading accuracy, decoding, comprehension, and fluency, yielded a standard score of [TOTAL_READING_SS] falling in the [TOTAL_READING_RANGE] range ([TOTAL_READING_PERCENTILE] percentile).

Written Expression

In the area of written expression, Spelling, which measures the ability to spell dictated words, yielded a standard score of [SPELLING_SS] falling in the [SPELLING_RANGE] range ([SPELLING_PERCENTILE] percentile). Sentence Composition, which measures the ability to write grammatically correct and meaningful sentences, yielded a standard score of [SENTENCE_COMPOSITION_SS] falling in the [SENTENCE_COMPOSITION_RANGE] range ([SENTENCE_COMPOSITION_PERCENTILE] percentile). Essay Composition, which measures written expression, organization, and the development of ideas in extended writing, yielded a standard score of [ESSAY_COMPOSITION_SS] falling in the [ESSAY_COMPOSITION_RANGE] range ([ESSAY_COMPOSITION_PERCENTILE] percentile). The Written Expression Composite, which provides an overall measure of written language skills, yielded a standard score of [WRITTEN_EXPRESSION_SS] falling in the [WRITTEN_EXPRESSION_RANGE] range ([WRITTEN_EXPRESSION_PERCENTILE] percentile).

Mathematics

In the area of mathematics, Math Problem Solving, which measures mathematical reasoning and applied math skills, yielded a standard score of [MATH_PROBLEM_SOLVING_SS] falling in the [MATH_PROBLEM_SOLVING_RANGE] range ([MATH_PROBLEM_SOLVING_PERCENTILE] percentile). Numerical Operations, which measures the ability to solve written math calculation problems, yielded a standard score of [NUMERICAL_OPERATIONS_SS] falling in the [NUMERICAL_OPERATIONS_RANGE] range ([NUMERICAL_OPERATIONS_PERCENTILE] percentile). The Mathematics Composite, which provides an overall measure of mathematical ability, yielded a standard score of [MATHEMATICS_COMPOSITE_SS] falling in the [MATHEMATICS_COMPOSITE_RANGE] range ([MATHEMATICS_COMPOSITE_PERCENTILE] percentile).

Overall Academic Functioning

[firstName]'s Total Achievement Composite, which provides the broadest measure of overall academic functioning across oral language, reading, written expression, and mathematics, yielded a standard score of [TOTAL_ACHIEVEMENT_SS] falling in the [TOTAL_ACHIEVEMENT_RANGE] range ([TOTAL_ACHIEVEMENT_PERCENTILE] percentile).`;

const SEC_PROMPTS = {
  referral: `Write the REASONS FOR REFERRAL section. Always generate output. Never ask for missing information.
Include: Who referred the student and why. Specific concerns (academic, behavioural, cognitive, social, emotional, adaptive). Assessment purpose. Previous assessments if relevant.
Use professional school psychologist tone. Use [firstName] and pronoun placeholders. Use cautious phrasing. Do not diagnose. Output only the section content.`,
  background: `Write the BACKGROUND INFORMATION section body. Do NOT include the opening sentence (it is prepended automatically).
Start with family/living situation. Include: languages spoken, birth/developmental history, medical history (vision, hearing, health), educational history, social and emotional development, previous assessments.
RULES:
- Do NOT mention custody arrangements unless the intake specifically indicates a non-standard custody situation (e.g., sole custody, legal guardian, court involvement).
- Do NOT elaborate on or list symptoms of family members' mental health conditions. Simply state the condition name as reported (e.g., "His mother reported a history of borderline personality disorder and bipolar traits"). Do not list associated symptoms, do not explain the condition.
- Use only information provided. Use professional cautious language. Use [firstName] and pronouns. Do not diagnose. Do not include bullet points. Output only the section content.`,
  doc_review: `Write the REVIEW OF DOCUMENTS section. This section summarizes relevant information obtained from a review of documents provided as part of the assessment.
Structure the section by document type, using subheadings where appropriate:
1. Previous Assessments: If previous psychoeducational, psychological, speech-language, occupational therapy, or other assessments were provided, summarize key findings, diagnoses, and recommendations from each. Include the date, assessor name, and assessment type if available.
2. Report Cards: If school report cards were provided, summarize academic performance trends, teacher comments regarding strengths and areas of concern, learning skills ratings, and any IEP or accommodation notes. Reference the grade and term where possible.
3. Notes from Parents, Teachers, and Other Professionals: If letters, emails, or notes from parents, teachers, tutors, physicians, or other professionals were provided, summarize the relevant concerns, observations, and recommendations communicated.
RULES:
- Only include subsections for document types that were actually provided. Do not reference documents that were not uploaded.
- Summarize — do not copy text verbatim from documents.
- Use professional, objective language. Report what the documents state without interpreting or diagnosing.
- Use [firstName] and pronouns throughout.
- Do not include bullet points. Write in paragraph form.
- Output only the section content.`,
  observations: `Write the BEHAVIOUR OBSERVATIONS section for a psychoeducational assessment report.
You will be given a set of SELECTED BEHAVIOUR OBSERVATION INPUTS describing the student's presentation during testing.
Your task is to compose these observations into a coherent, professional paragraph narrative.
Start with the standard testing setting: 'Testing was conducted at the psychological assessment center in a quiet room with minimal to no distractions. Assessment stimuli were presented on an iPad or computer monitor positioned to the right of [firstName], in accordance with standardized procedures.'
Then weave the selected observations into natural paragraphs covering: appearance and demeanour, engagement and cooperation, attention and concentration, motor skills and handwriting, and a validity conclusion.
Use [firstName] and correct pronouns throughout. Do not add observations that were not selected. Do not diagnose. Describe only observable behaviour. Use professional, cautious language. Output only the section content.`,
  cognitive: `Extract the interpretive text from the uploaded WISC-V (or WPPSI/WAIS) report document and output it as the Cognitive/Intellectual Functioning section.
Steps: 1. Find the section starting with "ABOUT WISC-V CDN SCORES" or similar. 2. Copy all interpretive text verbatim. 3. Stop before the SUMMARY section. 4. Remove page headers/footers and copyright lines. 5. Replace the child's name with [FIRST_NAME]. 6. Replace pronouns.
If no uploaded cognitive report text is found, write the section from provided scores using professional school psychologist tone.

WAIS (Ages 17+) SPECIFIC INSTRUCTIONS:
If the assessment uses the WAIS-IV (Wechsler Adult Intelligence Scale-4th Edition), you MUST write a thorough and comprehensive narrative overview of all cognitive results. This is NOT a template fill — you must write a full interpretive report section.
Requirements for WAIS sections:
- Report EVERY index score and subtest score with its exact percentile rank and classification range.
- Describe each index (Verbal Comprehension, Perceptual Reasoning, Working Memory, Processing Speed) in its own paragraph with all contributing subtests, their scaled scores, and percentiles.
- Report the Full Scale IQ (FSIQ) with percentile and confidence interval.
- Include the General Ability Index (GAI) if available.
- Compare index scores and note any statistically significant discrepancies.
- Be SPECIFIC and OBJECTIVE: state only what the scores show. Do not speculate, infer, or add clinical impressions beyond what the data supports.
- Do NOT use placeholders like [range], [percentile], [score], [classification]. You MUST write the actual numeric values and classification labels.
- If EXTRACTED SCORES are provided in the context, use those EXACT values. Do not guess or invent scores.
- Do NOT add information that is not in the source documents. Do NOT omit any scores that are present.
- Use exact score values as they appear in the source. Do not round, estimate, or approximate.
- Use professional school psychologist tone with cautious, evidence-based phrasing.
- Use [FIRST_NAME] for the student's name throughout.

CRITICAL — STRUCTURED SCORE SUMMARY: After the narrative section, you MUST include a clearly labeled score summary block in this EXACT format (one line per score). This is used for automatic table generation:
--- SCORE SUMMARY ---
FSIQ = [score], PR = [percentile]
VCI = [score], PR = [percentile]
PRI = [score], PR = [percentile]
WMI = [score], PR = [percentile]
PSI = [score], PR = [percentile]
GAI = [score], PR = [percentile]
SI = [scaled], PR = [percentile]
VC = [scaled], PR = [percentile]
IN = [scaled], PR = [percentile]
BD = [scaled], PR = [percentile]
MR = [scaled], PR = [percentile]
VP = [scaled], PR = [percentile]
DS = [scaled], PR = [percentile]
AR = [scaled], PR = [percentile]
SS = [scaled], PR = [percentile]
CD = [scaled], PR = [percentile]
--- END SCORE SUMMARY ---
Include ONLY scores that are present in the source data. Omit any line where the score is not available.

IMPORTANT — ANCILLARY INDEX ANALYSIS: After the five primary index scores, always include ancillary indexes in the WISC-V PDF report style. Include these paragraphs:
1. Intro paragraph: "In addition to the index scores described above, [FIRST_NAME] was administered subtests contributing to several ancillary index scores. Ancillary index scores do not replace the FSIQ and primary index scores, but are meant to provide additional information about [FIRST_NAME]'s cognitive profile."
2. Nonverbal Index (NVI): Describe it as derived from six subtests not requiring verbal responses, drawn from Visual Spatial, Fluid Reasoning, Working Memory, and Processing Speed domains. State it can estimate overall nonverbal cognitive ability.
3. General Ability Index (GAI): Describe as an estimate of general intelligence less impacted by working memory and processing speed. State it consists of subtests from verbal comprehension, visual spatial, and fluid reasoning. Note whether GAI and FSIQ are significantly different. Explain the GAI provides a clearer estimate of reasoning potential.
4. Cognitive Proficiency Index (CPI): Describe as drawn from working memory and processing speed domains. Explain low CPI may occur due to visual/auditory processing deficits, inattention, distractibility, visuomotor difficulties, limited working memory, or generally low cognitive ability. State CPI is most informative together with GAI. If GAI > CPI, state that higher-order abilities may be a strength compared to processing efficiency. Describe real-world impact: "Relative weaknesses in mental control and speed of visual scanning may sometimes create challenges as [FIRST_NAME] engages in more complex cognitive processes, such as learning new material or applying logical thinking skills."
Use provided scores only. Apply [FIRST_NAME] and pronouns throughout.`,
  memory: `WRAML-3 Memory and Learning Section Auto Population and Summary Generation.
LOCKED TEMPLATE PROTECTION: Only replace placeholders. Do NOT rewrite, rephrase, shorten, expand, or modify existing sentences.
Step 1: Extract scores from WRAML-3 Score Report PDF for each subtest and index.
Step 2: For index standard score placeholders like [GENERAL_IMMEDIATE_MEMORY_SCORE], insert the standard score number. For index percentile placeholders like [GENERAL_IMMEDIATE_MEMORY_PERCENTILE], insert the percentile rank with ordinal suffix (e.g., 42nd, 1st, 95th). For index range placeholders like [GENERAL_IMMEDIATE_MEMORY_RANGE], determine classification: 40-69=Very Low, 70-79=Low, 80-89=Low Average, 90-109=Average, 110-119=High Average, 120-129=Very High, 130+=Extremely High.
For subtest scaled score placeholders like [DESIGN_MEMORY_IMMEDIATE_SCORE], insert the scaled score number. For subtest percentile placeholders like [DESIGN_MEMORY_IMMEDIATE_PERCENTILE], convert scaled score to approximate percentile using: SS1=0.1, SS2=0.4, SS3=1, SS4=2, SS5=5, SS6=9, SS7=16, SS8=25, SS9=37, SS10=50, SS11=63, SS12=75, SS13=84, SS14=91, SS15=95, SS16=98, SS17=99.6, SS18=99.9, SS19=99.9 and add ordinal suffix. For subtest range placeholders like [DESIGN_MEMORY_IMMEDIATE_RANGE], determine classification: 1-3=Very Low, 4-5=Low, 6-7=Low Average, 8-12=Average, 13-15=High Average, 16+=Very High.
IMPORTANT: Always include percentile ranks in parentheses after every score. Format: "standard score of 96 (39th percentile)" or "scaled score of 9 (37th percentile)".
Step 3: Replace each placeholder with extracted values.
Step 4: Use correct pronouns throughout.
Step 5: Add Summary of Memory and Learning (150-250 words) covering overall functioning, immediate vs delayed, visual vs verbal, attention, strengths, weaknesses.
Use cautious language. Avoid diagnosis. Output final report text only.`,
  visual_motor: `Beery VMI Section Population Using Manual Percentile Entry.
CRITICAL: The paragraph MUST begin with "[firstName] was administered the Beery Buktenica Developmental Test of Visual Motor Integration..."
LOCKED TEMPLATE: Only replace [VMI_PERCENTILE] and [VMI_RANGE].
Convert percentile to range: 0.1-2=Very Low, 3-8=Low, 9-24=Low Average, 25-74=Average, 75-90=Above Average, 91-97=High, 98-99.9=Very High.
Add summary paragraph based on range. Use [firstName] and pronouns. Output final text only.`,
  social_emotional: `Write the Socio Emotional Functioning section. IMPORTANT: Use ONLY data from uploaded PDFs and structured rating scale data.
RULES: Describe functioning only. Never diagnose. Never use "aggressive" or "violent". Use softened language: "appears to", "may at times", "results suggest".
Structure for each test: 1. Full test name 2. Who completed it 3. Brief test description 4. Results by domain (Emotional, Behavioural, Attention, Social, Adaptive) 5. Multi-respondent comparison if applicable 6. Strengths.
Classification language: Within Expected/Average = "age appropriate functioning". Elevated/At Risk = "may at times experience difficulty". Very Elevated/Clinically Significant = "may experience notable difficulty".
Apply MODIFIER focus (STANDARD/EMOTIONAL/ADHD/AUTISM/OTHER) to interpretation emphasis.
End with Summary of Socio Emotional Functioning (150-250 words). Use [firstName] and pronouns. Output report text only.`,
  adaptive: "Write the DEVELOPMENT AND ADAPTIVE FUNCTIONING section. Interpret ABAS or Vineland results: GAC, Conceptual, Social, Practical domains with percentiles. Include both parent and teacher forms if available.",
  academic: `WIAT-III Academic Testing Section — Auto-fill template with standard scores, ranges, and percentiles.

You MUST use the following LOCKED TEMPLATE structure. Fill in EVERY placeholder with actual scores from the uploaded WIAT-III Score Report.

CLASSIFICATION RULES — Convert Standard Score (SS) to range label:
  SS 130+     = "Very Superior"
  SS 120-129  = "Superior"
  SS 110-119  = "High Average"
  SS 90-109   = "Average"
  SS 80-89    = "Low Average"
  SS 70-79    = "Borderline"
  SS below 70 = "Extremely Low"

For EACH subtest and composite, you MUST:
1. Find the Standard Score (SS) in the WIAT-III data
2. Find the Percentile Rank in the WIAT-III data
3. Replace [SUBTEST_SS] with the actual standard score number (e.g., "102", "85")
4. Replace [SUBTEST_RANGE] with the classification label from the table above (e.g., "Average", "Low Average")
5. Replace [SUBTEST_PERCENTILE] with the actual percentile followed by ordinal suffix (e.g., "45th", "2nd", "91st")

SUBTESTS to fill: Listening Comprehension, Receptive Vocabulary, Oral Discourse Comprehension, Word Reading, Pseudoword Decoding, Reading Comprehension, Oral Reading Fluency, Spelling, Sentence Composition, Essay Composition, Math Problem Solving, Numerical Operations.
COMPOSITES to fill: Oral Language Composite, Total Reading Composite, Basic Reading Composite, Reading Comprehension and Fluency Composite, Written Expression Composite, Mathematics Composite, Total Achievement.

CRITICAL RULES:
- Do NOT guess any scores. Use ONLY values explicitly present in the uploaded data.
- If a score is NOT found in the data, use [score not available] as the placeholder — do NOT leave the template placeholder or make up a value.
- Do NOT add, remove, or rephrase any template sentences. Only replace the placeholders.
- Copy percentile values EXACTLY as they appear. Do not round or estimate.
- Every subtest MUST have a SS, RANGE, and PERCENTILE filled in if the data is available.

After filling the template, add an Academic Summary (150-250 words) covering: overall academic functioning (Total Achievement), oral language, reading (including Total Reading, Basic Reading, and Reading Comprehension and Fluency composites), writing (including Written Expression composite), mathematics (including Mathematics composite), strengths and weaknesses.
Use cautious phrasing. Avoid diagnosis. Use [firstName] and pronouns. Output report text only.`,
  summary: `Write the Summary, Formulation & Diagnosis section. This integrates ALL findings and leads to a diagnostic conclusion.
Structure:
1. Referral and purpose (2-3 sentences)
2. Cognitive summary — key scores, index patterns, ancillary indexes
3. Detailed academic profile — all areas with percentiles, composites
4. Memory, processing, visual-motor summary
5. Socio-emotional and adaptive summary
6. Interpretive considerations — behavioural observations, functional impact
7. Integrated formulation explaining how patterns connect — why the profile leads to the diagnosis (or why it does not)
8. Diagnostic rationale — evaluate against criteria for each selected modifier:
   For LEARNING DISABILITY: Evaluate LDAO criteria: Average+ IQ, academic underachievement, processing weaknesses, exclusionary factors, functional impact.
   For GIFTED: Evaluate FSIQ/index scores in gifted range.
   For MID/DD: Evaluate BOTH cognitive AND adaptive functioning.
   For ADHD: Evaluate observations, rating scales, cognitive indicators. HIGH CAUTION. State "Formal diagnosis requires medical evaluation."
   For AUTISM: MAXIMUM CAUTION. Rely on behavioural evidence, not rating scales alone.
   For NO DIAGNOSIS: Explain why criteria not met.
9. Diagnostic conclusion statement — the diagnosis flows naturally from the evidence presented above.
This is a legal document. Reasoning must be explicit and evidence-based.
Use cautious language. No bullet points. Use [firstName] and pronouns. Output section text only.`,
  strengths_needs: `Write the STRENGTHS AND NEEDS section. This will be rendered as a two-column table (Strengths | Weaknesses). Format as:

STRENGTHS
• [One ability per line — e.g., Verbal Comprehension]
• [e.g., Mathematics]
• [e.g., Adaptive Functioning]
• [Include personal qualities — e.g., Persistence, Peer Relationships]

WEAKNESSES
• [One ability per line — e.g., Working Memory]
• [e.g., Processing Speed]
• [e.g., Reading Decoding]
• [Include socio-emotional concerns — e.g., Academic Anxiety]

RULES:
- Each line is ONE short ability name. No full sentences. No scores. No percentiles. No explanations.
- Use broad composite/index names, NOT individual subtests (e.g., write "Processing Speed" not "Coding" or "Symbol Search").
- Use teacher-friendly ability names: "Reading Decoding" (not "Basic Reading"), "Phonological Awareness" (not "Pseudoword Decoding").
- Do NOT repeat abilities that overlap (e.g., if "Reading Decoding" is listed, do NOT also list "Word Reading").
- Do NOT use technical jargon like "GAI–CPI Discrepancy" — teachers need plain ability names they recognise.
- This is a quick-glance reference table of abilities for teachers.`,
  recommendations: `Write the Recommendations section.
Begin with: "Based on the results of this assessment, the following recommendations are being made to support [firstName]'s educational programming and development."
Include selected blocks in order: IPRC identification (combine multiple categories into one sentence), IEP/Accommodations, SEA/Assistive Technology, Referrals, Socio-Emotional supports.
For IPRC, use: "Consideration should be given to placement in a special education program under the exceptionality of [category] through the Identification, Placement, and Review Committee (IPRC) process."
Adapt to educational level (Elementary/High School/College-University).
End with: "It was a pleasure to have had the opportunity to work with [firstName]. I trust that the information contained in this report, as well as the recommendations provided above, will aid in providing [object] with the most appropriate support."
Use [firstName] and pronouns. Use bullet points for recommendations.`,
  appendix: `Write the Appendix: Detailed Recommendations and Intervention Strategies.
Include only selected APPENDIX_BLOCKS. For each, write specific, actionable, step-by-step recommendations.
IMPORTANT — WISC-V COGNITIVE PROFILE RECOMMENDATIONS: If the cognitive section includes WISC-V results, ALWAYS start the appendix with a section titled "WISC-V Cognitive Profile Recommendations:" that includes:
1. Working Memory Recommendations: If WMI is below Average, provide strategies for chunking information, external memory aids, repeating/rephrasing instructions, reducing cognitive load, visual supports, mnemonic strategies, and extra time for mental manipulation tasks.
2. Processing Speed Recommendations: If PSI is below Average, provide strategies for extended time, reduced volume of written work, avoiding timed tasks, advance organisers, calculator use, copies of notes, and keyboard/speech-to-text tools.
3. GAI-CPI Discrepancy Recommendations: If GAI > CPI significantly, explain that reasoning is stronger than processing efficiency, leverage reasoning strengths in instruction, provide accommodations for output, allow alternative demonstrations of understanding, and monitor for frustration.
Extract specific WISC-V recommendations from the uploaded PDF if available.
Additional Domains: Reading, Writing, Mathematics, Attention/EF, Memory, Processing Speed, Language, Visual-Motor, Socio-Emotional, Adaptive, Giftedness, LD Support, Post-Secondary.
Adapt to educational level. Personalize to student's documented profile.
Use [firstName] and pronouns. Use bullet points under clear headings. Output section text only.`,
  appendix_tables: `SECTION: APPENDIX — Tables

MANDATORY INCLUSION RULE
You will always generate and include the WISC-V and WIAT-III score summary tables in this APPENDIX Tables section.
These tables must appear in every report.
These tables must appear exactly in the format and order specified below.
You will never omit these tables.
You will never add additional cognitive or academic tables.
You will never modify the structure, column names, or row names.

DATA SOURCE RULE
You will populate these tables using only values explicitly present in DOCUMENT EXCERPTS.
DOCUMENT EXCERPTS contain text extracted from uploaded PDF, DOCX, or image files.
You will carefully scan DOCUMENT EXCERPTS for the following sections:
  WISC-V Subtest Score Summary
  WISC-V Index Score Summary
  WIAT-III Subtest Score Summary
You will extract only explicitly stated:
  Scaled Scores
  Standard Scores
  Percentile Ranks
  Classification labels
You will copy values exactly as written.
You will not reinterpret values.
You will not calculate values.
You will not estimate values.
You will not infer values.
You will not generate values.
You will not modify classification labels.
You will only transfer values that exist in DOCUMENT EXCERPTS.

MISSING DATA RULE
If a score, percentile rank, or classification is not present in DOCUMENT EXCERPTS, you will insert the placeholder symbol: —
You will never leave cells blank.
You will never remove rows.
You will never remove tables.

OUTPUT FORMAT — Output ONLY valid HTML. No markdown. No code blocks. No backticks. No explanatory text.

HTML STYLING — use inline styles on every element:
- Each table: style="width:100%;border-collapse:collapse;margin:6pt 0 6pt 0;font-family:'Times New Roman',Times,serif;font-size:11pt;border:0.5pt solid #666"
- Caption/title row: style="font-weight:bold;font-size:12pt;padding:6px 10px;text-align:left;border:0.5pt solid #666"
- Column headers (th): style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:left;font-weight:bold"
- Numeric column headers (th for scores/percentiles/classification): add text-align:center
- Data cells (td): style="padding:3px 10px;border:0.5pt solid #999"
- Numeric data cells: style="padding:3px 10px;border:0.5pt solid #999;text-align:center"
- Even rows: add background:#fafaff
- Odd rows: add background:#fff
- Index/Composite rows: add style="font-weight:bold;background:#f0f0fa"

TABLES TO BUILD — tables in this exact order:

Table 1. Cognitive Subtest Score Summary (test-specific: WISC-V, WAIS-IV, or WPPSI-IV)
Columns: Subtest | Scaled Score | Percentile Rank | Classification

Table 2. Cognitive Index Score Summary (test-specific: WISC-V, WAIS-IV, or WPPSI-IV)
Columns: Index | Standard Score | Percentile Rank | Classification

Table 3. WIAT-III Subtest Score Summary
Columns: Subtest | Standard Score | Percentile Rank | Classification
Rows (exactly these 12 in this order):
  Listening Comprehension
  Receptive Vocabulary
  Oral Discourse Comprehension
  Word Reading
  Pseudoword Decoding
  Reading Comprehension
  Oral Reading Fluency
  Spelling
  Sentence Composition
  Essay Composition
  Numerical Operations
  Math Problem Solving

Table 4. WIAT-III Composite Score Summary
Columns: Composite | Standard Score | Percentile Rank | Classification
Rows:
  Oral Language Composite
  Total Reading
  Basic Reading
  Reading Comprehension & Fluency
  Written Expression
  Mathematics
  Total Achievement

Table 5. WRAML-3 Subtest Score Summary (only if WRAML data present)
Columns: Subtest | Scaled Score | Percentile Rank | Classification

Table 6. WRAML-3 Index Score Summary (only if WRAML data present)
Columns: Index | Standard Score | Percentile Rank | Classification

FINAL RULE: Output ONLY the HTML tables above. No other tables. No explanatory text. Replace — placeholders ONLY when a matching value is explicitly found in the provided document excerpts.`,
};

const QUICK_WORDING = {
  referral: [
    { label: "Parent Referral (Default)", text: "[firstName] was referred for a psychoeducational assessment by [possessive] parents to better understand [possessive] current cognitive, academic, and emotional functioning and to assist with educational planning and support." },
    { label: "Self-Referral (18+)", text: "[firstName] requested a psychoeducational assessment to better understand [possessive] current cognitive, academic, and emotional functioning and to inform educational planning and support at the postsecondary level." },
    { label: "Reassessment", text: "The current assessment was requested to review [firstName]'s present functioning and to inform ongoing educational planning and support." },
  ],
  background: [
    { label: "Template Body", text: "[firstName] lives at home with {{family members}}. {{languages}} are spoken at home.\n\nParents reported that [firstName] was born in {{X was born in}} after an uncomplicated pregnancy and delivery. They stated that {{Developmental milestones}} {{Vision and hearing}}.{{Other info regarding development}}\n\n{{Information obtained during the interview}}" },
  ],
  observations: [
    { label: "Standard Opening", text: "Testing was conducted at the psychological assessment center in a quiet room with none or minimal distractions. Assessment stimuli were displayed on an iPad or computer monitor located to the right of [firstName], as per standardized procedures." },
    { label: "Validity Statement", text: "Considering [firstName]'s good efforts, attention and motivation, it is believed that the results of the assessment constitute a valid estimate of [firstName]'s present abilities and functioning." },
  ],
  doc_review: [
    { label: "Review Intro", text: "A review of the following documents was conducted as part of this assessment." },
    { label: "No Previous Assessments", text: "No previous psychoeducational or psychological assessments were reported or provided for review." },
    { label: "Report Cards Reviewed", text: "Report cards from [firstName]'s school were reviewed as part of this assessment." },
  ],
  summary: [
    { label: "LD Identification", text: "The school may wish to present [firstName] at an Identification, Placement, and Review Committee (IPRC) meeting for the purpose of identifying [object] as an exceptional student under the Learning Disability category." },
    { label: "Behaviour Identification", text: "The school may wish to present [firstName] at an Identification, Placement, and Review Committee (IPRC) meeting for the purpose of identifying [object] as an exceptional student under the Behaviour category due to ongoing difficulties that are impacting [possessive] functioning at school." },
    { label: "Gifted Identification", text: "The school may wish to present [firstName] at an Identification, Placement, and Review Committee (IPRC) meeting for the purpose of identifying [object] as an exceptional student under the Intellectual-Gifted category." },
  ],
  recommendations: [
    { label: "IEP", text: "[possessive] Individual Education Plan (IEP) should be developed based on the results from this assessment." },
    { label: "SEA Claim", text: "The nature of [firstName]'s learning difficulties suggests that [pronoun] could benefit from the regular use of assistive technology software for all language based and math activities. Preparation of a Special Equipment Amount (SEA claim) is strongly advised." },
    { label: "OT Referral", text: "An Occupational Therapy assessment is recommended to assist with fine motor skills and pencil grip." },
    { label: "SLP Referral", text: "Speech and Language Pathologist assessment is recommended." },
    { label: "Physician Consult", text: "[possessive] attentional difficulties and symptoms should be further discussed with a physician." },
    { label: "Closing", text: "It was a pleasure to have had the opportunity to work with [firstName]. I trust that the information contained in this report, as well as the recommendations provided above will aid in providing [object] with the most appropriate support." },
  ],
};

// BEHAVIOUR OBSERVATIONS MENU CONFIG (all groups are multi-select)
const BEH_OBS_STANDARD_OPENING = "Testing was conducted at the psychological assessment center in a quiet room with minimal to no distractions. Assessment stimuli were presented on an iPad or computer monitor positioned to the right of [firstName], in accordance with standardized procedures.";

const COG_STANDARD_OPENING = "The actual test scores contained within this report are attached as an appendix. Please note all testing was completed. A summary of the trends that emerged is included in the sections that follow. From each pattern of scores, real world or functional implications are considered.";

const BEH_OBS_GROUPS = {
  strengths: {
    title: "Strengths & Engagement",
    options: [
      { key: "COOP_MOTIVATED", label: "Cooperative and motivated" },
      { key: "POLITE_KIND", label: "Polite, kind, and hardworking" },
      { key: "CURIOUS", label: "Curious and engaged" },
      { key: "COMFORTABLE", label: "Comfortable with testing" },
      { key: "HEALTHY_ALERT", label: "Physically healthy, alert, and oriented" },
      { key: "NO_DIFF_INSTRUCTIONS", label: "No difficulty understanding task instructions" },
      { key: "BEST_EFFORT", label: "Put forth best effort on all tasks" },
      { key: "ASKED_CLARIFY", label: "Asked questions for clarification" },
      { key: "PERSISTENT", label: "Remained persistent despite challenges" },
    ],
  },
  attention: {
    title: "Attention & Behaviour",
    options: [
      { key: "ATTENTION_SUSTAINED", label: "Sustained attention throughout" },
      { key: "MOTOR_NORMAL", label: "Motor activity within normal limits" },
      { key: "NO_IMPULSIVE", label: "No signs of impulsive behaviour" },
      { key: "EYE_CONTACT_CONSISTENT", label: "Consistent eye contact" },
      { key: "JOINT_ATTENTION", label: "Demonstrated joint attention" },
      { key: "NEED_PROMPTS", label: "Needed prompts and redirection" },
      { key: "LOSE_FOCUS", label: "Lost focus at times" },
      { key: "REPEAT_INSTRUCTIONS", label: "Needed repetition of instructions" },
      { key: "FREQUENT_BREAKS", label: "Requested frequent breaks" },
      { key: "CHALLENGE_SLOWED", label: "Work slowed when tasks felt challenging" },
      { key: "MOOD_VARIED", label: "Mood varied across tasks" },
      { key: "LOW_FRUSTRATION", label: "Low frustration tolerance for difficult tasks" },
      { key: "NEGATIVE_SELF_TALK", label: "Verbalized difficulty or engaged in negative self-talk" },
    ],
  },
  motor: {
    title: "Motor & Writing",
    options: [
      { key: "RIGHT_HAND", label: "Right-handed dominance" },
      { key: "LEFT_HAND", label: "Left-handed dominance" },
      { key: "TRIPOD_GRIP", label: "Tripod pencil grip" },
      { key: "AWKWARD_GRIP", label: "Pencil grip awkward" },
      { key: "LEGIBLE", label: "Legible handwriting" },
      { key: "MESSY_WRITING", label: "Writing messy and hard to read" },
    ],
  },
  validity: {
    title: "Validity Conclusion",
    options: [
      { key: "VALID_ESTIMATE", label: "Valid estimate" },
      { key: "MAY_UNDERESTIMATE", label: "May underestimate abilities" },
      { key: "CAUTION", label: "Interpret with caution" },
      { key: "CAUTION_YOUNG_AGE", label: "Interpret with caution due to young age" },
    ],
  },
  validityModifiers: {
    title: "Validity Modifiers",
    options: [
      { key: "MOD_ATTENTION", label: "Variability in attention" },
      { key: "MOD_ENGAGEMENT", label: "Reduced engagement" },
      { key: "MOD_FATIGUE", label: "Fatigue" },
      { key: "MOD_INSTRUCTIONS", label: "Difficulty understanding instructions" },
    ],
  },
};

const BEH_OBS_DEFAULTS = {
  strengths: [],
  attention: [],
  motor: [],
  validity: [],
  validityModifiers: [],
};

/** Build the prompt context block from behObsMenu state */
function buildBehObsPromptBlock(menu) {
  if (!menu) return "";
  const labels = (groupKey, keys) => {
    if (!keys || keys.length === 0) return "None";
    return keys
      .map((k) => BEH_OBS_GROUPS[groupKey]?.options.find((o) => o.key === k)?.label || k)
      .join(", ");
  };

  const lines = [
    "=== SELECTED BEHAVIOUR OBSERVATION INPUTS ===",
    `Strengths & engagement: ${labels("strengths", menu.strengths)}`,
    `Attention & behaviour: ${labels("attention", menu.attention)}`,
    `Motor & writing: ${labels("motor", menu.motor)}`,
    `Validity conclusion: ${labels("validity", menu.validity)}`,
    `Validity modifiers: ${labels("validityModifiers", menu.validityModifiers)}`,
  ];
  return lines.join("\n");
}

/** Build the specific AI writing rules for the behaviour observations section */
const BEH_OBS_AI_RULES = `AI rules: Use ONLY selected observation items. Compose into professional paragraphs. Apply [firstName] and pronouns. Do not add unselected observations. Do not diagnose. Describe observable behaviour only. Maintain neutral tone. Use cautious language.`

const BEH_OBS_EXAMPLE = `Testing was conducted at the psychological assessment center in a quiet room with minimal to no distractions. Assessment stimuli were presented on an iPad or computer monitor positioned to the right of [firstName], in accordance with standardized procedures.

During testing, [firstName] presented as polite, kind, and hardworking, and [pronoun] appeared physically healthy, alert, and oriented. Overall, [firstName] had no difficulty understanding task instructions. [possessive] level of motor activity remained within normal limits for [possessive] age, with no signs of impulsive behaviour observed. Eye contact was consistent, and [pronoun] demonstrated appropriate joint attention.

[firstName] showed right-handed dominance and used a tripod pencil grip, and [possessive] penmanship was legible. [firstName] put forth [possessive] best effort on all tasks presented to [object] and, when unsure, asked questions for clarification.

[firstName]'s mood varied across tasks; [pronoun] appeared happy and cheerful during preferred activities but demonstrated low frustration tolerance for tasks [pronoun] perceived as difficult. [firstName] frequently verbalized that tasks felt difficult for [object] and engaged in negative self-talk; however, [pronoun] remained persistent, did not become discouraged, and continued to put forth strong effort, stating, "I tried my best, but it is difficult."

Given [firstName]'s good effort, attention, and motivation, the results of the assessment are considered to provide a valid estimate of [possessive] current abilities and level of functioning.`;

// DIAGNOSTIC FORMULATION — MODIFIERS
const FORMULATION_MODIFIERS = [
  { id: "LD", label: "Learning Disability" },
  { id: "GIFTED", label: "Gifted Identification" },
  { id: "MID_DD", label: "Mild Intellectual Disability / Developmental Disability" },
  { id: "ADHD", label: "ADHD" },
  { id: "AUTISM", label: "Autism Spectrum" },
  { id: "NONE", label: "No Diagnosis" },
];

/** Sections whose content is fed to the formulation prompt */
const FORMULATION_SOURCE_SECTIONS = [
  "referral", "background", "doc_review", "observations", "cognitive", "memory",
  "visual_motor", "social_emotional", "adaptive", "academic",
];

function buildFormulationContext(secs, meta) {
  const parts = [];
  for (const sid of FORMULATION_SOURCE_SECTIONS) {
    const content = secs[sid]?.content?.trim();
    if (content) {
      const label = TABS.find((t) => t.id === sid)?.label || sid;
      parts.push(`=== ${label.toUpperCase()} ===\n${content}`);
    }
  }
  if (meta.ageAtTesting) parts.push(`\n=== STUDENT AGE ===\n${meta.ageAtTesting}`);
  if (meta.grade) parts.push(`\n=== STUDENT GRADE ===\n${meta.grade}`);
  return parts.join("\n\n");
}

// RECOMMENDATIONS — BLOCKS & EDUCATIONAL LEVEL
const REC_BLOCKS = [
  { id: "LD", label: "IPRC: Learning Disability", group: "iprc" },
  { id: "MID", label: "IPRC: MID / DD", group: "iprc" },
  { id: "GIFTED", label: "IPRC: Gifted", group: "iprc" },
  { id: "AUTISM", label: "IPRC: Autism", group: "iprc" },
  { id: "BEHAVIOUR", label: "IPRC: Behaviour", group: "iprc" },
  { id: "IEP", label: "IEP / Accommodations", group: "core" },
  { id: "SEA", label: "SEA / Assistive Tech", group: "core" },
  { id: "REFERRALS", label: "Referrals", group: "core" },
  { id: "SE", label: "Socio-Emotional", group: "core" },
];

const REC_EDU_LEVELS = [
  { id: "ELEMENTARY", label: "Elementary" },
  { id: "HIGH_SCHOOL", label: "High School" },
  { id: "COLLEGE_UNI", label: "College / University" },
];

// APPENDIX — BLOCKS
const APPENDIX_BLOCKS = [
  { id: "WISC", label: "WISC-V Recommendations" },
  { id: "READING", label: "Reading" },
  { id: "WRITING", label: "Writing" },
  { id: "MATH", label: "Mathematics" },
  { id: "ATTENTION_EF", label: "Attention & Executive Functioning" },
  { id: "MEMORY", label: "Memory Support" },
  { id: "PROCESSING_SPEED", label: "Processing Speed" },
  { id: "LANGUAGE", label: "Language & Communication" },
  { id: "VMI_MOTOR", label: "Visual-Motor & Fine Motor" },
  { id: "SE_SUPPORT", label: "Socio-Emotional" },
  { id: "ADAPTIVE", label: "Adaptive Functioning" },
  { id: "GIFTED", label: "Giftedness" },
  { id: "LD_SUPPORT", label: "Learning Disability Support" },
  { id: "POST_SECONDARY", label: "Post-Secondary Support" },
];

// APPENDIX TABLES — BLOCKS
// Only WISC-V and WIAT-III have corresponding appendix score tables
const TOOLS_WITH_TABLES = new Set([
  "wisc-v","wais-iv","wppsi-iv","wiat-iii","wiat-4",
]);
const TABLE_BLOCKS = [
  { id: "wisc-v",        label: "WISC-V",              cat: "Cognitive" },
  { id: "wais-iv",       label: "WAIS-IV",             cat: "Cognitive" },
  { id: "wppsi-iv",      label: "WPPSI-IV",            cat: "Cognitive" },
  { id: "wiat-iii",      label: "WIAT-III",            cat: "Academic" },
  { id: "wiat-4",        label: "WIAT-4",              cat: "Academic" },
];

// BEHAVIOUR OBSERVATIONS — SENTENCE TEMPLATES (exact wording per item)
const BEH_OBS_TEMPLATES = {
  // Strengths (para 1) — first selected item starts with "During testing,"
  COOP_MOTIVATED: "[firstName] was cooperative and motivated throughout the assessment sessions.",
  POLITE_KIND: "[pronoun] presented as polite, kind, and hardworking,",
  CURIOUS: "[pronoun] was curious and engaged with each task and openly shared [possessive] thoughts about what [pronoun] was doing.",
  COMFORTABLE: "[pronoun] appeared comfortable and relaxed during the testing process.",
  HEALTHY_ALERT: "[pronoun] appeared physically healthy, alert, and oriented.",
  NO_DIFF_INSTRUCTIONS: "Overall, [pronoun] had no difficulty understanding or adhering to task instructions.",
  BEST_EFFORT: "[pronoun] consistently put forth [possessive] best effort on all tasks presented.",
  ASKED_CLARIFY: "When unsure, [pronoun] appropriately asked questions for clarification.",
  PERSISTENT: "[pronoun] remained persistent, did not become discouraged, and continued to put forth strong effort.",

  // Attention (para 2)
  ATTENTION_SUSTAINED: "In terms of attention and concentration, [firstName] was able to maintain focus for the duration of each subtest and task presented.",
  MOTOR_NORMAL: "[possessive] level of motor activity remained within normal limits for [possessive] age,",
  NO_IMPULSIVE: "with no observed signs of impulsivity or inattention.",
  EYE_CONTACT_CONSISTENT: "[possessive] eye contact was consistent.",
  JOINT_ATTENTION: "[pronoun] demonstrated appropriate joint attention.",
  NEED_PROMPTS: "Although generally cooperative, [pronoun] required some encouragement to complete less-preferred tasks and benefited from prompts, to which [pronoun] responded well.",
  LOSE_FOCUS: "[pronoun] appeared to lose focus at times and did not always redirect [possessive] attention without support from the assessor.",
  REPEAT_INSTRUCTIONS: "At times, [pronoun] required repetitions of instructions.",
  FREQUENT_BREAKS: "[pronoun] frequently asked when [pronoun] could have a break, and numerous short breaks were provided.",
  CHALLENGE_SLOWED: "[possessive] work pace slowed when tasks became more demanding.",
  MOOD_VARIED: "[firstName]'s mood varied across tasks; [pronoun] appeared happy and cheerful during preferred activities",
  LOW_FRUSTRATION: "but demonstrated low frustration tolerance for tasks [pronoun] perceived as difficult.",
  NEGATIVE_SELF_TALK: '[pronoun] frequently verbalized that tasks felt difficult and engaged in negative self-talk; however, [pronoun] remained persistent, did not become discouraged, and continued to put forth strong effort, stating, "I tried my best, but it is difficult."',

  // Motor (para 3)
  RIGHT_HAND: "[firstName] demonstrated right-handed dominance",
  LEFT_HAND: "[firstName] demonstrated left-handed dominance",
  TRIPOD_GRIP: "and used a tripod pencil grip,",
  AWKWARD_GRIP: "[possessive] pencil grip was awkward.",
  LEGIBLE: "with legible penmanship.",
  MESSY_WRITING: "[possessive] writing was messy and difficult to read.",

  // Validity (para 5)
  VALID_ESTIMATE: "Considering [firstName]'s strong effort, sustained attention, and high level of motivation, the results of this assessment are believed to provide a valid estimate of [possessive] current abilities and functioning.",
  MAY_UNDERESTIMATE: "Overall, the results of the assessment are believed to provide an estimate of [firstName]'s current functioning; however, they may underestimate [possessive] abilities due to MODIFIER_PHRASE observed during testing.",
  CAUTION: "Overall, the results of the assessment should be interpreted with caution due to MODIFIER_PHRASE observed during testing.",
  CAUTION_YOUNG_AGE: "Overall, the results of the assessment provide useful information regarding [firstName]'s functioning; however, they should be interpreted with caution due to developmental factors related to age.",
};

const BEH_OBS_MODIFIER_LABELS = {
  MOD_ATTENTION: "variability in attention",
  MOD_ENGAGEMENT: "reduced engagement",
  MOD_FATIGUE: "fatigue",
  MOD_INSTRUCTIONS: "difficulty understanding instructions",
};

// SOCIO-EMOTIONAL — MODULAR TEST WINDOWS CONSTANTS
const SE_RESPONDENT_TYPES = ["Parent", "Teacher", "Self", "Other"];

const SE_HAS_RESPONDENT = ["BASC-3", "CBRS", "Conners-4", "Vineland-3", "ASRS"];

/** Maps tool IDs from Tests Administered → SE test type + respondent */
const TOOL_TO_SE_MAP = {
  "basc-3-p":      { testType: "BASC-3",     respondentType: "Parent" },
  "basc-3-t":      { testType: "BASC-3",     respondentType: "Teacher" },
  "basc-3-s":      { testType: "BASC-3",     respondentType: "Self" },
  "conners-4-p":   { testType: "Conners-4",  respondentType: "Parent" },
  "conners-4-t":   { testType: "Conners-4",  respondentType: "Teacher" },
  "conners-cbrs-p": { testType: "CBRS",      respondentType: "Parent" },
  "vineland-3":    { testType: "Vineland-3",  respondentType: "Parent" },
  "phq-9":         { testType: "PHQ-9",      respondentType: "Self" },
  "gad-7":         { testType: "GAD-7",      respondentType: "Self" },
  "bai":           { testType: "Other",      respondentType: "Self", otherTestName: "Beck Anxiety Inventory (BAI)" },
  "bdi-2":         { testType: "Other",      respondentType: "Self", otherTestName: "Beck Depression Inventory-II (BDI-2)" },
  "asrs":          { testType: "ASRS",       respondentType: "Parent" },
};

function makeSeTestWindow(testType, respondentType, fromToolId, otherTestName) {
  return {
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "rs_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    testType: testType || "BASC-3",
    respondentType: respondentType || "Parent",
    respondentName: "",
    otherTestName: otherTestName || "",
    fromToolId: fromToolId || null,
  };
}

/** Build a structured prompt block listing which tests and respondents are provided — scores come from PDFs */
function buildSeRatingScalePrompt(ratingScales) {
  if (!ratingScales || ratingScales.length === 0) return "";
  const parts = ["=== RATING SCALE INSTRUMENTS ADMINISTERED ==="];
  parts.push("The following instruments were administered. Extract all scores, classifications, and scale data from the uploaded PDF score reports for each instrument below.");

  for (const rs of ratingScales) {
    const name = rs.testType === "Other" ? (rs.otherTestName?.trim() || "Other instrument") : rs.testType;
    parts.push(`\n--- ${name} ---`);
    parts.push(`Respondent: ${rs.respondentType}${rs.respondentName ? " (" + rs.respondentName + ")" : ""}`);
    parts.push("Extract ALL scale names, scores, percentiles, T-scores, and classification ranges from the uploaded PDF for this instrument.");
    parts.push("Use ONLY data that appears in the PDF. Do not estimate or infer any values.");
  }

  parts.push("\nIMPORTANT: If any test listed above does not have a corresponding uploaded PDF, note that scores were not available and continue with remaining tests.");

  return parts.join("\n");
}

// Defines the order sentences appear and how they group into paragraphs.
// Sentences within a paragraph are joined with spaces; the compose function
// adds "During testing," before the first strengths sentence and cleans up
// punctuation so fragments connect grammatically.
const BEH_OBS_PARAGRAPH_ORDER = [
  { keys: ["COOP_MOTIVATED", "POLITE_KIND", "CURIOUS", "COMFORTABLE", "HEALTHY_ALERT", "NO_DIFF_INSTRUCTIONS"], prefix: "During testing, " },
  { keys: ["ATTENTION_SUSTAINED", "MOTOR_NORMAL", "NO_IMPULSIVE", "EYE_CONTACT_CONSISTENT", "JOINT_ATTENTION"] },
  { keys: ["RIGHT_HAND", "LEFT_HAND", "TRIPOD_GRIP", "AWKWARD_GRIP", "LEGIBLE", "MESSY_WRITING", "BEST_EFFORT", "ASKED_CLARIFY"] },
  { keys: ["MOOD_VARIED", "LOW_FRUSTRATION", "NEGATIVE_SELF_TALK", "NEED_PROMPTS", "LOSE_FOCUS", "REPEAT_INSTRUCTIONS", "FREQUENT_BREAKS", "CHALLENGE_SLOWED", "PERSISTENT"] },
  { keys: ["VALID_ESTIMATE", "MAY_UNDERESTIMATE", "CAUTION", "CAUTION_YOUNG_AGE"] },
];

/** Clean up punctuation: ensure sentence ends with a period, fix orphaned connectors, capitalize all sentence starts. */
function cleanParagraph(text) {
  let t = text.trim();
  // Remove trailing comma if it's the last character
  if (t.endsWith(",")) t = t.slice(0, -1) + ".";
  // Ensure ends with period
  if (t && !/[.!?"]$/.test(t)) t += ".";
  // Strip leading connectors (orphaned "and/but/with" when their predecessor isn't selected)
  t = t.replace(/^(During testing,\s*)?(?:,\s*)?(?:and,?\s+|but\s+|with\s+)/i, (match, prefix) => prefix || "");
  // Fix ", ." or ",."
  t = t.replace(/,\s*\./g, ".");
  // Fix double periods
  t = t.replace(/\.{2,}/g, ".");
  // Fix ",," 
  t = t.replace(/,\s*,/g, ",");
  // Mid-sentence: ". and" → ", and" (connector lost its predecessor)
  t = t.replace(/\.\s+and\s+/g, ", and ");
  t = t.replace(/\.\s+but\s+/g, ", but ");
  t = t.replace(/\.\s+with\s+/g, ", with ");
  // Capitalize first letter of every sentence (after . ! ? and start of string)
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
  return t;
}

/** Compose the full Behaviour Observations text from menu selections (WITHOUT the standard opening) */
function composeBehObsText(menu) {
  if (!menu) return "";
  const allSelected = new Set();
  for (const gk of Object.keys(BEH_OBS_GROUPS)) {
    for (const key of (menu[gk] || [])) allSelected.add(key);
  }
  if (allSelected.size === 0) return "";

  const modKeys = menu.validityModifiers || [];
  const modPhrase = modKeys.length > 0
    ? modKeys.map((k) => BEH_OBS_MODIFIER_LABELS[k] || k).join(", ")
    : "";

  const paragraphs = [];

  for (const para of BEH_OBS_PARAGRAPH_ORDER) {
    const fragments = [];
    for (const key of para.keys) {
      if (!allSelected.has(key)) continue;
      let tmpl = BEH_OBS_TEMPLATES[key];
      if (!tmpl) continue;
      if (tmpl.includes("MODIFIER_PHRASE")) {
        const phrase = modPhrase || (key === "MAY_UNDERESTIMATE" ? "variability in attention and engagement" : "behavioural factors");
        tmpl = tmpl.replace("MODIFIER_PHRASE", phrase);
      }
      if (key === "CAUTION_YOUNG_AGE" && modKeys.length > 0) {
        tmpl += " As well as " + modPhrase + " observed during testing.";
      }
      fragments.push(tmpl);
    }
    if (fragments.length > 0) {
      let joined = (para.prefix || "") + fragments.join(" ");
      paragraphs.push(cleanParagraph(joined));
    }
  }

  return paragraphs.join("\n\n");
}

// PROMPT LIBRARY — persistence key + resolver
const PROMPT_LIB_KEY = "psychoed_custom_prompts";

function resolvePrompt(sid, customPrompts) {
  if (customPrompts && customPrompts[sid]) return customPrompts[sid];
  return SEC_PROMPTS[sid] || "";
}

// PRINT STYLESHEET (injected once)
const PRINT_STYLES = `
html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
}
.print-header {
  display: none;
}
@media print {
  body { background: white !important; margin: 0 !important; overflow: visible !important; }
  html { overflow: visible !important; }
  .no-print, [data-no-print] { display: none !important; }
  .print-only { display: block !important; }
  .print-header {
    display: block;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    font-family: "Times New Roman", Times, serif;
    font-size: 10pt;
    color: #333;
    border-bottom: 1px solid #ccc;
    padding-bottom: 4pt;
    margin-bottom: 8pt;
  }
  .print-report {
    padding: 0 !important;
    margin: 0 !important;
    border: none !important;
    box-shadow: none !important;
    max-width: 100% !important;
    padding-top: 30pt !important;
  }
  @page {
    margin: 0.75in 0.6in;
    size: letter;
    @bottom-center {
      content: "Page " counter(page);
      font-family: "Times New Roman", Times, serif;
      font-size: 9pt;
      color: #777;
    }
  }
  @page :first {
    margin-top: 0.75in;
  }
  @page :first .print-header {
    display: none;
  }
}
`;

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

/** Replace pronoun placeholders in text */
function applyPronouns(text, pronounKey) {
  const pr = PRONOUN_MAP[pronounKey] || PRONOUN_MAP["he/him"];
  return text
    // New neutral placeholders
    .replace(/\[pronoun\]/gi, pr.subject)
    .replace(/\[possessive\]/gi, pr.possessive)
    .replace(/\[object\]/gi, pr.object)
    .replace(/\[reflexive\]/gi, pr.reflexive)
    // Legacy gendered placeholders (templates, AI output)
    .replace(/\[HIS\/HER\]/g, pr.possessive)
    .replace(/\[HE\/SHE\]/g, pr.subject)
    .replace(/\[HIM\/HER\]/g, pr.object)
    .replace(/\[HIMSELF\/HERSELF\]/g, pr.reflexive)
    .replace(/HIS\/HER/g, pr.possessive)
    .replace(/HE\/SHE/g, pr.subject)
    .replace(/HIM\/HER/g, pr.object)
    .replace(/HIMSELF\/HERSELF/g, pr.reflexive);
}

/** Replace [firstName] placeholder — skip if no name provided */
function applyName(text, firstName) {
  if (!firstName) return text; // Keep placeholders intact until name is entered
  return text
    .replace(/\[firstName\]/g, firstName)
    .replace(/\[First Name\]/g, firstName); // also catch previously-replaced fallback
}

/** Apply both name and pronoun placeholders in one step — the single consistent entry point */
function personalize(text, firstName, pronouns) {
  return applyPronouns(applyName(text, firstName), pronouns);
}

/** Capitalize first letter of every sentence (after . ! ? and start of each line/paragraph) */
function capitalizeSentences(text) {
  return text.replace(/(^|[.!?]\s+|\n\n)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

/** Sanitize tone: convert harsh/negative phrasing to supportive professional language */
function sanitizeTone(text) {
  const replacements = [
    [/\bfailed\b/gi, "found challenging"],
    [/\bfailure\b/gi, "area of difficulty"],
    [/\bfailures\b/gi, "areas of difficulty"],
    [/\bpoor performance\b/gi, "area of emerging development"],
    [/\bpoor\b/gi, "limited"],
    [/\bdeficit(s)?\b/gi, "area of need"],
    [/\bdeficient\b/gi, "below expected levels"],
    [/\bimpaired\b/gi, "presenting with difficulty"],
    [/\bimpairment(s)?\b/gi, "area(s) of difficulty"],
    [/\binability\b/gi, "difficulty with"],
    [/\bweakness(es)?\b/gi, "area(s) of need"],
    [/\bsuffered\b/gi, "experienced"],
    [/\bstruggled greatly\b/gi, "experienced significant difficulty"],
    [/\bstruggled\b/gi, "experienced difficulty"],
    [/\bstruggles\b/gi, "experiences difficulty"],
    [/\bcannot\b/gi, "has difficulty with"],
    [/\baggression\b/gi, "reactive behaviours"],
    [/\baggressive\b/gi, "exhibiting externalizing behaviours"],
    [/\bviolence\b/gi, "behavioural difficulties"],
    [/\bviolent\b/gi, "exhibiting behavioural difficulties"],
    [/\blazy\b/gi, "may benefit from additional motivation supports"],
    [/\bstubborn\b/gi, "persistent"],
    [/\bdisobedient\b/gi, "having difficulty following expectations"],
  ];
  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Strip markdown formatting artifacts from AI-generated content.
 *  Removes: # ## ### headers, duplicate section titles, horizontal rules, bold markers */
function cleanAIOutput(text, sectionId) {
  if (!text) return text;
  let t = text;
  // Remove markdown headers (# ## ### #### etc.) — keep the text, drop the markers
  t = t.replace(/^#{1,6}\s+/gm, "");
  // Remove bold markers ** and __
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  // Remove italic markers * and _ (single)
  t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  // Remove horizontal rules
  t = t.replace(/^[-*_]{3,}\s*$/gm, "");
  // Remove duplicate section title lines that match known headings
  const sectionTitles = [
    "A NOTE ON THE INTERPRETATION OF ASSESSMENT RESULTS",
    "A Note on the Interpretation of Assessment Results",
    "COGNITIVE/INTELLECTUAL FUNCTIONING", "COGNITIVE\\/INTELLECTUAL FUNCTIONING",
    "Cognitive/Intellectual Functioning", "Cognitive\\/Intellectual Functioning",
    "INTERPRETATION OF WISC-V RESULTS", "INTERPRETATION OF WISC-V CDN RESULTS",
    "INTERPRETATION OF WPPSI-IV RESULTS", "INTERPRETATION OF WAIS-IV RESULTS",
    "RESULTS AND INTERPRETATION", "MEMORY AND LEARNING", "Memory and Learning",
    "VISUAL-MOTOR INTEGRATION SKILLS", "Visual-motor integration skills",
    "VISUAL MOTOR INTEGRATION", "Visual Motor Integration",
    "SOCIAL-EMOTIONAL FUNCTIONING", "Social-Emotional Functioning",
    "DEVELOPMENT AND ADAPTIVE FUNCTIONING", "Development and Adaptive Functioning",
    "ACADEMIC TESTING", "Academic Testing",
    "SUMMARY AND FORMULATION", "Summary and Formulation",
    "SUMMARY, FORMULATION AND DIAGNOSIS", "Summary, Formulation and Diagnosis",
    "DIAGNOSTIC FORMULATION AND RATIONALE", "Diagnostic Formulation and Rationale",
    "DIAGNOSTIC FORMULATION", "Diagnostic Formulation",
    "STRENGTHS AND NEEDS", "Strengths and Needs",
    "RECOMMENDATIONS", "Recommendations",
    "BACKGROUND INFORMATION", "Background Information",
    "REVIEW OF DOCUMENTS", "Review of Documents",
    "BEHAVIOR OBSERVATIONS", "Behavior Observations",
    "REASONS FOR REFERRAL", "Reasons for Referral",
    "BEHAVIOUR OBSERVATIONS", "Behaviour Observations",
  ];
  for (const title of sectionTitles) {
    // Remove lines that are just the section title (with optional colon/dash)
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^\\s*${escaped}[:\\-]?\\s*$`, "gmi"), "");
  }
  // Clean up multiple blank lines left behind
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}
async function extractTextFromFile(file, onProgress, base64DataUrl) {
  const textTypes = [
    "text/plain", "text/csv", "text/html", "text/markdown",
    "application/json", "text/tab-separated-values",
  ];
  const isText = textTypes.some(t => file.type?.startsWith(t)) ||
    /\.(txt|csv|tsv|md|json)$/i.test(file.name);

    if (isText) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result || "");
      reader.onerror = () => resolve("");
      reader.readAsText(file);
    });
  }

    if (file.type === "application/pdf") {
    if (base64DataUrl) {
      const extracted = await extractPDFTextLocal(base64DataUrl, file.name, onProgress);
      if (extracted && extracted.length > 50) return extracted;
    }
    onProgress?.("PDF uploaded — paste key scores into Assessment Notes for AI to use.");
    return "[PDF uploaded. Paste the relevant scores and text content into the Assessment Notes field for this section. The AI will use your pasted notes plus the uploaded file to generate the section.]";
  }

    if (file.type?.includes("word") || /\.docx$/i.test(file.name)) {
    if (base64DataUrl) {
      try {
        const parsed = await parseDocxStructured(base64DataUrl, onProgress);
        if (parsed.fullText && parsed.fullText.length > 50) return parsed.fullText;
      } catch (e) {
        // DOCX parsing failed
      }
    }
    return "[Word document uploaded — paste relevant content into Assessment Notes for AI to use.]";
  }

    if (file.type?.startsWith("image/")) {
    if (base64DataUrl) {
      try {
        const parsed = await parseImageOCR(base64DataUrl, onProgress);
        if (parsed.fullText && parsed.fullText.length > 20) return parsed.fullText;
      } catch (e) {
        // OCR failed
      }
    }
    onProgress?.("Image uploaded — paste key scores into Assessment Notes for AI to use.");
    return "[Image uploaded. Paste the relevant scores and text content into the Assessment Notes field for this section. The AI will use your pasted notes plus the uploaded file to generate the section.]";
  }

  return "";
}

// BELL CURVE (standalone component — path pre-computed at module level)
const _BC_W = 600, _BC_H = 280, _BC_ML = 40, _BC_MT = 24, _BC_MW = _BC_W - 80, _BC_MH = 180;
const _bcSx = (v) => _BC_ML + ((v - 40) / 120) * _BC_MW;
const _bcNormal = (x) => (1 / (15 * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - 100) / 15) ** 2);
const _bcSy = (v) => _BC_MT + _BC_MH - (v / 0.028) * _BC_MH;
let _bcPath = "";
let _bcFill = "";
for (let _i = 40; _i <= 160; _i += 0.5) {
  const px = _bcSx(_i).toFixed(1);
  const py = _bcSy(_bcNormal(_i)).toFixed(1);
  _bcPath += (_i === 40 ? "M" : "L") + px + "," + py;
  _bcFill += (_i === 40 ? "M" + px + "," + (_BC_MT + _BC_MH) + "L" : "L") + px + "," + py;
}
_bcFill += "L" + _bcSx(160).toFixed(1) + "," + (_BC_MT + _BC_MH) + "Z";
const BELL_CURVE_PATH = _bcPath;
const BELL_FILL_PATH = _bcFill;
const BELL_BANDS = [
  { s: 40, e: 70, c: "#fca5a5", l: "Very Low", sub: "<70" },
  { s: 70, e: 80, c: "#fdba74", l: "Low", sub: "70–79" },
  { s: 80, e: 90, c: "#fde68a", l: "Low Average", sub: "80–89" },
  { s: 90, e: 110, c: "#86efac", l: "Average", sub: "90–109" },
  { s: 110, e: 120, c: "#67e8f9", l: "High Average", sub: "110–119" },
  { s: 120, e: 130, c: "#93c5fd", l: "Superior", sub: "120–129" },
  { s: 130, e: 160, c: "#a5b4fc", l: "Very Superior", sub: "130+" },
];
const BELL_SD_LABELS = [
  { x: 55, l: "-3SD" }, { x: 70, l: "-2SD" }, { x: 85, l: "-1SD" }, { x: 100, l: "Mean" },
  { x: 115, l: "+1SD" }, { x: 130, l: "+2SD" }, { x: 145, l: "+3SD" },
];
const BELL_PERCENTILES = [
  [55, "0.1"], [70, "2"], [85, "16"], [100, "50"], [115, "84"], [130, "98"], [145, "99.9"],
];
const BELL_SCORE_TICKS = [55, 70, 85, 100, 115, 130, 145];

const BellCurve = memo(function BellCurve() {
  const axisY = _BC_MT + _BC_MH;
  const labelY = axisY + 15;
  const classY = axisY + 30;
  const classSubY = axisY + 42;
  const pctY = axisY + 56;
  return (
    <svg viewBox={`0 0 ${_BC_W} ${_BC_H}`} style={{ width: "100%", maxWidth: 680, display: "block", margin: "0 auto" }}>
      <defs>
        <linearGradient id="bellGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4f46e5" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.03" />
        </linearGradient>
      </defs>

      {/* Classification bands */}
      {BELL_BANDS.map((b, i) => (
        <rect key={i} x={_bcSx(b.s)} y={_BC_MT} width={_bcSx(b.e) - _bcSx(b.s)} height={_BC_MH} fill={b.c} opacity={0.22} />
      ))}

      {/* Filled area under curve */}
      <path d={BELL_FILL_PATH} fill="url(#bellGrad)" />

      {/* Curve line */}
      <path d={BELL_CURVE_PATH} fill="none" stroke="#312e81" strokeWidth="2.5" strokeLinejoin="round" />

      {/* Baseline */}
      <line x1={_BC_ML} y1={axisY} x2={_BC_ML + _BC_MW} y2={axisY} stroke="#6b7280" strokeWidth="1" />

      {/* Tick marks and standard score labels */}
      {BELL_SCORE_TICKS.map((t) => (
        <g key={t}>
          <line x1={_bcSx(t)} y1={axisY} x2={_bcSx(t)} y2={axisY + 5} stroke="#6b7280" strokeWidth="1" />
          <text x={_bcSx(t)} y={labelY} textAnchor="middle" fontSize="9" fill="#374151" fontWeight="600" fontFamily="'Times New Roman', serif">{t}</text>
        </g>
      ))}

      {/* SD labels at the top */}
      {BELL_SD_LABELS.map((s) => (
        <text key={s.x} x={_bcSx(s.x)} y={_BC_MT - 6} textAnchor="middle" fontSize="8" fill="#6b7280" fontFamily="'Times New Roman', serif" fontWeight="500">{s.l}</text>
      ))}

      {/* Vertical dashed guide lines at each SD */}
      {[70, 85, 100, 115, 130].map((v) => (
        <line key={v} x1={_bcSx(v)} y1={_BC_MT} x2={_bcSx(v)} y2={axisY} stroke="#9ca3af" strokeWidth="0.5" strokeDasharray="3,3" />
      ))}

      {/* Classification labels below axis */}
      {BELL_BANDS.map((b, i) => {
        const cx = _bcSx(b.s + (b.e - b.s) / 2);
        return (
          <g key={i}>
            <text x={cx} y={classY} textAnchor="middle" fontSize="7.5" fill="#374151" fontWeight="700" fontFamily="'Times New Roman', serif">{b.l}</text>
            <text x={cx} y={classSubY} textAnchor="middle" fontSize="6.5" fill="#9ca3af" fontFamily="'Times New Roman', serif">{b.sub}</text>
          </g>
        );
      })}

      {/* Percentile rank row */}
      <text x={_BC_ML - 2} y={pctY} fontSize="7" fill="#6b7280" fontFamily="'Times New Roman', serif" fontWeight="600">Percentile:</text>
      {BELL_PERCENTILES.map(([x, l]) => (
        <text key={`pct-${x}`} x={_bcSx(Number(x))} y={pctY} textAnchor="middle" fontSize="7.5" fill="#4b5563" fontFamily="'Times New Roman', serif">{l}</text>
      ))}

      {/* Axis label */}
      <text x={_BC_ML + _BC_MW / 2} y={_BC_H - 2} textAnchor="middle" fontSize="9" fill="#6b7280" fontFamily="'Times New Roman', serif" fontWeight="600">Standard Score</text>
    </svg>
  );
});

// GLOBAL REPORT RULES (layer 1 of the two layer prompt system)
const GLOBAL_REPORT_RULES = `You are an experienced school psychologist in Ontario, Canada. Write in professional psychoeducational report style. Use Canadian English spelling (behaviour, colour, analyse, centre). Use person-first or neutral language. Never use "aggressive", "violent", or deficit-focused labels. Always use "difficulty with behavioural regulation" instead. Reference scores using: Standard Score, Percentile Rank, Classification range. Use classification labels: Very Low (<70), Low (70-79), Low Average (80-89), Average (90-109), High Average (110-119), Superior (120-129), Very Superior (130+). For percentiles: Very Low (<2nd), Low (2nd-8th), Low Average (9th-24th), Average (25th-74th), High Average (75th-90th), Superior (91st-97th), Very Superior (>98th). Never invent scores. Use only provided data. CRITICAL FORMATTING: Output plain text paragraphs only. Do NOT use markdown formatting — no # headers, no ## headers, no ### headers, no ** bold **, no __ underline __, no --- horizontal rules. Do NOT repeat the section title at the start of your output. Just write the content paragraphs directly.`

// GLOBAL TONE RULES (applied to every AI generation)
const GLOBAL_TONE_RULES = `You write sections of a psychoeducational assessment report as an experienced school psychologist. Write in clear paragraphs with smooth transitions. Use direct, active sentences. Use respectful, strengths-focused language. Describe needs in a balanced way. Avoid labels and absolutes. Use careful phrasing such as "at times", "often", "may", "appears". Keep the tone calm and professional. Use correct punctuation. Use only provided information. Do not guess or add facts not provided. Write so parents, teachers, and the student feel respected. Connect difficulties to practical impact and strengths. Use [firstName] and third person pronouns. Do not use bold formatting. Describe only observable behaviour, not clinical interpretations. Do not use diagnostic terms unless quoting a documented prior diagnosis.`

const DOC_EXCERPT_MAX = 12000;

function formatDocExcerpts(docs) {
  if (!docs || docs.length === 0) return "No documents selected for this section.";
  const parts = docs.map((d, i) => {
    const header = `[Document ${i + 1}: "${d.name}" | Categories: ${d.categories.join(", ")}]`;
    if (!d.extractedText || d.extractedText.length === 0) {
      return header + "\n(No extracted text available. Refer to Assessment Notes for data from this document.)";
    }
    const trimmed = d.extractedText.length > DOC_EXCERPT_MAX
      ? d.extractedText.slice(0, DOC_EXCERPT_MAX) + "\n... (excerpt trimmed)"
      : d.extractedText;
    return header + "\n" + trimmed;
  });
  return parts.join("\n\n");
}

// COGNITIVE SECTION: Direct text extraction from WISC/WPPSI/WAIS docs
// ═══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC EXTRACTION ENGINE
// No AI. No inference. Parse → Anchor → Extract → Structure.
// ═══════════════════════════════════════════════════════════════════════════

// ── SCORE VALIDATION BOUNDS ──
const SCALED_SCORE_MIN = 1;
const SCALED_SCORE_MAX = 19;
const STANDARD_SCORE_MIN = 40;
const STANDARD_SCORE_MAX = 160;
const PERCENTILE_MAX = 100;

function qualitativeLabel(ss) {
  if (ss >= 130) return "Extremely High";
  if (ss >= 120) return "Very High";
  if (ss >= 110) return "High Average";
  if (ss >= 90) return "Average";
  if (ss >= 80) return "Low Average";
  if (ss >= 70) return "Low";
  return "Extremely Low";
}

// ── AGE PARSING HELPER ──
function ageFromAgeAtTesting(ageAtTesting) {
  if (!ageAtTesting) return null;
  const s = String(ageAtTesting);
  const yMatch = s.match(/(\d{1,2})\s*years?/i);
  const mMatch = s.match(/(\d{1,2})\s*months?/i);
  const years = yMatch ? parseInt(yMatch[1], 10) : 0;
  const months = mMatch ? parseInt(mMatch[1], 10) : 0;
  if (!Number.isFinite(years) || !Number.isFinite(months)) return null;
  const totalMonths = years * 12 + months;
  return { years, months, totalMonths };
}
function scaledQualitative(ss) {
  if (ss >= 16) return "Very High";
  if (ss >= 13) return "High Average";
  if (ss >= 8) return "Average";
  if (ss >= 6) return "Low Average";
  if (ss >= 4) return "Low";
  return "Very Low";
}

// ── KNOWN NAMES ──
const DET_SUBTEST_NAMES = [
  "Similarities", "Vocabulary", "Information", "Comprehension",
  "Block Design", "Visual Puzzles", "Matrix Reasoning", "Figure Weights",
  "Arithmetic", "Digit Span", "Picture Span", "Letter-Number Sequencing",
  "Coding", "Symbol Search", "Cancellation",
  "Naming Speed Literacy", "Naming Speed Quantity",
  "Immediate Symbol Translation", "Delayed Symbol Translation", "Recognition Symbol Translation",
  "Receptive Vocabulary", "Picture Naming", "Bug Search", "Animal Coding",
  "Object Assembly", "Picture Memory", "Zoo Locations",
  "Picture Completion", "Weight Reasoning",
  "Digit Span Forward", "Digit Span Backward", "Digit Span Sequencing",
  "Block Design No Time Bonus",
];

const DET_INDEX_DEFS = [
  { abbrev: "FSIQ", full: "Full Scale IQ" },
  { abbrev: "VCI", full: "Verbal Comprehension Index" },
  { abbrev: "PRI", full: "Perceptual Reasoning Index" },
  { abbrev: "VSI", full: "Visual Spatial Index" },
  { abbrev: "FRI", full: "Fluid Reasoning Index" },
  { abbrev: "WMI", full: "Working Memory Index" },
  { abbrev: "PSI", full: "Processing Speed Index" },
  { abbrev: "GAI", full: "General Ability Index" },
  { abbrev: "CPI", full: "Cognitive Proficiency Index" },
  { abbrev: "NVI", full: "Nonverbal Index" },
  { abbrev: "QRI", full: "Quantitative Reasoning Index" },
  { abbrev: "AWMI", full: "Auditory Working Memory Index" },
  { abbrev: "VECI", full: "Verbal (Expanded Crystallized) Index" },
  { abbrev: "EFI", full: "Expanded Fluid Index" },
  { abbrev: "NSI", full: "Naming Speed Index" },
  { abbrev: "STI", full: "Symbol Translation Index" },
  { abbrev: "SRI", full: "Storage and Retrieval Index" },
];

const DET_SUBTEST_ABBREVS = {
  "SI": "Similarities", "VC": "Vocabulary", "IN": "Information", "CO": "Comprehension",
  "BD": "Block Design", "VP": "Visual Puzzles", "MR": "Matrix Reasoning", "FW": "Figure Weights",
  "AR": "Arithmetic", "DS": "Digit Span", "PS": "Picture Span", "LN": "Letter-Number Sequencing",
  "CD": "Coding", "SS": "Symbol Search", "CA": "Cancellation",
  "DSf": "Digit Span Forward", "DSb": "Digit Span Backward", "DSs": "Digit Span Sequencing",
};

// ── SECTION ANCHORS ──
const DET_ANCHORS = {
  cognitive_start: [
    /ABOUT WISC-V\s*(?:CDN\s*)?SCORES/i,
    /ABOUT WPPSI-IV\s*(?:CDN\s*)?SCORES/i,
    /ABOUT WAIS-IV\s*(?:CDN\s*)?SCORES/i,
    // Multi-line tolerant: "was administered" near "Wechsler/WISC" (PDF may split across lines)
    /\bwas\s+administered\b[\s\S]{0,120}(?:Wechsler|WISC|WPPSI|WAIS)/i,
    /\bThe\s+Wechsler\s+Intelligence\s+Scale/i,
    /\bThe\s+WISC[®–\- ]*V\b/i,
    /\bThe\s+WPPSI[®–\- ]*IV\b/i,
    /\bThe\s+WAIS[®–\- ]*IV\b/i,
    // Even broader: just WISC-V CDN or WISC-V anywhere as a line
    /\bWISC[®\-–]*\s*V\s*(?:CDN)?\b/i,
  ],
  cognitive_end: [
    /^\s*SUMMARY\s*$/m,
    /^\s*Summary\s*$/m,
    /\n\s*SUMMARY\s*\n/,
  ],
  summary_start: [
    /^\s*SUMMARY\s*$/m,
    /^\s*Summary\s*$/m,
    /^\s*SUMMARY AND (?:FORMULATION|RECOMMENDATIONS)/im,
    /^\s*SUMMARY,\s*FORMULATION/im,
  ],
  summary_end: [
    /^\s*RECOMMENDATIONS\s*$/m,
    /^\s*Recommendations\s*$/m,
    /^\s*APPENDIX/im,
  ],
  recommendations_start: [
    /^\s*RECOMMENDATIONS\s*$/m,
    /^\s*Recommendations\s*$/m,
  ],
  recommendations_end: [
    /^\s*APPENDIX/im,
  ],
  table_subtest: [
    /Subtest\s*Score\s*Summary/i,
    /Subtest\s*Scaled\s*Scores?/i,
    /Primary\s*Subtest\s*Score\s*Summary/i,
  ],
  table_composite: [
    /Composite\s*Score\s*Summary/i,
    /Primary\s*Index\s*Score\s*Summary/i,
  ],
  table_index: [
    /Index\s*Score\s*Summary/i,
    /Ancillary\s*(?:and\s*Complementary\s*)?Index\s*Score\s*Summary/i,
  ],
};

// Headers to strip (PDF page artifacts, not content)
const DET_STRIP_PATTERNS = [
  /^.*(?:WISC|WPPSI|WAIS)[®]*[-–]\s*(?:V|IV)\s*(?:CDN\s*)?Interpretive Report.*$/gmi,
  /^\s*ANCILLARY\s*INDEX\s*SCORES\s*$/gmi,
  /^.*INTERPRETATION OF (?:WISC|WPPSI|WAIS).*(?:RESULTS|CDN RESULTS).*$/gmi,
  /\d{2}\/\d{2}\/\d{4},\s*Page\s*\d+\s*[^\n]*/gi,
  /Copyright\s*©.*?reserved\.\s*/gi,
  /---\s*PAGE\s*BREAK\s*---/gi,
];

// ── ANCHOR MATCHING ──

function detFindAnchor(text, patterns) {
  for (const pat of patterns) {
    const m = text.search(pat);
    if (m !== -1) {
      let lineStart = m;
      while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
      return { index: m, lineStart };
    }
  }
  return null;
}

function detExtractBetween(text, startPats, endPats) {
  const start = detFindAnchor(text, startPats);
  if (!start) return null;
  const after = text.slice(start.lineStart);
  let endIdx = after.length;
  if (endPats) {
    for (const pat of endPats) {
      const m = after.search(pat);
      if (m !== -1 && m < endIdx) endIdx = m;
    }
  }
  return after.slice(0, endIdx).trim();
}

// ── TEXT CLEANUP ──

function detCleanText(text) {
  let c = text;
  for (const pat of DET_STRIP_PATTERNS) c = c.replace(pat, "");
  const pronouns = ["he","she","they","him","her","them","his","their","himself","herself","themselves","themself"];
  for (const p of pronouns) {
    c = c.replace(new RegExp("\\(" + p + "\\)", "gi"), (m) => m.slice(1, -1));
    c = c.replace(new RegExp("\\[" + p + "\\]", "gi"), (m) => m.slice(1, -1));
  }
  c = c.replace(/\[FIRST[_\s]?NAME\]/gi, "[firstName]");
  return c.replace(/\n{3,}/g, "\n\n").trim();
}

// ── SCORE EXTRACTORS (from text) ──

/** Extract subtest scores from table rows or inline text patterns.
 *  Returns [{name, scaledScore, percentile, qualitative}] or null. */
function detExtractSubtestScores(text) {
  const results = [];
  for (const name of DET_SUBTEST_NAMES) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sep = "[\\s\\t]+";
    // Pattern 1: Name  Raw  Scaled  CI  Percentile
    const re1 = new RegExp(esc + sep + "\\d+" + sep + "(\\d{1,2})" + sep + "\\d+\\s*[-–—]\\s*\\d+" + sep + "(\\d{1,3})", "i");
    // Pattern 2: Name  Scaled  Percentile
    const re2 = new RegExp(esc + sep + "(\\d{1,2})" + sep + "(\\d{1,3}(?:\\.\\d+)?)", "i");
    let m = text.match(re1);
    if (m && +m[1] >= SCALED_SCORE_MIN && +m[1] <= SCALED_SCORE_MAX) {
      results.push({ name, scaledScore: +m[1], percentile: +m[2], qualitative: scaledQualitative(+m[1]) });
      continue;
    }
    m = text.match(re2);
    if (m && +m[1] >= SCALED_SCORE_MIN && +m[1] <= SCALED_SCORE_MAX && +m[2] <= PERCENTILE_MAX) {
      results.push({ name, scaledScore: +m[1], percentile: +m[2], qualitative: scaledQualitative(+m[1]) });
    }
  }
  return results.length > 0 ? results : null;
}

/** Extract inline abbreviation scores like "(BD = 10; VP = 10)" or "(DSf = 9)" */
function detExtractInlineScores(text) {
  const results = [];
  for (const [abbrev, fullName] of Object.entries(DET_SUBTEST_ABBREVS)) {
    const re = new RegExp("(?:^|[\\s(;,])" + abbrev + "\\s*=\\s*(\\d{1,2})(?:[);,\\s]|$)", "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      const score = +m[1];
      if (score >= SCALED_SCORE_MIN && score <= SCALED_SCORE_MAX && !results.find((r) => r.name === fullName)) {
        results.push({ name: fullName, scaledScore: score, percentile: null, qualitative: scaledQualitative(score) });
      }
    }
  }
  return results;
}

/** Extract subtest scores from AI-generated narrative text.
 *  Handles patterns like: "Similarities ... scaled score of 10 (50th percentile)"
 *  Returns [{name, scaledScore, percentile, qualitative}] or []. */
function detExtractNarrativeSubtestScores(text) {
  const results = [];
  for (const name of DET_SUBTEST_NAMES) {
    if (results.find((r) => r.name === name)) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Pattern: "Name ... scaled score of X ... Yth percentile" (within 200 chars)
    const reNarr1 = new RegExp(esc + "[\\s\\S]{0,80}scaled\\s+score\\s+(?:of\\s+)?(\\d{1,2})(?:[\\s\\S]{0,80}?(\\d{1,3}(?:\\.\\d+)?)(?:st|nd|rd|th)\\s*percentile)?", "i");
    // Pattern: "Name ... a score of X ... Yth percentile"
    const reNarr2 = new RegExp(esc + "[\\s\\S]{0,60}(?:a\\s+)?score\\s+(?:of\\s+)?(\\d{1,2})(?:[,\\s][\\s\\S]{0,60}?(\\d{1,3}(?:\\.\\d+)?)(?:st|nd|rd|th))?", "i");
    // Pattern: "Name (X, Yth percentile)" or "Name (scaled score = X; Yth percentile)"
    const reNarr3 = new RegExp(esc + "\\s*\\([^)]*?(\\d{1,2})[^)]*?(\\d{1,3}(?:\\.\\d+)?)(?:st|nd|rd|th)\\s*percentile[^)]*?\\)", "i");

    let m = text.match(reNarr1);
    if (m && +m[1] >= SCALED_SCORE_MIN && +m[1] <= SCALED_SCORE_MAX) {
      results.push({ name, scaledScore: +m[1], percentile: m[2] ? parseFloat(m[2]) : null, qualitative: scaledQualitative(+m[1]) });
      continue;
    }
    m = text.match(reNarr3);
    if (m && +m[1] >= SCALED_SCORE_MIN && +m[1] <= SCALED_SCORE_MAX) {
      results.push({ name, scaledScore: +m[1], percentile: m[2] ? parseFloat(m[2]) : null, qualitative: scaledQualitative(+m[1]) });
      continue;
    }
    m = text.match(reNarr2);
    if (m && +m[1] >= SCALED_SCORE_MIN && +m[1] <= SCALED_SCORE_MAX) {
      results.push({ name, scaledScore: +m[1], percentile: m[2] ? parseFloat(m[2]) : null, qualitative: scaledQualitative(+m[1]) });
    }
  }
  return results;
}

/** Extract index scores from AI-generated narrative text.
 *  Handles patterns like: "Full Scale IQ (FSIQ) of 98 (45th percentile, Average range)"
 *  Returns [{abbrev, full, standardScore, percentile, ci, qualitative}] or null. */
function detExtractNarrativeIndexScores(text) {
  const results = [];
  const seen = new Set();
  for (const { abbrev, full } of DET_INDEX_DEFS) {
    if (seen.has(abbrev)) continue;
    const abbrEsc = abbrev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fullEsc = full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Pattern: "Full Name (ABBREV) ... standard score of X ... Yth percentile" or "... score of X (Yth percentile)"
    const reNarr1 = new RegExp("(?:" + fullEsc + "|" + abbrEsc + ")[\\s\\S]{0,120}(?:standard\\s+score|composite\\s+score|score|index\\s+score)\\s+(?:of\\s+|=\\s*|was\\s+)?(\\d{2,3})(?:[\\s\\S]{0,80}?(\\d{1,3}(?:\\.\\d+)?)(?:st|nd|rd|th)\\s*percentile)?", "i");
    // Pattern: "ABBREV of X ... Yth percentile" or "ABBREV = X ... Yth percentile"
    const reNarr2 = new RegExp("(?:" + abbrEsc + ")\\s*(?:of|=|was|:)\\s*(\\d{2,3})(?:[\\s\\S]{0,80}?(\\d{1,3}(?:\\.\\d+)?)(?:st|nd|rd|th)\\s*percentile)?", "i");
    // Pattern: "ABBREV ... X (Yth percentile)" — number followed by pct in parens
    const reNarr3 = new RegExp("(?:" + abbrEsc + ")[\\s\\S]{0,40}?(\\d{2,3})\\s*\\((?:(?:at\\s+)?(?:the\\s+)?)?(\\d{1,3}(?:\\.\\d+)?)(?:st|nd|rd|th)\\s*percentile", "i");

    let m = text.match(reNarr1);
    if (m && +m[1] >= STANDARD_SCORE_MIN && +m[1] <= STANDARD_SCORE_MAX) {
      results.push({ abbrev, full, standardScore: +m[1], percentile: m[2] ? parseFloat(m[2]) : null, ci: null, qualitative: qualitativeLabel(+m[1]) });
      seen.add(abbrev); continue;
    }
    m = text.match(reNarr3);
    if (m && +m[1] >= STANDARD_SCORE_MIN && +m[1] <= STANDARD_SCORE_MAX) {
      results.push({ abbrev, full, standardScore: +m[1], percentile: m[2] ? parseFloat(m[2]) : null, ci: null, qualitative: qualitativeLabel(+m[1]) });
      seen.add(abbrev); continue;
    }
    m = text.match(reNarr2);
    if (m && +m[1] >= STANDARD_SCORE_MIN && +m[1] <= STANDARD_SCORE_MAX) {
      results.push({ abbrev, full, standardScore: +m[1], percentile: m[2] ? parseFloat(m[2]) : null, ci: null, qualitative: qualitativeLabel(+m[1]) });
      seen.add(abbrev);
    }
  }
  return results.length > 0 ? results : null;
}

/** Extract index/composite scores from inline text like "(VCI = 98, PR = 45, CI = 91-106)".
 *  Returns [{abbrev, full, standardScore, percentile, ci, qualitative}] or null. */
function detExtractIndexScores(text) {
  const results = [];
  const seen = new Set();
  for (const { abbrev, full } of DET_INDEX_DEFS) {
    if (seen.has(abbrev)) continue;
    const sep = "[\\s\\t]+";
    // Table row: "VCI  22  102  96-108  55  Average"
    const reT = new RegExp("(?:^|\\n)\\s*" + abbrev + sep + "(?:\\d+" + sep + ")?(\\d{2,3})" + sep + "(\\d+)\\s*[-–—]\\s*(\\d+)" + sep + "(\\d{1,3})", "m");
    // Inline: "VCI = 98, PR = 45, ... CI = 91-106"
    const reI = new RegExp(abbrev + "\\s*=\\s*(\\d{2,3})\\s*,\\s*PR\\s*=\\s*(\\d{1,3})(?:.*?CI\\s*=\\s*(\\d+)\\s*[-–—]\\s*(\\d+))?", "i");
    // Simple: "VCI = 98, PR = 45"
    const reS = new RegExp(abbrev + "\\s*=\\s*(\\d{2,3}).*?PR\\s*=\\s*(\\d{1,3})", "i");
    // Table simple: "VCI  102  55"
    const reT2 = new RegExp("(?:^|\\n)\\s*" + abbrev + sep + "(\\d{2,3})" + sep + "(\\d{1,3})(?:\\s|$|\\n)", "m");

    let m = text.match(reT);
    if (m && +m[1] >= STANDARD_SCORE_MIN && +m[1] <= STANDARD_SCORE_MAX) {
      results.push({ abbrev, full, standardScore: +m[1], percentile: +m[4], ci: `${m[2]}-${m[3]}`, qualitative: qualitativeLabel(+m[1]) });
      seen.add(abbrev); continue;
    }
    m = text.match(reI);
    if (m && +m[1] >= STANDARD_SCORE_MIN && +m[1] <= STANDARD_SCORE_MAX) {
      results.push({ abbrev, full, standardScore: +m[1], percentile: +m[2], ci: m[3] && m[4] ? `${m[3]}-${m[4]}` : null, qualitative: qualitativeLabel(+m[1]) });
      seen.add(abbrev); continue;
    }
    m = text.match(reS);
    if (m && +m[1] >= STANDARD_SCORE_MIN && +m[1] <= STANDARD_SCORE_MAX) {
      results.push({ abbrev, full, standardScore: +m[1], percentile: +m[2], ci: null, qualitative: qualitativeLabel(+m[1]) });
      seen.add(abbrev); continue;
    }
    m = text.match(reT2);
    if (m && +m[1] >= STANDARD_SCORE_MIN && +m[1] <= STANDARD_SCORE_MAX && +m[2] <= PERCENTILE_MAX) {
      results.push({ abbrev, full, standardScore: +m[1], percentile: +m[2], ci: null, qualitative: qualitativeLabel(+m[1]) });
      seen.add(abbrev);
    }
  }
  return results.length > 0 ? results : null;
}

// ── PDF TABLE DETECTOR (from coordinates) ──

function detDetectPDFTables(pageLines) {
  const tables = [];
  const multiColLines = [];
  for (let i = 0; i < pageLines.length; i++) {
    if (pageLines[i].items.length >= 3) {
      multiColLines.push({ idx: i, line: pageLines[i] });
    }
  }
  if (multiColLines.length < 2) return tables;
  let group = [multiColLines[0]];
  for (let i = 1; i < multiColLines.length; i++) {
    const prev = multiColLines[i - 1], curr = multiColLines[i];
    if (Math.abs(curr.line.items.length - prev.line.items.length) <= 1 && curr.idx - prev.idx <= 3) {
      group.push(curr);
    } else {
      if (group.length >= 2) tables.push(group.map((g) => g.line.items.map((it) => it.text.trim())));
      group = [curr];
    }
  }
  if (group.length >= 2) tables.push(group.map((g) => g.line.items.map((it) => it.text.trim())));
  return tables; // Each table = array of rows, each row = array of cell strings
}

// ── DOCX TABLE EXTRACTOR ──

function detExtractDocxTables(docxTables) {
  const result = { subtests: null, composites: null, indexes: null };
  for (const table of docxTables) {
    if (table.rows.length < 2) continue;
    const hdr = table.rows[0].map((c) => c.toLowerCase()).join(" ");
    if (/subtest/.test(hdr) && /scaled/.test(hdr)) {
      const nameC = table.rows[0].findIndex((h) => /subtest|name/i.test(h));
      const scalC = table.rows[0].findIndex((h) => /scaled/i.test(h));
      const pctC = table.rows[0].findIndex((h) => /percentile|pr/i.test(h));
      if (nameC !== -1 && scalC !== -1) {
        result.subtests = [];
        for (let r = 1; r < table.rows.length; r++) {
          const row = table.rows[r];
          const nm = (row[nameC] || "").trim();
          const sc = parseInt(row[scalC]);
          const pc = pctC !== -1 ? parseInt(row[pctC]) : null;
          if (nm && nm !== "-" && nm !== "—" && !isNaN(sc) && sc >= SCALED_SCORE_MIN && sc <= SCALED_SCORE_MAX) {
            result.subtests.push({ name: nm, scaledScore: sc, percentile: isNaN(pc) ? null : pc, qualitative: scaledQualitative(sc) });
          }
        }
      }
    }
    if (/composite|index/i.test(hdr) && /standard/i.test(hdr)) {
      const nameC = table.rows[0].findIndex((h) => /composite|index|scale/i.test(h));
      const ssC = table.rows[0].findIndex((h) => /standard|score/i.test(h) && !/scaled/i.test(h));
      const pctC = table.rows[0].findIndex((h) => /percentile|pr/i.test(h));
      const qualC = table.rows[0].findIndex((h) => /qualitative|description|classification/i.test(h));
      const key = /composite/i.test(hdr) ? "composites" : "indexes";
      if (nameC !== -1 && ssC !== -1) {
        result[key] = [];
        for (let r = 1; r < table.rows.length; r++) {
          const row = table.rows[r];
          const nm = (row[nameC] || "").trim();
          const ss = parseInt(row[ssC]);
          const pc = pctC !== -1 ? parseInt(row[pctC]) : null;
          const ql = qualC !== -1 ? (row[qualC] || "").trim() : null;
          if (nm && nm !== "-" && nm !== "—" && !isNaN(ss) && ss >= STANDARD_SCORE_MIN && ss <= STANDARD_SCORE_MAX) {
            const def = DET_INDEX_DEFS.find((d) => nm.includes(d.abbrev) || nm.includes(d.full));
            result[key].push({ abbrev: def?.abbrev || nm, full: def?.full || nm, standardScore: ss, percentile: isNaN(pc) ? null : pc, qualitative: ql || qualitativeLabel(ss) });
          }
        }
      }
    }
  }
  return result;
}

// ── MAIN DETERMINISTIC EXTRACTION ──

const DET_STATUS = { OK: "ok", MISSING_ANCHOR: "missing_anchor", PARSE_ERROR: "parse_error", NO_CONTENT: "no_content" };

/**
 * Core deterministic extraction from any text source.
 * Returns { sections: { cognitive, summary, recommendations }, appendix_tables: { subtests, composites, indexes }, errors }
 */
function deterministicExtract(text, docxTables, pdfPages) {
  const result = {
    status: DET_STATUS.OK,
    errors: [],
    sections: {
      cognitive: { status: DET_STATUS.NO_CONTENT, text: null },
      summary: { status: DET_STATUS.NO_CONTENT, text: null },
      recommendations: { status: DET_STATUS.NO_CONTENT, text: null },
    },
    appendix_tables: { subtests: null, composites: null, indexes: null },
  };

  if (!text || text.length < 100) {
    result.status = DET_STATUS.NO_CONTENT;
    result.errors.push("Document has insufficient text");
    return result;
  }
  if (!/WISC|WPPSI|WAIS|Wechsler/i.test(text)) {
    result.status = DET_STATUS.NO_CONTENT;
    result.errors.push("Not a WISC/WPPSI/WAIS report");
    return result;
  }

  // ── COGNITIVE ──
  try {
    const raw = detExtractBetween(text, DET_ANCHORS.cognitive_start, DET_ANCHORS.cognitive_end);
    if (raw && raw.length > 100) {
      result.sections.cognitive = { status: DET_STATUS.OK, text: detCleanText(raw) };
    } else {
      result.sections.cognitive = { status: DET_STATUS.MISSING_ANCHOR, text: null };
      result.errors.push("Cognitive section anchors not found (raw=" + (raw ? raw.length : "null") + " chars)");
    }
  } catch (e) {
    result.sections.cognitive = { status: DET_STATUS.PARSE_ERROR, text: null };
    result.errors.push("Cognitive extraction error: " + e.message);
  }

  // ── SUMMARY ──
  try {
    const raw = detExtractBetween(text, DET_ANCHORS.summary_start, DET_ANCHORS.summary_end);
    if (raw) {
      // Remove the "SUMMARY" heading line itself
      const cleaned = raw.replace(/^\s*SUMMARY\s*\n*/i, "").trim();
      if (cleaned.length > 50) result.sections.summary = { status: DET_STATUS.OK, text: detCleanText(cleaned) };
    }
  } catch (e) {
    result.sections.summary = { status: DET_STATUS.PARSE_ERROR, text: null };
    result.errors.push("Summary extraction error: " + e.message);
  }

  // ── RECOMMENDATIONS ──
  try {
    const raw = detExtractBetween(text, DET_ANCHORS.recommendations_start, DET_ANCHORS.recommendations_end);
    if (raw) {
      const cleaned = raw.replace(/^\s*RECOMMENDATIONS\s*\n*/i, "").trim();
      if (cleaned.length > 50) result.sections.recommendations = { status: DET_STATUS.OK, text: detCleanText(cleaned) };
    }
  } catch (e) {
    result.sections.recommendations = { status: DET_STATUS.PARSE_ERROR, text: null };
    result.errors.push("Recommendations extraction error: " + e.message);
  }

  // ── SCORE TABLES ──
  try {
    // Priority 1: DOCX structured tables
    if (docxTables && docxTables.length > 0) {
      const dt = detExtractDocxTables(docxTables);
      if (dt.subtests) result.appendix_tables.subtests = dt.subtests;
      if (dt.composites) result.appendix_tables.composites = dt.composites;
      if (dt.indexes) result.appendix_tables.indexes = dt.indexes;
    }

    // Priority 2: PDF coordinate-based table detection
    if (pdfPages && pdfPages.length > 0) {
      for (const page of pdfPages) {
        if (!page.lines) continue;
        const pageTables = detDetectPDFTables(page.lines);
        for (const rows of pageTables) {
          if (rows.length < 2) continue;
          const hdr = rows[0].join(" ").toLowerCase();
          if (/subtest/.test(hdr) && /scaled/.test(hdr) && !result.appendix_tables.subtests) {
            result.appendix_tables.subtests = detParseSubtestRows(rows);
          }
          if ((/composite/.test(hdr) || /index/.test(hdr)) && /standard/.test(hdr)) {
            const target = /composite/.test(hdr) ? "composites" : "indexes";
            if (!result.appendix_tables[target]) {
              result.appendix_tables[target] = detParseIndexRows(rows);
            }
          }
        }
      }
    }

    // Priority 3: Regex extraction from text (inline scores)
    const scoreSrc = result.sections.cognitive.text || text;
    if (!result.appendix_tables.subtests) {
      result.appendix_tables.subtests = detExtractSubtestScores(scoreSrc);
    }
    // Also grab inline abbreviation scores and merge
    if (result.sections.cognitive.text) {
      const inl = detExtractInlineScores(result.sections.cognitive.text);
      if (inl.length > 0) {
        if (!result.appendix_tables.subtests) {
          result.appendix_tables.subtests = inl;
        } else {
          for (const s of inl) {
            if (!result.appendix_tables.subtests.find((x) => x.name === s.name)) {
              result.appendix_tables.subtests.push(s);
            }
          }
        }
      }
    }
    if (!result.appendix_tables.composites && !result.appendix_tables.indexes) {
      const idx = detExtractIndexScores(scoreSrc);
      if (idx) {
        const primary = ["FSIQ", "VCI", "VSI", "FRI", "WMI", "PSI", "PRI"];
        result.appendix_tables.composites = idx.filter((s) => primary.includes(s.abbrev));
        result.appendix_tables.indexes = idx.filter((s) => !primary.includes(s.abbrev));
        if (result.appendix_tables.composites.length === 0) result.appendix_tables.composites = null;
        if (result.appendix_tables.indexes.length === 0) result.appendix_tables.indexes = null;
      }
    }
  } catch (e) {
    result.errors.push("Table extraction error: " + e.message);
  }

  return result;
}

function detParseSubtestRows(rows) {
  const results = [];
  const hdr = rows[0].map((c) => c.toLowerCase());
  const nameC = hdr.findIndex((h) => /subtest|name/i.test(h));
  const scalC = hdr.findIndex((h) => /scaled/i.test(h));
  const pctC = hdr.findIndex((h) => /percentile|pr/i.test(h));
  if (nameC === -1 || scalC === -1) {
    // Fallback: assume col 0=name, find numeric cols
    for (let r = 1; r < rows.length; r++) {
      const nm = (rows[r][0] || "").trim();
      const nums = rows[r].slice(1).map((c) => parseInt(c)).filter((n) => !isNaN(n));
      const sc = nums.find((n) => n >= SCALED_SCORE_MIN && n <= SCALED_SCORE_MAX);
      if (nm && nm !== "-" && sc !== undefined) {
        const pc = nums.find((n) => n >= 0 && n <= PERCENTILE_MAX && n !== sc);
        results.push({ name: nm, scaledScore: sc, percentile: pc ?? null, qualitative: scaledQualitative(sc) });
      }
    }
  } else {
    for (let r = 1; r < rows.length; r++) {
      const nm = (rows[r][nameC] || "").trim();
      const sc = parseInt(rows[r][scalC]);
      const pc = pctC !== -1 ? parseInt(rows[r][pctC]) : null;
      if (nm && nm !== "-" && nm !== "—" && !isNaN(sc) && sc >= SCALED_SCORE_MIN && sc <= SCALED_SCORE_MAX) {
        results.push({ name: nm, scaledScore: sc, percentile: isNaN(pc) ? null : pc, qualitative: scaledQualitative(sc) });
      }
    }
  }
  return results.length > 0 ? results : null;
}

function detParseIndexRows(rows) {
  const results = [];
  const hdr = rows[0].map((c) => c.toLowerCase());
  const nameC = hdr.findIndex((h) => /composite|index|scale|name/i.test(h));
  const ssC = hdr.findIndex((h) => /standard|score/i.test(h) && !/scaled/i.test(h));
  const pctC = hdr.findIndex((h) => /percentile|pr/i.test(h));
  const qualC = hdr.findIndex((h) => /qualitative|description|classification/i.test(h));
  if (nameC === -1 || ssC === -1) {
    for (let r = 1; r < rows.length; r++) {
      const nm = (rows[r][0] || "").trim();
      const nums = rows[r].slice(1).map((c) => parseInt(c)).filter((n) => !isNaN(n));
      const ss = nums.find((n) => n >= STANDARD_SCORE_MIN && n <= STANDARD_SCORE_MAX);
      if (nm && ss !== undefined) {
        const pc = nums.find((n) => n >= 0 && n <= PERCENTILE_MAX && n !== ss);
        const def = DET_INDEX_DEFS.find((d) => nm.includes(d.abbrev) || nm.includes(d.full));
        results.push({ abbrev: def?.abbrev || nm, full: def?.full || nm, standardScore: ss, percentile: pc ?? null, qualitative: qualitativeLabel(ss) });
      }
    }
  } else {
    for (let r = 1; r < rows.length; r++) {
      const nm = (rows[r][nameC] || "").trim();
      const ss = parseInt(rows[r][ssC]);
      const pc = pctC !== -1 ? parseInt(rows[r][pctC]) : null;
      const ql = qualC !== -1 ? (rows[r][qualC] || "").trim() : null;
      if (nm && nm !== "-" && nm !== "—" && !isNaN(ss) && ss >= STANDARD_SCORE_MIN && ss <= STANDARD_SCORE_MAX) {
        const def = DET_INDEX_DEFS.find((d) => nm.includes(d.abbrev) || nm.includes(d.full));
        results.push({ abbrev: def?.abbrev || nm, full: def?.full || nm, standardScore: ss, percentile: isNaN(pc) ? null : pc, qualitative: ql || qualitativeLabel(ss) });
      }
    }
  }
  return results.length > 0 ? results : null;
}

// ── HTML TABLE BUILDER (deterministic, no AI) ──

function detBuildScoreTablesHTML(tables, firstName) {
  const nm = firstName || "[firstName]";
  const parts = [];
  const th = 'style="border:1px solid #666;padding:6px 10px;background:#e8e8e8;font-weight:bold;text-align:left;font-family:Times New Roman,serif;font-size:11pt"';
  const td = 'style="border:0.5pt solid #666;padding:3px 10px;font-family:Times New Roman,serif;font-size:11pt"';
  const ta = 'style="border:0.5pt solid #666;padding:3px 10px;font-family:Times New Roman,serif;font-size:11pt;background:#f5f5f5"';
  const tbl = 'style="border-collapse:collapse;width:100%;margin:12px 0 24px 0;font-family:Times New Roman,serif"';

  if (tables.subtests && tables.subtests.length > 0) {
    let h = `<p style="font-weight:bold;font-family:Times New Roman,serif;font-size:12pt;margin:16px 0 4px 0">WISC-V Subtest Score Summary — ${nm}</p>\n`;
    h += `<table ${tbl}>\n<tr><th ${th}>Subtest</th><th ${th}>Scaled Score</th><th ${th}>Percentile Rank</th><th ${th}>Qualitative Description</th></tr>\n`;
    tables.subtests.forEach((s, i) => {
      const st = i % 2 === 1 ? ta : td;
      h += `<tr><td ${st}>${s.name}</td><td ${st}>${s.scaledScore}</td><td ${st}>${s.percentile ?? "—"}</td><td ${st}>${s.qualitative}</td></tr>\n`;
    });
    h += "</table>";
    parts.push(h);
  }
  if (tables.composites && tables.composites.length > 0) {
    let h = `<p style="font-weight:bold;font-family:Times New Roman,serif;font-size:12pt;margin:16px 0 4px 0">WISC-V Composite Score Summary — ${nm}</p>\n`;
    h += `<table ${tbl}>\n<tr><th ${th}>Composite</th><th ${th}>Standard Score</th><th ${th}>Percentile Rank</th><th ${th}>Confidence Interval (95%)</th><th ${th}>Qualitative Description</th></tr>\n`;
    tables.composites.forEach((s, i) => {
      const st = i % 2 === 1 ? ta : td;
      h += `<tr><td ${st}>${s.full} (${s.abbrev})</td><td ${st}>${s.standardScore}</td><td ${st}>${s.percentile ?? "—"}</td><td ${st}>${s.ci || "—"}</td><td ${st}>${s.qualitative}</td></tr>\n`;
    });
    h += "</table>";
    parts.push(h);
  }
  if (tables.indexes && tables.indexes.length > 0) {
    let h = `<p style="font-weight:bold;font-family:Times New Roman,serif;font-size:12pt;margin:16px 0 4px 0">WISC-V Ancillary Index Score Summary — ${nm}</p>\n`;
    h += `<table ${tbl}>\n<tr><th ${th}>Index</th><th ${th}>Standard Score</th><th ${th}>Percentile Rank</th><th ${th}>Confidence Interval (95%)</th><th ${th}>Qualitative Description</th></tr>\n`;
    tables.indexes.forEach((s, i) => {
      const st = i % 2 === 1 ? ta : td;
      h += `<tr><td ${st}>${s.full} (${s.abbrev})</td><td ${st}>${s.standardScore}</td><td ${st}>${s.percentile ?? "—"}</td><td ${st}>${s.ci || "—"}</td><td ${st}>${s.qualitative}</td></tr>\n`;
    });
    h += "</table>";
    parts.push(h);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

// ── TEMPLATE-BASED TABLE BUILDER (placeholder fill, no AI) ──

// Mapping: subtest name (as parsed) → template abbreviation
const WISC_SUBTEST_ABBREV_MAP = {
  "Similarities": "SI", "Vocabulary": "VC", "Block Design": "BD", "Visual Puzzles": "VP",
  "Matrix Reasoning": "MR", "Figure Weights": "FW", "Digit Span": "DS", "Picture Span": "PS",
  "Coding": "CD", "Symbol Search": "SS", "Information": "IN", "Comprehension": "CO",
  "Arithmetic": "AR", "Letter-Number Sequencing": "LN", "Cancellation": "CA",
  "Naming Speed Literacy": "NSL", "Naming Speed Quantity": "NSQ",
  "Immediate Symbol Translation": "IST", "Delayed Symbol Translation": "DST", "Recognition Symbol Translation": "RST",
};
// Mapping: parseWIATScores keys → template placeholder keys
const WIAT_KEY_MAP = {
  WORD_READING: "WordReading", PSEUDOWORD_DECODING: "PseudowordDecoding",
  READING_COMPREHENSION: "ReadingComprehension", SPELLING: "Spelling",
  SENTENCE_COMPOSITION: "SentenceComposition", ESSAY_COMPOSITION: "EssayComposition",
  NUMERICAL_OPERATIONS: "NumericalOperations", MATH_PROBLEM_SOLVING: "MathProblemSolving",
  LISTENING_COMPREHENSION: "ListeningComprehension", RECEPTIVE_VOCABULARY: "ReceptiveVocabulary",
  ORAL_DISCOURSE: "OralDiscourseComprehension", ORAL_READING_FLUENCY: "OralReadingFluency",
  TOTAL_READING: "TotalReading", BASIC_READING: "BasicReading",
  READING_COMPREHENSION_FLUENCY: "ReadingComprehensionFluency",
  WRITTEN_EXPRESSION: "WrittenExpression", MATHEMATICS_COMPOSITE: "Mathematics",
  TOTAL_ACHIEVEMENT: "TotalAchievement", ORAL_LANGUAGE_COMPOSITE: "OralLanguageComposite",
};

function buildTemplatePlaceholderMap(wiscTables, wiatScores) {
  const map = {};

  // ── WISC subtests: {{WISC.XX.scaled}}, {{WISC.XX.percentile}} ──
  if (wiscTables?.subtests) {
    for (const s of wiscTables.subtests) {
      const abbr = WISC_SUBTEST_ABBREV_MAP[s.name];
      if (!abbr) continue;
      map[`WISC.${abbr}.scaled`] = s.scaledScore != null ? String(s.scaledScore) : "";
      map[`WISC.${abbr}.percentile`] = s.percentile != null ? String(s.percentile) : "";
    }
  }

  // ── WISC composites + indexes: {{WISC.XX.score}}, {{WISC.XX.percentile}}, {{WISC.XX.qualitative}} ──
  const allIdx = [...(wiscTables?.composites || []), ...(wiscTables?.indexes || [])];
  for (const s of allIdx) {
    const abbr = s.abbrev; // VCI, VSI, FRI, WMI, PSI, FSIQ, GAI, CPI, NVI, etc.
    if (!abbr) continue;
    map[`WISC.${abbr}.score`] = s.standardScore != null ? String(s.standardScore) : "";
    map[`WISC.${abbr}.percentile`] = s.percentile != null ? String(s.percentile) : "";
    map[`WISC.${abbr}.qualitative`] = s.qualitative || (s.standardScore != null ? qualitativeLabel(s.standardScore) : "");
  }

  // ── WIAT: {{WIAT.XX.score}}, {{WIAT.XX.percentile}}, {{WIAT.XX.qualitative}} ──
  if (wiatScores) {
    for (const [rawKey, data] of Object.entries(wiatScores)) {
      const tplKey = WIAT_KEY_MAP[rawKey];
      if (!tplKey || !data || data.ss == null) continue;
      map[`WIAT.${tplKey}.score`] = String(data.ss);
      map[`WIAT.${tplKey}.percentile`] = String(data.percentile ?? "");
      map[`WIAT.${tplKey}.qualitative`] = ssToRange(data.ss);
    }
  }

  return map;
}

function buildTemplateTablesHTML(wiscTables, wiatScores, firstName) {
  const nm = firstName || "[firstName]";
  const placeholders = buildTemplatePlaceholderMap(wiscTables, wiatScores);
  const parts = [];

  const th = 'style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:left;font-weight:bold;font-family:\'Times New Roman\',Times,serif"';
  const thC = 'style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:center;font-weight:bold;font-family:\'Times New Roman\',Times,serif"';
  const cap = 'style="font-weight:bold;font-size:12pt;padding:6px 10px;text-align:left;border:0.5pt solid #666;font-family:\'Times New Roman\',Times,serif"';
  const tbl = 'style="width:100%;border-collapse:collapse;margin:6pt 0 6pt 0;font-family:\'Times New Roman\',Times,serif;font-size:11pt;border:0.5pt solid #666"';

  function td(val, center) {
    const align = center ? "text-align:center;" : "";
    return `<td style="padding:3px 10px;border:0.5pt solid #999;${align}">${val}</td>`;
  }
  function tdBold(val, center) {
    const align = center ? "text-align:center;" : "";
    return `<td style="padding:3px 10px;border:0.5pt solid #999;font-weight:bold;${align}">${val}</td>`;
  }
  function rowBg(i) { return ''; }
  function fill(key) { return placeholders[key] ?? ""; }
  function hasFill(key) { return !!placeholders[key]; }

  // ═══ WISC-V Subtest Score Summary ═══
  const wiscSubtestDefs = [
    ["Similarities", "SI"], ["Vocabulary", "VC"], ["Block Design", "BD"], ["Visual Puzzles", "VP"],
    ["Matrix Reasoning", "MR"], ["Figure Weights", "FW"], ["Digit Span", "DS"], ["Picture Span", "PS"],
    ["Coding", "CD"], ["Symbol Search", "SS"],
  ];
  const wiscSubRows = wiscSubtestDefs.filter(([, abbr]) => hasFill(`WISC.${abbr}.scaled`));
  if (wiscSubRows.length > 0) {
    let h = `<table ${tbl}>\n<caption ${cap}>WISC-V Subtest Score Summary — ${nm}</caption>\n`;
    h += `<thead><tr><th ${th}>Subtest</th><th ${thC}>Scaled Score</th><th ${thC}>Percentile Rank</th></tr></thead>\n<tbody>\n`;
    wiscSubRows.forEach(([name, abbr], i) => {
      h += `<tr ${rowBg(i)}>${td(name)}${td(fill(`WISC.${abbr}.scaled`), true)}${td(fill(`WISC.${abbr}.percentile`), true)}</tr>\n`;
    });
    h += `</tbody></table>`;
    parts.push(h);
  }

  // ═══ WISC-V Composite Score Summary ═══
  const wiscCompDefs = [
    ["Verbal Comprehension Index", "VCI"], ["Visual Spatial Index", "VSI"],
    ["Fluid Reasoning Index", "FRI"], ["Working Memory Index", "WMI"],
    ["Processing Speed Index", "PSI"], ["Full Scale IQ", "FSIQ"],
  ];
  const wiscCompRows = wiscCompDefs.filter(([, abbr]) => hasFill(`WISC.${abbr}.score`));
  if (wiscCompRows.length > 0) {
    let h = `<table ${tbl}>\n<caption ${cap}>WISC-V Composite Score Summary — ${nm}</caption>\n`;
    h += `<thead><tr><th ${th}>Composite</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th></tr></thead>\n<tbody>\n`;
    wiscCompRows.forEach(([name, abbr], i) => {
      h += `<tr style="font-weight:bold;background:${i % 2 === 0 ? '#f0f0fa' : '#e8e8f0'}">${tdBold(`${name} (${abbr})`)}${tdBold(fill(`WISC.${abbr}.score`), true)}${tdBold(fill(`WISC.${abbr}.percentile`), true)}${tdBold(fill(`WISC.${abbr}.qualitative`), true)}</tr>\n`;
    });
    h += `</tbody></table>`;
    parts.push(h);
  }

  // ═══ WISC-V Index Score Summary (Ancillary) ═══
  const wiscIdxDefs = [
    ["Nonverbal Index", "NVI"], ["General Ability Index", "GAI"],
    ["Cognitive Proficiency Index", "CPI"], ["Auditory Working Memory Index", "AWMI"],
  ];
  const wiscIdxRows = wiscIdxDefs.filter(([, abbr]) => hasFill(`WISC.${abbr}.score`));
  if (wiscIdxRows.length > 0) {
    let h = `<table ${tbl}>\n<caption ${cap}>WISC-V Index Score Summary — ${nm}</caption>\n`;
    h += `<thead><tr><th ${th}>Index</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th></tr></thead>\n<tbody>\n`;
    wiscIdxRows.forEach(([name, abbr], i) => {
      h += `<tr style="font-weight:bold;background:${i % 2 === 0 ? '#f0f0fa' : '#e8e8f0'}">${tdBold(`${name} (${abbr})`)}${tdBold(fill(`WISC.${abbr}.score`), true)}${tdBold(fill(`WISC.${abbr}.percentile`), true)}${tdBold(fill(`WISC.${abbr}.qualitative`), true)}</tr>\n`;
    });
    h += `</tbody></table>`;
    parts.push(h);
  }

  // ═══ WIAT-III Subtest Score Summary ═══
  const wiatSubDefs = [
    ["Word Reading", "WordReading"], ["Pseudoword Decoding", "PseudowordDecoding"],
    ["Reading Comprehension", "ReadingComprehension"], ["Oral Reading Fluency", "OralReadingFluency"],
    ["Spelling", "Spelling"], ["Sentence Composition", "SentenceComposition"],
    ["Essay Composition", "EssayComposition"], ["Numerical Operations", "NumericalOperations"],
    ["Math Problem Solving", "MathProblemSolving"],
    ["Listening Comprehension", "ListeningComprehension"], ["Receptive Vocabulary", "ReceptiveVocabulary"],
    ["Oral Discourse Comprehension", "OralDiscourseComprehension"],
  ];
  const wiatSubRows = wiatSubDefs.filter(([, key]) => hasFill(`WIAT.${key}.score`));
  if (wiatSubRows.length > 0) {
    let h = `<table ${tbl}>\n<caption ${cap}>WIAT-III Subtest Score Summary — ${nm}</caption>\n`;
    h += `<thead><tr><th ${th}>Subtest</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th></tr></thead>\n<tbody>\n`;
    wiatSubRows.forEach(([name, key], i) => {
      h += `<tr ${rowBg(i)}>${td(name)}${td(fill(`WIAT.${key}.score`), true)}${td(fill(`WIAT.${key}.percentile`), true)}${td(fill(`WIAT.${key}.qualitative`), true)}</tr>\n`;
    });
    h += `</tbody></table>`;
    parts.push(h);
  }

  // ═══ WIAT-III Composite Score Summary ═══
  const wiatCompDefs = [
    ["Total Reading", "TotalReading"], ["Basic Reading", "BasicReading"],
    ["Reading Comprehension and Fluency", "ReadingComprehensionFluency"],
    ["Written Expression", "WrittenExpression"], ["Mathematics", "Mathematics"],
    ["Total Achievement", "TotalAchievement"], ["Oral Language Composite", "OralLanguageComposite"],
  ];
  const wiatCompRows = wiatCompDefs.filter(([, key]) => hasFill(`WIAT.${key}.score`));
  if (wiatCompRows.length > 0) {
    let h = `<table ${tbl}>\n<caption ${cap}>WIAT-III Composite Score Summary — ${nm}</caption>\n`;
    h += `<thead><tr><th ${th}>Composite</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th></tr></thead>\n<tbody>\n`;
    wiatCompRows.forEach(([name, key], i) => {
      h += `<tr style="font-weight:bold;background:${i % 2 === 0 ? '#f0f0fa' : '#e8e8f0'}">${tdBold(name)}${tdBold(fill(`WIAT.${key}.score`), true)}${tdBold(fill(`WIAT.${key}.percentile`), true)}${tdBold(fill(`WIAT.${key}.qualitative`), true)}</tr>\n`;
    });
    h += `</tbody></table>`;
    parts.push(h);
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

// ── PUBLIC API: drop-in replacements ──

/** Extract cognitive section text from uploaded docs. Returns string or null. */
function extractCognitiveText(docs) {
  if (!docs || docs.length === 0) { return null; }
  try {
    for (const d of docs) {
      const txt = d.extractedText || "";
      if (!txt || txt.length < 200) { continue; }

      // Check for WISC content with broad matching
      const hasWisc = /WISC|WPPSI|WAIS|Wechsler/i.test(txt);
      if (!hasWisc) { continue; }


      // Try deterministic extraction first
      const result = deterministicExtract(txt, d._docxTables || null, d._pdfPages || null);
      if (result.sections.cognitive.status === DET_STATUS.OK && result.sections.cognitive.text.length > 200) {
        return result.sections.cognitive.text;
      }

      // ── BROAD FALLBACK: find ANY substantial WISC content ──
      // Some PDFs have text split across items so anchors fail.
      // Try progressively broader patterns.
      const broadPatterns = [
        // Multi-line tolerant: "was administered" ... "Wechsler" with newlines allowed
        /\bwas administered\b[\s\S]{0,120}(?:Wechsler|WISC|WPPSI|WAIS)/i,
        // Just "WISC-V" or "Wechsler Intelligence Scale" anywhere
        /(?:The\s+)?(?:WISC[®\-–]*V|Wechsler\s+Intelligence\s+Scale)/i,
        // "Full Scale" or "FSIQ" (definitely interpretive content)
        /(?:Full\s+Scale\s+IQ|FSIQ\s*=?\s*\d)/i,
        // Any index abbreviation with score
        /(?:VCI|VSI|FRI|WMI|PSI)\s*=\s*\d{2,3}/i,
      ];

      for (const pat of broadPatterns) {
        const m = txt.search(pat);
        if (m === -1) continue;

        // Back up to paragraph/line start
        let start = m;
        while (start > 0 && txt[start - 1] !== "\n") start--;
        // Go back further to capture paragraph context (up to 200 chars before)
        let paraStart = start;
        let newlineCount = 0;
        while (paraStart > 0 && newlineCount < 2) {
          paraStart--;
          if (txt[paraStart] === "\n") newlineCount++;
        }
        if (paraStart > 0) paraStart++; // don't include the leading newline

        // Find end: SUMMARY or end of text
        const fromStart = txt.slice(paraStart);
        let endIdx = fromStart.length;
        const endPats = [/^\s*SUMMARY\s*$/m, /^\s*Summary\s*$/m];
        for (const ep of endPats) {
          const em = fromStart.search(ep);
          if (em !== -1 && em < endIdx) endIdx = em;
        }

        let extracted = fromStart.slice(0, endIdx).trim();
        if (extracted.length > 200) {
          extracted = detCleanText(extracted);
          return extracted;
        }
      }

      // ── LAST RESORT: return ALL text from first WISC mention to SUMMARY ──
      const firstWisc = txt.search(/WISC|Wechsler/i);
      if (firstWisc !== -1) {
        let start = firstWisc;
        while (start > 0 && txt[start - 1] !== "\n") start--;
        const rest = txt.slice(start);
        let endIdx = rest.length;
        const endPats2 = [/^\s*SUMMARY\s*$/m, /^\s*Summary\s*$/m];
        for (const ep of endPats2) {
          const em = rest.search(ep);
          if (em !== -1 && em < endIdx) endIdx = em;
        }
        const lastResort = detCleanText(rest.slice(0, endIdx).trim());
        if (lastResort.length > 100) {
          return lastResort;
        }
      }

    }
  } catch (e) {
    // extraction failed silently
  }
  return null;
}

/** Extract WISC summary section text from uploaded docs. Returns string or null. */
function extractSummaryText(docs) {
  if (!docs || docs.length === 0) return null;
  try {
    for (const d of docs) {
      const txt = d.extractedText || "";
      if (!txt || txt.length < 200) continue;
      if (!/WISC|WPPSI|WAIS|Wechsler/i.test(txt)) continue;
      const result = deterministicExtract(txt, d._docxTables || null, d._pdfPages || null);
      if (result.sections.summary.status === DET_STATUS.OK) return result.sections.summary.text;
    }
  } catch (e) { /* extraction failed */ }
  return null;
}

/** Extract WISC recommendations section text from uploaded docs. Returns string or null. */
function extractRecommendationsText(docs) {
  if (!docs || docs.length === 0) return null;
  try {
    for (const d of docs) {
      const txt = d.extractedText || "";
      if (!txt || txt.length < 200) continue;
      if (!/WISC|WPPSI|WAIS|Wechsler/i.test(txt)) continue;
      const result = deterministicExtract(txt, d._docxTables || null, d._pdfPages || null);
      if (result.sections.recommendations.status === DET_STATUS.OK) return result.sections.recommendations.text;
    }
  } catch (e) { /* extraction failed */ }
  return null;
}

/** Build appendix WISC + WIAT score tables HTML deterministically from docs. Returns HTML string or null. */
function buildAppendixTablesFromDocs(docs, firstName) {
  if (!docs || docs.length === 0) return null;
  let wiscTables = null;
  let wiatScores = null;
  try {
    for (const d of docs) {
      const txt = d.extractedText || "";
      if (!txt || txt.length < 200) continue;

      // ── WISC extraction ──
      if (!wiscTables && /WISC|WPPSI|WAIS|Wechsler/i.test(txt)) {
        const result = deterministicExtract(txt, d._docxTables || null, d._pdfPages || null);
        const t = result.appendix_tables;
        if (t.subtests || t.composites || t.indexes) {
          wiscTables = t;
        }
      }

      // ── WIAT extraction ──
      if (!wiatScores && /WIAT/i.test(txt)) {
        const sc = parseWIATScores(txt);
        const filled = Object.values(sc).filter((v) => v && v.ss != null).length;
        if (filled >= 2) {
          wiatScores = sc;
        }
      }
    }

    // Build tables using the template system (covers both WISC + WIAT)
    if (wiscTables || wiatScores) {
      const templateHtml = buildTemplateTablesHTML(wiscTables, wiatScores, firstName);
      if (templateHtml) return templateHtml;
    }

    // Legacy fallback: WISC-only tables from old builder
    if (wiscTables) {
      const html = detBuildScoreTablesHTML(wiscTables, firstName);
      if (html) return html;
    }
  } catch (e) { /* extraction failed */ }
  return null;
}

/**
 * Extract ALL available scores from uploaded docs into a unified flat map.
 * Keys match what buildBlankPlaceholderTablesHTML expects to fill cells.
 * Returns { "WISC.SI.scaled": "12", "WIAT.WordReading.score": "98", "WRAML.GIM.score": "95", ... }
 */
function extractAllScoresMap(docs) {
  if (!docs || docs.length === 0) return {};
  const map = {};
  try {
    for (const d of docs) {
      const txt = d.extractedText || "";
      if (!txt || txt.length < 150) continue;

      // ── WISC / WPPSI / WAIS extraction ──
      if (/WISC|WPPSI|WAIS|Wechsler/i.test(txt)) {
        try {
          const isWAIS = /WAIS/i.test(txt);
          const isWPPSI = /WPPSI/i.test(txt);
          const prefix = isWAIS ? "WAIS" : isWPPSI ? "WPPSI" : "WISC";
          const result = deterministicExtract(txt, d._docxTables || null, d._pdfPages || null);
          const t = result.appendix_tables;
          let hasSubtests = false;
          let hasIndexes = false;
          if (t.subtests) {
            for (const s of t.subtests) {
              const abbr = WISC_SUBTEST_ABBREV_MAP[s.name];
              if (!abbr) continue;
              hasSubtests = true;
              if (s.scaledScore != null) map[`${prefix}.${abbr}.scaled`] = String(s.scaledScore);
              if (s.percentile != null) map[`${prefix}.${abbr}.percentile`] = String(s.percentile);
            }
          }
          const allIdx = [...(t.composites || []), ...(t.indexes || [])];
          for (const s of allIdx) {
            const abbr = s.abbrev;
            if (!abbr) continue;
            hasIndexes = true;
            if (s.standardScore != null) map[`${prefix}.${abbr}.score`] = String(s.standardScore);
            if (s.percentile != null) map[`${prefix}.${abbr}.percentile`] = String(s.percentile);
            map[`${prefix}.${abbr}.qualitative`] = s.qualitative || (s.standardScore != null ? qualitativeLabel(s.standardScore) : "");
          }
          // ── FALLBACK: Narrative extraction for AI-generated text or non-standard formats ──
          if (!hasSubtests) {
            const narrSubs = detExtractNarrativeSubtestScores(txt);
            for (const s of narrSubs) {
              const abbr = WISC_SUBTEST_ABBREV_MAP[s.name];
              if (!abbr || map[`${prefix}.${abbr}.scaled`]) continue;
              if (s.scaledScore != null) map[`${prefix}.${abbr}.scaled`] = String(s.scaledScore);
              if (s.percentile != null) map[`${prefix}.${abbr}.percentile`] = String(s.percentile);
            }
          }
          if (!hasIndexes) {
            const narrIdx = detExtractNarrativeIndexScores(txt);
            if (narrIdx) {
              for (const s of narrIdx) {
                const abbr = s.abbrev;
                if (!abbr || map[`${prefix}.${abbr}.score`]) continue;
                if (s.standardScore != null) map[`${prefix}.${abbr}.score`] = String(s.standardScore);
                if (s.percentile != null) map[`${prefix}.${abbr}.percentile`] = String(s.percentile);
                map[`${prefix}.${abbr}.qualitative`] = s.qualitative || (s.standardScore != null ? qualitativeLabel(s.standardScore) : "");
              }
            }
          }
          // ── FALLBACK: parseWAISScores / parseWPPSIScores for index + subtest extraction ──
          if (!hasIndexes && isWAIS) {
            const parsed = parseWAISScores(txt);
            if (parsed) {
              const idxMap = [["fsiq","FSIQ"],["vci","VCI"],["pri","PRI"],["wmi","WMI"],["psi","PSI"],["gai","GAI"],["cpi","CPI"]];
              for (const [k, abbr] of idxMap) {
                if (parsed[k] && !map[`WAIS.${abbr}.score`]) {
                  map[`WAIS.${abbr}.score`] = String(parsed[k].score);
                  map[`WAIS.${abbr}.percentile`] = String(parsed[k].pct);
                  map[`WAIS.${abbr}.qualitative`] = qualitativeLabel(parsed[k].score);
                }
              }
              if (parsed.subtests) {
                for (const [abbr, data] of Object.entries(parsed.subtests)) {
                  if (!map[`WAIS.${abbr}.scaled`]) {
                    map[`WAIS.${abbr}.scaled`] = String(data.scaled);
                    map[`WAIS.${abbr}.percentile`] = String(data.pct);
                  }
                }
              }
            }
          }
          if (!hasIndexes && isWPPSI) {
            const parsed = parseWPPSIScores(txt);
            if (parsed) {
              const idxMap = [["fsiq","FSIQ"],["vci","VCI"],["vsi","VSI"],["fri","FRI"],["wmi","WMI"],["psi","PSI"],["gai","GAI"],["cpi","CPI"],["nvi","NVI"],["vai","VAI"]];
              for (const [k, abbr] of idxMap) {
                if (parsed[k] && !map[`WPPSI.${abbr}.score`]) {
                  map[`WPPSI.${abbr}.score`] = String(parsed[k].score);
                  map[`WPPSI.${abbr}.percentile`] = String(parsed[k].pct);
                  map[`WPPSI.${abbr}.qualitative`] = qualitativeLabel(parsed[k].score);
                }
              }
              if (parsed.subtests) {
                for (const [abbr, data] of Object.entries(parsed.subtests)) {
                  if (!map[`WPPSI.${abbr}.scaled`]) {
                    map[`WPPSI.${abbr}.scaled`] = String(data.scaled);
                    map[`WPPSI.${abbr}.percentile`] = String(data.pct);
                  }
                }
              }
            }
          }
          // Also try subtest extraction even when deterministicExtract got indexes
          if (isWAIS && !map[`WAIS.SI.scaled`]) {
            const parsed = parseWAISScores(txt);
            if (parsed?.subtests) {
              for (const [abbr, data] of Object.entries(parsed.subtests)) {
                if (!map[`WAIS.${abbr}.scaled`]) {
                  map[`WAIS.${abbr}.scaled`] = String(data.scaled);
                  map[`WAIS.${abbr}.percentile`] = String(data.pct);
                }
              }
            }
          }
          if (isWPPSI && !map[`WPPSI.RV.scaled`]) {
            const parsed = parseWPPSIScores(txt);
            if (parsed?.subtests) {
              for (const [abbr, data] of Object.entries(parsed.subtests)) {
                if (!map[`WPPSI.${abbr}.scaled`]) {
                  map[`WPPSI.${abbr}.scaled`] = String(data.scaled);
                  map[`WPPSI.${abbr}.percentile`] = String(data.pct);
                }
              }
            }
          }
        } catch (e) { /* parse error */ }
      }

      // ── WIAT extraction ──
      if (/WIAT/i.test(txt)) {
        try {
          const sc = parseWIATScores(txt);
          for (const [rawKey, data] of Object.entries(sc)) {
            const tplKey = WIAT_KEY_MAP[rawKey];
            if (!tplKey || !data || data.ss == null) continue;
            map[`WIAT.${tplKey}.score`] = String(data.ss);
            if (data.percentile != null) map[`WIAT.${tplKey}.percentile`] = String(data.percentile);
            map[`WIAT.${tplKey}.qualitative`] = ssToRange(data.ss) || "";
          }
        } catch (e) { /* parse error */ }
      }

      // ── WRAML-3 extraction ──
      if (/WRAML/i.test(txt)) {
        try {
          const sc = parseWRAML3Scores(txt);
          // Indexes
          const ixMap = { GIM:"GIM", VIM:"VIM", VBM:"VBM", AC:"AC", GD:"GD", VD:"VD", VBD:"VBD", SM_IDX:"SM_IDX" };
          for (const [k, mk] of Object.entries(ixMap)) {
            if (!sc[k]) continue;
            map[`WRAML.${mk}.score`] = String(sc[k].score);
            map[`WRAML.${mk}.percentile`] = String(sc[k].pct);
            map[`WRAML.${mk}.qualitative`] = wraml3IndexRange(sc[k].score);
          }
          // Subtests (immediate)
          const ssMap = { PM:"PM", DL:"DL", SM:"SM", VL:"VL", FW:"FW", NL:"NL", SEM:"SEM", SR:"SR" };
          for (const [k, mk] of Object.entries(ssMap)) {
            if (!sc[k]) continue;
            map[`WRAML.${mk}.score`] = String(sc[k].ss);
            map[`WRAML.${mk}.percentile`] = String(WRAML3_SS_TO_PCT[sc[k].ss] ?? "");
            map[`WRAML.${mk}.qualitative`] = wraml3SSRange(sc[k].ss);
          }
          // Subtests (delayed)
          const dlMap = { PMD:"PMD", DLD:"DLD", SMD:"SMD", VLD:"VLD" };
          for (const [k, mk] of Object.entries(dlMap)) {
            if (!sc[k]) continue;
            map[`WRAML.${mk}.score`] = String(sc[k].ss);
            map[`WRAML.${mk}.percentile`] = String(WRAML3_SS_TO_PCT[sc[k].ss] ?? "");
            map[`WRAML.${mk}.qualitative`] = wraml3SSRange(sc[k].ss);
          }
        } catch (e) { /* parse error */ }
      }
    }
  } catch (e) { /* extraction failed */ }
  return map;
}

/**
 * Build placeholder tables with score cells filled from `scores` map (or "___" if absent).
 * Only tables whose block ID is in `tableBlockIds` are included.
 */
function buildBlankPlaceholderTablesHTML(firstName, tableBlockIds, scores, dataOnly) {
  const nm = firstName || "[firstName]";
  const ids = new Set(tableBlockIds || []);
  if (ids.size === 0) return null;
  const sc = scores || {};
  const parts = [];
  // has(): true if ANY of the given score keys have real data
  function has(...keys) { return keys.some((k) => !!sc[k]); }
  function v(key) { return sc[key] || "___"; }

  const th = 'style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:left;font-weight:bold;font-family:\'Times New Roman\',Times,serif"';
  const thC = 'style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:center;font-weight:bold;font-family:\'Times New Roman\',Times,serif"';
  const cap = 'style="font-weight:bold;font-size:12pt;padding:6px 10px;text-align:left;border:0.5pt solid #666;font-family:\'Times New Roman\',Times,serif"';
  const tbl = 'style="width:100%;border-collapse:collapse;margin:6pt 0 6pt 0;font-family:\'Times New Roman\',Times,serif;font-size:11pt;border:0.5pt solid #666"';

  function td(val, center) {
    const align = center ? "text-align:center;" : "";
    return `<td style="padding:3px 10px;border:0.5pt solid #999;${align}">${val}</td>`;
  }
  function tdBold(val, center) {
    const align = center ? "text-align:center;" : "";
    return `<td style="padding:3px 10px;border:0.5pt solid #999;font-weight:bold;${align}">${val}</td>`;
  }
  function rowBg(i) { return ''; }
  function compBg(i) { return `style="font-weight:bold;background:${i % 2 === 0 ? '#f0f0fa' : '#e8e8f0'}"`; }

  // Helper: build a table from rows. When dataOnly=true, skip rows without data and skip entire table if no data rows.
  // When dataOnly=false (default), include ALL rows with ___ placeholders.
  function buildTable(caption, headers, rowDefs) {
    const dataRows = [];
    let ri = 0;
    for (const rd of rowDefs) {
      if (dataOnly && !has(...rd.keys)) continue; // ← skip rows with no score data (only in dataOnly mode)
      dataRows.push(rd.render(ri));
      ri++;
    }
    if (dataRows.length === 0) return null; // ← skip entire table if no rows
    let h = `<table ${tbl}>\n<caption ${cap}>${caption}</caption>\n`;
    h += `<thead><tr>${headers}</tr></thead>\n<tbody>\n`;
    h += dataRows.join("");
    h += `</tbody></table>`;
    return h;
  }

  // ═══ WISC-V / WPPSI-IV / WAIS-IV ═══
  const cogId = ids.has("wisc-v") ? "wisc-v" : ids.has("wppsi-iv") ? "wppsi-iv" : ids.has("wais-iv") ? "wais-iv" : null;
  const cogName = cogId === "wppsi-iv" ? "WPPSI-IV" : cogId === "wais-iv" ? "WAIS-IV" : "WISC-V";
  const cogPrefix = cogId === "wais-iv" ? "WAIS" : "WISC";
  if (cogId) {
    const subtests = cogName === "WPPSI-IV"
      ? [["Information","IN"],["Similarities","SI"],["Vocabulary","VC"],["Comprehension","CO"],["Block Design","BD"],["Object Assembly","OA"],["Matrix Reasoning","MR"],["Picture Concepts","PC"],["Bug Search","BS"],["Cancellation","CA"],["Picture Memory","PM"],["Zoo Locations","ZL"]]
      : cogName === "WAIS-IV"
        ? [["Similarities","SI"],["Vocabulary","VC"],["Information","IN"],["Block Design","BD"],["Matrix Reasoning","MR"],["Visual Puzzles","VP"],["Digit Span","DS"],["Arithmetic","AR"],["Symbol Search","SS"],["Coding","CD"]]
        : [["Similarities","SI"],["Vocabulary","VC"],["Block Design","BD"],["Visual Puzzles","VP"],["Matrix Reasoning","MR"],["Figure Weights","FW"],["Digit Span","DS"],["Picture Span","PS"],["Coding","CD"],["Symbol Search","SS"],["Information","IN"],["Comprehension","CO"],["Arithmetic","AR"],["Letter-Number Sequencing","LN"],["Cancellation","CA"]];
    const subTbl = buildTable(`${cogName} Subtest Score Summary — ${nm}`,
      `<th ${th}>Subtest</th><th ${thC}>Scaled Score</th><th ${thC}>Percentile Rank</th>`,
      subtests.map(([name, abbr]) => ({
        keys: [`${cogPrefix}.${abbr}.scaled`, `${cogPrefix}.${abbr}.percentile`],
        render: (i) => `<tr ${rowBg(i)}>${td(name)}${td(v(`${cogPrefix}.${abbr}.scaled`), true)}${td(v(`${cogPrefix}.${abbr}.percentile`), true)}</tr>\n`,
      }))
    );
    if (subTbl) parts.push(subTbl);

    const composites = cogName === "WPPSI-IV"
      ? [["Verbal Comprehension Index","VCI"],["Visual Spatial Index","VSI"],["Fluid Reasoning Index","FRI"],["Working Memory Index","WMI"],["Processing Speed Index","PSI"],["Full Scale IQ","FSIQ"]]
      : cogName === "WAIS-IV"
        ? [["Verbal Comprehension Index","VCI"],["Perceptual Reasoning Index","PRI"],["Working Memory Index","WMI"],["Processing Speed Index","PSI"],["Full Scale IQ","FSIQ"],["General Ability Index","GAI"]]
        : [["Verbal Comprehension Index","VCI"],["Visual Spatial Index","VSI"],["Fluid Reasoning Index","FRI"],["Working Memory Index","WMI"],["Processing Speed Index","PSI"],["Full Scale IQ","FSIQ"]];
    const compTbl = buildTable(`${cogName} Composite Score Summary — ${nm}`,
      `<th ${th}>Composite</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th>`,
      composites.map(([name, abbr]) => ({
        keys: [`${cogPrefix}.${abbr}.score`, `${cogPrefix}.${abbr}.percentile`, `${cogPrefix}.${abbr}.qualitative`],
        render: (i) => `<tr ${compBg(i)}>${tdBold(`${name} (${abbr})`)}${tdBold(v(`${cogPrefix}.${abbr}.score`), true)}${tdBold(v(`${cogPrefix}.${abbr}.percentile`), true)}${tdBold(v(`${cogPrefix}.${abbr}.qualitative`), true)}</tr>\n`,
      }))
    );
    if (compTbl) parts.push(compTbl);

    if (cogName === "WISC-V") {
      const indexes = [["Nonverbal Index","NVI"],["General Ability Index","GAI"],["Cognitive Proficiency Index","CPI"],["Auditory Working Memory Index","AWMI"]];
      const idxTbl = buildTable(`WISC-V Ancillary Index Score Summary — ${nm}`,
        `<th ${th}>Index</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th>`,
        indexes.map(([name, abbr]) => ({
          keys: [`WISC.${abbr}.score`, `WISC.${abbr}.percentile`, `WISC.${abbr}.qualitative`],
          render: (i) => `<tr ${compBg(i)}>${tdBold(`${name} (${abbr})`)}${tdBold(v(`WISC.${abbr}.score`), true)}${tdBold(v(`WISC.${abbr}.percentile`), true)}${tdBold(v(`WISC.${abbr}.qualitative`), true)}</tr>\n`,
        }))
      );
      if (idxTbl) parts.push(idxTbl);
    }
  }

  // ═══ WIAT-III / WIAT-4 ═══
  if (ids.has("wiat-iii") || ids.has("wiat-4")) {
    const wiatName = ids.has("wiat-4") ? "WIAT-4" : "WIAT-III";
    const subtests = [
      ["Listening Comprehension","ListeningComprehension"],["Receptive Vocabulary","ReceptiveVocabulary"],["Oral Discourse Comprehension","OralDiscourseComprehension"],
      ["Word Reading","WordReading"],["Pseudoword Decoding","PseudowordDecoding"],["Oral Reading Fluency","OralReadingFluency"],["Reading Comprehension","ReadingComprehension"],
      ["Spelling","Spelling"],["Sentence Composition","SentenceComposition"],["Essay Composition","EssayComposition"],
      ["Math Problem Solving","MathProblemSolving"],["Numerical Operations","NumericalOperations"],
    ];
    const subTbl = buildTable(`${wiatName} Subtest Score Summary — ${nm}`,
      `<th ${th}>Subtest</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th>`,
      subtests.map(([name, key]) => ({
        keys: [`WIAT.${key}.score`, `WIAT.${key}.percentile`, `WIAT.${key}.qualitative`],
        render: (i) => `<tr ${rowBg(i)}>${td(name)}${td(v(`WIAT.${key}.score`), true)}${td(v(`WIAT.${key}.percentile`), true)}${td(v(`WIAT.${key}.qualitative`), true)}</tr>\n`,
      }))
    );
    if (subTbl) parts.push(subTbl);

    const composites = [
      ["Oral Language Composite","OralLanguageComposite"],["Total Reading","TotalReading"],["Basic Reading","BasicReading"],
      ["Reading Comprehension and Fluency","ReadingComprehensionFluency"],["Written Expression","WrittenExpression"],["Mathematics","Mathematics"],
    ];
    const compTbl = buildTable(`${wiatName} Composite Score Summary — ${nm}`,
      `<th ${th}>Composite</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th>`,
      composites.map(([name, key]) => ({
        keys: [`WIAT.${key}.score`, `WIAT.${key}.percentile`, `WIAT.${key}.qualitative`],
        render: (i) => `<tr ${compBg(i)}>${tdBold(name)}${tdBold(v(`WIAT.${key}.score`), true)}${tdBold(v(`WIAT.${key}.percentile`), true)}${tdBold(v(`WIAT.${key}.qualitative`), true)}</tr>\n`,
      }))
    );
    if (compTbl) parts.push(compTbl);
  }

  // ═══ WRAML-3 ═══
  if (ids.has("wraml-3")) {
    const rows = [
      { name: "General Immediate Memory Index", key: "GIM", type: "index" },
      { name: "  Verbal Immediate Memory Index", key: "VBM", type: "index" },
      { name: "    Story Memory", key: "SM", type: "sub" },
      { name: "    Verbal Learning", key: "VL", type: "sub" },
      { name: "  Visual Immediate Memory Index", key: "VIM", type: "index" },
      { name: "    Design Memory", key: "DL", type: "sub" },
      { name: "    Picture Memory", key: "PM", type: "sub" },
      { name: "  Attention/Concentration Index", key: "AC", type: "index" },
      { name: "    Finger Windows", key: "FW", type: "sub" },
      { name: "    Number-Letter", key: "NL", type: "sub" },
      { name: "General Delayed Index", key: "GD", type: "index" },
      { name: "  Verbal Delayed Index", key: "VBD", type: "index" },
      { name: "    Story Memory Delayed", key: "SMD", type: "sub" },
      { name: "    Verbal Learning Delayed", key: "VLD", type: "sub" },
      { name: "  Visual Delayed Index", key: "VD", type: "index" },
      { name: "    Design Memory Delayed", key: "DLD", type: "sub" },
      { name: "    Picture Memory Delayed", key: "PMD", type: "sub" },
    ];
    const wramlTbl = buildTable(`WRAML-3 Score Summary — ${nm}`,
      `<th ${th}>Scale / Subtest</th><th ${thC}>Standard / Scaled Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th>`,
      rows.map((r) => ({
        keys: [`WRAML.${r.key}.score`, `WRAML.${r.key}.percentile`, `WRAML.${r.key}.qualitative`],
        render: (i) => r.type === "index"
          ? `<tr ${compBg(i)}>${tdBold(r.name.trim())}${tdBold(v(`WRAML.${r.key}.score`), true)}${tdBold(v(`WRAML.${r.key}.percentile`), true)}${tdBold(v(`WRAML.${r.key}.qualitative`), true)}</tr>\n`
          : `<tr ${rowBg(i)}>${td(r.name)}${td(v(`WRAML.${r.key}.score`), true)}${td(v(`WRAML.${r.key}.percentile`), true)}${td(v(`WRAML.${r.key}.qualitative`), true)}</tr>\n`,
      }))
    );
    if (wramlTbl) parts.push(wramlTbl);
  }

  // ═══ Beery VMI ═══
  if (ids.has("beery-6")) {
    const rows = [["Visual-Motor Integration (VMI)","VMI.vmi"],["Visual Perception","VMI.vp"],["Motor Coordination","VMI.mc"]];
    const vmiTbl = buildTable(`Beery-Buktenica VMI-6 Score Summary — ${nm}`,
      `<th ${th}>Test</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Qualitative Description</th>`,
      rows.map(([name, key]) => ({
        keys: [`${key}.score`, `${key}.percentile`, `${key}.qualitative`],
        render: (i) => `<tr ${rowBg(i)}>${td(name)}${td(v(`${key}.score`), true)}${td(v(`${key}.percentile`), true)}${td(v(`${key}.qualitative`), true)}</tr>\n`,
      }))
    );
    if (vmiTbl) parts.push(vmiTbl);
  }

  // ═══ BASC-3 (one table per respondent form) ═══
  const bascForms = [];
  if (ids.has("basc-3-p")) bascForms.push(["Parent", "BASC3P"]);
  if (ids.has("basc-3-t")) bascForms.push(["Teacher", "BASC3T"]);
  if (ids.has("basc-3-s")) bascForms.push(["Self-Report", "BASC3S"]);
  for (const [resp, prefix] of bascForms) {
    const scales = [
      { name: "Externalizing Problems", key: "ExtProb", type: "comp" },
      { name: "  Hyperactivity", key: "Hyper", type: "sub" },
      { name: "  Aggression", key: "Aggr", type: "sub" },
      { name: "  Conduct Problems", key: "Conduct", type: "sub" },
      { name: "Internalizing Problems", key: "IntProb", type: "comp" },
      { name: "  Anxiety", key: "Anx", type: "sub" },
      { name: "  Depression", key: "Dep", type: "sub" },
      { name: "  Somatization", key: "Somat", type: "sub" },
      { name: "Behavioural Symptoms Index", key: "BSI", type: "comp" },
      { name: "  Atypicality", key: "Atyp", type: "sub" },
      { name: "  Withdrawal", key: "Withdr", type: "sub" },
      { name: "  Attention Problems", key: "AttnProb", type: "sub" },
      { name: "Adaptive Skills", key: "AdaptSkills", type: "comp" },
      { name: "  Adaptability", key: "Adapt", type: "sub" },
      { name: "  Social Skills", key: "Social", type: "sub" },
      { name: "  Leadership", key: "Leader", type: "sub" },
      { name: "  Activities of Daily Living", key: "ADL", type: "sub" },
      { name: "  Functional Communication", key: "FuncComm", type: "sub" },
    ];
    const bascTbl = buildTable(`BASC-3 ${resp} Rating Scale — ${nm}`,
      `<th ${th}>Scale</th><th ${thC}>T-Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th>`,
      scales.map((r) => ({
        keys: [`${prefix}.${r.key}.tscore`, `${prefix}.${r.key}.percentile`, `${prefix}.${r.key}.classification`],
        render: (i) => r.type === "comp"
          ? `<tr ${compBg(i)}>${tdBold(r.name.trim())}${tdBold(v(`${prefix}.${r.key}.tscore`), true)}${tdBold(v(`${prefix}.${r.key}.percentile`), true)}${tdBold(v(`${prefix}.${r.key}.classification`), true)}</tr>\n`
          : `<tr ${rowBg(i)}>${td(r.name)}${td(v(`${prefix}.${r.key}.tscore`), true)}${td(v(`${prefix}.${r.key}.percentile`), true)}${td(v(`${prefix}.${r.key}.classification`), true)}</tr>\n`,
      }))
    );
    if (bascTbl) parts.push(bascTbl);
  }

  // ═══ Conners 4 (one table per respondent form) ═══
  const connersForms = [];
  if (ids.has("conners-4-p")) connersForms.push(["Parent", "C4P"]);
  if (ids.has("conners-4-t")) connersForms.push(["Teacher", "C4T"]);
  for (const [resp, prefix] of connersForms) {
    const scales = [
      ["Inattention","Inatt"],["Hyperactivity/Impulsivity","HyperImp"],["Learning Problems","LearnProb"],
      ["Executive Functioning","ExecFunc"],["Defiance/Aggression","DefAggr"],["Peer Relations","PeerRel"],
      ["Conners 4 ADHD Index","ADHDIdx"],["DSM-5 ADHD Inattentive","DSM5Inatt"],["DSM-5 ADHD Hyperactive-Impulsive","DSM5Hyper"],
    ];
    const cTbl = buildTable(`Conners 4 — ${resp} Form — ${nm}`,
      `<th ${th}>Scale</th><th ${thC}>T-Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th>`,
      scales.map(([name, key]) => ({
        keys: [`${prefix}.${key}.tscore`, `${prefix}.${key}.percentile`, `${prefix}.${key}.classification`],
        render: (i) => `<tr ${rowBg(i)}>${td(name)}${td(v(`${prefix}.${key}.tscore`), true)}${td(v(`${prefix}.${key}.percentile`), true)}${td(v(`${prefix}.${key}.classification`), true)}</tr>\n`,
      }))
    );
    if (cTbl) parts.push(cTbl);
  }

  // ═══ Conners CBRS ═══
  if (ids.has("conners-cbrs-p")) {
    const scales = [
      ["Emotional Distress","EmotDist"],["Upsetting Thoughts/Physical Symptoms","UpsetPhys"],["Social Problems","SocProb"],
      ["Defiant/Aggressive Behaviours","DefAggr"],["Academic Difficulties","AcadDiff"],["Language","Lang"],
      ["Math","Math"],["Hyperactivity/Impulsivity","HyperImp"],["Separation Fears","SepFears"],["Perfectionistic and Compulsive Behaviours","PerfComp"],
      ["Violence Potential","ViolPot"],["Physical Symptoms","PhysSym"],
    ];
    const cbrsTbl = buildTable(`Conners CBRS — Parent Form — ${nm}`,
      `<th ${th}>Scale</th><th ${thC}>T-Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th>`,
      scales.map(([name, key]) => ({
        keys: [`CBRS.${key}.tscore`, `CBRS.${key}.percentile`, `CBRS.${key}.classification`],
        render: (i) => `<tr ${rowBg(i)}>${td(name)}${td(v(`CBRS.${key}.tscore`), true)}${td(v(`CBRS.${key}.percentile`), true)}${td(v(`CBRS.${key}.classification`), true)}</tr>\n`,
      }))
    );
    if (cbrsTbl) parts.push(cbrsTbl);
  }

  // ═══ Vineland-3 ═══
  if (ids.has("vineland-3")) {
    const rows = [
      { name: "Adaptive Behaviour Composite", key: "ABC", type: "comp" },
      { name: "Communication Domain", key: "Comm", type: "comp" },
      { name: "  Receptive", key: "Recept", type: "sub" },
      { name: "  Expressive", key: "Express", type: "sub" },
      { name: "  Written", key: "Written", type: "sub" },
      { name: "Daily Living Skills Domain", key: "DLS", type: "comp" },
      { name: "  Personal", key: "Personal", type: "sub" },
      { name: "  Domestic", key: "Domestic", type: "sub" },
      { name: "  Community", key: "Community", type: "sub" },
      { name: "Socialization Domain", key: "Soc", type: "comp" },
      { name: "  Interpersonal Relationships", key: "Interp", type: "sub" },
      { name: "  Play and Leisure Time", key: "PlayLeis", type: "sub" },
      { name: "  Coping Skills", key: "Coping", type: "sub" },
      { name: "Motor Skills Domain", key: "Motor", type: "comp" },
      { name: "  Gross Motor", key: "GrossMotor", type: "sub" },
      { name: "  Fine Motor", key: "FineMotor", type: "sub" },
    ];
    const vinTbl = buildTable(`Vineland-3 Adaptive Behavior Scales — ${nm}`,
      `<th ${th}>Domain / Subdomain</th><th ${thC}>Standard / v-Scale Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Adaptive Level</th>`,
      rows.map((r) => ({
        keys: [`VIN.${r.key}.score`, `VIN.${r.key}.percentile`, `VIN.${r.key}.qualitative`],
        render: (i) => r.type === "comp"
          ? `<tr ${compBg(i)}>${tdBold(r.name.trim())}${tdBold(v(`VIN.${r.key}.score`), true)}${tdBold(v(`VIN.${r.key}.percentile`), true)}${tdBold(v(`VIN.${r.key}.qualitative`), true)}</tr>\n`
          : `<tr ${rowBg(i)}>${td(r.name)}${td(v(`VIN.${r.key}.score`), true)}${td(v(`VIN.${r.key}.percentile`), true)}${td(v(`VIN.${r.key}.qualitative`), true)}</tr>\n`,
      }))
    );
    if (vinTbl) parts.push(vinTbl);
  }

  // ═══ Brown EF/A Scales ═══
  if (ids.has("brown-efa")) {
    const scales = [["Activation","Activation"],["Focus","Focus"],["Effort","Effort"],["Emotion","Emotion"],["Memory","Memory"],["Action","Action"],["Total Composite","Total"]];
    const brownTbl = buildTable(`Brown Executive Function/Attention Scales — ${nm}`,
      `<th ${th}>Cluster</th><th ${thC}>T-Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th>`,
      scales.map(([name, key]) => ({
        keys: [`BROWN.${key}.tscore`, `BROWN.${key}.percentile`, `BROWN.${key}.classification`],
        render: (i) => name === "Total Composite"
          ? `<tr ${compBg(i)}>${tdBold(name)}${tdBold(v(`BROWN.${key}.tscore`), true)}${tdBold(v(`BROWN.${key}.percentile`), true)}${tdBold(v(`BROWN.${key}.classification`), true)}</tr>\n`
          : `<tr ${rowBg(i)}>${td(name)}${td(v(`BROWN.${key}.tscore`), true)}${td(v(`BROWN.${key}.percentile`), true)}${td(v(`BROWN.${key}.classification`), true)}</tr>\n`,
      }))
    );
    if (brownTbl) parts.push(brownTbl);
  }

  // ═══ PHQ-9 ═══
  if (ids.has("phq-9")) {
    const t = buildTable(`Patient Health Questionnaire-9 (PHQ-9) — ${nm}`,
      `<th ${th}>Measure</th><th ${thC}>Score</th><th ${thC}>Severity</th>`,
      [{ keys: ["PHQ9.Total.score", "PHQ9.Total.severity"], render: (i) => `<tr ${rowBg(i)}>${td("PHQ-9 Total")}${td(v("PHQ9.Total.score"), true)}${td(v("PHQ9.Total.severity"), true)}</tr>\n` }]
    );
    if (t) parts.push(t);
  }

  // ═══ GAD-7 ═══
  if (ids.has("gad-7")) {
    const t = buildTable(`Generalized Anxiety Disorder-7 (GAD-7) — ${nm}`,
      `<th ${th}>Measure</th><th ${thC}>Score</th><th ${thC}>Severity</th>`,
      [{ keys: ["GAD7.Total.score", "GAD7.Total.severity"], render: (i) => `<tr ${rowBg(i)}>${td("GAD-7 Total")}${td(v("GAD7.Total.score"), true)}${td(v("GAD7.Total.severity"), true)}</tr>\n` }]
    );
    if (t) parts.push(t);
  }

  // ═══ BAI ═══
  if (ids.has("bai")) {
    const t = buildTable(`Beck Anxiety Inventory (BAI) — ${nm}`,
      `<th ${th}>Measure</th><th ${thC}>Score</th><th ${thC}>Severity</th>`,
      [{ keys: ["BAI.Total.score", "BAI.Total.severity"], render: (i) => `<tr ${rowBg(i)}>${td("BAI Total")}${td(v("BAI.Total.score"), true)}${td(v("BAI.Total.severity"), true)}</tr>\n` }]
    );
    if (t) parts.push(t);
  }

  // ═══ BDI-2 ═══
  if (ids.has("bdi-2")) {
    const t = buildTable(`Beck Depression Inventory-II (BDI-2) — ${nm}`,
      `<th ${th}>Measure</th><th ${thC}>Score</th><th ${thC}>Severity</th>`,
      [{ keys: ["BDI2.Total.score", "BDI2.Total.severity"], render: (i) => `<tr ${rowBg(i)}>${td("BDI-II Total")}${td(v("BDI2.Total.score"), true)}${td(v("BDI2.Total.severity"), true)}</tr>\n` }]
    );
    if (t) parts.push(t);
  }

  // ═══ ASRS ═══
  if (ids.has("asrs")) {
    const scales = [["Total Score","Total"],["DSM-5 Scale","DSM5"],["Social/Communication","SocComm"],["Unusual Behaviours","Unusual"],["Self-Regulation","SelfReg"],["Peer Socialization","PeerSoc"],["Adult Socialization","AdultSoc"]];
    const asrsTbl = buildTable(`Autism Spectrum Rating Scale (ASRS) — ${nm}`,
      `<th ${th}>Scale</th><th ${thC}>T-Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th>`,
      scales.map(([name, key]) => ({
        keys: [`ASRS.${key}.tscore`, `ASRS.${key}.percentile`, `ASRS.${key}.classification`],
        render: (i) => `<tr ${rowBg(i)}>${td(name)}${td(v(`ASRS.${key}.tscore`), true)}${td(v(`ASRS.${key}.percentile`), true)}${td(v(`ASRS.${key}.classification`), true)}</tr>\n`,
      }))
    );
    if (asrsTbl) parts.push(asrsTbl);
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Build the 3 MANDATORY appendix tables (cognitive subtest, cognitive index, WIAT-III)
 * Automatically selects WISC-V or WAIS-IV tables based on cogTest parameter.
 * with a fixed structure that is NEVER modified. Missing values use "—".
 * This function always returns HTML — it never returns null.
 */
function buildMandatoryAppendixTablesHTML(firstName, scores, cogTest) {
  const nm = firstName || "[firstName]";
  const sc = scores || {};
  const isWAIS = cogTest === "wais-iv";
  const isWPPSI = cogTest === "wppsi-iv";
  function v(key) { return sc[key] || "\u2014"; }

  const th = 'style="padding:3px 10px;border:0.5pt solid #666;font-size:11pt;text-align:left;font-weight:bold;font-family:\'Times New Roman\',Times,serif;line-height:1.0;margin:0"';
  const thC = 'style="padding:3px 10px;border:0.5pt solid #666;font-size:11pt;text-align:center;font-weight:bold;font-family:\'Times New Roman\',Times,serif;line-height:1.0;margin:0"';
  const cap = 'style="font-weight:bold;font-size:12pt;padding:6px 10px;text-align:left;border:0.5pt solid #666;font-family:\'Times New Roman\',Times,serif;margin:0"';
  const tbl = 'style="width:100%;border-collapse:collapse;margin:6pt 0 6pt 0;font-family:\'Times New Roman\',Times,serif;font-size:11pt;border:0.5pt solid #666;line-height:1.0"';

  function td(val, center) {
    const align = center ? "text-align:center;" : "";
    return `<td style="padding:3px 10px;border:0.5pt solid #999;${align}line-height:1.0;margin:0">${val}</td>`;
  }
  function tdBold(val, center) {
    const align = center ? "text-align:center;" : "";
    return `<td style="padding:3px 10px;border:0.5pt solid #999;font-weight:bold;${align}line-height:1.0;margin:0">${val}</td>`;
  }
  function rowBg(i) { return ''; }
  function compBg(i) { return 'style="font-weight:bold"'; }

  // Derive classification from scaled score (only if score exists in map)
  function classifyScaled(ssKey) {
    const raw = sc[ssKey];
    if (!raw) return "\u2014";
    const n = parseInt(raw, 10);
    if (isNaN(n)) return "\u2014";
    if (n >= 16) return "Very High";
    if (n >= 13) return "High Average";
    if (n >= 8) return "Average";
    if (n >= 6) return "Low Average";
    if (n >= 4) return "Low";
    return "Very Low";
  }

  // Derive classification from standard score (only if score exists in map)
  function classifyStandard(ssKey) {
    const raw = sc[ssKey];
    if (!raw) return "\u2014";
    const n = parseInt(raw, 10);
    if (isNaN(n)) return "\u2014";
    if (n >= 130) return "Very Superior";
    if (n >= 120) return "Superior";
    if (n >= 110) return "High Average";
    if (n >= 90) return "Average";
    if (n >= 80) return "Low Average";
    if (n >= 70) return "Low";
    return "Very Low";
  }

  const parts = [];

  if (isWAIS) {
    // ── TABLE 1: WAIS-IV Subtest Score Summary ──
    const waisCoreSubtests = [
      ["Similarities", "SI"],
      ["Vocabulary", "VC"],
      ["Information", "IN"],
      ["Block Design", "BD"],
      ["Matrix Reasoning", "MR"],
      ["Visual Puzzles", "VP"],
      ["Digit Span", "DS"],
      ["Arithmetic", "AR"],
      ["Symbol Search", "SS"],
      ["Coding", "CD"],
    ];
    const waisSupplementalSubtests = [
      ["Comprehension", "CO"],
      ["Figure Weights", "FW"],
      ["Picture Completion", "PC"],
      ["Letter-Number Sequencing", "LN"],
      ["Cancellation", "CA"],
    ].filter(([, abbr]) => sc[`WAIS.${abbr}.scaled`]);
    const waisSubtests = [...waisCoreSubtests, ...waisSupplementalSubtests];
    let t1 = `<table ${tbl}>\n<caption ${cap}>Table 1. WAIS-IV Subtest Score Summary</caption>\n`;
    t1 += `<thead><tr><th ${th}>Subtest</th><th ${thC}>Scaled Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
    waisSubtests.forEach(([name, abbr], i) => {
      const scaledKey = `WAIS.${abbr}.scaled`;
      const pctKey = `WAIS.${abbr}.percentile`;
      const qualKey = `WAIS.${abbr}.qualitative`;
      const classification = sc[qualKey] || classifyScaled(scaledKey);
      t1 += `<tr ${rowBg(i)}>${td(name)}${td(v(scaledKey), true)}${td(v(pctKey), true)}${td(classification, true)}</tr>\n`;
    });
    t1 += `</tbody></table>`;
    parts.push(t1);

    // ── TABLE 2: WAIS-IV Index Score Summary ──
    const waisIndexes = [
      ["Verbal Comprehension Index (VCI)", "VCI"],
      ["Perceptual Reasoning Index (PRI)", "PRI"],
      ["Working Memory Index (WMI)", "WMI"],
      ["Processing Speed Index (PSI)", "PSI"],
      ["Full Scale IQ (FSIQ)", "FSIQ"],
      ["General Ability Index (GAI)", "GAI"],
      ["Cognitive Proficiency Index (CPI)", "CPI"],
    ].filter(([, abbr]) => sc[`WAIS.${abbr}.score`]);
    let t2 = `<table ${tbl}>\n<caption ${cap}>Table 2. WAIS-IV Index Score Summary</caption>\n`;
    t2 += `<thead><tr><th ${th}>Index</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
    waisIndexes.forEach(([name, abbr], i) => {
      const scoreKey = `WAIS.${abbr}.score`;
      const pctKey = `WAIS.${abbr}.percentile`;
      const qualKey = `WAIS.${abbr}.qualitative`;
      const classification = sc[qualKey] || classifyStandard(scoreKey);
      t2 += `<tr ${compBg(i)}>${tdBold(name)}${tdBold(v(scoreKey), true)}${tdBold(v(pctKey), true)}${tdBold(classification, true)}</tr>\n`;
    });
    t2 += `</tbody></table>`;
    parts.push(t2);

  } else if (isWPPSI) {
    // ── TABLE 1: WPPSI-IV Subtest Score Summary ──
    const wppsiSubtests = [
      ["Information", "IN"],
      ["Similarities", "SI"],
      ["Vocabulary", "VC"],
      ["Comprehension", "CO"],
      ["Receptive Vocabulary", "RV"],
      ["Picture Naming", "PN"],
      ["Block Design", "BD"],
      ["Object Assembly", "OA"],
      ["Matrix Reasoning", "MR"],
      ["Picture Concepts", "PC"],
      ["Picture Memory", "PM"],
      ["Zoo Locations", "ZL"],
      ["Bug Search", "BS"],
      ["Cancellation", "CA"],
      ["Animal Coding", "AC"],
    ].filter(([, abbr]) => sc[`WPPSI.${abbr}.scaled`]);
    let t1 = `<table ${tbl}>\n<caption ${cap}>Table 1. WPPSI-IV Subtest Score Summary</caption>\n`;
    t1 += `<thead><tr><th ${th}>Subtest</th><th ${thC}>Scaled Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
    wppsiSubtests.forEach(([name, abbr], i) => {
      const scaledKey = `WPPSI.${abbr}.scaled`;
      const pctKey = `WPPSI.${abbr}.percentile`;
      const qualKey = `WPPSI.${abbr}.qualitative`;
      const classification = sc[qualKey] || classifyScaled(scaledKey);
      t1 += `<tr ${rowBg(i)}>${td(name)}${td(v(scaledKey), true)}${td(v(pctKey), true)}${td(classification, true)}</tr>\n`;
    });
    t1 += `</tbody></table>`;
    parts.push(t1);

    // ── TABLE 2: WPPSI-IV Index Score Summary ──
    const wppsiIndexes = [
      ["Verbal Comprehension Index (VCI)", "VCI"],
      ["Visual Spatial Index (VSI)", "VSI"],
      ["Fluid Reasoning Index (FRI)", "FRI"],
      ["Working Memory Index (WMI)", "WMI"],
      ["Processing Speed Index (PSI)", "PSI"],
      ["Full Scale IQ (FSIQ)", "FSIQ"],
      ["General Ability Index (GAI)", "GAI"],
      ["Cognitive Proficiency Index (CPI)", "CPI"],
      ["Nonverbal Index (NVI)", "NVI"],
      ["Vocabulary Acquisition Index (VAI)", "VAI"],
    ].filter(([, abbr]) => sc[`WPPSI.${abbr}.score`]);
    let t2 = `<table ${tbl}>\n<caption ${cap}>Table 2. WPPSI-IV Index Score Summary</caption>\n`;
    t2 += `<thead><tr><th ${th}>Index</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
    wppsiIndexes.forEach(([name, abbr], i) => {
      const scoreKey = `WPPSI.${abbr}.score`;
      const pctKey = `WPPSI.${abbr}.percentile`;
      const qualKey = `WPPSI.${abbr}.qualitative`;
      const classification = sc[qualKey] || classifyStandard(scoreKey);
      t2 += `<tr ${compBg(i)}>${tdBold(name)}${tdBold(v(scoreKey), true)}${tdBold(v(pctKey), true)}${tdBold(classification, true)}</tr>\n`;
    });
    t2 += `</tbody></table>`;
    parts.push(t2);

  } else {
    const wiscSubtests = [
      ["Similarities", "SI"],
      ["Vocabulary", "VC"],
      ["Information", "IN"],
      ["Comprehension", "CO"],
      ["Block Design", "BD"],
      ["Visual Puzzles", "VP"],
      ["Matrix Reasoning", "MR"],
      ["Figure Weights", "FW"],
      ["Picture Span", "PS"],
      ["Digit Span", "DS"],
      ["Letter-Number Sequencing", "LN"],
      ["Arithmetic", "AR"],
      ["Coding", "CD"],
      ["Symbol Search", "SS"],
      ["Cancellation", "CA"],
      ["Naming Speed Literacy", "NSL"],
      ["Naming Speed Quantity", "NSQ"],
    ].filter(([, abbr]) => sc[`WISC.${abbr}.scaled`]);
    let t1 = `<table ${tbl}>\n<caption ${cap}>Table 1. WISC-V Subtest Score Summary</caption>\n`;
    t1 += `<thead><tr><th ${th}>Subtest</th><th ${thC}>Scaled Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
    wiscSubtests.forEach(([name, abbr], i) => {
      const scaledKey = `WISC.${abbr}.scaled`;
      const pctKey = `WISC.${abbr}.percentile`;
      const qualKey = `WISC.${abbr}.qualitative`;
      const classification = sc[qualKey] || classifyScaled(scaledKey);
      t1 += `<tr ${rowBg(i)}>${td(name)}${td(v(scaledKey), true)}${td(v(pctKey), true)}${td(classification, true)}</tr>\n`;
    });
    t1 += `</tbody></table>`;
    parts.push(t1);

    // ── TABLE 2: WISC-V Index Score Summary ──
    const wiscIndexes = [
      ["Verbal Comprehension Index (VCI)", "VCI"],
      ["Visual Spatial Index (VSI)", "VSI"],
      ["Fluid Reasoning Index (FRI)", "FRI"],
      ["Working Memory Index (WMI)", "WMI"],
      ["Processing Speed Index (PSI)", "PSI"],
      ["Full Scale IQ (FSIQ)", "FSIQ"],
      ["General Ability Index (GAI)", "GAI"],
      ["Cognitive Proficiency Index (CPI)", "CPI"],
      ["Nonverbal Index (NVI)", "NVI"],
      ["Quantitative Reasoning Index (QRI)", "QRI"],
      ["Auditory Working Memory Index (AWMI)", "AWMI"],
      ["Naming Speed Index (NSI)", "NSI"],
      ["Symbol Translation Index (STI)", "STI"],
      ["Storage and Retrieval Index (SRI)", "SRI"],
    ].filter(([, abbr]) => sc[`WISC.${abbr}.score`]);
    let t2 = `<table ${tbl}>\n<caption ${cap}>Table 2. WISC-V Index Score Summary</caption>\n`;
    t2 += `<thead><tr><th ${th}>Index</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
    wiscIndexes.forEach(([name, abbr], i) => {
      const scoreKey = `WISC.${abbr}.score`;
      const pctKey = `WISC.${abbr}.percentile`;
      const qualKey = `WISC.${abbr}.qualitative`;
      const classification = sc[qualKey] || classifyStandard(scoreKey);
      t2 += `<tr ${compBg(i)}>${tdBold(name)}${tdBold(v(scoreKey), true)}${tdBold(v(pctKey), true)}${tdBold(classification, true)}</tr>\n`;
    });
    t2 += `</tbody></table>`;
    parts.push(t2);
  }

  // ── TABLE 3: WIAT-III Subtest Score Summary (always shown) ──
  const wiatSubtests = [
    ["Listening Comprehension", "ListeningComprehension"],
    ["Receptive Vocabulary", "ReceptiveVocabulary"],
    ["Oral Discourse Comprehension", "OralDiscourseComprehension"],
    ["Word Reading", "WordReading"],
    ["Pseudoword Decoding", "PseudowordDecoding"],
    ["Reading Comprehension", "ReadingComprehension"],
    ["Oral Reading Fluency", "OralReadingFluency"],
    ["Spelling", "Spelling"],
    ["Sentence Composition", "SentenceComposition"],
    ["Essay Composition", "EssayComposition"],
    ["Numerical Operations", "NumericalOperations"],
    ["Math Problem Solving", "MathProblemSolving"],
  ];
  let t3 = `<table ${tbl}>\n<caption ${cap}>Table 3. WIAT-III Subtest Score Summary</caption>\n`;
  t3 += `<thead><tr><th ${th}>Subtest</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
  wiatSubtests.forEach(([name, key], i) => {
    const scoreKey = `WIAT.${key}.score`;
    const pctKey = `WIAT.${key}.percentile`;
    const qualKey = `WIAT.${key}.qualitative`;
    const classification = sc[qualKey] || classifyStandard(scoreKey);
    t3 += `<tr ${rowBg(i)}>${td(name)}${td(v(scoreKey), true)}${td(v(pctKey), true)}${td(classification, true)}</tr>\n`;
  });
  t3 += `</tbody></table>`;
  parts.push(t3);

  // ── TABLE 4: WIAT-III Composite Score Summary (always shown) ──
  const wiatComposites = [
    ["Oral Language Composite", "OralLanguageComposite"],
    ["Total Reading", "TotalReading"],
    ["Basic Reading", "BasicReading"],
    ["Reading Comprehension & Fluency", "ReadingComprehensionFluency"],
    ["Written Expression", "WrittenExpression"],
    ["Mathematics", "Mathematics"],
    ["Total Achievement", "TotalAchievement"],
  ];
  let t4 = `<table ${tbl}>\n<caption ${cap}>Table 4. WIAT-III Composite Score Summary</caption>\n`;
  t4 += `<thead><tr><th ${th}>Composite</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
  wiatComposites.forEach(([name, key], i) => {
    const scoreKey = `WIAT.${key}.score`;
    const pctKey = `WIAT.${key}.percentile`;
    const qualKey = `WIAT.${key}.qualitative`;
    const classification = sc[qualKey] || classifyStandard(scoreKey);
    t4 += `<tr ${compBg(i)}>${tdBold(name)}${tdBold(v(scoreKey), true)}${tdBold(v(pctKey), true)}${tdBold(classification, true)}</tr>\n`;
  });
  t4 += `</tbody></table>`;
  parts.push(t4);

  // ── TABLE 5: WRAML-3 Subtest Score Summary (shown if WRAML scores exist) ──
  const hasWraml = Object.keys(sc).some(k => k.startsWith("WRAML."));
  if (hasWraml) {
    const wramlSubtests = [
      ["Story Memory", "SM"],
      ["Verbal Learning", "VL"],
      ["Design Learning", "DL"],
      ["Picture Memory", "PM"],
      ["Finger Windows", "FW"],
      ["Number Letter", "NL"],
      ["Sentence Memory", "SEM"],
      ["Sentence Recall", "SR"],
      ["Story Memory Delayed", "SMD"],
      ["Verbal Learning Delayed", "VLD"],
      ["Design Learning Delayed", "DLD"],
      ["Picture Memory Delayed", "PMD"],
    ].filter(([, key]) => sc[`WRAML.${key}.score`]);
    let t5 = `<table ${tbl}>\n<caption ${cap}>Table 5. WRAML-3 Subtest Score Summary</caption>\n`;
    t5 += `<thead><tr><th ${th}>Subtest</th><th ${thC}>Scaled Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
    wramlSubtests.forEach(([name, key], i) => {
      const scoreKey = `WRAML.${key}.score`;
      const pctKey = `WRAML.${key}.percentile`;
      const qualKey = `WRAML.${key}.qualitative`;
      const classification = sc[qualKey] || "___";
      t5 += `<tr ${rowBg(i)}>${td(name)}${td(v(scoreKey), true)}${td(v(pctKey), true)}${td(classification, true)}</tr>\n`;
    });
    t5 += `</tbody></table>`;
    parts.push(t5);

    // ── TABLE 6: WRAML-3 Index Score Summary ──
    const wramlIndexes = [
      ["General Immediate Memory (GIM)", "GIM"],
      ["Verbal Immediate Memory (VBM)", "VBM"],
      ["Visual Immediate Memory (VIM)", "VIM"],
      ["Attention/Concentration (AC)", "AC"],
      ["General Delayed Memory (GD)", "GD"],
      ["Verbal Delayed Memory (VBD)", "VBD"],
      ["Visual Delayed Memory (VD)", "VD"],
      ["Screener Memory (SM_IDX)", "SM_IDX"],
    ].filter(([, key]) => sc[`WRAML.${key}.score`]);
    let t6 = `<table ${tbl}>\n<caption ${cap}>Table 6. WRAML-3 Index Score Summary</caption>\n`;
    t6 += `<thead><tr><th ${th}>Index</th><th ${thC}>Standard Score</th><th ${thC}>Percentile Rank</th><th ${thC}>Classification</th></tr></thead>\n<tbody>\n`;
    wramlIndexes.forEach(([name, key], i) => {
      const scoreKey = `WRAML.${key}.score`;
      const pctKey = `WRAML.${key}.percentile`;
      const qualKey = `WRAML.${key}.qualitative`;
      const classification = sc[qualKey] || "___";
      t6 += `<tr ${compBg(i)}>${tdBold(name)}${tdBold(v(scoreKey), true)}${tdBold(v(pctKey), true)}${tdBold(classification, true)}</tr>\n`;
    });
    t6 += `</tbody></table>`;
    parts.push(t6);
  }

  return parts.join("\n");
}

/** Legacy compat: extractCognitiveScoreTable — returns formatted string for AI context. */
function extractCognitiveScoreTable(docs) {
  if (!docs || docs.length === 0) return null;
  try {
    for (const d of docs) {
      const txt = d.extractedText || "";
      if (!txt || txt.length < 100) continue;
      if (!/WISC|WPPSI|WAIS/i.test(txt)) continue;
      const result = deterministicExtract(txt, d._docxTables || null, d._pdfPages || null);
      const t = result.appendix_tables;
      const lines = [];
      if (t.subtests) {
        for (const s of t.subtests) lines.push(`${s.name}: Scaled Score=${s.scaledScore}, Percentile=${s.percentile ?? "N/A"}`);
      }
      if (t.composites) {
        for (const s of t.composites) lines.push(`${s.full} (${s.abbrev}): Standard Score=${s.standardScore}, Percentile=${s.percentile ?? "N/A"}`);
      }
      if (t.indexes) {
        for (const s of t.indexes) lines.push(`${s.full} (${s.abbrev}): Standard Score=${s.standardScore}, Percentile=${s.percentile ?? "N/A"}`);
      }
      if (lines.length > 0) return "=== WISC/COGNITIVE SCORE TABLE (extracted from PDF) ===\n" + lines.join("\n");
    }
  } catch (e) { /* extraction failed */ }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// END DETERMINISTIC EXTRACTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

// MEMORY SECTION: Template fill from WRAML3 Score Report
const WRAML3_SS_TO_PCT = {1:0.1,2:0.4,3:1,4:2,5:5,6:9,7:16,8:25,9:37,10:50,11:63,12:75,13:84,14:91,15:95,16:98,17:99.6,18:99.9,19:99.9};

function wraml3IndexRange(s) {
  if (s >= 130) return "Extremely High";
  if (s >= 120) return "Very High";
  if (s >= 110) return "High Average";
  if (s >= 90) return "Average";
  if (s >= 80) return "Low Average";
  if (s >= 70) return "Low";
  return "Very Low";
}
function wraml3SSRange(ss) {
  if (ss >= 16) return "Very High";
  if (ss >= 13) return "High Average";
  if (ss >= 8) return "Average";
  if (ss >= 6) return "Low Average";
  if (ss >= 4) return "Low";
  return "Very Low";
}
function ordinalPct(n) {
  if (n == null) return "___";
  const s = String(n);
  if (s.includes(".")) {
    const last = s.charAt(s.length - 1);
    if (last === "1") return s + "st";
    if (last === "2") return s + "nd";
    if (last === "3") return s + "rd";
    return s + "th";
  }
  const num = parseInt(s);
  const lastTwo = num % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return s + "th";
  const ld = num % 10;
  if (ld === 1) return s + "st";
  if (ld === 2) return s + "nd";
  if (ld === 3) return s + "rd";
  return s + "th";
}

function parseWRAML3Scores(txt) {
  const sc = {};
  const ixPats = [
    ["GIM", /General Immediate Memory\s+(\d+)\s+(\d+)\s+\d+\s*-\s*\d+\s+(\d+)/],
    ["VIM", /Visual Immediate Memory\s+(\d+)\s+(\d+)\s+\d+\s*-\s*\d+\s+(\d+)/],
    ["VBM", /Verbal Immediate Memory\s+(\d+)\s+(\d+)\s+\d+\s*-\s*\d+\s+(\d+)/],
    ["AC",  /Attention\/Concentration\s+(\d+)\s+(\d+)\s+\d+\s*-\s*\d+\s+(\d+)/],
    ["SM_IDX", /Screener Memory\s+(\d+)\s+(\d+)\s+\d+\s*-\s*\d+\s+(\d+)/],
    ["GD",  /General Delayed\s+(\d+)\s+(\d+)\s+\d+\s*-\s*\d+\s+(\d+)/],
    ["VD",  /Visual Delayed\s+(\d+)\s+(\d+)\s+\d+\s*-\s*\d+\s+(\d+)/],
    ["VBD", /Verbal Delayed\s+(\d+)\s+(\d+)\s+\d+\s*-\s*\d+\s+(\d+)/],
  ];
  for (const [k, p] of ixPats) { const m = txt.match(p); if (m) sc[k] = { score: +m[2], pct: +m[3] }; }
  const ssPats = [
    ["PM", /Picture Memory(?!\s+(?:Delayed|Recognition))\s+(\d+)\s+(\d+)/],
    ["DL", /Design Learning(?!\s+(?:Delayed|Recognition))\s+(\d+)\s+(\d+)/],
    ["SM", /Story Memory(?!\s+(?:Delayed|Recognition))\s+(\d+)\s+(\d+)/],
    ["VL", /Verbal Learning(?!\s+(?:Delayed|Recognition))\s+(\d+)\s+(\d+)/],
    ["FW", /Finger Windows\s+(\d+)\s+(\d+)/],
    ["NL", /Number Letter\s+(\d+)\s+(\d+)/],
    ["SEM", /Sentence Memory\s+(\d+)\s+(\d+)/],
    ["SR", /Sentence Recall\s+(\d+)\s+(\d+)/],
  ];
  for (const [k, p] of ssPats) { const m = txt.match(p); if (m) sc[k] = { raw: +m[1], ss: +m[2] }; }
  const dlPats = [
    ["PMD", /Picture Memory Delayed\s+(\d+)\s+(\d+)/],
    ["DLD", /Design Learning Delayed\s+(\d+)\s+(\d+)/],
    ["SMD", /Story Memory Delayed\s+(\d+)\s+(\d+)/],
    ["VLD", /Verbal Learning Delayed\s+(\d+)\s+(\d+)/],
  ];
  for (const [k, p] of dlPats) { const m = txt.match(p); if (m) sc[k] = { raw: +m[1], ss: +m[2] }; }
  return sc;
}

// ── WAIS-IV Score Parser ──
// Extracts FSIQ, VCI, PRI, WMI, PSI from WAIS-IV score report PDF text
function parseWAISScores(txt) {
  if (!txt || txt.length < 50) return null;
  const sc = {};
  // Pattern pairs: [key, indexName regex, abbreviation regex]
  const indexes = [
    ["fsiq", /Full\s*Scale(?:\s*IQ)?/i, /FSIQ/],
    ["vci",  /Verbal\s*Comprehension(?:\s*Index)?/i, /VCI/],
    ["pri",  /Perceptual\s*Reasoning(?:\s*Index)?/i, /PRI/],
    ["wmi",  /Working\s*Memory(?:\s*Index)?/i, /WMI/],
    ["psi",  /Processing\s*Speed(?:\s*Index)?/i, /PSI/],
    ["gai",  /General\s*Ability(?:\s*Index)?/i, /GAI/],
    ["cpi",  /Cognitive\s*Proficiency(?:\s*Index)?/i, /CPI/],
  ];
  for (const [key, namePat, abbrPat] of indexes) {
    const patterns = [
      new RegExp(namePat.source + "\\s+(?:Index\\s+)?(?:\\d+\\s+)?(\\d{2,3})\\s+(\\d{1,3})", namePat.flags),
      new RegExp(abbrPat.source + "\\s+(?:\\d+\\s+)?(\\d{2,3})\\s+(\\d{1,3})", abbrPat.flags),
      new RegExp(abbrPat.source + "\\s+\\d+\\s+(\\d{2,3})\\s+(\\d{1,3})\\s+\\d+", abbrPat.flags),
    ];
    for (const p of patterns) {
      const m = txt.match(p);
      if (m) {
        const score = +m[1];
        const pct = +m[2];
        if (score >= 40 && score <= 160 && pct >= 0 && pct <= 100) {
          sc[key] = { score, pct };
          break;
        }
      }
    }
  }
  // ── Subtest extraction (scaled scores 1-19, percentiles 0-99) ──
  const subtests = [
    ["SI", /Similarities/i],
    ["VC", /Vocabulary/i],
    ["IN", /Information/i],
    ["BD", /Block\s*Design/i],
    ["MR", /Matrix\s*Reasoning/i],
    ["VP", /Visual\s*Puzzles/i],
    ["DS", /Digit\s*Span/i],
    ["AR", /Arithmetic/i],
    ["SS", /Symbol\s*Search/i],
    ["CD", /Coding/i],
    ["CO", /(?<!Oral\s+Discourse\s+)Comprehension(?!\s+(?:and|&)\s+Fluency)/i],
    ["FW", /Figure\s*Weights/i],
    ["LN", /Letter[\s-]*Number\s*Sequencing/i],
    ["CA", /Cancellation/i],
    ["PC", /Picture\s*Completion/i],
  ];
  sc.subtests = {};
  for (const [abbr, namePat] of subtests) {
    // Try: "SubtestName  scaledScore  percentile"
    const patterns = [
      new RegExp(namePat.source + "\\s+(\\d{1,2})\\s+(\\d{1,3})", namePat.flags),
      // Table: "SubtestName  rawScore  scaledScore  percentile"
      new RegExp(namePat.source + "\\s+\\d+\\s+(\\d{1,2})\\s+(\\d{1,3})", namePat.flags),
    ];
    for (const p of patterns) {
      const m = txt.match(p);
      if (m) {
        const scaled = +m[1];
        const pct = +m[2];
        if (scaled >= 1 && scaled <= 19 && pct >= 0 && pct <= 99) {
          sc.subtests[abbr] = { scaled, pct };
          break;
        }
      }
    }
  }
  // Need at least FSIQ + 2 indexes to be valid
  const keys = Object.keys(sc).filter(k => k !== "subtests");
  if (!sc.fsiq || keys.length < 3) return null;
  return sc;
}

// ── WPPSI-IV Score Parser ──
// Extracts FSIQ, VCI, VSI, FRI, WMI, PSI from WPPSI-IV score report PDF text
function parseWPPSIScores(txt) {
  if (!txt || txt.length < 50) return null;
  const sc = {};
  const indexes = [
    ["fsiq", /Full\s*Scale(?:\s*IQ)?/i, /FSIQ/],
    ["vci",  /Verbal\s*Comprehension(?:\s*Index)?/i, /VCI/],
    ["vsi",  /Visual\s*Spatial(?:\s*Index)?/i, /VSI/],
    ["fri",  /Fluid\s*Reasoning(?:\s*Index)?/i, /FRI/],
    ["wmi",  /Working\s*Memory(?:\s*Index)?/i, /WMI/],
    ["psi",  /Processing\s*Speed(?:\s*Index)?/i, /PSI/],
    ["gai",  /General\s*Ability(?:\s*Index)?/i, /GAI/],
    ["cpi",  /Cognitive\s*Proficiency(?:\s*Index)?/i, /CPI/],
    ["nvi",  /Nonverbal(?:\s*Index)?/i, /NVI/],
    ["vai",  /Vocabulary\s*Acquisition(?:\s*Index)?/i, /VAI/],
  ];
  for (const [key, namePat, abbrPat] of indexes) {
    const patterns = [
      new RegExp(namePat.source + "\\s+(?:Index\\s+)?(?:\\d+\\s+)?(\\d{2,3})\\s+(\\d{1,3})", namePat.flags),
      new RegExp(abbrPat.source + "\\s+(?:\\d+\\s+)?(\\d{2,3})\\s+(\\d{1,3})", abbrPat.flags),
      new RegExp(abbrPat.source + "\\s+\\d+\\s+(\\d{2,3})\\s+(\\d{1,3})\\s+\\d+", abbrPat.flags),
    ];
    for (const p of patterns) {
      const m = txt.match(p);
      if (m) {
        const score = +m[1];
        const pct = +m[2];
        if (score >= 40 && score <= 160 && pct >= 0 && pct <= 100) {
          sc[key] = { score, pct };
          break;
        }
      }
    }
  }
  // ── Subtest extraction (scaled scores 1-19, percentiles 0-99) ──
  const subtests = [
    ["RV", /Receptive\s*Vocabulary/i],
    ["IN", /Information/i],
    ["BD", /Block\s*Design/i],
    ["OA", /Object\s*Assembly/i],
    ["MR", /Matrix\s*Reasoning/i],
    ["PC", /Picture\s*Concepts/i],
    ["PM", /Picture\s*Memory/i],
    ["ZL", /Zoo\s*Locations/i],
    ["BS", /Bug\s*Search/i],
    ["CA", /Cancellation/i],
    ["SI", /Similarities/i],
    ["VC", /(?<!Receptive\s+)Vocabulary/i],
    ["CO", /(?<!Oral\s+Discourse\s+)Comprehension(?!\s+(?:and|&)\s+Fluency)/i],
    ["AC", /Animal\s*Coding/i],
    ["PN", /Picture\s*Naming/i],
  ];
  sc.subtests = {};
  for (const [abbr, namePat] of subtests) {
    const patterns = [
      new RegExp(namePat.source + "\\s+(\\d{1,2})\\s+(\\d{1,3})", namePat.flags),
      new RegExp(namePat.source + "\\s+\\d+\\s+(\\d{1,2})\\s+(\\d{1,3})", namePat.flags),
    ];
    for (const p of patterns) {
      const m = txt.match(p);
      if (m) {
        const scaled = +m[1];
        const pct = +m[2];
        if (scaled >= 1 && scaled <= 19 && pct >= 0 && pct <= 99) {
          sc.subtests[abbr] = { scaled, pct };
          break;
        }
      }
    }
  }
  const keys = Object.keys(sc).filter(k => k !== "subtests");
  if (!sc.fsiq || keys.length < 3) return null;
  return sc;
}

// ── Auto-derive strengths/weaknesses from parsed scores ──
function deriveStrengthsWeaknesses(scores, indexList) {
  // indexList: [[key, label], ...] e.g. [["vci","verbal reasoning"], ["pri","visual reasoning"]]
  if (!scores) return { strengths: "", weaker: "" };
  const entries = indexList.filter(([k]) => scores[k]).map(([k, label]) => ({ key: k, label, score: scores[k].score }));
  if (entries.length < 2) return { strengths: "", weaker: "" };
  const avg = entries.reduce((s, e) => s + e.score, 0) / entries.length;
  const strong = entries.filter(e => e.score >= avg + 3).sort((a, b) => b.score - a.score);
  const weak = entries.filter(e => e.score <= avg - 3).sort((a, b) => a.score - b.score);
  // If no clear differentiation, use highest/lowest
  if (strong.length === 0 && weak.length === 0) {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    if (sorted[0].score > sorted[sorted.length - 1].score) {
      strong.push(sorted[0]);
      weak.push(sorted[sorted.length - 1]);
    }
  }
  return {
    strengths: strong.length > 0 ? strong.map(e => e.label).join(" and ") : entries.filter(e => e.score >= avg).map(e => e.label).join(" and "),
    weaker: weak.length > 0 ? weak.map(e => e.label).join(" and ") : entries.filter(e => e.score < avg).map(e => e.label).join(" and "),
  };
}

// ── Extract WAIS-IV cognitive text from docs ──
function extractWAISCogText(docs, firstName, pronouns) {
  if (!docs || docs.length === 0) return null;
  for (const d of docs) {
    const txt = d.extractedText || "";
    if (!txt || txt.length < 100) continue;
    if (!/WAIS|Wechsler\s*Adult/i.test(txt)) continue;
    const sc = parseWAISScores(txt);
    if (!sc) continue;
    // Build manual-like object from parsed scores
    const wm = {};
    if (sc.fsiq) { wm.fsiqScore = String(sc.fsiq.score); wm.fsiqPercentile = String(sc.fsiq.pct); }
    if (sc.vci) { wm.vciScore = String(sc.vci.score); wm.vciPercentile = String(sc.vci.pct); }
    if (sc.pri) { wm.priScore = String(sc.pri.score); wm.priPercentile = String(sc.pri.pct); }
    if (sc.wmi) { wm.wmiScore = String(sc.wmi.score); wm.wmiPercentile = String(sc.wmi.pct); }
    if (sc.psi) { wm.psiScore = String(sc.psi.score); wm.psiPercentile = String(sc.psi.pct); }
    if (sc.gai) { wm.gaiScore = String(sc.gai.score); wm.gaiPercentile = String(sc.gai.pct); }
    if (sc.cpi) { wm.cpiScore = String(sc.cpi.score); wm.cpiPercentile = String(sc.cpi.pct); }
    // Pass subtests through
    if (sc.subtests) {
      for (const [abbr, data] of Object.entries(sc.subtests)) {
        wm[`sub_${abbr}_scaled`] = String(data.scaled);
        wm[`sub_${abbr}_pct`] = String(data.pct);
      }
    }
    // Auto-derive strengths/weaknesses
    const sw = deriveStrengthsWeaknesses(sc, [
      ["vci", "verbal reasoning"], ["pri", "visual reasoning"],
      ["wmi", "working memory"], ["psi", "processing efficiency"],
    ]);
    wm.strengths = sw.strengths;
    wm.weakerAreas = sw.weaker;
    return { wm, scores: sc };
  }
  return null;
}

// ── Extract WPPSI-IV cognitive text from docs ──
function extractWPPSICogText(docs, firstName, pronouns) {
  if (!docs || docs.length === 0) return null;
  for (const d of docs) {
    const txt = d.extractedText || "";
    if (!txt || txt.length < 100) continue;
    if (!/WPPSI|Wechsler\s*Preschool/i.test(txt)) continue;
    const sc = parseWPPSIScores(txt);
    if (!sc) continue;
    const wm = {};
    if (sc.fsiq) { wm.fsiqScore = String(sc.fsiq.score); wm.fsiqPercentile = String(sc.fsiq.pct); }
    if (sc.vci) { wm.vciScore = String(sc.vci.score); wm.vciPercentile = String(sc.vci.pct); }
    if (sc.vsi) { wm.vsiScore = String(sc.vsi.score); wm.vsiPercentile = String(sc.vsi.pct); }
    if (sc.fri) { wm.friScore = String(sc.fri.score); wm.friPercentile = String(sc.fri.pct); }
    if (sc.wmi) { wm.wmiScore = String(sc.wmi.score); wm.wmiPercentile = String(sc.wmi.pct); }
    if (sc.psi) { wm.psiScore = String(sc.psi.score); wm.psiPercentile = String(sc.psi.pct); }
    if (sc.gai) { wm.gaiScore = String(sc.gai.score); wm.gaiPercentile = String(sc.gai.pct); }
    if (sc.cpi) { wm.cpiScore = String(sc.cpi.score); wm.cpiPercentile = String(sc.cpi.pct); }
    if (sc.nvi) { wm.nviScore = String(sc.nvi.score); wm.nviPercentile = String(sc.nvi.pct); }
    if (sc.vai) { wm.vaiScore = String(sc.vai.score); wm.vaiPercentile = String(sc.vai.pct); }
    // Pass subtests through
    if (sc.subtests) {
      for (const [abbr, data] of Object.entries(sc.subtests)) {
        wm[`sub_${abbr}_scaled`] = String(data.scaled);
        wm[`sub_${abbr}_pct`] = String(data.pct);
      }
    }
    const sw = deriveStrengthsWeaknesses(sc, [
      ["vci", "language based reasoning"], ["vsi", "visual spatial skills"],
      ["fri", "fluid reasoning"], ["wmi", "working memory"], ["psi", "processing efficiency"],
    ]);
    wm.strengths = sw.strengths;
    wm.weakerAreas = sw.weaker;
    return { wm, scores: sc };
  }
  return null;
}

// ── Build score summary block for AI academic impact ──
function buildCogScoreSummary(testName, scores, indexLabels) {
  const lines = [];
  lines.push(`Test: ${testName}`);
  for (const [key, label] of indexLabels) {
    if (scores[key]) {
      const desc = percentileToDescriptor(scores[key].pct);
      lines.push(`${label}: ${scores[key].score} (${scores[key].pct}th percentile, ${desc})`);
    }
  }
  return lines.join("\n");
}

function buildMemoryText(sc, firstName, pr) {
  const sub = pr?.subject || "he";
  const obj = pr?.object || "him";
  const pos = pr?.possessive || "his";
  const Sub = sub.charAt(0).toUpperCase() + sub.slice(1);
  const Pos = pos.charAt(0).toUpperCase() + pos.slice(1);
  const ssPct = (k) => sc[k] ? ordinalPct(WRAML3_SS_TO_PCT[sc[k].ss] ?? null) : null;
  const ssRng = (k) => sc[k] ? wraml3SSRange(sc[k].ss) : null;
  const ixPct = (k) => sc[k] ? ordinalPct(sc[k].pct) : null;
  const ixRng = (k) => sc[k] ? wraml3IndexRange(sc[k].score) : null;
  const parts = [];

  // Intro
  parts.push(`Selected subtests of the Wide Range Assessment of Memory and Learning, Third Edition (WRAML-3) were administered to examine ${firstName}'s memory and learning abilities. The WRAML-3 is an individually administered, standardized assessment designed to evaluate a broad range of memory, learning, and cognitive functions that underlie everyday learning. Memory is a foundational skill that supports virtually all areas of academic achievement. The ability to take in new information, hold it in mind, organize it, and later retrieve it when needed is essential for following classroom instruction, learning to read, acquiring mathematical concepts, and completing written assignments. Weaknesses in memory functioning can affect a student's performance even when intellectual ability and motivation are adequate. The WRAML-3 measures how well ${firstName} can encode, store, and retrieve verbal and visual information both immediately after presentation and after a delay of approximately twenty to thirty minutes. Specifically, it provides information about ${firstName}'s verbal and visual immediate recall, delayed recall, recognition memory, attention and concentration, and working memory. Index scores are reported as standard scores with a mean of 100 and a standard deviation of 15. Subtest scores are reported as scaled scores with a mean of 10 and a standard deviation of 3. Qualitative descriptors are used to describe the range of performance.`);

  // General Immediate Memory
  if (sc.GIM) {
    parts.push(`The General Immediate Memory Index provides a broad estimate of ${firstName}'s overall ability to take in and immediately reproduce new information across a wide range of memory tasks. This composite draws upon both verbal and visual memory channels, as well as attention and concentration, and therefore reflects the general efficiency with which ${firstName} can register and recall newly presented material. It is derived from the combined scores earned on the Verbal Immediate Memory Index, the Visual Immediate Memory Index, and the Attention and Concentration Index. ${firstName} obtained a standard score of ${sc.GIM.score} (${ixPct("GIM")} percentile), which falls within the ${ixRng("GIM")} range. This suggests that ${firstName}'s overall capacity to take in and immediately recall new information across both verbal and visual modalities is ${ixRng("GIM")} when compared to same age peers.`);
  }

  // Visual Immediate Memory
  if (sc.VIM) {
    let t = `The Visual Immediate Memory Index is an estimate of how well ${firstName} can learn and recall visual information shortly after it is presented. Visual memory plays an important role in many classroom activities, including remembering what was written on the board, recalling the layout of a page or diagram, and recognizing previously seen material. This index is derived from the scaled scores earned on the Picture Memory and Design Learning subtests. ${firstName} obtained a standard score of ${sc.VIM.score} (${ixPct("VIM")} percentile), which falls within the ${ixRng("VIM")} range, suggesting that ${pos} ability to take in and immediately recall visual information is ${ixRng("VIM")} relative to same age peers.`;
    if (sc.DL) {
      t += ` On the Design Learning subtest, ${firstName} was shown a stimulus card containing geometric shapes distributed across four quadrants. The card was exposed for ten seconds and then removed. After a brief delay, ${firstName} was asked to recall and draw the shapes in the correct locations. This procedure was repeated across four learning trials, providing an opportunity to observe how well ${firstName} benefits from repeated exposure to the same visual material. This type of task is similar to situations in which students must learn and remember spatial arrangements, such as map details or geometric configurations. ${firstName} obtained a scaled score of ${sc.DL.ss} (${ssPct("DL")} percentile), which falls within the ${ssRng("DL")} range.`;
    }
    if (sc.DLD) {
      t += ` When asked to recall the design details in the correct locations after a twenty to thirty minute delay, ${firstName} obtained a scaled score of ${sc.DLD.ss} (${ssPct("DLD")} percentile), which falls within the ${ssRng("DLD")} range. This delayed score reflects how well ${firstName} can consolidate and later retrieve visual spatial information from long term memory, a skill that is important for retaining learned material from one lesson to the next.`;
    }
    if (sc.PM) {
      t += ` On the Picture Memory subtest, ${firstName} was shown a meaningful visual scene and was then asked to look at a second, similar scene. Memory of the original picture is indicated by identifying elements that were altered, added, or removed in the second picture. Unlike Design Learning, this subtest draws on memory for contextually rich and meaningful visual information, which is more similar to everyday visual experiences. ${firstName} obtained a scaled score of ${sc.PM.ss} (${ssPct("PM")} percentile), which falls within the ${ssRng("PM")} range.`;
    }
    if (sc.PMD) {
      t += ` When asked to identify elements that were changed, added, or moved after a twenty to thirty minute delay, ${firstName} obtained a scaled score of ${sc.PMD.ss} (${ssPct("PMD")} percentile), which falls within the ${ssRng("PMD")} range.`;
    }
    parts.push(t);
  }

  // Verbal Immediate Memory
  if (sc.VBM) {
    let t = `The Verbal Immediate Memory Index is an estimate of how well ${firstName} can learn and recall verbal information shortly after hearing it. Verbal memory is central to classroom learning because much of what is taught is delivered through spoken language. The ability to listen to a teacher's explanation, hold the key ideas in mind, and recall them accurately is essential for following instructions, participating in discussions, and learning from lectures. This index is derived from the scaled scores earned on the Story Memory and Verbal Learning subtests. ${firstName} obtained a standard score of ${sc.VBM.score} (${ixPct("VBM")} percentile), which falls within the ${ixRng("VBM")} range, suggesting that ${pos} ability to take in and immediately recall verbally presented information is ${ixRng("VBM")} relative to same age peers.`;
    if (sc.SM) {
      t += ` The Story Memory subtest assesses the ability to process, encode, and recall meaningful material that is presented in a sequential narrative format. In the immediate portion, the examiner reads two stories one at a time, and ${firstName} was asked to retell each story from memory. Because the material is organized into a meaningful narrative, this subtest reflects how well ${firstName} can use contextual meaning and story structure to support recall. ${firstName} obtained a scaled score of ${sc.SM.ss} (${ssPct("SM")} percentile), which falls within the ${ssRng("SM")} range.`;
    }
    if (sc.SMD) {
      t += ` On the delayed recall portion, administered after a twenty to thirty minute delay, ${firstName} obtained a scaled score of ${sc.SMD.ss} (${ssPct("SMD")} percentile), which falls within the ${ssRng("SMD")} range. This delayed score reflects ${pos} ability to consolidate and retain meaningful verbal information over time, which is important for remembering what was taught earlier in a lesson or on a previous day.`;
    }
    if (sc.VL) {
      t += ` The Verbal Learning subtest assesses ${firstName}'s ability to learn a list of unrelated words over four learning trials. Because the words are not connected by meaning, this task places heavier demands on rote verbal learning and measures how well ${firstName} benefits from repetition when the material itself provides few contextual cues to support recall. ${firstName} obtained a scaled score of ${sc.VL.ss} (${ssPct("VL")} percentile), which falls within the ${ssRng("VL")} range.`;
    }
    if (sc.VLD) {
      t += ` On the delayed recall section, administered after a twenty to thirty minute delay, ${firstName} obtained a scaled score of ${sc.VLD.ss} (${ssPct("VLD")} percentile), which falls within the ${ssRng("VLD")} range, reflecting ${pos} ability to store and later retrieve rote verbal material from long term memory.`;
    }
    parts.push(t);
  }

  // Attention/Concentration
  if (sc.AC) {
    let t = `The Attention and Concentration Index provides an estimate of how well ${firstName} can learn and recall attentionally demanding, relatively rote, sequential information. Attention and concentration underlie all forms of memory because information cannot be stored effectively if it is not attended to in the first place. This domain is particularly relevant to tasks that require sustained focus, such as listening to multi step directions, copying from the board, or following a sequence of classroom instructions. Both auditory and visual information are sampled within this index. It is derived from the scaled scores earned on the Finger Windows and Number Letter subtests. ${firstName} obtained a standard score of ${sc.AC.score} (${ixPct("AC")} percentile), which falls within the ${ixRng("AC")} range, suggesting that ${pos} ability to attend to and remember sequentially presented information is ${ixRng("AC")} relative to same age peers.`;
    if (sc.FW) {
      t += ` The Finger Windows subtest assesses the ability to attend to and remember a sequence of spatial locations. The examiner points to a pattern of holes, or windows, in a card in a specified order, and ${firstName} must reproduce the sequence from memory. The pattern of windows becomes progressively longer as the subtest proceeds, placing increasing demands on visual sequential memory and the ability to maintain a mental representation of a spatial sequence. ${firstName} obtained a scaled score of ${sc.FW.ss} (${ssPct("FW")} percentile), which falls within the ${ssRng("FW")} range.`;
    }
    if (sc.NL) {
      t += ` The Number Letter subtest requires ${firstName} to listen to a random mix of numbers and letters presented verbally and repeat them back in the exact order they were given. This task assesses auditory attention, working memory, and the ability to hold and reproduce sequential auditory information, which is similar to what is required when following a series of spoken instructions in the classroom. ${firstName} obtained a scaled score of ${sc.NL.ss} (${ssPct("NL")} percentile), which falls within the ${ssRng("NL")} range.`;
    }
    if (sc.SEM) {
      t += ` The Sentence Memory subtest requires ${firstName} to listen to sentences of increasing length and complexity and repeat them back verbatim. This task assesses auditory memory and the ability to hold and reproduce meaningful verbal sequences, which is important for following verbal instructions and understanding spoken language. ${firstName} obtained a scaled score of ${sc.SEM.ss} (${ssPct("SEM")} percentile), which falls within the ${ssRng("SEM")} range.`;
    }
    if (sc.SR) {
      t += ` The Sentence Recall subtest assesses the ability to recall sentences that were presented earlier in the assessment, requiring ${firstName} to retain meaningful verbal information over a brief delay. ${firstName} obtained a scaled score of ${sc.SR.ss} (${ssPct("SR")} percentile), which falls within the ${ssRng("SR")} range.`;
    }
    parts.push(t);
  }

  // General Delayed
  if (sc.GD) {
    parts.push(`The General Delayed Index provides an estimate of how well ${firstName} can retain and later retrieve information that was learned earlier in the assessment session. After the immediate memory subtests were administered, approximately twenty to thirty minutes were allowed to pass before ${firstName} was asked to recall the same material again without any additional exposure. This delayed recall format is important because it reflects the kind of memory required for learning in school, where students must remember information from one part of a lesson to the next, or from one day to the next. This index is derived from the scores earned on the Visual Delayed and Verbal Delayed Indexes and reflects how well ${firstName} can retain both visual and verbal information over time. ${firstName} obtained a standard score of ${sc.GD.score} (${ixPct("GD")} percentile), which falls within the ${ixRng("GD")} range, suggesting that ${pos} overall ability to consolidate and retrieve previously learned material after a delay is ${ixRng("GD")} relative to same age peers.`);
  }

  // Visual Delayed
  if (sc.VD) {
    parts.push(`The Visual Delayed Index is an estimate of how well ${firstName} can retain and retrieve visual information after a twenty to thirty minute delay. This index reflects the ability to consolidate visual material into longer term storage and access it when needed, which is relevant for tasks such as remembering diagrams, visual instructions, or the layout of previously seen material. It is derived from the subtest scaled scores of Picture Memory Delayed and Design Learning Delayed. ${firstName} obtained a standard score of ${sc.VD.score} (${ixPct("VD")} percentile), which falls within the ${ixRng("VD")} range.`);
  }

  // Verbal Delayed
  if (sc.VBD) {
    parts.push(`The Verbal Delayed Index is an estimate of how well ${firstName} can store and retrieve verbal information after a twenty to thirty minute delay. This index reflects the ability to consolidate verbally presented material into longer term memory and retrieve it when needed, which is essential for retaining information from classroom instruction, remembering what was read in a passage, or recalling details from a previous lesson. It is derived from the subtest scaled scores of Story Memory Delayed and Verbal Learning Delayed. ${firstName} obtained a standard score of ${sc.VBD.score} (${ixPct("VBD")} percentile), which falls within the ${ixRng("VBD")} range.`);
  }

  // Collect all scores for AI summary generation
  const scoreSummaryLines = [];
  if (sc.GIM) scoreSummaryLines.push(`General Immediate Memory Index: Standard Score ${sc.GIM.score} (${ixRng("GIM")}, ${sc.GIM.pct}th percentile)`);
  if (sc.VIM) scoreSummaryLines.push(`Visual Immediate Memory Index: Standard Score ${sc.VIM.score} (${ixRng("VIM")}, ${sc.VIM.pct}th percentile)`);
  if (sc.VBM) scoreSummaryLines.push(`Verbal Immediate Memory Index: Standard Score ${sc.VBM.score} (${ixRng("VBM")}, ${sc.VBM.pct}th percentile)`);
  if (sc.AC) scoreSummaryLines.push(`Attention/Concentration Index: Standard Score ${sc.AC.score} (${ixRng("AC")}, ${sc.AC.pct}th percentile)`);
  if (sc.GD) scoreSummaryLines.push(`General Delayed Index: Standard Score ${sc.GD.score} (${ixRng("GD")}, ${sc.GD.pct}th percentile)`);
  if (sc.VD) scoreSummaryLines.push(`Visual Delayed Index: Standard Score ${sc.VD.score} (${ixRng("VD")}, ${sc.VD.pct}th percentile)`);
  if (sc.VBD) scoreSummaryLines.push(`Verbal Delayed Index: Standard Score ${sc.VBD.score} (${ixRng("VBD")}, ${sc.VBD.pct}th percentile)`);
  if (sc.DL) scoreSummaryLines.push(`Design Learning: Scaled Score ${sc.DL.ss} (${ssRng("DL")}, ${ssPct("DL")} percentile)`);
  if (sc.PM) scoreSummaryLines.push(`Picture Memory: Scaled Score ${sc.PM.ss} (${ssRng("PM")}, ${ssPct("PM")} percentile)`);
  if (sc.SM) scoreSummaryLines.push(`Story Memory: Scaled Score ${sc.SM.ss} (${ssRng("SM")}, ${ssPct("SM")} percentile)`);
  if (sc.VL) scoreSummaryLines.push(`Verbal Learning: Scaled Score ${sc.VL.ss} (${ssRng("VL")}, ${ssPct("VL")} percentile)`);
  if (sc.FW) scoreSummaryLines.push(`Finger Windows: Scaled Score ${sc.FW.ss} (${ssRng("FW")}, ${ssPct("FW")} percentile)`);
  if (sc.NL) scoreSummaryLines.push(`Number Letter: Scaled Score ${sc.NL.ss} (${ssRng("NL")}, ${ssPct("NL")} percentile)`);
  if (sc.SEM) scoreSummaryLines.push(`Sentence Memory: Scaled Score ${sc.SEM.ss} (${ssRng("SEM")}, ${ssPct("SEM")} percentile)`);
  if (sc.SR) scoreSummaryLines.push(`Sentence Recall: Scaled Score ${sc.SR.ss} (${ssRng("SR")}, ${ssPct("SR")} percentile)`);
  if (sc.DLD) scoreSummaryLines.push(`Design Learning Delayed: Scaled Score ${sc.DLD.ss} (${ssRng("DLD")}, ${ssPct("DLD")} percentile)`);
  if (sc.PMD) scoreSummaryLines.push(`Picture Memory Delayed: Scaled Score ${sc.PMD.ss} (${ssRng("PMD")}, ${ssPct("PMD")} percentile)`);
  if (sc.SMD) scoreSummaryLines.push(`Story Memory Delayed: Scaled Score ${sc.SMD.ss} (${ssRng("SMD")}, ${ssPct("SMD")} percentile)`);
  if (sc.VLD) scoreSummaryLines.push(`Verbal Learning Delayed: Scaled Score ${sc.VLD.ss} (${ssRng("VLD")}, ${ssPct("VLD")} percentile)`);

  // Append score data block (hidden from display, used by AI summary generation)
  if (scoreSummaryLines.length > 0) {
    parts.push(`[MEMORY_SCORES_FOR_SUMMARY]\n${scoreSummaryLines.join("\n")}\n[/MEMORY_SCORES_FOR_SUMMARY]`);
  }

  return parts.join("\n\n");
}

function extractMemoryText(docs, firstName, pronouns) {
  if (!docs || docs.length === 0) return null;
  for (const d of docs) {
    const txt = d.extractedText || "";
    if (!txt || !txt.match(/WRAML/i)) continue;
    const sc = parseWRAML3Scores(txt);
    if (!sc.GIM && !sc.VIM && !sc.VBM) continue;
    const pr = PRONOUN_MAP[pronouns] || PRONOUN_MAP["he/him"];
    return buildMemoryText(sc, firstName || "[firstName]", pr);
  }
  return null;
}

// WIAT III SCORE EXTRACTION & TEMPLATE POPULATION
function ssToRange(ss) {
  if (ss == null) return null;
  const n = parseInt(ss, 10);
  if (isNaN(n)) return null;
  if (n >= 130) return "Very Superior";
  if (n >= 120) return "Superior";
  if (n >= 110) return "High Average";
  if (n >= 90) return "Average";
  if (n >= 80) return "Low Average";
  if (n >= 70) return "Borderline";
  return "Extremely Low";
}

function parseWIATScores(txt) {
  const scores = {};
  // Normalize whitespace
  const t = txt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // ── SPECIAL: Parse "Subtest Component Score Summary" section ──
  // In WIAT PDFs extracted by pdfminer/pdf.js, numbers appear one-per-line in COLUMN order:
  //   Raw1, Raw2, ..., RawN, SS1, SS2, ..., SSN, PR1, PR2, ..., PRN, NCE1..., Stanine1...
  // Then names appear after "Subtest Component" label.
  // Group headers (Listening Comprehension, Sentence Composition, Essay Composition) have no data rows.
  try {
    // Find the actual section heading (not the reference on page 2 ending with ").")
    const compHeadIdx = t.search(/Subtest Component Score Summary\s*\n\s*\n?\s*Raw\b/i);
    const compNameIdx = compHeadIdx >= 0 ? t.indexOf("Subtest Component\n", compHeadIdx + 30) : -1;
    if (compHeadIdx >= 0 && compNameIdx >= 0) {
      // Get text between section heading and the "Subtest Component" name label
      const dataZone = t.slice(compHeadIdx, compNameIdx);
      // Skip everything until after the "Description" header line
      const afterHeaders = dataZone.replace(/^[\s\S]*?Description\s*\n/i, "");
      // Collect all standalone numbers and qualitative labels
      const allNums = [];
      const qualLabels = [];
      for (const line of afterHeaders.split("\n")) {
        const trimmed = line.trim();
        if (/^\d+$/.test(trimmed)) allNums.push(parseInt(trimmed, 10));
        else if (/^(Very |Extremely )?(Above |Below )?(Average|Superior|Low|High)/i.test(trimmed)) qualLabels.push(trimmed);
      }
      // 5 numeric columns: Raw, SS, PR, NCE, Stanine → N = total / 5
      const nCols = 5;
      const N = Math.floor(allNums.length / nCols);
      if (N >= 2 && N <= 20) {
        const ssCol = allNums.slice(N, N * 2);       // Standard Scores
        const prCol = allNums.slice(N * 2, N * 3);   // Percentile Ranks

        // Get component names after "Subtest Component\n"
        const nameZone = t.slice(compNameIdx + "Subtest Component\n".length, compNameIdx + 600);
        const nameLines = nameZone.split("\n").map(l => l.trim()).filter(l =>
          /^[A-Z]/i.test(l) && !/^(Composite|Sum of|Standard|Percentile|Raw|Normal|Stanine|Qualitative|90%|Confidence|WIAT|ID:)/i.test(l)
        );
        // Filter out group headers — parent subtests that already appear in the main score table
        const groupHeaders = new Set([
          "Listening Comprehension", "Sentence Composition", "Essay Composition",
          "Reading Comprehension", "Math Problem Solving", "Numerical Operations",
          "Spelling", "Word Reading", "Pseudoword Decoding",
        ]);
        const componentNames = nameLines.filter(n => !groupHeaders.has(n));

        const componentKeyMap = {
          "Receptive Vocabulary": "RECEPTIVE_VOCABULARY",
          "Oral Discourse Comprehension": "ORAL_DISCOURSE",
          "Oral Discourse": "ORAL_DISCOURSE",
        };
        for (let i = 0; i < Math.min(N, componentNames.length); i++) {
          const name = componentNames[i];
          const key = componentKeyMap[name];
          if (key && ssCol[i] >= STANDARD_SCORE_MIN && ssCol[i] <= STANDARD_SCORE_MAX) {
            if (!scores[key]) scores[key] = { ss: ssCol[i], percentile: prCol[i] };
          }
        }
      }
    }
  } catch (e) { /* component parsing failed — continue with regex patterns */ }

  // ── SPECIAL: Parse "Composite Score Summary" positional section ──
  // Numbers are also in column order: Sum1..SumN, SS1..SSN, CI-lo1..CI-loN, CI-hi1..CI-hiN, PR1..PRN, NCE1..NCEN, Stanine1..StanineN
  try {
    const compScoreMatch = t.match(/Composite\s+Score\s+Summary[\s\S]*?(?=Composite\s+Score\s+Profile|Differences\s+Between|$)/i);
    if (compScoreMatch) {
      const compSection = compScoreMatch[0];
      // Find composite names after "Composite\n" label
      const namePart = compSection.match(/\nComposite\s*\n([\s\S]*?)(?:Sum\s+of|Standard|$)/i);
      const compositeNames = [];
      if (namePart) {
        for (const line of namePart[1].split("\n")) {
          const trimmed = line.trim();
          if (/^[A-Z]/i.test(trimmed) && !/^(Sum|Standard|Percentile|Raw|Normal|Stanine|Qualitative|90%|Confidence|Note|WIAT)/i.test(trimmed)) {
            compositeNames.push(trimmed);
          }
        }
      }
      // Collect all numbers after column headers (skip to after "Stanine" or "Description")
      const afterHeaders = compSection.replace(/^[\s\S]*?(?:Equiv\.\s*Stanine|Description)\s*\n/i, "");
      const allNums = [];
      for (const line of afterHeaders.split("\n")) {
        const trimmed = line.trim();
        if (/^\d+$/.test(trimmed)) allNums.push(parseInt(trimmed, 10));
        // CI range "122-130" → two numbers
        if (/^\d+\s*[-–—]\s*\d+$/.test(trimmed)) {
          const parts = trimmed.split(/\s*[-–—]\s*/);
          allNums.push(parseInt(parts[0], 10));
          allNums.push(parseInt(parts[1], 10));
        }
      }
      // 7 columns: Sum, SS, CI-lo, CI-hi, PR, NCE, Stanine → N = total / 7
      const N = compositeNames.length || Math.floor(allNums.length / 7);
      if (N >= 1 && N <= 10 && allNums.length >= N * 7) {
        const compositeKeyMap = {
          "Oral Language": "ORAL_LANGUAGE_COMPOSITE",
          "Total Reading": "TOTAL_READING",
          "Basic Reading": "BASIC_READING",
          "Written Expression": "WRITTEN_EXPRESSION",
          "Mathematics": "MATHEMATICS_COMPOSITE",
          "Total Achievement": "TOTAL_ACHIEVEMENT",
        };
        // Column-based: SS starts at index N (after Sum column), PR at index N*4 (after Sum, SS, CI-lo, CI-hi)
        const ssCol = allNums.slice(N, N * 2);
        const prCol = allNums.slice(N * 4, N * 5);
        for (let i = 0; i < Math.min(N, compositeNames.length); i++) {
          const name = compositeNames[i];
          const key = compositeKeyMap[name];
          const ss = ssCol[i];
          const pr = prCol[i];
          if (key && ss >= STANDARD_SCORE_MIN && ss <= STANDARD_SCORE_MAX && pr <= PERCENTILE_MAX) {
            if (!scores[key]) scores[key] = { ss, percentile: pr };
          }
        }
      }
    }
  } catch (e) { /* composite positional parsing failed */ }

  // ── SPECIAL: Parse main "Subtest Score Summary" positional section ──
  // In WIAT PDFs, the main subtest table has numbers in column order similar to component/composite tables
  try {
    // Find heading: "Subtest Score Summary" but NOT "Subtest Component Score Summary"
    const mainHeadMatch = t.match(/(?:^|\n)\s*(?:Subtest\s+Score\s+Summary)\s*\n/i);
    if (mainHeadMatch && !/Component/i.test(mainHeadMatch[0])) {
      const mainHeadIdx = t.indexOf(mainHeadMatch[0]);
      // Look for "Subtest\n" label after the header to find names
      const nameSearchZone = t.slice(mainHeadIdx, mainHeadIdx + 3000);
      const subtestLabelIdx = nameSearchZone.search(/\nSubtest\s*\n/i);
      if (subtestLabelIdx >= 0) {
        const absNameIdx = mainHeadIdx + subtestLabelIdx;
        // Extract numbers between header and name label
        const dataZone = t.slice(mainHeadIdx, absNameIdx);
        const afterHeaders = dataZone.replace(/^[\s\S]*?(?:Description|Stanine)\s*\n/i, "");
        const allNums = [];
        for (const line of afterHeaders.split("\n")) {
          const trimmed = line.trim();
          if (/^\d+$/.test(trimmed)) allNums.push(parseInt(trimmed, 10));
        }
        // Extract subtest names after "Subtest\n"
        const afterLabel = t.slice(absNameIdx + subtestLabelIdx + "Subtest\n".length + 1, absNameIdx + subtestLabelIdx + 600);
        const nameLines = afterLabel.split("\n").map(l => l.trim()).filter(l =>
          /^[A-Z]/i.test(l) && !/^(Composite|Sum of|Standard|Percentile|Raw|Normal|Stanine|Qualitative|90%|Confidence|WIAT|ID:|Subtest)/i.test(l)
        );
        // 5 numeric columns: Raw, SS, PR, NCE, Stanine
        const nCols = 5;
        const N = Math.floor(allNums.length / nCols);
        if (N >= 3 && N <= 20 && nameLines.length >= N) {
          const ssCol = allNums.slice(N, N * 2);
          const prCol = allNums.slice(N * 2, N * 3);
          const mainSubtestKeyMap = {
            "Listening Comprehension": "LISTENING_COMPREHENSION",
            "Word Reading": "WORD_READING",
            "Pseudoword Decoding": "PSEUDOWORD_DECODING",
            "Reading Comprehension": "READING_COMPREHENSION",
            "Oral Reading Fluency": "ORAL_READING_FLUENCY",
            "Spelling": "SPELLING",
            "Sentence Composition": "SENTENCE_COMPOSITION",
            "Essay Composition": "ESSAY_COMPOSITION",
            "Math Problem Solving": "MATH_PROBLEM_SOLVING",
            "Numerical Operations": "NUMERICAL_OPERATIONS",
          };
          for (let i = 0; i < Math.min(N, nameLines.length); i++) {
            const name = nameLines[i];
            const key = mainSubtestKeyMap[name];
            const ss = ssCol[i];
            const pr = prCol[i];
            if (key && ss >= STANDARD_SCORE_MIN && ss <= STANDARD_SCORE_MAX && pr <= PERCENTILE_MAX) {
              if (!scores[key]) scores[key] = { ss, percentile: pr };
            }
          }
        }
      }
    }
  } catch (e) { /* main subtest positional parsing failed */ }

  // Helper: try multiple patterns for a subtest name, return {ss, percentile} or null
  function extractScore(name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Pattern 1: Raw  SS  CI  Percentile (full WIAT row)
    const re1 = new RegExp(esc + "[\\s\\-]+(\\d+|-)(?:[\\s\\u00B9\\u00B2]*)\\s+(\\d{2,3})\\s+[\\d]+\\s*[-–—]\\s*[\\d]+\\s+(\\d{1,3}(?:\\.\\d+)?)", "i");
    // Pattern 2: SS  CI  Percentile (no raw score)
    const re2 = new RegExp(esc + "[\\s\\-:]+(?:Standard\\s*Score)?[=:\\s]*(\\d{2,3})\\s+[\\d]+\\s*[-–—]\\s*[\\d]+\\s+(\\d{1,3}(?:\\.\\d+)?)", "i");
    // Pattern 3: SS  Percentile only (two numbers)
    const re3 = new RegExp(esc + "[\\s\\-:]+" + "(\\d{2,3})" + "[\\s\\t]+" + "(\\d{1,3}(?:\\.\\d+)?)(?:\\s|$|\\n|[,;])", "i");
    // Pattern 4: AI-formatted "Name: Standard Score = 102, Percentile = 55"
    const re4 = new RegExp(esc + "[:\\s]+(?:Standard\\s*Score)?[=:\\s]*(\\d{2,3})[,;\\s]+(?:Percentile(?:\\s*Rank)?)?[=:\\s]*(\\d{1,3}(?:\\.\\d+)?)", "i");
    // Pattern 5: Name (SS=102, PR=55) or inline parenthetical
    const re5 = new RegExp(esc + "\\s*\\(?(?:SS[=:\\s]*)?(\\d{2,3})[,;\\s]+(?:PR[=:\\s]*|percentile[=:\\s]*)?(?:the\\s+)?(\\d{1,3}(?:\\.\\d+)?)(?:st|nd|rd|th)?\\)?", "i");
    // Pattern 6: Name Composite Raw SS CI Percentile (composite rows with "Composite" between name and numbers)
    const re6 = new RegExp(esc + "(?:\\s+Composite)?[\\s\\-]+(\\d+|-)(?:[\\s\\u00B9\\u00B2]*)\\s+(\\d{2,3})\\s+[\\d]+\\s*[-–—]\\s*[\\d]+\\s+(\\d{1,3}(?:\\.\\d+)?)", "i");
    // Pattern 7: SS Percentile with ordinal suffix (e.g., "102  55th")
    const re7 = new RegExp(esc + "[\\s\\-:]+" + "(\\d{2,3})" + "[\\s\\t]+" + "(\\d{1,3}(?:\\.\\d+)?)(?:st|nd|rd|th)", "i");

    let m = t.match(re1);
    if (m) return { ss: parseInt(m[2], 10), percentile: parseFloat(m[3]) };
    m = t.match(re2);
    if (m) return { ss: parseInt(m[1], 10), percentile: parseFloat(m[2]) };
    m = t.match(re6);
    if (m) return { ss: parseInt(m[2], 10), percentile: parseFloat(m[3]) };
    m = t.match(re4);
    if (m && parseInt(m[1]) >= STANDARD_SCORE_MIN && parseInt(m[1]) <= STANDARD_SCORE_MAX) return { ss: parseInt(m[1], 10), percentile: parseFloat(m[2]) };
    m = t.match(re5);
    if (m && parseInt(m[1]) >= STANDARD_SCORE_MIN && parseInt(m[1]) <= STANDARD_SCORE_MAX) return { ss: parseInt(m[1], 10), percentile: parseFloat(m[2]) };
    m = t.match(re7);
    if (m && parseInt(m[1]) >= STANDARD_SCORE_MIN && parseInt(m[1]) <= STANDARD_SCORE_MAX && parseFloat(m[2]) <= PERCENTILE_MAX) return { ss: parseInt(m[1], 10), percentile: parseFloat(m[2]) };
    m = t.match(re3);
    if (m && parseInt(m[1]) >= STANDARD_SCORE_MIN && parseInt(m[1]) <= STANDARD_SCORE_MAX && parseFloat(m[2]) <= PERCENTILE_MAX) return { ss: parseInt(m[1], 10), percentile: parseFloat(m[2]) };
    return null;
  }

  // Subtests
  const subtestMap = {
    LISTENING_COMPREHENSION: "Listening Comprehension",
    READING_COMPREHENSION: "Reading Comprehension",
    MATH_PROBLEM_SOLVING: "Math Problem Solving",
    SENTENCE_COMPOSITION: "Sentence Composition",
    WORD_READING: "Word Reading",
    ESSAY_COMPOSITION: "Essay Composition",
    SPELLING: "Spelling",
    PSEUDOWORD_DECODING: "Pseudoword Decoding",
    NUMERICAL_OPERATIONS: "Numerical Operations",
    RECEPTIVE_VOCABULARY: "Receptive Vocabulary",
    ORAL_DISCOURSE: "Oral Discourse Comprehension",
    ORAL_READING_FLUENCY: "Oral Reading Fluency",
  };

  for (const [key, name] of Object.entries(subtestMap)) {
    const result = extractScore(name);
    if (result) scores[key] = result;
  }
  // Retry Oral Discourse with shortened name if not found
  if (!scores.ORAL_DISCOURSE) {
    const alt = extractScore("Oral Discourse");
    if (alt) scores.ORAL_DISCOURSE = alt;
  }

  // Composites — try with and without "Composite" suffix
  const compositeMap = {
    ORAL_LANGUAGE_COMPOSITE: ["Oral Language Composite", "Oral Language"],
    TOTAL_READING: ["Total Reading Composite", "Total Reading"],
    BASIC_READING: ["Basic Reading Composite", "Basic Reading"],
    WRITTEN_EXPRESSION: ["Written Expression Composite", "Written Expression"],
    MATHEMATICS_COMPOSITE: ["Mathematics Composite", "Mathematics"],
    TOTAL_ACHIEVEMENT: ["Total Achievement Composite", "Total Achievement"],
    READING_COMPREHENSION_FLUENCY: ["Reading Comprehension and Fluency Composite", "Reading Comprehension and Fluency"],
    ORAL_READING_FLUENCY: ["Oral Reading Fluency"],
  };

  for (const [key, names] of Object.entries(compositeMap)) {
    for (const name of names) {
      const result = extractScore(name);
      if (result) { scores[key] = result; break; }
    }
  }

  return scores;
}

function buildWIATText(scores, firstName, pronounKey) {
  let text = personalize(WIAT_TEMPLATE, firstName, pronounKey);

  // Replace score placeholders — now includes [KEY_SS], [KEY_RANGE], [KEY_PERCENTILE]
  const replacements = {
    LISTENING_COMPREHENSION: scores.LISTENING_COMPREHENSION,
    RECEPTIVE_VOCABULARY: scores.RECEPTIVE_VOCABULARY,
    ORAL_DISCOURSE: scores.ORAL_DISCOURSE,
    WORD_READING: scores.WORD_READING,
    PSEUDOWORD_DECODING: scores.PSEUDOWORD_DECODING,
    READING_COMPREHENSION: scores.READING_COMPREHENSION,
    ORAL_READING_FLUENCY: scores.ORAL_READING_FLUENCY,
    SPELLING: scores.SPELLING,
    SENTENCE_COMPOSITION: scores.SENTENCE_COMPOSITION,
    ESSAY_COMPOSITION: scores.ESSAY_COMPOSITION,
    MATH_PROBLEM_SOLVING: scores.MATH_PROBLEM_SOLVING,
    NUMERICAL_OPERATIONS: scores.NUMERICAL_OPERATIONS,
    ORAL_LANGUAGE_COMPOSITE: scores.ORAL_LANGUAGE_COMPOSITE,
    TOTAL_READING: scores.TOTAL_READING,
    BASIC_READING: scores.BASIC_READING,
    READING_COMPREHENSION_FLUENCY: scores.READING_COMPREHENSION_FLUENCY,
    WRITTEN_EXPRESSION: scores.WRITTEN_EXPRESSION,
    MATHEMATICS_COMPOSITE: scores.MATHEMATICS_COMPOSITE,
    TOTAL_ACHIEVEMENT: scores.TOTAL_ACHIEVEMENT,
  };

  let unfilled = 0;
  for (const [key, data] of Object.entries(replacements)) {
    const ssTag = `[${key}_SS]`;
    const rangeTag = `[${key}_RANGE]`;
    const pctTag = `[${key}_PERCENTILE]`;
    if (data && data.ss != null) {
      const range = ssToRange(data.ss);
      text = text.replace(ssTag, String(data.ss));
      text = text.replace(rangeTag, range);
      text = text.replace(pctTag, String(data.percentile) + getSuffix(data.percentile));
    } else {
      unfilled++;
      // Mark unfilled placeholders for sentence removal
      text = text.replace(ssTag, "⟦___⟧");
      text = text.replace(rangeTag, "⟦___⟧");
      text = text.replace(pctTag, "⟦___⟧");
    }
  }

  // Remove individual sentences that still contain unfilled ⟦___⟧ placeholders
  // Split into paragraphs, then within each paragraph strip sentences with blanks
  const paragraphs = text.split(/\n\n/);
  const cleaned = paragraphs.map(p => {
    if (!p.includes("⟦___⟧")) return p;
    // Split paragraph into sentences, remove ones with unfilled placeholders
    // Use regex to split on sentence boundaries (period followed by space and capital letter, or end)
    const sentences = p.split(/(?<=\.)\s+(?=[A-Z\[])/);
    const kept = sentences.filter(s => !s.includes("⟦___⟧"));
    if (kept.length === 0) return null; // entire paragraph unfilled — remove it
    return kept.join(" ");
  }).filter(p => p !== null);
  text = cleaned.join("\n\n");

  return { text, unfilled };
}

function extractAcademicText(docs, firstName, pronouns) {
  if (!docs || docs.length === 0) return null;
  for (const d of docs) {
    const txt = d.extractedText || "";
    if (!txt || !txt.match(/WIAT/i)) continue;
    const sc = parseWIATScores(txt);
    // Need at least 3 subtests parsed to consider valid
    const filled = Object.values(sc).filter((v) => v && v.ss != null).length;
    if (filled < 3) continue;
    const { text, unfilled } = buildWIATText(sc, firstName || "[firstName]", pronouns);
    return { text, unfilled };
  }
  return null;
}

// VMI: MANUAL PERCENTILE ENTRY → TEMPLATE + SUMMARY
function vmiPercentileToRange(pct) {
  const n = parseFloat(pct);
  if (isNaN(n) || n < 0) return null;
  if (n <= 2) return "Very Low";
  if (n <= 8) return "Low";
  if (n <= 24) return "Low Average";
  if (n <= 74) return "Average";
  if (n <= 90) return "Above Average";
  if (n <= 97) return "High";
  return "Very High";
}

function buildVMIText(percentile, firstName, pronounKey) {
  const range = vmiPercentileToRange(percentile);
  if (!range) return null;

  let text = personalize(VMI_TEMPLATE, firstName, pronounKey);
  text = text.replace(/\[VMI_RANGE\]/g, range);
  text = text.replace(/\[VMI_PERCENTILE\]/g, String(percentile) + (String(percentile).match(/\d+(st|nd|rd|th)$/i) ? "" : getSuffix(percentile)));

  // Select summary based on range
  let summary = "";
  const lowRanges = ["Very Low", "Low", "Low Average"];
  const highRanges = ["Above Average", "High", "Very High"];
  const pr = PRONOUN_MAP[pronounKey] || PRONOUN_MAP["he/him"];
  const capSubject = pr.subject.charAt(0).toUpperCase() + pr.subject.slice(1);

  if (lowRanges.includes(range)) {
    summary = `Taken together, these results suggest that ${firstName} may experience difficulty with tasks that require coordination between visual perception and motor output. This may at times affect handwriting, copying information, organizing written work, and completing paper and pencil tasks efficiently. Support and accommodations may help improve performance in tasks requiring visual motor coordination.`;
  } else if (range === "Average") {
    summary = `Taken together, these results suggest that ${firstName} demonstrates age appropriate visual motor integration skills. ${capSubject} is expected to complete tasks requiring coordination between visual perception and motor output effectively in most academic situations.`;
  } else if (highRanges.includes(range)) {
    summary = `Taken together, these results suggest that ${firstName} demonstrates strong visual motor integration skills. This ability supports efficient performance in tasks requiring visual motor coordination, including handwriting, copying, and visually guided written work.`;
  }

  return text + "\n\n" + summary;
}

function getSuffix(n) {
  const num = parseInt(n, 10);
  if (isNaN(num)) return "th";
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (num % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

// ── WAIS-IV / WPPSI-IV DETERMINISTIC GENERATION HELPERS ──

function percentileToDescriptor(pct) {
  const n = parseFloat(pct);
  if (isNaN(n) || n < 0) return null;
  if (n >= 98) return "Very High";
  if (n >= 91) return "High";
  if (n >= 75) return "Above Average";
  if (n >= 25) return "Average";
  if (n >= 9) return "Low Average";
  if (n >= 3) return "Low";
  if (n >= 1) return "Very Low";
  return "Very Low";
}

function descriptorToStrengthLabel(descriptor) {
  if (!descriptor) return "an area of expected development";
  const d = descriptor.toLowerCase();
  if (d === "very high" || d === "high" || d === "above average") return "a relative strength";
  if (d === "average") return "an area of expected development";
  return "an area of somewhat weaker development";
}

function fillWAISCognitiveTemplate(waisManual, firstName, pronouns) {
  const m = waisManual || {};
  let text = WAIS_COG_TEMPLATE;

  const fsiqDesc = percentileToDescriptor(m.fsiqPercentile);
  const vciDesc = percentileToDescriptor(m.vciPercentile);
  const priDesc = percentileToDescriptor(m.priPercentile);
  const wmiDesc = percentileToDescriptor(m.wmiPercentile);
  const psiDesc = percentileToDescriptor(m.psiPercentile);

  text = text.replace(/\[FSIQ_SCORE\]/g, m.fsiqScore || "___");
  text = text.replace(/\[FSIQ_PERCENTILE\]/g, m.fsiqPercentile ? String(m.fsiqPercentile) + getSuffix(m.fsiqPercentile) : "___");
  text = text.replace(/\[FSIQ_DESCRIPTOR\]/g, fsiqDesc || "___");

  text = text.replace(/\[VCI_SCORE\]/g, m.vciScore || "___");
  text = text.replace(/\[VCI_PERCENTILE\]/g, m.vciPercentile ? String(m.vciPercentile) + getSuffix(m.vciPercentile) : "___");
  text = text.replace(/\[VCI_DESCRIPTOR\]/g, vciDesc || "___");
  text = text.replace(/\[VCI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(vciDesc));

  text = text.replace(/\[PRI_SCORE\]/g, m.priScore || "___");
  text = text.replace(/\[PRI_PERCENTILE\]/g, m.priPercentile ? String(m.priPercentile) + getSuffix(m.priPercentile) : "___");
  text = text.replace(/\[PRI_DESCRIPTOR\]/g, priDesc || "___");
  text = text.replace(/\[PRI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(priDesc));

  text = text.replace(/\[WMI_SCORE\]/g, m.wmiScore || "___");
  text = text.replace(/\[WMI_PERCENTILE\]/g, m.wmiPercentile ? String(m.wmiPercentile) + getSuffix(m.wmiPercentile) : "___");
  text = text.replace(/\[WMI_DESCRIPTOR\]/g, wmiDesc || "___");
  text = text.replace(/\[WMI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(wmiDesc));

  text = text.replace(/\[PSI_SCORE\]/g, m.psiScore || "___");
  text = text.replace(/\[PSI_PERCENTILE\]/g, m.psiPercentile ? String(m.psiPercentile) + getSuffix(m.psiPercentile) : "___");
  text = text.replace(/\[PSI_DESCRIPTOR\]/g, psiDesc || "___");
  text = text.replace(/\[PSI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(psiDesc));

  text = text.replace(/\[WAIS_STRENGTHS\]/g, m.strengths?.trim() || "verbal reasoning and visual reasoning");
  text = text.replace(/\[WAIS_WEAKER_AREAS\]/g, m.weakerAreas?.trim() || "processing efficiency and working memory demands");

  // ── Subtest replacements ──
  const waisSubs = ["SI","VC","IN","BD","MR","VP","DS","AR","SS","CD"];
  for (const abbr of waisSubs) {
    const scaled = m[`sub_${abbr}_scaled`] || "___";
    const pct = m[`sub_${abbr}_pct`] ? String(m[`sub_${abbr}_pct`]) + getSuffix(m[`sub_${abbr}_pct`]) : "___";
    text = text.replace(new RegExp(`\\[${abbr}_SCALED\\]`, "g"), scaled);
    text = text.replace(new RegExp(`\\[${abbr}_PERCENTILE\\]`, "g"), pct);
  }

  text = personalize(text, firstName, pronouns);
  text = capitalizeSentences(text);
  return text;
}

function fillWPPSICognitiveTemplate(wppsiManual, firstName, pronouns) {
  const m = wppsiManual || {};
  let text = WPPSI_COG_TEMPLATE;

  const fsiqDesc = percentileToDescriptor(m.fsiqPercentile);
  const vciDesc = percentileToDescriptor(m.vciPercentile);
  const vsiDesc = percentileToDescriptor(m.vsiPercentile);
  const friDesc = percentileToDescriptor(m.friPercentile);
  const wmiDesc = percentileToDescriptor(m.wmiPercentile);
  const psiDesc = percentileToDescriptor(m.psiPercentile);

  text = text.replace(/\[FSIQ_SCORE\]/g, m.fsiqScore || "___");
  text = text.replace(/\[FSIQ_PERCENTILE\]/g, m.fsiqPercentile ? String(m.fsiqPercentile) + getSuffix(m.fsiqPercentile) : "___");
  text = text.replace(/\[FSIQ_DESCRIPTOR\]/g, fsiqDesc || "___");

  text = text.replace(/\[VCI_SCORE\]/g, m.vciScore || "___");
  text = text.replace(/\[VCI_PERCENTILE\]/g, m.vciPercentile ? String(m.vciPercentile) + getSuffix(m.vciPercentile) : "___");
  text = text.replace(/\[VCI_DESCRIPTOR\]/g, vciDesc || "___");
  text = text.replace(/\[VCI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(vciDesc));

  text = text.replace(/\[VSI_SCORE\]/g, m.vsiScore || "___");
  text = text.replace(/\[VSI_PERCENTILE\]/g, m.vsiPercentile ? String(m.vsiPercentile) + getSuffix(m.vsiPercentile) : "___");
  text = text.replace(/\[VSI_DESCRIPTOR\]/g, vsiDesc || "___");
  text = text.replace(/\[VSI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(vsiDesc));

  text = text.replace(/\[FRI_SCORE\]/g, m.friScore || "___");
  text = text.replace(/\[FRI_PERCENTILE\]/g, m.friPercentile ? String(m.friPercentile) + getSuffix(m.friPercentile) : "___");
  text = text.replace(/\[FRI_DESCRIPTOR\]/g, friDesc || "___");
  text = text.replace(/\[FRI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(friDesc));

  text = text.replace(/\[WMI_SCORE\]/g, m.wmiScore || "___");
  text = text.replace(/\[WMI_PERCENTILE\]/g, m.wmiPercentile ? String(m.wmiPercentile) + getSuffix(m.wmiPercentile) : "___");
  text = text.replace(/\[WMI_DESCRIPTOR\]/g, wmiDesc || "___");
  text = text.replace(/\[WMI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(wmiDesc));

  text = text.replace(/\[PSI_SCORE\]/g, m.psiScore || "___");
  text = text.replace(/\[PSI_PERCENTILE\]/g, m.psiPercentile ? String(m.psiPercentile) + getSuffix(m.psiPercentile) : "___");
  text = text.replace(/\[PSI_DESCRIPTOR\]/g, psiDesc || "___");
  text = text.replace(/\[PSI_STRENGTH_OR_WEAKER\]/g, descriptorToStrengthLabel(psiDesc));

  text = text.replace(/\[WPPSI_STRENGTHS\]/g, m.strengths?.trim() || "language based reasoning and visual spatial skills");
  text = text.replace(/\[WPPSI_WEAKER_AREAS\]/g, m.weakerAreas?.trim() || "processing efficiency and sustained attention demands");

  // ── Subtest replacements ──
  const wppsiSubs = ["RV","IN","BD","OA","MR","PC","PM","ZL","BS","CA","SI","VC","CO","AC","PN"];
  for (const abbr of wppsiSubs) {
    const scaled = m[`sub_${abbr}_scaled`] || "___";
    const pct = m[`sub_${abbr}_pct`] ? String(m[`sub_${abbr}_pct`]) + getSuffix(m[`sub_${abbr}_pct`]) : "___";
    text = text.replace(new RegExp(`\\[${abbr}_SCALED\\]`, "g"), scaled);
    text = text.replace(new RegExp(`\\[${abbr}_PERCENTILE\\]`, "g"), pct);
  }

  // ── Conditionally append supplemental subtests to each index section ──
  const suppDefs = {
    SI: { section: "VCI_STRENGTH_OR_WEAKER", desc: "Similarities, which measures verbal concept formation and abstract reasoning" },
    VC: { section: "VCI_STRENGTH_OR_WEAKER", desc: "Vocabulary, which measures word knowledge and verbal concept formation" },
    CO: { section: "VCI_STRENGTH_OR_WEAKER", desc: "Comprehension, which measures practical reasoning and social understanding" },
    PN: { section: "VCI_STRENGTH_OR_WEAKER", desc: "Picture Naming, which measures expressive vocabulary and word retrieval" },
    AC: { section: "PSI_STRENGTH_OR_WEAKER", desc: "Animal Coding, which measures processing speed, associative learning, and graphomotor skills" },
  };
  for (const [abbr, info] of Object.entries(suppDefs)) {
    if (m[`sub_${abbr}_scaled`] && m[`sub_${abbr}_scaled`] !== "___") {
      const scaled = m[`sub_${abbr}_scaled`];
      const pct = m[`sub_${abbr}_pct`] ? String(m[`sub_${abbr}_pct`]) + getSuffix(m[`sub_${abbr}_pct`]) : "___";
      const sentence = ` Additionally, ${firstName} scored ${scaled} on ${info.desc} (${pct} percentile).`;
      const marker = new RegExp(`(This pattern suggests that [^.]*?represents \\[${info.section}\\])`, "i");
      text = text.replace(marker, sentence + " $1");
    }
  }

  text = personalize(text, firstName, pronouns);
  text = capitalizeSentences(text);
  return text;
}
async function aiGen(meta, tools, prompt, strat, ctx, docs, toneRules, maxTokens, sectionId, accessPassword, proxyUrl, apiKey, signal, model) {
  const openaiModel = model || OPENAI_MODEL_DEFAULT;
  // Determine endpoint and auth — OpenAI only
  let apiEndpoint, headers;

  if (apiKey) {
    // Has OpenAI API key — use it (works both locally via Vite proxy and deployed via Vercel serverless function)
    apiEndpoint = OPENAI_API_ENDPOINT;
    headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
  } else if (!IS_LOCAL && accessPassword && proxyUrl) {
    // Deployed mode: use Cloudflare proxy + access password
    apiEndpoint = proxyUrl.replace(/\/+$/, "") + "/v1/chat/completions";
    headers = { "Content-Type": "application/json", "X-Access-Password": accessPassword };
  } else {
    // No API key and no proxy — cannot generate
    return { ok: false, text: "No OpenAI API key found. Please enter your API key in Settings (⚙️ icon) to enable AI generation." };
  }

  const tNames = tools.filter((t) => t.used).map((t) => t.name).join(", ");
  const pr = PRONOUN_MAP[meta.pronouns] || PRONOUN_MAP["he/him"];
  const derivedFirstName = (meta.fullName || "").trim().split(/\s+/)[0] || "";
  const activeToneRules = toneRules || GLOBAL_TONE_RULES;

  // Build PII map from Case Info fields
  const piiMap = buildPiiMap(meta);

    // For appendix_tables, use a minimal system prompt that doesn't conflict with HTML output
  const aiCogTest = tools.find(t => t.id === "wais-iv" && t.used) ? "wais-iv" : tools.find(t => t.id === "wppsi-iv" && t.used) ? "wppsi-iv" : "wisc-v";
  const cogTableLabel = aiCogTest === "wais-iv" ? "WAIS-IV" : "WISC-V";
  const systemPrompt = sectionId === "appendix_tables"
    ? [
        "You are a psychoeducational report score table generator.",
        `You will ALWAYS generate exactly 3 tables: Table 1 (${cogTableLabel} Subtest Score Summary), Table 2 (${cogTableLabel} Index Score Summary), Table 3 (WIAT-III Subtest Score Summary).`,
        "You will NEVER add additional tables. You will NEVER modify table structure, column names, or row names.",
        "You will populate tables using ONLY values explicitly present in the provided document excerpts.",
        "You will NOT calculate, estimate, infer, derive, or generate any values.",
        "You will copy values exactly as written in the source.",
        "If a value is not explicitly present, insert the em-dash symbol: —",
        "You will NEVER leave cells blank. You will NEVER remove rows. You will NEVER remove tables.",
        "Output ONLY valid HTML. No markdown, no code blocks (no ```), no explanatory text before or after.",
        "Every table must use inline styles for professional formatting: border-collapse:collapse, Times New Roman font, alternating row colors, bold index rows.",
        "NOTE: The student is referred to as [STUDENT] or [FIRST_NAME] in the text. Use [FIRST_NAME] in table titles.",
      ].join("\n")
    : [
        GLOBAL_REPORT_RULES,
        "",
        activeToneRules,
        "",
        `Student first name (use ONLY this token, never the full name): "[FIRST_NAME]"`,
        "",
        "=== PRONOUN NORMALIZATION AND AUTOMATIC REPLACEMENT ===",
        "Step 1: Normalize all pronouns into [pronoun] placeholder.",
        "Scan your entire output and any provided text. Replace every gendered pronoun (HE, SHE, HIM, HER, HIS) with [pronoun]. This applies to uppercase, lowercase, and mixed case. Do not leave any HE/SHE/HIM/HER/HIS placeholders. Keep [firstName] and [FIRST_NAME] unchanged.",
        "",
        "Step 2: Replace [pronoun] with the correct grammatical form using these inputs:",
        `  subject pronoun: ${pr.subject}`,
        `  object pronoun: ${pr.object}`,
        `  possessive adjective: ${pr.possessive}`,
        "",
        "Rules:",
        `  Use subject pronoun (${pr.subject}) when the pronoun performs the action. Example: ${pr.subject} completed the task.`,
        `  Use object pronoun (${pr.object}) when the pronoun receives the action. Example: the assessor asked ${pr.object}.`,
        `  Use possessive adjective (${pr.possessive}) when showing ownership. Example: ${pr.possessive} score was high.`,
        "",
        "Step 3: Preserve all original writing quality. Do not change sentence wording, order, tone, punctuation, or capitalization. Only replace pronouns.",
        "Step 4: Output only the corrected text. No explanations, no comments, no brackets after final replacement.",
        "=== END PRONOUN INSTRUCTIONS ===",
        "",
        `Writing strategy: ${strat.name || "Standard"}`,
        `Strategy guidance: ${strat.desc || "Use standard professional tone."}`,
        "",
        "IMPORTANT: The student is referred to as [FIRST_NAME] throughout the provided text. Always use [FIRST_NAME] in your output — it will be automatically replaced with the real name.",
      ].join("\n");

  // PRIVACY: Do NOT send raw PDF/image files. Only send de-identified extracted text.

  // Include de-identified text excerpts from documents
  const docExcerpts = formatDocExcerpts(docs);
  const deidentifiedExcerpts = deidentifyText(docExcerpts, piiMap);

  const userParts = [
    "=== STUDENT INFORMATION ===",
    "Name: [STUDENT]",
    "Age: " + (meta.ageAtTesting || "(not provided)"),
    "Grade: " + (meta.grade || "(not provided)"),
    "School: [SCHOOL]",
    "Tests administered: " + (tNames || "(none selected)"),
    "",
    "=== SECTION INSTRUCTIONS ===",
    prompt || "(No section specific instructions provided.)",
    "",
    "=== DOCUMENT EXCERPTS ===",
    deidentifiedExcerpts,
  ];

  if (ctx && ctx.trim()) {
    userParts.push("", "=== ASSESSMENT NOTES ===", deidentifyText(ctx.trim(), piiMap));
  }

  userParts.push("", "Write only the section content. Do not include the section title or heading. Use [FIRST_NAME] for the student's name.");
  const userMessage = userParts.join("\n");


  try {
      // OpenAI-compatible API (local or proxy) with auto-retry on rate limit
      const requestBody = {
        model: openaiModel,
        max_tokens: maxTokens || 4000,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      };

      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const fetchOpts = {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        };
        if (signal) fetchOpts.signal = signal;
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), 90000);
        if (!fetchOpts.signal) fetchOpts.signal = timeoutController.signal;

        const res = await fetch(apiEndpoint, fetchOpts);
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          if (res.status === 429) {
            if (attempt < MAX_RETRIES) {
              const waitSec = (attempt + 1) * 15;
              await new Promise(r => setTimeout(r, waitSec * 1000));
              continue;
            }
            return { ok: false, text: "Rate limited after retries. Wait 1-2 min, or switch to gpt-4o-mini in settings (higher rate limits)." };
          }
          if (res.status === 401) return { ok: false, text: "Invalid API key. Check your OpenAI API key in Settings." };
          if (res.status === 504 || res.status === 529) return { ok: false, text: "Request timed out or API overloaded. Please try again." };
          if (res.status === 402 || res.status === 403) return { ok: false, text: "API access denied. Check your account has available credits." };
          return { ok: false, text: `API error (${res.status}): ${errBody?.error?.message || errBody?.error || "Unknown error"}` };
        }

        const d = await res.json();
        let text = d.choices?.[0]?.message?.content || "";
        if (!text) return { ok: false, text: "Generation returned empty." };
        text = reidentifyText(text, meta);
        return { ok: true, text };
      }
  } catch (e) {
    if (e.name === "AbortError") {
      return { ok: false, text: signal?.aborted ? "Generation cancelled." : "Generation timed out (90s). Try a shorter section or simpler prompt." };
    }
    if (e.message?.includes("Failed to fetch") || e.message?.includes("NetworkError") || e.message?.includes("did not match")) {
      return { ok: false, text: "Network error. Check your connection and OpenAI API key in Settings." };
    }
    return { ok: false, text: "Generation error: " + e.message };
  }
}

// EXPORT: DOCX (HTML-based Word document with Word headers/footers)
function buildReportHtml(meta, secs, tools, usedToolsStr) {
  // Determine cognitive test type from age first, then tool selection
  let cogTestType = "wisc-v";
  if (meta.dob && meta.dateOfTesting) {
    const totalMonths = calcAgeObj(meta.dob, meta.dateOfTesting)?.totalMonths;
    if (totalMonths != null) {
      if (totalMonths >= 203) cogTestType = "wais-iv";
      else if (totalMonths < 83) cogTestType = "wppsi-iv";
    }
  }
  if (cogTestType === "wisc-v") {
    if (tools.find(t => t.id === "wais-iv" && t.used)) cogTestType = "wais-iv";
    else if (tools.find(t => t.id === "wppsi-iv" && t.used)) cogTestType = "wppsi-iv";
  }
  const escape = (t) => (t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nl2p = (t) => escape(t).split(/\n\n+/).map((p) => `<p style="text-align:justify;line-height:1.5;margin:0 0 0 0;font-size:12pt">${p.replace(/\n/g, "<br/>")}</p>`).join("");
  const derivedFirstName = (meta.fullName || "").trim().split(/\s+/)[0] || "";

  // Build section content with prepends
  function getSectionContent(id) {
    let c = secs[id]?.content;
    if (id === "background") {
      const opening = personalize(BG_STANDARD_OPENING, derivedFirstName, meta.pronouns);
      c = c ? opening + "\n\n" + c : opening;
    }
    if (id === "observations") {
      c = c ? capitalizeSentences(personalize(c, derivedFirstName, meta.pronouns)) : "";
    }
    if (id === "cognitive") {
      // COG_STANDARD_OPENING is now rendered between R&I heading and Cognitive heading
      // Don't prepend it to content
    }
    if (c) c = cleanAIOutput(c.replace(/[⟦⟧]/g, ""), id);
    return c;
  }

  const boldHeading = (text) => `<p style="font-weight:bold;font-size:14pt;margin:12pt 0 6pt 0;text-align:left;line-height:1.5">${escape(text)}</p>`;
  const boldUnderlineHeading = (text) => `<p style="font-weight:bold;text-decoration:underline;font-size:14pt;margin:12pt 0 6pt 0;text-align:left;line-height:1.5">${escape(text)}</p>`;

  const detailRows = [
    ["Name of the student:", meta.fullName],
    ["D.O.B.:", formatDate(meta.dob)],
    ["School attended:", meta.school],
    ["Age of the student:", meta.ageAtTesting],
    ["Grade level:", meta.grade],
  ];
  const detailRows2 = [
    ["Testing Dates:", formatTestingDates(meta.testingDates)],
    ["Tests administered:", usedToolsStr],
  ];
  const detailRows3 = [
    ["Report Date:", formatDate(meta.reportDate)],
    ["Written by:", (meta.author || "") + (meta.authorTitle ? `, ${meta.authorTitle}` : "")],
  ];

  const classTable = [
    ["Very Superior", ">98th"], ["Superior", "92nd to 97th"], ["High Average", "75th to 90th"],
    ["Average", "25th to 74th"], ["Low Average", "9th to 24th"], ["Low", "2nd to 8th"], ["Very Low", "<2nd"],
  ];

  // Build all main body sections
  let bodyHtml = "";

  // Logo + Title (first page header)
  bodyHtml += `<div style="text-align:center;margin-bottom:16pt">`;
  bodyHtml += `<img src="${LOGO_B64}" width="72" height="72" style="display:block;margin:0 auto 8pt auto" />`;
  bodyHtml += `<p style="text-align:center;font-size:18pt;font-weight:bold;letter-spacing:0.04em;margin:0">PSYCHOEDUCATIONAL ASSESSMENT REPORT</p>`;
  bodyHtml += `</div>`;

  // Case info block
  const renderRows = (rows) => rows.map(([l, v]) => `<tr><td style="font-weight:bold;padding:1pt 12pt 1pt 0;white-space:nowrap;vertical-align:top;font-size:12pt">${escape(l)}</td><td style="padding:1pt 0;vertical-align:top;font-size:12pt">${escape(v || "\u2014")}</td></tr>`).join("\n");
  bodyHtml += `<table style="font-size:12pt;margin-bottom:4pt"><tbody>\n${renderRows(detailRows)}\n</tbody></table>`;
  bodyHtml += `<br/><table style="font-size:12pt;margin-bottom:4pt"><tbody>\n${renderRows(detailRows2)}\n</tbody></table>`;
  bodyHtml += `<br/><table style="font-size:12pt;margin-bottom:4pt"><tbody>\n${renderRows(detailRows3)}\n</tbody></table><br/>`;

  // Interpretation Note
  const interpNote = getSectionContent("interpretation_note");
  if (interpNote) {
    bodyHtml += boldHeading("A Note on the Interpretation of Assessment Results");
    bodyHtml += nl2p(interpNote);
  }

  // Referral
  const referral = getSectionContent("referral");
  if (referral) {
    bodyHtml += boldHeading("Reasons for Referral");
    bodyHtml += nl2p(referral);
  }

  // Background
  const bg = getSectionContent("background");
  if (bg) {
    bodyHtml += boldHeading("Background Information");
    bodyHtml += nl2p(bg);
  }

  // Review of Documents
  const docRev = getSectionContent("doc_review");
  if (docRev) {
    bodyHtml += boldHeading("Review of Documents");
    bodyHtml += nl2p(docRev);
  }

  // Observations
  const obs = getSectionContent("observations");
  if (obs) {
    bodyHtml += boldHeading("Behavioural Observations");
    bodyHtml += nl2p(obs);
  }

  // RESULTS AND INTERPRETATION heading, then Cognitive
  const cog = getSectionContent("cognitive");
  if (cog) {
    bodyHtml += boldHeading("Results and Interpretation");
    bodyHtml += `<p style="text-align:justify;line-height:1.5;margin:0;font-size:12pt">The actual test scores contained within this report are attached as an appendix. Please note all testing was completed. A summary of the trends that emerged is included in the sections that follow. From a review of these results the following patterns of abilities, skills and needs emerge.</p>`;
    bodyHtml += boldHeading("Cognitive/Intellectual Functioning");
    bodyHtml += nl2p(cog);
  }

  // Memory
  const mem = getSectionContent("memory");
  if (mem) {
    bodyHtml += boldHeading("Memory and Learning");
    bodyHtml += nl2p(mem);
  }

  // Visual Motor
  const vmi = getSectionContent("visual_motor");
  if (vmi) {
    bodyHtml += boldHeading("Visual-Motor Integration");
    bodyHtml += nl2p(vmi);
  }

  // Social-Emotional
  const se = getSectionContent("social_emotional");
  if (se) {
    bodyHtml += boldHeading("Social-Emotional Functioning");
    bodyHtml += nl2p(se);
  }

  // Adaptive
  const adp = getSectionContent("adaptive");
  if (adp) {
    bodyHtml += boldHeading("Development and Adaptive Functioning");
    bodyHtml += nl2p(adp);
  }

  // Academic
  const acad = getSectionContent("academic");
  if (acad) {
    bodyHtml += boldHeading("Academic Testing");
    bodyHtml += nl2p(acad);
  }

  // Summary, Formulation & Diagnosis
  const summ = getSectionContent("summary");
  if (summ) {
    bodyHtml += boldHeading("Summary, Formulation and Diagnosis");
    bodyHtml += nl2p(summ);
  }

  // Strengths and Needs (bold + underline per template) — bullet point format
  const sn = getSectionContent("strengths_needs");
  if (sn) {
    bodyHtml += boldUnderlineHeading("Strengths and Needs");
    const snParts = sn.split(/\n\s*(WEAKNESSES|NEEDS)\s*\n?/i);
    const snStrengths = (snParts[0] || "").replace(/^\s*STRENGTHS\s*\n?/i, "").trim();
    const snWeaknesses = (snParts[2] || snParts[1] || "").trim();
    const toItems = (text) => text.split("\n").map(l => l.trim()).filter(l => l.length > 0).map(l => l.replace(/^[•\-\*]\s*/, ""));
    const sItems = toItems(snStrengths);
    const wItems = toItems(snWeaknesses);
    const maxRows = Math.max(sItems.length, wItems.length);
    let tableHtml = `<table style="width:100%;border-collapse:collapse;border:0.5pt solid #666;font-family:'Times New Roman',Times,serif;font-size:11pt;line-height:1.0;margin:6pt 0 6pt 0">`;
    tableHtml += `<thead><tr><th style="padding:4px 10px;border:0.5pt solid #666;text-align:left;font-weight:bold;width:50%">Strengths</th><th style="padding:4px 10px;border:0.5pt solid #666;text-align:left;font-weight:bold;width:50%">Weaknesses</th></tr></thead>`;
    tableHtml += `<tbody>`;
    for (let i = 0; i < maxRows; i++) {
      tableHtml += `<tr><td style="padding:3px 10px;border:0.5pt solid #999;vertical-align:top;margin:0">${escape(sItems[i] || "")}</td><td style="padding:3px 10px;border:0.5pt solid #999;vertical-align:top;margin:0">${escape(wItems[i] || "")}</td></tr>`;
    }
    tableHtml += `</tbody></table>`;
    bodyHtml += tableHtml;
  }

  // Recommendations
  const rec = getSectionContent("recommendations");
  if (rec) {
    bodyHtml += `<br style="page-break-before:always"/>`;
    bodyHtml += boldHeading("Recommendations");
    bodyHtml += `<p style="text-align:justify;line-height:1.5;margin:0;font-size:12pt">In view of the preceding comments, the following recommendations are offered:</p>`;
    bodyHtml += nl2p(rec);
  }

  // Closing
  const closingParagraph = personalize(
    "It was a pleasure to have had the opportunity to work with [firstName]. I trust that the information contained in this report, as well as the recommendations provided above will aid in providing [object] with the most appropriate support.",
    derivedFirstName, meta.pronouns
  );
  bodyHtml += `<br/><p style="text-align:justify;line-height:1.5;margin:0;font-size:12pt">${escape(closingParagraph)}</p>`;
  bodyHtml += `<br/><p style="text-align:left;line-height:1.5;margin:0;font-size:12pt">Sincerely yours,</p><br/><br/>`;
  bodyHtml += `<p style="margin:0;font-size:12pt">________________________</p>`;
  bodyHtml += `<p style="margin:0;font-size:12pt">${escape(meta.author || "Dr. Ewa J. Antczak, C.Psych.")}</p>`;
  bodyHtml += `<p style="margin:0;font-size:12pt">${escape(meta.authorTitle || "School Psychologist")}</p>`;

  // APPENDIX - Recommendations
  const appx = getSectionContent("appendix");
  if (appx) {
    bodyHtml += `<br style="page-break-before:always"/>`;
    bodyHtml += boldHeading("Appendix - Recommendations");
    bodyHtml += `<p style="text-align:justify;line-height:1.5;margin:0;font-size:12pt">The following more specific recommendations are made with a view to promoting ${escape(derivedFirstName || "the student")}'s optimal functioning.</p>`;
    bodyHtml += `<p style="text-align:justify;line-height:1.5;margin:0;font-size:12pt;font-style:italic">Note that some of these recommendations may not be currently relevant, but should be applied if issues arise in later years.</p>`;
    bodyHtml += nl2p(appx);
  }

  // APPENDIX - Bell Curve
  bodyHtml += `<br style="page-break-before:always"/>`;
  bodyHtml += boldHeading("Appendix - Bell Curve");
  bodyHtml += `<p style="text-decoration:underline;text-align:justify;line-height:1.5;margin:0;font-size:12pt">Description of scores and categories used in reporting cognitive and academic skills.</p>`;
  bodyHtml += `<p style="text-align:justify;line-height:1.5;margin:0;font-size:12pt">It is important to note that the results are most accurately understood within the context of the formulation and interpretation contained in the body of the report.</p>`;
  bodyHtml += `<p style="text-align:justify;line-height:1.5;margin:0;font-size:12pt">As an aid in reading the assessment results, a percentile score refers to a student's placement on a test relative to others of the same age. The higher the percentile rank, the better the performance.</p>`;
  bodyHtml += `<table style="width:100%;border-collapse:collapse;font-family:'Times New Roman',Times,serif;font-size:11pt;line-height:1.0;margin:6pt 0 6pt 0"><thead><tr><th style="text-align:left;padding:4pt 8pt;font-weight:bold;border:0.5pt solid #666;border-bottom:0.5pt solid #666">Classification</th><th style="text-align:left;padding:4pt 8pt;font-weight:bold;border:0.5pt solid #666;border-bottom:0.5pt solid #666">Range of Percentiles</th></tr></thead>`;
  bodyHtml += `<tbody>${classTable.map(([c, r]) => `<tr><td style="padding:3pt 8pt;border:0.5pt solid #999">${c}</td><td style="padding:3pt 8pt;border:0.5pt solid #999">${r}</td></tr>`).join("\n")}</tbody></table>`;

  // APPENDIX - Tables (ALWAYS included — mandatory)
  const appTables = secs.appendix_tables?.content?.replace(/[⟦⟧]/g, "")
    || buildMandatoryAppendixTablesHTML(derivedFirstName || "[firstName]", {}, cogTestType);
  bodyHtml += `<br style="page-break-before:always"/>`;
  bodyHtml += boldHeading("Appendix - Tables");
  bodyHtml += `<p style="text-align:justify;line-height:1.5;margin:0;font-size:12pt">The following represents a summary of the scores obtained across various cognitive and academic domains. Percentiles can be used to provide a means of comparison with same-aged peers. A percentile refers to the percentage of individuals who fall below a given score.</p>`;
  bodyHtml += appTables;

  return `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Psychoeducational Assessment Report</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>
  @page { size: 8.5in 11in; margin: 1in 0.9in 1in 1in; mso-footer-margin: 0.5in; }
  @page Section1 {
    mso-header-margin: 0.5in;
    mso-footer-margin: 0.5in;
    mso-header: h1;
    mso-footer: f1;
    mso-title-page: yes;
  }
  div.Section1 { page: Section1; }
  body {
    font-family: "Times New Roman", Times, serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #111;
    text-align: justify;
  }
  p {
    margin: 0;
    text-align: justify;
    font-size: 12pt;
    line-height: 1.5;
  }
  table {
    font-family: "Times New Roman", Times, serif;
    font-size: 11pt;
    line-height: 1.0;
    border-collapse: collapse;
  }
  table td, table th {
    margin: 0;
    padding: 3px 8px;
  }
  .footer-note { text-align: center; font-size: 9pt; color: #555; line-height: 1.3; margin: 0; }
</style></head>
<body>
<div class="Section1">
${bodyHtml}
<br/>
<div class="footer-note">
THIS REPORT IS CONFIDENTIAL AND ANY DISCLOSURE, COPYING OR DISTRIBUTION IS SUBJECT TO THE<br/>
PERSONAL HEALTH INFORMATION PROTECTION ACT (PHIPA), 2004
</div>
</div>
<!--[if gte mso 9]>
<div style="mso-element:header" id="h1">
<p style="font-size:10pt;margin:0;border-bottom:1px solid #ccc;padding-bottom:4pt">${escape(meta.fullName || "Student Name")}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;D.O.B. ${escape(formatDate(meta.dob) || "____")}</p>
</div>
<div style="mso-element:footer" id="f1">
<p style="text-align:center;font-size:9pt;color:#777;margin:0 0 4pt 0">Page <!--[if supportFields]><span style="mso-element:field-begin"></span> PAGE <span style="mso-element:field-end"></span><![endif]--> </p>
<p class="footer-note">THIS REPORT IS CONFIDENTIAL AND ANY DISCLOSURE, COPYING OR DISTRIBUTION IS SUBJECT TO THE</p>
<p class="footer-note">PERSONAL HEALTH INFORMATION PROTECTION ACT (PHIPA), 2004</p>
</div>
<![endif]-->
</body></html>`;
}

function exportDocx(meta, secs, tools, usedToolsStr) {
  const html = buildReportHtml(meta, secs, tools, usedToolsStr);
  const blob = new Blob(
    ['\ufeff', html],
    { type: "application/msword" }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (meta.fullName || "Student").replace(/[^a-zA-Z0-9 ]/g, "").trim();
  a.download = `Psychoeducational Report - ${safeName}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// EXPORT: PDF (html2canvas + jsPDF)
async function exportPdf(reportElement, meta) {
  if (!reportElement) throw new Error("Report element not found");
  // In the artifact environment, use the browser's print dialog for PDF
  try {
    window.print();
  } catch (e) {
    // If print fails, offer to copy the HTML content
    const html = reportElement.innerHTML;
    const blob = new Blob([`<html><head><style>body{font-family:"Times New Roman",serif;font-size:12pt;line-height:1.5;margin:0.75in 0.6in;}</style></head><body>${html}</body></html>`], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (meta.fullName || "Student").replace(/[^a-zA-Z0-9 ]/g, "").trim();
    a.download = `Psychoeducational Report - ${safeName}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

const Toast = memo(function Toast({ message, type = "info", onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4500);
    return () => clearTimeout(t);
  }, [onClose]);

  const colors = {
    error: "bg-red-600", success: "bg-emerald-600", info: "bg-indigo-600", warn: "bg-amber-500",
  };

  return (
    <div role="alert" aria-live="polite" className={`fixed bottom-6 right-6 z-[999] px-5 py-3 rounded-2xl text-white text-sm font-bold shadow-2xl flex items-center gap-3 animate-[slideUp_0.3s_ease] ${colors[type] || colors.info}`}>
      {type === "error" && <AlertTriangle size={16} />}
      {type === "success" && <CheckCircle size={16} />}
      <span>{message}</span>
      <button onClick={onClose} className="ml-2 opacity-60 hover:opacity-100"><X size={14} /></button>
    </div>
  );
});

const ConfirmModal = memo(function ConfirmModal({ message, onConfirm, onCancel }) {
  if (!message) return null;
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Confirmation dialog">
      <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4 border border-gray-200">
        <div className="flex items-start gap-3 mb-5">
          <div className="bg-amber-100 p-2 rounded-xl flex-shrink-0">
            <AlertTriangle size={20} className="text-amber-600" />
          </div>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line pt-1">{message}</p>
        </div>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-5 py-2 text-sm font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-5 py-2 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors shadow-lg"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
});

// BEHAVIOUR OBSERVATIONS MENU (left sidebar grouped checkbox menu)
const BehObsMenuGroup = memo(function BehObsMenuGroup({ title, count, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div>
      <button
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between py-1.5 px-1 rounded-lg hover:bg-gray-50 transition-colors"
      >
        <span className="text-xs font-extrabold text-gray-500 uppercase flex items-center gap-1.5" style={{ fontSize: 8, letterSpacing: "0.06em" }}>
          {title}
        </span>
        <span className="flex items-center gap-1.5">
          {count > 0 && (
            <span className="text-xs font-bold text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded-full" style={{ fontSize: 7 }}>
              {count}
            </span>
          )}
          <span className="text-gray-400" style={{ fontSize: 8 }}>{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && <div className="space-y-0.5 mt-1">{children}</div>}
    </div>
  );
});

const BehObsMenu = memo(function BehObsMenu({ menu, onChange, locked }) {
  const m = menu || BEH_OBS_DEFAULTS;

  const toggle = (field, key) => {
    if (locked) return;
    const arr = m[field] || [];
    onChange({ ...m, [field]: arr.includes(key) ? arr.filter((k) => k !== key) : [...arr, key] });
  };

  const checkItem = (field, opt) => {
    const arr = m[field] || [];
    const sel = arr.includes(opt.key);
    return (
      <label
        key={opt.key}
        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-all ${
          sel ? "bg-indigo-50 border border-indigo-200" : "hover:bg-gray-50 border border-transparent"
        } ${locked ? "opacity-50 pointer-events-none" : ""}`}
      >
        <input
          type="checkbox"
          checked={sel}
          onChange={() => toggle(field, opt.key)}
          disabled={locked}
          className="flex-shrink-0"
          style={{ accentColor: "#4f46e5" }}
        />
        <span className={`leading-snug ${sel ? "text-gray-800 font-medium" : "text-gray-600"}`} style={{ fontSize: 10 }}>{opt.label}</span>
      </label>
    );
  };

  const cnt = (field) => (m[field]?.length || 0);
  const totalSelected = Object.keys(BEH_OBS_GROUPS).reduce((n, gk) => n + cnt(gk), 0);

  return (
    <div className="w-56 flex-shrink-0 bg-white rounded-2xl border border-gray-200 p-3 shadow-sm self-start space-y-1.5">
      <div className="flex items-center justify-between pb-1">
        <p className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1" style={{ fontSize: 9 }}>
          <Eye size={10} className="text-indigo-400" /> Behaviour Observations
        </p>
        {totalSelected > 0 && (
          <span className="text-xs font-bold text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded-full" style={{ fontSize: 8 }}>
            {totalSelected}
          </span>
        )}
      </div>

      <BehObsMenuGroup title="Strengths & Engagement" count={cnt("strengths")} defaultOpen={true}>
        {BEH_OBS_GROUPS.strengths.options.map((o) => checkItem("strengths", o))}
      </BehObsMenuGroup>

      <div className="border-t border-gray-100" />

      <BehObsMenuGroup title="Attention & Behaviour" count={cnt("attention")}>
        {BEH_OBS_GROUPS.attention.options.map((o) => checkItem("attention", o))}
      </BehObsMenuGroup>

      <div className="border-t border-gray-100" />

      <BehObsMenuGroup title="Motor & Writing" count={cnt("motor")}>
        {BEH_OBS_GROUPS.motor.options.map((o) => checkItem("motor", o))}
      </BehObsMenuGroup>

      <div className="border-t border-gray-100" />

      <BehObsMenuGroup title="Validity Conclusion" count={cnt("validity")}>
        {BEH_OBS_GROUPS.validity.options.map((o) => checkItem("validity", o))}
      </BehObsMenuGroup>

      <div className="border-t border-gray-100" />

      <BehObsMenuGroup title="Validity Modifiers" count={cnt("validityModifiers")}>
        {BEH_OBS_GROUPS.validityModifiers.options.map((o) => checkItem("validityModifiers", o))}
      </BehObsMenuGroup>

      {/* Clear All */}
      <div className="pt-1 border-t border-gray-100">
        <button
          onClick={() => { if (!locked) onChange({ ...BEH_OBS_DEFAULTS }); }}
          disabled={locked || totalSelected === 0}
          className="w-full py-1.5 text-center text-gray-400 hover:text-red-500 hover:bg-red-50 font-bold uppercase rounded-lg disabled:opacity-30"
          style={{ fontSize: 7 }}
        >
          Clear All
        </button>
      </div>
    </div>
  );
});

// SOCIO-EMOTIONAL PANEL (modular test windows — scores from PDFs)
const SeTestWindow = memo(function SeTestWindow({ testWindow, onChange, onDelete, locked }) {
  return (
    <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-2.5 py-2 bg-gray-50 border-b border-gray-100">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-extrabold text-indigo-700" style={{ fontSize: 10 }}>
            {testWindow.testType === "Other" ? (testWindow.otherTestName?.trim() || "Other") : testWindow.testType}
          </span>
          <span className="text-xs text-gray-400" style={{ fontSize: 8 }}>
            ({testWindow.respondentType}{testWindow.respondentName ? ": " + testWindow.respondentName : ""})
          </span>
          {testWindow.fromToolId && (
            <span className="text-xs font-bold text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full" style={{ fontSize: 6 }}>AUTO</span>
          )}
        </div>
        <button
          onClick={onDelete}
          disabled={locked}
          className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors disabled:opacity-30"
          title="Delete test window"
        >
          <X size={11} />
        </button>
      </div>

      {/* Body */}
      <div className="p-2.5 space-y-2">
        {/* Other test name */}
        {testWindow.testType === "Other" && (
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-0.5" style={{ fontSize: 8 }}>Test Name</label>
            <input
              value={testWindow.otherTestName || ""}
              onChange={(e) => onChange({ ...testWindow, otherTestName: e.target.value })}
              disabled={locked}
              placeholder="Enter full test name..."
              className="w-full px-2 py-1 border border-gray-200 rounded-lg text-xs bg-white focus:ring-2 focus:ring-indigo-300 outline-none disabled:opacity-40"
              style={{ fontSize: 10 }}
            />
          </div>
        )}

        {/* Respondent — only for BASC-3, CBRS, Conners-4, Vineland-3, ASRS */}
        {SE_HAS_RESPONDENT.includes(testWindow.testType) && (
          <div className="flex gap-1.5">
            <div className="flex-1">
              <label className="block text-xs font-bold text-gray-500 mb-0.5" style={{ fontSize: 8 }}>Respondent</label>
              <select
                value={testWindow.respondentType}
                onChange={(e) => onChange({ ...testWindow, respondentType: e.target.value })}
                disabled={locked}
                className="w-full px-2 py-1 border border-gray-200 rounded-lg text-xs bg-white focus:ring-2 focus:ring-indigo-300 outline-none disabled:opacity-40"
                style={{ fontSize: 10 }}
              >
                {SE_RESPONDENT_TYPES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-bold text-gray-500 mb-0.5" style={{ fontSize: 8 }}>Name (optional)</label>
              <input
                value={testWindow.respondentName}
                onChange={(e) => onChange({ ...testWindow, respondentName: e.target.value })}
                disabled={locked}
                placeholder="e.g. Mrs. Smith"
                className="w-full px-2 py-1 border border-gray-200 rounded-lg text-xs bg-white focus:ring-2 focus:ring-indigo-300 outline-none disabled:opacity-40"
                style={{ fontSize: 10 }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 p-1.5 bg-indigo-50/60 border border-indigo-100 rounded-lg">
          <Upload size={9} className="text-indigo-500 flex-shrink-0" />
          <span className="text-xs text-indigo-600 leading-snug" style={{ fontSize: 7 }}>
            Scores extracted from uploaded PDF score report
          </span>
        </div>
      </div>
    </div>
  );
});

const SocioEmotionalPanel = memo(function SocioEmotionalPanel({ sec, secs, tools, onUpdateSec, locked }) {
  const sid = "social_emotional";
  const ratingScales = sec?.seRatingScales || [];
  const modifier = sec?.seModifier || "STANDARD";

  const addWithRespondent = (testType, respondentType) => {
    const newRs = makeSeTestWindow(testType, respondentType);
    onUpdateSec(sid, { seRatingScales: [...ratingScales, newRs] });
  };

  const updateTestWindow = (idx, updated) => {
    const newScales = [...ratingScales];
    newScales[idx] = updated;
    onUpdateSec(sid, { seRatingScales: newScales });
  };

  const deleteTestWindow = (idx) => {
    onUpdateSec(sid, { seRatingScales: ratingScales.filter((_, i) => i !== idx) });
  };

  const bgContent = secs?.background?.content?.trim();

  // Multi-respondent tests with their available respondent types
  const RESPONDENT_TESTS = [
    { type: "BASC-3",     resp: ["Parent", "Teacher", "Self"] },
    { type: "CBRS",       resp: ["Parent", "Teacher", "Self"] },
    { type: "Conners-4",  resp: ["Parent", "Teacher", "Self"] },
    { type: "MASC",       resp: ["Parent", "Self"] },
    { type: "Vineland-3", resp: ["Parent", "Teacher"] },
    { type: "ASRS",       resp: ["Parent", "Teacher"] },
  ];
  // Single-respondent tests
  const SIMPLE_TESTS = ["GAD-7", "PHQ-9", "CDI-2", "CARS"];

  return (
    <div className="w-60 flex-shrink-0 bg-white rounded-2xl border border-gray-200 p-3 shadow-sm self-start space-y-3" style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1" style={{ fontSize: 9 }}>
          <ShieldCheck size={10} className="text-indigo-400" /> Socio-Emotional
        </p>
        {ratingScales.length > 0 && (
          <span className="text-xs font-bold text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded-full" style={{ fontSize: 7 }}>
            {ratingScales.length}
          </span>
        )}
      </div>

      {/* Background — auto-pulled */}
      <div className="p-2 bg-indigo-50/60 border border-indigo-100 rounded-lg">
        <div className="flex items-center gap-1.5 mb-1">
          <FolderOpen size={9} className="text-indigo-500" />
          <span className="text-xs font-bold text-indigo-600" style={{ fontSize: 8 }}>Background (auto-pulled)</span>
        </div>
        <p className="text-xs text-gray-500 leading-relaxed" style={{ fontSize: 8 }}>
          {bgContent
            ? bgContent.slice(0, 120) + (bgContent.length > 120 ? "..." : "")
            : "Write the Background section first."}
        </p>
      </div>

      {/* Interview Info */}
      <div>
        <label className="block text-xs font-bold text-gray-600 mb-1" style={{ fontSize: 9 }}>Interview Information</label>
        <textarea
          value={sec?.seInterview || ""}
          onChange={(e) => onUpdateSec(sid, { seInterview: e.target.value })}
          disabled={locked}
          placeholder="Optional: observations from interviews..."
          rows={3}
          className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs resize-none focus:ring-2 focus:ring-indigo-300 outline-none disabled:opacity-40"
          style={{ fontSize: 10 }}
        />
      </div>

      {/* Modifier */}
      <div>
        <label className="block text-xs font-bold text-gray-600 mb-1" style={{ fontSize: 9 }}>Interpretation Focus</label>
        <div className="flex flex-wrap gap-1">
          {[["STANDARD","Standard"],["EMOTIONAL","Emotional"],["ADHD","ADHD"],["AUTISM","Autism"],["OTHER","Other"]].map(([val, lbl]) => (
            <button
              key={val}
              onClick={() => !locked && onUpdateSec(sid, { seModifier: val })}
              disabled={locked}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 ${
                modifier === val
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-indigo-100 hover:text-indigo-700"
              }`}
              style={{ fontSize: 9 }}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>
      {modifier === "OTHER" && (
        <textarea
          value={sec?.seOtherDesc || ""}
          onChange={(e) => onUpdateSec(sid, { seOtherDesc: e.target.value })}
          disabled={locked}
          placeholder="Describe the interpretation focus..."
          rows={2}
          className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs resize-none focus:ring-2 focus:ring-indigo-300 outline-none disabled:opacity-40"
          style={{ fontSize: 10 }}
        />
      )}

      <div className="border-t border-gray-100" />

      {/* Rating Scales — active cards */}
      <div className="space-y-2">
        <label className="text-xs font-extrabold text-gray-500 uppercase" style={{ fontSize: 8, letterSpacing: "0.06em" }}>
          Rating Scales
        </label>

        {ratingScales.length > 0 ? ratingScales.map((rs, idx) => (
          <SeTestWindow
            key={rs.id}
            testWindow={rs}
            onChange={(updated) => updateTestWindow(idx, updated)}
            onDelete={() => deleteTestWindow(idx)}
            locked={locked}
          />
        )) : (
          <p className="text-xs text-gray-400 italic text-center py-1" style={{ fontSize: 8 }}>
            Auto-added from Tests Administered, or add below.
          </p>
        )}
      </div>

      <div className="border-t border-gray-100" />

      {/* Add Respondent — multi-respondent tests */}
      <div className="space-y-1.5">
        <label className="text-xs font-extrabold text-gray-500 uppercase" style={{ fontSize: 7, letterSpacing: "0.06em" }}>
          Add Respondent
        </label>
        {RESPONDENT_TESTS.map(({ type, resp }) => (
          <div key={type} className="flex items-center gap-1">
            <span className="text-xs font-bold text-gray-700 w-16 flex-shrink-0 truncate" style={{ fontSize: 8 }}>{type}</span>
            <div className="flex gap-0.5 flex-1">
              {resp.map((r) => (
                <button
                  key={r}
                  onClick={() => addWithRespondent(type, r)}
                  disabled={locked}
                  className="flex-1 py-1 bg-gray-50 border border-gray-200 rounded text-xs font-semibold text-gray-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 transition-colors disabled:opacity-30"
                  style={{ fontSize: 7 }}
                >
                  {r === "Parent" ? "P" : r === "Teacher" ? "T" : r === "Self" ? "S" : "O"}
                </button>
              ))}
              <button
                onClick={() => addWithRespondent(type, "Other")}
                disabled={locked}
                className="py-1 px-1.5 bg-gray-50 border border-dashed border-gray-300 rounded text-xs font-semibold text-gray-400 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 transition-colors disabled:opacity-30"
                style={{ fontSize: 7 }}
              >
                +
              </button>
            </div>
          </div>
        ))}

        {/* Simple tests — single click */}
        <div className="flex flex-wrap gap-1 pt-1">
          {SIMPLE_TESTS.map((t) => (
            <button
              key={t}
              onClick={() => addWithRespondent(t, "Self")}
              disabled={locked}
              className="px-2 py-1 bg-gray-50 border border-gray-200 rounded text-xs font-semibold text-gray-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 transition-colors disabled:opacity-30"
              style={{ fontSize: 7 }}
            >
              + {t}
            </button>
          ))}
          <button
            onClick={() => addWithRespondent("Other", "Self")}
            disabled={locked}
            className="px-2 py-1 bg-gray-50 border border-dashed border-gray-300 rounded text-xs font-semibold text-gray-400 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 transition-colors disabled:opacity-30"
            style={{ fontSize: 7 }}
          >
            + Other
          </button>
        </div>
      </div>

      <div className="p-2 bg-gray-50 border border-gray-100 rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed" style={{ fontSize: 7 }}>
          P = Parent &nbsp; T = Teacher &nbsp; S = Self &nbsp; + = Other respondent
        </p>
      </div>
    </div>
  );
});

const FormulationPanel = memo(function FormulationPanel({ sec, secs, onUpdateSec, locked }) {
  const sid = "summary";
  const modifiers = sec?.formModifiers || [];

  const toggleMod = (modId) => {
    if (locked) return;
    const updated = modifiers.includes(modId)
      ? modifiers.filter((m) => m !== modId)
      : [...modifiers, modId];
    onUpdateSec(sid, { formModifiers: updated });
  };

  // Count how many source sections have content
  const filledSections = FORMULATION_SOURCE_SECTIONS.filter((s) => secs[s]?.content?.trim()).length;

  return (
    <div className="w-56 flex-shrink-0 bg-white rounded-2xl border border-gray-200 p-3 shadow-sm self-start space-y-3" style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
      <p className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1" style={{ fontSize: 9 }}>
        <ShieldCheck size={10} className="text-indigo-400" /> Formulation
      </p>

      {/* Source sections status */}
      <div className="p-2 bg-indigo-50/60 border border-indigo-100 rounded-lg">
        <div className="flex items-center gap-1.5 mb-1">
          <FolderOpen size={9} className="text-indigo-500" />
          <span className="text-xs font-bold text-indigo-600" style={{ fontSize: 8 }}>
            {filledSections}/{FORMULATION_SOURCE_SECTIONS.length} sections available
          </span>
        </div>
        <p className="text-xs text-gray-500 leading-relaxed" style={{ fontSize: 7 }}>
          All prior sections are auto-pulled into the formulation context.
        </p>
      </div>

      {/* Modifiers */}
      <div>
        <label className="block text-xs font-bold text-gray-600 mb-1.5" style={{ fontSize: 9 }}>Formulation Modifiers</label>
        <div className="space-y-1">
          {FORMULATION_MODIFIERS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => toggleMod(id)}
              disabled={locked}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors text-left disabled:opacity-40 ${
                modifiers.includes(id)
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700"
              }`}
              style={{ fontSize: 9 }}
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center rounded border flex-shrink-0" style={{
                borderColor: modifiers.includes(id) ? "rgba(255,255,255,0.5)" : "#d1d5db",
                background: modifiers.includes(id) ? "rgba(255,255,255,0.2)" : "white",
              }}>
                {modifiers.includes(id) && <span style={{ fontSize: 8 }}>✓</span>}
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {modifiers.length === 0 && (
        <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs text-amber-700 leading-relaxed" style={{ fontSize: 8 }}>
            Select at least one modifier before generating.
          </p>
        </div>
      )}

      <div className="p-2 bg-gray-50 border border-gray-100 rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed" style={{ fontSize: 7 }}>
          AI integrates all prior sections and writes the formulation based on selected modifiers. Write other sections first.
        </p>
      </div>
    </div>
  );
});

const RecommendationsPanel = memo(function RecommendationsPanel({ sec, onUpdateSec, locked }) {
  const sid = "recommendations";
  const blocks = sec?.recBlocks || [];
  const eduLevel = sec?.recEduLevel || "ELEMENTARY";

  const toggleBlock = (blockId) => {
    if (locked) return;
    const updated = blocks.includes(blockId)
      ? blocks.filter((b) => b !== blockId)
      : [...blocks, blockId];
    onUpdateSec(sid, { recBlocks: updated });
  };

  const iprcBlocks = REC_BLOCKS.filter((b) => b.group === "iprc");
  const coreBlocks = REC_BLOCKS.filter((b) => b.group === "core");
  const iprcSelected = iprcBlocks.filter((b) => blocks.includes(b.id));

  return (
    <div className="w-56 flex-shrink-0 bg-white rounded-2xl border border-gray-200 p-3 shadow-sm self-start space-y-3" style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
      <p className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1" style={{ fontSize: 9 }}>
        <ShieldCheck size={10} className="text-indigo-400" /> Recommendations
      </p>

      {/* Educational Level */}
      <div>
        <label className="block text-xs font-bold text-gray-600 mb-1" style={{ fontSize: 9 }}>Educational Level</label>
        <div className="flex flex-wrap gap-1">
          {REC_EDU_LEVELS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => !locked && onUpdateSec(sid, { recEduLevel: id })}
              disabled={locked}
              className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 ${
                eduLevel === id
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-indigo-100 hover:text-indigo-700"
              }`}
              style={{ fontSize: 8 }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-gray-100" />

      {/* IPRC Identification Categories */}
      <div>
        <label className="block text-xs font-bold text-gray-600 mb-1" style={{ fontSize: 9 }}>IPRC Identification</label>
        <p className="text-xs text-gray-400 mb-1.5" style={{ fontSize: 7 }}>
          Select categories — combined into one IPRC sentence.
        </p>
        <div className="space-y-1">
          {iprcBlocks.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => toggleBlock(id)}
              disabled={locked}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors text-left disabled:opacity-40 ${
                blocks.includes(id)
                  ? "bg-violet-600 text-white"
                  : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-violet-50 hover:border-violet-300 hover:text-violet-700"
              }`}
              style={{ fontSize: 9 }}
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center rounded border flex-shrink-0" style={{
                borderColor: blocks.includes(id) ? "rgba(255,255,255,0.5)" : "#d1d5db",
                background: blocks.includes(id) ? "rgba(255,255,255,0.2)" : "white",
              }}>
                {blocks.includes(id) && <span style={{ fontSize: 8 }}>✓</span>}
              </span>
              {label.replace("IPRC: ", "")}
            </button>
          ))}
        </div>
        {iprcSelected.length > 1 && (
          <div className="mt-1.5 p-1.5 bg-violet-50 border border-violet-100 rounded-lg">
            <p className="text-xs text-violet-700" style={{ fontSize: 7 }}>
              → One combined IPRC sentence: "...in the {iprcSelected.map((b) => b.label.replace("IPRC: ", "")).join(" and ")} {iprcSelected.length === 1 ? "category" : "categories"}..."
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-gray-100" />

      {/* Core Recommendation Blocks */}
      <div>
        <label className="block text-xs font-bold text-gray-600 mb-1.5" style={{ fontSize: 9 }}>Supports & Referrals</label>
        <div className="space-y-1">
          {coreBlocks.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => toggleBlock(id)}
              disabled={locked}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors text-left disabled:opacity-40 ${
                blocks.includes(id)
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700"
              }`}
              style={{ fontSize: 9 }}
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center rounded border flex-shrink-0" style={{
                borderColor: blocks.includes(id) ? "rgba(255,255,255,0.5)" : "#d1d5db",
                background: blocks.includes(id) ? "rgba(255,255,255,0.2)" : "white",
              }}>
                {blocks.includes(id) && <span style={{ fontSize: 8 }}>✓</span>}
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {blocks.length === 0 && (
        <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs text-amber-700 leading-relaxed" style={{ fontSize: 8 }}>
            Select at least one block before generating.
          </p>
        </div>
      )}

      <div className="p-2 bg-gray-50 border border-gray-100 rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed" style={{ fontSize: 7 }}>
          IPRC categories are combined into one sentence. IEP recommendations are personalized to the student's profile.
        </p>
      </div>
    </div>
  );
});

const AppendixPanel = memo(function AppendixPanel({ sec, secs, onUpdateSec, locked }) {
  const sid = "appendix";
  const blocks = sec?.appendixBlocks || [];
  const eduLevel = secs.recommendations?.recEduLevel || "ELEMENTARY";

  const toggleBlock = (blockId) => {
    if (locked) return;
    const updated = blocks.includes(blockId)
      ? blocks.filter((b) => b !== blockId)
      : [...blocks, blockId];
    onUpdateSec(sid, { appendixBlocks: updated });
  };

  return (
    <div className="w-56 flex-shrink-0 bg-white rounded-2xl border border-gray-200 p-3 shadow-sm self-start space-y-3" style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
      <p className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1" style={{ fontSize: 9 }}>
        <ShieldCheck size={10} className="text-indigo-400" /> Appendix
      </p>

      {/* Edu level display */}
      <div className="p-2 bg-indigo-50/60 border border-indigo-100 rounded-lg">
        <p className="text-xs text-indigo-600 font-bold" style={{ fontSize: 8 }}>
          Level: {REC_EDU_LEVELS.find((e) => e.id === eduLevel)?.label || "Elementary"}
        </p>
        <p className="text-xs text-gray-400" style={{ fontSize: 7 }}>
          Set in Recommendations tab.
        </p>
      </div>

      {/* Appendix Blocks */}
      <div>
        <label className="block text-xs font-bold text-gray-600 mb-1.5" style={{ fontSize: 9 }}>Include Sections</label>
        <div className="space-y-1">
          {APPENDIX_BLOCKS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => toggleBlock(id)}
              disabled={locked}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors text-left disabled:opacity-40 ${
                blocks.includes(id)
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700"
              }`}
              style={{ fontSize: 9 }}
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center rounded border flex-shrink-0" style={{
                borderColor: blocks.includes(id) ? "rgba(255,255,255,0.5)" : "#d1d5db",
                background: blocks.includes(id) ? "rgba(255,255,255,0.2)" : "white",
              }}>
                {blocks.includes(id) && <span style={{ fontSize: 8 }}>✓</span>}
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {blocks.length === 0 && (
        <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs text-amber-700 leading-relaxed" style={{ fontSize: 8 }}>
            Select sections to include in the appendix.
          </p>
        </div>
      )}

      <div className="p-2 bg-gray-50 border border-gray-100 rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed" style={{ fontSize: 7 }}>
          WISC-V recommendations are extracted from uploaded cognitive PDF. All other sections are personalized from report findings.
        </p>
      </div>
    </div>
  );
});

const AppendixTablesPanel = memo(function AppendixTablesPanel({ sec, secs, onUpdateSec, locked, tools, docs }) {
  const sid = "appendix_tables";
  const blocks = sec?.tableBlocks || [];

  const toggleBlock = (blockId) => {
    if (locked) return;
    const updated = blocks.includes(blockId)
      ? blocks.filter((b) => b !== blockId)
      : [...blocks, blockId];
    onUpdateSec(sid, { tableBlocks: updated });
  };

  // Group blocks by category
  const categories = {};
  TABLE_BLOCKS.forEach((b) => {
    if (!categories[b.cat]) categories[b.cat] = [];
    categories[b.cat].push(b);
  });

  // Compute which tools are active (for showing which blocks are available)
  const activeToolIds = new Set((tools || []).filter((t) => t.used).map((t) => t.id));

  // Count filled scores from docs
  const scoreMap = useMemo(() => extractAllScoresMap(docs || []), [docs]);
  const filledCount = Object.keys(scoreMap).length;

  return (
    <div className="w-56 flex-shrink-0 bg-white rounded-2xl border border-gray-200 p-3 shadow-sm self-start space-y-3" style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
      <p className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1" style={{ fontSize: 9 }}>
        <ShieldCheck size={10} className="text-indigo-400" /> Score Tables
      </p>

      {/* Score extraction status */}
      {filledCount > 0 && (
        <div className="p-2 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-xs font-bold text-green-700" style={{ fontSize: 8 }}>
            ✓ {filledCount} scores auto-filled from uploaded PDFs
          </p>
        </div>
      )}

      {/* Table Blocks grouped by category */}
      {Object.entries(categories).map(([cat, items]) => {
        // Only show categories that have at least one tool selected
        const relevant = items.filter((b) => activeToolIds.has(b.id));
        if (relevant.length === 0) return null;
        return (
          <div key={cat}>
            <label className="block text-xs font-bold text-gray-500 mb-1" style={{ fontSize: 8 }}>{cat}</label>
            <div className="space-y-1">
              {relevant.map(({ id, label }) => {
                const selected = blocks.includes(id);
                return (
                  <button
                    key={id}
                    onClick={() => toggleBlock(id)}
                    disabled={locked}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors text-left disabled:opacity-40 ${
                      selected
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700"
                    }`}
                    style={{ fontSize: 9 }}
                  >
                    <span className="w-3.5 h-3.5 flex items-center justify-center rounded border flex-shrink-0" style={{
                      borderColor: selected ? "rgba(255,255,255,0.5)" : "#d1d5db",
                      background: selected ? "rgba(255,255,255,0.2)" : "white",
                    }}>
                      {selected && <span style={{ fontSize: 8 }}>✓</span>}
                    </span>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {blocks.length === 0 && (
        <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs text-amber-700 leading-relaxed" style={{ fontSize: 8 }}>
            Select tools in Case Info to add score tables.
          </p>
        </div>
      )}

      <div className="p-2 bg-gray-50 border border-gray-100 rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed" style={{ fontSize: 7 }}>
          Tables auto-sync from selected tools. Toggle individual tables on/off. Scores auto-fill when PDFs are uploaded.
        </p>
      </div>
    </div>
  );
});

// SECTION EDITOR (extracted outside App — wrapped in memo for perf)
const SecEd = memo(function SecEd({
  sid, secs, docs, meta, tools, customPrompts, onSavePrompt, onDeletePrompt,
  genning, onGenerate, onUpdateSec, onToggleDoc, onApplyQuick, onSecUpload, onSecDrop, showToast,
  behObsMenu, onBehObsChange,
}) {
  const s = secs[sid];
  const locked = s?.status === SS.APPROVED;
  const cats = SEC_CAT_MAP[sid] || [];
  const rel = docs.filter((d) => d.categories.some((c) => cats.includes(c)));
  const selIds = s?.docIds || [];
  const qw = QUICK_WORDING[sid];
  const title = TABS.find((t) => t.id === sid)?.label || sid;
  const [showPrompt, setShowPrompt] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const activePrompt = resolvePrompt(sid, customPrompts);
  const isCustom = !!(customPrompts && customPrompts[sid]);
  const defaultPrompt = SEC_PROMPTS[sid] || "";
  const derivedFirstName = (meta?.fullName || "").trim().split(/\s+/)[0] || "";
  const pz = useCallback((text) => personalize(text, derivedFirstName, meta?.pronouns), [derivedFirstName, meta?.pronouns]);
  const [secDragging, setSecDragging] = useState(false);

  // Age-based instrument flags for cognitive manual entry UI
  const secEdAge = useMemo(() => ageFromAgeAtTesting(meta?.ageAtTesting), [meta?.ageAtTesting]);
  const secEdUseWAIS = sid === "cognitive" && secEdAge ? secEdAge.totalMonths >= 203 : false;
  const secEdUseWPPSI = sid === "cognitive" && secEdAge ? secEdAge.totalMonths < 83 : false;

  // Debounced text input: buffer keystrokes locally, sync to parent after 300ms idle
  const [localCtx, setLocalCtx] = useState(s?.ctx || "");
  const [localContent, setLocalContent] = useState(s?.content || "");
  const ctxTimerRef = useRef(null);
  const contentTimerRef = useRef(null);

  // Sync parent → local when parent changes externally (AI generation, quick wording, etc.)
  useEffect(() => { if (s?.ctx !== undefined && s.ctx !== localCtx) setLocalCtx(s.ctx); }, [s?.ctx]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (s?.content !== undefined && s.content !== localContent) setLocalContent(s.content); }, [s?.content]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCtxChange = useCallback((e) => {
    const val = e.target.value;
    setLocalCtx(val);
    if (ctxTimerRef.current) clearTimeout(ctxTimerRef.current);
    ctxTimerRef.current = setTimeout(() => onUpdateSec(sid, { ctx: val }), 300);
  }, [sid, onUpdateSec]);

  const handleContentChange = useCallback((e) => {
    const val = e.target.value;
    setLocalContent(val);
    if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    contentTimerRef.current = setTimeout(() => onUpdateSec(sid, { content: val }), 300);
  }, [sid, onUpdateSec]);

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (ctxTimerRef.current) clearTimeout(ctxTimerRef.current);
    if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
  }, []);

  return (
    <div className="space-y-4">
      {/* Document Selection */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <h4
            className="text-xs font-extrabold text-gray-600 uppercase flex items-center gap-2"
            style={{ letterSpacing: "0.08em" }}
          >
            <FolderOpen size={13} className="text-indigo-500" /> Documents Included in This Section
          </h4>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 font-bold">{selIds.length} selected</span>
            <button
              onClick={() => onSecUpload(sid)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-extrabold uppercase hover:bg-indigo-500 transition-colors"
              style={{ fontSize: 8, letterSpacing: "0.06em" }}
            >
              <Upload size={10} /> Upload
            </button>
          </div>
        </div>
        {/* Drop zone for section */}
        <div
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setSecDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setSecDragging(false); }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSecDragging(false);
            const files = e.dataTransfer?.files;
            if (files && onSecDrop) {
              for (let i = 0; i < files.length; i++) {
                onSecDrop(files[i], sid);
              }
            }
          }}
          className={`mx-3 mt-3 border-2 border-dashed rounded-xl p-3 text-center transition-colors ${
            secDragging
              ? "border-indigo-500 bg-indigo-50/60"
              : "border-gray-200 hover:border-indigo-300"
          }`}
        >
          <p className="text-xs text-gray-400">
            {secDragging ? "Drop files here" : "Drag files here to upload for this section"}
          </p>
        </div>
        <div className="p-3">
          {docs.length === 0 ? (
            <p className="text-xs text-gray-400 italic text-center py-3">No documents uploaded yet.</p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {docs.map((d) => {
                const isR = rel.some((r) => r.id === d.id);
                const isS = selIds.includes(d.id);
                return (
                  <label
                    key={d.id}
                    className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer text-xs ${
                      isS ? "bg-indigo-50 border border-indigo-200" : "hover:bg-gray-50 border border-transparent"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isS}
                      onChange={() => onToggleDoc(sid, d.id)}
                      style={{ accentColor: "#4f46e5" }}
                    />
                    <span className="font-semibold text-gray-700 truncate flex-1">{d.name}</span>
                    {d.extractedText && d.extractedText.length > 0 && !d.extractedText.startsWith("[") && (
                      <span className="text-emerald-600 bg-emerald-50 px-1.5 rounded font-bold" style={{ fontSize: 8 }}>
                        TEXT
                      </span>
                    )}
                    {isR && (
                      <span className="text-indigo-600 bg-indigo-100 px-1.5 rounded font-bold" style={{ fontSize: 8 }}>
                        AUTO
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
        {selIds.length > 0 && (
          <div className="px-3 pb-2">
            <div className="flex items-center gap-1 text-xs text-amber-600 font-semibold bg-amber-50 px-2 py-1.5 rounded-lg">
              <AlertTriangle size={11} /> AI uses ONLY these {selIds.length} doc{selIds.length > 1 ? "s" : ""}
            </div>
          </div>
        )}
      </div>

      {/* Assessment Notes */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm space-y-3">
        <p
          className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1"
          style={{ fontSize: 9, letterSpacing: "0.08em" }}
        >
          <Quote size={11} className="text-indigo-400" /> Assessment Notes
        </p>
        <textarea
          value={localCtx}
          onChange={handleCtxChange}
          placeholder="Enter scores, observations, notes..."
          className="w-full h-24 p-3 text-xs bg-gray-50 border border-gray-100 rounded-xl outline-none resize-y leading-relaxed"
        />
      </div>

      {/* AI Generation */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm space-y-3">
        {/* AI Source Selection */}
        <div className="space-y-1.5">
          <p
            className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1"
            style={{ fontSize: 9, letterSpacing: "0.08em" }}
          >
            AI uses these sources:
          </p>
          <div className="flex flex-wrap gap-3">
            {[
              { key: "notes", label: "Assessment Notes", color: "indigo" },
              { key: "docs", label: "Selected Documents", color: "indigo" },
              { key: "draft", label: "My Observations / Current Draft", color: "amber" },
            ].map(({ key, label, color }) => (
              <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={s?.aiSources?.[key] ?? (key !== "draft")}
                  onChange={() => onUpdateSec(sid, {
                    aiSources: { ...(s?.aiSources || { notes: true, docs: true, draft: false }), [key]: !(s?.aiSources?.[key] ?? (key !== "draft")) }
                  })}
                  style={{ accentColor: color === "amber" ? "#d97706" : "#4f46e5" }}
                />
                <span className="text-xs font-semibold text-gray-600">{label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Section Prompt (collapsible, editable) */}
        <div className="border border-gray-100 rounded-xl overflow-hidden">
          <button
            onClick={() => { setShowPrompt(!showPrompt); if (!showPrompt && !editingPrompt) setPromptDraft(activePrompt); }}
            className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors"
          >
            <span className="flex items-center gap-1.5 text-xs font-bold text-gray-500" style={{ fontSize: 9 }}>
              <ChevronDown size={11} className={`transition-transform ${showPrompt ? "rotate-180" : ""}`} />
              Section Prompt
              {isCustom && <span className="ml-1 text-amber-600 bg-amber-50 px-1.5 rounded font-extrabold" style={{ fontSize: 7 }}>CUSTOM</span>}
            </span>
            {!showPrompt && (
              <span className="text-xs text-gray-400 truncate max-w-xs" style={{ fontSize: 9 }}>{activePrompt.slice(0, 60)}...</span>
            )}
          </button>
          {showPrompt && (
            <div className="p-3 space-y-2 bg-white border-t border-gray-100">
              {editingPrompt ? (
                <>
                  <textarea
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    className="w-full p-3 text-xs bg-gray-50 border border-indigo-200 rounded-xl outline-none resize-y leading-relaxed focus:border-indigo-400"
                    style={{ minHeight: 120, fontSize: 11 }}
                    placeholder="Enter your custom prompt for this section..."
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (promptDraft.trim()) {
                          onSavePrompt(sid, promptDraft.trim());
                          showToast("Prompt saved", "success");
                        }
                        setEditingPrompt(false);
                      }}
                      className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg font-extrabold uppercase hover:bg-indigo-500"
                      style={{ fontSize: 8 }}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setEditingPrompt(false); setPromptDraft(activePrompt); }}
                      className="px-3 py-1.5 bg-gray-200 text-gray-600 rounded-lg font-extrabold uppercase hover:bg-gray-300"
                      style={{ fontSize: 8 }}
                    >
                      Cancel
                    </button>
                    {isCustom && (
                      <button
                        onClick={() => {
                          onDeletePrompt(sid);
                          setPromptDraft(defaultPrompt);
                          setEditingPrompt(false);
                          showToast("Prompt reset to default", "info");
                        }}
                        className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg font-extrabold uppercase hover:bg-red-100 ml-auto"
                        style={{ fontSize: 8 }}
                      >
                        Reset to Default
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <pre
                    className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed font-sans bg-gray-50 p-3 rounded-xl border border-gray-100 max-h-40 overflow-y-auto"
                    style={{ fontSize: 10 }}
                  >
                    {activePrompt || "(no prompt)"}
                  </pre>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setPromptDraft(activePrompt); setEditingPrompt(true); }}
                      className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg font-extrabold uppercase hover:bg-indigo-100"
                      style={{ fontSize: 8 }}
                    >
                      Edit Prompt
                    </button>
                    {isCustom && (
                      <button
                        onClick={() => {
                          onDeletePrompt(sid);
                          setPromptDraft(defaultPrompt);
                          showToast("Prompt reset to default", "info");
                        }}
                        className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg font-extrabold uppercase hover:bg-red-100"
                        style={{ fontSize: 8 }}
                      >
                        Reset to Default
                      </button>
                    )}
                    {!defaultPrompt && !isCustom && (
                      <button
                        onClick={() => { setPromptDraft(""); setEditingPrompt(true); }}
                        className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg font-extrabold uppercase hover:bg-emerald-100"
                        style={{ fontSize: 8 }}
                      >
                        Add Prompt
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Generate / Regenerate button */}
        <button
          onClick={() => onGenerate(sid)}
          disabled={genning || locked}
          className={`w-full py-2.5 ${s?.content?.trim() ? "bg-amber-500 hover:bg-amber-400" : "bg-indigo-600 hover:bg-indigo-500"} text-white rounded-xl font-extrabold uppercase flex items-center justify-center gap-2 disabled:opacity-40 shadow-lg`}
          style={{ fontSize: 10, letterSpacing: "0.08em" }}
        >
          {genning ? (
            <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : s?.content?.trim() ? (
            <RefreshCw size={14} />
          ) : (
            <Sparkles size={14} />
          )}
          {genning ? "Generating..." : s?.content?.trim() ? "Regenerate Section" : "Generate Section"}
        </button>
      </div>

      {/* Quick Wording / BehObs Menu + Editor */}
      <div className="flex gap-4">
        {/* Left sidebar: BehObsMenu for observations, SE Panel for social_emotional, Quick Wording for others */}
        {sid === "observations" ? (
          <BehObsMenu
            menu={behObsMenu}
            onChange={onBehObsChange}
            locked={locked}
          />
        ) : sid === "social_emotional" ? (
          <SocioEmotionalPanel
            sec={s}
            secs={secs}
            tools={tools}
            onUpdateSec={onUpdateSec}
            locked={locked}
          />
        ) : sid === "summary" ? (
          <FormulationPanel
            sec={s}
            secs={secs}
            onUpdateSec={onUpdateSec}
            locked={locked}
          />
        ) : sid === "recommendations" ? (
          <RecommendationsPanel
            sec={s}
            onUpdateSec={onUpdateSec}
            locked={locked}
          />
        ) : sid === "appendix" ? (
          <AppendixPanel
            sec={s}
            secs={secs}
            onUpdateSec={onUpdateSec}
            locked={locked}
          />
        ) : sid === "appendix_tables" ? (
          <AppendixTablesPanel
            sec={s}
            secs={secs}
            onUpdateSec={onUpdateSec}
            locked={locked}
            tools={tools}
            docs={docs}
          />
        ) : qw ? (
          <div className="w-48 flex-shrink-0 bg-white rounded-2xl border border-gray-200 p-3 shadow-sm self-start space-y-2">
            <p
              className="text-xs font-extrabold text-gray-400 uppercase flex items-center gap-1"
              style={{ fontSize: 9 }}
            >
              <MousePointer2 size={10} className="text-indigo-400" /> Quick Wording
            </p>
            {qw.map((t, i) => (
              <button
                key={i}
                onClick={() => onApplyQuick(sid, t.text)}
                disabled={locked}
                className="w-full p-2 bg-gray-50 hover:bg-indigo-50 border border-gray-100 rounded-xl text-left group disabled:opacity-40"
              >
                <p className="font-extrabold text-indigo-600 uppercase mb-0.5" style={{ fontSize: 8 }}>{t.label}</p>
                <p
                  className="text-gray-500 italic leading-snug"
                  style={{
                    fontSize: 8,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {t.text.slice(0, 80)}...
                </p>
              </button>
            ))}
          </div>
        ) : null}
        <div
          className="flex-1 bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col min-w-0"
          style={{ minHeight: 380 }}
        >
          <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={15} className="text-indigo-600 flex-shrink-0" />
              <h3 className="text-sm font-extrabold tracking-tight truncate">{title}</h3>
            </div>
            <button
              onClick={() => onUpdateSec(sid, { status: locked ? SS.DRAFT : SS.APPROVED })}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg font-extrabold uppercase flex-shrink-0 ${
                locked ? "bg-green-600 text-white" : "bg-white border-2 border-gray-200 text-gray-400"
              }`}
              style={{ fontSize: 9 }}
            >
              {locked ? <><Lock size={10} /> Final</> : <><Unlock size={10} /> Draft</>}
            </button>
          </div>
          <div className="flex-1 p-3">
            {sid === "background" && (
              <div
                className="mb-3 p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl"
                style={{ lineHeight: 1.7, fontFamily: "'Times New Roman', Times, serif", fontSize: "12pt", textAlign: "justify" }}
              >
                <div className="text-gray-700 mb-2">
                  {pz(BG_STANDARD_OPENING)}
                </div>
                <div className="text-gray-400 italic" style={{ fontSize: "11pt" }}>
                  {pz(BG_TEMPLATE_BODY).split("\n\n").map((p, i) => (
                    <p key={i} style={{ marginBottom: 6 }}>{p}</p>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-1">
                  <Lock size={9} className="text-indigo-400" />
                  <span className="text-xs text-indigo-400 font-bold uppercase" style={{ fontSize: 7 }}>Fixed template — AI fills {`{{placeholders}}`} from your documents</span>
                </div>
              </div>
            )}
            {sid === "cognitive" && (
              <div
                className="mb-3 p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl text-gray-700"
                style={{ lineHeight: 1.5, fontFamily: "'Times New Roman', Times, serif", fontSize: "12pt", textAlign: "justify" }}
              >
                {COG_STANDARD_OPENING}
              </div>
            )}
            {/* ── WAIS-IV Manual Score Entry (age >= 16) ── */}
            {secEdUseWAIS && (() => {
              const wm = s?.waisManual || {};
              const setWM = (field, val) => onUpdateSec(sid, { waisManual: { ...wm, [field]: val } });
              const fieldStyle = "w-20 px-2 py-1 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-indigo-300 focus:outline-none text-center";
              const labelStyle = "text-xs font-medium text-gray-600 whitespace-nowrap";
              return (
                <div className="mb-3 p-3 bg-amber-50/60 border border-amber-200 rounded-xl space-y-3">
                  <div className="flex items-center gap-2">
                    <Lock size={10} className="text-amber-500" />
                    <span className="text-xs text-amber-700 font-bold uppercase" style={{ fontSize: 7 }}>WAIS-IV Manual Score Entry (age 16+)</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                    {[
                      ["FSIQ", "fsiq"], ["VCI", "vci"], ["PRI", "pri"], ["WMI", "wmi"], ["PSI", "psi"],
                    ].map(([label, key]) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className={labelStyle} style={{ minWidth: 32 }}>{label}:</span>
                        <input placeholder="Score" value={wm[key + "Score"] || ""} onChange={(e) => setWM(key + "Score", e.target.value)} disabled={locked} className={fieldStyle} />
                        <input placeholder="PR" value={wm[key + "Percentile"] || ""} onChange={(e) => setWM(key + "Percentile", e.target.value)} disabled={locked} className={fieldStyle} />
                        {wm[key + "Percentile"] && percentileToDescriptor(wm[key + "Percentile"]) && (
                          <span className="text-xs text-gray-400 italic" style={{ fontSize: 9 }}>{percentileToDescriptor(wm[key + "Percentile"])}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className={labelStyle}>Strengths:</span>
                      <input placeholder="e.g., verbal reasoning and acquired knowledge" value={wm.strengths || ""} onChange={(e) => setWM("strengths", e.target.value)} disabled={locked} className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-indigo-300 focus:outline-none" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={labelStyle}>Weaker areas:</span>
                      <input placeholder="e.g., processing speed and working memory" value={wm.weakerAreas || ""} onChange={(e) => setWM("weakerAreas", e.target.value)} disabled={locked} className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-indigo-300 focus:outline-none" />
                    </div>
                  </div>
                  <p className="text-xs text-gray-400" style={{ fontSize: 7 }}>Enter all index scores and percentile ranks, then click Generate to fill the WAIS-IV template.</p>
                </div>
              );
            })()}
            {/* ── WPPSI-IV Manual Score Entry (age < 6) ── */}
            {secEdUseWPPSI && (() => {
              const wm = s?.wppsiManual || {};
              const setWM = (field, val) => onUpdateSec(sid, { wppsiManual: { ...wm, [field]: val } });
              const fieldStyle = "w-20 px-2 py-1 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-indigo-300 focus:outline-none text-center";
              const labelStyle = "text-xs font-medium text-gray-600 whitespace-nowrap";
              return (
                <div className="mb-3 p-3 bg-purple-50/60 border border-purple-200 rounded-xl space-y-3">
                  <div className="flex items-center gap-2">
                    <Lock size={10} className="text-purple-500" />
                    <span className="text-xs text-purple-700 font-bold uppercase" style={{ fontSize: 7 }}>WPPSI-IV Manual Score Entry (age under 6)</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                    {[
                      ["FSIQ", "fsiq"], ["VCI", "vci"], ["VSI", "vsi"], ["FRI", "fri"], ["WMI", "wmi"], ["PSI", "psi"],
                    ].map(([label, key]) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className={labelStyle} style={{ minWidth: 32 }}>{label}:</span>
                        <input placeholder="Score" value={wm[key + "Score"] || ""} onChange={(e) => setWM(key + "Score", e.target.value)} disabled={locked} className={fieldStyle} />
                        <input placeholder="PR" value={wm[key + "Percentile"] || ""} onChange={(e) => setWM(key + "Percentile", e.target.value)} disabled={locked} className={fieldStyle} />
                        {wm[key + "Percentile"] && percentileToDescriptor(wm[key + "Percentile"]) && (
                          <span className="text-xs text-gray-400 italic" style={{ fontSize: 9 }}>{percentileToDescriptor(wm[key + "Percentile"])}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className={labelStyle}>Strengths:</span>
                      <input placeholder="e.g., visual spatial skills and early reasoning" value={wm.strengths || ""} onChange={(e) => setWM("strengths", e.target.value)} disabled={locked} className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-indigo-300 focus:outline-none" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={labelStyle}>Weaker areas:</span>
                      <input placeholder="e.g., processing speed and working memory" value={wm.weakerAreas || ""} onChange={(e) => setWM("weakerAreas", e.target.value)} disabled={locked} className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-indigo-300 focus:outline-none" />
                    </div>
                  </div>
                  <p className="text-xs text-gray-400" style={{ fontSize: 7 }}>Enter all index scores and percentile ranks, then click Generate to fill the WPPSI-IV template.</p>
                </div>
              );
            })()}
            {sid === "memory" && (
              <div
                className="mb-3 p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl"
                style={{ lineHeight: 1.7, fontFamily: "'Times New Roman', Times, serif", fontSize: "11pt", textAlign: "justify", maxHeight: 200, overflowY: "auto" }}
              >
                <div className="text-gray-400 italic" style={{ fontSize: "11pt" }}>
                  {pz(MEM_TEMPLATE).split("\n\n").map((p, i) => (
                    <p key={i} style={{ marginBottom: 6 }}>{p}</p>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-1">
                  <Lock size={9} className="text-indigo-400" />
                  <span className="text-xs text-indigo-400 font-bold uppercase" style={{ fontSize: 7 }}>Fixed template — scores auto-filled from WRAML3 Score Report PDF</span>
                </div>
              </div>
            )}
            {s?.content && s.content.includes("⟦") && (
              <div className="mb-3 p-2.5 bg-amber-50 border border-amber-200 rounded-xl">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={13} className="text-amber-500" />
                    <span className="text-xs font-bold text-amber-800">
                      Review needed
                    </span>
                  </div>
                  {!locked && (
                    <button
                      onClick={() => {
                        let updated = localContent.replace(/[⟦⟧]/g, "");
                        setLocalContent(updated);
                        onUpdateSec(sid, { content: updated });
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-500 transition-colors"
                    >
                      <Check size={11} /> Mark All Reviewed
                    </button>
                  )}
                </div>
                <div className="text-xs text-amber-800 leading-relaxed">
                  Text inside <span className="font-mono bg-amber-100 px-1 rounded">⟦brackets⟧</span> was auto-generated from scores and needs your review.
                  {sid === "academic" && " Placeholders ⟦___⟧ could not be auto-filled — please enter the scores manually."}
                  {" "}Edit the text if needed, then click <span className="font-semibold">Mark All Reviewed</span> to finalize.
                </div>
              </div>
            )}
            {sid === "visual_motor" && (
              <div className="mb-3 space-y-3">
                <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl">
                  <div className="flex items-center gap-2 mb-2">
                    <Lock size={10} className="text-indigo-400" />
                    <span className="text-xs text-indigo-500 font-bold uppercase" style={{ fontSize: 7 }}>Manual percentile entry — template auto-populated</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-medium text-gray-700 whitespace-nowrap">Beery VMI Percentile:</label>
                    <input
                      type="number"
                      min="0.1"
                      max="99.9"
                      step="0.1"
                      value={s?.vmiPercentile ?? ""}
                      onChange={(e) => onUpdateSec(sid, { vmiPercentile: e.target.value })}
                      placeholder="e.g. 5"
                      className="w-24 px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 outline-none"
                      style={{ fontSize: "13px" }}
                    />
                    {s?.vmiPercentile && vmiPercentileToRange(s.vmiPercentile) && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                        {vmiPercentileToRange(s.vmiPercentile)}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-gray-500">Enter the percentile from the Beery VMI report, then click <span className="font-semibold">Generate</span> to auto-fill the template with the correct range and summary.</div>
                </div>
                <div
                  className="p-3 bg-indigo-50/30 border border-indigo-100/60 rounded-xl"
                  style={{ lineHeight: 1.7, fontFamily: "'Times New Roman', Times, serif", fontSize: "11pt", textAlign: "justify", maxHeight: 160, overflowY: "auto" }}
                >
                  <div className="text-gray-400 italic" style={{ fontSize: "11pt" }}>
                    {pz(VMI_TEMPLATE)}
                  </div>
                </div>
              </div>
            )}
            {sid === "academic" && (
              <div
                className="mb-3 p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl"
                style={{ lineHeight: 1.7, fontFamily: "'Times New Roman', Times, serif", fontSize: "11pt", textAlign: "justify", maxHeight: 200, overflowY: "auto" }}
              >
                <div className="text-gray-400 italic" style={{ fontSize: "11pt" }}>
                  {pz(WIAT_TEMPLATE).split("\n\n").map((p, i) => (
                    <p key={i} style={{ marginBottom: 6 }}>{p}</p>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-1">
                  <Lock size={9} className="text-indigo-400" />
                  <span className="text-xs text-indigo-400 font-bold uppercase" style={{ fontSize: 7 }}>Fixed template — scores auto-filled from WIAT III Score Report PDF</span>
                </div>
              </div>
            )}
            {/* Clean Formatting button — shown when content has markdown artifacts */}
            {s?.content && sid !== "appendix_tables" && /^#{1,6}\s|^\*\*|^[-*_]{3,}/m.test(s.content) && !locked && (
              <button
                onClick={() => {
                  const cleaned = cleanAIOutput(localContent, sid);
                  setLocalContent(cleaned);
                  onUpdateSec(sid, { content: cleaned });
                }}
                className="mb-2 px-3 py-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors flex items-center gap-1.5"
              >
                <AlertTriangle size={11} /> Clean Formatting (remove markdown headers & duplicates)
              </button>
            )}
            {/* Bracket Review System — highlights [bracketed] items for review */}
            {(() => {
              const SYSTEM_TOKENS = /^\[?(firstName|FIRST_NAME|STUDENT|LAST_NAME|SCHOOL|AUTHOR|DOB|pronoun|possessive|object|reflexive)\]?$/;
              const bracketPattern = /\[([^\[\]]{2,})\]/g;
              const brackets = [];
              if (localContent) {
                let m;
                const re = new RegExp(bracketPattern);
                while ((m = re.exec(localContent)) !== null) {
                  if (!SYSTEM_TOKENS.test(m[0])) brackets.push(m[0]);
                }
              }
              if (brackets.length === 0) return null;
              return (
                <div className="mb-3">
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={13} className="text-amber-500" />
                        <span className="text-xs font-bold text-amber-800">
                          {brackets.length} item{brackets.length !== 1 ? "s" : ""} to review
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          let updated = localContent;
                          const removeRe = /\[([^\[\]]{2,})\]/g;
                          updated = updated.replace(removeRe, (match, inner) => {
                            if (SYSTEM_TOKENS.test(match)) return match;
                            return inner;
                          });
                          setLocalContent(updated);
                          onUpdateSec(sid, { content: updated });
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-500 transition-colors"
                      >
                        <Check size={11} /> Mark All Reviewed
                      </button>
                    </div>
                    <div
                      className="text-xs text-amber-900 leading-relaxed max-h-32 overflow-y-auto rounded-lg bg-white/60 p-2"
                      style={{ fontFamily: "'Times New Roman', Times, serif", fontSize: "11pt", lineHeight: 1.6 }}
                    >
                      {localContent.split(bracketPattern).map((part, i) => {
                        if (i % 2 === 1 && !SYSTEM_TOKENS.test("[" + part + "]")) {
                          return (
                            <span
                              key={i}
                              className="bg-amber-200 text-amber-900 font-semibold px-1 py-0.5 rounded mx-0.5"
                              style={{ border: "1px solid #f59e0b" }}
                            >
                              [{part}]
                            </span>
                          );
                        }
                        if (i % 2 === 1) return <span key={i}>[{part}]</span>;
                        return <span key={i}>{part.length > 80 ? part.slice(0, 40) + "..." + part.slice(-40) : part}</span>;
                      })}
                    </div>
                  </div>
                </div>
              );
            })()}
            <textarea
              readOnly={locked}
              value={localContent}
              onChange={handleContentChange}
              placeholder={sid === "observations" ? "Check items from the menu to build this section..." : "Type or generate..."}
              className={`w-full h-full resize-none outline-none text-gray-800 ${locked ? "bg-gray-50 opacity-80" : ""} ${sid === "appendix_tables" ? "hidden" : ""}`}
              style={{ minHeight: sid === "observations" ? 200 : 300, lineHeight: 1.5, fontFamily: "'Times New Roman', Times, serif", fontSize: "12pt", textAlign: "justify", padding: 0 }}
            />
            {/* Rendered Table Preview for appendix_tables (replaces textarea) */}
            {sid === "appendix_tables" && (
              <div>
                <style>{`
                  .score-tables { font-family: "Times New Roman", Times, serif; }
                  .score-tables h3, .score-tables h4, .score-tables caption {
                    font-family: "Times New Roman", Times, serif;
                    font-size: 13px; font-weight: bold; margin: 20px 0 8px 0;
                    padding-bottom: 4px; border-bottom: 2px solid #333; text-align: left;
                  }
                  .score-tables table {
                    width: 100%; border-collapse: collapse; margin-bottom: 24px;
                    font-family: "Times New Roman", Times, serif; font-size: 11px;
                    border: 1px solid #999;
                  }
                  .score-tables table caption {
                    caption-side: top; padding: 10px 12px; font-size: 12px;
                    font-weight: bold; background: #e8e8f0; border: 1px solid #999;
                    border-bottom: none; text-align: left;
                  }
                  .score-tables thead tr { background: #f0f0f5; }
                  .score-tables th {
                    padding: 7px 12px; text-align: left; font-weight: bold;
                    border: 1px solid #bbb; font-size: 10.5px; color: #222;
                  }
                  .score-tables td {
                    padding: 6px 12px; border: 1px solid #ccc; color: #333;
                  }
                  .score-tables tbody tr:nth-child(even) { background: #fafaff; }
                  .score-tables tbody tr:nth-child(odd) { background: #fff; }
                  .score-tables tbody tr:hover { background: #eef0ff; }
                  .score-tables tr.composite-row td,
                  .score-tables tr.index-row td,
                  .score-tables tr[style*="bold"] td,
                  .score-tables b, .score-tables strong {
                    font-weight: bold;
                  }
                  .score-tables tr.composite-row td,
                  .score-tables tr.index-row td {
                    background: #f0f0fa !important; font-weight: bold;
                  }
                  .score-tables td:first-child { font-weight: 500; }
                  .score-tables td:not(:first-child) { text-align: center; }
                  .score-tables th:not(:first-child) { text-align: center; }
                `}</style>
                {s?.content ? (
                  <div
                    className="score-tables bg-white rounded-xl border border-gray-200 p-5 overflow-x-auto"
                    dangerouslySetInnerHTML={{ __html: sanitizeHTML(s.content) }}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <FileText size={28} className="text-gray-300 mb-3" />
                    <p className="text-sm font-bold text-gray-400">No score tables yet</p>
                    <p className="text-xs text-gray-400 mt-1 max-w-xs">Upload score report PDFs and click <span className="font-semibold text-indigo-500">Generate</span>, or tables will auto-populate when scores are detected.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

// SECTION TABS (the ones that use SecEd)
const SECTION_IDS = [
  "referral", "background", "doc_review", "observations", "cognitive", "memory", "visual_motor",
  "social_emotional", "adaptive", "academic", "summary",
  "strengths_needs", "recommendations", "appendix", "appendix_tables",
];

// VALIDATION & GENERATION ORDER
const REQUIRED_FIELDS = [
  { key: "fullName", label: "Student Name" },
  { key: "grade", label: "Grade" },
  { key: "school", label: "School" },
  { key: "reportDate", label: "Report Date" },
];

const REQUIRED_SECTIONS = ["referral", "background", "observations", "summary", "recommendations"];

const GEN_ORDER = [
  "referral", "background", "doc_review", "observations", "cognitive", "memory", "visual_motor",
  "social_emotional", "adaptive", "academic", "summary",
  "strengths_needs", "recommendations", "appendix", "appendix_tables",
];

const AUTOSAVE_KEY = "psychoed-save";

// TONE SANITIZATION PAIRS (for display in prompt reference)
const TONE_SANITIZE_PAIRS = [
  ["failed", "found challenging"],
  ["failure", "area of difficulty"],
  ["failures", "areas of difficulty"],
  ["poor performance", "area of emerging development"],
  ["poor", "limited"],
  ["deficit(s)", "area of need"],
  ["deficient", "below expected levels"],
  ["impaired", "presenting with difficulty"],
  ["impairment(s)", "area(s) of difficulty"],
  ["inability", "difficulty with"],
  ["weakness(es)", "area(s) of need"],
  ["suffered", "experienced"],
  ["struggled greatly", "experienced significant difficulty"],
  ["struggled", "experienced difficulty"],
  ["struggles", "experiences difficulty"],
  ["cannot", "has difficulty with"],
  ["aggression", "reactive behaviours"],
  ["aggressive", "exhibiting externalizing behaviours"],
  ["violence", "behavioural difficulties"],
  ["violent", "exhibiting behavioural difficulties"],
  ["lazy", "may benefit from additional motivation supports"],
  ["stubborn", "persistent"],
  ["disobedient", "having difficulty following expectations"],
];

const PromptRefSection = memo(function PromptRefSection({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-2">
      <button onClick={() => setOpen(p => !p)} className="w-full px-4 py-2.5 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors">
        <span className="text-xs font-bold text-gray-700 uppercase" style={{letterSpacing:"0.06em"}}>{title}</span>
        <span className="text-gray-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="p-3"><pre className="text-xs text-gray-600 whitespace-pre-wrap font-sans bg-gray-50 p-3 rounded-lg max-h-60 overflow-y-auto">{children}</pre></div>}
    </div>
  );
});

/** Editable prompt card — used for both built-in and user-created prompts.
 *  `isUserCreated` true  → shows Rename + Delete (permanently removes)
 *  `isUserCreated` false → shows Reset to Default when customised
 */
const EditablePromptRefSection = memo(function EditablePromptRefSection({
  title, sid, activePrompt, defaultPrompt, isCustom, isUserCreated,
  onSave, onDelete, onRename, onRemove, showToast,
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(title || "");

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-2">
      {/* Header bar */}
      <button
        onClick={() => { setOpen(p => !p); if (!open && !editing) setDraft(activePrompt); }}
        className="w-full px-4 py-2.5 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold text-gray-700 uppercase truncate" style={{ letterSpacing: "0.06em" }}>{title}</span>
          {isCustom && !isUserCreated && (
            <span className="flex-shrink-0 text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded font-extrabold" style={{ fontSize: 7 }}>MODIFIED</span>
          )}
          {isUserCreated && (
            <span className="flex-shrink-0 text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded font-extrabold" style={{ fontSize: 7 }}>USER PROMPT</span>
          )}
        </span>
        <span className="text-gray-400 text-xs flex-shrink-0 ml-2">{open ? "▲" : "▼"}</span>
      </button>

      {/* Expanded body */}
      {open && (
        <div className="p-3 space-y-2 border-t border-gray-100">
          {/* Rename row (user-created only) */}
          {isUserCreated && renaming && (
            <div className="flex items-center gap-2 mb-1">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="flex-1 px-3 py-1.5 text-xs border border-indigo-200 rounded-lg outline-none focus:border-indigo-400"
                placeholder="Prompt name…"
                autoFocus
              />
              <button
                onClick={() => {
                  if (nameDraft.trim() && nameDraft.trim() !== title) {
                    onRename(sid, nameDraft.trim());
                    showToast("Prompt renamed", "success");
                  }
                  setRenaming(false);
                }}
                className="px-2.5 py-1.5 bg-indigo-600 text-white rounded-lg font-extrabold uppercase hover:bg-indigo-500"
                style={{ fontSize: 8 }}
              >
                Save Name
              </button>
              <button
                onClick={() => { setRenaming(false); setNameDraft(title); }}
                className="px-2.5 py-1.5 bg-gray-200 text-gray-600 rounded-lg font-extrabold uppercase hover:bg-gray-300"
                style={{ fontSize: 8 }}
              >
                Cancel
              </button>
            </div>
          )}

          {editing ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full p-3 text-xs bg-gray-50 border border-indigo-200 rounded-xl outline-none resize-y leading-relaxed focus:border-indigo-400 font-sans"
                style={{ minHeight: 160, maxHeight: 400, fontSize: 11, overflowY: "auto" }}
                placeholder="Enter your prompt text…"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => {
                    if (draft.trim()) {
                      onSave(sid, draft.trim());
                      showToast("Prompt saved", "success");
                    }
                    setEditing(false);
                  }}
                  className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg font-extrabold uppercase hover:bg-indigo-500"
                  style={{ fontSize: 8 }}
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditing(false); setDraft(activePrompt); }}
                  className="px-3 py-1.5 bg-gray-200 text-gray-600 rounded-lg font-extrabold uppercase hover:bg-gray-300"
                  style={{ fontSize: 8 }}
                >
                  Cancel
                </button>
                {/* Built-in with override → reset */}
                {isCustom && !isUserCreated && (
                  <button
                    onClick={() => {
                      onDelete(sid);
                      setDraft(defaultPrompt);
                      setEditing(false);
                      showToast("Prompt reset to default", "info");
                    }}
                    className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg font-extrabold uppercase hover:bg-red-100 ml-auto"
                    style={{ fontSize: 8 }}
                  >
                    Reset to Default
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <pre
                className="text-xs text-gray-600 whitespace-pre-wrap font-sans bg-gray-50 p-3 rounded-xl border border-gray-100 overflow-y-auto"
                style={{ fontSize: 10, maxHeight: 280 }}
              >
                {activePrompt || "(empty)"}
              </pre>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => { setDraft(activePrompt); setEditing(true); }}
                  className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg font-extrabold uppercase hover:bg-indigo-100 flex items-center gap-1"
                  style={{ fontSize: 8 }}
                >
                  <Pencil size={9} /> Edit Prompt
                </button>
                {isUserCreated && (
                  <button
                    onClick={() => { setRenaming(true); setNameDraft(title); }}
                    className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg font-extrabold uppercase hover:bg-indigo-100"
                    style={{ fontSize: 8 }}
                  >
                    Rename
                  </button>
                )}
                {/* Built-in with override → reset to default */}
                {isCustom && !isUserCreated && (
                  <button
                    onClick={() => {
                      onDelete(sid);
                      setDraft(defaultPrompt);
                      showToast("Prompt reset to default", "info");
                    }}
                    className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg font-extrabold uppercase hover:bg-red-100"
                    style={{ fontSize: 8 }}
                  >
                    Reset to Default
                  </button>
                )}
                {/* User-created → delete entirely */}
                {isUserCreated && (
                  <button
                    onClick={() => {
                      onRemove(sid);
                      showToast("Prompt deleted", "info");
                    }}
                    className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg font-extrabold uppercase hover:bg-red-100 ml-auto flex items-center gap-1"
                    style={{ fontSize: 8 }}
                  >
                    <X size={9} /> Delete Prompt
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});

const PromptReference = memo(function PromptReference({ customPrompts, userPrompts, onSavePrompt, onDeletePrompt, onAddUserPrompt, onSaveUserPrompt, onRenameUserPrompt, onRemoveUserPrompt, showToast }) {
  const sectionLabels = {};
  TABS.forEach(t => { sectionLabels[t.id] = t.label; });

  // "Add new prompt" form state
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newText, setNewText] = useState("");

  const globalSections = [
    { key: "_global_report_rules", title: "Global Report Rules", default: GLOBAL_REPORT_RULES },
    { key: "_global_tone_rules", title: "Global Tone Rules", default: GLOBAL_TONE_RULES },
    { key: "_beh_obs_opening", title: "Behaviour Observations Opening", default: BEH_OBS_STANDARD_OPENING },
    { key: "_cog_opening", title: "Cognitive Opening", default: COG_STANDARD_OPENING },
  ];

  // Sorted user prompts
  const sortedUserPrompts = useMemo(() => {
    if (!userPrompts || !userPrompts.length) return [];
    return [...userPrompts].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [userPrompts]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <Clipboard size={16} className="text-indigo-600" />
          <h3 className="text-base font-extrabold">Prompt & Style Reference</h3>
        </div>
        <p className="text-xs text-gray-500">
          View and edit all writing rules and section prompts. Click any section to expand, then <strong>Edit Prompt</strong> to customize.
          Use <strong>+ Add New Prompt</strong> below to create your own named prompts.
        </p>
      </div>

      {/* ── USER-CREATED PROMPTS ── */}
      <div className="flex items-center gap-3 px-1">
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-xs font-bold text-gray-400 uppercase" style={{ letterSpacing: "0.08em" }}>My Custom Prompts</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {sortedUserPrompts.map((up) => (
        <EditablePromptRefSection
          key={up.id}
          title={up.name}
          sid={up.id}
          activePrompt={up.text}
          defaultPrompt=""
          isCustom={false}
          isUserCreated
          onSave={onSaveUserPrompt}
          onDelete={() => {}}
          onRename={onRenameUserPrompt}
          onRemove={onRemoveUserPrompt}
          showToast={showToast}
        />
      ))}

      {sortedUserPrompts.length === 0 && !adding && (
        <div className="text-center py-4 text-xs text-gray-400">No custom prompts yet. Click below to add one.</div>
      )}

      {/* Add new prompt form */}
      {adding ? (
        <div className="bg-white rounded-xl border-2 border-dashed border-indigo-300 p-4 space-y-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-indigo-400"
            placeholder="Prompt name (e.g. My LD Summary Template)…"
            autoFocus
          />
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            className="w-full p-3 text-xs bg-gray-50 border border-gray-200 rounded-xl outline-none resize-y leading-relaxed focus:border-indigo-400 font-sans"
            style={{ minHeight: 120, maxHeight: 320, fontSize: 11, overflowY: "auto" }}
            placeholder="Enter the prompt text…"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (!newName.trim()) { showToast("Please enter a prompt name", "error"); return; }
                if (!newText.trim()) { showToast("Please enter prompt text", "error"); return; }
                onAddUserPrompt(newName.trim(), newText.trim());
                setNewName("");
                setNewText("");
                setAdding(false);
                showToast("Prompt added", "success");
              }}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-extrabold uppercase hover:bg-indigo-500 flex items-center gap-1"
              style={{ fontSize: 9 }}
            >
              <Sparkles size={11} /> Add Prompt
            </button>
            <button
              onClick={() => { setAdding(false); setNewName(""); setNewText(""); }}
              className="px-4 py-2 bg-gray-200 text-gray-600 rounded-lg font-extrabold uppercase hover:bg-gray-300"
              style={{ fontSize: 9 }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full py-2.5 rounded-xl border-2 border-dashed border-gray-300 text-xs font-extrabold text-gray-500 uppercase hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors flex items-center justify-center gap-1.5"
          style={{ letterSpacing: "0.06em" }}
        >
          <Sparkles size={12} /> Add New Prompt
        </button>
      )}

      {/* ── GLOBAL RULES ── */}
      <div className="flex items-center gap-3 px-1 mt-2">
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-xs font-bold text-gray-400 uppercase" style={{ letterSpacing: "0.08em" }}>Global Rules</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {globalSections.map((gs) => {
        const isCustom = !!(customPrompts && customPrompts[gs.key]);
        const activePrompt = isCustom ? customPrompts[gs.key] : gs.default;
        return (
          <EditablePromptRefSection
            key={gs.key}
            title={gs.title}
            sid={gs.key}
            activePrompt={activePrompt}
            defaultPrompt={gs.default}
            isCustom={isCustom}
            isUserCreated={false}
            onSave={onSavePrompt}
            onDelete={onDeletePrompt}
            onRename={() => {}}
            onRemove={() => {}}
            showToast={showToast}
          />
        );
      })}

      {/* ── SECTION PROMPTS ── */}
      <div className="flex items-center gap-3 px-1">
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-xs font-bold text-gray-400 uppercase" style={{ letterSpacing: "0.08em" }}>Section Prompts</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {Object.entries(SEC_PROMPTS).map(([sid, prompt]) => {
        const isCustom = !!(customPrompts && customPrompts[sid]);
        const activePrompt = resolvePrompt(sid, customPrompts);
        return (
          <EditablePromptRefSection
            key={sid}
            title={sectionLabels[sid] || sid}
            sid={sid}
            activePrompt={activePrompt}
            defaultPrompt={prompt}
            isCustom={isCustom}
            isUserCreated={false}
            onSave={onSavePrompt}
            onDelete={onDeletePrompt}
            onRename={() => {}}
            onRemove={() => {}}
            showToast={showToast}
          />
        );
      })}
    </div>
  );
});

// Hoisted static style objects — avoid re-creation on every render
const REPORT_CONTAINER_STYLE = {
  fontFamily: "'Times New Roman', Times, serif",
  fontSize: 12,
  lineHeight: 1.5,
  textAlign: "justify",
  padding: "0",
  maxWidth: 816,
  margin: "0 auto",
  position: "relative",
};
const REPORT_HEADER_STYLE = {
  textAlign: "center",
  padding: "24px 56px 16px 56px",
  borderBottom: "1px solid #ddd",
};
const REPORT_LOGO_STYLE = {
  width: 72, height: 72, display: "block", margin: "0 auto 10px auto",
};
const REPORT_FOOTER_STYLE = {
  padding: "10px 56px 16px 56px",
  borderTop: "1px solid #ccc",
  textAlign: "center",
  fontSize: 8,
  color: "#555",
  lineHeight: 1.4,
  background: "#fff",
};
const REPORT_BODY_STYLE = { padding: "28px 56px 20px 56px" };
const INTERP_NOTE_STYLE = {
  fontFamily: "'Times New Roman', Times, serif",
  fontSize: 12,
  lineHeight: 1.5,
  textAlign: "justify",
};
const PREVIEW_SECTION_HEADING_STYLE = { fontWeight: "bold", fontSize: 12, marginBottom: 8 };
const PREVIEW_SECTION_HEADING_UNDERLINE_STYLE = { fontWeight: "bold", textDecoration: "underline", fontSize: 12, marginBottom: 8 };
const PREVIEW_PARAGRAPH_STYLE = { textAlign: "justify", marginBottom: 8 };
const PREVIEW_PREWRAP_STYLE = { whiteSpace: "pre-line", textAlign: "justify" };
const CLASSIFICATION_TABLE_ROWS = [
  ["Very Superior", ">98th"],
  ["Superior", "92nd to 97th"],
  ["High Average", "75th to 90th"],
  ["Average", "25th to 74th"],
  ["Low Average", "9th to 24th"],
  ["Low", "2nd to 8th"],
  ["Very Low", "<2nd"],
];

// ── DEMO CONTENT for all report sections ──
const DEMO_CONTENT = {
  referral: `Liam was referred for a psychoeducational assessment by his parents to better understand his current cognitive, academic, and emotional functioning and to assist with educational planning and support. Liam's parents and teachers have expressed concerns regarding his difficulties in reading and written expression, as well as attention and focus during classroom activities. A previous screening conducted in Grade 2 suggested that Liam may benefit from a comprehensive assessment to identify his learning profile and inform appropriate accommodations and interventions.`,

  background: `Liam lives at home with his parents and his younger sister, age 7. English is the primary language spoken at home, though Liam's maternal grandmother, who visits frequently, speaks Polish.

Parents reported that Liam was born in Ottawa after an uncomplicated pregnancy and delivery at 39 weeks gestation. Developmental milestones were reported to have been reached within expected timeframes, with the exception of speech, which was noted to have developed somewhat later than his peers. Liam began speaking in full sentences at approximately age 3. Vision and hearing screenings conducted through the school were reported as within normal limits.

Liam has no significant medical history. He has not been prescribed any medications. Parents reported that Liam sleeps approximately 9 to 10 hours per night and generally maintains a healthy appetite.

Liam has attended Maple Ridge Public School since Junior Kindergarten. He is currently in a Grade 4 regular classroom. His teachers have noted that Liam is a kind and cooperative student who participates well in class discussions but struggles with independent reading tasks and written assignments. He received reading intervention support through a small-group literacy programme in Grade 3.

Socially, Liam is described by his parents as a friendly and empathetic child who gets along well with peers. He enjoys sports, particularly soccer and swimming, and participates in a community soccer league. His parents noted that Liam occasionally becomes frustrated with homework, particularly tasks involving reading or writing, and may at times express reluctance to complete such assignments.`,

  doc_review: `A review of the following documents was conducted as part of this assessment.

A previous speech-language assessment conducted by Ms. Sarah Thompson, Speech-Language Pathologist, in March 2023, indicated that Liam demonstrated age-appropriate receptive language skills but exhibited mild weaknesses in phonological awareness and phonemic segmentation. Recommendations at that time included continued phonological awareness intervention and monitoring of reading development.

Report cards from Grades 2 and 3 at Maple Ridge Public School were reviewed. In Grade 2, Liam's teacher noted that he was a kind and enthusiastic student who participated actively in class discussions but required additional support for independent reading and writing tasks. His learning skills were rated as consistently demonstrating Good effort and responsibility. In Grade 3, teacher comments indicated that Liam continued to struggle with reading fluency and written expression despite receiving small-group literacy intervention. His mathematics and oral communication marks remained at grade-level expectations throughout both years.

A letter from Liam's Grade 3 teacher, Ms. Kwan, was also reviewed. Ms. Kwan noted concerns regarding Liam's reading accuracy and comprehension during independent tasks, and indicated that he benefited significantly from one-on-one support during literacy activities. She reported that Liam was well-liked by peers and demonstrated strong effort despite his difficulties.`,

  observations: `During testing, Liam presented as a polite, kind, and hardworking young boy who appeared physically healthy, alert, and oriented. He was cooperative and motivated throughout all testing sessions and demonstrated appropriate rapport with the examiner. Liam had no difficulty understanding task instructions and put forth his best effort on all tasks presented to him.

Liam showed right-handed dominance and used a tripod pencil grip, and his penmanship was legible, though he wrote at a somewhat slow pace. His level of motor activity remained within normal limits for his age, with no signs of impulsive behaviour observed. Eye contact was consistent, and he demonstrated appropriate joint attention throughout.

Liam's attention was generally sustained during shorter tasks; however, during lengthier or more demanding activities, he occasionally lost focus and required gentle prompts to redirect his attention. He at times verbalised that tasks involving reading felt challenging for him, stating, "I tried my best, but the words are hard." Despite these moments, Liam remained persistent and did not become discouraged, continuing to put forth strong effort across all tasks.

Considering Liam's good efforts, attention, and motivation, it is believed that the results of the assessment constitute a valid estimate of his present abilities and functioning.`,

  cognitive: `Liam was administered the Wechsler Intelligence Scale for Children, Fifth Edition, Canadian (WISC-V CDN). The WISC-V CDN is an individually administered comprehensive clinical instrument for assessing the intelligence of children ages 6 years through 16 years 11 months. It provides composite scores that represent intellectual functioning in specific cognitive domains, as well as a composite score that represents overall intellectual ability (Full Scale IQ).

Liam obtained a Full Scale IQ (FSIQ) of 96, which falls within the Average range and at the 39th percentile. This indicates that Liam's overall cognitive ability is comparable to that of his same-aged peers.

The Verbal Comprehension Index (VCI) measures verbal reasoning, comprehension, and conceptualization. Liam's VCI score of 105 falls within the Average range (63rd percentile), suggesting that his verbal reasoning and language-based skills are appropriately developed.

The Visual Spatial Index (VSI) assesses visual-spatial processing and the ability to analyse and synthesise visual stimuli. Liam scored 102 on this index, placing him within the Average range (55th percentile).

The Fluid Reasoning Index (FRI) measures the ability to detect and apply rules, identify and apply relationships, and form concepts. Liam obtained an FRI of 98, falling within the Average range (45th percentile).

The Working Memory Index (WMI) assesses the ability to hold information in memory and manipulate it. Liam's WMI score of 88 falls within the Low Average range (21st percentile). This suggests that Liam may at times experience difficulty holding and manipulating information in working memory, which can affect his ability to follow multi-step instructions and complete complex academic tasks.

The Processing Speed Index (PSI) measures the speed and accuracy of visual scanning, discrimination, and sequential ordering. Liam obtained a PSI score of 85, falling within the Low Average range (16th percentile). This finding suggests that Liam processes visual information at a pace that is slower than many of his same-aged peers, which may affect his efficiency when completing timed academic tasks and note-copying activities.

Notably, there is a significant discrepancy between Liam's verbal reasoning abilities (VCI = 105) and his processing speed (PSI = 85), with a 20-point difference. This pattern is consistent with a profile where strong verbal and reasoning skills may be masked by slower processing efficiency, potentially affecting academic output.

In addition to the index scores described above, Liam was administered subtests contributing to several ancillary index scores. Ancillary index scores do not replace the FSIQ and primary index scores, but are meant to provide additional information about Liam's cognitive profile.

The Nonverbal Index (NVI) is derived from six subtests that do not require verbal responses. This index score can provide a measure of general intellectual functioning that minimises expressive language demands for children with special circumstances or clinical needs. Subtests that contribute to the NVI are drawn from four of the five primary cognitive domains (i.e., Visual Spatial, Fluid Reasoning, Working Memory, and Processing Speed). Liam's performance on the NVI fell in the Average range when compared to other children his age (at around the 32nd percentile). Assessment of Liam's performance on the NVI may help to estimate his overall nonverbal cognitive ability.

Liam was administered the five subtests comprising the General Ability Index (GAI), an ancillary index score that provides an estimate of general intelligence that is less impacted by working memory and processing speed, relative to the FSIQ. The GAI consists of subtests from the verbal comprehension, visual spatial, and fluid reasoning domains. Overall, this index score was similar to other children his age (at around the 55th percentile). The GAI does not replace the FSIQ as the best estimate of overall ability. It should be interpreted along with the FSIQ and all of the primary index scores. Liam's FSIQ and GAI scores were not significantly different, indicating that reducing the impact of working memory and processing speed resulted in little difference on his overall performance. However, the GAI score of 102 does provide a clearer estimate of Liam's reasoning potential that is not attenuated by his processing weaknesses.

Liam was also administered subtests that contribute to the Cognitive Proficiency Index (CPI). These four subtests are drawn from the working memory and processing speed domains. Liam's index score suggests that he demonstrates somewhat lower than average efficiency when processing cognitive information in the service of learning, problem solving, and higher-order reasoning (at around the 16th percentile). Low CPI scores may occur for many reasons, including visual or auditory processing deficits, inattention, distractibility, visuomotor difficulties, limited working memory storage or mental manipulation capacity, or generally low cognitive ability. The CPI is most informative when interpreted as part of a comprehensive evaluation, together with its counterpart, the GAI. The practitioner may consider evaluating the GAI-CPI pairwise comparison, as this may provide additional interpretive information regarding the possible impact of cognitive processing on his ability. Liam's performance on subtests contributing to the GAI was stronger than his overall level of cognitive proficiency. The difference between his GAI (102) and CPI (85) scores suggests that higher-order cognitive abilities may be a strength compared to abilities that facilitate cognitive processing efficiency. Relative weaknesses in mental control and speed of visual scanning may sometimes create challenges as Liam engages in more complex cognitive processes, such as learning new material or applying logical thinking skills.`,

  memory: `Selected subtests of the Wide Range Assessment of Memory and Learning, Third Edition (WRAML-3) were administered to examine Liam's memory and learning abilities. The WRAML-3 is an individually administered, standardized assessment designed to evaluate a broad range of memory, learning, and cognitive functions that support memory and learning processes. This instrument measures how well Liam can encode, store, and retrieve verbal and visual information both immediately after presentation and after a delay. Specifically, the WRAML-3 provides information about Liam's verbal and visual immediate recall, delayed recall, recognition memory, attention and concentration, and working memory. Index scores are reported as standard scores with a mean of 100 and a standard deviation of 15. Subtest scores are reported as scaled scores with a mean of 10 and a standard deviation of 3. Qualitative descriptors are used to describe the range of performance.

The General Immediate Memory Index provides a broad estimate of Liam's overall immediate recall ability, measured across a wide range of memory tasks involving both verbal and visual modalities. This index is derived from the combined scores earned on the Verbal Immediate Memory Index, the Visual Immediate Memory Index, and the Attention and Concentration Index. Liam obtained a standard score of 96 (39th percentile), which falls within the Average range. This score provides an overall indication of how effectively Liam can take in and immediately reproduce new information across different types of content.

The Visual Immediate Memory Index is an estimate of how well Liam can learn and recall both meaningful and relatively unrelated visual information shortly after it is presented. This index is derived from the scaled scores earned on the Picture Memory and Design Learning subtests. Liam obtained a standard score of 100 (50th percentile), which falls within the Average range. On the Design Learning subtest, Liam was shown a stimulus card containing geometric shapes distributed across four quadrants. The card was exposed for ten seconds and then removed. After a brief delay, Liam was asked to recall and draw the shapes in the correct locations. This procedure was repeated across four learning trials to assess Liam's ability to acquire and consolidate visual information with repetition. Liam obtained a scaled score of 9 (37th percentile), which falls within the Average range. When asked to recall the design details in the correct locations after a twenty to thirty minute delay, Liam obtained a scaled score of 10 (50th percentile), which falls within the Average range, reflecting his ability to retain and retrieve visual spatial information from long term memory. On the Picture Memory subtest, Liam was shown a meaningful visual scene and was then asked to look at a second, similar scene. Memory of the original picture is indicated by identifying elements that were altered, added, or removed in the second picture. This subtest measures visual memory for contextually meaningful material. Liam obtained a scaled score of 11 (63rd percentile), which falls within the Average range. When asked to identify elements that were changed, added, or moved after a twenty to thirty minute delay, Liam obtained a scaled score of 10 (50th percentile), which falls within the Average range.

The Verbal Immediate Memory Index is an estimate of how well Liam can learn and recall both contextually meaningful and relatively less meaningful verbal information shortly after it is presented. This index is derived from the scaled scores earned on the Story Memory and Verbal Learning subtests. Liam obtained a standard score of 85 (16th percentile), which falls within the Low Average range. These subtests place heavy demands on the ability to attend to and encode verbal information. The Story Memory subtest assesses the ability to process, encode, and recall meaningful material that is presented in a sequential narrative format. In the immediate portion, the examiner reads two stories one at a time, and Liam was asked to retell each story from memory. Liam obtained a scaled score of 7 (16th percentile), which falls within the Low Average range. On the delayed recall portion, administered after a twenty to thirty minute delay, Liam obtained a scaled score of 7 (16th percentile), which falls within the Low Average range, reflecting his ability to retain verbally presented narrative information over time. The Verbal Learning subtest assesses Liam's ability to learn a list of unrelated words over four learning trials, measuring rote verbal learning and the benefit of repetition. Liam obtained a scaled score of 7 (16th percentile), which falls within the Low Average range. On the delayed recall section, administered after a twenty to thirty minute delay, Liam obtained a scaled score of 8 (25th percentile), which falls within the Average range, reflecting his ability to store and retrieve unrelated verbal material from long term memory.

The Attention and Concentration Index provides an estimate of how well Liam can learn and recall attentionally demanding, relatively rote, sequential information. Both auditory and visual information are sampled within this domain. This index is derived from the scaled scores earned on the Finger Windows and Number Letter subtests. Liam obtained a standard score of 85 (16th percentile), which falls within the Low Average range. The Finger Windows subtest assesses the ability to attend to and remember a sequence of spatial locations using a card with holes, or windows. The examiner points to a pattern of windows in a specified order, and Liam must reproduce the sequence from memory. The pattern of windows becomes progressively longer as the subtest proceeds, placing increasing demands on visual sequential memory. Liam obtained a scaled score of 9 (37th percentile), which falls within the Average range. The Number Letter subtest requires Liam to repeat a random mix of verbally presented numbers and letters in the exact order they were given. This subtest assesses auditory attention, working memory, and the ability to maintain sequential information. Liam obtained a scaled score of 6 (9th percentile), which falls within the Low Average range.

Summary of Memory and Learning: Overall, Liam's memory functioning presents a mixed profile. His visual memory abilities are within the Average range, suggesting that he learns and retains visual material effectively. However, his verbal memory skills fall within the Low Average range, indicating that he may at times have difficulty learning and retaining verbally presented information. His attention and concentration scores suggest relative difficulty with tasks requiring sustained auditory attention and sequential processing. This pattern is consistent with his cognitive profile, where verbal reasoning strengths coexist with processing speed and working memory weaknesses. These findings may impact his ability to retain information from classroom lectures and verbal instructions without additional supports.`,

  visual_motor: `Liam was administered the Beery Buktenica Developmental Test of Visual Motor Integration Sixth Edition to assess the extent to which he can integrate both visual and motor abilities. On the Visual Motor Integration test, where Liam had to copy various geometric forms of increasing difficulty without erasing, he demonstrated Average ability to integrate visual perception and fine motor requirements (at around the 45th percentile).

Liam's visual-motor integration skills are appropriately developed for his age, suggesting that he does not experience significant difficulty coordinating visual perception with motor output. This finding indicates that visual-motor factors are unlikely to be a primary contributor to his academic difficulties. His pencil grip was noted to be appropriate, and his handwriting, while somewhat slow in pace, was legible.`,

  social_emotional: `Social-emotional functioning was assessed using the Behavior Assessment System for Children, Third Edition (BASC-3), which was completed by Liam's mother (Parent Rating Scale) and his classroom teacher (Teacher Rating Scale). The Conners 4th Edition was also completed by both his parent and teacher.

BASC-3 Parent Rating Scale (completed by Liam's mother):
The BASC-3 is a comprehensive measure of both adaptive and problem behaviours in community and home settings. Liam's mother rated his Externalizing Problems composite as within the Average range, suggesting that she does not observe significant concerns with hyperactivity, aggression, or conduct difficulties at home. The Internalizing Problems composite was rated as At Risk, indicating that Liam may at times experience some difficulties with anxiety and feelings of worry. Specifically, the Anxiety scale was elevated to the At Risk range, with his mother noting that Liam sometimes worries about school performance and becomes anxious before tests. The Depression scale was within the Average range. The Behavioural Symptoms Index was within the Average range. On the Adaptive Skills composite, Liam's scores were within the Average range, indicating age-appropriate social skills, leadership, and activities of daily living.

BASC-3 Teacher Rating Scale (completed by Liam's Grade 4 teacher):
Liam's teacher rated his Externalizing Problems as within the Average range. The Internalizing Problems composite was rated as Average. The Attention Problems scale was rated as At Risk, indicating that his teacher observes some variability in Liam's ability to sustain focus during classroom activities, particularly during independent reading and writing tasks. The Learning Problems scale was elevated to the At Risk range, consistent with his teacher's observations of academic difficulties in literacy. The Adaptive Skills composite was rated within the Average range, reflecting appropriate social skills and peer interactions.

Conners 4th Edition, Parent and Teacher Forms:
Both the parent and teacher Conners 4 forms were completed to further assess attention and executive functioning. The Inattention scale was elevated to the At Risk range by both respondents, suggesting that Liam demonstrates some patterns of inattentive behaviour across settings. The Hyperactivity/Impulsivity scale was within the Average range for both respondents. The Executive Functioning scale was elevated to the At Risk range by his teacher.

Summary of Social-Emotional Functioning: Overall, Liam presents as a well-adjusted child with age-appropriate social skills and positive peer relationships. Rating scale results suggest that attention difficulties are present across home and school settings, particularly during tasks requiring sustained focus on reading and writing activities. Mild anxiety symptoms related to academic performance were noted by his mother. These findings should be considered within the context of Liam's academic difficulties, as anxiety and inattention may be secondary to his learning challenges rather than primary concerns.`,

  adaptive: `Liam's adaptive functioning was assessed using the Vineland Adaptive Behavior Scales, Third Edition, Parent Form, which was completed by his mother. The Vineland-3 assesses adaptive behaviour across three broad domains: Communication, Daily Living Skills, and Socialization.

Liam's Adaptive Behavior Composite score fell within the Average range (standard score of 95, 37th percentile), indicating that his overall adaptive functioning is appropriately developed for his age.

In the Communication domain, Liam scored within the Average range (standard score of 92, 30th percentile). His receptive and expressive communication skills are age-appropriate, though his written communication subdomain was rated somewhat lower, consistent with his academic difficulties in written expression.

In the Daily Living Skills domain, Liam scored within the Average range (standard score of 98, 45th percentile). He demonstrates age-appropriate personal care routines, domestic skills, and community navigation abilities.

In the Socialization domain, Liam scored within the Average range (standard score of 100, 50th percentile). He demonstrates appropriate interpersonal relationships, play and leisure skills, and coping skills. His mother noted that Liam has several close friendships and is well-liked by his peers.

Overall, Liam's adaptive functioning is within the expected range across all domains assessed, suggesting that his daily living skills, communication, and social competencies are appropriately developed. These results do not indicate significant adaptive behaviour concerns.`,

  academic: `Academic skills were assessed using the Wechsler Individual Achievement Test, Third Edition, Canadian (WIAT-III CDN). The WIAT-III is an individually administered instrument that measures academic achievement and uses Canadian norms.

To assess Liam's oral language skills, one subtest was administered. Liam's performance in Listening Comprehension was in the Average range (at around the 50th percentile). This subtest measures a student's ability to understand spoken language and receptive language. Receptive Vocabulary, which measures listening vocabulary, fell within the Average range (at around the 55th percentile). Oral Discourse Comprehension, which measures the ability to understand spoken passages, fell within the Average range (at around the 45th percentile). Overall, Liam's Oral Language Composite, which provides a broad measure of oral language skills, fell in the Average range (at around the 50th percentile).

In the area of reading, the Word Reading subtest measures word recognition accuracy. Liam scored in the Low Average range (at around the 16th percentile). The Pseudoword Decoding subtest, which measures the ability to decode unfamiliar words, fell in the Low range (at around the 7th percentile). Reading Comprehension, which measures the ability to understand written passages, fell in the Low Average range (at around the 18th percentile). The Basic Reading Composite, which measures fundamental reading skills including word recognition and decoding, fell in the Low range (at around the 9th percentile). The Total Reading Composite, which provides an overall measure of reading ability combining word reading accuracy, decoding, and reading comprehension, fell in the Low Average range (at around the 14th percentile).

In the area of written expression, Spelling, which measures the ability to spell dictated words, fell in the Low Average range (at around the 14th percentile). Sentence Composition, which measures the ability to write grammatically correct sentences, fell in the Low Average range (at around the 21st percentile). Essay Composition, which measures written expression and organization, fell in the Low Average range (at around the 16th percentile). The Written Expression Composite, which provides an overall measure of written language skills, fell in the Low Average range (at around the 16th percentile).

In the area of mathematics, Math Problem Solving, which measures mathematical reasoning and applied math skills, fell in the Average range (at around the 42nd percentile). Numerical Operations, which measures the ability to solve written math calculation problems, fell in the Average range (at around the 39th percentile). The Mathematics Composite, which provides an overall measure of mathematical ability, fell in the Average range (at around the 40th percentile).

Summary of Academic Functioning: Liam's academic profile reveals a significant discrepancy between his oral language and mathematical abilities, which fall within the Average range, and his reading and written expression skills, which fall within the Low Average to Low range. His Basic Reading Composite (9th percentile) represents a notable area of weakness, with particular difficulty in decoding unfamiliar words (7th percentile). Reading comprehension is also affected (18th percentile), likely impacted by his underlying decoding difficulties. Written expression skills, including spelling, sentence construction, and essay writing, are consistently in the Low Average range. In contrast, Liam's mathematics skills are within the Average range, indicating that his learning difficulties are primarily language-based rather than affecting all academic domains.`,

  summary: `Liam McAllister, a 10-year-old boy in Grade 4 at Maple Ridge Public School, was referred for a psychoeducational assessment by his parents due to concerns regarding difficulties with reading, written expression, and attention during classroom activities.

Cognitive assessment using the WISC-V CDN indicates that Liam's overall intellectual functioning falls within the Average range (FSIQ = 96, 39th percentile). His verbal reasoning skills are a relative strength, falling within the Average range (VCI = 105, 63rd percentile), and his visual-spatial and fluid reasoning abilities are also within the Average range. However, his Working Memory Index (WMI = 88, 21st percentile) and Processing Speed Index (PSI = 85, 16th percentile) both fall within the Low Average range, representing relative areas of weakness. Ancillary index analysis further clarifies this profile: Liam's General Ability Index (GAI = 102, 55th percentile) confirms Average reasoning ability, while his Cognitive Proficiency Index (CPI = 85, 16th percentile) indicates reduced cognitive efficiency. The 17-point GAI–CPI discrepancy is statistically significant and clinically meaningful, suggesting that Liam's reasoning potential is not fully reflected in his processing efficiency. This pattern has direct implications for his academic functioning.

Academically, Liam demonstrates Average oral language skills (50th percentile) and Average mathematics skills (40th percentile). However, his reading skills are significantly below expectations, with a Basic Reading Composite at the 9th percentile and particular weakness in pseudoword decoding (7th percentile). His Total Reading Composite (14th percentile) and Written Expression Composite (16th percentile) are also in the Low Average range. This pattern indicates a specific area of underachievement in reading and written expression relative to his cognitive ability.

Memory assessment reveals a mixed profile, with Average visual memory but Low Average verbal memory (18th percentile) and Low Average attention and concentration (18th percentile). Visual-motor integration skills are within the Average range (45th percentile).

Social-emotional assessment indicates that Liam is a well-adjusted child with age-appropriate adaptive functioning (Adaptive Behavior Composite = 95, 37th percentile). Attention difficulties were noted by both his parent and teacher, particularly during literacy tasks. Mild anxiety related to academic performance was reported by his mother. These emotional and attentional concerns appear to be closely related to his learning difficulties.

Taken together, Liam's learning profile was evaluated against the criteria established by the Learning Disabilities Association of Ontario (LDAO). The following analysis considers each of the key criteria for the identification of a Learning Disability:

Average or above cognitive ability: Liam's Full Scale IQ of 96 falls within the Average range, meeting this criterion. His Verbal Comprehension Index of 105 and General Ability Index (GAI) of 102 further support that his reasoning abilities are within the Average range. The GAI, which excludes working memory and processing speed, provides a more accurate estimate of Liam's intellectual potential given his processing weaknesses.

Academic underachievement: Liam demonstrates significant underachievement in reading, with a Basic Reading Composite at the 9th percentile and pseudoword decoding at the 7th percentile. His Written Expression Composite falls at the 16th percentile. These scores are well below what would be expected given his cognitive ability and represent a significant discrepancy between ability and achievement.

Processing weaknesses: Liam demonstrates weaknesses in working memory (WMI = 88, 21st percentile) and processing speed (PSI = 85, 16th percentile), reflected in a Cognitive Proficiency Index (CPI) of 85 (16th percentile). His verbal memory is also in the Low Average range (18th percentile). The significant GAI–CPI discrepancy (102 vs. 85, 17 points) confirms that Liam's cognitive efficiency is substantially below his reasoning potential. These processing deficits are directly related to the cognitive demands of reading and writing tasks and are consistent with the pattern of academic difficulty observed.

Exclusionary factors: Liam's learning difficulties cannot be attributed to intellectual disability (Average FSIQ), sensory impairment (vision and hearing within normal limits), emotional disturbance (age-appropriate adaptive functioning), or environmental disadvantage (supportive home environment with access to educational resources). English is the primary language spoken at home.

Functional impact: Liam's reading and writing difficulties have a documented impact on his classroom functioning, as noted by both his parents and teacher. He requires additional time to complete literacy tasks and has received reading intervention support.

Based on the assessment findings and the analysis of the above criteria, Liam's profile is consistent with a Learning Disability in the areas of reading (basic reading skills and reading comprehension) and written expression. The school may wish to present Liam at an Identification, Placement, and Review Committee (IPRC) meeting for the purpose of identifying him as an exceptional student under the Learning Disability category.

It is noted that attention difficulties were reported by both Liam's parent and teacher on the Conners 4 and BASC-3 rating scales. However, these attentional concerns appear to be most prominent during literacy-based tasks and may be secondary to his learning difficulties rather than indicative of a primary attention disorder. Formal diagnosis of Attention-Deficit/Hyperactivity Disorder requires medical evaluation and ongoing monitoring. It is recommended that Liam's attentional functioning continue to be monitored, and a referral to his physician may be considered if attention concerns persist or worsen.`,

  strengths_needs: `STRENGTHS
• Verbal Comprehension
• Visual Spatial Reasoning
• Fluid Reasoning
• Oral Language
• Mathematics
• Visual Memory
• Visual-Motor Integration
• Adaptive Functioning
• Peer Relationships
• Persistence and Motivation

WEAKNESSES
• Working Memory
• Processing Speed
• Reading Decoding
• Phonological Awareness
• Reading Comprehension
• Written Expression
• Verbal Memory
• Attention and Concentration
• Academic Anxiety`,

  recommendations: `Based on the results of this assessment, the following recommendations are being made to support Liam's educational programming and development.

1. Consideration should be given to placement in a special education program under the exceptionality of Learning Disability through the Identification, Placement, and Review Committee (IPRC) process.

2. An Individual Education Plan (IEP) should be developed based on the results from this assessment. The IEP should include accommodations and modifications to support Liam's learning needs in reading and written expression.

3. The nature of Liam's learning difficulties suggests that he could benefit from the regular use of assistive technology software for all language-based activities. Preparation of a Special Equipment Amount (SEA claim) is strongly advised. Recommended tools include text-to-speech software, speech-to-text software, and word prediction programs.

4. Liam would benefit from continued evidence-based reading intervention focused on phonological awareness, phonics, and decoding skills. A structured literacy approach is recommended.

5. Accommodations should include extended time for reading and writing tasks, access to audiobooks and text-to-speech technology, reduced written output requirements where appropriate, and the option to demonstrate knowledge through oral responses when feasible.

6. Liam's attentional difficulties and symptoms should be further discussed with a physician to determine whether further assessment or monitoring is warranted.

7. Strategies to support Liam's anxiety around academic tasks should be implemented, including providing encouragement, breaking tasks into manageable steps, and fostering a growth mindset approach to learning challenges.`,

  appendix: `The following more specific recommendations are made with a view to promoting Liam's optimal functioning.

WISC-V Cognitive Profile Recommendations:

Working Memory Recommendations:
- Liam's working memory performance was in the Low Average range. Working memory is important for holding information in mind while performing mental operations. When working memory is relatively lower than general intellectual ability, additional effort is needed to learn new material.
- Provide information in smaller chunks and check for understanding frequently before moving on to new concepts.
- Teach Liam to use external memory aids such as checklists, written step-by-step instructions, graphic organisers, and personal dictionaries.
- Repeat and rephrase important instructions and new information. Have Liam repeat instructions back to confirm understanding.
- Reduce the amount of information that must be held in mind at one time. For multi-step problems, provide written steps or allow Liam to complete one step at a time.
- Use visual supports alongside verbal instruction (e.g., diagrams, charts, concept maps) to reduce the load on auditory working memory.
- Teach mnemonic strategies and visualisation techniques to support memory encoding and retrieval.
- Provide additional time when Liam is required to hold and manipulate information mentally, such as during mental math, following oral directions, or note-taking.

Processing Speed Recommendations:
- Liam's processing speed was in the Low Average range. Processing speed reflects the ability to quickly and accurately scan, discriminate, and process simple visual information. Lower processing speed may affect the rate at which Liam completes tasks and may result in him needing more time relative to peers.
- Allow extended time on tests and assignments. The amount of extra time should be based on the nature of the task and Liam's individual needs.
- Reduce the volume of written work required. Focus on quality of responses rather than quantity.
- Avoid timed tasks that penalise slower processing. When speed is being assessed, consider separate accommodations.
- Provide advance organisers and outlines for lectures so that Liam does not need to simultaneously process and record new information.
- Allow the use of a calculator for math tasks to reduce the processing demand of basic computation.
- Provide copies of notes, slides, or graphic organisers rather than requiring Liam to copy information from the board at the pace of instruction.
- Allow Liam to use a keyboard or speech-to-text software for written output, as these tools may be faster and more efficient than handwriting.

GAI-CPI Discrepancy Recommendations:
- Liam's profile shows a significant discrepancy between his General Ability Index (GAI = 102, Average) and his Cognitive Proficiency Index (CPI = 85, Low Average). This pattern indicates that his reasoning and problem-solving abilities are stronger than his efficiency in processing and manipulating information.
- Instructional approaches should leverage Liam's reasoning strengths by teaching concepts at grade level while providing accommodations for processing demands.
- Encourage Liam to use his strong verbal reasoning to self-explain and elaborate on new material, as this engages his areas of strength.
- Be aware that Liam may understand concepts at a higher level than his work output suggests. Provide opportunities for him to demonstrate understanding through discussion, oral presentations, or projects that are not solely dependent on processing speed.
- Monitor for frustration that may arise when Liam perceives a gap between what he understands and what he can produce in a given time frame. Provide reassurance and strategies for managing task demands.

Reading Recommendations:
- Provide systematic, explicit instruction in phonological awareness and phonics using an evidence-based structured literacy programme (e.g., Orton-Gillingham, Empower Reading, or Wilson Reading System).
- Allow Liam to use text-to-speech software to access grade-level content across all subject areas.
- Provide access to audiobooks for novel studies and independent reading assignments.
- Pre-teach vocabulary and provide graphic organisers before reading assignments.
- Allow extended time for all reading tasks and assessments.
- Use high-interest, lower-reading-level texts to build reading confidence and fluency.

Writing Recommendations:
- Allow the use of speech-to-text software (e.g., Dragon NaturallySpeaking, Google Voice Typing) for written assignments.
- Provide word prediction software to support spelling and word retrieval.
- Teach explicit strategies for planning, organising, and revising written work (e.g., graphic organisers, templates, checklists).
- Reduce written output requirements where appropriate; allow alternative demonstrations of knowledge.
- Do not penalise spelling errors in content-area subjects.
- Provide copies of notes rather than requiring Liam to copy from the board.

Attention and Executive Functioning Recommendations:
- Provide preferential seating near the teacher and away from distractions.
- Break longer tasks into smaller, manageable steps with clear expectations and timelines.
- Use visual schedules, checklists, and timers to support task completion.
- Provide frequent check-ins and verbal prompts to redirect attention during independent work.
- Allow movement breaks during longer periods of sustained work.

Social-Emotional Recommendations:
- Implement strategies to reduce anxiety around academic tasks, including providing advance notice of tests, offering alternative assessment formats, and fostering a supportive classroom environment.
- Encourage participation in areas of strength and interest to build self-esteem.
- Monitor Liam's emotional well-being and refer to school-based counselling if anxiety symptoms increase.

Note that some of these recommendations may not be currently relevant, but should be applied if issues arise in later years.`,

  appendix_tables: `<table style="width:100%;border-collapse:collapse;margin:6pt 0 6pt 0;font-family:'Times New Roman',Times,serif;font-size:11pt;border:0.5pt solid #666">
<caption style="font-weight:bold;font-size:12pt;padding:6px 10px;text-align:left;border:0.5pt solid #666">WISC-V CDN Score Summary</caption>
<thead><tr style="background:#f0f0f5"><th style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:left;font-weight:bold">Index / Subtest</th><th style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:center;font-weight:bold">Standard Score</th><th style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:center;font-weight:bold">Percentile Rank</th><th style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:center;font-weight:bold">Classification</th></tr></thead>
<tbody>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Full Scale IQ (FSIQ)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">96</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">39</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Verbal Comprehension Index (VCI)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">105</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">63</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Similarities</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">11</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">63</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Vocabulary</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">11</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">63</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Visual Spatial Index (VSI)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">102</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">55</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Block Design</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">10</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">50</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Visual Puzzles</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">11</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">63</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Fluid Reasoning Index (FRI)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">98</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">45</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Matrix Reasoning</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">10</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">50</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Figure Weights</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">9</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">37</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Working Memory Index (WMI)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">88</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">21</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Digit Span</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">8</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">25</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Picture Span</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">7</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">16</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Processing Speed Index (PSI)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">85</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">16</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Coding</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">7</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">16</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">&nbsp;&nbsp;Symbol Search</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">7</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">16</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr><td colspan="4" style="padding:6px 10px;border:0.5pt solid #999;font-weight:bold;font-size:11pt">Ancillary Indexes</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">General Ability Index (GAI)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">102</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">55</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Cognitive Proficiency Index (CPI)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">85</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">16</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Nonverbal Index (NVI)</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">93</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">32</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
</tbody></table>

<table style="width:100%;border-collapse:collapse;margin:6pt 0 6pt 0;font-family:'Times New Roman',Times,serif;font-size:11pt;border:0.5pt solid #666">
<caption style="font-weight:bold;font-size:12pt;padding:6px 10px;text-align:left;border:0.5pt solid #666">WIAT-III CDN Score Summary</caption>
<thead><tr style="background:#f0f0f5"><th style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:left;font-weight:bold">Subtest / Composite</th><th style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:center;font-weight:bold">Standard Score</th><th style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:center;font-weight:bold">Percentile Rank</th><th style="padding:3px 10px;border:0.5pt solid #666;font-size:10pt;text-align:center;font-weight:bold">Classification</th></tr></thead>
<tbody>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">Listening Comprehension</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">100</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">50</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">Word Reading</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">85</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">16</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">Pseudoword Decoding</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">78</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">7</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">Reading Comprehension</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">86</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">18</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">Spelling</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">84</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">14</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">Sentence Composition</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">88</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">21</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">Essay Composition</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">85</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">16</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="background:#fafaff"><td style="padding:3px 10px;border:0.5pt solid #999">Math Problem Solving</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">96</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">42</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="background:#fff"><td style="padding:3px 10px;border:0.5pt solid #999">Numerical Operations</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">95</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">39</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Oral Language Composite</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">100</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">50</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Total Reading Composite</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">84</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">14</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Basic Reading Composite</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">80</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">9</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Written Expression Composite</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">85</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">16</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Low Average</td></tr>
<tr style="font-weight:bold;background:#f0f0fa"><td style="padding:3px 10px;border:0.5pt solid #999">Mathematics Composite</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">95</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">40</td><td style="padding:3px 10px;border:0.5pt solid #999;text-align:center">Average</td></tr>
</tbody></table>`,
};

export default function App() {
  const [tab, setTab] = useState("preview");
  const [genning, setGenning] = useState(false);
  const [customPrompts, setCustomPrompts] = usePersistedJSON("psychoed-custom-prompts", {});
  const [userPrompts, setUserPrompts] = usePersistedJSON("psychoed-user-prompts", []);
  const [toast, setToast] = useState(null);
  const fRef = useRef(null);
  const secFileRef = useRef(null);
  const [secUploadTarget, setSecUploadTarget] = useState(null);
  const reportRef = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [privacyMode, setPrivacyMode] = useState(true);

  // Credentials kept in memory (localStorage not available in artifact sandbox)
  const [accessPassword, setAccessPassword] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [apiKey, setApiKey] = usePersistedState("psychoed-api-key", "");
  const [openaiModel, setOpenaiModel] = usePersistedState("psychoed-model", OPENAI_MODEL_DEFAULT);
  const [showPassword, setShowPassword] = useState(false);
  const [showSavedCases, setShowSavedCases] = useState(false);

  const [dragging, setDragging] = useState(false);
  const showToast = useCallback((message, type = "info") => {
    setToast({ message, type, key: Date.now() });
  }, []);

  // AbortController for cancelling in-flight AI generation requests
  const abortControllerRef = useRef(null);
  const cancelGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const [meta, setMeta] = useState({
    fullName: "", dob: "", ageAtTesting: "", grade: "", school: "",
    testingDates: ["", "", "", ""],
    reportDate: "",
    author: "Dr. Ewa J. Antczak, C.Psych.", authorTitle: "School Psychologist",
    pronouns: "he/him", isLocked: false, otherToolText: "",
  });

  // Auto-derive firstName from fullName (first word) — memoized
  const derivedFirstName = useMemo(() => (meta.fullName || "").trim().split(/\s+/)[0] || "", [meta.fullName]);

  // ── Age-based cognitive instrument selection ──
  const derivedAge = useMemo(() => ageFromAgeAtTesting(meta.ageAtTesting), [meta.ageAtTesting]);
  const useWAISByAge = derivedAge ? derivedAge.totalMonths >= 203 : false; // 16 years 11 months = 203 months
  const useWPPSIByAge = derivedAge ? derivedAge.totalMonths < 83 : false;   // under 6 years 11 months = 83 months

  /** Shorthand: apply [firstName] + pronoun placeholders using current meta */
  const pz = useCallback((text) => personalize(text, derivedFirstName, meta.pronouns), [derivedFirstName, meta.pronouns]);

  const DEFAULT_TOOL_IDS = ["wisc-v","wiat-iii","wraml-3","beery-6","basc-3-p","basc-3-t","conners-4-p","conners-4-t","vineland-3","interview"];
  const [tools, setTools] = useState(TOOLS.map((t) => ({
    ...t,
    used: DEFAULT_TOOL_IDS.includes(t.id),
  })));
  const OBS_DEFAULT_MENU = {
    strengths: ["POLITE_KIND", "HEALTHY_ALERT", "COOP_MOTIVATED", "COMFORTABLE", "CURIOUS", "NO_DIFF_INSTRUCTIONS", "BEST_EFFORT", "ASKED_CLARIFY"],
    attention: ["ATTENTION_SUSTAINED", "MOTOR_NORMAL", "NO_IMPULSIVE", "EYE_CONTACT_CONSISTENT"],
    motor: ["RIGHT_HAND", "TRIPOD_GRIP", "LEGIBLE"],
    validity: ["VALID_ESTIMATE"],
    validityModifiers: [],
  };
  const OBS_DEFAULT_BODY = composeBehObsText(OBS_DEFAULT_MENU);
  const OBS_DEFAULT_CONTENT = OBS_DEFAULT_BODY ? BEH_OBS_STANDARD_OPENING + "\n\n" + OBS_DEFAULT_BODY : BEH_OBS_STANDARD_OPENING;

  const [docs, setDocs] = useState([]);
  const [secs, setSecs] = useState(() => {
    const o = {};
    const defaultTableBlocks = DEFAULT_TOOL_IDS.filter((id) => TOOLS_WITH_TABLES.has(id));
    TABS.filter((t) => !["case_info", "documents", "preview", "prompt_reference"].includes(t.id)).forEach((t) => {
      o[t.id] = {
        content: t.id === "observations" ? OBS_DEFAULT_CONTENT : "",
        status: t.id === "interpretation_note" ? SS.APPROVED : SS.DRAFT,
        ctx: "",
        docIds: [],
        aiSources: { notes: true, docs: true, draft: false },
        ...(t.id === "observations" ? { behObsMenu: { ...OBS_DEFAULT_MENU } } : {}),
        ...(t.id === "social_emotional" ? { seModifier: "STANDARD", seInterview: "", seOtherDesc: "", seRatingScales: [] } : {}),
        ...(t.id === "summary" ? { formModifiers: ["LD"] } : {}),
        ...(t.id === "recommendations" ? { recBlocks: ["LD","IEP","SEA","REFERRALS","SE"], recEduLevel: "ELEMENTARY" } : {}),
        ...(t.id === "appendix" ? { appendixBlocks: ["READING","WRITING","ATTENTION_EF","SE_SUPPORT"] } : {}),
        ...(t.id === "appendix_tables" ? { tableBlocks: defaultTableBlocks } : {}),
      };
    });
    return o;
  });
  const [upModal, setUpModal] = useState(null);
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [interpNoteType, setInterpNoteType] = useState("minor"); // "minor" or "adult"
  const saveTimerRef = useRef(null);
  const lastSavedRef = useRef({ meta: null, tools: null, docs: null, secs: null, privacyMode: null });

    useEffect(() => {
    const age = meta.ageAtTesting?.trim();
    if (!age) return;
    const num = parseInt(age, 10);
    if (!isNaN(num)) setInterpNoteType(num >= 18 ? "adult" : "minor");
  }, [meta.ageAtTesting]);

  // ── Auto-select cognitive tool based on age ──
  useEffect(() => {
    if (!derivedAge) return;
    const cogToolIds = new Set(["wais-iv", "wppsi-iv", "wisc-v"]);
    let targetId = "wisc-v";
    if (derivedAge.totalMonths >= 203) targetId = "wais-iv";
    else if (derivedAge.totalMonths < 83) targetId = "wppsi-iv";
    setTools((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (!cogToolIds.has(t.id)) return t;
        const shouldBeUsed = t.id === targetId;
        if (t.used !== shouldBeUsed) { changed = true; return { ...t, used: shouldBeUsed }; }
        return t;
      });
      return changed ? next : prev;
    });
  }, [derivedAge]);

  // Auto-personalize ALL section content when name or pronouns change
  // For observations, rebuild from templates to ensure pronoun changes take effect
  useEffect(() => {
    if (!derivedFirstName) return;
    setSecs((p) => {
      let changed = false;
      const next = { ...p };

      // Special handling for observations: rebuild from templates so pronoun changes apply
      const obs = next.observations;
      if (obs && obs.behObsMenu && obs.status !== SS.APPROVED) {
        const body = composeBehObsText(obs.behObsMenu);
        const opening = BEH_OBS_STANDARD_OPENING;
        let content = body ? opening + "\n\n" + body : opening;
        content = capitalizeSentences(personalize(content, derivedFirstName, meta.pronouns));
        if (content !== obs.content) {
          next.observations = { ...obs, content };
          changed = true;
        }
      }

      // For all other sections, replace remaining placeholders
      for (const sid of Object.keys(next)) {
        if (sid === "observations") continue;
        const s = next[sid];
        if (!s || s.status === SS.APPROVED) continue;
        const c = s.content || "";
        if (/\[pronoun\]|\[possessive\]|\[object\]|\[reflexive\]|\[firstName\]|\[First Name\]/i.test(c)) {
          const updated = personalize(c, derivedFirstName, meta.pronouns);
          if (updated !== c) {
            next[sid] = { ...s, content: updated };
            changed = true;
          }
        }
      }
      return changed ? next : p;
    });
  }, [meta.pronouns, derivedFirstName]);

  // Auto-calculate age from DOB and first testing date
  useEffect(() => {
    const dob = meta.dob;
    if (!dob) return;
    const refDate = meta.testingDates?.find(Boolean) || meta.reportDate || new Date().toISOString().split("T")[0];
    const birth = new Date(dob + "T00:00:00");
    const ref = new Date(refDate + "T00:00:00");
    if (isNaN(birth.getTime()) || isNaN(ref.getTime()) || ref <= birth) return;
    let years = ref.getFullYear() - birth.getFullYear();
    let months = ref.getMonth() - birth.getMonth();
    if (ref.getDate() < birth.getDate()) months--;
    if (months < 0) { years--; months += 12; }
    const ageStr = `${years} years, ${months} month${months !== 1 ? "s" : ""}`;
    setMeta((p) => (p.ageAtTesting === ageStr ? p : { ...p, ageAtTesting: ageStr }));
  }, [meta.dob, meta.testingDates, meta.reportDate]);

    useEffect(() => {
    const g = (meta.grade || "").trim().toLowerCase();
    if (!g) return;
    const num = parseInt(g.replace(/[^0-9]/g, ""), 10);
    let level = "ELEMENTARY";
    if (/college|university|post.?secondary/i.test(g)) level = "COLLEGE_UNI";
    else if (!isNaN(num) && num >= 9) level = "HIGH_SCHOOL";
    else if (!isNaN(num) && num <= 8) level = "ELEMENTARY";
    setSecs((prev) => {
      if (prev.recommendations?.recEduLevel === level) return prev;
      return { ...prev, recommendations: { ...prev.recommendations, recEduLevel: level } };
    });
  }, [meta.grade]);

    useEffect(() => {
    const src = interpNoteType === "adult" ? INTERP_NOTE_ADULT : INTERP_NOTE_MINOR;
    const txt = personalize(src, derivedFirstName, meta.pronouns);
    setSecs((prev) => {
      const current = prev.interpretation_note?.content || "";
      // Only auto-fill if content is empty OR still matches one of the two templates
      // (i.e., user hasn't manually edited it)
      const minorTxt = personalize(INTERP_NOTE_MINOR, derivedFirstName, meta.pronouns);
      const adultTxt = personalize(INTERP_NOTE_ADULT, derivedFirstName, meta.pronouns);
      // Also check with previous name/pronoun combos by testing the raw template markers
      const isTemplate = !current.trim()
        || current === minorTxt || current === adultTxt
        || current === INTERP_NOTE_MINOR || current === INTERP_NOTE_ADULT
        || /\[firstName\]/.test(current);
      if (!isTemplate) return prev; // User has edited — don't overwrite
      return {
        ...prev,
        interpretation_note: { ...prev.interpretation_note, content: txt },
      };
    });
  }, [derivedFirstName, meta.pronouns, interpNoteType]);

    useEffect(() => {
    setSecs((prev) => {
      const se = prev.social_emotional;
      if (!se || se.status === SS.APPROVED) return prev;
      const current = se.seRatingScales || [];
      const selectedToolIds = tools.filter((t) => t.used && TOOL_TO_SE_MAP[t.id]).map((t) => t.id);

      let updated = [...current];
      let changed = false;

      // Add missing auto entries
      for (const toolId of selectedToolIds) {
        if (!updated.some((rs) => rs.fromToolId === toolId)) {
          const m = TOOL_TO_SE_MAP[toolId];
          updated.push(makeSeTestWindow(m.testType, m.respondentType, toolId, m.otherTestName || ""));
          changed = true;
        }
      }
      // Remove auto entries whose tool was deselected
      const before = updated.length;
      updated = updated.filter((rs) => !rs.fromToolId || selectedToolIds.includes(rs.fromToolId));
      if (updated.length !== before) changed = true;

      if (!changed) return prev;
      return { ...prev, social_emotional: { ...se, seRatingScales: updated } };
    });
  }, [tools]);

  // Auto-sync tableBlocks from tools: add when tool selected, remove when deselected.
  useEffect(() => {
    const selectedWithTables = tools.filter((t) => t.used && TOOLS_WITH_TABLES.has(t.id)).map((t) => t.id);
    setSecs((prev) => {
      const at = prev.appendix_tables;
      if (!at || at.status === SS.APPROVED) return prev;
      const current = at.tableBlocks || [];
      let updated = [...current];
      let changed = false;
      // Add missing blocks for newly selected tools
      for (const id of selectedWithTables) {
        if (!updated.includes(id)) { updated.push(id); changed = true; }
      }
      // Remove blocks whose tool was deselected
      const before = updated.length;
      updated = updated.filter((id) => selectedWithTables.includes(id));
      if (updated.length !== before) changed = true;
      if (!changed) return prev;
      return { ...prev, appendix_tables: { ...at, tableBlocks: updated } };
    });
  }, [tools]);

  // Stable key for tableBlocks to use as dependency (avoids object reference issues)
  const tableBlocksKey = (secs.appendix_tables?.tableBlocks || []).join(",");

  // Auto-fill appendix tables from uploaded PDFs and generated section content.
  // Always builds the 3 mandatory tables; fills scores when available.
  // Track cognitive _waisScores to know when to re-run
  const waisScoresKey = JSON.stringify(secs.cognitive?._waisScores || null);
  const cogContentKey = (secs.cognitive?.content || "").length;
  const acadContentKey = (secs.academic?.content || "").length;
  const memContentKey = (secs.memory?.content || "").length;

  useEffect(() => {
    setSecs((prev) => {
      const at = prev.appendix_tables;
      if (!at || at.status === SS.APPROVED) return prev;
      // Extract scores from all uploaded docs
      const scoreMap = extractAllScoresMap(docs);

      // Also extract from generated section content
      const pseudoDocs = [];
      const cogContent = prev.cognitive?.content?.replace(/[⟦⟧]/g, "")?.trim();
      if (cogContent && cogContent.length > 100 && /WISC|WPPSI|WAIS|Wechsler|FSIQ|VCI|VSI|FRI|WMI|PSI|PRI/i.test(cogContent)) {
        pseudoDocs.push({ extractedText: cogContent, name: "_cognitive_", _docxTables: null, _pdfPages: null });
      }
      const acadContent = prev.academic?.content?.replace(/[⟦⟧]/g, "")?.trim();
      if (acadContent && acadContent.length > 100 && /WIAT/i.test(acadContent)) {
        pseudoDocs.push({ extractedText: acadContent, name: "_academic_", _docxTables: null, _pdfPages: null });
      }
      const memContent = prev.memory?.content?.replace(/[⟦⟧]/g, "")?.trim();
      if (memContent && memContent.length > 100 && /WRAML/i.test(memContent)) {
        pseudoDocs.push({ extractedText: memContent, name: "_memory_", _docxTables: null, _pdfPages: null });
      }
      if (pseudoDocs.length > 0) {
        const sectionScores = extractAllScoresMap(pseudoDocs);
        for (const [k, val] of Object.entries(sectionScores)) {
          if (!scoreMap[k]) scoreMap[k] = val;
        }
      }

      // Merge stored WAIS scores from AI-generated cognitive section
      const waisScores = prev.cognitive?._waisScores;
      if (waisScores) {
        for (const [k, val] of Object.entries(waisScores)) {
          if (!scoreMap[k]) scoreMap[k] = val;
        }
      }

      // Inject WAIS-IV manual scores into scoreMap for appendix tables
      const waisManual = prev.cognitive?.waisManual;
      if (waisManual) {
        const wm = waisManual;
        const waisIdx = [["FSIQ","fsiq"],["VCI","vci"],["PRI","pri"],["WMI","wmi"],["PSI","psi"],["GAI","gai"]];
        for (const [abbr, key] of waisIdx) {
          if (wm[key + "Score"]) {
            scoreMap[`WAIS.${abbr}.score`] = wm[key + "Score"];
            if (wm[key + "Percentile"]) {
              scoreMap[`WAIS.${abbr}.percentile`] = wm[key + "Percentile"];
              scoreMap[`WAIS.${abbr}.qualitative`] = percentileToDescriptor(wm[key + "Percentile"]) || "";
            }
          }
        }
        // Inject WAIS subtests
        for (const abbr of ["SI","VC","IN","BD","MR","VP","DS","AR","SS","CD"]) {
          if (wm[`sub_${abbr}_scaled`] && !scoreMap[`WAIS.${abbr}.scaled`]) {
            scoreMap[`WAIS.${abbr}.scaled`] = wm[`sub_${abbr}_scaled`];
            if (wm[`sub_${abbr}_pct`]) scoreMap[`WAIS.${abbr}.percentile`] = wm[`sub_${abbr}_pct`];
          }
        }
      }

      // Inject WPPSI-IV manual scores into scoreMap for appendix tables
      const wppsiManual = prev.cognitive?.wppsiManual;
      if (wppsiManual) {
        const wm = wppsiManual;
        const wppsiIdx = [["FSIQ","fsiq"],["VCI","vci"],["VSI","vsi"],["FRI","fri"],["WMI","wmi"],["PSI","psi"]];
        for (const [abbr, key] of wppsiIdx) {
          if (wm[key + "Score"]) {
            scoreMap[`WPPSI.${abbr}.score`] = wm[key + "Score"];
            if (wm[key + "Percentile"]) {
              scoreMap[`WPPSI.${abbr}.percentile`] = wm[key + "Percentile"];
              scoreMap[`WPPSI.${abbr}.qualitative`] = percentileToDescriptor(wm[key + "Percentile"]) || "";
            }
          }
        }
        // Inject WPPSI subtests
        for (const abbr of ["RV","IN","BD","OA","MR","PC","PM","ZL","BS","CA"]) {
          if (wm[`sub_${abbr}_scaled`] && !scoreMap[`WPPSI.${abbr}.scaled`]) {
            scoreMap[`WPPSI.${abbr}.scaled`] = wm[`sub_${abbr}_scaled`];
            if (wm[`sub_${abbr}_pct`]) scoreMap[`WPPSI.${abbr}.percentile`] = wm[`sub_${abbr}_pct`];
          }
        }
      }

      const hasAnyScores = Object.keys(scoreMap).length > 0;
      if (!hasAnyScores) return prev; // No scores found — leave existing content alone
      // Determine cognitive test type: age-based first, then tool selection, then auto-detect from scoreMap keys
      let cogTestType = useWAISByAge ? "wais-iv" : useWPPSIByAge ? "wppsi-iv" : "wisc-v";
      if (cogTestType === "wisc-v") {
        if (tools.find(t => t.id === "wais-iv" && t.used)) cogTestType = "wais-iv";
        else if (tools.find(t => t.id === "wppsi-iv" && t.used)) cogTestType = "wppsi-iv";
        else if (Object.keys(scoreMap).some(k => k.startsWith("WAIS."))) cogTestType = "wais-iv";
        else if (Object.keys(scoreMap).some(k => k.startsWith("WPPSI."))) cogTestType = "wppsi-iv";
      }
      const html = buildMandatoryAppendixTablesHTML(derivedFirstName || "[firstName]", scoreMap, cogTestType);
      if (!html || html === (at.content || "")) return prev;
      return { ...prev, appendix_tables: { ...at, content: html } };
    });
  }, [docs, derivedFirstName, tools, tableBlocksKey, waisScoresKey, cogContentKey, acadContentKey, memContentKey, useWAISByAge, useWPPSIByAge]);

    useEffect(() => {
    const id = "psychoed-print-styles";
    if (!document.getElementById(id)) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = PRINT_STYLES;
      document.head.appendChild(style);
    }
  }, []);

    useEffect(() => {
    const id = "psychoed-keyframes";
    if (!document.getElementById(id)) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = `@keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
      document.head.appendChild(style);
    }
  }, []);

    useEffect(() => {
    setAutoLoaded(true);

    // Warn before closing tab to prevent accidental data loss
    const handleBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "You have unsaved report data. Are you sure you want to leave?";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const uSec = useCallback((id, u) => {
    setSecs((p) => ({ ...p, [id]: { ...p[id], ...u } }));
  }, []);

  const savePrompt = useCallback((sid, text) => {
    setCustomPrompts((p) => ({ ...p, [sid]: text }));
  }, []);

  const deletePrompt = useCallback((sid) => {
    setCustomPrompts((p) => { const n = { ...p }; delete n[sid]; return n; });
  }, []);

  // ── User-created prompt handlers ──
  const addUserPrompt = useCallback((name, text) => {
    setUserPrompts((p) => [...p, { id: "up_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6), name, text }]);
  }, []);
  const saveUserPrompt = useCallback((id, text) => {
    setUserPrompts((p) => p.map((u) => u.id === id ? { ...u, text } : u));
  }, []);
  const renameUserPrompt = useCallback((id, name) => {
    setUserPrompts((p) => p.map((u) => u.id === id ? { ...u, name } : u));
  }, []);
  const removeUserPrompt = useCallback((id) => {
    setUserPrompts((p) => p.filter((u) => u.id !== id));
  }, []);

  const togDoc = useCallback((sid, did) => {
    setSecs((p) => {
      const ids = p[sid].docIds || [];
      const newIds = ids.includes(did) ? ids.filter((x) => x !== did) : [...ids, did];
      const updates = { ...p[sid], docIds: newIds };

      // Auto-fill memory when WRAML3 doc toggled ON and content is empty
      if (sid === "memory" && !ids.includes(did) && (!p[sid].content || !p[sid].content.trim())) {
        const doc = docs.find((d) => d.id === did);
        if (doc?.extractedText?.match(/WRAML/i)) {
          const memDocs = docs.filter((d) => newIds.includes(d.id));
          const text = extractMemoryText(memDocs, derivedFirstName, meta.pronouns);
          if (text) updates.content = text;
        }
      }

      return { ...p, [sid]: updates };
    });
  }, [docs, derivedFirstName, meta.pronouns]);

    const processFile = useCallback((f, forSection) => {
    if (!f) return;
    const dataReader = new FileReader();
    dataReader.onload = async (ev) => {
      const base64Data = ev.target.result;
      const isPdfOrImage = f.type === "application/pdf" || f.type?.startsWith("image/");
      const isDocx = f.type?.includes("word") || /\.docx$/i.test(f.name);
      if (isPdfOrImage || isDocx) showToast("Extracting text from file...", "info");

      let extracted = "";
      let _pdfPages = null;
      let _docxTables = null;

      try {
        if (f.type === "application/pdf" && base64Data) {
          // Use structured PDF parser — get both text and page data
          const parsed = await parsePDFStructured(base64Data, (msg) => showToast(msg, "info"));
          extracted = parsed.fullText || "";
          _pdfPages = parsed.pages || null;
          if (!extracted || extracted.length <= 50) {
            showToast("PDF had very little extractable text. Paste scores manually.", "info");
            extracted = "[PDF uploaded. Paste the relevant scores and text content into the Assessment Notes field for this section.]";
          }
        } else if (isDocx && base64Data) {
          try {
            const parsed = await parseDocxStructured(base64Data, (msg) => showToast(msg, "info"));
            extracted = parsed.fullText || "";
            _docxTables = parsed.tables || null;
            if (!extracted || extracted.length <= 50) {
              extracted = "[Word document uploaded — paste relevant content into Assessment Notes.]";
            }
          } catch (docxErr) {
            // DOCX parsing failed
            extracted = "[Word document uploaded — paste relevant content into Assessment Notes.]";
          }
        } else {
          extracted = await extractTextFromFile(f, (msg) => showToast(msg, "info"), base64Data);
        }
      } catch (parseErr) {
        // File parsing failed
        extracted = await extractTextFromFile(f, (msg) => showToast(msg, "info"), base64Data);
      }

      // Auto-classify based on content and filename
      const autoCats = autoClassifyDoc(extracted, f.name);
      const newId = "d" + Date.now();
      const newDoc = {
        id: newId,
        name: f.name,
        size: f.size,
        type: f.type,
        categories: autoCats,
        autoClassified: true,
        uploadedAt: Date.now(),
        extractedText: extracted || "",
        data: base64Data || "",
        _pdfPages,     // Structured PDF page data for deterministic extraction
        _docxTables,   // Structured DOCX tables for deterministic extraction
      };
      setDocs((p) => [...p, newDoc]);

        // Auto-link to ALL sections whose SEC_CAT_MAP categories overlap with doc categories
        setSecs((p) => {
          const next = { ...p };
          for (const [secId, secCats] of Object.entries(SEC_CAT_MAP)) {
            if (!next[secId]) continue;
            const matches = autoCats.some((c) => secCats.includes(c));
            if (matches) {
              const existing = next[secId].docIds || [];
              if (!existing.includes(newId)) {
                next[secId] = { ...next[secId], docIds: [...existing, newId] };
              }
            }
          }
          // Also ensure the explicit forSection is linked even if categories didn't match
          if (forSection && next[forSection]) {
            const existing = next[forSection].docIds || [];
            if (!existing.includes(newId)) {
              next[forSection] = { ...next[forSection], docIds: [...existing, newId] };
            }
          }
          return next;
        });

        const hasText = extracted && !extracted.startsWith("[");

        // Auto-populate empty Case Info fields from uploaded document headers
        if (hasText) {
          const caseInfo = extractCaseInfo(extracted);
          if (Object.keys(caseInfo).length > 0) {
            setMeta((prev) => {
              const next = { ...prev };
              let changed = false;
              // Only fill fields that are currently empty
              if (caseInfo.fullName && !prev.fullName.trim()) { next.fullName = caseInfo.fullName; changed = true; }
              if (caseInfo.dob && !prev.dob.trim()) { next.dob = caseInfo.dob; changed = true; }
              if (caseInfo.ageAtTesting && !prev.ageAtTesting.trim()) { next.ageAtTesting = caseInfo.ageAtTesting; changed = true; }
              if (caseInfo.grade && !prev.grade.trim()) { next.grade = caseInfo.grade; changed = true; }
              if (caseInfo.school && !prev.school.trim()) { next.school = caseInfo.school; changed = true; }
              if (caseInfo.pronouns && prev.pronouns === "he/him") { next.pronouns = caseInfo.pronouns; changed = true; }
              if (caseInfo.testingDates && prev.testingDates.every((d) => !d)) {
                const td = [...prev.testingDates];
                caseInfo.testingDates.forEach((d, i) => { if (i < td.length) td[i] = d; });
                next.testingDates = td;
                changed = true;
              }
              return changed ? next : prev;
            });
            const filled = Object.keys(caseInfo).filter((k) => k !== "dobRaw" && k !== "pronouns");
            if (filled.length > 0) {
              showToast(`Auto-filled: ${filled.map((k) => k === "testingDates" ? "testing dates" : k === "fullName" ? "name" : k).join(", ")}`, "info");
            }
          }
        }

        // Build list of auto-linked sections for toast
        const linkedSections = Object.entries(SEC_CAT_MAP)
          .filter(([, secCats]) => autoCats.some((c) => secCats.includes(c)))
          .map(([secId]) => TABS.find((t) => t.id === secId)?.label || secId)
          .filter((label) => !["Summary", "Strengths & Needs", "Identification", "Recommendations", "Appendix"].includes(label));

        showToast(
          hasText
            ? `"${f.name}" → ${autoCats.join(", ")}${linkedSections.length > 0 ? ` · Auto-linked to: ${linkedSections.slice(0, 3).join(", ")}${linkedSections.length > 3 ? ` +${linkedSections.length - 3}` : ""}` : ""}`
            : `"${f.name}" uploaded — paste scores into Assessment Notes`,
          hasText ? "success" : "info"
        );
    };
    dataReader.readAsDataURL(f);
  }, [showToast]);

    const handleFile = useCallback((e) => {
    const files = e.target.files || [];
    for (let i = 0; i < files.length; i++) {
      processFile(files[i]);
    }
    e.target.value = "";
  }, [processFile]);

    const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files) {
      for (let i = 0; i < files.length; i++) {
        processFile(files[i]);
      }
    }
  }, [processFile]);

  const handleSecFile = useCallback((e) => {
    const f = (e.target.files || [])[0];
    if (!f) return;
    processFile(f, secUploadTarget);
    e.target.value = "";
  }, [secUploadTarget, processFile]);

  // Open the classification modal for an existing document
  const editDocCats = useCallback((doc) => {
    setUpModal({
      docId: doc.id,
      name: doc.name,
      size: doc.size,
      type: doc.type,
      cats: [...doc.categories],
      extractedText: doc.extractedText || "",
    });
  }, []);

  // Save updated categories from the edit modal
  const saveCats = useCallback(() => {
    if (!upModal || !upModal.docId) return;
    setDocs((p) =>
      p.map((d) =>
        d.id === upModal.docId
          ? { ...d, categories: upModal.cats, autoClassified: false }
          : d
      )
    );
    showToast(`Categories updated for "${upModal.name}"`, "success");
    setUpModal(null);
  }, [upModal, showToast]);

  const rmDoc = useCallback((id) => {
    setDocs((p) => p.filter((d) => d.id !== id));
    // Clean references from all sections (immutable update)
    setSecs((p) => {
      const next = {};
      for (const k of Object.keys(p)) {
        const sec = p[k];
        if (sec.docIds && sec.docIds.includes(id)) {
          next[k] = { ...sec, docIds: sec.docIds.filter((x) => x !== id) };
        } else {
          next[k] = sec;
        }
      }
      return next;
    });
  }, []);

  const selDocs = useCallback(
    (sid) => docs.filter((d) => (secs[sid]?.docIds || []).includes(d.id)),
    [docs, secs]
  );

  const applyQ = useCallback((sid, txt) => {
    setSecs((p) => {
      const s = p[sid];
      if (!s || s.status === SS.APPROVED) return p;
      const replaced = capitalizeSentences(sanitizeTone(personalize(txt, derivedFirstName, meta.pronouns)));
      // Toggle: if content already ends with this text, remove it
      const content = s.content || "";
      if (content.trimEnd().endsWith(replaced.trimEnd())) {
        const idx = content.lastIndexOf(replaced.trim());
        const newContent = content.slice(0, idx).replace(/\n+$/, "");
        return { ...p, [sid]: { ...s, content: newContent } };
      }
      return {
        ...p,
        [sid]: { ...s, content: (content ? content + "\n\n" : "") + replaced },
      };
    });
  }, [derivedFirstName, meta.pronouns]);

    const updateBehObsMenu = useCallback((newMenu) => {
    setSecs((p) => {
      const obs = p.observations;
      if (!obs || obs.status === SS.APPROVED) return p;
      const body = composeBehObsText(newMenu);
      const opening = BEH_OBS_STANDARD_OPENING;
      let content = body ? opening + "\n\n" + body : opening;
      if (derivedFirstName) {
        content = capitalizeSentences(personalize(content, derivedFirstName, meta.pronouns));
      }
      return { ...p, observations: { ...obs, behObsMenu: newMenu, content } };
    });
  }, [derivedFirstName, meta.pronouns]);

    const gen = useCallback(async (sid) => {
    const s = secs[sid];
    if (!s || s.status === SS.APPROVED) return;

    const src = s.aiSources || { notes: true, docs: true, draft: false };

    cancelGeneration();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setGenning(true);
    try {
            if (sid === "cognitive" || sid === "summary" || sid === "recommendations" || sid === "appendix_tables") {
        // ── DETERMINISTIC EXTRACTION — NO AI ──
        // Find all docs with WISC content
        const wiscDocs = docs.filter((d) => d.extractedText && d.extractedText.length > 100 && /WISC|WPPSI|WAIS|Wechsler/i.test(d.extractedText));
        const allTextDocs = docs.filter((d) => d.extractedText && d.extractedText.length > 100 && !d.extractedText.startsWith("["));

        if (sid === "cognitive") {
          // ── Helper: Generate AI academic impact summary for cognitive scores ──
          const generateCogImpactSummary = async (baseContent, testName, scoreSummary) => {
            uSec(sid, { content: baseContent + "\n\n[Generating academic impact summary...]" });
            try {
              const impactPrompt = `Write an Academic Impact paragraph (150-250 words) for a psychoeducational assessment report.

Based on the following ${testName} cognitive scores, write a cohesive paragraph that:
1. Describes how this cognitive profile is expected to impact academic functioning
2. Connects specific cognitive strengths to areas where the student is likely to perform well academically
3. Connects specific cognitive weaknesses to areas where the student may experience academic difficulty
4. Addresses implications for reading, writing, mathematics, and classroom learning as relevant
5. Discusses how the pattern of strengths and weaknesses may interact (e.g., strong verbal but weak processing speed may mean the student understands content but struggles with timed work)
6. Uses cautious, professional language — "may", "suggests", "is expected to", "at times"

SCORES:
${scoreSummary}

Use [firstName] and correct pronouns throughout. Do NOT use bullet points. Write in connected paragraphs. Do NOT restate individual scores — synthesize them into a functional academic narrative. Output only the paragraph(s).`;

              const result = await aiGen(
                meta, tools, impactPrompt,
                { name: "Standard", desc: "Functional impact, strengths-based, Ontario style." },
                "", [], GLOBAL_TONE_RULES, 2000, "cognitive",
                accessPassword, proxyUrl, apiKey, controller.signal, openaiModel
              );
              if (result.ok) {
                let impact = cleanAIOutput(result.text, "cognitive");
                if (!/academic\s+impact|implications?\s+for\s+academic|impact\s+on\s+learning/i.test(impact)) {
                  impact = "Academic Impact\n\n" + impact;
                }
                return baseContent + "\n\n" + impact;
              }
            } catch (e) { /* fall through */ }
            return baseContent;
          };

          // ── WAIS-IV (age >= 16): Try PDF extraction first, then manual entry ──
          if (useWAISByAge) {
            // Try PDF extraction
            const waisDocs = docs.filter(d => d.extractedText && d.extractedText.length > 100 && /WAIS|Wechsler\s*Adult/i.test(d.extractedText));
            const pdfResult = extractWAISCogText(waisDocs.length > 0 ? waisDocs : allTextDocs);
            let wm, scoreSummary;
            if (pdfResult) {
              wm = pdfResult.wm;
              scoreSummary = buildCogScoreSummary("WAIS-IV", pdfResult.scores, [
                ["fsiq", "Full Scale IQ"], ["vci", "Verbal Comprehension"], ["pri", "Perceptual Reasoning"],
                ["wmi", "Working Memory"], ["psi", "Processing Speed"],
              ]);
              // Also populate manual fields so UI stays in sync
              uSec(sid, { waisManual: { ...secs.cognitive?.waisManual, ...wm } });
            } else {
              // Fall back to manual entry
              wm = secs.cognitive?.waisManual || {};
              const missing = [];
              if (!wm.fsiqScore?.trim()) missing.push("FSIQ Score");
              if (!wm.fsiqPercentile?.trim()) missing.push("FSIQ Percentile");
              if (!wm.vciScore?.trim()) missing.push("VCI Score");
              if (!wm.vciPercentile?.trim()) missing.push("VCI Percentile");
              if (!wm.priScore?.trim()) missing.push("PRI Score");
              if (!wm.priPercentile?.trim()) missing.push("PRI Percentile");
              if (!wm.wmiScore?.trim()) missing.push("WMI Score");
              if (!wm.wmiPercentile?.trim()) missing.push("WMI Percentile");
              if (!wm.psiScore?.trim()) missing.push("PSI Score");
              if (!wm.psiPercentile?.trim()) missing.push("PSI Percentile");
              if (missing.length > 0) {
                showToast("No WAIS-IV scores found in PDFs. Missing manual fields: " + missing.join(", "), "error");
                setGenning(false);
                return;
              }
              scoreSummary = `Test: WAIS-IV\nFull Scale IQ: ${wm.fsiqScore} (${wm.fsiqPercentile}th percentile)\nVerbal Comprehension: ${wm.vciScore} (${wm.vciPercentile}th percentile)\nPerceptual Reasoning: ${wm.priScore} (${wm.priPercentile}th percentile)\nWorking Memory: ${wm.wmiScore} (${wm.wmiPercentile}th percentile)\nProcessing Speed: ${wm.psiScore} (${wm.psiPercentile}th percentile)`;
            }
            let content = fillWAISCognitiveTemplate(wm, derivedFirstName || "[firstName]", meta.pronouns);
            content = await generateCogImpactSummary(content, "WAIS-IV", scoreSummary);
            uSec(sid, { content });
            showToast(pdfResult ? "WAIS-IV cognitive section auto-populated from PDF + AI academic impact." : "WAIS-IV cognitive section generated from manual scores + AI academic impact.", "success");
            setGenning(false);
            return;
          }

          // ── WPPSI-IV (age < 6y11m): Try PDF extraction first, then manual entry ──
          if (useWPPSIByAge) {
            const wppsiDocs = docs.filter(d => d.extractedText && d.extractedText.length > 100 && /WPPSI|Wechsler\s*Preschool/i.test(d.extractedText));
            const pdfResult = extractWPPSICogText(wppsiDocs.length > 0 ? wppsiDocs : allTextDocs);
            let wm, scoreSummary;
            if (pdfResult) {
              wm = pdfResult.wm;
              scoreSummary = buildCogScoreSummary("WPPSI-IV", pdfResult.scores, [
                ["fsiq", "Full Scale IQ"], ["vci", "Verbal Comprehension"], ["vsi", "Visual Spatial"],
                ["fri", "Fluid Reasoning"], ["wmi", "Working Memory"], ["psi", "Processing Speed"],
              ]);
              uSec(sid, { wppsiManual: { ...secs.cognitive?.wppsiManual, ...wm } });
            } else {
              wm = secs.cognitive?.wppsiManual || {};
              const missing = [];
              if (!wm.fsiqScore?.trim()) missing.push("FSIQ Score");
              if (!wm.fsiqPercentile?.trim()) missing.push("FSIQ Percentile");
              if (!wm.vciScore?.trim()) missing.push("VCI Score");
              if (!wm.vciPercentile?.trim()) missing.push("VCI Percentile");
              if (!wm.vsiScore?.trim()) missing.push("VSI Score");
              if (!wm.vsiPercentile?.trim()) missing.push("VSI Percentile");
              if (!wm.friScore?.trim()) missing.push("FRI Score");
              if (!wm.friPercentile?.trim()) missing.push("FRI Percentile");
              if (!wm.wmiScore?.trim()) missing.push("WMI Score");
              if (!wm.wmiPercentile?.trim()) missing.push("WMI Percentile");
              if (!wm.psiScore?.trim()) missing.push("PSI Score");
              if (!wm.psiPercentile?.trim()) missing.push("PSI Percentile");
              if (missing.length > 0) {
                showToast("No WPPSI-IV scores found in PDFs. Missing manual fields: " + missing.join(", "), "error");
                setGenning(false);
                return;
              }
              scoreSummary = `Test: WPPSI-IV\nFull Scale IQ: ${wm.fsiqScore} (${wm.fsiqPercentile}th percentile)\nVerbal Comprehension: ${wm.vciScore} (${wm.vciPercentile}th percentile)\nVisual Spatial: ${wm.vsiScore} (${wm.vsiPercentile}th percentile)\nFluid Reasoning: ${wm.friScore} (${wm.friPercentile}th percentile)\nWorking Memory: ${wm.wmiScore} (${wm.wmiPercentile}th percentile)\nProcessing Speed: ${wm.psiScore} (${wm.psiPercentile}th percentile)`;
            }
            let content = fillWPPSICognitiveTemplate(wm, derivedFirstName || "[firstName]", meta.pronouns);
            content = await generateCogImpactSummary(content, "WPPSI-IV", scoreSummary);
            uSec(sid, { content });
            showToast(pdfResult ? "WPPSI-IV cognitive section auto-populated from PDF + AI academic impact." : "WPPSI-IV cognitive section generated from manual scores + AI academic impact.", "success");
            setGenning(false);
            return;
          }

          // ── WISC-V / default: Deterministic extraction from Q-interactive PDF ──
          const isWAISSelected = tools.some(t => t.id === "wais-iv" && t.used);
          if (!isWAISSelected) {
            let extracted = extractCognitiveText(selDocs(sid));
            if (!extracted && wiscDocs.length > 0) extracted = extractCognitiveText(wiscDocs);
            if (!extracted && allTextDocs.length > 0) extracted = extractCognitiveText(allTextDocs);
            if (extracted) {
              let content = derivedFirstName ? capitalizeSentences(personalize(extracted, derivedFirstName, meta.pronouns)) : extracted;
              // Try to extract WISC scores for AI academic impact
              const wiscScoreDocs = wiscDocs.length > 0 ? wiscDocs : selDocs(sid);
              let wiscScoreSummary = null;
              for (const d of wiscScoreDocs) {
                const txt = d.extractedText || "";
                // Extract basic WISC scores for summary
                const fsiq = txt.match(/Full\s*Scale\s*IQ[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                const vci = txt.match(/(?:Verbal\s*Comprehension|VCI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                const vsi = txt.match(/(?:Visual\s*Spatial|VSI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                const fri = txt.match(/(?:Fluid\s*Reasoning|FRI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                const wmi = txt.match(/(?:Working\s*Memory|WMI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                const psi = txt.match(/(?:Processing\s*Speed|PSI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                if (fsiq) {
                  const lines = ["Test: WISC-V"];
                  if (fsiq) lines.push(`Full Scale IQ: ${fsiq[1]} (${fsiq[2]}th percentile)`);
                  if (vci) lines.push(`Verbal Comprehension: ${vci[1]} (${vci[2]}th percentile)`);
                  if (vsi) lines.push(`Visual Spatial: ${vsi[1]} (${vsi[2]}th percentile)`);
                  if (fri) lines.push(`Fluid Reasoning: ${fri[1]} (${fri[2]}th percentile)`);
                  if (wmi) lines.push(`Working Memory: ${wmi[1]} (${wmi[2]}th percentile)`);
                  if (psi) lines.push(`Processing Speed: ${psi[1]} (${psi[2]}th percentile)`);
                  wiscScoreSummary = lines.join("\n");
                  break;
                }
              }
              if (wiscScoreSummary) {
                content = await generateCogImpactSummary(content, "WISC-V", wiscScoreSummary);
              }
              uSec(sid, { content });
              showToast("Cognitive text extracted from uploaded report" + (wiscScoreSummary ? " + AI academic impact" : ""), "success");
              setGenning(false);
              return;
            } else if (wiscDocs.length > 0) {
              const rawDump = wiscDocs[0].extractedText;
              uSec(sid, { content: rawDump });
              showToast("Could not locate cognitive section anchors — full document text inserted for manual editing.", "warn");
              setGenning(false);
              return;
            }
          }
          // No extraction succeeded — fall through to AI generation below
        }

        if (sid === "summary") {
          let extracted = extractSummaryText(wiscDocs.length > 0 ? wiscDocs : allTextDocs);
          if (extracted) {
            const content = derivedFirstName ? capitalizeSentences(personalize(extracted, derivedFirstName, meta.pronouns)) : extracted;
            uSec(sid, { content });
            showToast("Summary extracted from uploaded report (no AI)", "success");
            setGenning(false);
            return;
          }
          // No deterministic extraction — fall through to AI generation below
        }

        if (sid === "recommendations") {
          let extracted = extractRecommendationsText(wiscDocs.length > 0 ? wiscDocs : allTextDocs);
          if (extracted) {
            const content = derivedFirstName ? capitalizeSentences(personalize(extracted, derivedFirstName, meta.pronouns)) : extracted;
            uSec(sid, { content });
            showToast("Recommendations extracted from uploaded report (no AI)", "success");
            setGenning(false);
            return;
          }
          // No deterministic extraction — fall through to AI generation below
        }

        if (sid === "appendix_tables") {
          const blocks = secs.appendix_tables?.tableBlocks || [];

          // ── Unified score extraction from ALL sources ──
          const allSources = allTextDocs.length > 0 ? allTextDocs : docs;
          const scoreMap = extractAllScoresMap(allSources);

          // Also try extracting from already-generated section content (cognitive, academic, memory)
          const pseudoDocs = [];
          const cogContent = secs.cognitive?.content?.trim();
          if (cogContent && cogContent.length > 100 && /WISC|WPPSI|WAIS|Wechsler|FSIQ|VCI|VSI|FRI|WMI|PSI|PRI/i.test(cogContent)) {
            pseudoDocs.push({ extractedText: cogContent, name: "_cognitive_", _docxTables: null, _pdfPages: null });
          }
          const acadContent = secs.academic?.content?.trim();
          if (acadContent && acadContent.length > 100 && /WIAT/i.test(acadContent)) {
            pseudoDocs.push({ extractedText: acadContent, name: "_academic_", _docxTables: null, _pdfPages: null });
          }
          const memContent = secs.memory?.content?.trim();
          if (memContent && memContent.length > 100 && /WRAML/i.test(memContent)) {
            pseudoDocs.push({ extractedText: memContent, name: "_memory_", _docxTables: null, _pdfPages: null });
          }
          if (pseudoDocs.length > 0) {
            const sectionScores = extractAllScoresMap(pseudoDocs);
            // Merge section scores (don't overwrite PDF-extracted scores)
            for (const [k, val] of Object.entries(sectionScores)) {
              if (!scoreMap[k]) scoreMap[k] = val;
            }
          }

          // ── Merge stored WAIS scores from AI-generated cognitive section ──
          const waisScores = secs.cognitive?._waisScores;
          if (waisScores) {
            for (const [k, val] of Object.entries(waisScores)) {
              if (!scoreMap[k]) scoreMap[k] = val;
            }
          }

          const filledCount = Object.keys(scoreMap).length;

          // ── MANDATORY: Always build the 3 fixed tables (cognitive subtest, cognitive index, WIAT-III) ──
          let cogTestType = useWAISByAge ? "wais-iv" : useWPPSIByAge ? "wppsi-iv" : "wisc-v";
          if (cogTestType === "wisc-v") {
            if (tools.find(t => t.id === "wais-iv" && t.used)) cogTestType = "wais-iv";
            else if (tools.find(t => t.id === "wppsi-iv" && t.used)) cogTestType = "wppsi-iv";
            else if (Object.keys(scoreMap).some(k => k.startsWith("WAIS."))) cogTestType = "wais-iv";
            else if (Object.keys(scoreMap).some(k => k.startsWith("WPPSI."))) cogTestType = "wppsi-iv";
          }
          const mandatoryHtml = buildMandatoryAppendixTablesHTML(derivedFirstName || "[firstName]", scoreMap, cogTestType);

          uSec(sid, { content: mandatoryHtml });
          showToast(filledCount > 0
            ? `Tables built — ${filledCount} scores auto-filled from docs/sections`
            : "Mandatory tables created with — placeholders — upload score PDFs or generate other sections first",
            filledCount > 0 ? "success" : "info");
          setGenning(false);
          return;
        }
      }

      // ── DETERMINISTIC + AI SUMMARY: Memory from WRAML3 ──
      if (sid === "memory") {
        const memDocs = selDocs(sid);
        const extracted = extractMemoryText(memDocs, derivedFirstName, meta.pronouns);
        if (extracted) {
          // Extract the score summary block for AI
          const scoreBlockMatch = extracted.match(/\[MEMORY_SCORES_FOR_SUMMARY\]\n([\s\S]*?)\n\[\/MEMORY_SCORES_FOR_SUMMARY\]/);
          const cleanedText = extracted.replace(/\n*\[MEMORY_SCORES_FOR_SUMMARY\][\s\S]*?\[\/MEMORY_SCORES_FOR_SUMMARY\]\s*/, "").trim();

          if (scoreBlockMatch) {
            // Call AI for interpretive summary
            uSec(sid, { content: cleanedText + "\n\n[Generating summary...]" });
            try {
              const summaryPrompt = `Write a Summary of Memory and Learning paragraph (150-250 words) for a psychoeducational assessment report.

Based on the following WRAML-3 scores, write a cohesive summary that:
1. Describes the student's overall memory and learning profile
2. Compares immediate vs delayed memory
3. Compares visual vs verbal memory
4. Notes attention/concentration functioning
5. Identifies clear strengths and weaknesses
6. Describes implications for the student's academic functioning (e.g., how memory weaknesses may affect learning, note-taking, following instructions, retaining information)
7. Uses cautious, professional language — "may", "suggests", "is expected to"

SCORES:
${scoreBlockMatch[1]}

Use [firstName] and correct pronouns throughout. Do NOT use bullet points. Write in connected paragraphs. Do NOT restate individual scores — synthesize them into a functional narrative. Output only the summary paragraph(s).`;

              const summaryResult = await aiGen(
                meta, tools,
                summaryPrompt,
                { name: "Standard", desc: "Functional impact, strengths-based, Ontario style." },
                "",
                [],
                GLOBAL_TONE_RULES,
                2000,
                "memory",
                accessPassword,
                proxyUrl,
                apiKey,
                controller.signal,
                openaiModel
              );

              if (summaryResult.ok) {
                let summary = cleanAIOutput(summaryResult.text, "memory");
                // Ensure it starts with "Summary of Memory and Learning" heading if not present
                if (!/summary\s+of\s+memory/i.test(summary)) {
                  summary = "Summary of Memory and Learning\n\n" + summary;
                }
                uSec(sid, { content: cleanedText + "\n\n" + summary });
                showToast("Memory text + AI summary generated from WRAML3 report", "success");
              } else {
                uSec(sid, { content: cleanedText });
                showToast("Memory text generated — AI summary failed, please add manually", "warning");
              }
            } catch (e) {
              uSec(sid, { content: cleanedText });
              showToast("Memory text generated — AI summary failed, please add manually", "warning");
            }
          } else {
            uSec(sid, { content: cleanedText });
            showToast("Memory text generated from WRAML3 report", "success");
          }
          setGenning(false);
          return;
        }
      }

      // ── DETERMINISTIC: Academic from WIAT ──
      if (sid === "academic") {
        const acadDocs = selDocs(sid);
        const extracted = extractAcademicText(acadDocs, derivedFirstName, meta.pronouns);
        if (extracted) {
          uSec(sid, { content: extracted.text });
          if (extracted.unfilled > 0) {
            showToast(`Academic template filled — ${extracted.unfilled} placeholder(s) need manual entry (⟦___⟧)`, "warning");
          } else {
            showToast("Academic text auto-populated from WIAT III report.", "success");
          }
          setGenning(false);
          return;
        }
      }

      // ── DETERMINISTIC: Visual Motor from VMI percentile ──
      if (sid === "visual_motor") {
        const pct = s.vmiPercentile;
        if (pct != null && String(pct).trim() !== "") {
          const filled = buildVMIText(pct, derivedFirstName || "[firstName]", meta.pronouns);
          if (filled) {
            uSec(sid, { content: filled });
            const range = vmiPercentileToRange(pct);
            showToast(`VMI template filled — ${range} range (${pct}th percentile) + Summary added`, "success");
            setGenning(false);
            return;
          }
        }
      }

      // ── AI GENERATION (only for sections without deterministic extractors, or when extraction returned null) ──
      const sectionPrompt = resolvePrompt(sid, customPrompts);
      const toneRules = GLOBAL_TONE_RULES;

      // Build context based on selected sources
      const ctxParts = [];
      if (src.notes && s.ctx?.trim()) ctxParts.push(s.ctx.trim());
      if (src.draft && s.content?.trim()) ctxParts.push("=== MY OBSERVATIONS / CURRENT DRAFT ===\n" + s.content.trim());

      // Include behaviour observation menu inputs for the observations section
      if (sid === "observations" && s.behObsMenu) {
        const block = buildBehObsPromptBlock(s.behObsMenu);
        if (block) ctxParts.push(block);
        ctxParts.push(BEH_OBS_AI_RULES);
      }

      // Include WIAT template for academic section so AI knows exact structure to fill
      if (sid === "academic") {
        const templateText = personalize(WIAT_TEMPLATE, derivedFirstName || "[firstName]", meta.pronouns);
        ctxParts.push("=== WIAT TEMPLATE TO FILL ===\nUse this EXACT template structure. Replace EVERY [PLACEHOLDER_SS] with the standard score number (e.g., 102, 85), EVERY [PLACEHOLDER_RANGE] with the classification (e.g., Average, Low Average), and EVERY [PLACEHOLDER_PERCENTILE] with the actual percentile (e.g., 45th, 2nd). If a score is not found, use [score not available].\n\n" + templateText);
        
        // Extract and inject structured WIAT scores so AI has exact values
        const acadDocs = docs.filter(d => d.extractedText && /WIAT/i.test(d.extractedText));
        if (acadDocs.length > 0) {
          for (const d of acadDocs) {
            const sc = parseWIATScores(d.extractedText || "");
            const filled = Object.entries(sc).filter(([, v]) => v && v.ss != null);
            if (filled.length > 0) {
              const lines = ["=== WIAT-III EXTRACTED SCORES (use these EXACT values) ==="];
              for (const [key, data] of filled) {
                const range = ssToRange(data.ss);
                lines.push(`  ${key}: Standard Score = ${data.ss}, Percentile = ${data.percentile}, Classification = ${range}`);
              }
              lines.push("\nCRITICAL: Use these EXACT scores to fill the template. Do NOT use placeholders.");
              ctxParts.push(lines.join("\n"));
            }
          }
        }
      }

      // ── WAIS COGNITIVE: Extract structured scores from docs and inject as context ──
      if (sid === "cognitive" && tools.some(t => t.id === "wais-iv" && t.used)) {
        const allDocsForScores = docs.filter(d => d.extractedText && d.extractedText.length > 50);
        const waisScoreMap = extractAllScoresMap(allDocsForScores);
        const waisKeys = Object.entries(waisScoreMap).filter(([k]) => k.startsWith("WAIS."));
        if (waisKeys.length > 0) {
          const lines = ["=== WAIS-IV EXTRACTED SCORES (use these EXACT values) ==="];
          const indexMap = { FSIQ: "Full Scale IQ", VCI: "Verbal Comprehension Index", PRI: "Perceptual Reasoning Index", WMI: "Working Memory Index", PSI: "Processing Speed Index", GAI: "General Ability Index" };
          const subtestMap = { SI: "Similarities", VC: "Vocabulary", IN: "Information", BD: "Block Design", MR: "Matrix Reasoning", VP: "Visual Puzzles", DS: "Digit Span", AR: "Arithmetic", SS: "Symbol Search", CD: "Coding" };
          lines.push("\nINDEX SCORES:");
          for (const [abbr, full] of Object.entries(indexMap)) {
            const score = waisScoreMap[`WAIS.${abbr}.score`];
            const pct = waisScoreMap[`WAIS.${abbr}.percentile`];
            const qual = waisScoreMap[`WAIS.${abbr}.qualitative`];
            if (score) lines.push(`  ${full} (${abbr}): Standard Score = ${score}, Percentile = ${pct || "N/A"}, Classification = ${qual || qualitativeLabel(parseInt(score))}`);
          }
          lines.push("\nSUBTEST SCORES:");
          for (const [abbr, full] of Object.entries(subtestMap)) {
            const scaled = waisScoreMap[`WAIS.${abbr}.scaled`];
            const pct = waisScoreMap[`WAIS.${abbr}.percentile`];
            if (scaled) lines.push(`  ${full} (${abbr}): Scaled Score = ${scaled}, Percentile = ${pct || "N/A"}`);
          }
          lines.push("\nCRITICAL: Use these EXACT scores in your narrative. Do NOT use placeholders like [range] or [percentile]. Write the actual values.");
          ctxParts.push(lines.join("\n"));
        }
        // Also extract raw text from WAIS docs for additional context
        const waisDocs = docs.filter(d => d.extractedText && /WAIS/i.test(d.extractedText));
        if (waisDocs.length > 0) {
          const rawText = waisDocs[0].extractedText.slice(0, 6000);
          ctxParts.push("=== RAW WAIS-IV DOCUMENT TEXT (for score verification) ===\n" + rawText);
        }
      }

      // Include socio-emotional inputs for the social_emotional section
      if (sid === "social_emotional") {
        const seParts = [];
        const mod = s.seModifier || "STANDARD";
        seParts.push(`=== MODIFIER: ${mod} ===`);
        if (mod === "OTHER" && s.seOtherDesc?.trim()) {
          seParts.push(`[OTHER_MODIFIER_DESCRIPTION]: ${s.seOtherDesc.trim()}`);
        }
        const bgContent = secs.background?.content?.trim();
        if (bgContent) {
          seParts.push(`=== BACKGROUND INFORMATION (from Background section) ===\n${bgContent}`);
        }
        if (s.seInterview?.trim()) {
          seParts.push(`=== INTERVIEW SOCIO-EMOTIONAL INFORMATION ===\n${s.seInterview.trim()}`);
        }
        // Include structured rating scale data
        const rsPrompt = buildSeRatingScalePrompt(s.seRatingScales);
        if (rsPrompt) {
          seParts.push(rsPrompt);
        }
        ctxParts.push(seParts.join("\n\n"));
      }

      // Include all prior sections for summary
      if (sid === "summary") {
        const sumCtx = buildFormulationContext(secs, meta);
        if (sumCtx) ctxParts.push(sumCtx);
        const mods = s.formModifiers || [];
        if (mods.length > 0) {
          const modLabels = mods.map((m) => FORMULATION_MODIFIERS.find((f) => f.id === m)?.label || m);
          ctxParts.push(`=== FORMULATION MODIFIERS (selected) ===\n${modLabels.join("\n")}`);
        }
      }

      // Include recommendations context
      if (sid === "recommendations") {
        const formCtx = buildFormulationContext(secs, meta);
        if (formCtx) ctxParts.push(formCtx);
        const blks = s.recBlocks || [];
        if (blks.length > 0) {
          const blkLabels = blks.map((b) => REC_BLOCKS.find((r) => r.id === b)?.label || b);
          ctxParts.push(`=== RECOMMENDATION BLOCKS (selected) ===\n${blkLabels.join("\n")}`);
        }
        const edu = REC_EDU_LEVELS.find((e) => e.id === (s.recEduLevel || "ELEMENTARY"))?.label || "Elementary";
        ctxParts.push(`=== EDUCATIONAL LEVEL MODIFIER ===\n${edu}`);
      }

      // Include appendix context
      if (sid === "appendix") {
        const appCtx = buildFormulationContext(secs, meta);
        if (appCtx) ctxParts.push(appCtx);
        const recContent = secs.recommendations?.content?.trim();
        if (recContent) ctxParts.push(`=== RECOMMENDATIONS SECTION ===\n${recContent}`);
        const blks = s.appendixBlocks || [];
        if (blks.length > 0) {
          const blkLabels = blks.map((b) => APPENDIX_BLOCKS.find((a) => a.id === b)?.label || b);
          ctxParts.push(`=== APPENDIX_BLOCKS (selected) ===\n${blkLabels.join("\n")}`);
        }
        const edu = REC_EDU_LEVELS.find((e) => e.id === (secs.recommendations?.recEduLevel || "ELEMENTARY"))?.label || "Elementary";
        ctxParts.push(`=== EDUCATIONAL LEVEL MODIFIER ===\n${edu}`);
      }

      // Include appendix tables context — feed all section content with scores
      if (sid === "appendix_tables") {
        const atCogTest = tools.find(t => t.id === "wais-iv" && t.used) ? "wais-iv" : "wisc-v";
        const atCogLabel = atCogTest === "wais-iv" ? "WAIS-IV" : "WISC-V";
        const scoreSectionMap = [
          { id: "cognitive", label: `COGNITIVE/INTELLECTUAL FUNCTIONING (${atCogLabel})`, tableType: `${atCogLabel} Subtest Score Summary + ${atCogLabel} Index Score Summary` },
          { id: "academic", label: "ACADEMIC TESTING (WIAT-III)", tableType: "WIAT-III Subtest Score Summary" },
          { id: "memory", label: "MEMORY AND LEARNING (WRAML-3 / CMS)", tableType: "Memory Score Summary table" },
          { id: "visual_motor", label: "VISUAL-MOTOR INTEGRATION (Beery VMI)", tableType: "Beery VMI Score Summary table" },
          { id: "social_emotional", label: "SOCIAL-EMOTIONAL FUNCTIONING (BASC-3 / Conners / CBRS / MASC / CDI)", tableType: "Rating scale tables (one per respondent)" },
          { id: "adaptive", label: "DEVELOPMENT AND ADAPTIVE FUNCTIONING (Vineland-3)", tableType: "Vineland Adaptive Behavior Score Summary table" },
        ];
        scoreSectionMap.forEach(({ id: secId, label }) => {
          let content = secs[secId]?.content?.trim();
          if (content) {
            // CRITICAL: Strip ⟦⟧ review markers so AI can read scores cleanly
            content = content.replace(/[⟦⟧]/g, "");
            ctxParts.push(`=== ${label} ===\n${content}`);
          }
        });
        // Extract WISC subtest score table from uploaded cognitive PDFs
        const allDocsWithText = docs.filter((d) => d.extractedText && d.extractedText.length > 50);
        const cogScoreTable = extractCognitiveScoreTable(allDocsWithText);
        if (cogScoreTable) ctxParts.push(cogScoreTable);
        // MANDATORY TABLES REMINDER — dynamic based on selected cognitive test
        const genCogTest = tools.find(t => t.id === "wais-iv" && t.used) ? "wais-iv" : tools.find(t => t.id === "wppsi-iv" && t.used) ? "wppsi-iv" : "wisc-v";
        if (genCogTest === "wais-iv") {
          ctxParts.push(`\n=== MANDATORY TABLE RULES ===\nYou MUST produce these tables in this order:\n1. Table 1. WAIS-IV Subtest Score Summary (up to 15 rows: Similarities, Vocabulary, Information, Comprehension, Block Design, Matrix Reasoning, Visual Puzzles, Figure Weights, Picture Completion, Digit Span, Arithmetic, Letter-Number Sequencing, Symbol Search, Coding, Cancellation — include only administered subtests)\n2. Table 2. WAIS-IV Index Score Summary (up to 7 rows: VCI, PRI, WMI, PSI, FSIQ, GAI, CPI — include only computed indexes)\n3. Table 3. WIAT-III Subtest Score Summary (12 fixed rows: Listening Comprehension, Receptive Vocabulary, Oral Discourse Comprehension, Word Reading, Pseudoword Decoding, Reading Comprehension, Oral Reading Fluency, Spelling, Sentence Composition, Essay Composition, Numerical Operations, Math Problem Solving)\n4. Table 4. WIAT-III Composite Score Summary (7 fixed rows: Oral Language, Total Reading, Basic Reading, Reading Comprehension & Fluency, Written Expression, Mathematics, Total Achievement)\nNEVER modify structure. Use \u2014 for missing values.`);
        } else if (genCogTest === "wppsi-iv") {
          ctxParts.push(`\n=== MANDATORY TABLE RULES ===\nYou MUST produce these tables in this order:\n1. Table 1. WPPSI-IV Subtest Score Summary (up to 15 rows: Information, Similarities, Vocabulary, Comprehension, Receptive Vocabulary, Picture Naming, Block Design, Object Assembly, Matrix Reasoning, Picture Concepts, Picture Memory, Zoo Locations, Bug Search, Cancellation, Animal Coding — include only administered subtests)\n2. Table 2. WPPSI-IV Index Score Summary (up to 10 rows: VCI, VSI, FRI, WMI, PSI, FSIQ, GAI, CPI, NVI, VAI — include only computed indexes)\n3. Table 3. WIAT-III Subtest Score Summary (12 fixed rows)\n4. Table 4. WIAT-III Composite Score Summary (7 fixed rows)\nNEVER modify structure. Use \u2014 for missing values.`);
        } else {
          ctxParts.push(`\n=== MANDATORY TABLE RULES ===\nYou MUST produce these tables in this order:\n1. Table 1. WISC-V Subtest Score Summary (up to 17 rows: Similarities, Vocabulary, Information, Comprehension, Block Design, Visual Puzzles, Matrix Reasoning, Figure Weights, Picture Span, Digit Span, Letter-Number Sequencing, Arithmetic, Coding, Symbol Search, Cancellation, Naming Speed Literacy, Naming Speed Quantity — include only administered subtests)\n2. Table 2. WISC-V Index Score Summary (up to 14 rows: VCI, VSI, FRI, WMI, PSI, FSIQ, GAI, CPI, NVI, QRI, AWMI, NSI, STI, SRI — include only computed indexes)\n3. Table 3. WIAT-III Subtest Score Summary (12 fixed rows: Listening Comprehension, Receptive Vocabulary, Oral Discourse Comprehension, Word Reading, Pseudoword Decoding, Reading Comprehension, Oral Reading Fluency, Spelling, Sentence Composition, Essay Composition, Numerical Operations, Math Problem Solving)\n4. Table 4. WIAT-III Composite Score Summary (7 fixed rows: Oral Language, Total Reading, Basic Reading, Reading Comprehension & Fluency, Written Expression, Mathematics, Total Achievement)\nNEVER modify structure. Use \u2014 for missing values.`);
        }
      }

      // Pre-check for appendix_tables: warn if no score sections have content
      if (sid === "appendix_tables") {
        const scoreSections = ["cognitive", "memory", "visual_motor", "social_emotional", "adaptive", "academic"];
        const hasContent = scoreSections.some((secId) => secs[secId]?.content?.trim());
        if (!hasContent) {
          showToast("Generate score sections first (Cognitive, Academic, etc.) — tables are built from their text.", "warn");
          setGenning(false);
          return;
        }
      }

      // Smart doc selection: for appendix_tables, ALWAYS include ALL uploaded docs
      let docsForAI = sid === "appendix_tables"
        ? docs.filter((d) => d.data || (d.extractedText && d.extractedText.length > 50 && !d.extractedText.startsWith("[")))
        : src.docs ? selDocs(sid) : [];
      if (docsForAI.length === 0 && docs.length > 0) {
        docsForAI = docs.filter((d) => d.data || (d.extractedText && d.extractedText.length > 50 && !d.extractedText.startsWith("[")));
      }

      const result = await aiGen(
        meta, tools,
        sectionPrompt,
        { name: "Standard", desc: "Functional impact, strengths-based, Ontario style." },
        ctxParts.join("\n\n"),
        docsForAI,
        toneRules,
        sid === "appendix_tables" ? 12000 : sid === "appendix" ? 6000 : 4000,
        sid,
        accessPassword,
        proxyUrl,
        apiKey,
        controller.signal,
        openaiModel
      );

      if (result.ok) {
        let content = result.text;
        // Strip markdown code blocks for appendix_tables (AI sometimes wraps HTML in ```)
        if (sid === "appendix_tables") {
          content = content.replace(/^```(?:html|HTML)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();
          // Also strip any leading text before the first HTML tag
          const firstTag = content.indexOf("<");
          if (firstTag > 0 && firstTag < 200) {
            content = content.slice(firstTag);
          }
        } else {
          // Clean markdown artifacts and duplicate section titles from all non-table sections
          content = cleanAIOutput(content, sid);
        }
        // WAIS cognitive: extract scores from AI output (multiple strategies)
        let waisExtractedScores = null;
        if (sid === "cognitive" && tools.some(t => t.id === "wais-iv" && t.used)) {
          waisExtractedScores = {};

          // Strategy 1: Parse structured SCORE SUMMARY block if present
          if (/---\s*SCORE\s*SUMMARY\s*---/i.test(content)) {
            const summaryMatch = content.match(/---\s*SCORE\s*SUMMARY\s*---([\s\S]*?)---\s*END\s*SCORE\s*SUMMARY\s*---/i);
            if (summaryMatch) {
              const lines = summaryMatch[1].trim().split("\n");
              for (const line of lines) {
                const m = line.match(/^([A-Z]{2,5})\s*=\s*(\d+)\s*,\s*PR\s*=\s*(\d+(?:\.\d+)?)/);
                if (m) {
                  const abbr = m[1];
                  const score = parseInt(m[2], 10);
                  const pct = parseFloat(m[3]);
                  const indexAbbrevs = ["FSIQ","VCI","PRI","WMI","PSI","GAI","NVI","CPI","VSI","FRI"];
                  if (indexAbbrevs.includes(abbr)) {
                    waisExtractedScores[`WAIS.${abbr}.score`] = String(score);
                    waisExtractedScores[`WAIS.${abbr}.percentile`] = String(pct);
                    waisExtractedScores[`WAIS.${abbr}.qualitative`] = qualitativeLabel(score);
                  } else {
                    waisExtractedScores[`WAIS.${abbr}.scaled`] = String(score);
                    waisExtractedScores[`WAIS.${abbr}.percentile`] = String(pct);
                  }
                }
              }
              // Strip the score summary block from displayed content
              content = content.replace(/\n*---\s*SCORE\s*SUMMARY\s*---[\s\S]*?---\s*END\s*SCORE\s*SUMMARY\s*---\s*/i, "").trim();
            }
          }

          // Strategy 2: Narrative extraction from AI text (always runs as fallback)
          try {
            const narrSubs = detExtractNarrativeSubtestScores(content);
            for (const s of narrSubs) {
              const abbr = WISC_SUBTEST_ABBREV_MAP[s.name];
              if (!abbr || waisExtractedScores[`WAIS.${abbr}.scaled`]) continue;
              if (s.scaledScore != null) waisExtractedScores[`WAIS.${abbr}.scaled`] = String(s.scaledScore);
              if (s.percentile != null) waisExtractedScores[`WAIS.${abbr}.percentile`] = String(s.percentile);
            }
            const narrIdx = detExtractNarrativeIndexScores(content);
            if (narrIdx) {
              for (const s of narrIdx) {
                if (!s.abbrev || waisExtractedScores[`WAIS.${s.abbrev}.score`]) continue;
                if (s.standardScore != null) waisExtractedScores[`WAIS.${s.abbrev}.score`] = String(s.standardScore);
                if (s.percentile != null) waisExtractedScores[`WAIS.${s.abbrev}.percentile`] = String(s.percentile);
                waisExtractedScores[`WAIS.${s.abbrev}.qualitative`] = s.qualitative || qualitativeLabel(s.standardScore);
              }
            }
          } catch (e) { /* narrative extraction failed — continue with what we have */ }

          // Strategy 3: Inline abbreviation extraction (e.g., "VCI = 98, PR = 45")
          try {
            const inlIdx = detExtractIndexScores(content);
            if (inlIdx) {
              for (const s of inlIdx) {
                if (!s.abbrev || waisExtractedScores[`WAIS.${s.abbrev}.score`]) continue;
                if (s.standardScore != null) waisExtractedScores[`WAIS.${s.abbrev}.score`] = String(s.standardScore);
                if (s.percentile != null) waisExtractedScores[`WAIS.${s.abbrev}.percentile`] = String(s.percentile);
                waisExtractedScores[`WAIS.${s.abbrev}.qualitative`] = s.qualitative || qualitativeLabel(s.standardScore);
              }
            }
            const inlSubs = detExtractInlineScores(content);
            for (const s of inlSubs) {
              const abbr = WISC_SUBTEST_ABBREV_MAP[s.name];
              if (!abbr || waisExtractedScores[`WAIS.${abbr}.scaled`]) continue;
              if (s.scaledScore != null) waisExtractedScores[`WAIS.${abbr}.scaled`] = String(s.scaledScore);
              if (s.percentile != null) waisExtractedScores[`WAIS.${abbr}.percentile`] = String(s.percentile);
            }
          } catch (e) { /* inline extraction failed */ }

          // If we got nothing, set to null so we don't store empty object
          if (Object.keys(waisExtractedScores).length === 0) {
            waisExtractedScores = null;
            console.warn("[PsychoEd] WAIS score extraction found 0 scores in AI output");
          } else {
            console.log("[PsychoEd] WAIS scores extracted:", Object.keys(waisExtractedScores).length, "keys", waisExtractedScores);
          }
        }
        uSec(sid, { content, ...(waisExtractedScores ? { _waisScores: waisExtractedScores } : {}) });
        showToast("Section generated successfully", "success");
      } else {
        // Show error both as toast AND in section content so user can see it
        uSec(sid, { content: `[GENERATION ERROR: ${result.text}]` });
        showToast(result.text, "error");
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        uSec(sid, { content: `[GENERATION ERROR: ${err.message}]` });
        showToast("Generation error: " + err.message, "error");
      }
    } finally {
      abortControllerRef.current = null;
      setGenning(false);
    }
  }, [secs, meta, tools, customPrompts, selDocs, docs, uSec, showToast, cancelGeneration, accessPassword, proxyUrl, apiKey, derivedFirstName, openaiModel]);

  const onSecUpload = useCallback((sid) => {
    setSecUploadTarget(sid);
    setTimeout(() => secFileRef.current?.click(), 0);
  }, []);

    const validateReport = useCallback(() => {
    const missingFields = REQUIRED_FIELDS
      .filter((f) => !meta[f.key]?.trim())
      .map((f) => f.label);
    const missingSections = REQUIRED_SECTIONS
      .filter((id) => !secs[id]?.content?.trim())
      .map((id) => TABS.find((t) => t.id === id)?.label || id);

    const issues = [];
    if (missingFields.length > 0) issues.push("Missing fields: " + missingFields.join(", "));
    if (missingSections.length > 0) issues.push("Empty required sections: " + missingSections.join(", "));

    if (issues.length > 0) {
      showToast(issues.join(" · "), "warn");
      return false;
    }
    return true;
  }, [meta, secs, showToast]);

    const generateAll = useCallback(async () => {
    if (!validateReport()) return;

    // Only generate sections that are unlocked AND empty
    const toGen = GEN_ORDER.filter((sid) => {
      const s = secs[sid];
      if (!s || s.status === SS.APPROVED) return false;
      if (!s.content || !s.content.trim()) return true;
      return false;
    });

    if (toGen.length === 0) {
      showToast("All sections already have content or are marked Final", "info");
      return;
    }

    cancelGeneration();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setGenning(true);
    let succeeded = 0;
    let failed = 0;
    const toneRules = GLOBAL_TONE_RULES;
    // Track content generated within this loop (React batches state updates, so secs closure is stale)
    const localContent = {};

    for (const sid of toGen) {
      try {
        const s = secs[sid];
        const src = s.aiSources || { notes: true, docs: true, draft: false };

                if (sid === "cognitive" || sid === "summary" || sid === "recommendations" || sid === "appendix_tables") {
          // ── DETERMINISTIC EXTRACTION — NO AI ──
          const wiscDocs = docs.filter((d) => d.extractedText && d.extractedText.length > 100 && /WISC|WPPSI|WAIS|Wechsler/i.test(d.extractedText));
          const allTextDocs = docs.filter((d) => d.extractedText && d.extractedText.length > 100 && !d.extractedText.startsWith("["));

          if (sid === "cognitive") {
            // ── Helper: AI academic impact (same as pipeline 1) ──
            const genCogImpact = async (base, testName, scoreSummary) => {
              try {
                const impactPrompt = `Write an Academic Impact paragraph (150-250 words) for a psychoeducational assessment report.\n\nBased on the following ${testName} cognitive scores, write a cohesive paragraph that:\n1. Describes how this cognitive profile is expected to impact academic functioning\n2. Connects specific cognitive strengths to areas where the student is likely to perform well academically\n3. Connects specific cognitive weaknesses to areas where the student may experience academic difficulty\n4. Addresses implications for reading, writing, mathematics, and classroom learning as relevant\n5. Uses cautious, professional language — "may", "suggests", "is expected to"\n\nSCORES:\n${scoreSummary}\n\nUse [firstName] and correct pronouns throughout. Do NOT use bullet points. Write in connected paragraphs. Output only the paragraph(s).`;
                const result = await aiGen(meta, tools, impactPrompt, { name: "Standard", desc: "Functional impact, strengths-based, Ontario style." }, "", [], GLOBAL_TONE_RULES, 2000, "cognitive", accessPassword, proxyUrl, apiKey, controller.signal, openaiModel);
                if (result.ok) {
                  let impact = cleanAIOutput(result.text, "cognitive");
                  if (!/academic\s+impact|implications?\s+for\s+academic/i.test(impact)) impact = "Academic Impact\n\n" + impact;
                  return base + "\n\n" + impact;
                }
              } catch (e) { /* fall through */ }
              return base;
            };

            // Try WAIS PDF extraction (age >= 16y11m)
            if (useWAISByAge) {
              const waisDocs = docs.filter(d => d.extractedText && d.extractedText.length > 100 && /WAIS|Wechsler\s*Adult/i.test(d.extractedText));
              const pdfResult = extractWAISCogText(waisDocs.length > 0 ? waisDocs : allTextDocs);
              let wm = pdfResult ? pdfResult.wm : secs.cognitive?.waisManual || {};
              if (pdfResult) uSec(sid, { waisManual: { ...secs.cognitive?.waisManual, ...wm } });
              const hasScores = wm.fsiqScore?.trim() && wm.vciScore?.trim();
              if (hasScores) {
                let content = fillWAISCognitiveTemplate(wm, derivedFirstName || "[firstName]", meta.pronouns);
                const scoreSummary = pdfResult ? buildCogScoreSummary("WAIS-IV", pdfResult.scores, [["fsiq","Full Scale IQ"],["vci","Verbal Comprehension"],["pri","Perceptual Reasoning"],["wmi","Working Memory"],["psi","Processing Speed"]]) : `Test: WAIS-IV\nFSIQ: ${wm.fsiqScore} (${wm.fsiqPercentile}th)\nVCI: ${wm.vciScore} (${wm.vciPercentile}th)\nPRI: ${wm.priScore} (${wm.priPercentile}th)\nWMI: ${wm.wmiScore} (${wm.wmiPercentile}th)\nPSI: ${wm.psiScore} (${wm.psiPercentile}th)`;
                content = await genCogImpact(content, "WAIS-IV", scoreSummary);
                uSec(sid, { content }); localContent[sid] = content; succeeded++; continue;
              }
            }

            // Try WPPSI PDF extraction (age < 6y11m)
            if (useWPPSIByAge) {
              const wppsiDocs = docs.filter(d => d.extractedText && d.extractedText.length > 100 && /WPPSI|Wechsler\s*Preschool/i.test(d.extractedText));
              const pdfResult = extractWPPSICogText(wppsiDocs.length > 0 ? wppsiDocs : allTextDocs);
              let wm = pdfResult ? pdfResult.wm : secs.cognitive?.wppsiManual || {};
              if (pdfResult) uSec(sid, { wppsiManual: { ...secs.cognitive?.wppsiManual, ...wm } });
              const hasScores = wm.fsiqScore?.trim() && wm.vciScore?.trim();
              if (hasScores) {
                let content = fillWPPSICognitiveTemplate(wm, derivedFirstName || "[firstName]", meta.pronouns);
                const scoreSummary = pdfResult ? buildCogScoreSummary("WPPSI-IV", pdfResult.scores, [["fsiq","Full Scale IQ"],["vci","Verbal Comprehension"],["vsi","Visual Spatial"],["fri","Fluid Reasoning"],["wmi","Working Memory"],["psi","Processing Speed"]]) : `Test: WPPSI-IV\nFSIQ: ${wm.fsiqScore}\nVCI: ${wm.vciScore}\nVSI: ${wm.vsiScore}\nFRI: ${wm.friScore}\nWMI: ${wm.wmiScore}\nPSI: ${wm.psiScore}`;
                content = await genCogImpact(content, "WPPSI-IV", scoreSummary);
                uSec(sid, { content }); localContent[sid] = content; succeeded++; continue;
              }
            }

            // WISC-V: existing deterministic extraction + AI impact
            let extracted = extractCognitiveText(selDocs(sid));
            if (!extracted && wiscDocs.length > 0) extracted = extractCognitiveText(wiscDocs);
            if (!extracted && allTextDocs.length > 0) extracted = extractCognitiveText(allTextDocs);
            if (extracted) {
              let content = derivedFirstName ? capitalizeSentences(personalize(extracted, derivedFirstName, meta.pronouns)) : extracted;
              // Try WISC score extraction for AI impact
              const scoreDocs = wiscDocs.length > 0 ? wiscDocs : selDocs(sid);
              for (const d of scoreDocs) {
                const txt = d.extractedText || "";
                const fsiq = txt.match(/Full\s*Scale\s*IQ[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                if (fsiq) {
                  const lines = ["Test: WISC-V", `Full Scale IQ: ${fsiq[1]} (${fsiq[2]}th percentile)`];
                  const vci = txt.match(/(?:Verbal\s*Comprehension|VCI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                  const vsi = txt.match(/(?:Visual\s*Spatial|VSI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                  const fri = txt.match(/(?:Fluid\s*Reasoning|FRI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                  const wmi = txt.match(/(?:Working\s*Memory|WMI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                  const psi = txt.match(/(?:Processing\s*Speed|PSI)[^\d]*([\d]{2,3})\s+(\d{1,3})/i);
                  if (vci) lines.push(`Verbal Comprehension: ${vci[1]} (${vci[2]}th percentile)`);
                  if (vsi) lines.push(`Visual Spatial: ${vsi[1]} (${vsi[2]}th percentile)`);
                  if (fri) lines.push(`Fluid Reasoning: ${fri[1]} (${fri[2]}th percentile)`);
                  if (wmi) lines.push(`Working Memory: ${wmi[1]} (${wmi[2]}th percentile)`);
                  if (psi) lines.push(`Processing Speed: ${psi[1]} (${psi[2]}th percentile)`);
                  content = await genCogImpact(content, "WISC-V", lines.join("\n"));
                  break;
                }
              }
              uSec(sid, { content }); localContent[sid] = content; succeeded++; continue;
            } else if (wiscDocs.length > 0) {
              const content = wiscDocs[0].extractedText;
              uSec(sid, { content }); localContent[sid] = content; succeeded++; continue;
            }
          } else if (sid === "summary") {
            const extracted = extractSummaryText(wiscDocs.length > 0 ? wiscDocs : allTextDocs);
            if (extracted) {
              const content = derivedFirstName ? capitalizeSentences(personalize(extracted, derivedFirstName, meta.pronouns)) : extracted;
              uSec(sid, { content });
              localContent[sid] = content;
              succeeded++;
              continue;
            }
          } else if (sid === "recommendations") {
            const extracted = extractRecommendationsText(wiscDocs.length > 0 ? wiscDocs : allTextDocs);
            if (extracted) {
              const content = derivedFirstName ? capitalizeSentences(personalize(extracted, derivedFirstName, meta.pronouns)) : extracted;
              uSec(sid, { content });
              localContent[sid] = content;
              succeeded++;
              continue;
            }
          } else if (sid === "appendix_tables") {
            const blocks = secs.appendix_tables?.tableBlocks || [];
            if (blocks.length > 0) {
              const allSources = allTextDocs.length > 0 ? allTextDocs : docs;
              const scoreMap = extractAllScoresMap(allSources);
              // Also merge from already-generated section content
              const pseudoDocs = [];
              const cogContent = (localContent.cognitive || secs.cognitive?.content || "").trim();
              if (cogContent && cogContent.length > 100 && /WISC|WPPSI|WAIS|Wechsler|FSIQ|VCI|VSI|FRI|WMI|PSI|PRI/i.test(cogContent)) {
                pseudoDocs.push({ extractedText: cogContent, name: "_cognitive_", _docxTables: null, _pdfPages: null });
              }
              const acadContent = (localContent.academic || secs.academic?.content || "").trim();
              if (acadContent && acadContent.length > 100 && /WIAT/i.test(acadContent)) {
                pseudoDocs.push({ extractedText: acadContent, name: "_academic_", _docxTables: null, _pdfPages: null });
              }
              const memContent = (localContent.memory || secs.memory?.content || "").trim();
              if (memContent && memContent.length > 100 && /WRAML/i.test(memContent)) {
                pseudoDocs.push({ extractedText: memContent, name: "_memory_", _docxTables: null, _pdfPages: null });
              }
              if (pseudoDocs.length > 0) {
                const sectionScores = extractAllScoresMap(pseudoDocs);
                for (const [k, val] of Object.entries(sectionScores)) {
                  if (!scoreMap[k]) scoreMap[k] = val;
                }
              }
              // Inject WAIS/WPPSI manual scores (may have been auto-populated from PDF)
              const waisM = secs.cognitive?.waisManual;
              if (waisM) {
                for (const [abbr, key] of [["FSIQ","fsiq"],["VCI","vci"],["PRI","pri"],["WMI","wmi"],["PSI","psi"],["GAI","gai"]]) {
                  if (waisM[key + "Score"] && !scoreMap[`WAIS.${abbr}.score`]) {
                    scoreMap[`WAIS.${abbr}.score`] = waisM[key + "Score"];
                    if (waisM[key + "Percentile"]) {
                      scoreMap[`WAIS.${abbr}.percentile`] = waisM[key + "Percentile"];
                      scoreMap[`WAIS.${abbr}.qualitative`] = percentileToDescriptor(waisM[key + "Percentile"]) || "";
                    }
                  }
                }
                // Inject WAIS subtests
                for (const abbr of ["SI","VC","IN","BD","MR","VP","DS","AR","SS","CD"]) {
                  if (waisM[`sub_${abbr}_scaled`] && !scoreMap[`WAIS.${abbr}.scaled`]) {
                    scoreMap[`WAIS.${abbr}.scaled`] = waisM[`sub_${abbr}_scaled`];
                    if (waisM[`sub_${abbr}_pct`]) scoreMap[`WAIS.${abbr}.percentile`] = waisM[`sub_${abbr}_pct`];
                  }
                }
              }
              const wppsiM = secs.cognitive?.wppsiManual;
              if (wppsiM) {
                for (const [abbr, key] of [["FSIQ","fsiq"],["VCI","vci"],["VSI","vsi"],["FRI","fri"],["WMI","wmi"],["PSI","psi"]]) {
                  if (wppsiM[key + "Score"] && !scoreMap[`WPPSI.${abbr}.score`]) {
                    scoreMap[`WPPSI.${abbr}.score`] = wppsiM[key + "Score"];
                    if (wppsiM[key + "Percentile"]) {
                      scoreMap[`WPPSI.${abbr}.percentile`] = wppsiM[key + "Percentile"];
                      scoreMap[`WPPSI.${abbr}.qualitative`] = percentileToDescriptor(wppsiM[key + "Percentile"]) || "";
                    }
                  }
                }
                // Inject WPPSI subtests
                for (const abbr of ["RV","IN","BD","OA","MR","PC","PM","ZL","BS","CA"]) {
                  if (wppsiM[`sub_${abbr}_scaled`] && !scoreMap[`WPPSI.${abbr}.scaled`]) {
                    scoreMap[`WPPSI.${abbr}.scaled`] = wppsiM[`sub_${abbr}_scaled`];
                    if (wppsiM[`sub_${abbr}_pct`]) scoreMap[`WPPSI.${abbr}.percentile`] = wppsiM[`sub_${abbr}_pct`];
                  }
                }
              }
              const filledCount = Object.keys(scoreMap).length;
              const placeholderHtml = buildBlankPlaceholderTablesHTML(derivedFirstName || "[firstName]", blocks, scoreMap, filledCount > 0);
              if (placeholderHtml) {
                uSec(sid, { content: placeholderHtml });
                localContent[sid] = placeholderHtml;
                succeeded++;
                continue;
              }
            }
          }
          // Deterministic extraction succeeded above (with continue) or failed — fall through to AI
        }

        // ── DETERMINISTIC + AI SUMMARY: Memory from WRAML3 ──
                if (sid === "memory") {
          const memDocs = selDocs(sid);
          const extracted = extractMemoryText(memDocs, derivedFirstName, meta.pronouns);
          if (extracted) {
            const scoreBlockMatch = extracted.match(/\[MEMORY_SCORES_FOR_SUMMARY\]\n([\s\S]*?)\n\[\/MEMORY_SCORES_FOR_SUMMARY\]/);
            const cleanedText = extracted.replace(/\n*\[MEMORY_SCORES_FOR_SUMMARY\][\s\S]*?\[\/MEMORY_SCORES_FOR_SUMMARY\]\s*/, "").trim();
            if (scoreBlockMatch) {
              try {
                const summaryPrompt = `Write a Summary of Memory and Learning paragraph (150-250 words) for a psychoeducational assessment report.\n\nBased on the following WRAML-3 scores, write a cohesive summary that:\n1. Describes the student's overall memory and learning profile\n2. Compares immediate vs delayed memory\n3. Compares visual vs verbal memory\n4. Notes attention/concentration functioning\n5. Identifies clear strengths and weaknesses\n6. Describes implications for the student's academic functioning (e.g., how memory weaknesses may affect learning, note-taking, following instructions, retaining information)\n7. Uses cautious, professional language — "may", "suggests", "is expected to"\n\nSCORES:\n${scoreBlockMatch[1]}\n\nUse [firstName] and correct pronouns throughout. Do NOT use bullet points. Write in connected paragraphs. Output only the summary paragraph(s).`;
                const summaryResult = await aiGen(meta, tools, summaryPrompt, { name: "Standard", desc: "Functional impact, strengths-based, Ontario style." }, "", [], GLOBAL_TONE_RULES, 2000, "memory", accessPassword, proxyUrl, apiKey, controller.signal, openaiModel);
                if (summaryResult.ok) {
                  let summary = cleanAIOutput(summaryResult.text, "memory");
                  if (!/summary\s+of\s+memory/i.test(summary)) summary = "Summary of Memory and Learning\n\n" + summary;
                  const content = cleanedText + "\n\n" + summary;
                  uSec(sid, { content }); localContent[sid] = content; succeeded++; continue;
                }
              } catch (e) { /* fall through to no-summary */ }
            }
            uSec(sid, { content: cleanedText }); localContent[sid] = cleanedText; succeeded++; continue;
          }
        }

        const sectionPrompt = resolvePrompt(sid, customPrompts);
        const ctxParts = [];
        if (src.notes && s.ctx?.trim()) ctxParts.push(s.ctx.trim());
        if (src.draft && s.content?.trim()) ctxParts.push("=== MY OBSERVATIONS / CURRENT DRAFT ===\n" + s.content.trim());
        // Include behaviour observation menu inputs for the observations section
        if (sid === "observations" && s.behObsMenu) {
          const block = buildBehObsPromptBlock(s.behObsMenu);
          if (block) ctxParts.push(block);
          ctxParts.push(BEH_OBS_AI_RULES);
        }
        // Include socio-emotional inputs for the social_emotional section
        if (sid === "social_emotional") {
          const seParts = [];
          const mod = s.seModifier || "STANDARD";
          seParts.push(`=== MODIFIER: ${mod} ===`);
          if (mod === "OTHER" && s.seOtherDesc?.trim()) {
            seParts.push(`[OTHER_MODIFIER_DESCRIPTION]: ${s.seOtherDesc.trim()}`);
          }
          const bgContent = secs.background?.content?.trim();
          if (bgContent) {
            seParts.push(`=== BACKGROUND INFORMATION (from Background section) ===\n${bgContent}`);
          }
          if (s.seInterview?.trim()) {
            seParts.push(`=== INTERVIEW SOCIO-EMOTIONAL INFORMATION ===\n${s.seInterview.trim()}`);
          }
          const rsPrompt = buildSeRatingScalePrompt(s.seRatingScales);
          if (rsPrompt) {
            seParts.push(rsPrompt);
          }
          ctxParts.push(seParts.join("\n\n"));
        }
        // Include all prior sections for summary + formulation modifiers
        if (sid === "summary") {
          const sumCtx = buildFormulationContext(secs, meta);
          if (sumCtx) ctxParts.push(sumCtx);
          const mods = s.formModifiers || [];
          if (mods.length > 0) {
            const modLabels = mods.map((m) => FORMULATION_MODIFIERS.find((f) => f.id === m)?.label || m);
            ctxParts.push(`=== FORMULATION MODIFIERS (selected) ===\n${modLabels.join("\n")}`);
          }
        }
        // Include recommendations context
        if (sid === "recommendations") {
          const recCtx = buildFormulationContext(secs, meta);
          if (recCtx) ctxParts.push(recCtx);
          const blks = s.recBlocks || [];
          if (blks.length > 0) {
            const blkLabels = blks.map((b) => REC_BLOCKS.find((r) => r.id === b)?.label || b);
            ctxParts.push(`=== RECOMMENDATION BLOCKS (selected) ===\n${blkLabels.join("\n")}`);
          }
          const edu = REC_EDU_LEVELS.find((e) => e.id === (s.recEduLevel || "ELEMENTARY"))?.label || "Elementary";
          ctxParts.push(`=== EDUCATIONAL LEVEL MODIFIER ===\n${edu}`);
        }
        // Include appendix context
        if (sid === "appendix") {
          const appCtx = buildFormulationContext(secs, meta);
          if (appCtx) ctxParts.push(appCtx);
          const recContent = secs.recommendations?.content?.trim();
          if (recContent) ctxParts.push(`=== RECOMMENDATIONS SECTION ===\n${recContent}`);
          const blks = s.appendixBlocks || [];
          if (blks.length > 0) {
            const blkLabels = blks.map((b) => APPENDIX_BLOCKS.find((a) => a.id === b)?.label || b);
            ctxParts.push(`=== APPENDIX_BLOCKS (selected) ===\n${blkLabels.join("\n")}`);
          }
          const edu2 = REC_EDU_LEVELS.find((e) => e.id === (secs.recommendations?.recEduLevel || "ELEMENTARY"))?.label || "Elementary";
          ctxParts.push(`=== EDUCATIONAL LEVEL MODIFIER ===\n${edu2}`);
        }
        // Include appendix tables context — feed all section content with scores
        if (sid === "appendix_tables") {
          let atCogTest2 = useWAISByAge ? "wais-iv" : useWPPSIByAge ? "wppsi-iv" : "wisc-v";
          if (atCogTest2 === "wisc-v") {
            if (tools.find(t => t.id === "wais-iv" && t.used)) atCogTest2 = "wais-iv";
            else if (tools.find(t => t.id === "wppsi-iv" && t.used)) atCogTest2 = "wppsi-iv";
          }
          const atCogLabel2 = atCogTest2 === "wais-iv" ? "WAIS-IV" : atCogTest2 === "wppsi-iv" ? "WPPSI-IV" : "WISC-V";
          const scoreSectionMap2 = [
            { id: "cognitive", label: `COGNITIVE/INTELLECTUAL FUNCTIONING (${atCogLabel2})`, tableType: `${atCogLabel2} Subtest + Index tables` },
            { id: "memory", label: "MEMORY AND LEARNING (WRAML-3 / CMS)", tableType: "Memory Score Summary table" },
            { id: "visual_motor", label: "VISUAL-MOTOR INTEGRATION (Beery VMI)", tableType: "Beery VMI Score Summary table" },
            { id: "social_emotional", label: "SOCIAL-EMOTIONAL FUNCTIONING (BASC-3 / Conners / CBRS / MASC / CDI)", tableType: "Rating scale tables (one per respondent)" },
            { id: "adaptive", label: "DEVELOPMENT AND ADAPTIVE FUNCTIONING (Vineland-3)", tableType: "Vineland Adaptive Behavior Score Summary table" },
            { id: "academic", label: "ACADEMIC TESTING (WIAT-III)", tableType: "WIAT Subtest and Composite Scores table" },
          ];
          const sectionsWithContent2 = [];
          scoreSectionMap2.forEach(({ id: secId, label, tableType }) => {
            // Use localContent (generated earlier in this loop) over stale secs closure
            let content = (localContent[secId] || secs[secId]?.content || "").trim();
            if (content) {
              content = content.replace(/[⟦⟧]/g, "");
              ctxParts.push(`=== ${label} ===\n>>> You MUST build: ${tableType}\n${content}`);
              sectionsWithContent2.push(tableType);
            }
          });
          // Extract WISC subtest score table from uploaded cognitive PDFs
          const allDocsWithText2 = docs.filter((d) => d.extractedText && d.extractedText.length > 50);
          const cogScoreTable2 = extractCognitiveScoreTable(allDocsWithText2);
          if (cogScoreTable2) ctxParts.push(cogScoreTable2);
          const blks = s.tableBlocks || [];
          if (blks.length > 0) {
            const blkLabels = blks.map((b) => TABLE_BLOCKS.find((t) => t.id === b)?.label || b);
            ctxParts.push(`=== TABLE_BLOCKS (selected) ===\n${blkLabels.join("\n")}`);
          } else {
            ctxParts.push("=== TABLE_BLOCKS (selected) ===\nBuild ALL tables for every test found in the section content above. Do not skip any test.");
          }
          if (sectionsWithContent2.length > 0) {
            ctxParts.push(`\n=== CRITICAL FINAL REMINDER ===\nYou MUST produce the following tables based on the sections provided above:\n${sectionsWithContent2.map((t, i) => `${i + 1}. ${t}`).join("\n")}\nDo NOT stop after WISC tables. Every section above MUST have its own table(s). If you only produce WISC tables, that is a FAILURE.`);
          }
        }
        // Smart doc selection: for appendix_tables, ALWAYS include ALL uploaded docs
        let docsForAI2 = sid === "appendix_tables"
          ? docs.filter((d) => d.data || (d.extractedText && d.extractedText.length > 50 && !d.extractedText.startsWith("[")))
          : src.docs ? selDocs(sid) : [];
        if (docsForAI2.length === 0 && docs.length > 0) {
          docsForAI2 = docs.filter((d) => d.data || (d.extractedText && d.extractedText.length > 50 && !d.extractedText.startsWith("[")));
        }

        const result = await aiGen(
          meta, tools,
          sectionPrompt,
          { name: "Standard", desc: "Functional impact, strengths-based, Ontario style." },
          ctxParts.join("\n\n"),
          docsForAI2,
          toneRules,
          sid === "appendix_tables" ? 12000 : sid === "appendix" ? 6000 : 4000,
          sid,
          accessPassword,
          proxyUrl,
          apiKey,
          controller.signal,
          openaiModel
        );
        if (result.ok) {
          let content = result.text;
          if (sid === "appendix_tables") {
            content = content.replace(/^```(?:html|HTML)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();
            const firstTag = content.indexOf("<");
            if (firstTag > 0 && firstTag < 200) {
              content = content.slice(firstTag);
            }
          } else {
            content = cleanAIOutput(content, sid);
          }
          uSec(sid, { content });
          localContent[sid] = content;
          succeeded++;
        } else {
          failed++;
        }
      } catch (err) {
        if (err.name === "AbortError" || controller.signal.aborted) break;
        failed++;
      }
      // Check if cancelled between sections
      if (controller.signal.aborted) break;
    }

    abortControllerRef.current = null;
    setGenning(false);
    if (controller.signal.aborted) {
      showToast("Generation cancelled", "info");
    } else {
      showToast(
        `Generated ${succeeded} section(s)` + (failed > 0 ? `, ${failed} failed` : ""),
        failed > 0 ? "warn" : "success"
      );
    }
  }, [secs, meta, tools, customPrompts, selDocs, docs, uSec, showToast, validateReport, cancelGeneration, accessPassword, proxyUrl, apiKey, derivedFirstName, openaiModel]);

    const usedTools = useMemo(() => tools
    .filter((t) => t.used)
    .map((t) => {
      if (["interview", "interview-student"].includes(t.id)) {
        return t.name.replace("[firstName]", derivedFirstName || "[firstName]");
      }
      if (t.id === "other" && meta.otherToolText) {
        return `${t.name} — ${meta.otherToolText}`;
      }
      return t.name;
    })
    .join(", "), [tools, derivedFirstName, meta.otherToolText]);

    const newCase = useCallback(async () => {
    // Prevent accidental data loss with a confirmation dialog
    const hasContent = Object.values(secs).some((s) => s.content?.trim());
    if (hasContent && !window.confirm("Start a new case? All current data will be permanently cleared.")) return;
    setMeta({
      fullName: "", dob: "", ageAtTesting: "", grade: "", school: "",
      testingDates: ["", "", "", ""],
      reportDate: new Date().toISOString().split("T")[0],
      author: "Dr. Ewa J. Antczak, C.Psych.", authorTitle: "School Psychologist",
      pronouns: "he/him", isLocked: false, otherToolText: "",
    });
    setTools(TOOLS.map((t) => ({ ...t })));
    setDocs([]);
    setSecs(() => {
      const o = {};
      TABS.filter((t) => !["case_info", "documents", "preview", "prompt_reference"].includes(t.id)).forEach((t) => {
        o[t.id] = {
          content: t.id === "observations" ? OBS_DEFAULT_CONTENT : "",
          status: t.id === "interpretation_note" ? SS.APPROVED : SS.DRAFT,
          ctx: "", docIds: [], aiSources: { notes: true, docs: true, draft: false },
          ...(t.id === "observations" ? { behObsMenu: { ...OBS_DEFAULT_MENU } } : {}),
          ...(t.id === "social_emotional" ? { seModifier: "STANDARD", seInterview: "", seOtherDesc: "", seRatingScales: [] } : {}),
          ...(t.id === "summary" ? { formModifiers: [] } : {}),
          ...(t.id === "recommendations" ? { recBlocks: [], recEduLevel: "ELEMENTARY" } : {}),
          ...(t.id === "appendix" ? { appendixBlocks: [] } : {}),
          ...(t.id === "appendix_tables" ? { tableBlocks: [] } : {}),
        };
      });
      return o;
    });
    setTab("case_info");
    showToast("New case started — previous data cleared from memory", "success");
  }, [showToast, secs]);

  // ═══ SAVED CASES SYSTEM ═══
  const SAVED_CASES_KEY = "psychoed-saved-cases";

  const getSavedCases = useCallback(() => {
    try {
      return JSON.parse(localStorage.getItem(SAVED_CASES_KEY) || "[]");
    } catch { return []; }
  }, []);

  const saveCase = useCallback(() => {
    const caseName = meta.fullName?.trim() || "Untitled Case";
    const caseId = "case_" + Date.now();
    const toolIds = tools.filter(t => t.used).map(t => t.id);
    // Save docs without base64 data (too large) — keep extractedText for AI context
    const docsMeta = docs.map(d => ({
      id: d.id, name: d.name, size: d.size, type: d.type,
      categories: d.categories, extractedText: d.extractedText || "",
      uploadedAt: d.uploadedAt, autoClassified: d.autoClassified,
    }));
    const caseData = {
      id: caseId,
      name: caseName,
      savedAt: new Date().toISOString(),
      meta,
      toolIds,
      secs,
      docsMeta,
    };
    try {
      const existing = getSavedCases();
      // Check if case with same name exists — update it
      const idx = existing.findIndex(c => c.name === caseName);
      if (idx >= 0) {
        existing[idx] = caseData;
      } else {
        existing.unshift(caseData);
      }
      localStorage.setItem(SAVED_CASES_KEY, JSON.stringify(existing));
      showToast(`Case "${caseName}" saved`, "success");
    } catch (e) {
      if (e.name === "QuotaExceededError") {
        showToast("Storage full — try deleting old saved cases first", "error");
      } else {
        showToast("Save failed: " + e.message, "error");
      }
    }
  }, [meta, tools, secs, docs, getSavedCases, showToast]);

  const loadCase = useCallback((caseData) => {
    if (!caseData) return;
    const hasContent = Object.values(secs).some(s => s.content?.trim());
    if (hasContent && !window.confirm(`Load "${caseData.name}"? Current unsaved work will be lost.`)) return;
    // Restore meta
    setMeta(caseData.meta || {
      fullName: "", dob: "", ageAtTesting: "", grade: "", school: "",
      testingDates: ["", "", "", ""], reportDate: "", author: "Dr. Ewa J. Antczak, C.Psych.",
      authorTitle: "School Psychologist", pronouns: "he/him", isLocked: false, otherToolText: "",
    });
    // Restore tools
    const usedIds = new Set(caseData.toolIds || []);
    setTools(TOOLS.map(t => ({ ...t, used: usedIds.has(t.id) })));
    // Restore sections
    setSecs(caseData.secs || {});
    // Restore docs (without file data — marked as restored)
    setDocs((caseData.docsMeta || []).map(d => ({
      ...d, data: "", _pdfPages: null, _docxTables: null, _restored: true,
    })));
    setShowSavedCases(false);
    setTab("case_info");
    showToast(`Case "${caseData.name}" loaded`, "success");
  }, [secs, showToast]);

  const deleteSavedCase = useCallback((caseId) => {
    if (!window.confirm("Delete this saved case? This cannot be undone.")) return;
    try {
      const existing = getSavedCases().filter(c => c.id !== caseId);
      localStorage.setItem(SAVED_CASES_KEY, JSON.stringify(existing));
      setShowSavedCases(false);
      setTimeout(() => setShowSavedCases(true), 50); // refresh list
      showToast("Saved case deleted", "success");
    } catch (e) {
      showToast("Delete failed: " + e.message, "error");
    }
  }, [getSavedCases, showToast]);

    const handleExportDocx = useCallback(() => {
    if (!validateReport()) return;
    try {
      setExporting(true);
      exportDocx(meta, secs, tools, usedTools);
      showToast("DOCX downloaded", "success");
    } catch (err) {
      showToast("DOCX export failed: " + err.message, "error");
    } finally {
      setExporting(false);
    }
  }, [meta, secs, tools, usedTools, validateReport, showToast]);

  const handleExportPdf = useCallback(async () => {
    if (!validateReport()) return;
    try {
      setExporting(true);
      showToast("Generating PDF (loading libraries)...", "info");
      await exportPdf(reportRef.current, meta);
      showToast("PDF downloaded", "success");
    } catch (err) {
      showToast("PDF export failed: " + err.message, "error");
    } finally {
      setExporting(false);
    }
  }, [meta, validateReport, showToast]);

        return (
    <>
      {/* Toast — rendered outside overflow container for proper z-stacking */}
      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

    <div style={{ position: "fixed", inset: 0, display: "flex" }} className="bg-gray-100">
      {/* Hidden file inputs */}
      <input ref={secFileRef} type="file" onChange={handleSecFile} className="hidden" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.txt,.csv" />

      {/* Sidebar */}
      <div className="w-52 min-w-52 bg-white border-r border-gray-200 flex flex-col flex-shrink-0" style={{ height: "100%" }} data-no-print>
        <div className="p-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <div className="bg-indigo-600 p-1 rounded-lg">
              <ShieldCheck className="text-white" size={16} />
            </div>
            <span className="font-extrabold text-sm tracking-tight">
              PsychoEd<span className="text-indigo-600">Pro</span>
            </span>
          </div>
          <p className="text-gray-400 font-bold uppercase mt-0.5" style={{ fontSize: 7, letterSpacing: "0.15em" }}>
            Report Writing Engine
          </p>
        </div>
        {/* Quick Preview Button — always visible at top */}
        <div className="px-2 pb-1">
          <button
            onClick={() => setTab("preview")}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl font-bold transition-all ${
              tab === "preview"
                ? "bg-indigo-600 text-white shadow-lg"
                : "bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-300 text-indigo-700 hover:from-indigo-100 hover:to-purple-100 hover:shadow"
            }`}
            style={{ fontSize: 12 }}
          >
            <Eye size={14} />
            Report Preview & Export
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }} className="py-1 px-1.5 space-y-px" role="tablist" aria-label="Report sections">
          {TABS.map((t, i) => {
            if (t.id === "preview") return null; // Rendered as dedicated button above
            const a = tab === t.id;
            const s = secs[t.id];
            const hc = s?.content?.length > 0;
            const fin = s?.status === SS.APPROVED;
            const sep = i === 2 || i === 16;
            return (
              <div key={t.id}>
                {sep && <div className="border-t border-gray-100 my-1.5" />}
                <button
                  role="tab"
                  aria-selected={a}
                  aria-label={`${t.label}${fin ? " (finalized)" : hc ? " (has content)" : ""}`}
                  onClick={() => setTab(t.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg transition-all ${
                    a ? "bg-indigo-600 text-white font-bold shadow" : "text-gray-500 hover:bg-gray-50 font-medium"
                  }`}
                  style={{ fontSize: 11 }}
                >
                  <span className="truncate">{t.label}</span>
                  {fin ? (
                    <CheckCircle size={10} className={a ? "text-white" : "text-green-500"} />
                  ) : hc ? (
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
        <div className="p-2 border-t border-gray-200 bg-gray-50 space-y-1.5">
          {/* Access Configuration — adapts to local vs deployed mode */}
          {/* API Key — always shown */}
            <div className={`rounded-lg border px-2 py-1.5 ${apiKey ? "bg-emerald-50 border-emerald-200" : "bg-orange-50 border-orange-300"}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="flex items-center gap-1">
                  <Key size={9} className={apiKey ? "text-emerald-600" : "text-orange-500"} />
                  <span className="font-extrabold uppercase" style={{ fontSize: 7, letterSpacing: "0.08em" }}>
                    OpenAI API Key
                  </span>
                </span>
                {apiKey && (
                  <span className="font-extrabold uppercase text-emerald-700 bg-emerald-100 px-1.5 rounded" style={{ fontSize: 7 }}>
                    READY
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                <input
                  type={showPassword ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value.trim())}
                  placeholder="sk-..."
                  className="flex-1 px-1.5 py-1 rounded border border-gray-300 bg-white text-xs font-mono"
                  style={{ fontSize: 9 }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  onClick={() => setShowPassword((p) => !p)}
                  className="px-1.5 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50"
                  title={showPassword ? "Hide" : "Show"}
                >
                  {showPassword ? <EyeOff size={10} /> : <Eye size={10} />}
                </button>
              </div>
              <p className="mt-1 text-gray-400" style={{ fontSize: 6.5 }}>
                Key saved in this browser only.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span className="font-extrabold uppercase text-gray-500" style={{ fontSize: 7, letterSpacing: "0.08em" }}>Model:</span>
                <select
                  value={openaiModel}
                  onChange={(e) => setOpenaiModel(e.target.value)}
                  className="px-1.5 py-0.5 rounded border border-gray-300 bg-white text-xs font-mono"
                  style={{ fontSize: 9 }}
                >
                  {OPENAI_MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>{m}{m === "gpt-4o-mini" ? " (faster, cheaper)" : " (best quality)"}</option>
                  ))}
                </select>
              </div>
            </div>
          <button
            onClick={genning ? cancelGeneration : generateAll}
            disabled={false}
            className={`w-full flex items-center justify-center gap-2 px-2 py-2.5 rounded-xl font-extrabold uppercase shadow-lg disabled:opacity-40 transition-colors ${
              genning ? "bg-red-700 hover:bg-red-600 text-white" : "bg-indigo-950 hover:bg-indigo-900 text-white"
            }`}
            style={{ fontSize: 9, letterSpacing: "0.08em" }}
            aria-label={genning ? "Cancel generation" : "Generate full report"}
          >
            {genning ? (
              <X size={12} />
            ) : (
              <Sparkles size={12} />
            )}
            {genning ? "Cancel Generation" : "Generate Full Report"}
          </button>
          <button
            onClick={() => setPrivacyMode((p) => !p)}
            className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left ${
              privacyMode ? "bg-emerald-50 border border-emerald-200" : "bg-amber-50 border border-amber-200"
            }`}
          >
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={10} className={privacyMode ? "text-emerald-600" : "text-amber-500"} />
              <span className="font-extrabold uppercase" style={{ fontSize: 7, letterSpacing: "0.08em" }}>
                Privacy Mode
              </span>
            </span>
            <span
              className={`font-extrabold uppercase px-1.5 rounded ${
                privacyMode ? "text-emerald-700 bg-emerald-100" : "text-amber-600 bg-amber-100"
              }`}
              style={{ fontSize: 7 }}
            >
              {privacyMode ? "ON" : "OFF"}
            </span>
          </button>
          <button
            onClick={newCase}
            disabled={genning}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={10} />
            <span className="font-extrabold uppercase" style={{ fontSize: 7, letterSpacing: "0.08em" }}>New Case</span>
          </button>
          <div className="flex gap-1">
            <button
              onClick={saveCase}
              disabled={genning}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-40"
            >
              <Save size={10} />
              <span className="font-extrabold uppercase" style={{ fontSize: 7, letterSpacing: "0.08em" }}>Save</span>
            </button>
            <button
              onClick={() => setShowSavedCases(!showSavedCases)}
              disabled={genning}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border transition-colors disabled:opacity-40 ${
                showSavedCases ? "bg-indigo-100 border-indigo-300 text-indigo-700" : "bg-indigo-50 border-indigo-200 text-indigo-600 hover:bg-indigo-100"
              }`}
            >
              <FolderOpen size={10} />
              <span className="font-extrabold uppercase" style={{ fontSize: 7, letterSpacing: "0.08em" }}>Load</span>
            </button>
          </div>
          {showSavedCases && (() => {
            const cases = getSavedCases();
            return (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-2 max-h-48 overflow-y-auto">
                <p className="font-extrabold uppercase text-indigo-600 mb-1.5" style={{ fontSize: 7, letterSpacing: "0.08em" }}>
                  Saved Cases ({cases.length})
                </p>
                {cases.length === 0 ? (
                  <p className="text-gray-400 text-center py-2" style={{ fontSize: 8 }}>No saved cases yet</p>
                ) : (
                  <div className="space-y-1">
                    {cases.map((c) => (
                      <div key={c.id} className="flex items-center gap-1 bg-white rounded border border-gray-200 px-2 py-1">
                        <button
                          onClick={() => loadCase(c)}
                          className="flex-1 text-left hover:text-indigo-700 transition-colors"
                          style={{ fontSize: 8 }}
                        >
                          <span className="font-bold block truncate">{c.name}</span>
                          <span className="text-gray-400 block" style={{ fontSize: 7 }}>
                            {new Date(c.savedAt).toLocaleDateString()} {new Date(c.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </button>
                        <button
                          onClick={() => deleteSavedCase(c.id)}
                          className="p-0.5 text-red-400 hover:text-red-600 rounded hover:bg-red-50 transition-colors"
                          title="Delete saved case"
                        >
                          <Trash2 size={9} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          <div className="flex justify-between items-center px-1">
            <span className="text-gray-400" style={{ fontSize: 7 }}>v4.0 — OpenAI + PHIPA Privacy</span>
          </div>
        </div>
      </div>

      {/* Main */}
      <main style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
        <div className="max-w-5xl mx-auto p-5 pb-32" data-no-print={tab !== "preview" ? true : undefined}>

          {/* Privacy Mode Banner */}
          {privacyMode && tab === "documents" && (
            <div className="mb-4 flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl">
              <ShieldCheck size={14} className="text-emerald-600 flex-shrink-0" />
              <p className="text-xs font-semibold text-emerald-700">
                Privacy Mode active. Sensitive document text is stored in memory only and will not persist in browser storage.
              </p>
            </div>
          )}

          {/* ══ CASE INFO ══ */}
          {tab === "case_info" && (
            <div className="space-y-5">
              <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <div className="bg-indigo-50 p-1.5 rounded-xl">
                      <UserCheck size={18} className="text-indigo-600" />
                    </div>
                    <h3 className="text-lg font-extrabold tracking-tight">Record Identification</h3>
                  </div>
                  <button
                    onClick={() => setMeta((p) => ({ ...p, isLocked: !p.isLocked }))}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded-xl font-extrabold uppercase ${
                      meta.isLocked ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-500"
                    }`}
                    style={{ fontSize: 9 }}
                  >
                    {meta.isLocked ? <><Lock size={11} /> Locked</> : <><Unlock size={11} /> Lock</>}
                  </button>
                </div>
                <div className={`grid grid-cols-2 gap-x-5 gap-y-4 ${meta.isLocked ? "opacity-50 pointer-events-none" : ""}`}>
                  {[
                    ["fullName", "Name of the student", "text"],
                    ["dob", "D.O.B.", "date"],
                    ["ageAtTesting", "Age of the student", "text"],
                    ["grade", "Grade level", "text"],
                    ["school", "School attended", "text"],
                    ["reportDate", "Report Date", "date"],
                  ].map(([k, l, t]) => (
                    <div key={k}>
                      <label
                        className="text-xs font-extrabold text-gray-400 uppercase block mb-1"
                        style={{ fontSize: 9, letterSpacing: "0.08em" }}
                      >
                        {l}
                      </label>
                      <input
                        type={t}
                        value={meta[k] || ""}
                        onChange={(e) => setMeta((p) => ({ ...p, [k]: e.target.value }))}
                        className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl outline-none text-sm font-medium"
                      />
                      {t === "date" && meta[k] && (
                        <p className="mt-0.5 text-xs text-indigo-500 font-medium" style={{ fontSize: 10 }}>{formatDate(meta[k])}</p>
                      )}
                    </div>
                  ))}
                  <div>
                    <label
                      className="text-xs font-extrabold text-gray-400 uppercase block mb-1"
                      style={{ fontSize: 9, letterSpacing: "0.08em" }}
                    >
                      Pronouns
                    </label>
                    <select
                      value={meta.pronouns}
                      onChange={(e) => setMeta((p) => ({ ...p, pronouns: e.target.value }))}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl outline-none text-sm font-medium"
                    >
                      <option value="he/him">he/him</option>
                      <option value="she/her">she/her</option>
                      <option value="they/them">they/them</option>
                    </select>
                  </div>
                  {/* Locked author */}
                  <div>
                    <label
                      className="text-xs font-extrabold text-gray-400 uppercase block mb-1"
                      style={{ fontSize: 9, letterSpacing: "0.08em" }}
                    >
                      <Lock size={8} className="inline -mt-0.5 mr-0.5" /> Written by
                    </label>
                    <div className="w-full px-3 py-2.5 bg-gray-100 border border-gray-200 rounded-xl text-sm font-medium text-gray-500">
                      Dr. Ewa Antczak, School Psychologist
                    </div>
                  </div>
                  {/* Auto-derived first name indicator */}
                  {derivedFirstName && (
                    <div className="col-span-2">
                      <p className="text-xs text-gray-400" style={{ fontSize: 8 }}>
                        <span className="font-bold text-indigo-500">First name used in report:</span> {derivedFirstName} <span className="text-gray-300">(auto-derived from student name)</span>
                      </p>
                    </div>
                  )}
                  <div className="col-span-2 pt-2">
                    <p
                      className="text-xs font-extrabold text-gray-400 uppercase mb-2 flex items-center gap-1"
                      style={{ fontSize: 9 }}
                    >
                      <Calendar size={10} className="text-indigo-400" /> Testing Dates
                    </p>
                    <div className="grid grid-cols-4 gap-2">
                      {meta.testingDates.map((d, i) => (
                        <div key={i}>
                          <label className="text-xs font-bold text-gray-300 uppercase block mb-0.5" style={{ fontSize: 8 }}>
                            Session {i + 1}
                          </label>
                          <input
                            type="date"
                            value={d}
                            onChange={(e) => {
                              const n = [...meta.testingDates];
                              n[i] = e.target.value;
                              setMeta((p) => ({ ...p, testingDates: n }));
                            }}
                            className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg outline-none text-xs"
                          />
                        </div>
                      ))}
                    </div>
                    {meta.testingDates.some(Boolean) && (
                      <p className="mt-2 text-xs text-indigo-600 font-medium" style={{ fontSize: 10 }}>
                        {formatTestingDates(meta.testingDates)}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Tools */}
              <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                <div className="flex items-center gap-2 mb-5">
                  <div className="bg-indigo-50 p-1.5 rounded-xl">
                    <Clipboard size={18} className="text-indigo-600" />
                  </div>
                  <h3 className="text-lg font-extrabold tracking-tight">Tests Administered</h3>
                </div>
                {TOOL_CATS.map((cat) => {
                  const ct = tools.filter((t) => t.cat === cat);
                  return (
                    <div key={cat} className="mb-4">
                      <p
                        className="text-xs font-extrabold text-indigo-900 uppercase border-b-2 border-indigo-50 pb-1 mb-2"
                        style={{ letterSpacing: "0.05em" }}
                      >
                        {cat}
                      </p>
                      <div className="grid grid-cols-1 gap-1.5">
                        {ct.map((tool) => (
                          <button
                            key={tool.id}
                            onClick={() => setTools((p) => p.map((t) => (t.id === tool.id ? { ...t, used: !t.used } : t)))}
                            className={`p-2.5 rounded-xl border text-left text-xs font-semibold flex items-center gap-2 ${
                              tool.used
                                ? "border-indigo-600 bg-indigo-50 text-indigo-900 shadow-sm"
                                : "border-gray-100 text-gray-400 hover:bg-gray-50"
                            }`}
                          >
                            <div
                              className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 ${
                                tool.used ? "bg-indigo-600" : "border-2 border-gray-200"
                              }`}
                            >
                              {tool.used && <Check size={10} className="text-white" />}
                            </div>
                            {["interview", "interview-student"].includes(tool.id)
                              ? tool.name.replace("[firstName]", derivedFirstName || "[firstName]")
                              : tool.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {/* Other tool text input */}
                {tools.find((t) => t.id === "other")?.used && (
                  <div className="mt-3 p-3 bg-indigo-50 rounded-xl border border-indigo-200">
                    <label
                      className="text-xs font-extrabold text-indigo-700 uppercase block mb-1"
                      style={{ fontSize: 9, letterSpacing: "0.08em" }}
                    >
                      Specify Other Assessment(s):
                    </label>
                    <input
                      type="text"
                      value={meta.otherToolText || ""}
                      onChange={(e) => setMeta((p) => ({ ...p, otherToolText: e.target.value }))}
                      placeholder="e.g., CELF-5, CTONI-2, etc."
                      className="w-full px-3 py-2 bg-white border border-indigo-100 rounded-lg outline-none text-xs font-medium"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══ DOCUMENTS ══ */}
          {tab === "documents" && (
            <div className="space-y-5">
              <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <div className="bg-indigo-50 p-1.5 rounded-xl">
                      <Upload size={18} className="text-indigo-600" />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold tracking-tight">Document Upload & Case File</h3>
                      <p className="text-xs text-gray-400">PDF, JPG, PNG, Word, TXT, CSV — unlimited uploads</p>
                    </div>
                  </div>
                  <span className="text-sm font-bold text-gray-400">
                    {docs.length} file{docs.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div
                  onClick={() => fRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer group transition-colors ${
                    dragging
                      ? "border-indigo-500 bg-indigo-50/60"
                      : "border-indigo-200 hover:bg-indigo-50/30"
                  }`}
                >
                  <Upload size={28} className={`mx-auto mb-2 ${dragging ? "text-indigo-500" : "text-indigo-300 group-hover:text-indigo-500"}`} />
                  <p className="text-sm font-semibold text-gray-600">
                    {dragging ? "Drop files here" : "Click or drag & drop to upload"}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">Drop multiple files at once — AI auto-classifies each document</p>
                </div>
                <input ref={fRef} type="file" onChange={handleFile} className="hidden" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.txt,.csv" multiple />
                {docs.length > 0 && (
                  <div className="mt-5 space-y-1.5">
                    <p className="text-xs font-extrabold text-gray-400 uppercase" style={{ fontSize: 9 }}>
                      Uploaded Documents
                    </p>
                    {docs.map((d) => (
                      <div key={d.id} className="p-2.5 bg-gray-50 rounded-xl border border-gray-100">
                        <div className="flex items-center gap-2">
                          <div className="bg-indigo-100 p-1 rounded-lg flex-shrink-0">
                            {d.type?.includes("image") ? (
                              <Image size={12} className="text-indigo-600" />
                            ) : (
                              <File size={12} className="text-indigo-600" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-gray-700 truncate">{d.name}</p>
                            <p className="text-xs text-gray-400">{formatFileSize(d.size)}</p>
                          </div>
                          {d._restored && (
                            <span className="text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded font-bold flex-shrink-0" style={{ fontSize: 7 }}>
                              RESTORED
                            </span>
                          )}
                          {d.extractedText && !d.extractedText.startsWith("[") && (
                            <span className="text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded font-bold flex-shrink-0" style={{ fontSize: 8 }}>
                              TEXT EXTRACTED
                            </span>
                          )}
                          <button onClick={() => editDocCats(d)} className="p-1 text-gray-400 hover:text-indigo-600" title="Edit categories">
                            <Pencil size={12} />
                          </button>
                          <button onClick={() => rmDoc(d.id)} className="p-1 text-gray-300 hover:text-red-500" title="Remove">
                            <X size={13} />
                          </button>
                        </div>
                        {/* Category chips */}
                        <div className="flex flex-wrap gap-1 mt-1.5 ml-7">
                          {d.autoClassified && (
                            <span className="text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded font-bold" style={{ fontSize: 7 }}>
                              AI-CLASSIFIED
                            </span>
                          )}
                          {d.categories.map((c) => (
                            <span key={c} className="text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded" style={{ fontSize: 8 }}>
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Upload Modal */}
              {upModal && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                  <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-base font-extrabold">Edit Document Categories</h4>
                      <button onClick={() => setUpModal(null)} className="p-1 text-gray-400 hover:text-gray-600">
                        <X size={16} />
                      </button>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-2.5 flex items-center gap-2">
                      <File size={15} className="text-indigo-600" />
                      <div>
                        <p className="text-sm font-semibold">{upModal.name}</p>
                        <p className="text-xs text-gray-400">{formatFileSize(upModal.size)}</p>
                      </div>
                      {upModal.extractedText && !upModal.extractedText.startsWith("[") && (
                        <span className="ml-auto text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded font-bold" style={{ fontSize: 9 }}>
                          Text extracted
                        </span>
                      )}
                    </div>
                    {upModal.extractedText && upModal.extractedText.startsWith("[") && (
                      <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-xl">
                        <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                        <span>{upModal.extractedText}</span>
                      </div>
                    )}
                    <div>
                      <p className="text-xs font-extrabold text-gray-500 uppercase mb-2" style={{ fontSize: 9 }}>
                        Assign categories:
                      </p>
                      <div className="space-y-1 max-h-56 overflow-y-auto">
                        {DOC_CATEGORIES.map((c) => {
                          const ch = upModal.cats.includes(c);
                          return (
                            <label
                              key={c}
                              className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer text-xs ${
                                ch ? "bg-indigo-50" : "hover:bg-gray-50"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={ch}
                                onChange={() =>
                                  setUpModal((p) => ({
                                    ...p,
                                    cats: ch ? p.cats.filter((x) => x !== c) : [...p.cats, c],
                                  }))
                                }
                                style={{ accentColor: "#4f46e5" }}
                              />
                              <span className="font-medium text-gray-700">{c}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setUpModal(null)}
                        className="flex-1 py-2 rounded-xl border border-gray-200 text-sm font-semibold text-gray-500"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveCats}
                        disabled={upModal.cats.length === 0}
                        className="flex-1 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-40"
                      >
                        Save Categories
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══ INTERPRETATION NOTE ══ */}
          {tab === "interpretation_note" && (
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lock size={14} className="text-amber-600" />
                  <div>
                    <h3 className="text-sm font-extrabold text-amber-800">
                      A Note on the Interpretation of Assessment Results
                    </h3>
                    <p className="text-xs text-amber-600 font-semibold mt-0.5">
                      Locked. Name & pronouns auto-replaced. Version auto-selected from age.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 bg-white rounded-lg border border-amber-200 p-0.5">
                  <button
                    onClick={() => setInterpNoteType("minor")}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                      interpNoteType === "minor"
                        ? "bg-amber-500 text-white"
                        : "text-amber-700 hover:bg-amber-100"
                    }`}
                    style={{ fontSize: 10 }}
                  >
                    Minor (Under 18)
                  </button>
                  <button
                    onClick={() => setInterpNoteType("adult")}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                      interpNoteType === "adult"
                        ? "bg-amber-500 text-white"
                        : "text-amber-700 hover:bg-amber-100"
                    }`}
                    style={{ fontSize: 10 }}
                  >
                    Adult (18+)
                  </button>
                </div>
              </div>
              <div className="p-6">
                <div className="text-gray-700" style={INTERP_NOTE_STYLE}>
                  {cleanAIOutput(secs.interpretation_note.content, "interpretation_note").split("\n\n").map((p, i) => (
                    <p key={i} style={{ marginBottom: "0.5em" }}>{p}</p>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ══ SECTION EDITORS ══ */}
          {SECTION_IDS.includes(tab) && (
            <SecEd
              key={tab}
              sid={tab}
              secs={secs}
              docs={docs}
              meta={meta}
              tools={tools}
              customPrompts={customPrompts}
              onSavePrompt={savePrompt}
              onDeletePrompt={deletePrompt}
              genning={genning}
              onGenerate={gen}
              onUpdateSec={uSec}
              onToggleDoc={togDoc}
              onApplyQuick={applyQ}
              onSecUpload={onSecUpload}
              onSecDrop={processFile}
              showToast={showToast}
              behObsMenu={secs.observations?.behObsMenu}
              onBehObsChange={updateBehObsMenu}
            />
          )}

          {/* ══ REPORT PREVIEW ══ */}
          {tab === "preview" && (
            <div className="space-y-5">
              <div className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm" data-no-print>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Eye size={18} className="text-indigo-600" />
                    <h3 className="text-lg font-extrabold">Report Preview & Export</h3>
                  </div>
                  <button
                    onClick={generateAll}
                    disabled={genning}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-950 text-white font-bold text-xs uppercase shadow-lg disabled:opacity-40 hover:bg-indigo-900 transition-colors"
                    style={{ letterSpacing: "0.08em" }}
                  >
                    {genning ? (
                      <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <Sparkles size={13} />
                    )}
                    {genning ? "Generating..." : "Generate Full Report"}
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
                  <span className="text-xs font-bold text-gray-400 uppercase mr-1" style={{ letterSpacing: "0.06em" }}>Export:</span>
                  <button
                    onClick={handleExportDocx}
                    disabled={exporting}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white font-bold text-xs uppercase shadow hover:bg-blue-500 transition-colors disabled:opacity-40"
                    style={{ letterSpacing: "0.06em" }}
                  >
                    {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} DOCX
                  </button>
                  <button
                    onClick={handleExportPdf}
                    disabled={exporting}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 text-white font-bold text-xs uppercase shadow hover:bg-red-500 transition-colors disabled:opacity-40"
                    style={{ letterSpacing: "0.06em" }}
                  >
                    {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} PDF
                  </button>
                  <button
                    onClick={() => { if (validateReport()) window.print(); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold text-xs uppercase shadow hover:bg-indigo-500 transition-colors"
                    style={{ letterSpacing: "0.06em" }}
                  >
                    <Printer size={12} /> Print
                  </button>
                </div>
              </div>

              {/* THE REPORT */}
              <style>{`
                .score-tables { font-family: "Times New Roman", Times, serif; }
                .score-tables h3, .score-tables h4, .score-tables caption {
                  font-family: "Times New Roman", Times, serif;
                  font-size: 13px; font-weight: bold; margin: 20px 0 8px 0;
                  padding-bottom: 4px; border-bottom: 2px solid #333; text-align: left;
                }
                .score-tables table {
                  width: 100%; border-collapse: collapse; margin-bottom: 24px;
                  font-family: "Times New Roman", Times, serif; font-size: 11px;
                  border: 1px solid #999;
                }
                .score-tables table caption {
                  caption-side: top; padding: 10px 12px; font-size: 12px;
                  font-weight: bold; background: #e8e8f0; border: 1px solid #999;
                  border-bottom: none; text-align: left;
                }
                .score-tables thead tr { background: #f0f0f5; }
                .score-tables th {
                  padding: 7px 12px; text-align: left; font-weight: bold;
                  border: 1px solid #bbb; font-size: 10.5px; color: #222;
                }
                .score-tables td {
                  padding: 6px 12px; border: 1px solid #ccc; color: #333;
                }
                .score-tables tbody tr:nth-child(even) { background: #fafaff; }
                .score-tables tbody tr:nth-child(odd) { background: #fff; }
                .score-tables b, .score-tables strong { font-weight: bold; }
                .score-tables td:not(:first-child), .score-tables th:not(:first-child) { text-align: center; }
                @media print {
                  .report-header, .report-footer { position: fixed; left: 0; right: 0; }
                  .report-header { top: 0; }
                  .report-footer { bottom: 0; }
                  .report-body { margin-top: 60px; margin-bottom: 50px; }
                  .page-break { break-before: page; page-break-before: always; }
                  .page-break-divider { display: none !important; }
                  @page {
                    @bottom-center {
                      content: counter(page);
                      font-family: "Times New Roman", Times, serif;
                      font-size: 10pt;
                      color: #555;
                    }
                  }
                }
              `}</style>
              <div
                ref={reportRef}
                id="report-content"
                className="print-report bg-white border border-gray-300 shadow-lg"
                style={REPORT_CONTAINER_STYLE}
              >
                {/* ─── PRINT HEADER: Name + DOB on pages 2+ ─── */}
                <div className="print-header" style={{ display: "none" }}>
                  {meta.fullName || "Student Name"}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;D.O.B. {formatDate(meta.dob) || "____"}
                </div>

                {/* ─── FIRST PAGE HEADER: Logo + Title ─── */}
                <div style={REPORT_HEADER_STYLE}>
                  <img src={LOGO_B64} alt="Core Psychological Services" style={REPORT_LOGO_STYLE} />
                  <h1 style={{
                    fontSize: 18, fontWeight: "bold", letterSpacing: "0.04em", margin: 0,
                    fontFamily: "'Times New Roman', Times, serif",
                  }}>
                    PSYCHOEDUCATIONAL ASSESSMENT REPORT
                  </h1>
                </div>

                {/* ─── REPORT BODY ─── */}
                <div className="report-body" style={REPORT_BODY_STYLE}>

                  {/* ─── CASE INFORMATION TABLE ─── */}
                  <div style={{ marginBottom: 28 }}>
                    {[
                      ["Name of the student:", meta.fullName],
                      ["D.O.B.:", formatDate(meta.dob)],
                      ["School attended:", meta.school],
                      ["Age of the student:", meta.ageAtTesting],
                      ["Grade level:", meta.grade],
                    ].map(([label, val]) => (
                      <div key={label} style={{ display: "flex", marginBottom: 3, fontSize: 12 }}>
                        <span style={{ fontWeight: "bold", width: 180, flexShrink: 0 }}>{label}</span>
                        <span>{val || "\u2014"}</span>
                      </div>
                    ))}
                    <div style={{ height: 10 }} />
                    <div style={{ display: "flex", marginBottom: 3, fontSize: 12 }}>
                      <span style={{ fontWeight: "bold", width: 180, flexShrink: 0 }}>Testing Dates:</span>
                      <span>{formatTestingDates(meta.testingDates) || "\u2014"}</span>
                    </div>
                    <div style={{ display: "flex", marginBottom: 3, fontSize: 12 }}>
                      <span style={{ fontWeight: "bold", width: 180, flexShrink: 0 }}>Tests administered:</span>
                      <span style={{ lineHeight: 1.6 }}>{usedTools || "\u2014"}</span>
                    </div>
                    <div style={{ height: 10 }} />
                    <div style={{ display: "flex", marginBottom: 3, fontSize: 12 }}>
                      <span style={{ fontWeight: "bold", width: 180, flexShrink: 0 }}>Report Date:</span>
                      <span>{formatDate(meta.reportDate) || "\u2014"}</span>
                    </div>
                    <div style={{ display: "flex", marginBottom: 3, fontSize: 12 }}>
                      <span style={{ fontWeight: "bold", width: 180, flexShrink: 0 }}>Written by:</span>
                      <span>{meta.author || "\u2014"}{meta.authorTitle ? `, ${meta.authorTitle}` : ""}</span>
                    </div>
                  </div>

                  {/* ─── REPORT SECTIONS ─── */}
                  {(() => {
                    // Build sections matching the exact template structure
                    const renderSection = (id, title, titleStyle, extraTitles, introParagraph) => {
                      let c = secs[id]?.content;
                      if (id === "background") {
                        const opening = pz(BG_STANDARD_OPENING);
                        c = c ? opening + "\n\n" + c : opening;
                      }
                      if (id === "observations") {
                        c = c ? capitalizeSentences(pz(c)) : "";
                      }
                      if (!c) return null;
                      const displayC = cleanAIOutput(c.replace(/[⟦⟧]/g, ""), id);
                      return (
                        <div key={id} style={{ marginBottom: 20, pageBreakInside: "avoid" }}>
                          <p style={{
                            fontWeight: "bold",
                            textDecoration: titleStyle === "boldUnderline" ? "underline" : "none",
                            marginBottom: 6, fontSize: 12,
                          }}>{title}</p>
                          {introParagraph && (
                            <div style={{ whiteSpace: "pre-line", textAlign: "justify", marginBottom: 12 }}>{introParagraph}</div>
                          )}
                          {extraTitles && extraTitles.map((et, i) => (
                            <p key={i} style={{ fontWeight: "bold", marginBottom: 6, fontSize: 12 }}>{et}</p>
                          ))}
                          <div style={{ whiteSpace: "pre-line", textAlign: "justify" }}>{displayC}</div>
                        </div>
                      );
                    };
                    return (
                      <>
                        {renderSection("interpretation_note", "A Note on the Interpretation of Assessment Results", "bold")}
                        {renderSection("referral", "Reasons for referral:", "bold")}
                        {renderSection("background", "BACKGROUND INFORMATION:", "bold")}
                        {renderSection("doc_review", "Review of Documents", "bold")}
                        {renderSection("observations", "Behavior Observations:", "bold")}

                        {/* RESULTS AND INTERPRETATION — special structure per template */}
                        {secs.cognitive?.content && (
                          <div style={{ marginBottom: 20, pageBreakInside: "avoid" }}>
                            <p style={{ fontWeight: "bold", marginBottom: 6, fontSize: 12 }}>RESULTS AND INTERPRETATION</p>
                            <div style={{ whiteSpace: "pre-line", textAlign: "justify", marginBottom: 12 }}>
                              The actual test scores contained within this report are attached as an appendix. Please note all testing was completed. A summary of the trends that emerged is included in the sections that follow. From a review of these results the following patterns of abilities, skills and needs emerge.
                            </div>
                            <p style={{ fontWeight: "bold", marginBottom: 6, fontSize: 12 }}>Cognitive/Intellectual Functioning</p>
                            <div style={{ whiteSpace: "pre-line", textAlign: "justify" }}>
                              {cleanAIOutput(secs.cognitive.content.replace(/[⟦⟧]/g, ""), "cognitive")}
                            </div>
                          </div>
                        )}

                        {renderSection("memory", "Memory and Learning", "bold")}
                        {renderSection("visual_motor", "Visual-motor integration skills", "bold")}
                        {renderSection("social_emotional", "Social-Emotional Functioning", "bold")}
                        {renderSection("adaptive", "Development and Adaptive Functioning", "bold")}
                        {renderSection("academic", "Academic Testing", "bold")}
                        {renderSection("summary", "SUMMARY, FORMULATION AND DIAGNOSIS", "bold")}
                        {/* Strengths and Needs — bullet point format */}
                        {secs.strengths_needs?.content && (() => {
                          const raw = cleanAIOutput(secs.strengths_needs.content.replace(/[⟦⟧]/g, ""), "strengths_needs");
                          const parts = raw.split(/\n\s*(WEAKNESSES|NEEDS)\s*\n?/i);
                          const strengthsRaw = (parts[0] || "").replace(/^\s*STRENGTHS\s*\n?/i, "").trim();
                          const weaknessesRaw = (parts[2] || parts[1] || "").trim();
                          const toBullets = (text) => text.split("\n").map(l => l.trim()).filter(l => l.length > 0).map(l => l.replace(/^[•\-\*]\s*/, ""));
                          const sBullets = toBullets(strengthsRaw);
                          const wBullets = toBullets(weaknessesRaw);
                          const maxRows = Math.max(sBullets.length, wBullets.length);
                          const cellStyle = { padding: "4px 10px", borderBottom: "1px solid #ddd", verticalAlign: "top", fontSize: 11 };
                          return (
                            <div style={{ marginBottom: 20 }}>
                              <p style={{ fontWeight: "bold", textDecoration: "underline", marginBottom: 6, fontSize: 12 }}>Strengths and Needs</p>
                              <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #999", fontFamily: "'Times New Roman', Times, serif" }}>
                                <thead>
                                  <tr style={{ background: "#f0f0f5" }}>
                                    <th style={{ padding: "6px 10px", borderBottom: "2px solid #999", borderRight: "1px solid #999", textAlign: "left", fontWeight: "bold", fontSize: 11, width: "50%" }}>Strengths</th>
                                    <th style={{ padding: "6px 10px", borderBottom: "2px solid #999", textAlign: "left", fontWeight: "bold", fontSize: 11, width: "50%" }}>Weaknesses</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Array.from({ length: maxRows }).map((_, i) => (
                                    <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#fafaff" }}>
                                      <td style={{ ...cellStyle, borderRight: "1px solid #ddd" }}>{sBullets[i] || ""}</td>
                                      <td style={cellStyle}>{wBullets[i] || ""}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          );
                        })()}

                        {/* Recommendations — with intro paragraph per template — new page */}
                        {secs.recommendations?.content && (
                          <>
                            <div className="page-break-divider" style={{ margin: "24px 0", borderTop: "2px dashed #c7d2fe", position: "relative" }}>
                              <span style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "0 12px", fontSize: 9, color: "#a5b4fc", fontWeight: 700, letterSpacing: "0.1em" }}>PAGE BREAK</span>
                            </div>
                            <div className="page-break" style={{ pageBreakBefore: "always", breakBefore: "page" }}>
                              <p style={{ fontWeight: "bold", marginBottom: 6, fontSize: 12 }}>Recommendations</p>
                              <div style={{ whiteSpace: "pre-line", textAlign: "justify", marginBottom: 8 }}>
                                In view of the preceding comments, the following recommendations are offered:
                              </div>
                              <div style={{ whiteSpace: "pre-line", textAlign: "justify" }}>
                                {cleanAIOutput(secs.recommendations.content.replace(/[⟦⟧]/g, ""), "recommendations")}
                              </div>
                            </div>
                          </>
                        )}
                      </>
                    );
                  })()}

                  {/* ─── CLOSING / SIGNATURE ─── */}
                  <div style={{ marginTop: 24, marginBottom: 24 }}>
                    <p style={{ textAlign: "justify", marginBottom: 24 }}>
                      {pz("It was a pleasure to have had the opportunity to work with [firstName]. I trust that the information contained in this report, as well as the recommendations provided above will aid in providing [object] with the most appropriate support.")}
                    </p>
                    <p style={{ marginBottom: 36 }}>Sincerely yours,</p>
                    <p>________________________</p>
                    <p>{meta.author || "Dr. Ewa J. Antczak, C.Psych."}</p>
                    <p>{meta.authorTitle || "School Psychologist"}</p>
                  </div>

                  {/* ─── APPENDIX: Detailed Recommendations ─── */}
                  {secs.appendix?.content && (
                    <>
                      <div className="page-break-divider" style={{ margin: "32px 0", borderTop: "2px dashed #c7d2fe", position: "relative" }}>
                        <span style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "0 12px", fontSize: 9, color: "#a5b4fc", fontWeight: 700, letterSpacing: "0.1em" }}>PAGE BREAK</span>
                      </div>
                      <div className="page-break" style={{ pageBreakBefore: "always", breakBefore: "page" }}>
                        <p style={{ fontWeight: "bold", fontSize: 12, marginBottom: 12 }}>APPENDIX - Recommendations</p>
                        <p style={{ marginBottom: 8 }}>The following more specific recommendations are made with a view to promoting {derivedFirstName || "the student"}'s optimal functioning.</p>
                        <p style={{ fontWeight: "bold", marginBottom: 16, fontSize: 12 }}>Note that some of these recommendations may not be currently relevant, but should be applied if issues arise in later years.</p>
                        <div style={{ whiteSpace: "pre-line", textAlign: "justify" }}>{cleanAIOutput(secs.appendix.content.replace(/[⟦⟧]/g, ""), "appendix")}</div>
                      </div>
                    </>
                  )}

                  {/* ─── APPENDIX: Bell Curve ─── */}
                  <div className="page-break-divider" style={{ margin: "32px 0", borderTop: "2px dashed #c7d2fe", position: "relative" }}>
                    <span style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "0 12px", fontSize: 9, color: "#a5b4fc", fontWeight: 700, letterSpacing: "0.1em" }}>PAGE BREAK</span>
                  </div>
                  <div className="page-break" style={{ pageBreakBefore: "always", breakBefore: "page" }}>
                    <p style={{ fontWeight: "bold", fontSize: 12, marginBottom: 12 }}>APPENDIX - Bell Curve</p>
                    <p style={{ marginBottom: 8, textDecoration: "underline" }}>
                      Description of scores and categories used in reporting cognitive and academic skills.
                    </p>
                    <p style={{ marginBottom: 16 }}>
                      It is important to note that the results are most accurately understood within the context of the
                      formulation and interpretation contained in the body of the report.
                    </p>
                    <BellCurve />
                    <div style={{ marginTop: 16, fontSize: 11, marginBottom: 12 }}>
                      <p style={{ marginBottom: 8 }}>
                        As an aid in reading the assessment results, a percentile score refers to a student's placement on a test relative to others of the same age. The higher the percentile rank, the better the performance.
                      </p>
                    </div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #333" }}>
                          <th style={{ textAlign: "left", padding: "6px 12px", fontWeight: "bold" }}>Classification</th>
                          <th style={{ textAlign: "left", padding: "6px 12px", fontWeight: "bold" }}>Range of Percentiles</th>
                        </tr>
                      </thead>
                      <tbody>
                        {CLASSIFICATION_TABLE_ROWS.map(([c, r]) => (
                          <tr key={c} style={{ borderBottom: "1px solid #ddd" }}>
                            <td style={{ padding: "4px 12px" }}>{c}</td>
                            <td style={{ padding: "4px 12px" }}>{r}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* ─── APPENDIX: Score Tables (ALWAYS shown) ─── */}
                  {(() => {
                    const prevCogTest = tools.find(t => t.id === "wais-iv" && t.used) ? "wais-iv" : tools.find(t => t.id === "wppsi-iv" && t.used) ? "wppsi-iv" : "wisc-v";
                    const tableContent = secs.appendix_tables?.content?.replace(/[⟦⟧]/g, "")
                      || buildMandatoryAppendixTablesHTML(derivedFirstName || "[firstName]", {}, prevCogTest);
                    return (
                    <>
                      <div className="page-break-divider" style={{ margin: "32px 0", borderTop: "2px dashed #c7d2fe", position: "relative" }}>
                        <span style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "0 12px", fontSize: 9, color: "#a5b4fc", fontWeight: 700, letterSpacing: "0.1em" }}>PAGE BREAK</span>
                      </div>
                      <div className="page-break" style={{ pageBreakBefore: "always", breakBefore: "page" }}>
                      <p style={{ fontWeight: "bold", fontSize: 12, marginBottom: 8 }}>APPENDIX - Tables</p>
                      <p style={{ marginBottom: 16 }}>
                        The following represents a summary of the scores obtained across various cognitive and academic domains. Percentiles can be used to provide a means of comparison with same-aged peers. A percentile refers to the percentage of individuals who fall below a given score.
                      </p>
                      <div className="score-tables" dangerouslySetInnerHTML={{ __html: sanitizeHTML(tableContent) }} />
                    </div>
                    </>
                    );
                  })()}

                </div>

                {/* ─── RUNNING FOOTER (PHIPA) ─── */}
                <div className="report-footer" style={REPORT_FOOTER_STYLE}>
                  <div style={{ marginBottom: 4, fontSize: 9, color: "#999", fontStyle: "italic" }}>Page numbers will appear when printed or exported</div>
                  <div>THIS REPORT IS CONFIDENTIAL AND ANY DISCLOSURE, COPYING OR DISTRIBUTION IS SUBJECT TO THE</div>
                  <div>PERSONAL HEALTH INFORMATION PROTECTION ACT (PHIPA), 2004</div>
                </div>
              </div>
            </div>
          )}

          {/* ══ PROMPT & STYLE REFERENCE ══ */}
          {tab === "prompt_reference" && (
            <PromptReference
              customPrompts={customPrompts}
              userPrompts={userPrompts}
              onSavePrompt={savePrompt}
              onDeletePrompt={deletePrompt}
              onAddUserPrompt={addUserPrompt}
              onSaveUserPrompt={saveUserPrompt}
              onRenameUserPrompt={renameUserPrompt}
              onRemoveUserPrompt={removeUserPrompt}
              showToast={showToast}
            />
          )}

        </div>
      </main>
    </div>
    </>
  );
}
