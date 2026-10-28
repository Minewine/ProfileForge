// Environment prep for GUI testing: seed the profile of gui.tester@example.com
// with the real content of CV/COUGHLAN_CV_2024_EN.pdf.
// Needed because LLM-backed parsing is unavailable (no OpenRouter key configured).
// Run: set -a && . ./.env && set +a && npx tsx scripts/seed-gui-test.ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  const user = await db.user.findUnique({ where: { email: "gui.tester@example.com" } });
  if (!user) throw new Error("gui.tester@example.com not found — register first via GUI");

  let profile = await db.profile.findFirst({ where: { userId: user.id } });
  if (!profile) {
    profile = await db.profile.create({
      data: { userId: user.id, version: 1, language: "en" },
    });
    console.log("Created empty profile:", profile.id);
  }
  const expCount = await db.experience.count({ where: { profileId: profile.id } });
  if (expCount > 0) {
    console.log("Profile already populated:", profile.id);
    return;
  }

  await db.profile.update({
    where: { id: profile.id },
    data: {
      userId: user.id,
      version: 1,
      language: "en",
      basics: {
        name: "Michael Coughlan",
        headline: "Technology Consultant & Project Manager",
        summary:
          "Seasoned technology consultant and project manager with over two decades of experience in driving digital transformation. Specialised in AI-driven solutions, project management, and product development.",
        location: "Geneva, Switzerland",
        email: "coughlan@gmail.com",
        phone: "+41 78 900 0022",
        links: ["https://www.linkedin.com/in/coughlan", "https://www.rametric.com"],
      },
      experiences: {
        create: [
          {
            company: "Rametric",
            title: "Founder & Lead Developer",
            location: "Geneva, Switzerland",
            startDate: "2020-08",
            endDate: "present",
            order: 0,
            bullets: {
              create: [
                { order: 0, text: "Leading the development of Docsumm, an AI-powered document summarization tool." },
                { order: 1, text: "Innovating solutions in AI document processing, data analytics, and enterprise AI strategies." },
                { order: 2, text: "Collaborating with partners to develop scalable, AI-based tools for knowledge extraction." },
              ],
            },
          },
          {
            company: "CSRG",
            title: "Volunteer",
            startDate: "2021-08",
            endDate: "2024-02",
            order: 1,
            bullets: { create: [{ order: 0, text: "Volunteered in a soup kitchen." }] },
          },
          {
            company: "Self-Employed",
            title: "Consultant",
            startDate: "2009-01",
            endDate: "2013-01",
            order: 2,
            bullets: {
              create: [
                { order: 0, text: "Led product development for a social network for sports organisations." },
                { order: 1, text: "Managed deployment of 500 customised iPads at IMD." },
                { order: 2, text: "Served as interim CTO at Poken." },
                { order: 3, text: "Advised a large sporting goods organisation on social media strategy for the Cricket World Cup." },
              ],
            },
          },
          {
            company: "CSC (UK)",
            title: "Senior Project Manager",
            startDate: "2004-09",
            endDate: "2008-12",
            order: 3,
            bullets: {
              create: [
                { order: 0, text: "Led a $50M program for BAE Systems." },
                { order: 1, text: "Organised a PMO for BT's $1B 21CN program." },
                { order: 2, text: "Managed VoIP rollout at Aviva and product management for Allder's retail system." },
              ],
            },
          },
          {
            company: "IBM",
            title: "Project Manager/Developer",
            startDate: "1995-10",
            endDate: "2004-08",
            order: 4,
            bullets: {
              create: [
                { order: 0, text: "Nokia (Finland): Developed an online product catalogue for their clients." },
                { order: 1, text: "Anglo Irish Bank (Ireland): Created ad hoc support applications for the trading desk." },
                { order: 2, text: "ABN-Amro (Holland): Developed an automated rollout system for applications across all bank offices." },
                { order: 3, text: "IHS Energy (Switzerland): Built a system to digitise and put paper oil reports online." },
              ],
            },
          },
        ],
      },
      educations: {
        create: [
          { institution: "Webster University", degree: "MBA in Business", startDate: "2011", endDate: "2013", order: 0 },
          { institution: "Waterford Institute of Technology", degree: "BSc in Applied Computing", startDate: "1991", endDate: "1994", order: 1 },
        ],
      },
      skills: {
        create: [
          "AI document processing",
          "project management",
          "business analysis",
          "change management",
          "program management",
          "AI strategy",
          "NLP and machine learning integration",
          "team leadership",
          "management consulting",
        ].map((name, i) => ({ name, order: i })),
      },
      languages: { create: [{ name: "French", proficiency: "B1", order: 0 }] },
      projects: {
        create: [
          {
            name: "Docsumm",
            description:
              "An AI-powered document summarization tool that supports multiple file formats, including audio, PDFs, and DOCX.",
            link: "https://www.rametric.com",
            order: 0,
            bullets: {
              create: [
                { order: 0, text: "Expanded from audio transcription to include multi-format document processing." },
                { order: 1, text: "Integrates vector stores for similarity search and fast information retrieval." },
              ],
            },
          },
        ],
      },
    },
  });
  console.log("Seeded profile:", profile.id, "version", profile.version);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
