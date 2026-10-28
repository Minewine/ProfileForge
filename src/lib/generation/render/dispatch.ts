import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings } from "@/lib/generation/schemas";
import { renderCV, type RenderedPdf } from "@/lib/generation/render/cv";
import { renderDesignedCV } from "@/lib/generation/render/designed";

/** Render the CV with the job's frozen template: "designed" (two-column) or the
 *  default single-column ATS layout. Pre-phase-8 settings (templateId absent)
 *  render ATS. Letters never route through here. */
export async function renderCVForSettings(args: {
  content: GeneratedCVContent;
  snapshot: PinnedSnapshot;
  settings: GenerationSettings;
  sanitize?: (text: string) => string;
}): Promise<RenderedPdf> {
  return (args.settings.templateId ?? "ats") === "designed"
    ? renderDesignedCV(args)
    : renderCV(args);
}
