# ProfileForge — Product Requirements & Implementation Specification

**Version:** 0.5 (Agent-ready, claim-level grounding & deterministic contracts)  
**Primary objective:** Maximize the user’s probability of receiving an interview by producing ATS-optimized, highly relevant, factually accurate CVs and cover letters whose claims are traceable to profile evidence.

**LLM Provider (MVP):** All LLM calls use the user’s OpenRouter API key. The key is stored encrypted (per-user in multi-user mode; environment variable acceptable for single-user prototype). Every task routes through OpenRouter. Model selection is configurable.

**MVP Scope (deliberately narrow):** One user, one structured profile, pasted job descriptions, evidence-backed matching with deterministic core, one reliable single-column ATS-friendly template, claim-level validation that can block export, and downloadable PDF (with text-layer verification). Multiple templates, advanced synonym expansion, job search automation, and full multi-user hosting are deferred.

---

## Current Status (2026-10-28)

**Implemented and verified — all eight slices.** The MVP scope above has been delivered, then extended:

| Slice | Scope | Status |
|---|---|---|
| [001-ats-cv-tailoring](specs/001-ats-cv-tailoring) | CV upload → parse → provenance-tracked profile (FR/EN) | Implemented |
| [002-jd-matching](specs/002-jd-matching) | JD analysis; deterministic + alias + evidence-validated semantic matching | Implemented |
| [003-cv-generation](specs/003-cv-generation) | Async CV/letter generation, Fact Guard gating, verified PDF export | Implemented |
| [004-profile-editing-e2e](specs/004-profile-editing-e2e) | Playwright end-to-end suite for the profile editor | Implemented |
| [005-cv-selection-refinement](specs/005-cv-selection-refinement) | Explicit selection record, omissions list, keyed rewriting | Implemented |
| [006-polish-reliability](specs/006-polish-reliability) | Loading/error/blocked-state UX, progress, dual-template export | Implemented |
| [007-fix-profile-editor-crud](specs/007-fix-profile-editor-crud) | Profile editor CRUD + autosave restoration | Implemented |
| [008-multi-user-isolation](specs/008-multi-user-isolation) | Accounts, sessions, per-user isolation, per-user encrypted keys | Implemented |

Deviations from this document: **multi-user is no longer deferred** (Slice 008 shipped accounts,
isolation, and per-user keys; a second template — designed two-column — also shipped). Still
**not started**: the **Evaluation** module (§3, `runBenchmark`) — no benchmark slice exists yet.
Still deferred by design: multiple profiles per user, account deletion / password reset / email
verification, job-board integrations.

Verification (2026-10-28): production build green; Vitest 420/420; Playwright e2e 45 passed /
1 skipped (the live upload/parse scenario self-skips without an OpenRouter key); ESLint 0 errors.
Known gaps and prioritized next steps: [CONSOLIDATION.md](CONSOLIDATION.md).

---

## 1. Product Vision

A web application that maintains a single, complete, structured career profile and uses it to generate job-specific CVs and cover letters. Every generated document is optimized for modern Applicant Tracking Systems while remaining truthful to the user’s actual history. Generated claims must be traceable to profile evidence or explicit user confirmation.

**Success metric for MVP:** A user can go from uploaded CV → reviewed profile → pasted job description → downloadable ATS-friendly CV + cover letter that (1) parses cleanly under automated text extraction, (2) presents evidence-backed matches against job requirements with a reproducible score breakdown, and (3) contains no unsupported material claims.

---

## 2. Guiding Principles (Non-Negotiable)

1. **Zero invented facts with claim-level provenance.** The system may reorder, rephrase, emphasize, shorten, and omit. It must never add employers, titles, dates, skills, tools, metrics, degrees, or achievements absent from the profile or explicit user confirmation. Every material factual claim in generated content must link to supporting profile evidence.
2. **ATS-first formatting with verification.** Generated CVs use simple linear layouts, standard section headings, and real text-layer PDFs. Compatibility is verified by automated text extraction and completeness checks, not assumed from template rules alone.
3. **Evidence-aware relevance.** The tailored CV surfaces the strongest truthful evidence for the job. Selection ranks by relevance, evidence strength, impact, and recency. Page budgets are layout constraints; fixed bullet quotas are not used.
4. **Transparent, deterministic matching.** The user sees which requirements were matched (exact, approved alias, or semantic), which are partial, and which are gaps, with evidence references and a reproducible score breakdown.
5. **Complementary cover letter.** The letter adds context and motivation rather than repeating the CV. MatchReport evidence remains available as interview-prep material.

---

## 3. Core Modules

