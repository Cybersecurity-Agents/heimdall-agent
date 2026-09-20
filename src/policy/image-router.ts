import { classifyChallenge, pyRe, typeToImageKey } from "../shared/classify.js";
import { resolveImage, type Config, type ImageRule } from "../shared/config.js";

export function routeImage(
  uniqueCode: string,
  cfg: Pick<Config, "image_default" | "image_pwn" | "image_rules" | "type_overrides" | "type_by_level" | "type_rules" | "type_default">,
  opts: { preferred?: string | null; description?: string | null; level?: number | null; challengeType?: string | null } = {},
): string {
  if (opts.preferred) return resolveImage(cfg, opts.preferred);
  for (const rule of (cfg.image_rules || []) as ImageRule[]) {
    if (!rule.match) continue;
    const re = pyRe(rule.match);
    if (re && re.test(uniqueCode || "")) return resolveImage(cfg, rule.image);
  }
  const ctype = opts.challengeType || classifyChallenge(uniqueCode, cfg, {
    description: opts.description,
    level: opts.level,
  });
  return resolveImage(cfg, typeToImageKey(ctype));
}
