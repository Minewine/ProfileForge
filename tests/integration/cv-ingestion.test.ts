import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getProfile } from "@/lib/profile/repository";
import { resetAuth, signIn, type SessionUser } from "../support/auth";

vi.mock("@/lib/llm/router", () => ({
  callLLM: vi.fn(),
  registerTask: vi.fn(),
  resetTaskRegistry: vi.fn(),
  OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
}));

const FIXTURES = path.resolve("tests/fixtures");

async function cleanDb() {
  await db.profileSnapshot.deleteMany({});
  await db.bullet.deleteMany({});
  await db.experience.deleteMany({});
  await db.education.deleteMany({});
  await db.skill.deleteMany({});
  await db.languageSkill.deleteMany({});
  await db.project.deleteMany({});
  await db.certification.deleteMany({});
  await db.profile.deleteMany({});
  await db.sourceDocument.deleteMany({});
  await db.llmUsageLog.deleteMany({});
}

function fileForm(filename: string, type: string): FormData {
  const bytes = readFileSync(path.join(FIXTURES, filename));
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type }));
  return form;
}

function req(url: string, init: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

const UP = "http://localhost:3000/api/cv/upload";

let user: SessionUser;

beforeEach(async () => {
  await resetAuth();
  user = await signIn("cv-ingestion@example.com");
  await cleanDb();
  vi.mocked(await import("@/lib/llm/router")).callLLM.mockReset();
});

describe("CV upload guards (FR-001/FR-023)", () => {
  it("accepts an English PDF and returns language + page metadata", async () => {
    const { POST } = await import("@/app/api/cv/upload/route");
    const res = await POST(req(UP, { method: "POST", body: fileForm("cv-en.pdf", "application/pdf") }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detectedLanguage).toBe("en");
    expect(body.pageCount).toBeGreaterThanOrEqual(1);
    expect(body.requiresPartialParseConfirmation).toBe(false);
    expect(body.parseStatus).toBe("unparsed");
  });

  it("accepts a French DOCX", async () => {
    const { POST } = await import("@/app/api/cv/upload/route");
    const res = await POST(
      req(UP, {
        method: "POST",
        body: fileForm(
          "cv-fr.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).detectedLanguage).toBe("fr");
  });

  it("rejects an image-only PDF with NO_TEXT_LAYER", async () => {
    const { POST } = await import("@/app/api/cv/upload/route");
    const res = await POST(req(UP, { method: "POST", body: fileForm("scanned.pdf", "application/pdf") }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("NO_TEXT_LAYER");
  });

  it("rejects unsupported formats and oversized files", async () => {
    const { POST } = await import("@/app/api/cv/upload/route");
    const txt = new FormData();
    txt.append("file", new File([new Uint8Array([1, 2, 3])], "cv.txt", { type: "text/plain" }));
    const res1 = await POST(req(UP, { method: "POST", body: txt }));
    expect(res1.status).toBe(415);

    const big = new Uint8Array(11 * 1024 * 1024);
    const pdf = new FormData();
    pdf.append("file", new File([big], "big.pdf", { type: "application/pdf" }));
    const res2 = await POST(req(UP, { method: "POST", body: pdf }));
    expect(res2.status).toBe(413);
    expect((await res2.json()).error.code).toBe("FILE_TOO_LARGE");
  });
});

describe("partial-parse confirmation gate (Very long CV decision)", () => {
  it("requires confirmPartial for an 11-page CV, then reports omissions", async () => {
    const upload = await import("@/app/api/cv/upload/route");
    const uploaded = await upload.POST(req(UP, { method: "POST", body: fileForm("cv-long.pdf", "application/pdf") }));
    const doc = await uploaded.json();
    expect(doc.requiresPartialParseConfirmation).toBe(true);

    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue({
      data: { basics: { name: "Jordan Smith" }, experience: [], education: [], skills: [], languages: [], projects: [], certifications: [] },
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001 },
      modelUsed: "test/model",
    });

    const parse = await import("@/app/api/cv/[id]/parse/route");
    const pArgs = { params: Promise.resolve({ id: doc.sourceDocumentId }) };
    const blocked = await parse.POST(req(`http://localhost:3000/api/cv/${doc.sourceDocumentId}/parse`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    }), pArgs);
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).error.code).toBe("CONFIRMATION_REQUIRED");

    const allowed = await parse.POST(req(`http://localhost:3000/api/cv/${doc.sourceDocumentId}/parse`, {
      method: "POST",
      body: JSON.stringify({ confirmPartial: true }),
      headers: { "Content-Type": "application/json" },
    }), pArgs);
    expect(allowed.status).toBe(200);
    const parsed = await allowed.json();
    expect(parsed.partial).toBe(true);
    expect(Array.isArray(parsed.omittedPages)).toBe(true);
  });
});

describe("parse + import (offline, mocked LLM)", () => {
  it("normalizes dates, flags failures, and imports with provenance", async () => {
    const upload = await import("@/app/api/cv/upload/route");
    const uploaded = await upload.POST(req(UP, { method: "POST", body: fileForm("cv-en.pdf", "application/pdf") }));
    const doc = await uploaded.json();

    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue({
      data: {
        basics: { name: "Jordan Smith", email: "jordan.smith@example.com" },
        experience: [
          {
            company: "Northwind Systems",
            title: "Senior Backend Engineer",
            startDateRaw: "Jan 2021",
            endDateRaw: "March 2023",
            bullets: [
              { text: "Led migration of monolith to event-driven services, cutting latency by 40%.", page: 1 },
              { text: "Won a Nobel Prize for engineering excellence.", page: 1 }, // invented — must be flagged
            ],
            skillsUsed: ["Kubernetes", "Go"],
            page: 1,
          },
          {
            company: "Acme Corp",
            title: "Backend Developer",
            startDateRaw: "04/2023",
            endDateRaw: "present",
            bullets: [],
            skillsUsed: [],
            page: 1,
          },
        ],
        education: [{ institution: "University of Washington", degree: "B.S. Computer Science", startDateRaw: "2011", endDateRaw: "2015", page: 1 }],
        skills: [{ name: "Kubernetes", page: 1 }, { name: "Go", page: 1 }],
        languages: [{ name: "French", proficiency: "professional", page: 1 }],
        projects: [],
        certifications: [],
      },
      usage: { promptTokens: 100, completionTokens: 200, costUsd: 0.002 },
      modelUsed: "test/model",
    });

    const parse = await import("@/app/api/cv/[id]/parse/route");
    const parseRes = await parse.POST(req(`http://localhost:3000/api/cv/${doc.sourceDocumentId}/parse`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    }), { params: Promise.resolve({ id: doc.sourceDocumentId }) });
    expect(parseRes.status).toBe(200);
    const parsed = await parseRes.json();
    expect(parsed.draft.experience[0].startDate).toBe("2021-01");
    expect(parsed.draft.experience[0].endDate).toBe("2023-03");
    expect(parsed.draft.experience[1].endDate).toBe("present");
    // year-only education dates: normalized to January + flagged
    expect(parsed.draft.education[0].startDate).toBe("2011-01");
    const flags = parsed.flags as Array<{ code: string; detail?: string }>;
    expect(flags.some((f) => f.code === "ambiguous_date")).toBe(true);

    // seed a user-entered skill to prove preservation on replace_parsed
    const { createEntry } = await import("@/lib/profile/repository");
    await createEntry(user.id, "skills", { name: "Rust", category: "Languages" });

    const { POST: importPost } = await import("@/app/api/profile/import/route");
    const importRes = await importPost(req("http://localhost:3000/api/profile/import", {
      method: "POST",
      body: JSON.stringify({ sourceDocumentId: doc.sourceDocumentId, mode: "replace_parsed" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(importRes.status).toBe(200);
    const imported = await importRes.json();
    expect(imported.preservedUserEntries).toBe(1);

    const profile = await getProfile(user.id);
    const exp = profile.experience.find((e) => e.company === "Northwind Systems")!;
    expect(exp.provenance).toBe("imported");
    expect(exp.sourceLocator).toMatchObject({ page: 1 });
    expect(exp.language).toBe("en");
    // the invented bullet must be flagged with containment_failed
    const invented = exp.bullets.find((b) => b.text.includes("Nobel"));
    expect(invented?.reviewFlag).toBe("containment_failed");
    expect(invented?.containmentOk).toBe(false);
    const faithful = exp.bullets.find((b) => b.text.includes("latency"));
    expect(faithful?.containmentOk).toBe(true);
    // user skill preserved alongside imported ones
    expect(profile.skills.map((s) => s.name)).toContain("Rust");
  });

  it("source documents referenced by entries cannot be deleted (409 SOURCE_IN_USE)", async () => {
    const upload = await import("@/app/api/cv/upload/route");
    const uploaded = await upload.POST(req(UP, { method: "POST", body: fileForm("cv-en.pdf", "application/pdf") }));
    const doc = await uploaded.json();
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue({
      data: { basics: null, experience: [], education: [], skills: [{ name: "Go", page: 1 }], languages: [], projects: [], certifications: [] },
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      modelUsed: "test/model",
    });
    const parse = await import("@/app/api/cv/[id]/parse/route");
    await parse.POST(req(`http://localhost:3000/api/cv/${doc.sourceDocumentId}/parse`, {
      method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" },
    }), { params: Promise.resolve({ id: doc.sourceDocumentId }) });
    const { POST: importPost } = await import("@/app/api/profile/import/route");
    await importPost(req("http://localhost:3000/api/profile/import", {
      method: "POST",
      body: JSON.stringify({ sourceDocumentId: doc.sourceDocumentId, mode: "merge" }),
      headers: { "Content-Type": "application/json" },
    }));

    const { PATCH, DELETE } = await import("@/app/api/cv/[id]/route");
    const dArgs = { params: Promise.resolve({ id: doc.sourceDocumentId }) };
    const blocked = await DELETE(req(`http://localhost:3000/api/cv/${doc.sourceDocumentId}`, { method: "DELETE" }), dArgs);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("SOURCE_IN_USE");

    // language correction (FR-030) updates the document before parsing
    const patched = await PATCH(req(`http://localhost:3000/api/cv/${doc.sourceDocumentId}`, {
      method: "PATCH",
      body: JSON.stringify({ language: "fr" }),
      headers: { "Content-Type": "application/json" },
    }), dArgs);
    expect(patched.status).toBe(200);
    const row = await db.sourceDocument.findUnique({ where: { id: doc.sourceDocumentId } });
    expect(row?.detectedLanguage).toBe("fr");
    expect(row?.languageManuallyCorrected).toBe(true);
    // upload must stamp the owner (specs/008 FR-006)
    expect(row?.userId).toBe(user.id);
  });
});