| Module | Responsibility | Key Interfaces |
|--------|----------------|----------------|
| **Profile** | Store and edit the single source of truth with provenance | `getProfile()`, `updateProfileSection()`, `importFromCV()` |
| **Ingestion** | Parse uploaded CV into structured profile + normalize dates | `parseCV(file) → ProfileDraft` |
| **Job Analysis** | Extract requirements and produce deterministic + LLM-assisted match report | `analyzeJob(jdText, profile) → MatchReport` |
| **Generation** | Produce tailored CV content and cover letter (async) with claim links | `generateApplication(...) → jobId` |
| **Templates** | Render structured content into ATS-safe PDFs with validation | `renderCV(content, templateId) → PDF + Validation` |
| **Fact Guard** | Claim-level validation; blockers prevent export | `validateClaims(content, profile) → ValidationReport` |
| **Application Store** | Persist applications, MatchReports, provenance, and versions | CRUD on Application records |
| **LLM Router** | Route all calls via user’s OpenRouter API key | `callLLM(task, payload, model?)` |
| **Evaluation** | Run fixed benchmark set for regression testing | `runBenchmark()` |

---

## 4. Data Schemas (Essential)

### Profile

```ts
interface Profile {
  id: string
  version: number
  basics: { name: string, headline?: string, summary?: string, location?: string, email?: string, phone?: string, links?: string[] }
  experience: Experience[]
  education: Education[]
  skills: Skill[]
  languages: Language[]
  projects: Project[]
  certifications: Certification[]
  // provenance metadata available on imported or user-confirmed items
}

interface Experience {
  id: string
  company: string
  title: string
  location?: string
  startDate: string          // YYYY-MM (normalized)
  endDate?: string           // YYYY-MM or "present"
  bullets: Bullet[]
  skillsUsed: string[]
}

interface Bullet {
  id: string
  text: string
  provenance?: "imported" | "user_entered" | "user_confirmed"
  confidence?: number
}

interface Skill {
  id: string
  name: string
  category?: string
  aliases?: string[]         // approved synonyms only
  level?: string             // user-stated; never inferred from keyword presence alone
  provenance?: string
}
```

### MatchReport

```ts
interface MatchReport {
  overallScore: number                 // 0–100, deterministic breakdown required
  scoreBreakdown: {
    hardRequirementsMet: number
    preferredRequirementsMet: number
    exactMatches: number
    aliasMatches: number
    semanticMatches: number
  }
  requirements: RequirementMatch[]
  recommendedKeywords: string[]
  missingKeywords: string[]
}

interface RequirementMatch {
  id: string
  text: string
  importance: "must" | "nice"
  isHardConstraint: boolean
  status: "strong" | "partial" | "gap"
  matchMethod: "exact" | "approved_alias" | "semantic" | "none"
  evidence: EvidenceRef[]
  note?: string
}

interface EvidenceRef {
  type: "bullet" | "skill" | "education" | "certification"
  id: string
  snippet: string
}
```

### GeneratedCVContent

```ts
interface GeneratedCVContent {
  summary: string
  summaryProvenance: EvidenceRef[]
  experience: {
    id: string
    bullets: { text: string, sourceBulletIds: string[], rationale?: string }[]
  }[]
  skills: string[]
  omissions: { type: string, id: string, reason: string }[]   // inspectable and reversible
  // education and projects similarly structured with provenance
}
```

### ValidationReport

```ts
interface ValidationReport {
  flags: {
    code: string                     // machine-readable
    claim: string
    severity: "blocker" | "warning"
    affectedFieldIds?: string[]
    sourceEvidence?: EvidenceRef[]
    resolution?: "pending" | "user_confirmed" | "edited" | "removed"
  }[]
}
```

---

## 5. Matching & Scoring Contract (Deterministic Core)

LLM may assist with requirement extraction and rephrasing. The matching and scoring rules themselves are deterministic and reproducible.

**Match methods (ordered by strength):**
- **exact**: normalized string match of a hard skill, tool, certification, or credential.
- **approved_alias**: match against an explicitly approved alias list on the skill (e.g. “K8s” ↔ “Kubernetes”). Not inferred freely.
- **semantic**: LLM- or embedding-assisted recognition of related experience for non-hard requirements only. Must cite evidence.
- **none**: gap.

Hard constraints (must-have tools, certifications, licenses, years of experience when explicit) default to exact or approved_alias. Semantic matches do not satisfy hard constraints unless the user explicitly confirms.

**Score (example formula, to be calibrated):**  
Base = (hard requirements met / total hard) × 60 + (preferred met / total preferred) × 30 + evidence quality bonus (0–10).  
Exact matches score higher than aliases; semantic matches score lower and never override hard-constraint failures.

---

## 6. LLM Task Contracts

All tasks return structured JSON, respect zero-invention, and run through the user’s OpenRouter key. Generation is asynchronous.

