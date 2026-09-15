/**
 * Minimal RFC 4180 CSV reader.
 *
 * Shared by the moderator's roster upload and the one-off Google Sheet import,
 * so there is one parser to understand and one to test. Spreadsheets export
 * quoted fields with embedded commas, doubled quotes and CRLF line endings, and
 * all three show up in real rosters (names like `O'Brien, Sam`).
 */
'use strict';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  // A BOM from Excel would otherwise become part of the first header name.
  const src = String(text || '').replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

/**
 * Rows keyed by header name, lowercased and space-insensitive so `Email`,
 * `email` and `E-mail ` all land on the same key — people paste these out of
 * whatever their department sent them.
 */
function parseTable(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map((h) => String(h).trim());
  const keys = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  return {
    header,
    rows: rows.slice(1).map((cells) => {
      const o = {};
      keys.forEach((k, i) => { if (k) o[k] = String(cells[i] ?? '').trim(); });
      return o;
    }),
  };
}

module.exports = { parseCsv, parseTable };
