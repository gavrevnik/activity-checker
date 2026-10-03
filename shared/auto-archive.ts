import { z } from "zod";

export const autoArchiveSettingsSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type AutoArchiveSettings = z.output<typeof autoArchiveSettingsSchema>;