| Task | Input | Output | Notes |
|------|-------|--------|-------|
| `parseCV` | Raw text | Partial Profile with provenance flags | Date normalization to YYYY-MM mandatory. Flag low-confidence fields. |
| `extractRequirements` | Job description | Structured requirements + keywords | Classify must vs nice. Mark hard constraints. |
| `generateMatchReport` | Profile + requirements | MatchReport | Deterministic exact/alias first; semantic second. Cite evidence IDs. |
| `generateTailoredCV` | Profile + MatchReport + notes | GeneratedCVContent with provenance | Evidence-aware selection (relevance + strength + impact + recency). No fixed bullet quotas. Record omissions. |
| `generateCoverLetter` | Profile + MatchReport + tone | Structured letter | Do not invent; do not repeat CV. |
| `factGuard` | Generated content + Profile | ValidationReport | Claim-level. Material unsupported claims are blockers. |

### Prompt constraints
- “Use only facts present in the provided profile or explicitly confirmed by the user. Link every material claim to evidence. Do not invent metrics, tools, employers, or achievements.”
- Prefer action-oriented, quantifiable language only when the numbers already exist.
- Prefer exact JD terminology for hard skills/tools when supported.

---

## 7. ATS Optimization & Verification Requirements

- Standard section headings: Professional Summary, Experience, Education, Skills, Projects (optional).
- Single-column layout preferred for MVP.
- Real text-layer PDF; no essential information in headers/footers or images.
- Consistent normalized dates.
- Skills section surfaces exact and approved-alias matches.
- **Verification (mandatory):** Every generated PDF/DOCX is subjected to automated text extraction. Check for presence of name, contact, section headings, experience entries, and absence of critical data loss. Fail the export if extraction completeness drops below a defined threshold.
- Page budgets are layout constraints enforced after content selection, not hard bullet caps.

---

## 8. Evaluation Benchmark (Required Before Generator Iteration)

A fixed, versioned set of synthetic or anonymized profiles and job descriptions must exist before heavy prompt tuning. It includes:

- Expected requirement matches (exact, alias, semantic, gap).
- Known unsupported claims that must be flagged.
- Formatting edge cases (accented names, long titles, multi-role histories, varied date formats).
- Pairwise comparison against the original CV for relevance and factual fidelity.

Pass/fail thresholds for extraction accuracy, match correctness, unsupported-claim detection rate, and text-extraction completeness are defined and automated.

---

## 9. Security & Deployment Boundary

- **Single-user prototype:** Acceptable for MVP. OpenRouter key via environment variable. Local database. No multi-tenant isolation required.
- **Hosted multi-user:** Requires explicit later decision on tenant isolation, encrypted secret storage, data retention/deletion, audit logging, and rate limits. Career data and API keys are sensitive; these controls are not retrofitted casually.
- All external LLM calls minimize payload to necessary profile and JD text.

---

## 10. User-Facing Features (MVP Acceptance Criteria)

| Feature | Acceptance Criteria |
|---------|---------------------|
| CV Upload & Parse | PDF/DOCX → editable structured profile with date normalization and low-confidence flags. |
| Profile Editor | Full CRUD with provenance tracking. Autosave. |
| Job Analysis | MatchReport with matchMethod, evidence refs, score breakdown, and hard-constraint status. |
| Generate Application | Async. Evidence-aware content selection. Omissions inspectable. |
| Fact Transparency | Claim-level flags. Blockers prevent download until resolved or user-confirmed. |
| Download | PDF with automated text-layer validation. Optional DOCX. |
| Persistence | Application + MatchReport + provenance saved. |
| OpenRouter | User-supplied key (encrypted). All LLM calls use it. |
| Evaluation | Benchmark suite runnable; regression thresholds enforced. |

---

## 11. Suggested Agent Implementation Sequence

### Sprint 1 – Foundation & Provenance
- Profile schema with IDs, provenance, and versioning.
- Profile editor.
- CV upload → extraction → parse with date normalization and confidence flags.
- OpenRouter key handling and LLM router.

### Sprint 2 – Deterministic Analysis
- Requirement extraction.
- Deterministic exact/alias matching layer + semantic assistance.
- MatchReport UI with evidence and score breakdown.

### Sprint 3 – Generation & Validation
- Evidence-aware `generateTailoredCV` (no fixed quotas; record omissions).
- Claim-level Fact Guard with blockers.
- Single-column template + PDF rendering with automated text extraction validation.
- Async job lifecycle (states, retries, cancellation).

### Sprint 4 – Benchmark & Polish
- Evaluation benchmark suite and automated checks.
- Live preview, omission restore, Gap Bridge.
- Download with validation gate.
- Application history.

### Later
- Additional templates, embedding-based semantic expansion, job search, interview-prep extensions, multi-user hosting.

---

## 12. Open Decisions

- Exact numerical weights in the score formula (to be calibrated against benchmark).
- Size and governance of the approved alias list.
- Default OpenRouter model(s) and cost limits.
- Whether DOCX is MVP or post-MVP.
- Precise text-extraction completeness threshold.

---

This version strengthens the central product promises—traceable facts, reproducible matching, and verified ATS-friendly output—while keeping the MVP narrow enough for reliable agent implementation. Platform-specific ATS behaviors remain hypotheses to be tested rather than fixed design rules.
