// Generates test fixtures: English/French CVs (PDF + DOCX), an image-only PDF,
// and a >10-page PDF. Run: node scripts/make-fixtures.mjs
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Document, Packer, Paragraph, TextRun } from "docx";

const OUT = path.resolve("tests/fixtures");
await mkdir(OUT, { recursive: true });

const CV_EN = [
  "Jordan Smith",
  "jordan.smith@example.com | +1 415 555 0101 | San Francisco, CA",
  "PROFESSIONAL SUMMARY",
  "Senior backend engineer with 8 years of experience building distributed systems.",
  "EXPERIENCE",
  "Senior Backend Engineer — Northwind Systems, San Francisco",
  "Jan 2021 - March 2023",
  "- Led migration of monolith to event-driven services, cutting latency by 40%.",
  "- Managed a team of 5 engineers across two time zones.",
  "Backend Developer — Acme Corp, Remote",
  "04/2023 - present",
  "- Designed a payment reconciliation pipeline processing 2M transactions daily.",
  "- Introduced contract testing, reducing integration incidents by 30%.",
  "EDUCATION",
  "B.S. Computer Science — University of Washington, 2015",
  "SKILLS",
  "Kubernetes, Go, PostgreSQL, Kafka, Terraform, K8s",
  "LANGUAGES",
  "English (native), French (professional)",
];

const CV_FR = [
  "Camille Durand",
  "camille.durand@example.fr | +33 6 12 34 56 78 | Lyon, France",
  "RÉSUMÉ PROFESSIONNEL",
  "Ingénieure logicielle senior avec 9 ans d'expérience en systèmes distribués.",
  "EXPÉRIENCE PROFESSIONNELLE",
  "Ingénieure Senior — Société Générale, Lyon",
  "janv. 2021 - mars 2023",
  "- Direction de la migration vers une architecture orientée services.",
  "- Réduction du temps de déploiement de 60 %.",
  "Développeuse — Atelier Numérique, Remote",
  "depuis sept. 2023",
  "- Conception d'un pipeline de données traitant 1,5 million d'événements par jour.",
  "- Mise en place de tests de charge automatisés.",
  "FORMATION",
  "Master Informatique — Université Claude Bernard Lyon 1, 2014",
  "COMPÉTENCES",
  "Kubernetes, Go, PostgreSQL, Kafka, Terraform, gestion de projet",
  "LANGUES",
  "Français (natif), Anglais (courant)",
];

async function makePdf(lines, pagesWanted = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const perPage = Math.ceil(lines.length / pagesWanted);
  for (let p = 0; p < pagesWanted; p++) {
    const page = doc.addPage([595, 842]);
    const slice = lines.slice(p * perPage, (p + 1) * perPage);
    if (slice.length === 0 && p > 0) break;
    let y = 800;
    for (const line of slice) {
      if (y < 40) break;
      page.drawText(line, { x: 50, y, size: line === line.toUpperCase() ? 12 : 10, font });
      y -= line === line.toUpperCase() ? 22 : 18;
    }
    if (p === 0 && pagesWanted > 1 && slice.length === lines.length) break;
  }
  return Buffer.from(await doc.save());
}

async function makeDocx(lines) {
  const doc = new Document({
    sections: [
      {
        children: lines.map(
          (l) =>
            new Paragraph({
              children: [new TextRun({ text: l, bold: l === l.toUpperCase() })],
            }),
        ),
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

await writeFile(path.join(OUT, "cv-en.pdf"), await makePdf(CV_EN));
await writeFile(path.join(OUT, "cv-fr.pdf"), await makePdf(CV_FR));
await writeFile(path.join(OUT, "cv-en.docx"), await makeDocx(CV_EN));
await writeFile(path.join(OUT, "cv-fr.docx"), await makeDocx(CV_FR));

// Image-only PDF: one blank page, zero text.
const scanned = await PDFDocument.create();
scanned.addPage([595, 842]);
await writeFile(path.join(OUT, "scanned.pdf"), Buffer.from(await scanned.save()));

// 11-page CV (exceeds the 10-page partial-parse threshold)
const longLines = [];
for (let p = 1; p <= 11; p++) {
  longLines.push(`PAGE ${p} HEADER — Jordan Smith Extended History`);
  for (let i = 0; i < 8; i++) longLines.push(`Experience detail line ${i} for page ${p} with concrete results.`);
}
await writeFile(path.join(OUT, "cv-long.pdf"), await makePdf(longLines, 11));

console.log("fixtures written to", OUT);
