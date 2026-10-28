# Data Model: CV Ingestion & Structured Profile Foundation (Slice 1)

**Date**: 2026-10-21 · Canonical TypeScript interfaces live in `ProfileForge-Specification.md` §4; this document maps them to the slice's persistence model (Prisma / PostgreSQL) and states validation rules derived from the spec.

## Entity Overview

```text
SourceDocument 1──* ProvenanceRef (via entry fields)
Profile 1──* Experience 1──* Bullet
Profile 1──* Education / Skill / LanguageSkill / Project / Certification
Profile 1──* ProfileSnapshot (append-only)
AppSettings 1──* LlmUsageLog
```

## Entities

### SourceDocument
An uploaded CV file: the origin of all parsed provenance.

| Field | Type | Rules |
|-------|------|-------|
| id | cuid (PK) | |
| originalFilename | string | preserved verbatim |
| storagePath | string | under `uploads/`, content-addressed by sha256 |
| sha256 | string | dedupe + integrity |
| mimeType | `application/pdf` \| DOCX type | only these two accepted |
| sizeBytes | int | 1..10_485_760 (FR-001) — larger rejected at the API edge |
| detectedLanguage | `fr` \| `en` | franc-gated, from extracted text; user-correctable via Profile |
| pageCount / paragraphCount | int? | PDF pages; DOCX paragraphs — provenance locator bounds |
| extractedText | text | full per-page/paragraph text (JSON structure: `[{page, text}]`) |
| parseStatus | `unparsed` → `parsing` → `parsed` \| `failed` | state machine; `failed` carries `parseError` |
| parseResult | JSONB (ProfileDraft, zod-validated) | set on `parsed`; includes containment flags |
| createdAt | datetime | |

State transitions: `unparsed → parsing → parsed | failed` (no retry loop in slice 1 — re-parse resets to `parsing`).

### Profile
The single source of truth (single active profile in MVP).

| Field | Type | Rules |
|-------|------|-------|
| id | cuid (PK) | one row active |
| version | int | incremented on every persisted mutation (FR-027) |
| language | `fr` \| `en` | copied from SourceDocument at import; user-correctable (FR-030) |
| basics | JSONB `{name, headline?, summary?, location?, email?, phone?, links?}` | zod-validated |
| createdAt / updatedAt | datetime | |

### Experience
| Field | Type | Rules |
|-------|------|-------|
| id | cuid (PK) | |
| profileId | FK → Profile | |
| company / title | string | required, non-empty |
| location | string? | |
| startDate | `YYYY-MM` | **regex-validated**; nullable only while flagged low-confidence |
| endDate | `YYYY-MM` \| `present` \| null | ≥ startDate when both absolute |
| skillsUsed | string[] | skills/tools referenced by this role (canonical §4); default `[]` |
| order | int | stable ordering |
| provenance | `imported` \| `user_entered` \| `user_confirmed` | FR-003/FR-005 |
| sourceDocumentId | FK? | required iff provenance = `imported` |
| sourceLocator | JSONB? `{page? \| paragraphIndex?, section?}` | required iff `imported` |
| confidence | float 0..1? | parser-supplied; low (<0.7) ⇒ flagged in UI (FR-003) |

Overlapping/invalid date ranges are warned at edit time (spec edge case) but not blocked in slice 1.

### Bullet
Bullet-level provenance is the atom of fact-guarding (§4 Bullet, FR-003).

| Field | Type | Rules |
|-------|------|-------|
| id | cuid (PK) | |
| experienceId / projectId / educationId | FK (polymorphic owner or per-owner tables; see note) | |
| text | string | non-empty; trimmed |
| provenance | `imported` \| `user_entered` \| `user_confirmed` | |
| sourceDocumentId + sourceLocator | as above | required iff `imported` |
| confidence | float? | low ⇒ user review flag |
| containmentOk | boolean? | result of the source-containment check (R8); false ⇒ flagged, needs `user_confirmed` |

**Note**: Prisma has no polymorphic FKs — model as three nullable FK columns with a CHECK-like zod rule (exactly one owner set), which keeps one Bullet table and one provenance/validation code path.

