import { normalizeText } from "@/lib/text/normalize";
import type { ProfileDto } from "@/lib/profile/repository";

/**
 * Versioned built-in bilingual alias groups (parent FR-007: approved-only,
 * vetted, shipped with the application). Normalized forms; matching is
 * bidirectional within a group. Users extend matching ONLY via per-skill
 * approved aliases on their profile.
 */
export const ALIAS_LIST_VERSION = 1;

export const BUILTIN_ALIASES: string[][] = [
  ["kubernetes", "k8s"],
  ["continuous integration", "ci", "integration continue"],
  ["continuous delivery", "cd", "livraison continue"],
  ["project management", "gestion de projet"],
  ["product management", "gestion de produit"],
  ["software engineering", "genie logiciel", "génie logiciel"],
  ["machine learning", "apprentissage automatique", "ml"],
  ["deep learning", "apprentissage profond"],
  ["data science", "science des donnees", "science des données"],
  ["artificial intelligence", "intelligence artificielle", "ai"],
  ["front end", "frontend"],
  ["back end", "backend"],
  ["full stack", "fullstack"],
  ["react", "react js", "react.js"],
  ["vue", "vue js", "vue.js"],
  ["angular", "angularjs"],
  ["node js", "node.js", "nodejs"],
  ["typescript", "ts"],
  ["javascript", "js"],
  ["postgresql", "postgres", "psql"],
  ["mysql", "mariadb"],
  ["infrastructure as code", "iac"],
  ["amazon web services", "aws"],
  ["google cloud platform", "gcp"],
  ["microsoft azure", "azure"],
  ["terraform", "tf"],
  ["business intelligence", "bi", "informatique decisionnelle", "informatique décisionnelle"],
  ["unit testing", "tests unitaires", "unit tests"],
  ["test driven development", "tdd", "developpement dirige par les tests"],
  ["agile", "agile methodology", "methodologie agile", "méthodologie agile"],
  ["scrum", "scrum master"],
  ["rest api", "rest apis", "api rest"],
  ["graphql", "graph ql"],
  ["message queue", "message broker", "file de messages"],
  ["microservices", "micro services", "architecture microservices"],
  ["devops", "dev ops"],
  ["site reliability engineering", "sre"],
  ["customer relationship management", "crm"],
  ["enterprise resource planning", "erp", "pgi"],
  ["big data", "bigdata"],
  ["etl", "extract transform load"],
  ["sql", "structured query language"],
  ["nosql", "no sql"],
  ["user experience", "ux", "experience utilisateur"],
  ["user interface", "ui", "interface utilisateur"],
  ["tech lead", "technical lead", "lead developer", "developpeur lead"],
  ["software architect", "architecte logiciel"],
  ["solution architect", "architecte solution"],
  ["requirements analysis", "analyse des besoins"],
  ["stakeholder management", "gestion des parties prenantes"],
  ["tech lead", "tech leadership"],
  ["bachelor degree", "bachelor s degree", "licence"],
  ["master degree", "master s degree", "master"],
  ["phd", "doctorat"],
  ["computer science", "informatique"],
  ["years of experience", "ans d experience", "ans d'expérience"],
].map((group) => [...new Set(group.map(normalizeText))].filter(Boolean));

const groupIndex = new Map<string, number>();
BUILTIN_ALIASES.forEach((group, i) => {
  for (const term of group) {
    const existing = groupIndex.get(term);
    if (existing === undefined) groupIndex.set(term, i);
    else {
      // merge groups that share a term
      if (existing !== i) {
        BUILTIN_ALIASES[existing] = [...new Set([...BUILTIN_ALIASES[existing], ...group])];
        for (const t of group) groupIndex.set(t, existing);
      }
    }
  }
});

/** True if the two normalized terms are approved aliases of each other. */
export function sameAliasGroup(
  termA: string,
  termB: string,
  profile?: Pick<ProfileDto, "skills">,
): boolean {
  const a = normalizeText(termA);
  const b = normalizeText(termB);
  if (!a || !b || a === b) return a === b && !!a;

  const ga = groupIndex.get(a);
  const gb = groupIndex.get(b);
  if (ga !== undefined && ga === gb) return true;

  if (profile) {
    for (const skill of profile.skills) {
      const name = normalizeText(skill.name);
      const aliasNorms = (skill.aliases ?? []).map(normalizeText);
      const linksName = name === a || name === b;
      const linksAlias = aliasNorms.includes(a) || aliasNorms.includes(b);
      if (linksName && linksAlias) return true;
    }
  }
  return false;
}
