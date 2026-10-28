export type NormalizedDate = { value: string | null; flag: "ambiguous_date" | null };

const PRESENT_WORDS = new Set([
  "present",
  "présent",
  "present.",
  "aujourd'hui",
  "aujourdhui",
  "current",
  "actuellement",
  "now",
  "maintenant",
]);

const MONTHS: Record<string, number> = {
  // English — full and common abbreviations
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
  // French — full and common abbreviations (accented and unaccented forms)
  janvier: 1, janv: 1, fevrier: 2, février: 2, fevr: 2, févr: 2, mars: 3,
  avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
  aout: 8, août: 8, aoû: 8, septembre: 9,
  octobre: 10, novembre: 11, decembre: 12, décembre: 12, déc: 12,
};

function mm(year: number, month: number): string | null {
  if (month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Deterministic EN/FR date normalization (FR-004, R9).
 * Ambiguity is flagged, never guessed: unparseable → null + flag;
 * year-only → January assumed + flagged; day/month both ≤12 → flagged.
 */
export function normalizeDate(raw: string | null | undefined, _language: "fr" | "en"): NormalizedDate {
  if (raw == null) return { value: null, flag: null };
  let s = raw.trim().toLowerCase();
  if (!s) return { value: null, flag: null };

  s = s.replace(/^(depuis|since|from|à partir de|a partir de|dès)\s+/, "").trim();
  s = s.replace(/[.,;]+$/, "").trim();
  if (!s) return { value: null, flag: null };
  if (PRESENT_WORDS.has(s)) return { value: "present", flag: null };

  // YYYY-MM
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const value = mm(+m[1], +m[2]);
    return value ? { value, flag: null } : { value: null, flag: "ambiguous_date" };
  }

  // MM/YYYY or MM.YYYY
  m = s.match(/^(\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const value = mm(+m[2], +m[1]);
    return value ? { value, flag: null } : { value: null, flag: "ambiguous_date" };
  }

  // D/M/YYYY (or M/D/YYYY) — day>12 or month>12 disambiguates; both ≤12 stays flagged
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const year = +m[3];
    if (a > 12 && b <= 12) return { value: mm(year, b), flag: null }; // DD/MM/YYYY
    if (b > 12 && a <= 12) return { value: mm(year, a), flag: null }; // MM/DD/YYYY
    return { value: null, flag: "ambiguous_date" };
  }

  // Month name YYYY (EN/FR, optional abbreviation period already stripped)
  m = s.match(/^([a-zéèûôàç']+\.?)\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].replace(/\.$/, "")];
    if (month) return { value: mm(+m[2], month), flag: null };
    return { value: null, flag: "ambiguous_date" };
  }

  // Bare year — keep the information, flag it for review
  m = s.match(/^(\d{4})$/);
  if (m) return { value: mm(+m[1], 1), flag: "ambiguous_date" };

  return { value: null, flag: "ambiguous_date" };
}
