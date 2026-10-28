import { z } from "zod";

/** Shared credential shape for register and login (specs/008, data-model.md):
 * the email is normalized (trim + lowercase) as part of validation so every
 * downstream store/compare sees the canonical form; password minimum 8 chars. */
export const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
