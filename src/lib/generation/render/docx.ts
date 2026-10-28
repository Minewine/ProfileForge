import { Document, Packer, Paragraph, TextRun } from "docx";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings } from "@/lib/generation/schemas";
import { activeSections, cvBasics, renderMetaOf } from "@/lib/generation/render/cv";
import { renderDesignedDocx } from "@/lib/generation/render/designed-docx";
import { formatDate, formatDateRange, sectionHeading } from "@/lib/generation/render/template";

/**
 * Best-effort DOCX export (research R3): rendered from the same
 * `GeneratedCVContent` as the PDF (one source of truth), explicitly ungated
 * by the extraction check (parent decision) — download stays blocker-gated
 * like every artifact. Phase 8: `templateId: "designed"` renders the
 * two-column layout (designed-docx.ts); the ATS single column stays default.
 */

function heading(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, bold: true })] });
}

function entryHeading(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, bold: true })] });
}

function metaLine(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, size: 18 })] }); // half-points ⇒ 9pt
}

function body(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text })] });
}

function bullet(text: string): Paragraph {
  return new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text })] });
}

export async function renderCVDocx(args: {
  content: GeneratedCVContent;
  snapshot: PinnedSnapshot;
  settings: GenerationSettings;
}): Promise<Uint8Array> {
  if ((args.settings.templateId ?? "ats") === "designed") return renderDesignedDocx(args);
  const { content } = args;
  const language = args.settings.outputLanguage;
  const children: Paragraph[] = [];

  const basics = cvBasics(args.snapshot);
  if (basics.name) children.push(new Paragraph({ children: [new TextRun({ text: basics.name, bold: true, size: 32 })] }));
  if (basics.contact.length > 0) {
    children.push(metaLine(basics.contact.map((item) => item.value).join(" · ")));
  }

  const sections = new Set(activeSections(content));
  if (sections.has("summary")) {
    children.push(heading(sectionHeading(language, "summary")), body(content.summary));
  }
  if (sections.has("experience")) {
    children.push(heading(sectionHeading(language, "experience")));
    for (const entry of content.experience) {
      if (entry.bullets.length === 0) continue;
      const meta = renderMetaOf.experience(args.snapshot, entry.id);
      if (meta) {
        // feature 005 US2: the rewritten title (fallback: the snapshot title)
        const title = entry.title?.text?.trim() || meta.title;
        children.push(entryHeading([title, meta.company].filter(Boolean).join(" — ")));
        const dates = formatDateRange(meta.startDate, meta.endDate);
        if (dates) children.push(metaLine(dates));
      }
      for (const b of entry.bullets) children.push(bullet(b.text));
    }
  }
  if (sections.has("education")) {
    children.push(heading(sectionHeading(language, "education")));
    for (const education of content.education) {
      const meta = renderMetaOf.education(args.snapshot, education.id);
      const dates = meta ? formatDateRange(meta.startDate, meta.endDate) : "";
      children.push(body(dates ? `${education.text} (${dates})` : education.text));
    }
  }
  if (sections.has("skills")) {
    children.push(heading(sectionHeading(language, "skills")), body(content.skills.join(", ")));
  }
  if (sections.has("projects")) {
    children.push(heading(sectionHeading(language, "projects")));
    for (const project of content.projects) {
      if (project.bullets.length === 0) continue;
      const meta = renderMetaOf.project(args.snapshot, project.id);
      if (meta) {
        children.push(entryHeading(meta.name));
        const dates = formatDateRange(meta.startDate, meta.endDate);
        if (dates) children.push(metaLine(dates));
      }
      for (const b of project.bullets) children.push(bullet(b.text));
    }
  }
  if (sections.has("certifications")) {
    children.push(heading(sectionHeading(language, "certifications")));
    for (const certification of content.certifications) {
      const meta = renderMetaOf.certification(args.snapshot, certification.id);
      const issued = meta?.issueDate ? formatDate(meta.issueDate) : "";
      children.push(body(issued ? `${certification.text} (${issued})` : certification.text));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return new Uint8Array(await Packer.toBuffer(doc));
}