### Education / Certification
| Field | Type | Rules |
|-------|------|-------|
| id, profileId, provenance, sourceDocumentId?, sourceLocator?, confidence | as above | |
| institution / title | string | required |
| startDate?, endDate? | `YYYY-MM`/`present` | normalized |
| degree, field, grade | string? | certification: issuer, issueDate (`YYYY-MM`) |

### Skill
| Field | Type | Rules |
|-------|------|-------|
| id, profileId, provenance fields | as above | |
| name | string | unique per profile (case/accent-insensitive) — duplicates prompt merge-or-keep (spec edge case) |
| category | string? | |
| aliases | string[] | **user-approved only** (FR-006/FR-007); union with built-in global list at match time |
| level | string? | user-stated only, never inferred (FR-006) |

### LanguageSkill (spoken language — distinct from document language)
| Field | Type | Rules |
|-------|------|-------|
| id, profileId, provenance fields | as above | |
| name | string (e.g., "Français", "English") | |
| proficiency | string? | user-stated (CEFR or free text); never inferred |

### Project
| Field | Type | Rules |
|-------|------|-------|
| id, profileId, provenance fields | as above | |
| name, description | string | description may own Bullets |
| startDate?/endDate? | `YYYY-MM`/`present` | |
| link | string (URL)? | |

### ProfileSnapshot (append-only)
| Field | Type |
|-------|------|-------|
| id, profileId, version (int), cause (`import` \| `edit` \| `restore`), data (JSONB = full profile), createdAt | |

### AppSettings (single row)
| Field | Type | Rules |
|-------|------|-------|
| openRouterKeyEncrypted | bytes? | AES-256-GCM; env var takes precedence at read time (R6) |
| keyHint | string? | masked tail for UI, e.g. `sk-or-…f4a2` |
| modelEconomy / modelPremium | string | OpenRouter model ids; validated for `structured_outputs` support at save |
| costCapUsd | decimal | default 0.50, user-adjustable (FR-008) |
| updatedAt | datetime | |

### LlmUsageLog
| Field | Type | Rules |
|-------|------|-------|
| id, task (`parseCV` \| …), model, runId (cuid grouping one user-run) | | |
| promptTokens / completionTokens | int | from response `usage` |
| costUsd | decimal | from response `usage.cost`; run total enforced ≤ costCapUsd |
| createdAt, durationMs | | |

## Validation Rules (cross-cutting, from spec)

- All API and LLM payloads validated by zod schemas in `src/lib/validation/schemas.ts`; Prisma types are inferred from these, not vice versa.
- Dates: `^\d{4}-(0[1-9]|1[0-2])$` or the literal `present`; normalization happens *before* persistence; anything unnormalizable is stored null + flagged (FR-004).
- Provenance invariant (enforced by service layer + zod): `provenance = imported ⇒ sourceDocumentId + sourceLocator present`; `user_entered/user_confirmed ⇒ confidence null, no source ref required`.
- Entry-level language metadata: every content entry carries nullable `language` (`fr` | `en`), set from its SourceDocument at import and null for user-entered entries unless explicitly set — supports mixed-language merge imports and FR-032 generation later.
- IDs are cuids generated server-side; client-suggested IDs are ignored.
- Profile mutations are transactional: entity change + `version += 1` + snapshot append commit atomically.

## Extensions beyond the canonical schema (§4)

Storage-level fields and tables added by this plan (not present in ProfileForge-Specification.md §4; each serves a spec FR): `containmentOk` (R8 zero-invention check), `sourceLocator` JSONB (FR-003), `order` (stable ordering), SourceDocument's `sha256`/`sizeBytes`/`parseStatus`/`extractedText`/`parseResult` (FR-001/FR-023 ingestion), the `ProfileSnapshot`, `AppSettings`, and `LlmUsageLog` tables (FR-027/FR-008), nullable `startDate` while flagged (FR-004 ambiguity rule), entry-level `language` (FR-030/FR-032), and bullets owned by Project/Education in addition to Experience. `LanguageSkill` is this model's name for the canonical `Language` entity (avoids collision with document language). Canonical fields — including `skillsUsed` and bullet-level provenance/confidence — are preserved as-is.

## Deferred (later slices — do not model yet)

MatchReport/RequirementMatch/EvidenceRef tables (Sprint 2), GeneratedDocument + ValidationReport persistence (Sprint 3), benchmark fixtures schema (Sprint 4).
