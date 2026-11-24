import { z } from "zod";

function withScheme(value: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}

export const CompanyXrayInputSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .transform(withScheme)
    .pipe(z.url({ protocol: /^https?$/ }))
    .refine((value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    }, "Credentials in URLs are not allowed")
    .transform((value) => new URL(value).href),
  focus: z.string().trim().min(1).max(500).optional(),
});

export type CompanyXrayInput = z.infer<typeof CompanyXrayInputSchema>;
